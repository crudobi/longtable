#!/bin/bash
# privacy-scan.sh — fail-closed privacy/sensitivity scan for Longtable.
#
# Usage:
#   privacy-scan.sh [--secrets FILE] [--patterns FILE] [--allowlist FILE]
#                   [--rev <rev>] <target>
#   <target> is a directory (scans its tracked files via git ls-files,
#   or all files if it is not a repo) or a single file (e.g. release
#   notes). With --rev, <target> must be a git repo and the scan runs
#   git grep at that revision instead of the worktree (history scan).
#
# Patterns come from two sources:
#   * the checked-in generic pattern file (ERE classes: private-key
#     headers, token prefixes, RFC1918 ranges, emails, real-format PLC
#     DIDs, credential-embedded URLs, phone numbers). It holds no
#     identifying values.
#   * the ops-side secrets file (--secrets; default $STATE/privacy-secrets
#     when STATE is set): fixed strings for the specific values that must
#     never appear — hostnames, the burned/rotated credentials, internal
#     paths. 0600, never in git. If STATE is set but the file is missing,
#     the scan FAILS: missing patterns must not silently pass.
#
# Matches are filtered through the allow-list (file glob + ERE against
# the matched text). Output is file:line + pattern class ONLY — matched
# content is never printed, so a secret value can never reach stdout or
# a CI log.
#
# Exit 0 = clean, 1 = hits found, 2 = usage/config error.
set -uo pipefail

PATTERNS=""
ALLOWLIST=""
SECRETS=""
REV=""
TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --secrets)   [ $# -ge 2 ] || { echo "privacy-scan: --secrets needs a value" >&2; exit 2; }; SECRETS=$2; shift 2 ;;
    --patterns)  [ $# -ge 2 ] || { echo "privacy-scan: --patterns needs a value" >&2; exit 2; }; PATTERNS=$2; shift 2 ;;
    --allowlist) [ $# -ge 2 ] || { echo "privacy-scan: --allowlist needs a value" >&2; exit 2; }; ALLOWLIST=$2; shift 2 ;;
    --rev)       [ $# -ge 2 ] || { echo "privacy-scan: --rev needs a value" >&2; exit 2; }; REV=$2; shift 2 ;;
    -h|--help)
      sed -n '2,25p' "${BASH_SOURCE[0]}"
      exit 0 ;;
    --) shift; break ;;
    -*) echo "privacy-scan: unknown option $1" >&2; exit 2 ;;
    *)  [ -z "$TARGET" ] || { echo "privacy-scan: extra target $1" >&2; exit 2; }; TARGET=$1; shift ;;
  esac
done
[ -n "$TARGET" ] || { echo "privacy-scan: no target given" >&2; exit 2; }

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[ -n "$PATTERNS" ] || PATTERNS="$SCRIPT_DIR/privacy-patterns"
[ -n "$ALLOWLIST" ] || ALLOWLIST="$SCRIPT_DIR/privacy-allowlist"
if [ -z "$SECRETS" ]; then
  if [ -n "${STATE:-}" ]; then
    if [ -f "$STATE/privacy-secrets" ]; then
      SECRETS="$STATE/privacy-secrets"
    else
      echo "privacy-scan: STATE is set but $STATE/privacy-secrets is missing; refusing to scan without the secrets patterns" >&2
      exit 2
    fi
  else
    echo "privacy-scan: no --secrets given and STATE unset; scanning generic patterns only" >&2
  fi
fi
[ -f "$PATTERNS" ] || { echo "privacy-scan: pattern file missing: $PATTERNS" >&2; exit 2; }
[ -f "$ALLOWLIST" ] || { echo "privacy-scan: allow-list missing: $ALLOWLIST" >&2; exit 2; }
if [ -n "$SECRETS" ]; then
  [ -f "$SECRETS" ] || { echo "privacy-scan: secrets file missing: $SECRETS" >&2; exit 2; }
  [ -s "$SECRETS" ] || { echo "privacy-scan: secrets file empty: $SECRETS" >&2; exit 2; }
  # An empty line in a fixed-string pattern file matches everything.
  if grep -q '^$' "$SECRETS"; then echo "privacy-scan: blank line in secrets file" >&2; exit 2; fi
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# grep -f has no comment syntax: strip comments/blank lines first.
grep -v '^[[:space:]]*#' "$PATTERNS" | grep -v '^[[:space:]]*$' > "$TMP/patterns" || true
[ -s "$TMP/patterns" ] || { echo "privacy-scan: no patterns in $PATTERNS" >&2; exit 2; }

HITS="$TMP/hits"        # file:line:class only — never matched content
: > "$HITS"
FILE_COUNT=0

# allow-listed? $1 = file path, $2 = matched text. True when some entry
# matches both the file glob and the matched text.
allowlisted() {
  local f=$1 m=$2 g r
  while IFS=$'\t' read -r g r || [ -n "$g" ]; do
    case "$g" in ''|'#'*) continue ;; esac
    [ -n "${r:-}" ] || continue
    case "$f" in $g) [[ "$m" =~ $r ]] && return 0 ;; esac
  done < "$ALLOWLIST"
  return 1
}

# Filter raw grep -o hits (file:line:match) through the allow-list,
# recording survivors as file:line:pattern.
filter_generic() {
  local raw=$1 hit f rest ln m
  while IFS= read -r hit || [ -n "$hit" ]; do
    f=${hit%%:*}; rest=${hit#*:}; ln=${rest%%:*}; m=${rest#*:}
    allowlisted "$f" "$m" || printf '%s:%s:pattern\n' "$f" "$ln" >> "$HITS"
  done < "$raw"
}

# Filter raw secrets hits (file:line:match-or-line) through the allow-list,
# recording survivors as file:line:secret. Secrets hits previously bypassed
# the allow-list entirely (2026-11-17: a hostname entry could not exempt a
# secrets-class hit); now both classes filter the same way.
filter_secrets() {
  local raw=$1 hit f rest ln m
  while IFS= read -r hit || [ -n "$hit" ]; do
    f=${hit%%:*}; rest=${hit#*:}; ln=${rest%%:*}; m=${rest#*:}
    allowlisted "$f" "$m" || printf '%s:%s:secret\n' "$f" "$ln" >> "$HITS"
  done < "$raw"
}

if [ -n "$REV" ]; then
  # --- revision mode: git grep at <rev> in TARGET (a git repo) ---
  [ -d "$TARGET" ] || { echo "privacy-scan: --rev target is not a directory: $TARGET" >&2; exit 2; }
  git -C "$TARGET" rev-parse --verify --quiet "$REV" >/dev/null || { echo "privacy-scan: unknown revision: $REV" >&2; exit 2; }
  FILE_COUNT=$(git -C "$TARGET" ls-tree -r --name-only "$REV" | wc -l)
  (cd "$TARGET" && git grep -I -n -o -E -f "$TMP/patterns" "$REV" -- 2>/dev/null || true) |
    cut -d: -f2- > "$TMP/generic_raw"
  filter_generic "$TMP/generic_raw"
  if [ -n "$SECRETS" ]; then
    (cd "$TARGET" && git grep -I -n -i -F -f "$SECRETS" "$REV" -- 2>/dev/null || true) |
      cut -d: -f2- > "$TMP/secrets_raw"
    filter_secrets "$TMP/secrets_raw"
  fi
elif [ -f "$TARGET" ]; then
  # --- single-file mode (e.g. release notes) ---
  FILE_COUNT=1
  grep -HInoE -f "$TMP/patterns" -- "$TARGET" > "$TMP/generic_raw" || true
  filter_generic "$TMP/generic_raw"
  if [ -n "$SECRETS" ]; then
    grep -HIniF -f "$SECRETS" -- "$TARGET" > "$TMP/secrets_raw" || true
    filter_secrets "$TMP/secrets_raw"
  fi
elif [ -d "$TARGET" ]; then
  # --- directory mode: tracked files if a repo, else all files ---
  : > "$TMP/generic_raw"
  if git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
    (cd "$TARGET" && git ls-files -z | xargs -r -0 grep -HInoE -f "$TMP/patterns" -- > "$TMP/generic_raw" || true)
    FILE_COUNT=$(cd "$TARGET" && git ls-files | wc -l)
  else
    (cd "$TARGET" && find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -printf '%P\0' | xargs -r -0 grep -HInoE -f "$TMP/patterns" -- > "$TMP/generic_raw" || true)
    FILE_COUNT=$(cd "$TARGET" && find . -type f -not -path './.git/*' -not -path '*/node_modules/*' | wc -l)
  fi
  filter_generic "$TMP/generic_raw"
  if [ -n "$SECRETS" ]; then
    if git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
      (cd "$TARGET" && git ls-files -z | xargs -r -0 grep -HIniF -f "$SECRETS" -- 2>/dev/null || true)  > "$TMP/secrets_raw"
      filter_secrets "$TMP/secrets_raw"
    else
      (cd "$TARGET" && find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -printf '%P\0' | xargs -r -0 grep -HIniF -f "$SECRETS" -- 2>/dev/null || true)  > "$TMP/secrets_raw"
      filter_secrets "$TMP/secrets_raw"
    fi
  fi
else
  echo "privacy-scan: target is neither a file nor a directory: $TARGET" >&2
  exit 2
fi

# De-duplicate (one line can match several patterns) and report.
sort -u "$HITS" -o "$HITS"
N=$(wc -l < "$HITS")
if [ "$N" -gt 0 ]; then
  echo "privacy-scan: FAIL ($N hits in $FILE_COUNT files; file:line:class only — matched content is never printed)"
  if [ -n "$REV" ]; then
    # In --rev mode each hit is prefixed with the short rev so a
    # history scan can tell which revision a hit came from.
    REV_SHORT=$(git -C "$TARGET" rev-parse --short "$REV" 2>/dev/null || echo "$REV")
    sed "s|^|$REV_SHORT:|" "$HITS"
  else
    cat "$HITS"
  fi
  exit 1
fi
echo "privacy-scan: clean ($FILE_COUNT files scanned)"
exit 0
