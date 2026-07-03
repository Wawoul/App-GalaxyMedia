package com.galaxymedia.player

import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.updateLayoutParams
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

private const val HEARTBEAT_INTERVAL_MS = 45_000L
private const val POLL_FALLBACK_MS = 60_000L
private const val UPDATE_CHECK_MS = 6 * 3600_000L

class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var api: ApiClient
    private lateinit var cache: MediaCache
    private lateinit var updater: UpdateManager
    private lateinit var engine: PlaybackEngine
    private lateinit var telemetry: Telemetry
    private lateinit var root: FrameLayout
    private lateinit var statusView: TextView
    private lateinit var updateBadge: TextView

    private var webSocket: WebSocket? = null
    private var syncJob: Job? = null
    private var scheduleJob: Job? = null
    private var currentItem: String? = null
    private var isPlaying = false
    private var activePlaylistId: String? = null
    private val playsBuffer = ArrayDeque<PlayRecord>() // proof-of-play, flushed with heartbeats

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        prefs = Prefs(this)
        api = ApiClient(prefs)
        cache = MediaCache(this, api.http)
        updater = UpdateManager(this, api, prefs)
        telemetry = Telemetry(this)

        root = FrameLayout(this)
        statusView = TextView(this).apply {
            gravity = Gravity.CENTER
            textSize = 32f
            setTextColor(-1)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT,
            )
        }
        // Unobtrusive "Updating… 43%" badge, bottom-right, only visible during downloads.
        updateBadge = TextView(this).apply {
            textSize = 16f
            setTextColor(-1)
            setBackgroundColor(0x99000000.toInt())
            setPadding(24, 12, 24, 12)
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.END,
            ).apply { setMargins(0, 0, 32, 32) }
        }
        engine = PlaybackEngine(this, root, cache, lifecycleScope) { item ->
            currentItem = item
            if (item != null) {
                synchronized(playsBuffer) {
                    playsBuffer.addLast(PlayRecord(item, java.time.Instant.now().toString()))
                    while (playsBuffer.size > 400) playsBuffer.removeFirst()
                }
            }
        }
        root.addView(statusView)
        root.addView(updateBadge)
        setContentView(root)

        when {
            prefs.serverUrl == null -> showServerSetup()
            prefs.deviceToken == null -> startPairing()
            else -> startPlayer()
        }
    }

    // ── First launch: point the app at your Galaxy Media server ──────────────

    private fun showServerSetup() {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT,
            )
        }
        val label = TextView(this).apply {
            text = "Galaxy Media - server URL (e.g. https://signage.example.com)"
            textSize = 22f
            setTextColor(-1)
            gravity = Gravity.CENTER
        }
        val input = EditText(this).apply {
            hint = "https://…"
            setText("https://")
        }
        column.addView(label)
        column.addView(input)
        statusView.visibility = View.GONE
        root.addView(column)

        input.setOnEditorActionListener { _, _, _ ->
            val url = input.text.toString().trim()
            if (url.startsWith("http")) {
                prefs.serverUrl = url
                root.removeView(column)
                statusView.visibility = View.VISIBLE
                startPairing()
            }
            true
        }
    }

    // ── Pairing: show the code, poll until an admin claims it ────────────────

    private fun startPairing() {
        lifecycleScope.launch {
            while (prefs.deviceToken == null) {
                try {
                    val registration = api.register()
                    prefs.pairingRequestId = registration.requestId
                    statusView.text =
                        "Pair this screen\n\n${registration.code}\n\n${prefs.serverUrl}"

                    val deadline = System.currentTimeMillis() + registration.expiresInS * 1000L
                    while (System.currentTimeMillis() < deadline) {
                        delay(registration.pollIntervalS * 1000L)
                        val poll = api.pollPairing(registration.requestId)
                        if (poll.status == "paired" && poll.deviceToken != null) {
                            prefs.deviceToken = poll.deviceToken
                            startPlayer()
                            return@launch
                        }
                        if (poll.status == "expired") break
                    }
                } catch (e: Exception) {
                    statusView.text = "Cannot reach server\n${prefs.serverUrl}\nRetrying…"
                    delay(10_000)
                }
            }
        }
    }

    // ── Player mode: cache-first playback + background sync ──────────────────

    /** Friendly idle screen for a paired TV with nothing assigned yet. */
    private fun showIdle() {
        val screen = api.cachedManifest()?.screen
        val brand = screen?.brandName?.takeIf { it.isNotBlank() } ?: "Galaxy Media"
        statusView.text = buildString {
            append(":)\n\n")
            append("This screen is connected to ").append(brand)
            if (screen?.name != null) append("\n“").append(screen.name).append("”")
            append("\n\nAssigned content will display here")
        }
        statusView.visibility = View.VISIBLE
    }

    private fun setPlaying(playing: Boolean) {
        isPlaying = playing
        if (playing) {
            statusView.text = ""
            statusView.visibility = View.GONE
        } else {
            showIdle()
        }
    }

    private var appliedOrientation = -1

    /**
     * Software rotation for portrait / flipped installs (SPEC §4). TV panels are
     * landscape-fixed, so the content view is rotated and resized instead of
     * relying on requestedOrientation (which TVs ignore).
     */
    private fun applyOrientation(deg: Int) {
        if (deg == appliedOrientation) return
        appliedOrientation = deg
        val metrics = resources.displayMetrics
        val w = metrics.widthPixels
        val h = metrics.heightPixels
        root.rotation = deg.toFloat()
        if (deg % 180 != 0) {
            // Swap dimensions and re-center: a h×w view rotated ±90° fills the panel.
            root.updateLayoutParams { width = h; height = w }
            root.translationX = (w - h) / 2f
            root.translationY = (h - w) / 2f
        } else {
            root.updateLayoutParams {
                width = FrameLayout.LayoutParams.MATCH_PARENT
                height = FrameLayout.LayoutParams.MATCH_PARENT
            }
            root.translationX = 0f
            root.translationY = 0f
        }
    }

    /** (Re)start playback with whatever the schedule says should be on now. */
    private fun applySchedule(manifest: Manifest?) {
        if (manifest != null) applyOrientation(manifest.screen.orientation)
        val entry = manifest?.takeIf { it.schedules.isNotEmpty() }
            ?.let { Schedule.resolveActive(it.schedules, it.screen.timezone) }
        val blackout = entry?.blackout == true
        val layout = if (blackout) null else entry?.layout
        val playlist = when {
            blackout || layout != null || manifest == null -> null
            manifest.schedules.isNotEmpty() -> entry?.playlist
            else -> manifest.playlist // legacy manifests without schedules
        }
        val key = when {
            blackout -> "blackout"
            layout != null -> "layout:${layout.id}"
            else -> playlist?.id
        }
        if (key == activePlaylistId && (isPlaying || blackout)) return // no change
        activePlaylistId = key

        when {
            blackout -> {
                // Scheduled "off": stop playback, hide everything, pure black.
                engine.stop()
                isPlaying = false
                currentItem = "Black screen (scheduled)"
                statusView.text = ""
                statusView.visibility = View.GONE
            }
            layout != null -> setPlaying(engine.playLayout(layout))
            else -> setPlaying(engine.play(playlist))
        }
    }

    private fun startPlayer() {
        // Play whatever we already have immediately (offline boot, SPEC §6).
        applySchedule(api.cachedManifest())
        // Dayparting runs on the TV's own clock - works with no network at all.
        scheduleJob?.cancel()
        scheduleJob = lifecycleScope.launch {
            while (true) {
                delay(60_000)
                applySchedule(api.cachedManifest())
            }
        }
        connectWebSocket()
        syncJob?.cancel()
        syncJob = lifecycleScope.launch {
            var lastSync = 0L
            var lastUpdateCheck = 0L
            while (true) {
                try {
                    // Periodic full sync as a fallback when WS is blocked.
                    if (System.currentTimeMillis() - lastSync > POLL_FALLBACK_MS) {
                        syncNow()
                        lastSync = System.currentTimeMillis()
                    }
                    // Self-update check every ~6 hours.
                    if (System.currentTimeMillis() - lastUpdateCheck > UPDATE_CHECK_MS) {
                        lastUpdateCheck = System.currentTimeMillis()
                        runCatching { updater.checkAndInstall() }
                    }
                    val plays = synchronized(playsBuffer) { playsBuffer.toList() }
                    api.heartbeat(BuildConfig.VERSION_NAME, currentItem, cache.freeSpaceMb(), plays, telemetry.sample())
                    // Delivered: drop what we sent (new plays may have arrived meanwhile).
                    synchronized(playsBuffer) { repeat(plays.size) { if (playsBuffer.isNotEmpty()) playsBuffer.removeFirst() } }
                } catch (e: RevokedException) {
                    onUnpaired()
                    return@launch
                } catch (_: Exception) {
                    // Offline: keep playing from cache; next loop retries (plays stay buffered).
                }
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    private suspend fun syncNow() {
        val manifest = api.fetchManifest()
        var lastReported = -100
        // Cache everything across ALL schedules so upcoming dayparts are ready (SPEC §6).
        cache.syncAll(Schedule.allItems(manifest)) { percent ->
            runOnUiThread {
                updateBadge.text = if (percent < 100) "Updating… $percent%" else "Updating…"
                updateBadge.visibility = if (percent < 100) View.VISIBLE else View.GONE
            }
            // Surface progress on the dashboard too (throttled to every 20%).
            if (percent - lastReported >= 20 && percent < 100) {
                lastReported = percent
                lifecycleScope.launch {
                    runCatching {
                        api.heartbeat(BuildConfig.VERSION_NAME, "Updating… $percent%", cache.freeSpaceMb())
                    }
                }
            }
        }
        runOnUiThread {
            updateBadge.visibility = View.GONE
            activePlaylistId = null // force re-evaluation with the fresh manifest
            applySchedule(manifest)
        }
        runCatching {
            api.heartbeat(BuildConfig.VERSION_NAME, currentItem ?: "Idle - nothing assigned", cache.freeSpaceMb())
        }
    }

    private fun connectWebSocket() {
        webSocket?.cancel()
        if (prefs.deviceToken == null) return
        webSocket = api.openWebSocket(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val message = runCatching { JSONObject(text) }.getOrNull() ?: return
                runOnUiThread {
                    when (message.optString("type")) {
                        "sync" -> lifecycleScope.launch { runCatching { syncNow() } }
                        "unpair" -> onUnpaired()
                        "command" -> when (message.optString("command")) {
                            "reload" -> lifecycleScope.launch {
                                runCatching { syncNow() }
                                runCatching { updater.checkAndInstall() }
                            }
                            "screenshot" -> captureAndUpload()
                            "identify" -> identify()
                            "clear_cache" -> {
                                cache.clear()
                                lifecycleScope.launch { runCatching { syncNow() } }
                            }
                            "restart" -> recreate()
                        }
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                // Reconnect with delay; polling in the sync loop covers the gap.
                root.postDelayed({ connectWebSocket() }, 15_000)
            }
        })
    }

    /** Grab what's on screen (PixelCopy captures video surfaces too) and upload it. */
    private fun captureAndUpload() {
        if (android.os.Build.VERSION.SDK_INT < 26) return // PixelCopy needs API 26
        // Window dimensions, not root's: applyOrientation() swaps root to h×w on
        // rotated screens, which would squash the copied window surface.
        val decor = window.decorView
        val bitmap = android.graphics.Bitmap.createBitmap(
            decor.width.coerceAtLeast(1), decor.height.coerceAtLeast(1),
            android.graphics.Bitmap.Config.ARGB_8888,
        )
        android.view.PixelCopy.request(window, bitmap, { result ->
            if (result == android.view.PixelCopy.SUCCESS) {
                lifecycleScope.launch {
                    runCatching {
                        val out = java.io.ByteArrayOutputStream()
                        bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, out)
                        api.uploadScreenshot(out.toByteArray())
                    }
                    bitmap.recycle()
                }
            } else {
                bitmap.recycle()
            }
        }, android.os.Handler(mainLooper))
    }

    private fun identify() {
        val name = api.cachedManifest()?.screen?.name ?: "This screen"
        statusView.text = name
        statusView.visibility = View.VISIBLE
        root.postDelayed({
            if (activePlaylistId == "blackout") {
                // Return to scheduled black, not the idle message.
                statusView.text = ""
                statusView.visibility = View.GONE
            } else {
                setPlaying(isPlaying)
            }
        }, 5_000)
    }

    private fun onUnpaired() {
        syncJob?.cancel()
        scheduleJob?.cancel()
        webSocket?.cancel()
        engine.stop()
        cache.clear()
        prefs.clearPairing()
        statusView.visibility = View.VISIBLE
        startPairing()
    }

    override fun onDestroy() {
        engine.release()
        webSocket?.cancel()
        super.onDestroy()
    }
}
