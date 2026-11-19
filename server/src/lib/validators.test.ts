import { describe, expect, it } from 'vitest';
import { emailListSchema, isValidTimezone, timezoneSchema } from './validators.js';

describe('isValidTimezone', () => {
  it('accepts real IANA zones', () => {
    for (const tz of ['Europe/London', 'America/New_York', 'Australia/Sydney', 'America/Argentina/Buenos_Aires', 'UTC', 'Etc/GMT+5']) {
      expect(isValidTimezone(tz), tz).toBe(true);
    }
  });

  it('rejects values Intl or Postgres would choke on', () => {
    // An invalid zone reaching `now() AT TIME ZONE ...` 500s the whole screens
    // list, and reaching Intl.DateTimeFormat 500s that screen's manifest.
    for (const tz of ['', ' ', 'Mars/Olympus', 'not a zone', 'Europe/', '/London', "Europe/London'; --", 'x'.repeat(80)]) {
      expect(isValidTimezone(tz), JSON.stringify(tz)).toBe(false);
    }
  });

  it('rejects numeric offsets, which Postgres reads with the opposite sign to Intl', () => {
    for (const tz of ['+01:00', '-05:00', 'GMT+5', 'UTC+1']) {
      expect(isValidTimezone(tz), tz).toBe(false);
    }
  });
});

describe('emailListSchema', () => {
  // Alert recipients are merged into ONE message with the MSP's own recipients, so a
  // single malformed entry makes the whole send fail - for everyone on that alert.
  it('accepts empty (no extra recipients) and normalises separators and spacing', () => {
    expect(emailListSchema.parse('')).toBe('');
    expect(emailListSchema.parse('  ')).toBe('');
    expect(emailListSchema.parse('a@example.com')).toBe('a@example.com');
    expect(emailListSchema.parse('a@example.com,b@example.org ; c@example.net')).toBe('a@example.com, b@example.org, c@example.net');
    expect(emailListSchema.parse('a@example.com,, b@example.org,')).toBe('a@example.com, b@example.org');
  });

  it('rejects anything that is not a plain address', () => {
    for (const bad of [
      'not an email',
      'a@example.com, nope',
      '"Bob" <bob@example.com>', // display-name form: nodemailer would accept it, but it is not what we store
      'a@example.com\nbcc: evil@example.com', // header injection attempt
      'a@b',
      '@example.com',
    ]) {
      expect(() => emailListSchema.parse(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('caps how many recipients one company can add', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `u${i}@example.com`).join(',');
    expect(() => emailListSchema.parse(ten)).not.toThrow();
    expect(() => emailListSchema.parse(`${ten},u10@example.com`)).toThrow();
  });
});

describe('timezoneSchema', () => {
  it('passes valid zones through unchanged', () => {
    expect(timezoneSchema.parse('Europe/London')).toBe('Europe/London');
  });

  it('throws on an invalid zone so the route answers 400, not 500 later', () => {
    expect(() => timezoneSchema.parse('Mars/Olympus')).toThrow();
  });
});
