/**
 * Schedule resolution (SPEC §5) - the single source of truth for "what should
 * this screen play right now". The Kotlin player implements the same rules for
 * offline dayparting; keep the two in sync.
 *
 * Rules, in order:
 *  1. Only assignments whose date range / days-of-week / time window match "now"
 *     (in the screen's timezone) are candidates. NULL fields mean "always".
 *  2. Highest `priority` wins.
 *  3. Tie-break: direct-to-screen beats group.
 *  4. Tie-break: newest created wins.
 */

export interface ScheduleEntry {
  id: string;
  playlistId: string | null; // null for blackout entries
  blackout?: boolean; // Black Screen: render black instead of content
  isDirect: boolean; // screen-targeted (vs group)
  createdAt: string; // ISO
  priority: number;
  daysOfWeek: number[] | null; // 0=Sun … 6=Sat
  startTime: string | null; // "HH:MM" or "HH:MM:SS"
  endTime: string | null;
  startDate: string | null; // "YYYY-MM-DD"
  endDate: string | null;
  weekInterval?: number; // 1 = weekly (default), 2 = bi-weekly, … anchored to startDate
}

export interface LocalNow {
  dateStr: string; // "YYYY-MM-DD" in screen tz
  dayOfWeek: number; // 0=Sun … 6=Sat in screen tz
  minutes: number; // minutes since local midnight
}

/** Current wall-clock in an IANA timezone. */
export function nowInTimezone(tz: string, at: Date = new Date()): LocalNow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    dayOfWeek: dows.indexOf(get('weekday')),
    // "24" can appear for midnight with hour12:false - normalize.
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

function toMinutes(time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Whole days between two "YYYY-MM-DD" strings (b − a). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function isActive(entry: ScheduleEntry, now: LocalNow): boolean {
  if (entry.startDate && now.dateStr < entry.startDate) return false;
  if (entry.endDate && now.dateStr > entry.endDate) return false;
  if (entry.daysOfWeek && entry.daysOfWeek.length > 0 && !entry.daysOfWeek.includes(now.dayOfWeek)) {
    return false;
  }
  const interval = entry.weekInterval ?? 1;
  if (interval > 1) {
    // Anchor the cycle to the week containing startDate; without one, treat as weekly.
    if (entry.startDate) {
      const days = daysBetween(entry.startDate, now.dateStr);
      // Align weeks to the anchor's weekday so week 0 starts at the anchor.
      const weeks = Math.floor(days / 7);
      if (days >= 0 && weeks % interval !== 0) return false;
    }
  }
  if (entry.startTime && entry.endTime) {
    const start = toMinutes(entry.startTime);
    const end = toMinutes(entry.endTime);
    if (start <= end) {
      if (now.minutes < start || now.minutes >= end) return false;
    } else {
      // Window crosses midnight (e.g. 22:00-02:00).
      if (now.minutes < start && now.minutes >= end) return false;
    }
  }
  return true;
}

/** Pick the entry that should play now, or null for "nothing scheduled". */
export function resolveActive<T extends ScheduleEntry>(entries: T[], now: LocalNow): T | null {
  let best: T | null = null;
  for (const entry of entries) {
    if (!isActive(entry, now)) continue;
    if (
      !best ||
      entry.priority > best.priority ||
      (entry.priority === best.priority && entry.isDirect && !best.isDirect) ||
      (entry.priority === best.priority && entry.isDirect === best.isDirect && entry.createdAt > best.createdAt)
    ) {
      best = entry;
    }
  }
  return best;
}
