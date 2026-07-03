package com.galaxymedia.player

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

@Serializable
data class ApkInfo(
    val versionCode: Int,
    val versionName: String,
    val sha256: String,
    val sizeBytes: Long = 0,
    val url: String,
)

/**
 * Self-update (SPEC §6): checks the server for a newer release, downloads it,
 * verifies the sha256, then hands the APK to the system installer. Without
 * device-owner provisioning Android shows a confirm prompt on the TV; the
 * signature must match the installed app or the system rejects it.
 */
class UpdateManager(private val context: Context, private val api: ApiClient, private val prefs: Prefs) {

    /** Returns true when an update was downloaded and the installer was launched. */
    suspend fun checkAndInstall(): Boolean = withContext(Dispatchers.IO) {
        val info = fetchInfo() ?: return@withContext false
        if (info.versionCode <= BuildConfig.VERSION_CODE) return@withContext false

        val apk = File(context.cacheDir, "update-${info.versionCode}.apk")
        if (!apk.exists() || sha256(apk) != info.sha256) {
            runCatching {
                api.http.newCall(Request.Builder().url(info.url).build()).execute().use { response ->
                    check(response.isSuccessful) { "apk download ${response.code}" }
                    apk.outputStream().use { out -> response.body!!.byteStream().copyTo(out) }
                }
            }.onFailure {
                apk.delete()
                return@withContext false
            }
            // Reject a tampered or truncated download (SPEC §8).
            if (sha256(apk) != info.sha256) {
                apk.delete()
                return@withContext false
            }
        }

        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        true
    }

    private suspend fun fetchInfo(): ApkInfo? = withContext(Dispatchers.IO) {
        runCatching {
            val base = prefs.serverUrl?.trimEnd('/') ?: return@runCatching null
            val request = Request.Builder()
                .url("$base/api/device/apk-info")
                .header("Authorization", "Bearer ${prefs.deviceToken}")
                .build()
            api.http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@runCatching null
                val body = response.body!!.string()
                if (body == "null" || body.isBlank()) null else json.decodeFromString<ApkInfo>(body)
            }
        }.getOrNull()
    }

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
