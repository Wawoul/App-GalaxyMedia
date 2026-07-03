package com.galaxymedia.player

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Color
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

private const val DEFAULT_IMAGE_MS = 10_000L
private const val DEFAULT_URL_MS = 30_000L

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
    private val playerView = PlayerView(context).apply {
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
                onItemChanged?.invoke(item.name ?: item.url ?: item.mediaId)
                when (item.type) {
                    "image" -> showImage(item)
                    "video" -> playVideo(item)
                    "url" -> showUrl(item)
                    else -> delay(1_000)
                }
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

    private suspend fun showImage(item: ManifestItem) {
        val bitmap = BitmapFactory.decodeFile(cache.fileFor(item).absolutePath) ?: return
        imageView.setImageBitmap(bitmap)
        imageView.visibility = View.VISIBLE
        playerView.visibility = View.GONE
        webView.visibility = View.GONE
        exoPlayer.stop()
        delay(item.durationMs ?: DEFAULT_IMAGE_MS)
    }

    private suspend fun showUrl(item: ManifestItem) {
        val url = item.url ?: return
        if (isStreamUrl(url)) return playStream(item, url)
        webView.loadUrl(url)
        webView.visibility = View.VISIBLE
        imageView.visibility = View.GONE
        playerView.visibility = View.GONE
        exoPlayer.stop()
        delay(item.durationMs ?: DEFAULT_URL_MS)
        webView.loadUrl("about:blank")
    }

    private fun isStreamUrl(url: String): Boolean {
        val path = url.substringBefore('?').lowercase()
        return path.endsWith(".m3u8") || path.endsWith(".mpd")
    }

    /**
     * Live stream (HLS/DASH) straight off the network - can't be cached, so it
     * needs connectivity. The periodic restart at the end of each duration also
     * recovers from stalled streams. Skipped quickly when unreachable.
     */
    private suspend fun playStream(item: ManifestItem, url: String) {
        playerView.visibility = View.VISIBLE
        imageView.visibility = View.GONE
        webView.visibility = View.GONE
        exoPlayer.volume = if (item.muted) 0f else 1f
        exoPlayer.setMediaItem(MediaItem.fromUri(url))
        exoPlayer.prepare()
        exoPlayer.play()
        // Default 1 hour; a single-item playlist just restarts it, so it is
        // effectively continuous (with a periodic self-heal).
        delay(item.durationMs ?: 3_600_000L)
        exoPlayer.stop()
    }

    private suspend fun playVideo(item: ManifestItem) {
        playerView.visibility = View.VISIBLE
        imageView.visibility = View.GONE
        webView.visibility = View.GONE
        exoPlayer.volume = if (item.muted) 0f else 1f
        exoPlayer.setMediaItem(MediaItem.fromUri(cache.fileFor(item).toURI().toString()))
        exoPlayer.prepare()
        exoPlayer.play()
        val fixed = item.durationMs
        if (fixed != null) delay(fixed) else awaitPlaybackEnd()
        exoPlayer.stop()
    }

    private suspend fun awaitPlaybackEnd() = suspendCancellableCoroutine { continuation ->
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) {
                    exoPlayer.removeListener(this)
                    if (continuation.isActive) continuation.resume(Unit)
                }
            }

            override fun onPlayerErrorChanged(error: androidx.media3.common.PlaybackException?) {
                if (error != null) {
                    exoPlayer.removeListener(this)
                    if (continuation.isActive) continuation.resume(Unit) // skip broken file
                }
            }
        }
        exoPlayer.addListener(listener)
        continuation.invokeOnCancellation { exoPlayer.removeListener(listener) }
    }

    fun release() {
        loop?.cancel()
        exoPlayer.release()
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
        val zone = ZonePlayer(context, addZoneContainer(0.0, 0.0, 1.0, 1.0), cache, scope, onItemChanged)
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
                // Only the main zone reports "now playing" to the dashboard.
                val reporter = if (zone.key == "main") onItemChanged else null
                val player = ZonePlayer(context, container, cache, scope, reporter)
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
