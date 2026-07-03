package com.galaxymedia.player

import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.updateLayoutParams
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

private const val HEARTBEAT_INTERVAL_MS = 45_000L
private const val POLL_FALLBACK_MS = 60_000L
private const val CONNECT_RETRY_DELAY_MS = 10_000L
private const val CONNECT_RETRY_SLOW_MS = 60_000L // background cadence after the fast attempts are exhausted
private const val MAX_CONNECT_ATTEMPTS = 5 // fast retries before dropping to the slow background cadence
private const val WS_RECONNECT_BASE_MS = 15_000L
private const val WS_RECONNECT_MAX_MS = 120_000L // caps a down server from being hammered every 15s for hours

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
    private lateinit var cancelButton: Button

    private var webSocket: WebSocket? = null
    private var syncJob: Job? = null
    private var scheduleJob: Job? = null
    private var pairingJob: Job? = null
    // Bumped on every connectWebSocket() call; a scheduled reconnect checks
    // this before firing so a stale attempt from a destroyed/superseded
    // instance (e.g. the "restart" command's recreate()) can't reconnect a
    // second, duplicate socket behind the new instance's back.
    // Written from the main thread (connectWebSocket/onDestroy) and OkHttp's
    // callback thread (onOpen/onFailure) - @Volatile for a correct read/write.
    @Volatile private var wsGeneration = 0
    @Volatile private var wsFailureCount = 0
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
        // Visible only while pairing (setup + connect-retry + waiting for a code claim);
        // lets the user bail out and fix the server URL instead of being stuck.
        cancelButton = Button(this).apply {
            text = "Cancel"
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL,
            ).apply { setMargins(0, 0, 0, 64) }
        }
        root.addView(statusView)
        root.addView(updateBadge)
        root.addView(cancelButton)
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
            text = "Galaxy Media - server URL\n" +
                "LAN install: http://192.168.x.x:8080  ·  Public domain: https://signage.example.com"
            textSize = 22f
            setTextColor(-1)
            gravity = Gravity.CENTER
        }
        cancelButton.visibility = View.GONE
        val input = EditText(this).apply {
            hint = "http:// or https://…"
            // No scheme pre-filled: a LAN install is plain http:// only (no cert), and
            // defaulting this field to "https://" meant LAN users kept it unedited and
            // got a silent, endlessly-retried TLS handshake failure against a plaintext server.
            setText(prefs.serverUrl ?: "") // keep whatever was last tried, so a typo is easy to fix
            // Plain EditText defaults to multi-line, so Enter just inserts "\n"
            // instead of submitting - force single-line with a "Go" IME action.
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
        }
        val connectButton = Button(this).apply {
            text = "Connect"
        }
        column.addView(label)
        column.addView(input)
        column.addView(connectButton)
        statusView.visibility = View.GONE
        root.addView(column)

        fun submit() {
            val url = input.text.toString().trim()
            if (url.startsWith("http")) {
                prefs.serverUrl = url
                root.removeView(column)
                statusView.visibility = View.VISIBLE
                startPairing()
            }
        }

        input.setOnEditorActionListener { _, _, _ -> submit(); true }
        // Backup path: some TV remotes/keyboards send a raw Enter key event
        // instead of (or in addition to) the IME action above.
        input.setOnKeyListener { _, keyCode, event ->
            if (event.action == KeyEvent.ACTION_DOWN &&
                (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER)
            ) {
                submit()
                true
            } else {
                false
            }
        }
        connectButton.setOnClickListener { submit() }
    }

    // ── Pairing: show the code, poll until an admin claims it ────────────────

    private fun startPairing() {
        pairingJob?.cancel() // never let two pairing loops race (double-submit, unpair storms)
        cancelButton.text = "Cancel"
        cancelButton.visibility = View.VISIBLE
        cancelButton.setOnClickListener {
            pairingJob?.cancel()
            // Forget the in-flight request: its code stays claimable server-side
            // until it expires, but nothing will ever poll it again.
            prefs.pairingRequestId = null
            cancelButton.visibility = View.GONE
            showServerSetup() // prefs.serverUrl is left as-is so the URL can be edited, not retyped
        }

        pairingJob = lifecycleScope.launch {
            var failedAttempts = 0
            while (prefs.deviceToken == null) {
                try {
                    val registration = api.register()
                    failedAttempts = 0
                    prefs.pairingRequestId = registration.requestId
                    statusView.text =
                        "Pair this screen\n\n${registration.code}\n\n${prefs.serverUrl}"

                    val deadline = System.currentTimeMillis() + registration.expiresInS * 1000L
                    while (System.currentTimeMillis() < deadline) {
                        delay(registration.pollIntervalS * 1000L)
                        val poll = api.pollPairing(registration.requestId)
                        if (poll.status == "paired" && poll.deviceToken != null) {
                            prefs.deviceToken = poll.deviceToken
                            cancelButton.visibility = View.GONE
                            startPlayer()
                            return@launch
                        }
                        if (poll.status == "expired") break
                    }
                } catch (e: Exception) {
                    failedAttempts++
                    // A failed TLS handshake against a plaintext LAN server (https:// typed
                    // for a http://-only install) looks like this, not a generic timeout -
                    // worth calling out since the fix is "change the scheme", not "wait".
                    val sslHint = if (e is javax.net.ssl.SSLException) {
                        "\nLooks like a TLS/SSL error - if this is a LAN install, use http:// not https://."
                    } else ""
                    if (failedAttempts >= MAX_CONNECT_ATTEMPTS) {
                        // Likely a bad address - stop the fast loop and tell the user.
                        // But KEEP retrying slowly in the background: an unpaired TV
                        // rebooting after a power cut (router still coming up) must
                        // self-recover with no one holding a remote (SPEC §6).
                        statusView.text = "Cannot reach server\n${prefs.serverUrl}$sslHint\n\n" +
                            "Still trying in the background - check the address if this persists."
                        cancelButton.text = "Change server"
                        delay(CONNECT_RETRY_SLOW_MS)
                    } else {
                        statusView.text = "Cannot reach server\n${prefs.serverUrl}$sslHint\n" +
                            "Retrying… ($failedAttempts/$MAX_CONNECT_ATTEMPTS)"
                        delay(CONNECT_RETRY_DELAY_MS)
                    }
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
            while (true) {
                try {
                    // Periodic full sync as a fallback when WS is blocked.
                    if (System.currentTimeMillis() - lastSync > POLL_FALLBACK_MS) {
                        syncNow()
                        lastSync = System.currentTimeMillis()
                    }
                    // Self-update is deliberately NOT automatic: installing shows a
                    // system confirm prompt that pauses playback until someone is
                    // physically at the TV to tap it. Only the explicit "update"
                    // remote command (below) triggers a check-and-install.
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
        val generation = ++wsGeneration
        webSocket = api.openWebSocket(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                wsFailureCount = 0
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val message = runCatching { JSONObject(text) }.getOrNull() ?: return
                runOnUiThread {
                    when (message.optString("type")) {
                        "sync" -> lifecycleScope.launch { runCatching { syncNow() } }
                        "unpair" -> onUnpaired()
                        "command" -> when (message.optString("command")) {
                            "reload" -> lifecycleScope.launch { runCatching { syncNow() } }
                            "screenshot" -> captureAndUpload()
                            "identify" -> identify()
                            "clear_cache" -> {
                                cache.clear()
                                lifecycleScope.launch { runCatching { syncNow() } }
                            }
                            "restart" -> recreate()
                            // Explicit, tech-initiated only (SPEC): installing shows a
                            // system confirm prompt that pauses playback until someone
                            // is on-site to tap it, so this must never fire on its own.
                            "update" -> lifecycleScope.launch { runCatching { updater.checkAndInstall() } }
                        }
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                // Stale callback from a superseded connection (recreate(), or a
                // newer connectWebSocket() already replaced this one) - drop it.
                if (generation != wsGeneration) return
                wsFailureCount++
                // Backoff instead of hammering a down server forever; polling in
                // the sync loop covers the gap either way.
                val delayMs = (WS_RECONNECT_BASE_MS * wsFailureCount).coerceAtMost(WS_RECONNECT_MAX_MS)
                root.postDelayed({ if (generation == wsGeneration) connectWebSocket() }, delayMs)
            }
        })
    }

    /** Grab what's on screen (PixelCopy captures video surfaces too) and upload it. */
    private fun captureAndUpload() {
        if (android.os.Build.VERSION.SDK_INT < 26) return // PixelCopy needs API 26
        // Window dimensions, not root's: applyOrientation() swaps root to h×w on
        // rotated screens, which would squash the copied window surface.
        val decor = window.decorView
        val bitmap = runCatching {
            android.graphics.Bitmap.createBitmap(
                decor.width.coerceAtLeast(1), decor.height.coerceAtLeast(1),
                android.graphics.Bitmap.Config.ARGB_8888,
            )
        }.getOrNull() ?: return

        // PixelCopy can throw synchronously on some device/GPU-driver combinations
        // (e.g. the window not being in a copyable state) - never let a screenshot
        // request crash the whole app.
        runCatching {
            android.view.PixelCopy.request(window, bitmap, { result ->
                // The activity may have been destroyed (e.g. a "restart" command)
                // between the request and this callback - launch would silently
                // never run on a cancelled scope, leaking the bitmap.
                if (result != android.view.PixelCopy.SUCCESS || !lifecycleScope.isActive) {
                    bitmap.recycle()
                    return@request
                }
                // Off the main thread: compressing a full-resolution (up to 4K)
                // capture is slow enough to ANR a cheap TV box otherwise.
                lifecycleScope.launch(Dispatchers.IO) {
                    val jpeg = runCatching {
                        val maxDim = 1280
                        val scale = (maxDim.toFloat() / maxOf(bitmap.width, bitmap.height)).coerceAtMost(1f)
                        val toUpload = if (scale < 1f) {
                            android.graphics.Bitmap.createScaledBitmap(
                                bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true,
                            )
                        } else {
                            bitmap
                        }
                        val out = java.io.ByteArrayOutputStream()
                        toUpload.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, out)
                        if (toUpload !== bitmap) toUpload.recycle()
                        out.toByteArray()
                    }.getOrNull()
                    // Free the ~33MB-at-4K capture BEFORE the (possibly slow) upload,
                    // so stacked screenshot commands can't OOM a small TV box.
                    bitmap.recycle()
                    if (jpeg != null) {
                        try {
                            api.uploadScreenshot(jpeg)
                        } catch (e: RevokedException) {
                            runOnUiThread { onUnpaired() }
                        } catch (_: Exception) {
                            // offline/server hiccup - the next screenshot command retries
                        }
                    }
                }
            }, android.os.Handler(mainLooper))
        }.onFailure {
            bitmap.recycle()
        }
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
        // A box that gets unpaired is usually about to be paired to a
        // DIFFERENT screen - without this, its first heartbeat there would
        // flush proof-of-play records naming the previous screen's content.
        synchronized(playsBuffer) { playsBuffer.clear() }
        prefs.clearPairing()
        statusView.visibility = View.VISIBLE
        startPairing()
    }

    override fun onDestroy() {
        wsGeneration++ // invalidate any reconnect already scheduled via postDelayed
        engine.release()
        webSocket?.cancel()
        super.onDestroy()
    }
}
