#!/usr/bin/env python3
"""CI check: committed legacy-hub digests match git history (review C1).

Derives the expected FNV-1a-64 digests of the pre-scrub legacy hub
values from `git show d725e40:src/hubs/hubs.ts` (the scrub parent —
the values that actually shipped) and compares them against the
committed LEGACY_HUB_HASHES in src/hubs/hubs.ts. The defensive
LEGACY_HUB_HASHES_V0 set (fragment-joined strings that never shipped)
was pinned the same way until it was removed after the v0.2.2 release;
it is no longer checked and must not come back.

Fails closed (exit 1) on any mismatch, any unparsable file, or any
unavailable revision — a wrong digest must never ship silently again.

Prints digests, lengths, and match booleans ONLY. The legacy values
themselves are never printed, logged, or written anywhere.

Usage: check-legacy-hub-digests.py [repo-dir]
  repo-dir defaults to the checkout containing this script (ci/..).
  In the pipeline the stage passes the pristine worktree path.
"""
import re
import subprocess
import sys
from pathlib import Path

SCRUB_PARENT_REV = "d725e40"
HUBS_PATH = "src/hubs/hubs.ts"

FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3
MASK = 0xFFFFFFFFFFFFFFFF
DIGEST_RE = re.compile(r"^[0-9a-f]{16}$")
FIELDS = ("id", "name", "credential")


def fnv1a64(text):
    h = FNV_OFFSET
    for b in text.encode("utf-8"):
        h ^= b
        h = (h * FNV_PRIME) & MASK
    return format(h, "016x")


def git_show(repo, rev):
    """Return the file at rev, or None (fail closed) if unavailable."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), "show", f"{rev}:{HUBS_PATH}"],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"legacy-hub-digests: git show {rev} failed to run: {exc}")
        return None
    if proc.returncode != 0:
        print(
            f"legacy-hub-digests: git show {rev}:{HUBS_PATH} failed "
            f"(exit {proc.returncode}); history for that rev is unavailable"
        )
        return None
    return proc.stdout


def parse_pre_scrub_values(src):
    """Extract the three legacy values from the pre-scrub hubs.ts.

    Returns dict field -> value, or None if the shape is unrecognized.
    Values are returned only for in-memory hashing, never printed.
    """
    m_id = re.search(r"export const DEFAULT_HUB_ID = '([^']+)'", src)
    m_hub = re.search(
        r"export const DEFAULT_HUB: HubConfig = \{(.*?)\n\}", src, re.DOTALL
    )
    if not m_id or not m_hub:
        return None
    body = m_hub.group(1)
    m_name = re.search(r"\n  name: '([^']+)'", body)
    m_cred = re.search(r"\n  turnCredential: '([^']+)'", body)
    if not m_name or not m_cred:
        return None
    return {
        "id": m_id.group(1),
        "name": m_name.group(1),
        "credential": m_cred.group(1),
    }


def parse_committed_set(src, const_name):
    """Extract a LEGACY_HUB_HASHES* literal from hubs.ts source.

    Returns dict field -> digest, or None if the block is missing or
    any field is absent / malformed.
    """
    m = re.search(
        r"export const " + re.escape(const_name) + r": LegacyHubHashes = \{(.*?)\n\}",
        src, re.DOTALL,
    )
    if not m:
        return None
    out = {}
    for field in FIELDS:
        fm = re.search(rf"\n  {field}: '([0-9a-f]+)'", m.group(1))
        if not fm or not DIGEST_RE.match(fm.group(1)):
            return None
        out[field] = fm.group(1)
    return out


def main():
    repo = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    hubs_file = repo / HUBS_PATH
    try:
        committed_src = hubs_file.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"legacy-hub-digests: cannot read {hubs_file}: {exc}")
        return 1

    ok = True

    # --- corrected set: derived from the pre-scrub values --------------
    pre_scrub_src = git_show(repo, SCRUB_PARENT_REV)
    if pre_scrub_src is None:
        return 1
    values = parse_pre_scrub_values(pre_scrub_src)
    if values is None:
        print(
            f"legacy-hub-digests: cannot parse DEFAULT_HUB_ID / DEFAULT_HUB "
            f"from {SCRUB_PARENT_REV}:{HUBS_PATH}; refusing to guess"
        )
        return 1
    committed = parse_committed_set(committed_src, "LEGACY_HUB_HASHES")
    if committed is None:
        print("legacy-hub-digests: cannot parse LEGACY_HUB_HASHES from "
              f"{hubs_file}; refusing to guess")
        return 1
    for field in FIELDS:
        derived = fnv1a64(values[field])
        match = derived == committed[field]
        ok = ok and match
        print(
            f"legacy-hub-digests: LEGACY_HUB_HASHES.{field} "
            f"len={len(values[field])} derived={derived} "
            f"committed={committed[field]} match={str(match).lower()}"
        )

    print(f"legacy-hub-digests: ALL_MATCH={str(ok).lower()}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
