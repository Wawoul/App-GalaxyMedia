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
  /** When bytes last arrived. Staleness is judged from this, not from startedAt. */
  lastProgressAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, ImportJob>();

// Finished jobs linger briefly so the UI's next poll can read the outcome, then
// go, so a long-running server doesn't accumulate them.
const KEEP_FINISHED_MS = 5 * 60_000;
// An import that hasn't advanced in this long is presumed dead (the process
// can't be mid-download without updating receivedBytes).
const STALE_MS = 60 * 60_000;

/**
 * Drops finished jobs once the page has had time to read them, and downloads that
 * have genuinely stalled. "Stalled" is time since bytes LAST arrived: this used to
 * measure time since the job STARTED, so a big file over a slow link lost its record
 * at 60 minutes while still downloading - the page never saw it finish, and the
 * per-company concurrency cap stopped counting it.
 */
export function pruneJobs(now = Date.now()): void {
  for (const [id, job] of jobs) {
    const finished = job.finishedAt !== undefined;
    if (finished && now - job.finishedAt! > KEEP_FINISHED_MS) jobs.delete(id);
    else if (!finished && now - job.lastProgressAt > STALE_MS) jobs.delete(id);
  }
}

setInterval(() => pruneJobs(), 60_000).unref();

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
  // Runs at startup only, so by definition nothing is mid-write: this process
  // has no imports yet, and any previous process is gone. An age check here
  // would be unsound anyway - mtime tracks the last write, so a stalled import
  // looks "old" while its file descriptor is still open, and unlinking it would
  // make the eventual rename() fail with a baffling error after an hour.
  const scanDir = async (dir: string, isOrphan: (name: string) => boolean) => {
    const files = await readdir(dir).catch(() => []);
    for (const name of files) {
      if (!isOrphan(name)) continue;
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      await unlink(file)
        .then(() => log.warn({ file, bytes: info.size }, 'removed an orphaned partial upload'))
        .catch(() => {});
    }
  };

  const entries = await readdir(mediaDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(mediaDir, entry.name);
    // Media imports/uploads write `.upload-<uuid>`; the APK upload (routes/
    // system.ts) writes `<name>.apk.upload`, which the prefix check missed
    // entirely - so a failed APK upload leaked up to MAX_UPLOAD_MB forever.
    await scanDir(dir, (name) => name.startsWith('.upload-') || name.endsWith('.upload'));
  }
}

/**
 * Concurrent downloads allowed per company. Each one holds an open socket and a
 * file being written, so without a cap an editor could start thousands in a
 * loop and exhaust sockets, file descriptors and disk on a single-process
 * server. Two at a time is ample for the actual use case (a tech adding media).
 */
export const MAX_ACTIVE_IMPORTS_PER_COMPANY = 2;

export class TooManyImportsError extends Error {
  statusCode = 429;
  constructor() {
    super('another import is already running for this company - wait for it to finish');
  }
}

export function activeCountForCompany(companyId: string): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.companyId === companyId && job.status === 'downloading') count++;
  }
  return count;
}

export function createJob(job: Omit<ImportJob, 'status' | 'receivedBytes' | 'startedAt' | 'lastProgressAt'>): ImportJob {
  if (activeCountForCompany(job.companyId) >= MAX_ACTIVE_IMPORTS_PER_COMPANY) {
    throw new TooManyImportsError();
  }
  const created: ImportJob = {
    ...job,
    status: 'downloading',
    receivedBytes: 0,
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
  };
  jobs.set(created.id, created);
  return created;
}

export function getJob(id: string): ImportJob | undefined {
  return jobs.get(id);
}

export function updateProgress(id: string, receivedBytes: number): void {
  const job = jobs.get(id);
  if (job) {
    job.receivedBytes = receivedBytes;
    job.lastProgressAt = Date.now();
  }
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
