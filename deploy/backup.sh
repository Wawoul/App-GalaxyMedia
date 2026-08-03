#!/usr/bin/env bash
# Galaxy Media nightly backup: database dump + media + config.
# Keeps BACKUP_KEEP days locally in /var/backups/galaxy-media.
# For offsite copies, rsync that directory from another host (key-only SSH),
# or mount a Proxmox backup target there.
set -euo pipefail

BACKUP_DIR=/var/backups/galaxy-media
KEEP_DAYS="${BACKUP_KEEP:-7}"
STAMP="$(date +%Y-%m-%d_%H%M)"
DEST="$BACKUP_DIR/$STAMP"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" # before $DEST exists, so config.env is never briefly world-readable
mkdir -p "$DEST"

# Anything below this point that fails leaves a partial backup, which must never
# be mistaken for a good one - and must never trigger the rotation at the end.
fail() {
  echo "backup FAILED: $1" >&2
  rm -rf "$DEST"
  exit 1
}

# 1. Database (custom format: restore with pg_restore - see restore.sh)
# Write to .part first: `>` truncates the target before pg_dump runs, so a
# disk-full or permission failure would otherwise leave a zero-byte file sitting
# there looking exactly like a backup.
sudo -u postgres pg_dump -Fc galaxy_media > "$DEST/galaxy_media.dump.part" \
  || fail "pg_dump returned non-zero"
# Verify it is a readable archive, not a truncated one, before trusting it.
pg_restore -l "$DEST/galaxy_media.dump.part" >/dev/null 2>&1 \
  || fail "pg_dump produced an unreadable archive (disk full?)"
mv "$DEST/galaxy_media.dump.part" "$DEST/galaxy_media.dump"

# 2. Config (contains JWT/encryption keys: without these, encrypted fields are lost)
cp /etc/galaxy-media/config.env "$DEST/config.env" || fail "could not copy config.env"
chmod 600 "$DEST/config.env"

# 3. Media files (hardlink against the previous backup to save space)
PREV="$(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | sort | tail -2 | head -1 || true)"
if [[ -n "$PREV" && -d "$PREV/media" && "$PREV" != "$DEST/" ]]; then
  rsync -a --link-dest="$PREV/media" /var/lib/galaxy-media/media/ "$DEST/media/" \
    || fail "media rsync failed (disk full?)"
else
  rsync -a /var/lib/galaxy-media/media/ "$DEST/media/" || fail "media rsync failed (disk full?)"
fi

# 4. Rotate - only ever with a verified backup in hand. Deleting old copies
# because tonight's run failed is how a fleet ends up with no backups at all.
if [[ ! -s "$DEST/galaxy_media.dump" || ! -s "$DEST/config.env" ]]; then
  fail "refusing to rotate: this backup is incomplete"
fi
find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -mtime +"$KEEP_DAYS" \
  -not -path "$DEST" -exec rm -rf {} +

# 5. Readable marker for the System tab's "Last backup" stat: the backup dir
# itself is root-only (0700), so the API (running as galaxy) can't inspect it.
date -u +"%Y-%m-%dT%H:%M:%SZ" > /var/lib/galaxy-media/media/.last-backup
chown galaxy:galaxy /var/lib/galaxy-media/media/.last-backup

echo "backup complete: $DEST ($(du -sh "$DEST" | cut -f1))"
