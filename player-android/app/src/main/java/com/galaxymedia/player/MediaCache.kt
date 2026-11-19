package com.galaxymedia.player

import android.content.Context
import android.os.SystemClock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

/**
 * Offline-first media store (SPEC §6): every media item is downloaded ahead of
 * play, checksum-verified, and served from local files thereafter.
 */
class MediaCache(context: Context, private val http: OkHttpClient) {
    private val dir = File(context.filesDir, "media").apply { mkdirs() }
    // MainActivity can trigger syncAll from independent paths (periodic poll,
    // a WS "sync" push, "reload") - without this, two overlapping calls would
    // both truncate-write the same "$mediaId.tmp" file, and an older call's
    // prune() could delete what a newer, still-running call just verified.
    private val syncMutex = Mutex()

    /**
     * Why the last download failed, reported on the next heartbeat. A screen
     * that cannot fetch its media plays nothing and looks idle from the
     * dashboard; this is the difference between "diagnose it remotely" and
     * "drive to site".
     */
    @Volatile
    var lastError: String? = null
        private set

    fun clearLastError() {
        lastError = null
    }

    /**
     * Called on every manifest sync. Forgets only the failures a FRESH URL can
     * fix - an expired or rejected token (HTTP 401/403) - so those retry at once.
     *
     * It used to clear everything. A sync runs every minute and every manifest
     * carries new signed URLs, so that wiped the backoff each time: an item that
     * could never succeed (checksum mismatch, truncated file on the server) was
     * downloaded IN FULL once a minute, forever - hundreds of GB a day for a
     * big video, on every screen. Failures a new URL cannot fix keep backing
     * off; [forgetAllFailures] is the explicit "try everything again".
     */
    fun resetFailures() {
        failures.values.removeAll { it.freshUrlHelps }
    }

    /** A tech asked for a reload or a cache clear: retry everything now. */
    fun forgetAllFailures() {
        failures.clear()
    }

    /** Per-item download failure state, for exponential backoff. */
    private class Failure(var count: Int, var retryAt: Long, var freshUrlHelps: Boolean = false)
    // Concurrent: resetFailures() is called from the main thread while syncAll()
    // runs on an IO thread.
    private val failures = java.util.concurrent.ConcurrentHashMap<String, Failure>()

    /** The server answered the download with a non-2xx status. */
    private class DownloadHttpException(val code: Int) : Exception("download $code")

    private fun noteFailure(mediaId: String, freshUrlHelps: Boolean = false) {
        val failure = failures.getOrPut(mediaId) { Failure(0, 0L) }
        failure.freshUrlHelps = freshUrlHelps
        failure.count += 1
        // 1min, 2, 4 ... capped at an hour. Long enough that a broken item costs
        // almost nothing, short enough that a transient outage recovers quickly.
        val backoff = (60_000L shl (failure.count - 1).coerceAtMost(6)).coerceAtMost(3_600_000L)
        failure.retryAt = SystemClock.elapsedRealtime() + backoff
    }

    /** OkHttp's body is platform-nullable; fail with a message instead of an NPE. */
    private fun okhttp3.Response.bodyOrThrow() =
        body ?: error("empty response body (HTTP $code)")

    fun fileFor(item: ManifestItem): File = File(dir, "${item.mediaId}.bin")

    fun isCached(item: ManifestItem): Boolean {
        val mediaId = item.mediaId ?: return false
        val file = File(dir, "$mediaId.bin")
        if (!file.exists() || file.length() == 0L) return false
        // "Non-empty" is not "intact". A TV that loses power mid-write can leave a
        // file that exists but is the wrong length, and trusting it meant that item
        // failed to play for ever with nothing to trigger a re-download. When the
        // server told us the size, the file must match it.
        val expected = item.sizeBytes
        return expected == null || expected <= 0L || file.length() == expected
    }

    /**
     * Download any missing media; verify sha256 before accepting.
     * Reports overall progress (0-100, byte-weighted) via [onProgress].
     */
    suspend fun syncAll(
        items: List<ManifestItem>,
        onProgress: ((percent: Int) -> Unit)? = null,
    ) = syncMutex.withLock { withContext(Dispatchers.IO) {
        // Same test the player uses, so a damaged file is re-downloaded rather than
        // treated as present by the sync and as absent by the player.
        val missing = items.filter { item ->
            item.mediaId != null && item.url != null && !isCached(item)
        }
        val totalBytes = missing.sumOf { it.sizeBytes ?: 0L }.coerceAtLeast(1L)
        var doneBytes = 0L
        var lastPercent = -1
        if (missing.isNotEmpty()) onProgress?.invoke(0)

        for (item in missing) {
            val mediaId = item.mediaId!!
            // Back off items that keep failing. Without this a permanently broken
            // item - deleted server-side, stale signed URL, corrupt file - is
            // re-downloaded in full on every 60s sync, burning bandwidth forever
            // and holding syncMutex so remote commands queue behind it.
            val failure = failures[mediaId]
            if (failure != null && SystemClock.elapsedRealtime() < failure.retryAt) continue

            val target = File(dir, "$mediaId.bin")
            val tmp = File(dir, "$mediaId.tmp")
            // Don't start a download that obviously cannot fit; ENOSPC mid-write
            // would just churn. Headroom for the item plus a small margin.
            val needed = (item.sizeBytes ?: 0L) + 32L * 1024 * 1024
            if (dir.usableSpace in 1 until needed) {
                noteFailure(mediaId)
                // Say so. This path used to be entirely silent, so a screen that
                // could never fit its media looked identical to a healthy one.
                lastError = "${item.name ?: mediaId}: needs ${needed / 1024 / 1024}MB, " +
                    "only ${dir.usableSpace / 1024 / 1024}MB free"
                continue
            }
            runCatching {
                http.newCall(Request.Builder().url(item.url!!).build()).execute().use { response ->
                    if (!response.isSuccessful) throw DownloadHttpException(response.code)
                    tmp.outputStream().use { out ->
                        val input = response.bodyOrThrow().byteStream()
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            out.write(buffer, 0, read)
                            doneBytes += read
                            // Per percent, not per chunk: a 77MB file is ~1200
                            // chunks, and each callback hops to the main thread,
                            // which is enough to risk an ANR on a cheap box.
                            val percent = ((doneBytes * 100) / totalBytes).toInt().coerceIn(0, 100)
                            if (percent != lastPercent) {
                                lastPercent = percent
                                onProgress?.invoke(percent)
                            }
                        }
                        // Force the bytes to storage BEFORE the rename below. Without it
                        // the file can be renamed into place while its data is still in
                        // the OS cache, and a power cut (routine for a TV) leaves a
                        // correctly-named file full of zeros.
                        out.flush()
                        out.fd.sync()
                    }
                }
                val expected = item.sha256
                if (expected != null) {
                    if (sha256(tmp) != expected) {
                        error("checksum mismatch for $mediaId") // tampered or truncated - reject
                    }
                } else {
                    // No server-side hash to check against, so fall back to the
                    // declared size: a connection dropped mid-body otherwise
                    // renames a truncated file into place and the zone plays a
                    // corrupt item forever with nothing to trigger a re-fetch.
                    val declared = item.sizeBytes
                    if (declared != null && declared > 0 && tmp.length() != declared) {
                        error("size mismatch for $mediaId (${tmp.length()} != $declared)")
                    }
                }
                check(tmp.renameTo(target)) { "rename failed" }
                failures.remove(mediaId)
            }.onFailure { err ->
                tmp.delete()
                // An expired/rejected token is fixed by the next manifest's fresh
                // URL; anything else (bad checksum, 404, a stall) is not.
                val code = (err as? DownloadHttpException)?.code
                noteFailure(mediaId, freshUrlHelps = code == 401 || code == 403)
                // Surface WHY. A download that keeps failing leaves the screen
                // with nothing to play and looks identical, from the dashboard,
                // to a screen that is simply idle - so without this the only way
                // to diagnose it is physical access to the TV.
                lastError = "${item.name ?: mediaId}: ${err.message ?: err::class.java.simpleName}"
            }
        }
        if (missing.isEmpty()) lastError = null
        if (missing.isNotEmpty()) onProgress?.invoke(100)
        prune(items.mapNotNull { it.mediaId }.toSet())
    } }

    /** Drop cached files no longer referenced by the manifest. */
    private fun prune(activeMediaIds: Set<String>) {
        dir.listFiles()?.forEach { file ->
            val id = file.name.removeSuffix(".bin").removeSuffix(".tmp")
            if (id !in activeMediaIds) file.delete()
        }
    }

    fun clear() {
        dir.listFiles()?.forEach { it.delete() }
        failures.clear() // a clean slate means every item is retried
    }

    fun freeSpaceMb(): Int = (dir.usableSpace / (1024 * 1024)).toInt()

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
