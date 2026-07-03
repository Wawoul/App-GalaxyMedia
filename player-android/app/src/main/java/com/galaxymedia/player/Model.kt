package com.galaxymedia.player

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

val json = Json { ignoreUnknownKeys = true }

@Serializable
data class RegisterResponse(
    val requestId: String,
    val code: String,
    val expiresInS: Int,
    val pollIntervalS: Int = 5,
)

@Serializable
data class PollResponse(
    val status: String, // "waiting" | "paired"
    val code: String? = null,
    val screenId: String? = null,
    val deviceToken: String? = null,
)

@Serializable
data class ManifestScreen(
    val id: String,
    val name: String,
    val timezone: String,
    val orientation: Int = 0, // 0 | 90 | 180 | 270 - software display rotation
    val brandName: String = "", // white-label name for the idle screen
)

@Serializable
data class PlayRecord(val name: String, val at: String) // proof-of-play entry

@Serializable
data class HeartbeatPayload(
    val appVersion: String,
    val currentItem: String?,
    val storageFreeMb: Int,
    val plays: List<PlayRecord> = emptyList(),
    // Device telemetry (SPEC §7) - null when unavailable on this hardware.
    val batteryPct: Int? = null,
    val ramFreeMb: Int? = null,
    val ramTotalMb: Int? = null,
    val cpuPct: Int? = null,
    val wifiRssi: Int? = null,
    val uptimeS: Long? = null,
)

@Serializable
data class ManifestItem(
    val id: String,
    // Defaulted, not just documented as required: a missing/unexpected value
    // for one item would otherwise fail decodeFromString for the WHOLE
    // manifest, discarding every other valid schedule/item along with it.
    // PlaybackEngine's `when (item.type)` already has an `else -> skip` arm.
    val type: String = "", // "image" | "video" | "url"
    val name: String? = null,
    val url: String? = null,
    val mediaId: String? = null,
    val sha256: String? = null,
    val sizeBytes: Long? = null,
    val mime: String? = null,
    val durationMs: Long? = null,
    val muted: Boolean = false,
)

@Serializable
data class ManifestPlaylist(val id: String, val items: List<ManifestItem>)

@Serializable
data class LayoutZone(
    val key: String, // "main" | "side" | "ticker"
    val x: Double, val y: Double, val w: Double, val h: Double, // screen fractions
    val playlist: ManifestPlaylist? = null,
    val tickerTexts: List<String>? = null,
)

@Serializable
data class ManifestLayout(
    val id: String,
    val name: String = "",
    val preset: String = "",
    val zones: List<LayoutZone> = emptyList(),
)

@Serializable
data class ScheduleEntry(
    val id: String,
    val playlistId: String? = null,
    val layout: ManifestLayout? = null, // split-screen zones instead of a playlist
    val blackout: Boolean = false, // Black Screen: render black (simulates TV off)
    val isDirect: Boolean = false,
    val createdAt: String = "",
    val priority: Int = 0,
    val daysOfWeek: List<Int>? = null, // 0=Sun … 6=Sat
    val startTime: String? = null,     // "HH:MM[:SS]"
    val endTime: String? = null,
    val startDate: String? = null,     // "YYYY-MM-DD"
    val endDate: String? = null,
    val weekInterval: Int = 1,         // 1 = weekly, 2 = bi-weekly (anchored to startDate)
    val playlist: ManifestPlaylist? = null,
)

@Serializable
data class Manifest(
    val screen: ManifestScreen,
    val schedules: List<ScheduleEntry> = emptyList(),
    val playlist: ManifestPlaylist? = null, // legacy: server-resolved "active now"
    val generatedAt: String,
)
