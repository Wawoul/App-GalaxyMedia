package com.galaxymedia.player

import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Local schedule resolution - the Kotlin twin of the server's lib/schedule.ts.
 * Runs against the TV's own clock so dayparting keeps working offline (SPEC §6).
 * Rules: active window filter → highest priority → direct beats group → newest.
 */
object Schedule {

    fun isActive(entry: ScheduleEntry, now: ZonedDateTime): Boolean {
        val start = entry.startTime
        val end = entry.endTime
        val minutes = now.toLocalTime().hour * 60 + now.toLocalTime().minute
        val startMin = start?.let { parseMinutes(it) } ?: 0
        val endMin = end?.let { parseMinutes(it) } ?: 0
        val overnight = start != null && end != null && startMin > endMin
        // The early-morning tail of an overnight window (e.g. 00:30 for a
        // 22:00-02:00 slot) still belongs to the PREVIOUS calendar day's
        // date/days-of-week/interval - mirrors lib/schedule.ts.
        val inOvernightTail = overnight && minutes < endMin
        val date = if (inOvernightTail) now.toLocalDate().minusDays(1) else now.toLocalDate()
        val dow = if (inOvernightTail) (now.dayOfWeek.value % 7 + 6) % 7 else now.dayOfWeek.value % 7

        entry.startDate?.let { if (date.isBefore(LocalDate.parse(it))) return false }
        entry.endDate?.let { if (date.isAfter(LocalDate.parse(it))) return false }

        entry.daysOfWeek?.takeIf { it.isNotEmpty() }?.let { days ->
            if (dow !in days) return false
        }

        // Recurrence interval (bi-weekly etc.), anchored to startDate - mirrors lib/schedule.ts.
        if (entry.weekInterval > 1 && entry.startDate != null) {
            val days = java.time.temporal.ChronoUnit.DAYS.between(LocalDate.parse(entry.startDate), date)
            if (days >= 0 && (days / 7) % entry.weekInterval != 0L) return false
        }

        if (start != null && end != null) {
            if (!overnight) {
                if (minutes < startMin || minutes >= endMin) return false
            } else {
                // Window crosses midnight (e.g. 22:00-02:00).
                if (minutes < startMin && minutes >= endMin) return false
            }
        }
        return true
    }

    fun resolveActive(entries: List<ScheduleEntry>, timezone: String): ScheduleEntry? {
        val zone = runCatching { ZoneId.of(timezone) }.getOrDefault(ZoneId.systemDefault())
        val now = ZonedDateTime.now(zone)
        var best: ScheduleEntry? = null
        for (entry in entries) {
            if (!isActive(entry, now)) continue
            val current = best
            if (current == null ||
                entry.priority > current.priority ||
                (entry.priority == current.priority && entry.isDirect && !current.isDirect) ||
                (entry.priority == current.priority && entry.isDirect == current.isDirect &&
                    entry.createdAt > current.createdAt)
            ) {
                best = entry
            }
        }
        return best
    }

    /** Playlist that should be on screen right now (schedules preferred, legacy fallback). */
    fun activePlaylist(manifest: Manifest): ManifestPlaylist? =
        if (manifest.schedules.isNotEmpty()) {
            resolveActive(manifest.schedules, manifest.screen.timezone)?.playlist
        } else {
            manifest.playlist
        }

    /** All items across all schedules (incl. layout zones) - everything worth caching. */
    fun allItems(manifest: Manifest): List<ManifestItem> =
        (manifest.schedules.mapNotNull { it.playlist }.flatMap { it.items } +
            manifest.schedules.mapNotNull { it.layout }
                .flatMap { layout -> layout.zones.mapNotNull { it.playlist } }
                .flatMap { it.items } +
            (manifest.playlist?.items ?: emptyList()))
            .distinctBy { it.mediaId ?: it.id }

    private fun parseMinutes(time: String): Int {
        val parts = time.split(":")
        return (parts.getOrNull(0)?.toIntOrNull() ?: 0) * 60 + (parts.getOrNull(1)?.toIntOrNull() ?: 0)
    }
}
