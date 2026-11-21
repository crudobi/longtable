# Upload-keystore recovery runbook

One page: where the Android upload key lives, where its backups live,
how to restore it, how to verify the restore, and what total loss
actually costs. The keystore itself is never committed to this repo;
this page names locations by role only — the ops-side copy of this
runbook (kept with the CI state) carries the exact paths.

## What it is

- Release builds are signed with the project's upload key, alias
  `upload`, held in a Java keystore (`upload-keystore.jks`) beside a
  `key.properties` file (`storeFile`, `storePassword`, `keyAlias`,
  `keyPassword`). The pipeline's `signed-release` stage builds
  `bundleRelease` + `assembleRelease` with it, but only when HEAD
  carries an exact git tag.
- Expected certificate SHA-256 fingerprint (also in the repo README):
  `AD:C9:E0:62:94:C2:88:7B:A6:51:7F:9A:B7:5C:BA:C8:FB:81:42:D6:99:43:66:C0:A1:BA:54:A0:10:31:D4:E9`
- The `signed-release` stage pins this fingerprint: it fails closed
  if the release APK is signed by any other key. A fingerprint
  mismatch after a restore means the restore is wrong — stop, do not
  publish.

## Where it lives

| Copy | Location (by role) | Mode |
| --- | --- | --- |
| Live | Ops CI state dir, beside `key.properties` | `0600` |
| Backup 1 | Vault dir (second location, survives loss of the ops dir): `longtable-upload-keystore.jks` + `longtable-key.properties` | `0600` |
| Backup 2 | Nightly off-box snapshot of the whole host, which covers the ops CI state dir (verified 2026-11-21: latest snapshot holds both files byte-identical to live) | — |

## Passwords

KeePass, group `longtable` (synced to Bitwarden by the hourly vault
sync — the entries below are the source of truth, not `key.properties`):

- `Longtable upload keystore` (username `upload`) — the keystore
  (store) password.
- `Longtable upload key password` (username `upload`) — the key
  password.

Both entries' notes record the fingerprint, the backup locations, and
a pointer to this runbook. The passwords also exist as literals in the
ops-side privacy-secrets file (the pipeline's secret-scan patterns) —
that is a check file, not a recovery path; recover from KeePass.

## Restore procedure

1. Pick a source: the vault-dir copy first (it is the deliberate
   second location); the nightly off-box snapshot second.
2. Copy the keystore AND `key.properties` back into the ops CI state
   dir. Set mode `0600` on both. Do not leave a copy in a shell
   history, a temp dir, or a chat message.
3. Verify the restore before anything publishes:
   - `sha256sum` of the restored keystore matches the vault copy.
   - `keytool -list -v -keystore <restored> -storepass:file <file
     holding the store password>` shows alias `upload` and the
     fingerprint above. Read the password from `key.properties` by
     path into a `0600` temp file and use `-storepass:file` — never
     type or paste the password on a command line (it would show in
     `ps`) and never print it. Shred the temp file afterwards.
   - The next tagged pipeline run is the end-to-end proof: the
     `signed-release` stage's fingerprint pin passes only if the
     restored key signs the artifact.
4. If the restore was from the off-box snapshot, re-verify the
   vault-dir copy is still byte-identical afterwards (a restore is
   not a reason to let the second copy drift).

## Total loss — the honest consequence

If the keystore AND every backup AND the KeePass passwords are all
gone, the signing key is unrecoverable: a new keystore means a new
signing key. What that costs depends on one fact to confirm in Play
Console before it matters:

- **If the app is enrolled in Play App Signing** (Google holds the
  app signing key; the upload key only signs the bundle): loss is
  recoverable — request an upload-key reset from Google Play support
  with a newly generated key. Existing installs keep updating,
  because the app signing key never changed.
- **If the app is NOT enrolled** (the upload key IS the app signing
  key): loss is terminal for existing installs. Google Play will
  refuse updates signed with a different key, so the only path is a
  new app listing under a new package name and every user must
  reinstall. Local-first users who never exported lose their
  on-device data with the reinstall.

Confirm the enrollment state in Play Console now and record it here;
do not discover it during an incident. Either way, the keystore has
two backups plus KeePass for a reason — a restore should never need
the Play-support path.

## Rotation (deliberately not routine)

Do not rotate this keystore on a schedule. Rotation = a new signing
key = the total-loss consequence above for existing installs (unless
Play App Signing's key-upgrade flow applies). Rotate only if the key
is compromised, and then only through the Play Console key-upgrade /
upload-key-reset flow, never by quietly swapping the file.
