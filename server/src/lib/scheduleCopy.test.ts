import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The web player runs its own copy of the schedule rules (the admin bundle cannot import
 * from the server). The copy had already drifted once - it lacked the overnight-tail rule,
 * so a Monday-only 22:00-02:00 slot stopped at midnight on web TVs only. Byte equality
 * makes drift impossible to merge: edit server/src/lib/schedule.ts, then copy it over.
 */
describe('web player schedule copy', () => {
  it('is byte-identical to the server schedule.ts', () => {
    const server = readFileSync(new URL('./schedule.ts', import.meta.url), 'utf8');
    const web = readFileSync(new URL('../../../admin/src/player/schedule.ts', import.meta.url), 'utf8');
    expect(web, 'run: cp server/src/lib/schedule.ts admin/src/player/schedule.ts').toBe(server);
  });
});
