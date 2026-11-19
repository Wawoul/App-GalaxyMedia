/** What sendAlert() reports per channel: null = delivered, a string = why it was not. */
export interface AlertResult {
  email: string | null;
  telegram: string | null;
}

const NOT_CONFIGURED = /not configured$/;

/**
 * Did an alert actually get out?
 *  - 'sent': at least one channel delivered it (another failing does not matter).
 *  - 'failed': a channel that IS configured errored and nothing got through - the
 *    case worth retrying.
 *  - 'unconfigured': nothing exists to deliver through, so there is nothing to retry.
 */
export function alertOutcome(result: AlertResult): 'sent' | 'failed' | 'unconfigured' {
  if (result.email === null || result.telegram === null) return 'sent';
  const attemptedAndFailed = [result.email, result.telegram].filter((reason) => !NOT_CONFIGURED.test(reason));
  return attemptedAndFailed.length > 0 ? 'failed' : 'unconfigured';
}
