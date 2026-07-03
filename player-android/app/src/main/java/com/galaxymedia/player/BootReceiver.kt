package com.galaxymedia.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Auto-start playback when the TV powers on (SPEC §6: kiosk behavior). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val launch = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(launch)
        }
    }
}
