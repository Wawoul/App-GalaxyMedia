import { describe, expect, it } from 'vitest';
import { alertOutcome } from './alertOutcome.js';

describe('alertOutcome', () => {
  it('is sent when at least one channel delivered', () => {
    expect(alertOutcome({ email: null, telegram: 'telegram not configured' })).toBe('sent');
    expect(alertOutcome({ email: 'email not configured', telegram: null })).toBe('sent');
    expect(alertOutcome({ email: null, telegram: null })).toBe('sent');
    // One channel failing does not matter if another got the message out.
    expect(alertOutcome({ email: 'connect ETIMEDOUT', telegram: null })).toBe('sent');
  });

  it('is failed when a configured channel errored and nothing got through', () => {
    // This is the case that used to lose the alert for good: the screen was
    // already marked as alerted, so nobody was ever told it went offline.
    expect(alertOutcome({ email: 'connect ETIMEDOUT', telegram: 'telegram not configured' })).toBe('failed');
    expect(alertOutcome({ email: 'email not configured', telegram: 'telegram HTTP 401' })).toBe('failed');
    expect(alertOutcome({ email: 'Invalid login', telegram: 'telegram HTTP 500' })).toBe('failed');
  });

  it('is unconfigured when no channel exists to fail', () => {
    expect(alertOutcome({ email: 'email not configured', telegram: 'telegram not configured' })).toBe('unconfigured');
  });
});
