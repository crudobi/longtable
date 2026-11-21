#!/bin/bash
# history-scan.sh — nightly all-history privacy scan for Longtable.
#
# Fetches origin into a mirror under $STATE/work/history-scan-mirror,
# scans every rev in `git rev-list --all` with ci/privacy-scan.sh
# (--rev mode, the same pattern files + allow-list as the per-commit
# stage), and compares the hit set against the recorded baseline
# ($STATE/history-scan-baseline.json).
#
# Why a baseline: the published history still contains pre-scrub
# residue that the Oct-15 rewrite did not remove — internal paths in
# revs before the scrub commit. Those hits are known and recorded once;
# the scan fails only on NEW hits, which is the case that matters: a
# leak introduced after the baseline, including the commit-then-revert
# case the per-commit stage cannot see (a secret committed and reverted
# before HEAD is still public on GitHub).
#
# Usage: history-scan.sh [--repo DIR] [--state DIR] [--establish-baseline]
# Status: $STATE/history-scan.json (+ a per-run log under
# $STATE/logs/). Exit 0 = clean, known-baseline-only, or baseline
# established with --establish-baseline; exit 1 = new hits (needs human
# review), missing baseline (re-run with --establish-baseline after a
# human has reviewed the current hits), or baseline hits removed
# (history rewritten or baseline stale — needs human review).
# A missing baseline is NEVER silently re-established: deleting the
# baseline plus introducing a leak would otherwise make the leak
# "known" on the next run (S14).
set -uo pipefail

REPO=""
STATE=""
ESTABLISH_BASELINE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)  [ $# -ge 2 ] || { echo "history-scan: --repo needs a value" >&2; exit 2; }; REPO=$2; shift 2 ;;
    --state) [ $# -ge 2 ] || { echo "history-scan: --state needs a value" >&2; exit 2; }; STATE=$2; shift 2 ;;
    --establish-baseline) ESTABLISH_BASELINE=1; shift ;;
    -h|--help) sed -n '2,27p' "${BASH_SOURCE[0]}"; exit 0 ;;
    --) shift; break ;;
    -*) echo "history-scan: unknown option $1" >&2; exit 2 ;;
    *) echo "history-scan: unexpected argument $1" >&2; exit 2 ;;
  esac
done

[ -n "$REPO" ] || REPO=$(git rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$REPO" ] || { echo "history-scan: no repo given and not inside one" >&2; exit 2; }
[ -d "$REPO" ] || { echo "history-scan: repo not a directory: $REPO" >&2; exit 2; }
if [ -z "$STATE" ]; then
  # Default: the ops CI dir beside the repo's host root
  # (repo is <root>/code/longtable).
  STATE=$(cd "$REPO/../.." 2>/dev/null && pwd)/ops/longtable-ci
fi
[ -d "$STATE" ] || { echo "history-scan: state dir missing: $STATE" >&2; exit 2; }
[ -x "$REPO/ci/privacy-scan.sh" ] || { echo "history-scan: privacy-scan.sh missing/not executable in $REPO/ci" >&2; exit 2; }
[ -f "$REPO/ci/privacy-patterns" ] || { echo "history-scan: privacy-patterns missing in $REPO/ci" >&2; exit 2; }
[ -f "$REPO/ci/privacy-allowlist" ] || { echo "history-scan: privacy-allowlist missing in $REPO/ci" >&2; exit 2; }
[ -f "$STATE/privacy-secrets" ] || { echo "history-scan: $STATE/privacy-secrets missing; refusing to scan without the secrets patterns" >&2; exit 2; }

MIRROR="$STATE/work/history-scan-mirror"
BASELINE="$STATE/history-scan-baseline.json"
STATUS="$STATE/history-scan.json"
STARTED=$(date -Iseconds)
LOG="$STATE/logs/history-scan-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$STATE/logs" "$STATE/work"

RESULT=""
HIT_COUNT=0
REV_COUNT=0

# Detailed output goes to the per-run log; a one-line summary goes to
# stdout (the journal) after the block — same shape as the CI pipeline.
{
echo "history-scan: started $STARTED repo=$REPO"

ORIGIN=$(git -C "$REPO" config --get remote.origin.url 2>/dev/null || true)
[ -n "$ORIGIN" ] || { echo "history-scan: no origin URL in $REPO" >&2; exit 2; }
# Prefer an unauthenticated HTTPS fetch for the public repo; convert
# an SSH-style origin URL rather than depending on agent keys.
case "$ORIGIN" in
  git@github.com:*)
    ORIGIN="https://github.com/${ORIGIN#git@github.com:}"
    ORIGIN="${ORIGIN%.git}.git" ;;
esac
if [ -d "$MIRROR" ]; then
  echo "history-scan: fetching $ORIGIN into mirror"
  git -C "$MIRROR" fetch --all --prune || { echo "history-scan: mirror fetch failed" >&2; exit 2; }
else
  echo "history-scan: cloning mirror from $ORIGIN"
  git clone --mirror "$ORIGIN" "$MIRROR" || { echo "history-scan: mirror clone failed" >&2; exit 2; }
fi

HEAD=$(git -C "$MIRROR" rev-parse HEAD)
REVS=$(git -C "$MIRROR" rev-list --all)
REV_COUNT=$(printf '%s\n' "$REVS" | wc -l)
echo "history-scan: mirror HEAD $HEAD, $REV_COUNT revs"

TMP=$(mktemp -d)
trap '[ -n "${TMP:-}" ] && rm -rf "$TMP"' EXIT
: > "$TMP/hits"
for rev in $REVS; do
  # rc 0 = clean, 1 = hits (expected path), 2 = config error: abort
  # rather than silently reporting clean on a broken scan.
  rc=0
  "$REPO/ci/privacy-scan.sh" --rev "$rev" --secrets "$STATE/privacy-secrets" "$MIRROR" >> "$TMP/hits" 2>/dev/null || rc=$?
  [ "$rc" = 2 ] && { echo "history-scan: privacy-scan config error on rev $rev; aborting" >&2; exit 2; }
done
# Keep only rev-prefixed hit lines (drop the per-rev summary lines).
# The path is matched with .+ so a hit on an unusually-named path is
# never silently dropped from the baseline comparison.
grep -E '^[0-9a-f]{7,40}:.+:[0-9]+:(pattern|secret)$' "$TMP/hits" > "$TMP/hitlines" || true
sort -u "$TMP/hitlines" -o "$TMP/hitlines"
HIT_COUNT=$(wc -l < "$TMP/hitlines")
echo "history-scan: $HIT_COUNT distinct hits across $REV_COUNT revs"

FINISHED=$(date -Iseconds)
NEW_HITS="[]"
if [ ! -f "$BASELINE" ]; then
  if [ "$ESTABLISH_BASELINE" != 1 ]; then
    # Fail closed (S14): a missing baseline is never silently
    # re-established — that would bless whatever the current history
    # contains, including a fresh leak. The operator establishes it
    # explicitly after reviewing the hits in the log.
    RESULT="missing-baseline"
    echo "history-scan: NO BASELINE at $BASELINE — refusing to silently establish one"
    echo "history-scan: review the $HIT_COUNT hits in the log, then re-run with --establish-baseline"
  else
  python3 - "$BASELINE" "$TMP/hitlines" "$HEAD" "$REV_COUNT" "$STARTED" <<'PYEOF'
import json, sys
baseline_path, hits_path, head, revs, started = sys.argv[1:6]
hits = [l.rstrip("\n") for l in open(hits_path) if l.strip()]
with open(baseline_path, "w") as f:
    json.dump({"created_at": started, "head": head, "revs": int(revs), "hits": hits}, f, indent=2)
PYEOF
  RESULT="baseline-established"
  echo "history-scan: baseline established with $HIT_COUNT known hits"
  fi
else
  python3 - "$BASELINE" "$TMP/hitlines" > "$TMP/newhits" <<'PYEOF'
import json, sys
baseline = json.load(open(sys.argv[1]))
known = set(baseline.get("hits", []))
current = [l.rstrip("\n") for l in open(sys.argv[2]) if l.strip()]
new = sorted(set(current) - known)
removed = sorted(known - set(current))
print(json.dumps({"new": new, "removed": removed}))
PYEOF
  NEW_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["new"]))' "$TMP/newhits")
  REMOVED_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["removed"]))' "$TMP/newhits")
  NEW_HITS=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["new"]))' "$TMP/newhits")
  if [ "$NEW_COUNT" -gt 0 ]; then
    RESULT="dirty"
    echo "history-scan: $NEW_COUNT NEW hits (and $REMOVED_COUNT baseline hits gone)"
  elif [ "$REMOVED_COUNT" -gt 0 ]; then
    # Fail closed (S14): baseline hits disappearing means history was
    # rewritten or the baseline is stale. Either way a human must
    # confirm it is a legitimate rewrite, not a baseline trimmed to
    # hide a leak — silently accepting the smaller set would do that.
    RESULT="removed-hits"
    echo "history-scan: $REMOVED_COUNT baseline hits gone (history rewritten or baseline stale) — needs human review"
  else
    RESULT="known"
    echo "history-scan: no new hits ($HIT_COUNT total, all in baseline; $REMOVED_COUNT baseline hits gone)"
  fi
fi

python3 - "$STATUS" "$STARTED" "$FINISHED" "$HEAD" "$REV_COUNT" "$HIT_COUNT" "$RESULT" "$NEW_HITS" "$LOG" <<'PYEOF'
import json, sys
status_path, started, finished, head, revs, hits, result, new_hits_json, log = sys.argv[1:10]
rec = {
    "scanned_at": started,
    "finished_at": finished,
    "repo_head": head,
    "revs_scanned": int(revs),
    "hits": int(hits),
    "result": result,
    "new_hits": json.loads(new_hits_json),
    "log": log,
}
with open(status_path, "w") as f:
    json.dump(rec, f, indent=2)
PYEOF
echo "history-scan: result=$RESULT hits=$HIT_COUNT revs=$REV_COUNT log=$LOG"
} >"$LOG" 2>&1

echo "history-scan: result=$RESULT hits=$HIT_COUNT revs=$REV_COUNT log=$LOG"
if [ "$RESULT" = dirty ]; then
  echo "history-scan: NEW HITS NEED HUMAN REVIEW — see $STATUS" >&2
  exit 1
fi
if [ "$RESULT" = missing-baseline ]; then
  echo "history-scan: MISSING BASELINE — review the hits, then re-run with --establish-baseline" >&2
  exit 1
fi
if [ "$RESULT" = removed-hits ]; then
  echo "history-scan: BASELINE HITS REMOVED — see $STATUS" >&2
  exit 1
fi
exit 0
