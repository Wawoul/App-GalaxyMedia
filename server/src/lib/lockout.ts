/** Failed passwords tolerated before an account is temporarily locked. */
export const MAX_FAILED_LOGINS = 5;
const LOCKOUT_BASE_S = 60; // the first lock; doubles per extra failure
/**
 * Hard ceiling on one lock. The doubling used to be unbounded, so 40 wrong
 * guesses - a few minutes from a single machine - locked an account for
 * thousands of years. Anyone who knew an admin's email could take that admin
 * offline for good, with nothing to recover it short of editing the database.
 * A cap keeps brute-force expensive without making the lock itself the attack.
 */
export const MAX_LOCKOUT_S = 15 * 60;

/** Seconds to lock an account for after `failures` consecutive wrong passwords. */
export function lockoutSeconds(failures: number): number {
  if (failures < MAX_FAILED_LOGINS) return 0;
  // Clamp the exponent first: 2 ** 1024 is Infinity, which Postgres rejects.
  const exponent = Math.min(failures - MAX_FAILED_LOGINS, 20);
  return Math.min(LOCKOUT_BASE_S * 2 ** exponent, MAX_LOCKOUT_S);
}
