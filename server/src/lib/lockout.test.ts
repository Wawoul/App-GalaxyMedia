import { describe, expect, it } from 'vitest';
import { lockoutSeconds, MAX_LOCKOUT_S } from './lockout.js';

describe('lockoutSeconds', () => {
  it('does not lock before the fifth failure', () => {
    for (const failures of [0, 1, 2, 3, 4]) expect(lockoutSeconds(failures)).toBe(0);
  });

  it('starts at a minute on the fifth failure and doubles from there', () => {
    expect(lockoutSeconds(5)).toBe(60);
    expect(lockoutSeconds(6)).toBe(120);
    expect(lockoutSeconds(7)).toBe(240);
    expect(lockoutSeconds(8)).toBe(480);
  });

  it('never exceeds the cap, however many failures pile up', () => {
    // Unbounded doubling made 40 wrong guesses lock an account for thousands of
    // years - anyone who knew an email could take that account offline for good,
    // and the only way back was editing the database.
    expect(MAX_LOCKOUT_S).toBe(15 * 60);
    expect(lockoutSeconds(9)).toBe(MAX_LOCKOUT_S);
    for (const failures of [10, 40, 1_000, 1_000_000]) {
      expect(lockoutSeconds(failures)).toBe(MAX_LOCKOUT_S);
    }
  });

  it('is always a finite number the database can store as an interval', () => {
    for (const failures of [0, 5, 100, 10_000, Number.MAX_SAFE_INTEGER]) {
      expect(Number.isFinite(lockoutSeconds(failures))).toBe(true);
    }
  });
});
