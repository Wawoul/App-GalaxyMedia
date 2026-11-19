#!/usr/bin/env bash
# Tests for deploy/swap-release.sh: a new build that fails to start must be rolled back
# automatically, leaving the previous build running. Uses throwaway directories and fake
# restart/health commands - nothing real is touched.
#
#   bash deploy/tests/swap-release.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWAP="$HERE/../swap-release.sh"
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# A fake install: APP/{server,admin} hold the running build, STAGE/{server,admin} the new one.
# "Healthy" means the running server's VERSION file does not say BROKEN.
setup() {
  APP="$TMP/app"; STAGE="$TMP/stage"; LOG="$TMP/restarts.log"
  rm -rf "$APP" "$STAGE" "$LOG"
  mkdir -p "$APP/server" "$APP/admin" "$STAGE/server" "$STAGE/admin"
  echo old > "$APP/server/VERSION"; echo old > "$APP/admin/VERSION"
  echo "$1" > "$STAGE/server/VERSION"; echo "$1" > "$STAGE/admin/VERSION"
  HEALTH="! grep -q BROKEN '$APP/server/VERSION'"
  RESTART="echo restart >> '$LOG'"
}
run() { HEALTH_TRIES=3 HEALTH_INTERVAL=0 bash "$SWAP" "$APP" "$STAGE" "$HEALTH" "$RESTART" >"$TMP/out.txt" 2>&1; }
restarts() { [ -f "$LOG" ] && wc -l < "$LOG" | tr -d ' ' || echo 0; }

echo "== a healthy new build"
setup new
run; rc=$?
check "exits 0"                                  '[ $rc -eq 0 ]'
check "the new build is live (server)"           '[ "$(cat "$APP/server/VERSION")" = new ]'
check "the new build is live (admin)"            '[ "$(cat "$APP/admin/VERSION")" = new ]'
check "the previous build is kept for a manual rollback" '[ "$(cat "$APP/server.prev/VERSION")" = old ] && [ "$(cat "$APP/admin.prev/VERSION")" = old ]'
check "the service was restarted exactly once"   '[ "$(restarts)" = 1 ]'
check "the stage folder was consumed"            '[ ! -e "$STAGE/server" ]'

echo "== a new build that does not come up healthy"
setup BROKEN
run; rc=$?
check "exits non-zero"                           '[ $rc -ne 0 ]'
check "the previous build is running again (server)" '[ "$(cat "$APP/server/VERSION")" = old ]'
check "the previous build is running again (admin)"  '[ "$(cat "$APP/admin/VERSION")" = old ]'
check "the service was restarted again to pick it up" '[ "$(restarts)" = 2 ]'
check "the failed build is kept for inspection"  '[ "$(cat "$APP/server.failed/VERSION")" = BROKEN ]'
check "the output says what happened"            'grep -qi "rolled back" "$TMP/out.txt"'

echo "== leftovers from an earlier update are replaced, not stacked"
setup new
mkdir -p "$APP/server.prev" "$APP/admin.prev" "$APP/server.failed"; echo ancient > "$APP/server.prev/VERSION"
run; rc=$?
check "still succeeds"                           '[ $rc -eq 0 ]'
check "server.prev is the build that was just replaced, not the ancient one" '[ "$(cat "$APP/server.prev/VERSION")" = old ]'

echo "== refuses to run with bad arguments, changing nothing"
setup new
HEALTH_TRIES=1 bash "$SWAP" "$APP" "$TMP/does-not-exist" "true" "true" >/dev/null 2>&1; rc=$?
check "missing stage folder -> non-zero"         '[ $rc -ne 0 ]'
check "the running build is untouched"           '[ "$(cat "$APP/server/VERSION")" = old ]'
bash "$SWAP" >/dev/null 2>&1; rc=$?
check "no arguments -> non-zero"                 '[ $rc -ne 0 ]'

echo "passed=$pass failed=$fail"; [ $fail -eq 0 ]
