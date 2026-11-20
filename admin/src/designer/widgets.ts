/**
 * What the clock / date / weather widgets show. Shared by the editor (so the preview matches) and by
 * the live page the TVs play, which is why it is plain functions with no framework.
 *
 * Weather comes from Open-Meteo (free, no account or key). The TV's web view fetches it directly, so
 * the TV needs internet access; a failed fetch keeps showing the last reading rather than blanking.
 */
import type { WidgetObj } from './model';

export interface Weather { temp: number; code: number; at: number }

// WMO weather codes -> an emoji (emoji draw in colour on every browser and Android TV, unlike icon fonts).
export function weatherIcon(code: number): string {
  if (code === 0) return '☀️';
  if (code === 1 || code === 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 57) return '🌦️';
  if (code >= 61 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '❄️';
  if (code >= 80 && code <= 82) return '🌧️';
  if (code === 85 || code === 86) return '🌨️';
  if (code >= 95) return '⛈️';
  return '🌡️';
}

export const weatherLabel = (code: number): string => {
  if (code === 0) return 'Clear';
  if (code <= 2) return 'Partly cloudy';
  if (code === 3) return 'Cloudy';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code >= 95) return 'Thunderstorm';
  return '';
};

/** Format with a time zone, falling back to the device's own if the name is not one the browser knows. */
function format(opts: Intl.DateTimeFormatOptions, timeZone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: timeZone || undefined }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-GB', opts).format(now);
  }
}

export function clockText(o: Pick<WidgetObj, 'hour12' | 'seconds' | 'timezone'>, now: Date): string {
  const t = format(
    { hour: o.hour12 ? 'numeric' : '2-digit', minute: '2-digit', second: o.seconds ? '2-digit' : undefined, hour12: o.hour12 },
    o.timezone, now,
  );
  return o.hour12 ? t.toUpperCase() : t;
}

export function dateText(o: Pick<WidgetObj, 'dateStyle' | 'timezone'>, now: Date): string {
  const opts: Record<WidgetObj['dateStyle'], Intl.DateTimeFormatOptions> = {
    long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
    medium: { weekday: 'short', day: 'numeric', month: 'short' },
    short: { day: '2-digit', month: '2-digit', year: 'numeric' },
    weekday: { weekday: 'long' },
  };
  return format(opts[o.dateStyle], o.timezone, now);
}

export function weatherText(o: Pick<WidgetObj, 'units' | 'place' | 'showPlace'>, w: Weather | null): string {
  const unit = o.units === 'f' ? 'F' : 'C';
  const body = w ? `${weatherIcon(w.code)} ${Math.round(w.temp)}°${unit}` : `🌡️ --°${unit}`;
  return o.showPlace && o.place ? `${body}  ${o.place}` : body;
}

/** The text a widget shows right now. */
export function widgetText(o: WidgetObj, now: Date, weather: Weather | null): string {
  switch (o.kind) {
    case 'clock': return clockText(o, now);
    case 'date': return dateText(o, now);
    case 'weather': return weatherText(o, weather);
  }
}

// ── weather fetching ─────────────────────────────────────────────────────────────────────
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, Weather>();
const inflight = new Map<string, Promise<Weather | null>>();

export const weatherKey = (o: Pick<WidgetObj, 'lat' | 'lon' | 'units'>) => `${o.lat.toFixed(3)},${o.lon.toFixed(3)},${o.units}`;

/** Current weather; reuses a reading under ten minutes old. Resolves null (never throws) when unreachable. */
export async function fetchWeather(o: Pick<WidgetObj, 'lat' | 'lon' | 'units'>): Promise<Weather | null> {
  const key = weatherKey(o);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = (async () => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${o.lat}&longitude=${o.lon}`
        + `&current=temperature_2m,weather_code&temperature_unit=${o.units === 'f' ? 'fahrenheit' : 'celsius'}`;
      const res = await fetch(url);
      if (!res.ok) return cache.get(key) ?? null;
      const body = (await res.json()) as { current?: { temperature_2m?: number; weather_code?: number } };
      if (typeof body.current?.temperature_2m !== 'number' || typeof body.current.weather_code !== 'number') return cache.get(key) ?? null;
      const w: Weather = { temp: body.current.temperature_2m, code: body.current.weather_code, at: Date.now() };
      cache.set(key, w);
      return w;
    } catch {
      return cache.get(key) ?? null; // offline: keep the last reading on screen
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

export interface Place { name: string; detail: string; lat: number; lon: number }

/** Look a town up by name, for the weather widget's location picker. */
export async function searchPlaces(name: string): Promise<Place[]> {
  const q = name.trim();
  if (q.length < 2) return [];
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
  if (!res.ok) throw new Error('Place search failed');
  const body = (await res.json()) as { results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[] };
  return (body.results ?? []).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

export const COMMON_TIMEZONES = [
  'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Athens',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];
