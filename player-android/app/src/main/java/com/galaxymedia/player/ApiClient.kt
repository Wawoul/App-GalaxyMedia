package com.galaxymedia.player

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

class ApiClient(private val prefs: Prefs) {
    /** Short timeouts: these are small JSON calls that should fail fast. */
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * Separate client for media downloads. The API client's 30s readTimeout is
     * right for a JSON call and wrong for a 300MB video: on a slow or congested
     * link a large transfer can easily stall longer than that between reads, and
     * OkHttp then aborts it. The download restarts from zero on the next sync,
     * fails the same way, and the screen never gets its media - which is exactly
     * what stranded a screen in the field, with the server logging a healthy
     * 200 while the client walked away mid-body.
     *
     * No callTimeout at all (an unbounded total is intended here), a generous
     * read gap, and retryOnConnectionFailure so a dropped connection is retried
     * rather than surfacing as a failure.
     */
    val downloadHttp: OkHttpClient = http.newBuilder()
        .readTimeout(5, TimeUnit.MINUTES)
        .writeTimeout(5, TimeUnit.MINUTES)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val jsonType = "application/json".toMediaType()

    private fun base(): String = prefs.serverUrl?.trimEnd('/') ?: error("server url not set")

    private fun authed(builder: Request.Builder): Request.Builder {
        prefs.deviceToken?.let { builder.header("Authorization", "Bearer $it") }
        return builder
    }

    /**
     * OkHttp's body is platform-nullable and genuinely null for a 204 or a
     * HEAD-style reply, which a misbehaving proxy can return. `!!` there throws an
     * NPE that lands in a generic catch and tells nobody anything; this fails with
     * a message naming the call instead.
     */
    private fun okhttp3.Response.bodyText(what: String): String =
        body?.string() ?: error("$what: empty response body (HTTP $code)")

    suspend fun register(): RegisterResponse = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${base()}/api/device/register")
            .post("{}".toRequestBody(jsonType))
            .build()
        http.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "register failed: ${response.code}" }
            json.decodeFromString<RegisterResponse>(response.bodyText("register"))
        }
    }

    suspend fun pollPairing(requestId: String): PollResponse = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("${base()}/api/device/register/$requestId").build()
        http.newCall(request).execute().use { response ->
            when {
                response.isSuccessful -> json.decodeFromString<PollResponse>(response.bodyText("poll"))
                response.code == 404 || response.code == 410 -> PollResponse(status = "expired")
                // Throttled: the request is still valid, so keep the same code on screen
                // and poll again. Treating this as a failure sent the TV round to
                // register a NEW code, changing it under whoever was typing it in.
                response.code == 429 -> PollResponse(status = "waiting")
                else -> error("poll failed: ${response.code}")
            }
        }
    }

    suspend fun fetchManifest(): Manifest = withContext(Dispatchers.IO) {
        val request = authed(Request.Builder().url("${base()}/api/device/manifest")).build()
        http.newCall(request).execute().use { response ->
            if (response.code == 401) throw RevokedException()
            check(response.isSuccessful) { "manifest failed: ${response.code}" }
            val body = response.bodyText("manifest")
            // Decode BEFORE caching: persisting an undecodable manifest would
            // overwrite the last good one, and cachedManifest() silently returns
            // null for it - stranding the screen on the idle message across
            // reboots until a valid manifest happens to arrive (SPEC §6).
            val manifest = json.decodeFromString<Manifest>(body)
            prefs.cachedManifest = body // offline fallback
            manifest
        }
    }

    fun cachedManifest(): Manifest? =
        prefs.cachedManifest?.let { runCatching { json.decodeFromString<Manifest>(it) }.getOrNull() }

    suspend fun heartbeat(
        appVersion: String,
        currentItem: String?,
        storageFreeMb: Int,
        plays: List<PlayRecord> = emptyList(),
        telemetry: TelemetrySample? = null,
        lastCrash: LastCrash? = null,
        mediaError: String? = null,
    ) = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(
            HeartbeatPayload.serializer(),
            HeartbeatPayload(
                appVersion, currentItem, storageFreeMb, plays,
                batteryPct = telemetry?.batteryPct,
                ramFreeMb = telemetry?.ramFreeMb,
                ramTotalMb = telemetry?.ramTotalMb,
                cpuPct = telemetry?.cpuPct,
                wifiRssi = telemetry?.wifiRssi,
                uptimeS = telemetry?.uptimeS,
                localIp = telemetry?.localIp,
                lastCrashAt = lastCrash?.at,
                lastCrashMessage = lastCrash?.message,
                mediaError = mediaError,
            ),
        )
        val request = authed(
            Request.Builder()
                .url("${base()}/api/device/heartbeat")
                .post(payload.toRequestBody(jsonType)),
        ).build()
        http.newCall(request).execute().use { response ->
            if (response.code == 401) throw RevokedException()
            check(response.isSuccessful) { "heartbeat ${response.code}" }
        }
    }

    /** Upload a support screenshot (raw JPEG body). */
    suspend fun uploadScreenshot(jpeg: ByteArray) = withContext(Dispatchers.IO) {
        val request = authed(
            Request.Builder()
                .url("${base()}/api/device/screenshot")
                .post(jpeg.toRequestBody("image/jpeg".toMediaType())),
        ).build()
        http.newCall(request).execute().use { response ->
            if (response.code == 401) throw RevokedException()
            check(response.isSuccessful) { "screenshot ${response.code}" }
        }
    }

    /**
     * A one-minute credential for the push socket, so the long-lived device token
     * is never placed in a URL (URLs end up in proxy access logs). Returns null
     * ONLY when an older server has no such endpoint (404) - the caller then falls
     * back to the legacy token. Any other failure throws, because working around
     * a transient error by exposing the token would defeat the whole point.
     */
    suspend fun fetchWsTicket(): String? = withContext(Dispatchers.IO) {
        val request = authed(
            Request.Builder()
                .url("${base()}/api/device/ws-ticket")
                .post("{}".toRequestBody(jsonType)),
        ).build()
        http.newCall(request).execute().use { response ->
            if (response.code == 401) throw RevokedException()
            if (response.code == 404) return@use null
            check(response.isSuccessful) { "ws-ticket ${response.code}" }
            org.json.JSONObject(response.bodyText("ws-ticket")).getString("ticket")
        }
    }

    /** Live push channel; caller handles reconnect with backoff. */
    fun openWebSocket(listener: WebSocketListener, ticket: String?): WebSocket {
        val wsBase = base().replaceFirst("http", "ws") // http→ws, https→wss
        val credential = if (ticket != null) {
            "ticket=${java.net.URLEncoder.encode(ticket, "UTF-8")}"
        } else {
            "token=${prefs.deviceToken}" // older server without /ws-ticket
        }
        val request = Request.Builder()
            .url("$wsBase/api/device/ws?$credential")
            .build()
        return http.newWebSocket(request, listener)
    }
}

class RevokedException : Exception("device token revoked")
