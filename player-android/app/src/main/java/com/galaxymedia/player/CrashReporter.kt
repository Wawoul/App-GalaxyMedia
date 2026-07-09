package com.galaxymedia.player

import android.content.Context
import android.content.SharedPreferences

/**
 * Records the last uncaught exception to plain (unencrypted) SharedPreferences -
 * deliberately not the EncryptedSharedPreferences in Prefs.kt, since a crash
 * handler must still work if the Keystore itself is what's broken - then reports
 * it once via the next successful heartbeat (SPEC §7: this is the only signal
 * available for a screen that crashes without rebooting, since nothing else is
 * logged anywhere on unattended field hardware).
 */
object CrashReporter {
    private const val STORE = "galaxy_crash"
    private const val KEY_AT = "crash_at"
    private const val KEY_MESSAGE = "crash_message"

    private fun store(context: Context): SharedPreferences =
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

    fun install(context: Context) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            runCatching {
                val summary = buildString {
                    append(throwable::class.java.simpleName)
                    throwable.message?.let { append(": ").append(it.take(200)) }
                    throwable.stackTrace.firstOrNull()?.let { append(" at ").append(it) }
                }
                store(context).edit()
                    .putString(KEY_AT, java.time.Instant.now().toString())
                    .putString(KEY_MESSAGE, summary.take(500))
                    .commit() // synchronous: the process is about to die, apply() may never flush
            }
            previous?.uncaughtException(thread, throwable)
                ?: run {
                    android.os.Process.killProcess(android.os.Process.myPid())
                    kotlin.system.exitProcess(10)
                }
        }
    }

    /** Non-destructive read; call [clear] only after the report is confirmed delivered. */
    fun pending(context: Context): LastCrash? {
        val prefs = store(context)
        val at = prefs.getString(KEY_AT, null) ?: return null
        val message = prefs.getString(KEY_MESSAGE, null) ?: return null
        return LastCrash(at, message)
    }

    fun clear(context: Context) {
        store(context).edit().clear().apply()
    }
}

data class LastCrash(val at: String, val message: String)
