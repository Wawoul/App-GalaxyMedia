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

    suspend fun register(): RegisterResponse = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${base()}/api/device/register")
            .post("{}".toRequestBody(jsonType))
            .build()
        http.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "register failed: ${response.code}" }
            json.decodeFromString<RegisterResponse>(response.body!!.string())
        }
    }

    suspend fun pollPairing(requestId: String): PollResponse = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("${base()}/api/device/register/$requestId").build()
        http.newCall(request).execute().use { response ->
            when {
                response.isSuccessful -> json.decodeFromString<PollResponse>(response.body!!.string())
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
            val body = response.body!!.string()
            prefs.cachedManifest = body // offline fallback (SPEC §6)
            json.decodeFromString<Manifest>(body)
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
