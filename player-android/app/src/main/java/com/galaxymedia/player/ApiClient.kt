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
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
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
                lastCrashAt = lastCrash?.at,
                lastCrashMessage = lastCrash?.message,
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

    /** Live push channel; caller handles reconnect with backoff. */
    fun openWebSocket(listener: WebSocketListener): WebSocket {
        val wsBase = base().replaceFirst("http", "ws") // http→ws, https→wss
        val request = Request.Builder()
            .url("$wsBase/api/device/ws?token=${prefs.deviceToken}")
            .build()
        return http.newWebSocket(request, listener)
    }
}

class RevokedException : Exception("device token revoked")
