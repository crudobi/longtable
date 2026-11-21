#!/bin/bash
# history-scan.sh — nightly all-history privacy scan for Longtable.
#
# Fetches origin into a mirror under $STATE/work/history-scan-mirror,
# scans every rev in `git rev-list --all` with the HASH-PINNED scanner
# ($STATE/scanner/privacy-scan.sh, --rev mode — H3, never the repo's
# own ci/ copy), and compares the hit set against the recorded
# baseline ($STATE/history-scan-baseline.json). Commit and tag messages
# are scanned too (M18): every rev's message plus every tag annotation
# goes through the same pinned scanner and is compared against the
# baseline's "message_hits" key, so a secret in a subject or an
# annotation is caught even though no tree ever contained it.
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
# Sec L21: the installed copy must track the repo — a stale installed
# script silently runs old gates (the pre-H3 installed copy ran the
# worktree scanner and skipped the message scan entirely). Fail closed
# on drift; the operator re-runs ci/install-ci.sh after any ci/ change.
[ -f "$REPO/ci/history-scan.sh" ] || { echo "history-scan: repo copy missing: $REPO/ci/history-scan.sh" >&2; exit 2; }
cmp -s "$STATE/history-scan.sh" "$REPO/ci/history-scan.sh" || { echo "history-scan: installed copy $STATE/history-scan.sh differs from $REPO/ci/history-scan.sh — run ci/install-ci.sh" >&2; exit 2; }
# Hash-pinned scanner (H3): the scan must not judge history with a
# scanner from the history it judges. The pinned copy is verified
# against its sha256sums manifest before every run; a missing pin or
# a hash mismatch fails closed. Install/refresh it by hand with
# ci/pin-scanner.sh — never from this script.
SCANNER_DIR="$STATE/scanner"
[ -d "$SCANNER_DIR" ] || { echo "history-scan: pinned scanner dir missing: $SCANNER_DIR (run ci/pin-scanner.sh)" >&2; exit 2; }
[ -f "$SCANNER_DIR/sha256sums" ] || { echo "history-scan: pinned scanner manifest missing in $SCANNER_DIR" >&2; exit 2; }
[ -x "$SCANNER_DIR/privacy-scan.sh" ] || { echo "history-scan: pinned privacy-scan.sh missing/not executable in $SCANNER_DIR" >&2; exit 2; }
(cd "$SCANNER_DIR" && sha256sum -c sha256sums >/dev/null) || { echo "history-scan: pinned scanner hash mismatch; refusing to scan" >&2; exit 2; }
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
  "$SCANNER_DIR/privacy-scan.sh" --rev "$rev" --secrets "$STATE/privacy-secrets" "$MIRROR" >> "$TMP/hits" 2>/dev/null || rc=$?
  [ "$rc" = 2 ] && { echo "history-scan: privacy-scan config error on rev $rev; aborting" >&2; exit 2; }
done
# Keep only rev-prefixed hit lines (drop the per-rev summary lines).
# The path is matched with .+ so a hit on an unusually-named path is
# never silently dropped from the baseline comparison. The
# secret-binary class (S30: a secrets literal in a binary blob, no
# line number) is a hit like any other.
grep -E '^[0-9a-f]{7,40}:.+:[0-9]+:(pattern|secret|secret-binary)$' "$TMP/hits" > "$TMP/hitlines" || true
sort -u "$TMP/hitlines" -o "$TMP/hitlines"
HIT_COUNT=$(wc -l < "$TMP/hitlines")
echo "history-scan: $HIT_COUNT distinct hits across $REV_COUNT revs"

# --- commit + tag messages (M18) -------------------------------------------
# Messages are not in any tree, so the per-rev scan above cannot see
# them. Scan them all in one file (one section per rev, then one per
# tag) with the same pinned scanner + secrets. Hits are mapped back to
# their rev/tag by the section header above them (a header line is
# only trusted when it matches ---msg <40-hex>--- exactly, or
# ---tag <name>--- with <name> a real tag, so a message line that
# merely looks like a header cannot misattribute a hit) and recorded
# as <rev-short>:<line-in-message>:<class> or
# tag:<name>:<line>:<class>. Compared against the baseline's
# "message_hits" key, same S14 rules as tree hits: never silently
# blessed, removed hits fail closed.
MSG_FILE="$TMP/messages.txt"
: > "$MSG_FILE"
for rev in $REVS; do
  {
    echo "---msg $rev---"
    git -C "$MIRROR" show -s --format=%B "$rev"
  } >> "$MSG_FILE"
done
git -C "$MIRROR" for-each-ref --format='%(refname:short)' refs/tags > "$TMP/tags.txt"
for tag in $(cat "$TMP/tags.txt"); do
  {
    echo "---tag $tag---"
    git -C "$MIRROR" for-each-ref --format='%(contents)' "refs/tags/$tag"
  } >> "$MSG_FILE"
done
msg_rc=0
"$SCANNER_DIR/privacy-scan.sh" --secrets "$STATE/privacy-secrets" "$MSG_FILE" > "$TMP/msg_scan_out" 2>&1 || msg_rc=$?
[ "$msg_rc" = 2 ] && { echo "history-scan: message scan config error; aborting" >&2; exit 2; }
grep -F "$MSG_FILE:" "$TMP/msg_scan_out" | sed "s|^$MSG_FILE:||" > "$TMP/msg_rawhits" || true
python3 - "$MSG_FILE" "$TMP/msg_rawhits" "$TMP/tags.txt" > "$TMP/msg_hitlines" <<'PYEOF'
import re, sys
msg_path, rawhits_path, tags_path = sys.argv[1:4]
tags = {l.strip() for l in open(tags_path) if l.strip()}
sections = []
with open(msg_path) as f:
    for i, line in enumerate(f, start=1):
        line = line.rstrip('\n')
        m = re.fullmatch(r'---msg ([0-9a-f]{40})---', line)
        if m:
            sections.append((i, m.group(1)[:12]))
            continue
        m = re.fullmatch(r'---tag ([^ ]+)---', line)
        if m and m.group(1) in tags:
            sections.append((i, 'tag:' + m.group(1)))
out = []
for raw in open(rawhits_path):
    raw = raw.strip()
    if not raw:
        continue
    num, _, cls = raw.rpartition(':')
    lineno = int(num)
    label, start = None, None
    for s_line, s_label in reversed(sections):
        if s_line <= lineno:
            label, start = s_label, s_line
            break
    if label is None:
        continue
    out.append(f'{label}:{lineno - start}:{cls}')
if out:
    print('\n'.join(sorted(set(out))))
PYEOF
MSG_HIT_COUNT=$(wc -l < "$TMP/msg_hitlines")
echo "history-scan: $MSG_HIT_COUNT distinct message hits"

FINISHED=$(date -Iseconds)
NEW_HITS="[]"
NEW_MSG_HITS="[]"
# A baseline without the "message_hits" key predates the M18 message
# scan: treat it as a missing message baseline (fail closed, same as
# a missing file) so the message hits are reviewed, not silently
# blessed, by --establish-baseline.
BASELINE_HAS_MSGS=0
if [ -f "$BASELINE" ]; then
  BASELINE_HAS_MSGS=$(python3 -c 'import json,sys; print(1 if "message_hits" in json.load(open(sys.argv[1])) else 0)' "$BASELINE")
fi
if [ ! -f "$BASELINE" ] || [ "$BASELINE_HAS_MSGS" != 1 ]; then
  if [ "$ESTABLISH_BASELINE" != 1 ]; then
    # Fail closed (S14): a missing baseline is never silently
    # re-established — that would bless whatever the current history
    # contains, including a fresh leak. The operator establishes it
    # explicitly after reviewing the hits in the log.
    RESULT="missing-baseline"
    if [ ! -f "$BASELINE" ]; then
      echo "history-scan: NO BASELINE at $BASELINE — refusing to silently establish one"
    else
      echo "history-scan: baseline at $BASELINE predates the message scan (no message_hits key) — refusing to silently extend it"
    fi
    echo "history-scan: review the $HIT_COUNT tree hits + $MSG_HIT_COUNT message hits in the log, then re-run with --establish-baseline"
  else
  python3 - "$BASELINE" "$TMP/hitlines" "$TMP/msg_hitlines" "$HEAD" "$REV_COUNT" "$STARTED" <<'PYEOF'
import json, sys
baseline_path, hits_path, msg_hits_path, head, revs, started = sys.argv[1:7]
hits = [l.rstrip("\n") for l in open(hits_path) if l.strip()]
msg_hits = [l.rstrip("\n") for l in open(msg_hits_path) if l.strip()]
with open(baseline_path, "w") as f:
    json.dump({"created_at": started, "head": head, "revs": int(revs), "hits": hits, "message_hits": msg_hits}, f, indent=2)
PYEOF
  RESULT="baseline-established"
  echo "history-scan: baseline established with $HIT_COUNT known tree hits + $MSG_HIT_COUNT known message hits"
  fi
else
  python3 - "$BASELINE" "$TMP/hitlines" "$TMP/msg_hitlines" > "$TMP/newhits" <<'PYEOF'
import json, sys
baseline = json.load(open(sys.argv[1]))
known = set(baseline.get("hits", []))
current = [l.rstrip("\n") for l in open(sys.argv[2]) if l.strip()]
new = sorted(set(current) - known)
removed = sorted(known - set(current))
msg_known = set(baseline.get("message_hits", []))
msg_current = [l.rstrip("\n") for l in open(sys.argv[3]) if l.strip()]
msg_new = sorted(set(msg_current) - msg_known)
msg_removed = sorted(msg_known - set(msg_current))
print(json.dumps({"new": new, "removed": removed, "msg_new": msg_new, "msg_removed": msg_removed}))
PYEOF
  NEW_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["new"]))' "$TMP/newhits")
  REMOVED_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["removed"]))' "$TMP/newhits")
  NEW_HITS=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["new"]))' "$TMP/newhits")
  MSG_NEW_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["msg_new"]))' "$TMP/newhits")
  MSG_REMOVED_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["msg_removed"]))' "$TMP/newhits")
  NEW_MSG_HITS=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["msg_new"]))' "$TMP/newhits")
  if [ "$NEW_COUNT" -gt 0 ] || [ "$MSG_NEW_COUNT" -gt 0 ]; then
    RESULT="dirty"
    echo "history-scan: $NEW_COUNT NEW tree hits + $MSG_NEW_COUNT NEW message hits ($REMOVED_COUNT tree + $MSG_REMOVED_COUNT message baseline hits gone)"
  elif [ "$REMOVED_COUNT" -gt 0 ] || [ "$MSG_REMOVED_COUNT" -gt 0 ]; then
    # Fail closed (S14): baseline hits disappearing means history was
    # rewritten or the baseline is stale. Either way a human must
    # confirm it is a legitimate rewrite, not a baseline trimmed to
    # hide a leak — silently accepting the smaller set would do that.
    RESULT="removed-hits"
    echo "history-scan: $REMOVED_COUNT tree + $MSG_REMOVED_COUNT message baseline hits gone (history rewritten or baseline stale) — needs human review"
  else
    RESULT="known"
    echo "history-scan: no new hits ($HIT_COUNT tree + $MSG_HIT_COUNT message total, all in baseline)"
  fi
fi

python3 - "$STATUS" "$STARTED" "$FINISHED" "$HEAD" "$REV_COUNT" "$HIT_COUNT" "$MSG_HIT_COUNT" "$RESULT" "$NEW_HITS" "$NEW_MSG_HITS" "$LOG" <<'PYEOF'
import json, sys
status_path, started, finished, head, revs, hits, msg_hits, result, new_hits_json, new_msg_hits_json, log = sys.argv[1:12]
rec = {
    "scanned_at": started,
    "finished_at": finished,
    "repo_head": head,
    "revs_scanned": int(revs),
    "hits": int(hits),
    "message_hits": int(msg_hits),
    "result": result,
    "new_hits": json.loads(new_hits_json),
    "new_message_hits": json.loads(new_msg_hits_json),
    "log": log,
}
with open(status_path, "w") as f:
    json.dump(rec, f, indent=2)
PYEOF
echo "history-scan: result=$RESULT hits=$HIT_COUNT message_hits=$MSG_HIT_COUNT revs=$REV_COUNT log=$LOG"
} >"$LOG" 2>&1

echo "history-scan: result=$RESULT hits=$HIT_COUNT message_hits=$MSG_HIT_COUNT revs=$REV_COUNT log=$LOG"
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
