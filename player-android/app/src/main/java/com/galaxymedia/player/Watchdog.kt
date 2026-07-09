package com.galaxymedia.player

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.SystemClock

private const val CHECK_INTERVAL_MS = 5 * 60_000L // how often the alarm fires
private const val STALE_THRESHOLD_MS = 4 * 60_000L // no "still alive" mark in this long => relaunch

/**
 * Dead-man's-switch for unattended TVs: MainActivity marks itself alive on a
 * timer (markAlive), independent of network state, so a screen stuck playing
 * from cache still counts as alive. If that mark goes stale - the process
 * crashed, or something on the main thread wedged so badly the coroutine loop
 * stopped ticking - the alarm (which the OS will run in a fresh process even
 * if the app's was killed) relaunches MainActivity. The TV itself never
 * reboots for this, unlike BootReceiver's boot-time recovery.
 */
object Watchdog {
    private const val STORE = "galaxy_watchdog"
    private const val KEY_ALIVE_AT = "alive_at_elapsed_ms"

    private fun store(context: Context): SharedPreferences =
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

    fun markAlive(context: Context) {
        store(context).edit().putLong(KEY_ALIVE_AT, SystemClock.elapsedRealtime()).apply()
    }

    private fun isStale(context: Context): Boolean {
        val markedAt = store(context).getLong(KEY_ALIVE_AT, 0L)
        if (markedAt == 0L) return false // never marked yet (fresh install) - nothing to judge
        return SystemClock.elapsedRealtime() - markedAt > STALE_THRESHOLD_MS
    }

    private fun pendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, WatchdogReceiver::class.java)
        return PendingIntent.getBroadcast(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** Call once per process start (MainActivity.onCreate); re-arms on every launch. */
    fun schedule(context: Context) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // Inexact repeating: a TV box is mains-powered and idle-tolerant, and this
        // doesn't need second-level precision - exact alarms would just cost battery
        // on the (rare) battery-backed unit for no real benefit here.
        alarmManager.setInexactRepeating(
            AlarmManager.ELAPSED_REALTIME,
            SystemClock.elapsedRealtime() + CHECK_INTERVAL_MS,
            CHECK_INTERVAL_MS,
            pendingIntent(context),
        )
    }

    fun checkAndRecover(context: Context) {
        if (!isStale(context)) return
        val launch = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(launch)
    }
}

class WatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Watchdog.checkAndRecover(context)
    }
}
