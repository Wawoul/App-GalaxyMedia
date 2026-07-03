package com.galaxymedia.player

import android.content.Context
import kotlinx.coroutines.Dispatchers
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
    ) = withContext(Dispatchers.IO) {
        val missing = items.filter { item ->
            val mediaId = item.mediaId
            mediaId != null && item.url != null &&
                !File(dir, "$mediaId.bin").let { it.exists() && it.length() > 0 }
        }
        val totalBytes = missing.sumOf { it.sizeBytes ?: 0L }.coerceAtLeast(1L)
        var doneBytes = 0L
        if (missing.isNotEmpty()) onProgress?.invoke(0)

        for (item in missing) {
            val mediaId = item.mediaId!!
            val target = File(dir, "$mediaId.bin")
            val tmp = File(dir, "$mediaId.tmp")
            runCatching {
                http.newCall(Request.Builder().url(item.url!!).build()).execute().use { response ->
                    check(response.isSuccessful) { "download ${response.code}" }
                    tmp.outputStream().use { out ->
                        val input = response.body!!.byteStream()
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            out.write(buffer, 0, read)
                            doneBytes += read
                            onProgress?.invoke(((doneBytes * 100) / totalBytes).toInt().coerceIn(0, 100))
                        }
                    }
                }
                val expected = item.sha256
                if (expected != null && sha256(tmp) != expected) {
                    error("checksum mismatch for $mediaId") // tampered or truncated - reject
                }
                check(tmp.renameTo(target)) { "rename failed" }
            }.onFailure { tmp.delete() }
        }
        if (missing.isNotEmpty()) onProgress?.invoke(100)
        prune(items.mapNotNull { it.mediaId }.toSet())
    }

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
