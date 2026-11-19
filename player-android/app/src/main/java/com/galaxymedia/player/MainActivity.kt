package com.galaxymedia.player

import android.os.Bundle
import android.os.SystemClock
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
import kotlinx.coroutines.sync.withLock
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

private const val HEARTBEAT_INTERVAL_MS = 45_000L
// Comfortably under Watchdog's staleness threshold so a healthy screen is never
// misjudged, even if a tick is delayed.
private const val ALIVE_MARK_INTERVAL_MS = 60_000L
// If the sync loop hasn't come round in this long it is wedged, not merely slow
// (a pass is ~45s), so stop vouching for it and let the watchdog act.
private const val LOOP_STALL_MS = 10 * 60_000L
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
    private var aliveJob: Job? = null
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
    private val syncMutex = kotlinx.coroutines.sync.Mutex() // one syncNow at a time
    // Advanced on every pass of the sync loop; the liveness mark is gated on it.
    @Volatile private var lastLoopAt = SystemClock.elapsedRealtime()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashReporter.install(this)
        // Started from the Activity, not BootReceiver: Android 15 forbids
        // starting a mediaPlayback foreground service from a BOOT_COMPLETED
        // receiver, and BootReceiver launches this Activity anyway.
        PlayerService.start(this)
        Watchdog.schedule(this)
        Watchdog.markAlive(this)
        // Liveness is tied to the Activity itself, not to the sync loop: that
        // loop only runs once paired, so a screen sitting on the pairing code
        // (or the server-URL prompt) would otherwise go stale and be relaunched
        // out from under whoever is standing there setting it up.
        // Marks liveness only while the screen is still doing real work. The
        // sync loop sets lastLoopAt on every pass; if that stops advancing the
        // app is wedged even though the Activity is technically alive, and the
        // watchdog should be allowed to relaunch it. Before pairing there is no
        // sync loop, so the Activity itself counts.
        aliveJob = lifecycleScope.launch {
            while (true) {
                delay(ALIVE_MARK_INTERVAL_MS)
                val loopHealthy = syncJob == null ||
                    SystemClock.elapsedRealtime() - lastLoopAt < LOOP_STALL_MS
                if (loopHealthy) Watchdog.markAlive(this@MainActivity)
            }
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        prefs = Prefs(this)
        api = ApiClient(prefs)
        cache = MediaCache(this, api.downloadHttp)
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
        engine = PlaybackEngine(
            this, root, cache, lifecycleScope,
            // Fires when an item goes on screen - drives the dashboard's
            // "now playing", so it must update at the START of an item.
            // Clipped to the server's limits (it also clips, but older servers
            // reject an over-long value - and with it the whole heartbeat).
            onItemChanged = { item -> currentItem = item?.take(200) },
            // Fires once an item has actually played through - this is the
            // proof-of-play record, so a file that failed to decode is excluded.
            onItemPlayed = { item ->
                if (item != null) {
                    synchronized(playsBuffer) {
                        playsBuffer.addLast(PlayRecord(item.take(300), java.time.Instant.now().toString()))
                        while (playsBuffer.size > 400) playsBuffer.removeFirst()
                    }
                }
            },
        )
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
            text = "Galaxy Media - server URL"
            textSize = 22f
            setTextColor(-1)
            gravity = Gravity.CENTER
        }
        val hintLabel = TextView(this).apply {
            text = "LAN install: http://192.168.x.x:8080\n" +
                "Public domain: https://signage.example.com"
            textSize = 14f
            setTextColor(-1)
            gravity = Gravity.CENTER
            setPadding(0, 12, 0, 0)
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
        column.addView(hintLabel)
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
        // The key identifies what is scheduled AND what it contains. Editing a
        // playlist in place keeps its id, so an id-only key would leave the
        // screen on the old items until something else forced a restart - but
        // including the items means an unchanged playlist keeps the same key and
        // playback is left alone, which is what lets a video reach its end and
        // be recorded as a play.
        // How many of a playlist's items can actually play right now. A zone
        // snapshots only the CACHED items when it starts, so without this in the
        // key an item that finishes downloading after playback began was never
        // added to the running loop - a new video on a slow link would not appear
        // until something else changed or the TV restarted. Downloads routinely
        // outlast the one-minute schedule tick, which is what made it common.
        fun playable(p: ManifestPlaylist?): Int =
            p?.items?.count { it.type == "url" || cache.isCached(it) } ?: 0
        val key = when {
            blackout -> "blackout"
            layout != null -> "layout:${layout.id}:${layout.zones.joinToString(",") { z ->
                "${z.key}=${z.playlist?.items?.joinToString("|") { "${it.id}:${it.durationMs}" }}#${playable(z.playlist)}"
            }}"
            else -> playlist?.let { p ->
                "${p.id}:${p.items.joinToString("|") { "${it.id}:${it.durationMs}" }}#${playable(p)}"
            }
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
                lastLoopAt = SystemClock.elapsedRealtime()
                try {
                    // Periodic full sync as a fallback when WS is blocked.
                    //
                    // Deliberately NOT awaited: syncNow downloads media on a
                    // client with no callTimeout and a 5-minute read gap, so a
                    // stalled transfer parks it for a long time - and for a big
                    // file over a bad link, that is normal rather than broken.
                    // Awaiting it here stops the heartbeat going out at all,
                    // which loses the proof-of-play the reports are billed on,
                    // and stalls lastLoopAt until the watchdog decides the app
                    // is wedged and relaunches it on top of itself. The sync
                    // has its own mutex, so letting it run alongside the
                    // heartbeat is safe; overlapping passes are already
                    // serialised there.
                    // lifecycleScope, NOT this loop's scope: a bare launch here
                    // makes the sync a CHILD of syncJob, so the download still
                    // ties the loop's scope up and a failure inside it cancels
                    // the parent - killing the heartbeat outright, which is
                    // worse than the stall it was meant to fix. The sync must
                    // outlive and stay independent of the heartbeat pass that
                    // started it, and only the Activity scope gives that.
                    if (System.currentTimeMillis() - lastSync > POLL_FALLBACK_MS) {
                        lastSync = System.currentTimeMillis()
                        lifecycleScope.launch { runCatching { syncNow() } }
                    }
                    // Self-update is deliberately NOT automatic: installing shows a
                    // system confirm prompt that pauses playback until someone is
                    // physically at the TV to tap it. Only the explicit "update"
                    // remote command (below) triggers a check-and-install.
                    val plays = synchronized(playsBuffer) { playsBuffer.toList() }
                    val lastCrash = CrashReporter.pending(this@MainActivity)
                    api.heartbeat(
                        BuildConfig.VERSION_NAME, currentItem, cache.freeSpaceMb(), plays,
                        telemetry.sample(), lastCrash, cache.lastError,
                    )
                    // Delivered: drop exactly what we sent, matched by identity rather
                    // than by count. The buffer can overflow (and shed its oldest
                    // entries) while the request is in flight, in which case removing
                    // N from the front would silently discard newer plays that were
                    // never sent - lost proof-of-play the reports are billed on.
                    synchronized(playsBuffer) {
                        val sent = plays.toMutableList()
                        playsBuffer.retainAll { play -> !sent.remove(play) }
                    }
                    if (lastCrash != null) CrashReporter.clear(this@MainActivity)
                } catch (e: RevokedException) {
                    onUnpaired()
                    return@launch
                } catch (e: kotlinx.coroutines.CancellationException) {
                    // Never swallowed by the catch below: cancellation is how the
                    // loop is meant to end (unpair, Activity teardown), and
                    // treating it as a transient network error would leave a
                    // cancelled job spinning instead of stopping.
                    throw e
                } catch (_: Exception) {
                    // Offline: keep playing from cache; next loop retries (plays/crash report stay buffered).
                }
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    /**
     * Serialised: the periodic sync and the "reload"/"update" remote commands can
     * all land at once, and MediaCache's own mutex only orders the downloads. Two
     * overlapping syncs would still race to applySchedule, letting an older
     * manifest win and leaving the screen on stale content.
     *
     * The periodic caller launches this without awaiting it, so a pass that is
     * still downloading when the next one comes round must be skipped rather
     * than queued - otherwise a slow link builds a backlog of syncs that all
     * run once the download finishes.
     */
    private suspend fun syncNow() {
        if (!syncMutex.tryLock()) return // a sync is already in flight
        try {
            syncNowLocked()
        } finally {
            syncMutex.unlock()
        }
    }

    private suspend fun syncNowLocked() {
        val manifest = api.fetchManifest()
        // A fresh manifest carries freshly signed URLs, so any past download
        // failure is stale information. Without this, an item that failed a few
        // times sits in an hour-long backoff even after the cause is fixed.
        cache.resetFailures()
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
            // Deliberately does NOT reset activePlaylistId. Doing so defeats the
            // "no change" guard in applySchedule, so every sync tore the
            // ZonePlayer down, released the ExoPlayer mid-item and restarted the
            // playlist at item 0. With a sync every POLL_FALLBACK_MS (60s) and a
            // 90s video, the item could never reach its end: STATE_ENDED never
            // arrived, so the play was never recorded even though the screen
            // looked perfectly healthy. applySchedule already re-reads the
            // manifest and restarts on its own when the resolved playlist,
            // layout or blackout state actually differs; a manifest whose
            // content changed under the same id is picked up by the media cache
            // without needing playback to be interrupted.
            applySchedule(manifest)
        }
        runCatching {
            api.heartbeat(BuildConfig.VERSION_NAME, currentItem ?: "Idle - nothing assigned", cache.freeSpaceMb())
        }
        // A sync that got this far proves the server is reachable again, so don't
        // leave the socket sitting on a 2-minute backoff earned during the outage -
        // that delays every push command for minutes after recovery.
        wsFailureCount = 0
    }

    private fun connectWebSocket() {
        webSocket?.cancel()
        if (prefs.deviceToken == null) return
        val generation = ++wsGeneration
        lifecycleScope.launch {
        // Trade the device token for a one-minute ticket so it never sits in a URL.
        // null = an older server without the endpoint, which gets the legacy form.
        val ticket = try {
            api.fetchWsTicket()
        } catch (e: RevokedException) {
            onUnpaired()
            return@launch
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            // Could not get a ticket right now: back off and retry, exactly like a
            // failed connection - never fall back to putting the token in the URL.
            if (generation == wsGeneration) {
                wsFailureCount++
                val delayMs = (WS_RECONNECT_BASE_MS * wsFailureCount).coerceAtMost(WS_RECONNECT_MAX_MS)
                root.postDelayed({ if (generation == wsGeneration) connectWebSocket() }, delayMs)
            }
            return@launch
        }
        if (generation != wsGeneration) return@launch // superseded while we were fetching
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
                            "reload" -> {
                                // An explicit tech request: retry every item, including
                                // ones sitting in a download backoff.
                                cache.forgetAllFailures()
                                lifecycleScope.launch { runCatching { syncNow() } }
                            }
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
        }, ticket)
        }
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

    /**
     * The Activity is singleTask, so a watchdog relaunch of an app that is still
     * running lands here rather than in onCreate. Without re-marking liveness the
     * mark would stay stale forever and the watchdog would relaunch on every
     * check - a permanent 5-minute flicker on a screen that was never broken.
     */
    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        Watchdog.markAlive(this)
    }

    override fun onResume() {
        super.onResume()
        // Any path back to the foreground proves the app is alive, including ones
        // that skip both onCreate and onNewIntent.
        Watchdog.markAlive(this)
    }

    override fun onDestroy() {
        wsGeneration++ // invalidate any reconnect already scheduled via postDelayed
        engine.release()
        webSocket?.cancel()
        super.onDestroy()
    }
}
