import { z } from 'zod';

/**
 * IANA timezone names only ("Europe/London", "UTC", "Etc/GMT+5").
 *
 * The value is later used in two places that each fail hard on a bad name:
 * Intl.DateTimeFormat (the screen's manifest) and Postgres `AT TIME ZONE`
 * (the dashboard's screen list, which covers EVERY company). So one typo'd
 * zone used to 500 the dashboard for everyone. Validating here turns that into
 * a 400 at the point it was typed.
 *
 * Numeric offsets ("+01:00", "UTC+1", "GMT+5") are refused on purpose: Postgres
 * reads those POSIX-style with the opposite sign to Intl, so the dashboard and
 * the TV would disagree about what time it is.
 */
const NAME_SHAPE = /^[A-Za-z]+(?:[_-][A-Za-z]+)*(?:\/[A-Za-z0-9_+-]+)+$/;

export function isValidTimezone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64) return false;
  if (tz !== 'UTC' && !NAME_SHAPE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const MAX_ALERT_RECIPIENTS = 10;
const singleEmail = z.string().email();

/**
 * A list of plain email addresses, separated by commas, semicolons or whitespace,
 * normalised to "a@x.com, b@y.com". Alert recipients are merged into ONE message
 * with the MSP's own recipients, so a single malformed entry used to make the whole
 * send fail for everyone on it - and the field accepted any text, newlines included.
 */
export const emailListSchema = z.string().max(1000).transform((raw, ctx) => {
  const parts = raw.split(/[,;\s]+/).filter(Boolean);
  if (parts.length > MAX_ALERT_RECIPIENTS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${MAX_ALERT_RECIPIENTS} addresses` });
    return z.NEVER;
  }
  for (const part of parts) {
    if (!singleEmail.safeParse(part).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a valid email address: ${part.slice(0, 60)}` });
      return z.NEVER;
    }
  }
  return parts.join(', ');
});

export const timezoneSchema = z
  .string()
  .max(64)
  .refine(isValidTimezone, { message: 'not a valid IANA timezone (e.g. Europe/London)' });
