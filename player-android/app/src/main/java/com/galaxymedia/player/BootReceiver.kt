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
            val launch = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(launch)
        }
    }
}
