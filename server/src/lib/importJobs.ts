/**
 * In-memory progress for URL imports.
 *
 * The browser can't observe an import the way it observes an upload: with an
 * upload the bytes leave the browser, so XHR reports progress for free; with an
 * import the server does the fetching and the request would otherwise just hang
 * until it finished. So the import returns a job id immediately and the UI polls
 * this for progress.
 *
 * Deliberately in memory rather than a table: a job is meaningless once the
 * process restarts (the download died with it), and persisting would mean
 * resurrecting rows that can never complete. The trade-off is that the API is
 * single-instance for this feature, which matches the WebSocket layer's
 * existing constraint.
 */
export interface ImportJob {
  id: string;
  companyId: string;
  /** Who started it - only they and their company should be able to poll it. */
  userId: string;
  url: string;
  name: string;
  status: 'downloading' | 'done' | 'error';
  receivedBytes: number;
  /** From Content-Length; null when the source didn't say. */
  totalBytes: number | null;
  /** Set on success - the created media row. */
  media?: Record<string, unknown>;
  /** Set on failure - safe to show to the admin who asked. */
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, ImportJob>();

// Finished jobs linger briefly so the UI's next poll can read the outcome, then
// go, so a long-running server doesn't accumulate them.
const KEEP_FINISHED_MS = 5 * 60_000;
// An import that hasn't advanced in this long is presumed dead (the process
// can't be mid-download without updating receivedBytes).
const STALE_MS = 60 * 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const finished = job.finishedAt !== undefined;
    if (finished && now - job.finishedAt! > KEEP_FINISHED_MS) jobs.delete(id);
    else if (!finished && now - job.startedAt > STALE_MS) jobs.delete(id);
  }
}, 60_000).unref();

/**
 * Deletes `.upload-*` scratch files left behind when the process died mid-write.
 * Uploads used to be bounded by a request, so a crash took the client with it;
 * an import outlives its request by minutes, which makes an interrupted write
 * far likelier, and nothing else would ever collect a half-written 300MB file.
 */
export async function sweepOrphanedUploads(
  mediaDir: string,
  log: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  const { readdir, stat, unlink } = await import('node:fs/promises');
  const path = await import('node:path');
  // Older than this can't belong to a live import (they'd still be growing).
  const cutoff = Date.now() - STALE_MS;
  const companies = await readdir(mediaDir, { withFileTypes: true }).catch(() => []);
  for (const entry of companies) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(mediaDir, entry.name);
    const files = await readdir(dir).catch(() => []);
    for (const name of files) {
      if (!name.startsWith('.upload-')) continue;
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (!info || info.mtimeMs > cutoff) continue;
      await unlink(file)
        .then(() => log.warn({ file }, 'removed an orphaned partial upload'))
        .catch(() => {});
    }
  }
}

export function createJob(job: Omit<ImportJob, 'status' | 'receivedBytes' | 'startedAt'>): ImportJob {
  const created: ImportJob = {
    ...job,
    status: 'downloading',
    receivedBytes: 0,
    startedAt: Date.now(),
  };
  jobs.set(created.id, created);
  return created;
}

export function getJob(id: string): ImportJob | undefined {
  return jobs.get(id);
}

export function updateProgress(id: string, receivedBytes: number): void {
  const job = jobs.get(id);
  if (job) job.receivedBytes = receivedBytes;
}

export function finishJob(id: string, media: Record<string, unknown>): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'done';
  job.media = media;
  job.finishedAt = Date.now();
}

export function failJob(id: string, error: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'error';
  job.error = error;
  job.finishedAt = Date.now();
}
