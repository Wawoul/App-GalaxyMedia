/**
 * Schedule resolution for the web player.
 * COPY of server/src/lib/schedule.ts (which owns the tests) - keep in sync,
 * like the Kotlin twin in the Android app.
 */

export interface ScheduleEntry {
  id: string;
  playlistId: string | null;
  blackout?: boolean;
  isDirect: boolean;
  createdAt: string;
  priority: number;
  daysOfWeek: number[] | null; // 0=Sun … 6=Sat
  startTime: string | null; // "HH:MM[:SS]"
  endTime: string | null;
  startDate: string | null; // "YYYY-MM-DD"
  endDate: string | null;
  weekInterval?: number;
}

export interface LocalNow {
  dateStr: string;
  dayOfWeek: number;
  minutes: number;
}

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
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

function toMinutes(time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return h * 60 + m;
}

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
  if (interval > 1 && entry.startDate) {
    const days = daysBetween(entry.startDate, now.dateStr);
    const weeks = Math.floor(days / 7);
    if (days >= 0 && weeks % interval !== 0) return false;
  }
  if (entry.startTime && entry.endTime) {
    const start = toMinutes(entry.startTime);
    const end = toMinutes(entry.endTime);
    if (start <= end) {
      if (now.minutes < start || now.minutes >= end) return false;
    } else {
      if (now.minutes < start && now.minutes >= end) return false;
    }
  }
  return true;
}

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
