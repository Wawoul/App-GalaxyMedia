package com.galaxymedia.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager

private const val CHANNEL_ID = "galaxy_player"
private const val NOTIFICATION_ID = 1

/**
 * Keeps the player process alive and recoverable on unattended TVs.
 *
 * Two jobs, both needed for different failure modes:
 *
 *  1. **Foreground service** - raises process priority so Android stops killing
 *     the player under memory pressure in the first place. This is the real fix
 *     for a screen that quietly disappears back to the TV's launcher after days
 *     of uptime; a cheap 1 GB TV box evicts ordinary background processes long
 *     before it evicts a foreground one. START_STICKY has the system recreate
 *     the service if the process dies anyway.
 *
 *  2. **Overlay window** - a 1x1 transparent TYPE_APPLICATION_OVERLAY view. Not
 *     decoration: since Android 10 an app with no visible window may not call
 *     startActivity() at all, so without this the watchdog's relaunch is
 *     silently dropped by the OS exactly when it's needed. Holding a visible
 *     overlay is the one background-activity-launch exemption a sideloaded app
 *     can actually obtain, and Android 15 requires the window to genuinely
 *     exist rather than merely holding the permission.
 *
 * The overlay needs a one-time per-TV grant (Android TV has no Settings UI for it):
 *   adb shell appops set com.galaxymedia.player SYSTEM_ALERT_WINDOW allow
 * Without it the service still runs and still prevents most kills - only the
 * self-relaunch path degrades, so this fails soft rather than crashing.
 */
class PlayerService : Service() {
    private var overlay: View? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())
        addOverlay()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Recreate the service (not the whole task) if the process is killed, so
        // the watchdog and its relaunch path come back with it.
        return START_STICKY
    }

    override fun onDestroy() {
        removeOverlay()
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Galaxy Media player",
                // Min importance: TVs shouldn't show a banner for this, it exists
                // only because a foreground service is required to have one.
                NotificationManager.IMPORTANCE_MIN,
            )
            manager.createNotificationChannel(channel)
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Galaxy Media")
            .setContentText("Signage player running")
            .setSmallIcon(R.drawable.ic_launcher)
            .setOngoing(true)
            .build()
    }

    private fun canDrawOverlays(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)

    private fun addOverlay() {
        if (overlay != null || !canDrawOverlays()) return
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_SYSTEM_ALERT
        }
        val params = WindowManager.LayoutParams(
            1, 1, type,
            // Not focusable/not touchable: this must never intercept a remote
            // keypress or draw over the content the screen is there to show.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP or Gravity.START }
        runCatching {
            val view = View(this)
            (getSystemService(Context.WINDOW_SERVICE) as WindowManager).addView(view, params)
            overlay = view
        }
    }

    private fun removeOverlay() {
        val view = overlay ?: return
        overlay = null
        runCatching {
            (getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(view)
        }
    }

    companion object {
        fun start(context: Context) {
            val intent = Intent(context, PlayerService::class.java)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            }
        }
    }
}
