#!/usr/bin/env bash
# Swap a freshly built release into place, restart the service, and ROLL BACK if the new
# build does not come up healthy.
#
#   swap-release.sh <app-dir> <stage-dir> <health-command> <restart-command>
#
# update.sh used to rsync the new build straight over the running one and restart. If the
# new build then failed to start (a bad migration, a missing dependency, a typo that only
# shows at runtime) the service crash-looped with the old, working build already gone.
# Here the previous build is moved aside first, so a failed start puts it straight back.
#
# Environment (for tests): HEALTH_TRIES (default 30), HEALTH_INTERVAL seconds (default 1).
set -uo pipefail

APP="${1:-}"; STAGE="${2:-}"; HEALTH="${3:-}"; RESTART="${4:-}"
TRIES="${HEALTH_TRIES:-30}"
INTERVAL="${HEALTH_INTERVAL:-1}"

if [[ -z "$APP" || -z "$STAGE" || -z "$HEALTH" || -z "$RESTART" ]]; then
  echo "usage: swap-release.sh <app-dir> <stage-dir> <health-command> <restart-command>" >&2
  exit 2
fi
# Check everything BEFORE moving anything: a half-done swap is worse than none.
if [[ ! -d "$APP/server" || ! -d "$STAGE/server" || ! -d "$STAGE/admin" ]]; then
  echo "refusing to swap: expected $APP/server and $STAGE/{server,admin} to exist" >&2
  exit 2
fi

healthy() {
  local i
  for ((i = 1; i <= TRIES; i++)); do
    if eval "$HEALTH" >/dev/null 2>&1; then return 0; fi
    sleep "$INTERVAL"
  done
  return 1
}

# 1. Set the running build aside (replacing leftovers of any earlier update).
rm -rf "$APP/server.prev" "$APP/admin.prev" "$APP/server.failed" "$APP/admin.failed"
mv "$APP/server" "$APP/server.prev"
[[ -d "$APP/admin" ]] && mv "$APP/admin" "$APP/admin.prev"

# 2. Put the new build in place.
mv "$STAGE/server" "$APP/server"
mv "$STAGE/admin" "$APP/admin"

# 3. Restart and wait for the API to answer.
eval "$RESTART"
if healthy; then
  echo "new release is healthy"
  echo "previous release kept in $APP/server.prev and $APP/admin.prev (swap them back and restart to undo)"
  exit 0
fi

# 4. It did not come up: put the previous build back.
echo "NEW RELEASE DID NOT BECOME HEALTHY - rolled back to the previous release" >&2
mv "$APP/server" "$APP/server.failed"
mv "$APP/admin" "$APP/admin.failed"
mv "$APP/server.prev" "$APP/server"
[[ -d "$APP/admin.prev" ]] && mv "$APP/admin.prev" "$APP/admin"
eval "$RESTART"
if ! healthy; then
  echo "WARNING: the previous release is not answering either - check: journalctl -u galaxy-api -n 50" >&2
fi
echo "the failed build is kept in $APP/server.failed for inspection" >&2
exit 1
