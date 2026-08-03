package com.galaxymedia.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

private const val ACTION_QUICKBOOT_POWERON = "android.intent.action.QUICKBOOT_POWERON"
private const val ACTION_HTC_QUICKBOOT_POWERON = "com.htc.intent.action.QUICKBOOT_POWERON"

/**
 * Auto-start playback when the TV powers on (SPEC §6: kiosk behavior).
 * Cheap TV boxes commonly fire a vendor "quickboot" action instead of (or
 * alongside) the standard one on fast-boot/resume - without also matching
 * those, self-recovery after a power cut can silently fail on such hardware.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == ACTION_QUICKBOOT_POWERON ||
            intent.action == ACTION_HTC_QUICKBOOT_POWERON
        ) {
            // Re-arm the watchdog first: if the activity start below is refused,
            // this is what brings the screen back a few minutes later.
            runCatching { Watchdog.schedule(context) }
            // specialUse (not mediaPlayback) precisely so this is allowed from a
            // BOOT_COMPLETED receiver on Android 15.
            runCatching { PlayerService.start(context) }
            val launch = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            // Background activity starts are restricted on Android 10+; an
            // uncaught refusal here would crash the receiver and take the
            // watchdog re-arm above down with it.
            runCatching { context.startActivity(launch) }
        }
    }
}
