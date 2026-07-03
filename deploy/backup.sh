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

mkdir -p "$DEST"
chmod 700 "$BACKUP_DIR"

# 1. Database (custom format: restore with pg_restore)
sudo -u postgres pg_dump -Fc galaxy_media > "$DEST/galaxy_media.dump"

# 2. Config (contains JWT/encryption keys: without these, encrypted fields are lost)
cp /etc/galaxy-media/config.env "$DEST/config.env"
chmod 600 "$DEST/config.env"

# 3. Media files (hardlink against the previous backup to save space)
PREV="$(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | sort | tail -2 | head -1 || true)"
if [[ -n "$PREV" && -d "$PREV/media" && "$PREV" != "$DEST/" ]]; then
  rsync -a --link-dest="$PREV/media" /var/lib/galaxy-media/media/ "$DEST/media/"
else
  rsync -a /var/lib/galaxy-media/media/ "$DEST/media/"
fi

# 4. Rotate
find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +

# 5. Readable marker for the System tab's "Last backup" stat: the backup dir
# itself is root-only (0700), so the API (running as galaxy) can't inspect it.
date -u +"%Y-%m-%dT%H:%M:%SZ" > /var/lib/galaxy-media/media/.last-backup
chown galaxy:galaxy /var/lib/galaxy-media/media/.last-backup

echo "backup complete: $DEST ($(du -sh "$DEST" | cut -f1))"
