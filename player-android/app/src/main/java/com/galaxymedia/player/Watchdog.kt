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
    private const val KEY_LAST_QUICK_RELAUNCH = "last_quick_relaunch_wall_ms"
    private const val QUICK_RELAUNCH_MIN_GAP_MS = 60_000L
    const val EXTRA_FORCE = "force"

    private fun store(context: Context): SharedPreferences =
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

    fun markAlive(context: Context) {
        store(context).edit().putLong(KEY_ALIVE_AT, SystemClock.elapsedRealtime()).apply()
    }

    /**
     * Pure so it can be reasoned about (and tested) without a device.
     *
     * elapsedRealtime() restarts from zero at every boot, so a mark written by the
     * PREVIOUS boot looks like it is in the future. The old code computed a negative
     * age, which is never "stale" - so if the app failed to start after a reboot, the
     * watchdog that exists to recover exactly that did nothing for as long as the
     * previous boot had been up (days, for a TV). A mark from before this boot means
     * "nothing has marked since startup", which counts as stale once the device has
     * been up longer than the threshold.
     */
    internal fun isStaleAt(markedAt: Long, now: Long): Boolean {
        if (markedAt == 0L) return false // never marked yet (fresh install) - nothing to judge
        val age = now - markedAt
        if (age < 0) return now > STALE_THRESHOLD_MS
        return age > STALE_THRESHOLD_MS
    }

    private fun isStale(context: Context): Boolean =
        isStaleAt(store(context).getLong(KEY_ALIVE_AT, 0L), SystemClock.elapsedRealtime())

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

    /**
     * Relaunch the player in a few seconds, for use right after an uncaught crash.
     * The normal check only fires every 5 minutes and treats the app as dead after 15
     * minutes of silence, so a crash left the screen dark for up to ~20 minutes.
     *
     * Guarded against a crash loop: at most one quick relaunch a minute, so an app that
     * crashes on startup falls back to the slow cadence instead of flickering forever.
     */
    fun scheduleRelaunchSoon(context: Context, delayMs: Long = 4_000L) {
        val now = System.currentTimeMillis()
        val last = store(context).getLong(KEY_LAST_QUICK_RELAUNCH, 0L)
        if (kotlin.math.abs(now - last) < QUICK_RELAUNCH_MIN_GAP_MS) return
        store(context).edit().putLong(KEY_LAST_QUICK_RELAUNCH, now).commit() // synchronous: we are crashing
        val intent = Intent(context, WatchdogReceiver::class.java).putExtra(EXTRA_FORCE, true)
        // A different request code from the regular alarm, so neither replaces the other.
        val pending = PendingIntent.getBroadcast(
            context, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val at = SystemClock.elapsedRealtime() + delayMs
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending)
            } else {
                alarmManager.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending)
            }
        }.onFailure {
            runCatching { alarmManager.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending) }
        }
    }

    /** [force] skips the staleness test: the caller already knows the app just died. */
    fun checkAndRecover(context: Context, force: Boolean = false) {
        // Re-arm first: this is a one-shot alarm, so an early return below must
        // not be allowed to end the watchdog chain permanently.
        schedule(context)
        // Keeps the process alive and, with the overlay, keeps the relaunch
        // below legal - safe to call when already running.
        PlayerService.start(context)
        if (!force && !isStale(context)) return
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
        Watchdog.checkAndRecover(context, intent.getBooleanExtra(Watchdog.EXTRA_FORCE, false))
    }
}
