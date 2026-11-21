# Install Longtable from a GitHub release

Longtable is not on Google Play yet. Until it is, install it from a
GitHub release on the phone itself. You need Android 7.0 or later
(API 24; see `android/variables.gradle`, `minSdkVersion = 24`).

## 1. Download the APK — not the AAB

On the phone (or on a computer, then copy the files to the phone),
open the release page:

`https://github.com/crudobi/longtable/releases`

Download these two files from the release you want:

- `longtable-release.apk` — **this is the file you install.**
- `longtable-release.apk.sha256` — the checksum sidecar for it.

Do **not** install `longtable-release.aab`. The `.aab` is the Play
publishing bundle: it is not an installable app, and Android cannot
sideload it. It only becomes installable APKs through Play (or
`bundletool`). The `.aab` and its `.sha256` sidecar are published for
the Play submission, not for sideloading.

## 2. Verify the download before you install it

The `.sha256` sidecar holds the SHA-256 of the APK, written as
`sha256sum longtable-release.apk` by the release pipeline
(`ci/run-pipeline.sh`, `do_publish` via `ci_write_sha256`), so the
standard check works. In the folder holding both files, run:

```sh
sha256sum -c longtable-release.apk.sha256
```

You want exactly this:

```
longtable-release.apk: OK
```

Do **not** install the APK if the check fails, or if the sidecar is
missing. Re-download both files and check again; if it still fails,
do not install that copy.

On Android you can run this in a terminal app (for example Termux),
or check the hash on a computer before copying the APK to the phone.
Either way, check in the same folder as the APK — the sidecar names
the APK by its plain filename.

Optional, if you know how: the APK is signed with the project's
upload key. `apksigner verify --print-certs` on the APK prints its
certificate fingerprints; compare the SHA-256 fingerprint with the
one in the README's "Release signing" section (the README is the
single source of truth for it — it is not repeated here, so a stale
copy cannot disagree with it).

## 3. Allow installing from unknown sources

Android will not install an APK from outside Play until you allow the
app you are installing from to do so. When you tap the APK, Android
offers the setting; or set it first:

Settings → Apps → (the browser or Files app you downloaded with) →
Install unknown apps → Allow.

The wording varies by Android version, but the path is the same idea:
the permission belongs to the app doing the installing, not to
Longtable.

## 4. Expect the Play Protect prompt

Play Protect scans sideloaded APKs. Expect a prompt along the lines
of "Play Protect doesn't recognize this developer" with a choice to
block the install or install anyway. The wording and the exact button
("Install anyway" / "Install") vary by Android version.

Only tap through **after** the checksum in step 2 said `OK`. The
checksum is what ties the file on your phone to the file the release
pipeline published; the Play Protect prompt cannot tell you that.

## 5. After installing

The app opens as a local cookbook: create, edit, delete, import, and
back up recipes all work immediately, offline, with no account and no
server.

The networked features — invite-code pairing, friend sync, publishing,
Discover — need a hub you (or someone you trust) runs. There is no
public hub, and the built-in hub points at developer-only endpoints
that reach nothing on a real phone. See "What works out of the box —
and what needs a hub" in the [README](../README.md) and
[hub/README.md](../hub/README.md) for running one.

What data leaves the device, and when, is in
[privacy-policy.md](privacy-policy.md).

## Upgrading and uninstalling

- **Upgrading:** install a newer `longtable-release.apk` over the old
  one the same way. Same signing key, so your recipes, friends, and
  identity carry over. Verify the checksum every time.
- **Uninstalling:** removes the app and everything it stored on the
  device — recipes, friends, identity. Android auto-backup is off for
  this app, so uninstalling without a backup is total loss. Make an
  encrypted backup first (Backup in the app; see
  [backup.md](backup.md)), and keep the file somewhere safe.
