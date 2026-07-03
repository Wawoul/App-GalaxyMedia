package com.galaxymedia.player

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Process
import android.os.SystemClock

/**
 * Device health readings sent with each heartbeat (SPEC §7). Every field is
 * nullable: TVs without a battery or on ethernet simply omit those readings.
 */
data class TelemetrySample(
    val batteryPct: Int?,
    val ramFreeMb: Int?,
    val ramTotalMb: Int?,
    val cpuPct: Int?,
    val wifiRssi: Int?,
    val uptimeS: Long,
)

class Telemetry(private val context: Context) {
    // App CPU share is sampled between heartbeats: this is the player's own
    // usage (system-wide /proc/stat is off-limits since Android 8), which on a
    // dedicated signage box is the number that matters.
    private var lastCpuMs = Process.getElapsedCpuTime()
    private var lastSampleAt = SystemClock.elapsedRealtime()

    fun sample(): TelemetrySample {
        val memory = memory()
        return TelemetrySample(
            batteryPct = batteryPct(),
            ramFreeMb = memory?.first,
            ramTotalMb = memory?.second,
            cpuPct = cpuPct(),
            wifiRssi = wifiRssi(),
            uptimeS = SystemClock.elapsedRealtime() / 1000,
        )
    }

    private fun batteryPct(): Int? = runCatching {
        // Many cheap Android TV boxes are reflashed phone/tablet vendor images
        // whose battery HAL never got stripped - instead of omitting it, it
        // reports a fixed fake reading (50% is the single most common one).
        // A plain "is it in 1..100" range check can't catch that, so cross-check
        // that the device actually declares having a battery at all first.
        if (!hasBattery()) return@runCatching null
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        pct.takeIf { it in 1..100 }
    }.getOrNull()

    private fun hasBattery(): Boolean {
        // TV form factor never has a battery - this also catches fake battery
        // HALs that (wrongly) report EXTRA_PRESENT=true on reflashed TV boxes.
        if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)) return false
        val sticky = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        return sticky?.getBooleanExtra(BatteryManager.EXTRA_PRESENT, false) ?: false
    }

    private fun memory(): Pair<Int, Int>? = runCatching {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = ActivityManager.MemoryInfo()
        am.getMemoryInfo(info)
        Pair((info.availMem / 1_048_576L).toInt(), (info.totalMem / 1_048_576L).toInt())
    }.getOrNull()

    private fun cpuPct(): Int? {
        val nowCpu = Process.getElapsedCpuTime()
        val nowAt = SystemClock.elapsedRealtime()
        val wallMs = nowAt - lastSampleAt
        val cpuMs = nowCpu - lastCpuMs
        lastCpuMs = nowCpu
        lastSampleAt = nowAt
        if (wallMs < 1_000) return null // first call or clock hiccup
        val cores = Runtime.getRuntime().availableProcessors().coerceAtLeast(1)
        return (cpuMs * 100 / (wallMs * cores)).toInt().coerceIn(0, 100)
    }

    private fun wifiRssi(): Int? = runCatching {
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        if (!wm.isWifiEnabled) return null
        @Suppress("DEPRECATION")
        val rssi = wm.connectionInfo?.rssi ?: return null
        // Not associated (e.g. ethernet) reads as -127 or an absurd value.
        rssi.takeIf { it in -126..0 }
    }.getOrNull()
}
