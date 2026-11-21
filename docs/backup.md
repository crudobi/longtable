# Backup & restore — export + encrypted backup (Wave 3 C3)

Longtable is local-first: recipes, friends, and the device identity live
only on the device. Before this work there was no export or backup at
all — losing the phone meant losing everything. There are now two
separate mechanisms, kept visibly separate in the UI so nobody mistakes
one for the other.

## 1. Recipe export — `longtable-json` v1 (plaintext)

**File:** `longtable-export-YYYY-MM-DD.json`, produced by the Backup
panel (`src/components/BackupPanel.tsx`) via `collectExport` /
`serializeExport` in `src/backup/export.ts`.

**Contents:** every recipe (id, title, ingredients, steps, photos,
prep/cook minutes, visibility, createdAt/updatedAt) plus friends by
name + DID. The file is the same shape the shipped `longtable-json`
importer already reads (`{ "recipes": [...] }` — see
`src/importers/jsonImporter.ts`), so an export round-trips through the
Import panel with no new import code, and the round-trip is proven in
`src/test/backup.test.ts` (byte-identical recipe content through the
real importer + validator).

**Deliberately NOT in the export:** pair secrets, key-vault entries,
and the identity key. The file is plaintext by design, and it says so
in its own `notes` field. A friends-only recipe keeps its `visibility`
marker in the export, but the keys that make the share work are not
there — restoring sharing from a bare JSON export alone needs
re-pairing and re-sharing. The export's `visibility` field survives the
importer because `ImportedRecipe` gained an optional `visibility` and
`validateImportedRecipe` passes a valid tier through (an unknown tier
is dropped, never stored).

## 2. Encrypted backup — `longtable-backup` v1 (`.ltbackup`)

**File:** `longtable-backup-YYYY-MM-DD.ltbackup` (JSON), produced by
`createEncryptedBackup` and opened by `decryptBackupFile` /
`restoreBackup` in `src/backup/backup.ts`.

### File format (outer, unencrypted JSON)

```json
{
  "format": "longtable-backup",
  "version": 1,
  "kdf": "argon2id",
  "opsLimit": 3,
  "memLimit": 268435456,
  "salt": "<base64, 16 bytes>",
  "nonce": "<base64, 24 bytes>",
  "ciphertext": "<base64 secretbox ciphertext>"
}
```

### Crypto

- **KDF: Argon2id, libsodium MODERATE preset** — opsLimit 3,
  memLimit 256 MiB, 16-byte random salt, 32-byte key. Measured on the
  build machine: ~430 ms per derivation (INTERACTIVE ~80 ms, SENSITIVE
  ~2.2 s). The limits are stored in the file so a future version can
  raise them; restore enforces sane bounds (ops 1–10, mem 8 MiB–1 GiB)
  *before* deriving, so a crafted file cannot force a multi-gigabyte
  allocation.
- **Encryption: libsodium secretbox** (XSalsa20-Poly1305) over the
  plaintext JSON, random 24-byte nonce per backup. The secretbox MAC is
  the integrity check: a wrong passphrase and a corrupt file both fail
  it, and are therefore indistinguishable by construction.
- **Why the SUMO build.** The brief assumed `crypto_pwhash` from the
  pinned `libsodium-wrappers@0.8.4`, but the STANDARD build ships no
  `crypto_pwhash` at all — verified at runtime (`typeof
  sodium.crypto_pwhash === 'undefined'`; scrypt and HMAC-SHA256 are
  absent too). The backup therefore adds
  `libsodium-wrappers-sumo@0.8.4` (same libsodium, full function set)
  and imports it **dynamically**, only on the backup code paths. The
  rest of the app stays on the standard build; the production build
  emits sumo as a separate lazy chunk (`libsodium-wrappers-*.js`,
  loaded via `import()` from `backup.ts`), and the PWA precache
  includes it, so backup/restore work offline.
- **Passphrase:** entered at create and at restore, kept only in the
  Backup panel's component state for the duration of one operation,
  cleared afterwards. Never written to storage, never logged, never in
  a report. Minimum 8 characters at create. **There is no recovery:**
  a forgotten passphrase means the backup cannot be opened, and the UI
  says so in plain words.

### Plaintext contents (inside the secretbox)

```json
{
  "format": "longtable-backup",
  "version": 1,
  "exportedAt": "<ISO-8601>",
  "displayName": "<string>",
  "identity": { "did": "did:key:z...", "secretKey": "<base64, 64 bytes>" },
  "friends": [ "<FriendRecord>, incl. pairSecret, pairId, channelTag" ],
  "vault": { "<recipeId>": "<RecipeKeyRecord>" },
  "shares": [ "<ShareRecord>: recipeId, room, signaling, role, secret" ],
  "received": { "<ownerDid>:<recipeId>": { "localId": "<uuid>", "updatedAt": "..." } },
  "recipes": [ { "id": "<uuid>", "<full Recipe>" } ],
  "shelves": [ { "friendDid": "...", "guid": "shelf-...", "update": "<base64 Yjs update>" } ]
}
```

Everything a phone loss would destroy: the identity key (so the DID
survives), friends + pair secrets, the key vault, P2P share records,
the received-shares mapping, every recipe under its original id with
its original timestamps, and every friend-channel shelf document (so
shares a friend sent me survive even while they are offline — the
shelf doc is captured as a Yjs state update per friend, read directly
by guid with no channel join and no network).

### Restore semantics

- **Replace, not merge.** Restore replaces ALL local state, after the
  UI's explicit checkbox confirmation. Merging would duplicate recipes
  and could leave a stale identity key alongside the restored one —
  two DIDs on one device is exactly the conflict a backup must not
  create. The app reloads after a restore so the restored identity and
  channels take effect.
- **Fail closed, in order:** (1) parse the outer file, (2) derive the
  key and open the secretbox — wrong passphrase or corrupt file stops
  here with one message, (3) fully validate the payload — the identity
  DID re-derived from the secret key, recipe contents through the
  store's own sanitizer, share rooms re-derived from their recipe ids,
  shelf updates trial-applied to scratch docs — and only then (4) wipe
  local state and write. Validation happens before ANY write, so a
  backup that fails validation leaves local state untouched, and a
  failure mid-restore can never leave a partial import.
- **Shares keep working.** Share records restore verbatim (same room,
  same secret, same role), and the vault keys + shelf docs they depend
  on restore with them — a friends-only recipe needs no re-pairing.
  Proven in `src/test/backup.test.ts`: after wipe + restore, the
  friend's identity still opens the restored envelope and decrypts the
  restored payload.
- **Orphans are dropped and counted, never silently kept.** A share
  record whose recipe is missing from the backup, and a
  received-mapping entry whose local recipe is missing, are left out of
  the restored state; the restore report carries both counts. (The
  delete flow removes share records with their recipes, so orphans
  should not occur — but a backup must not resurrect a dead share.)
  The mapping is only an upsert cache; a dropped entry is rebuilt the
  next time that share is imported.

### Deliberately NOT in the backup

- Hub configuration (re-enterable in Hubs settings).
- The ATProto publishing session (a login — sign in again under
  Publishing). Public PDS records themselves live on the PDS, not on
  the device, and are unaffected by restore.
- The stable Yjs client id (`longtable:client-id` — device-local,
  regenerable; restored docs carry their own state).

### What the tests prove (`src/test/backup.test.ts`, 11 tests)

- Export → real `jsonImporter` → validator: byte-identical recipe
  content (title, ingredients, steps, photos, minutes, visibility);
  the export text contains no pair secret, vault key, or identity key.
- Backup → wipe (fresh store) → restore: identical DID, identical
  recipes (ids, content, timestamps, photos), identical friends,
  vault, shares, received mapping, and byte-identical shelf-doc state.
- Friend-decrypt after restore: the friend's identity opens the
  restored envelope and decrypts the restored friends-only recipe.
- Wrong passphrase, truncated ciphertext, single flipped ciphertext
  character, non-JSON file: all fail closed with no partial import
  (identity key, friends, vault, shares, recipes all still absent).
- Tampered inner payload (valid encryption, DID no longer matching its
  key): caught by validation before any write.
- Restore replaces existing state (other identity/recipe/friend gone).
- Short passphrase refused at create; KDF settings outside the sane
  bounds refused before deriving.

### `allowBackup` is unchanged

Android `allowBackup` stays `false` (`android/app/src/main/AndroidManifest.xml`).
The backup is an explicit user action (an export file the user keeps),
never Android auto-backup — a cloud copy of the identity key outside
the user's control would defeat the point.

## 3. Recovering from damaged data (H8/H9)

Saved data can go bad (a torn write, a corrupt Keystore entry, a bad
migration): the stored value is present but unreadable. The app never
silently destroys it and never silently works around it.

- **Quarantine, not deletion.** Any store whose saved JSON cannot be
  read (unparseable, or the wrong top-level shape) is copied verbatim
  under `<store-key>.corrupt-<fnv1a64-hex>` — e.g.
  `longtable:friends.corrupt-3f9a21c47b8e05d1` — and the live value
  stays in place. The quarantine key is deterministic (same bytes →
  same key), so re-detecting the damage does not pile up copies.
  Quarantine copies of secret stores route to the Keystore on native
  exactly like the keys they preserve. The corrupt value is never
  deleted by the app, except by the user's explicit "Discard damaged
  copy" (see below) — and even then the quarantine copy remains.
- **Damaged identity (H8) blocks the app.** If the stored identity
  secret is present but unreadable, no fresh identity is minted — a
  new DID would orphan every friend and published recipe — and the
  app shows a blocking "Your device identity is damaged" screen
  instead of the cookbook. The only way forward is restoring from an
  encrypted backup (the panel's restore flow works without a working
  identity; creating a backup does not). Restore replaces the damaged
  key with the backed-up one, and the app reloads onto the restored
  DID. A plain read path — including the localhost API's identity
  endpoint — can never rotate the DID by asking for it.
- **Damaged JSON stores (H9) read as safe empty views.** The friend
  list, key vault, P2P shares, received-shares mapping, hub registry,
  publications list, and local API settings each load as their empty
  default when their stored JSON is corrupt, and the app shows a
  banner naming each damaged store and its quarantine key. Saves
  refuse to overwrite a damaged store (pairing, key rotation,
  share/unshare, hub changes, and API-settings saves all throw a
  plain-language error instead), so a load-then-save round-trip can
  never persist emptiness over the damaged bytes. One bad entry
  inside an otherwise readable store is dropped individually — it
  never wipes the other entries.
- **Restore heals what the backup covers.** Restoring replaces the
  identity, friends, key vault, shares, received mapping, recipes,
  and shelf docs — and is the one writer allowed to overwrite a
  damaged store (it clears the damage record first, after the backup
  itself validated). Not in the backup, and therefore not healed by
  restore: hub configuration, the publications list, and the local
  API settings. For those, the banner offers "Discard damaged copy":
  the live damaged value is removed (the quarantine copy keeps the
  bytes) and the store heals to its default — re-enter the hubs,
  re-publish to rebuild the publications list, re-enable the API.
  The identity key is never offered for discard.
- **A backup is never made from damaged data.** `collectBackup`
  refuses when any of its source stores (friends, vault, shares,
  received mapping) is damaged: the reads would return safe empty
  views, and backing those up would mint a backup that deletes the
  user's data on restore.

What the tests prove (`src/test/corrupt.test.ts`): corrupt input is
quarantined with bytes preserved and never overwritten by any save
path; a damaged identity blocks regeneration and offers restore;
restore heals the damaged stores; a backup refuses to snapshot
damaged sources.
