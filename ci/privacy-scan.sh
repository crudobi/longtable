#!/bin/bash
# privacy-scan.sh — fail-closed privacy/sensitivity scan for Longtable.
#
# Usage:
#   privacy-scan.sh [--secrets FILE] [--patterns FILE] [--allowlist FILE]
#                   [--generic-only] [--rev <rev>] <target>
#   <target> is a directory (scans its tracked + untracked non-ignored
#   files via git ls-files, or all files if it is not a repo) or a
#   single file (e.g. release notes). With --rev, <target> must be a git
#   repo and the scan runs git grep at that revision instead of the
#   worktree (history scan).
#
#   Directory mode (S26): tracked AND untracked files are scanned —
#   a secret in a new untracked file used to pass a local scan.
#   Gitignored files are deliberately NOT scanned: they are build
#   outputs and local secret-adjacent files (dist/, *.jks, .env,
#   turn-password.txt) that are never committed and never published
#   as source; the artifact gates (release_turn_clean,
#   forbidden_literals_clean_dir, release_artifacts_clean) cover the
#   built/published artifacts those files can reach instead.
#
#   Without --secrets and without STATE (S29), the scan FAILS (exit 2):
#   a generic-patterns-only scan is a reduced gate and must be asked
#   for explicitly with --generic-only. The pipeline and the history
#   scan always pass --secrets.
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
# a CI log. Binary blobs have no line: a secrets hit in one is reported
# as file:0:secret-binary (S30).
#
# Exit 0 = clean, 1 = hits found, 2 = usage/config error.
set -uo pipefail

PATTERNS=""
ALLOWLIST=""
SECRETS=""
GENERIC_ONLY=0
REV=""
TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --secrets)   [ $# -ge 2 ] || { echo "privacy-scan: --secrets needs a value" >&2; exit 2; }; SECRETS=$2; shift 2 ;;
    --patterns)  [ $# -ge 2 ] || { echo "privacy-scan: --patterns needs a value" >&2; exit 2; }; PATTERNS=$2; shift 2 ;;
    --allowlist) [ $# -ge 2 ] || { echo "privacy-scan: --allowlist needs a value" >&2; exit 2; }; ALLOWLIST=$2; shift 2 ;;
    --generic-only) GENERIC_ONLY=1; shift ;;
    --rev)       [ $# -ge 2 ] || { echo "privacy-scan: --rev needs a value" >&2; exit 2; }; REV=$2; shift 2 ;;
    -h|--help)
      sed -n '2,44p' "${BASH_SOURCE[0]}"
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
  elif [ "$GENERIC_ONLY" = 1 ]; then
    echo "privacy-scan: --generic-only: scanning generic patterns only (no secrets file — reduced gate, acknowledged)" >&2
  else
    # S29: a generic-patterns-only scan must be asked for explicitly.
    # Silently scanning without the secrets file used to exit 0 with a
    # stderr warning — a caller that forgot --secrets looked clean.
    echo "privacy-scan: no --secrets given and STATE unset; refusing to scan generic patterns only (pass --generic-only to acknowledge the reduced scan)" >&2
    exit 2
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
# S28: the glob is matched against the path AND each of its trailing
# suffixes (stripping leading components one at a time), so a file
# scanned by absolute path (single-file mode: /tmp/…/notes,
# /abs/path/hub/hub.mjs) gets the same file-specific exemptions as the
# same file scanned by repo-relative path (directory/--rev mode:
# hub/hub.mjs). Single-file mode used to drop those exemptions —
# fail-closed, but inconsistent. The suffix rule only widens matches
# to paths ENDING in the listed path; the matched text must still
# satisfy the anchored ERE exactly.
allowlisted() {
  local f=$1 m=$2 g r p
  while IFS=$'\t' read -r g r || [ -n "$g" ]; do
    case "$g" in ''|'#'*) continue ;; esac
    [ -n "${r:-}" ] || continue
    p="$f"
    while :; do
      case "$p" in $g) [[ "$m" =~ $r ]] && return 0 ;; esac
      case "$p" in */*) p=${p#*/} ;; *) break ;; esac
    done
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

# Filter raw secrets hits (file:line:match) through the allow-list,
# recording survivors as file:line:secret. Secrets are matched with
# grep -oF (2026-11-20 S1): the allow-list sees the MATCHED LITERAL
# only, never the whole line — a benign substring on the line (e.g. the
# 10.0.2.2 emulator alias) must not exempt a secret on the same line.
# Allow-list EREs are anchored (^...$) in ci/privacy-allowlist (S24),
# so an entry exempts only the exact matched literal.
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
    (cd "$TARGET" && git grep -I -n -o -i -F -f "$SECRETS" "$REV" -- 2>/dev/null || true) |
      cut -d: -f2- > "$TMP/secrets_raw"
    filter_secrets "$TMP/secrets_raw"
    # S30: git grep -I skips binary blobs, so a secret inside a binary
    # file (e.g. a keystore) in history was invisible. Second pass
    # without -I, listing files only: -o on a binary blob prints
    # "Binary file … matches", which is unparseable, while -l gives
    # clean paths. Files the -I pass already reported are not
    # re-reported; the rest become file:0:secret-binary hits (a binary
    # blob has no line number). Generic patterns are NOT run here:
    # EREs on binary bytes are noise-prone (random digit runs match
    # phone-number classes), while fixed secrets literals cannot match
    # by chance — the residual (generic classes in binary blobs) is
    # documented in ci/README.md.
    (cd "$TARGET" && git grep -l -i -F -f "$SECRETS" "$REV" -- 2>/dev/null || true) |
      cut -d: -f2- | sort -u > "$TMP/secrets_binary_files"
    cut -d: -f1 "$TMP/secrets_raw" | sort -u > "$TMP/secrets_text_files"
    comm -23 "$TMP/secrets_binary_files" "$TMP/secrets_text_files" > "$TMP/secrets_binary_only" || true
    while IFS= read -r bf || [ -n "$bf" ]; do
      printf '%s:0:secret-binary\n' "$bf" >> "$HITS"
    done < "$TMP/secrets_binary_only"
  fi
elif [ -f "$TARGET" ]; then
  # --- single-file mode (e.g. release notes) ---
  FILE_COUNT=1
  grep -HInoE -f "$TMP/patterns" -- "$TARGET" > "$TMP/generic_raw" || true
  filter_generic "$TMP/generic_raw"
  if [ -n "$SECRETS" ]; then
    # -a: a binary single file (e.g. a keystore passed directly) must
    # still be searched for secrets literals (S30, same blind spot as
    # --rev mode; grep without -a reports no match on binary input).
    grep -HInioaF -f "$SECRETS" -- "$TARGET" > "$TMP/secrets_raw" || true
    filter_secrets "$TMP/secrets_raw"
  fi
elif [ -d "$TARGET" ]; then
  # --- directory mode: tracked files if a repo, else all files ---
  : > "$TMP/generic_raw"
  if git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
    # S26: tracked AND untracked (non-ignored) files, from one list
    # shared by both passes. git ls-files alone skipped untracked
    # files, so a secret in a new file passed a local scan.
    # Gitignored files stay out deliberately (see the header comment).
    (cd "$TARGET" && git ls-files --cached --others --exclude-standard -z > "$TMP/files0")
    FILE_COUNT=$(tr -cd '\0' < "$TMP/files0" | wc -c)
    (cd "$TARGET" && xargs -r -0 grep -HInoE -f "$TMP/patterns" -- < "$TMP/files0" > "$TMP/generic_raw" || true)
    filter_generic "$TMP/generic_raw"
    if [ -n "$SECRETS" ]; then
      # -a: binary files in the tree must still be searched for secrets
      # literals (S30; grep without -a reports no match on binary input).
      (cd "$TARGET" && xargs -r -0 grep -HInioaF -f "$SECRETS" -- < "$TMP/files0" > "$TMP/secrets_raw" || true)
      filter_secrets "$TMP/secrets_raw"
    fi
  else
    (cd "$TARGET" && find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -printf '%P\0' | xargs -r -0 grep -HInoE -f "$TMP/patterns" -- > "$TMP/generic_raw" || true)
    FILE_COUNT=$(cd "$TARGET" && find . -type f -not -path './.git/*' -not -path '*/node_modules/*' | wc -l)
    filter_generic "$TMP/generic_raw"
    if [ -n "$SECRETS" ]; then
      # -a: binary files must still be searched for secrets literals (S30).
      (cd "$TARGET" && find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -printf '%P\0' | xargs -r -0 grep -HInioaF -f "$SECRETS" -- 2>/dev/null || true)  > "$TMP/secrets_raw"
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
