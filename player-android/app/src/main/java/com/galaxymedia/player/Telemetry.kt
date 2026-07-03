package com.galaxymedia.player

import android.app.ActivityManager
import android.content.Context
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
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        // TVs and boxes without a battery report 0 or Integer.MIN_VALUE.
        pct.takeIf { it in 1..100 }
    }.getOrNull()

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
