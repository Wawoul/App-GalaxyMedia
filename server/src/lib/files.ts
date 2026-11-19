import { rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

// Ids reach these helpers from validated route params, but they are about to become
// part of a path that is deleted, so refuse anything that is not plainly a UUID.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Best effort: a missing file is the normal case (no screenshot was ever taken). */
export async function removeScreenshot(screenId: string): Promise<void> {
  if (!UUID.test(screenId)) return;
  await unlink(path.join(config.MEDIA_DIR, 'screenshots', `${screenId}.jpg`)).catch(() => {});
}

/**
 * Removes everything on disk that belonged to a deleted company: its media folder
 * and its screens' screenshots. Deleting the company cascaded away every row but
 * left the files for ever - a deleted customer's content, and the disk space.
 */
export async function removeCompanyFiles(companyId: string, screenIds: string[] = []): Promise<void> {
  if (!UUID.test(companyId)) return;
  await rm(path.join(config.MEDIA_DIR, companyId), { recursive: true, force: true }).catch(() => {});
  await Promise.all(screenIds.map(removeScreenshot));
}
