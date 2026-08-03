package com.galaxymedia.player

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.SystemClock

private const val CHECK_INTERVAL_MS = 5 * 60_000L // how often the alarm fires
// Generous against the 60s mark interval. The alarm uses ...AndAllowWhileIdle and
// so pierces Doze, but the Activity's coroutine delay() does not - a dozing TV can
// throttle the mark while the check still fires on time. Too tight a threshold
// here means relaunching screens that were never broken.
private const val STALE_THRESHOLD_MS = 15 * 60_000L

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

    /**
     * Arms the next check. Self-rescheduling one-shot rather than
     * setInexactRepeating: only the ...AndAllowWhileIdle variants fire while the
     * device is dozing, and an idle TV box is exactly the state we need to
     * recover from. ELAPSED_REALTIME_WAKEUP (not the non-wakeup variant, which
     * merely fires "whenever the device next wakes" - possibly never on an
     * unattended screen) so the check actually happens.
     */
    fun schedule(context: Context) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val at = SystemClock.elapsedRealtime() + CHECK_INTERVAL_MS
        val intent = pendingIntent(context)
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, at, intent,
                )
            } else {
                alarmManager.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, intent)
            }
        }.onFailure {
            // Exact-alarm permission can be revoked by the user/OEM; an inexact
            // check that sometimes runs late still beats no watchdog at all.
            runCatching { alarmManager.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, intent) }
        }
    }

    fun checkAndRecover(context: Context) {
        // Re-arm first: this is a one-shot alarm, so an early return below must
        // not be allowed to end the watchdog chain permanently.
        schedule(context)
        // Keeps the process alive and, with the overlay, keeps the relaunch
        // below legal - safe to call when already running.
        PlayerService.start(context)
        if (!isStale(context)) return
        val launch = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        }
        // Blocked by the OS unless the app holds a visible overlay window
        // (PlayerService) - without that grant this throws rather than recovering,
        // so don't let it take the alarm chain down with it.
        runCatching { context.startActivity(launch) }
    }
}

class WatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Watchdog.checkAndRecover(context)
    }
}
