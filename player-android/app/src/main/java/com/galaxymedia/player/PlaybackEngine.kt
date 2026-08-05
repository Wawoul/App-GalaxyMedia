package com.galaxymedia.player

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Color
import android.text.TextUtils
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

private const val DEFAULT_IMAGE_MS = 10_000L
private const val DEFAULT_URL_MS = 30_000L
// Floor between attempts when an item fails to play, so an undecodable file
// can't spin the playlist loop at full CPU.
private const val ERROR_RETRY_MS = 5_000L

/**
 * One rectangular region playing its own playlist loop (images, videos, URLs).
 * A fullscreen playlist is just a single zone covering the whole root.
 */
@SuppressLint("SetJavaScriptEnabled")
private class ZonePlayer(
    context: Context,
    val container: FrameLayout,
    private val cache: MediaCache,
    private val scope: CoroutineScope,
    private val onItemChanged: ((String?) -> Unit)?,
    private val onItemPlayed: ((String?) -> Unit)?,
) {
    private val match = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT,
    )
    private val imageView = ImageView(context).apply {
        layoutParams = match
        scaleType = ImageView.ScaleType.FIT_CENTER
        visibility = View.GONE
    }
    private val exoPlayer = ExoPlayer.Builder(context).build()
    // Inflated (not constructed) so surface_type=texture_view applies - see
    // res/layout/zone_player_view.xml for why screenshots need TextureView.
    private val playerView = (
        LayoutInflater.from(context).inflate(R.layout.zone_player_view, container, false) as PlayerView
        ).apply {
        layoutParams = match
        useController = false
        player = exoPlayer
        visibility = View.GONE
    }
    // URL items: JS on (dashboards need it), everything else off (SPEC §8).
    private val webView = WebView(context).apply {
        layoutParams = match
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.setGeolocationEnabled(false)
        settings.mediaPlaybackRequiresUserGesture = false
        visibility = View.GONE
    }
    private var loop: Job? = null

    init {
        container.addView(playerView)
        container.addView(webView)
        container.addView(imageView)
    }

    /** Starts the loop; returns false when there is nothing playable. */
    fun play(playlist: ManifestPlaylist?): Boolean {
        loop?.cancel()
        val items = playlist?.items?.filter { it.type == "url" || cache.isCached(it) } ?: emptyList()
        if (items.isEmpty()) {
            onItemChanged?.invoke(null)
            hideAll()
            return false
        }
        loop = scope.launch {
            var index = 0
            while (true) {
                val item = items[index % items.size]
                val label = item.name ?: item.url ?: item.mediaId
                // Two different questions, so two callbacks. "What is on screen
                // right now" must be answered when the item STARTS, or the
                // dashboard reads blank for the whole of a video. "What actually
                // played" is proof-of-play, and a file ExoPlayer rejected must
                // not be billed as a play.
                onItemChanged?.invoke(label)
                val played = when (item.type) {
                    "video" -> playVideo(item)
                    "image" -> showImage(item)
                    "url" -> showUrl(item)
                    else -> {
                        delay(1_000)
                        false
                    }
                }
                if (played) onItemPlayed?.invoke(label)
                index++
            }
        }
        return true
    }

    private fun hideAll() {
        imageView.visibility = View.GONE
        playerView.visibility = View.GONE
        webView.visibility = View.GONE
        exoPlayer.stop()
    }

    /** @return true if the image was decoded and shown, false if the file is unusable. */
    private suspend fun showImage(item: ManifestItem): Boolean {
        // Stop the previous frame's animated GIF/WebP before swapping - the
        // playlist loop swaps images every ~10s by default, and each unstopped
        // AnimatedImageDrawable keeps decoding in the background otherwise,
        // piling up native decoder/frame-buffer memory on a TV box.
        (imageView.drawable as? android.graphics.drawable.AnimatedImageDrawable)?.stop()
        val file = cache.fileFor(item)
        // ImageDecoder (API 28+) animates GIF/WebP; older TVs get the first frame.
        val shown = if (android.os.Build.VERSION.SDK_INT >= 28) {
            runCatching {
                val drawable = withContext(Dispatchers.IO) {
                    android.graphics.ImageDecoder.decodeDrawable(
                        android.graphics.ImageDecoder.createSource(file),
                    )
                }
                // A rapid second "reload" cancels this loop mid-decode; without
                // this the stale frame would still be pushed into a view the new
                // loop has already taken over.
                currentCoroutineContext().ensureActive()
                imageView.setImageDrawable(drawable)
                (drawable as? android.graphics.drawable.AnimatedImageDrawable)?.start()
                true
            }.getOrDefault(false)
        } else false
        if (!shown) {
            // Decode off the main thread: a large JPEG on a slow TV box otherwise
            // blocks the UI long enough to risk an ANR.
            val bitmap = withContext(Dispatchers.IO) {
                runCatching { BitmapFactory.decodeFile(file.absolutePath) }.getOrNull()
            }
            if (bitmap == null) {
                // Undecodable file. Returning early here used to skip the delay
                // below as well, so a zone whose only item is a corrupt image
                // span the loop at full CPU - and it was still billed as a play.
                delay(ERROR_RETRY_MS)
                return false
            }
            // Recycle the outgoing bitmap: on API 24-27 nothing else frees it, and
            // the playlist swaps images every few seconds for weeks at a time.
            val previous = (imageView.drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap
            imageView.setImageBitmap(bitmap)
            if (previous != null && previous != bitmap && !previous.isRecycled) previous.recycle()
        }
        imageView.visibility = View.VISIBLE
        playerView.visibility = View.GONE
        webView.visibility = View.GONE
        exoPlayer.stop()
        delay(item.durationMs ?: DEFAULT_IMAGE_MS)
        return true
    }

    /** @return true if the page/stream was shown, false if it could not play. */
    private suspend fun showUrl(item: ManifestItem): Boolean {
        val url = item.url ?: return false
        if (isStreamUrl(url)) return playStream(item, url)
        webView.loadUrl(url)
        webView.visibility = View.VISIBLE
        imageView.visibility = View.GONE
        playerView.visibility = View.GONE
        exoPlayer.stop()
        delay(item.durationMs ?: DEFAULT_URL_MS)
        webView.loadUrl("about:blank")
        return true
    }

    private fun isStreamUrl(url: String): Boolean {
        val path = url.substringBefore('?').lowercase()
        return path.endsWith(".m3u8") || path.endsWith(".mpd")
    }

    /**
     * Live stream (HLS/DASH) straight off the network - can't be cached, so it
     * needs connectivity. The periodic restart at the end of each duration also
     * recovers from stalled streams. Skipped quickly when unreachable.
     *
     * @return true if the stream played, false if it never connected - a dead
     * origin must not be billed as an hour of playback while the screen is black.
     */
    private suspend fun playStream(item: ManifestItem, url: String): Boolean {
        playerView.visibility = View.VISIBLE
        imageView.visibility = View.GONE
        webView.visibility = View.GONE
        exoPlayer.volume = if (item.muted) 0f else 1f
        exoPlayer.setMediaItem(MediaItem.fromUri(url))
        exoPlayer.prepare()
        exoPlayer.play()
        // Run for the configured duration (default 1 hour - a single-item
        // playlist just restarts it, so it is effectively continuous with a
        // periodic self-heal), but abandon early if the stream dies. Waiting out
        // the full hour on a dead origin would leave the screen black and, worse,
        // bill it as an hour of playback.
        var failed = false
        val done = CompletableDeferred<Unit>()
        val listener = object : Player.Listener {
            override fun onPlayerErrorChanged(error: androidx.media3.common.PlaybackException?) {
                if (error != null) {
                    failed = true
                    done.complete(Unit)
                }
            }
        }
        exoPlayer.addListener(listener)
        try {
            withTimeoutOrNull(item.durationMs ?: 3_600_000L) { done.await() }
        } finally {
            exoPlayer.removeListener(listener)
            exoPlayer.stop()
        }
        if (failed) delay(ERROR_RETRY_MS)
        return !failed
    }

    /** @return true if the item played, false if ExoPlayer rejected it. */
    private suspend fun playVideo(item: ManifestItem): Boolean {
        playerView.visibility = View.VISIBLE
        imageView.visibility = View.GONE
        webView.visibility = View.GONE
        exoPlayer.volume = if (item.muted) 0f else 1f
        exoPlayer.setMediaItem(MediaItem.fromUri(cache.fileFor(item).toURI().toString()))
        exoPlayer.prepare()
        exoPlayer.play()
        val fixed = item.durationMs
        val ok = if (fixed != null) {
            delay(fixed)
            true
        } else {
            awaitPlaybackEnd()
        }
        exoPlayer.stop()
        // A file ExoPlayer can't decode fails instantly. Without this floor, a
        // zone whose only item is corrupt re-enters the loop immediately and
        // pegs a CPU core while emitting hundreds of play records a second.
        if (!ok) delay(ERROR_RETRY_MS)
        return ok
    }

    /** @return true if playback reached the end, false if it errored out. */
    private suspend fun awaitPlaybackEnd(): Boolean = suspendCancellableCoroutine { continuation ->
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) {
                    exoPlayer.removeListener(this)
                    if (continuation.isActive) continuation.resume(true)
                }
            }

            override fun onPlayerErrorChanged(error: androidx.media3.common.PlaybackException?) {
                if (error != null) {
                    exoPlayer.removeListener(this)
                    if (continuation.isActive) continuation.resume(false) // skip broken file
                }
            }
        }
        exoPlayer.addListener(listener)
        continuation.invokeOnCancellation { exoPlayer.removeListener(listener) }
    }

    fun release() {
        loop?.cancel()
        exoPlayer.release()
        // A detached WebView keeps its renderer, JS timers and network activity
        // running. Layout re-syncs build new ZonePlayers, so without this the
        // dead ones accumulate until a 1 GB TV box OOMs after days of uptime.
        webView.loadUrl("about:blank")
        (webView.parent as? android.view.ViewGroup)?.removeView(webView)
        webView.destroy()
    }
}

/**
 * Renders whatever is on screen: a fullscreen playlist or a multi-zone layout
 * (SPEC §4). Zones are independent ZonePlayers; the ticker is a marquee.
 */
class PlaybackEngine(
    private val context: Context,
    private val root: FrameLayout,
    private val cache: MediaCache,
    private val scope: CoroutineScope,
    private val onItemChanged: (String?) -> Unit,
    private val onItemPlayed: (String?) -> Unit,
) {
    private val zonePlayers = mutableListOf<ZonePlayer>()
    private val zoneViews = mutableListOf<View>()

    private fun clear() {
        zonePlayers.forEach { it.release() }
        zonePlayers.clear()
        zoneViews.forEach { root.removeView(it) }
        zoneViews.clear()
    }

    private fun addZoneContainer(x: Double, y: Double, w: Double, h: Double): FrameLayout {
        val container = FrameLayout(context)
        zoneViews.add(container)
        root.addView(container, 0) // behind status/badge overlays
        // Position once the root is measured (TV resolution is fixed after boot).
        root.post {
            container.layoutParams = FrameLayout.LayoutParams(
                (root.width * w).toInt(),
                (root.height * h).toInt(),
            ).apply {
                leftMargin = (root.width * x).toInt()
                topMargin = (root.height * y).toInt()
            }
        }
        return container
    }

    /** Fullscreen playlist; returns false when there is nothing playable. */
    fun play(playlist: ManifestPlaylist?): Boolean {
        clear()
        if (playlist == null) {
            onItemChanged(null)
            return false
        }
        val zone = ZonePlayer(context, addZoneContainer(0.0, 0.0, 1.0, 1.0), cache, scope, onItemChanged, onItemPlayed)
        zonePlayers.add(zone)
        val playing = zone.play(playlist)
        if (!playing) clear()
        return playing
    }

    /** Multi-zone layout; returns false when no zone has playable content. */
    fun playLayout(layout: ManifestLayout?): Boolean {
        clear()
        if (layout == null) {
            onItemChanged(null)
            return false
        }
        var anyPlaying = false
        for (zone in layout.zones) {
            val texts = zone.tickerTexts.orEmpty()
            if (texts.isNotEmpty()) {
                // Ticker zones are identified by content (custom layouts name them ticker0, ticker1…).
                addTicker(zone, texts)
                anyPlaying = true
            } else {
                val container = addZoneContainer(zone.x, zone.y, zone.w, zone.h)
                // Only the main zone reports "now playing" to the dashboard, and
                // only it contributes proof-of-play - otherwise a four-zone layout
                // would bill four simultaneous plays for one screen.
                val isMain = zone.key == "main"
                val player = ZonePlayer(
                    context, container, cache, scope,
                    if (isMain) onItemChanged else null,
                    if (isMain) onItemPlayed else null,
                )
                zonePlayers.add(player)
                if (player.play(zone.playlist)) anyPlaying = true
            }
        }
        if (!anyPlaying) {
            clear()
            onItemChanged(null)
        }
        return anyPlaying
    }

    private fun addTicker(zone: LayoutZone, texts: List<String>) {
        val container = addZoneContainer(zone.x, zone.y, zone.w, zone.h)
        container.setBackgroundColor(Color.BLACK)
        val ticker = TextView(context).apply {
            text = texts.joinToString("      •      ")
            setTextColor(Color.WHITE)
            textSize = 22f
            gravity = Gravity.CENTER_VERTICAL
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.MARQUEE
            marqueeRepeatLimit = -1 // forever
            isFocusable = true
            isFocusableInTouchMode = true
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT,
            )
            isSelected = true // required for marquee to run
        }
        container.addView(ticker)
    }

    fun stop() {
        clear()
    }

    fun release() {
        clear()
    }
}
