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
     * Forget past failures so every item is retried immediately. Called when the
     * manifest changes: the signed URLs are new, so a previous failure says
     * nothing about whether this attempt will work, and an hour-long backoff
     * would otherwise leave a fixed screen dark long after the fix.
     */
    fun resetFailures() {
        failures.clear()
    }

    /** Per-item download failure state, for exponential backoff. */
    private class Failure(var count: Int, var retryAt: Long)
    private val failures = mutableMapOf<String, Failure>()

    private fun noteFailure(mediaId: String) {
        val failure = failures.getOrPut(mediaId) { Failure(0, 0L) }
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
        return File(dir, "$mediaId.bin").let { it.exists() && it.length() > 0 }
    }

    /**
     * Download any missing media; verify sha256 before accepting.
     * Reports overall progress (0-100, byte-weighted) via [onProgress].
     */
    suspend fun syncAll(
        items: List<ManifestItem>,
        onProgress: ((percent: Int) -> Unit)? = null,
    ) = syncMutex.withLock { withContext(Dispatchers.IO) {
        val missing = items.filter { item ->
            val mediaId = item.mediaId
            mediaId != null && item.url != null &&
                !File(dir, "$mediaId.bin").let { it.exists() && it.length() > 0 }
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
                    check(response.isSuccessful) { "download ${response.code}" }
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
                noteFailure(mediaId)
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
