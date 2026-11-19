import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJob, finishJob, getJob, pruneJobs, updateProgress } from './importJobs.js';

const MIN = 60_000;
let seq = 0;
const newJob = (company = 'c1') =>
  createJob({ id: `job-${++seq}`, companyId: company, userId: 'u1', url: 'https://x.test/a.mp4', name: 'a.mp4', totalBytes: 1000 });

describe('import job pruning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a slow download that is still making progress, however long it has run', () => {
    // The comment said "hasn't advanced in an hour", but the code measured time since
    // it STARTED - so a big file over a slow link lost its job record at 60 minutes
    // while still downloading: the page never saw it finish, and the per-company
    // concurrency cap stopped counting it.
    const job = newJob('slow');
    vi.setSystemTime(Date.now() + 90 * MIN);
    updateProgress(job.id, 400);
    vi.setSystemTime(Date.now() + 40 * MIN); // 130 min since start, 40 min since progress
    pruneJobs();
    expect(getJob(job.id)).toBeDefined();
  });

  it('drops a download that has not advanced for an hour', () => {
    const job = newJob('stuck');
    updateProgress(job.id, 10);
    vi.setSystemTime(Date.now() + 61 * MIN);
    pruneJobs();
    expect(getJob(job.id)).toBeUndefined();
  });

  it('keeps a finished job just long enough for the page to read its outcome', () => {
    const job = newJob('done');
    finishJob(job.id, { id: 'media-1' });
    vi.setSystemTime(Date.now() + 4 * MIN);
    pruneJobs();
    expect(getJob(job.id)).toBeDefined();
    vi.setSystemTime(Date.now() + 2 * MIN); // 6 min after finishing
    pruneJobs();
    expect(getJob(job.id)).toBeUndefined();
  });
});
