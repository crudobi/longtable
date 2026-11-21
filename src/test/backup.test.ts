/**
 * Backup + export proof tests — Wave 3 C3.
 *
 * Everything runs against the REAL code paths (no mocks of the
 * export/import/backup logic): the longtable-json export round-trips
 * through the shipped jsonImporter; the encrypted backup is created
 * with the real Argon2id + secretbox code, restored into a wiped
 * store, and compared field by field. All fixtures are synthetic
 * (deterministic seeds, fixed byte patterns); no real secret ever
 * appears here, and no secret value is ever printed — assertions
 * compare lengths/booleans/equality only.
 *
 * Slow part: each backup create/restore derives an Argon2id MODERATE
 * key (~0.5 s on the build machine). The suite does ~9 derivations.
 */
import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { getOrCreateIdentity, identityFromSeed, restoreIdentitySecret } from '../identity/identity'
import { base64ToU8, u8ToBase64 } from '../identity/codec'
import {
  channelTagFor,
  listFriends,
  pairIdFor,
  saveFriend,
  shelfGuidFor,
  type FriendRecord,
} from '../friends/friends'
import {
  ensureRecipeKey,
  loadVault,
  processChannel,
  publishShare,
  readEnvelope,
  readManifest,
  readPayload,
  setKeyFriends,
} from '../friends/shelf'
import { getDisplayName, loadReceivedMap, saveReceivedMap, setDisplayName } from '../friends/service'
import { createRepo, getOrCreateDoc } from '../store/repo'
import {
  createRecipe,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  memoryStore,
  type KeyValueStore,
} from '../store/recipes'
import { jsonImporter } from '../importers/jsonImporter'
import { validateImportedRecipe } from '../importers/contract'
import { collectExport, parseExport, serializeExport } from '../backup/export'
import {
  BackupError,
  collectBackup,
  createEncryptedBackup,
  decryptBackupFile,
  restoreBackup,
  validateBackupPlaintext,
} from '../backup/backup'
import { listShares, roomForRecipe, saveShares } from '../p2p/share'
import type { Recipe, RecipeInput } from '../types'

let dbCounter = 0
const makeRepo = () => createRepo(`longtable-backup-test-${++dbCounter}`)
const seed = (n: number) => new Uint8Array(32).fill(n)
/** Synthetic test passphrase (a fixture, never a real secret). */
const PASS = 'correct horse battery staple backup'
const WRONG_PASS = 'wrong horse battery staple backup'
const FIXED_TS = '2026-11-21T10:00:00.000Z'
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const sample = (title: string, extra: Partial<RecipeInput> = {}): RecipeInput => ({
  title,
  ingredients: ['2 cups flour', '1 tsp salt'],
  steps: ['Mix everything.', 'Bake 20 min.'],
  prepMinutes: 10,
  cookMinutes: 20,
  photos: [],
  ...extra,
})

interface Populated {
  kv: KeyValueStore
  repo: ReturnType<typeof makeRepo>
  meDid: string
  friendDid: string
  friend: FriendRecord
  pairSecretB64: string
  recipeIds: string[]
  recipes: Record<string, Recipe>
  shelfUpdate: Uint8Array
}

/** Build a fully populated device: identity, friend, vault, share, shelf, received. */
async function populate(): Promise<Populated> {
  const kv = memoryStore()
  const repo = makeRepo()
  const me = await identityFromSeed(seed(1))
  await restoreIdentitySecret(u8ToBase64(me.secretKey), kv)
  const meDid = (await getOrCreateIdentity(kv)).did
  expect(meDid).toBe(me.did)
  setDisplayName('Test Cook', kv)

  const friendIdentity = await identityFromSeed(seed(2))
  // Fixed byte pattern as the pair secret — a synthetic fixture.
  const pairSecretB64 = u8ToBase64(new Uint8Array(32).fill(7))
  const pairId = await pairIdFor(pairSecretB64)
  const friend: FriendRecord = {
    did: friendIdentity.did,
    name: 'Test Friend',
    pairSecret: pairSecretB64,
    pairId,
    channelTag: channelTagFor(pairId, me.did, friendIdentity.did),
    signaling: 'wss://example.invalid/signaling',
    addedAt: FIXED_TS,
  }
  saveFriend(friend, kv)

  const index = await getOrCreateIndex(repo, kv)
  const r1 = await createRecipe(
    repo,
    index,
    sample('Shared Soup', { visibility: 'friends-only', photos: [PHOTO] }),
    { createdAt: FIXED_TS, updatedAt: FIXED_TS },
  )
  const r2 = await createRecipe(
    repo,
    index,
    sample('Private Pie', { prepMinutes: undefined, cookMinutes: undefined }),
    { createdAt: FIXED_TS, updatedAt: FIXED_TS },
  )
  const r3 = await createRecipe(repo, index, sample('Public Salad', { visibility: 'public' }), {
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  })
  // A local copy of a recipe the friend shared with me.
  const r4 = await createRecipe(repo, index, sample('Shared Soup (from friend)'), {
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  })
  const recipes: Record<string, Recipe> = {}
  for (const s of [r1, r2, r3, r4]) {
    const full = await getRecipe(repo, s.url)
    expect(full).not.toBeNull()
    recipes[s.id] = full!
  }

  // Vault: friends-only key for the shared recipe, authorized to the friend.
  const keyRec = await ensureRecipeKey(r1.id, kv)
  setKeyFriends(r1.id, [friend.did], kv)

  // P2P share record (host side) for the same recipe.
  saveShares(kv, [
    {
      recipeId: r1.id,
      room: roomForRecipe(r1.id),
      signaling: 'wss://example.invalid/signaling',
      role: 'host',
      secret: u8ToBase64(new Uint8Array(32).fill(9)),
    },
  ])

  // Received-shares mapping: the friend's recipe -> my local copy r4.
  saveReceivedMap(kv, {
    [`${friend.did}:00000000-0000-0000-0000-000000000001`]: {
      localId: r4.id,
      updatedAt: FIXED_TS,
    },
  })

  // Shelf doc: publish the shared recipe into the friend's channel.
  const shelfDoc = await getOrCreateDoc(repo, shelfGuidFor(friend))
  await publishShare(shelfDoc, me, 'Test Cook', recipes[r1.id], r1.id, keyRec, friend.did)
  const shelfUpdate = Y.encodeStateAsUpdate(shelfDoc)

  return {
    kv,
    repo,
    meDid: me.did,
    friendDid: friend.did,
    friend,
    pairSecretB64,
    recipeIds: [r1.id, r2.id, r3.id, r4.id],
    recipes,
    shelfUpdate,
  }
}

/** Assert a target store holds nothing restorable (fail-closed check). */
async function expectWiped(
  kv: KeyValueStore,
  repo: ReturnType<typeof makeRepo>,
): Promise<void> {
  expect(kv.getItem('longtable:identity-secret')).toBeNull()
  expect(listFriends(kv)).toEqual([])
  expect(loadVault(kv)).toEqual({})
  expect(listShares(kv)).toEqual([])
  expect(loadReceivedMap(kv)).toEqual({})
  const index = await getOrCreateIndex(repo, kv)
  expect(await listRecipes(index)).toEqual([])
}

describe('longtable-json export', () => {
  it('round-trips through the existing importer with byte-identical recipe content', async () => {
    const p = await populate()
    const exp = await collectExport(p.repo, p.kv)
    const text = serializeExport(exp)

    // The export parses as its own format, friends by name+DID only.
    const parsed = parseExport(text)
    expect(parsed.format).toBe('longtable-json')
    expect(parsed.version).toBe(1)
    expect(parsed.recipes).toHaveLength(4)
    expect(parsed.friends).toEqual([{ name: 'Test Friend', did: p.friendDid }])

    // Plaintext export must contain NO secret material (checked by
    // absence of the synthetic values, never printed).
    const vaultKey = loadVault(p.kv)[p.recipeIds[0]].key
    expect(text.includes(p.pairSecretB64)).toBe(false)
    expect(text.includes(vaultKey)).toBe(false)
    expect(text.includes(u8ToBase64((await identityFromSeed(seed(1))).secretKey))).toBe(false)

    // The REAL importer reads it back; validation normalizes it.
    const imported = await jsonImporter.import({ kind: 'text', text })
    expect(imported).toHaveLength(4)
    const validated = imported.map((r, i) => validateImportedRecipe(r, 'longtable-json', i))
    const byTitle = new Map(validated.map((r) => [r.title, r]))
    for (const id of p.recipeIds) {
      const orig = p.recipes[id]
      const back = byTitle.get(orig.title)
      expect(back).toBeDefined()
      expect(back!.title).toBe(orig.title)
      expect(back!.ingredients).toEqual(orig.ingredients)
      expect(back!.steps).toEqual(orig.steps)
      expect(back!.photos).toEqual(orig.photos)
      expect(back!.prepMinutes).toBe(orig.prepMinutes)
      expect(back!.cookMinutes).toBe(orig.cookMinutes)
      expect(back!.visibility).toBe(orig.visibility ?? undefined)
    }
  })

  it('rejects a file claiming another format version', () => {
    expect(() =>
      parseExport(JSON.stringify({ format: 'longtable-json', version: 99, exportedAt: FIXED_TS, recipes: [], friends: [] })),
    ).toThrow(/not a longtable-json v1 export/)
  })
})

describe('encrypted backup', () => {
  it('records Argon2id MODERATE parameters in the file', async () => {
    const p = await populate()
    const plain = await collectBackup(p.repo, p.kv, await getOrCreateIdentity(p.kv))
    const fileText = await createEncryptedBackup(plain, PASS)
    const file = JSON.parse(fileText) as Record<string, unknown>
    expect(file.format).toBe('longtable-backup')
    expect(file.version).toBe(1)
    expect(file.kdf).toBe('argon2id')
    expect(file.opsLimit).toBe(3)
    expect(file.memLimit).toBe(256 * 1024 * 1024)
    // Salt / nonce lengths only (never their values).
    expect(base64ToU8(file.salt as string).length).toBe(16)
    expect(base64ToU8(file.nonce as string).length).toBe(24)
    expect(file.ciphertext).toBeTruthy()
  })

  it('restores identical state after a full wipe (DID, recipes, friends, vault, shares, shelves)', async () => {
    const p = await populate()
    const plain = await collectBackup(p.repo, p.kv, await getOrCreateIdentity(p.kv))
    const fileText = await createEncryptedBackup(plain, PASS)

    // Wipe: a brand-new device (fresh kv + fresh repo namespace).
    const kv2 = memoryStore()
    const repo2 = makeRepo()
    const report = await restoreBackup(repo2, kv2, fileText, PASS)
    expect(report.did).toBe(p.meDid)
    expect(report.recipes).toBe(4)
    expect(report.friends).toBe(1)
    expect(report.shares).toBe(1)
    expect(report.vaultEntries).toBe(1)
    expect(report.shelves).toBe(1)
    expect(report.droppedShares).toBe(0)
    expect(report.droppedReceived).toBe(0)

    // Identity: the DID survives (the whole point of the backup).
    expect((await getOrCreateIdentity(kv2)).did).toBe(p.meDid)
    expect(getDisplayName(kv2)).toBe('Test Cook')

    // Recipes: same ids, same full content (incl. timestamps + photos).
    const index2 = await getOrCreateIndex(repo2, kv2)
    const listed = await listRecipes(index2)
    expect(listed.map((s) => s.id).sort()).toEqual([...p.recipeIds].sort())
    for (const id of p.recipeIds) {
      const back = await getRecipe(repo2, listed.find((s) => s.id === id)!.url)
      expect(back).toEqual(p.recipes[id])
    }

    // Friends, vault, shares, received mapping: identical.
    expect(listFriends(kv2)).toEqual(listFriends(p.kv))
    expect(loadVault(kv2)).toEqual(loadVault(p.kv))
    expect(listShares(kv2)).toEqual(listShares(p.kv))
    expect(loadReceivedMap(kv2)).toEqual(loadReceivedMap(p.kv))

    // Shelf doc: identical state — the manifest, payload, and envelope
    // are all present and byte-identical to the backed-up doc.
    const shelf2 = await getOrCreateDoc(repo2, shelfGuidFor(p.friend))
    expect(Y.encodeStateAsUpdate(shelf2)).toEqual(p.shelfUpdate)
    const manifest = readManifest(shelf2, p.meDid)
    expect(manifest).not.toBeNull()
    expect(manifest!.shares).toHaveLength(1)
    const payload = readPayload(shelf2, p.recipeIds[0])
    expect(payload).not.toBeNull()
    expect(readEnvelope(shelf2, p.recipeIds[0], p.friendDid)).not.toBeNull()
  })

  it('lets the friend still decrypt the restored friends-only share', async () => {
    const p = await populate()
    const plain = await collectBackup(p.repo, p.kv, await getOrCreateIdentity(p.kv))
    const fileText = await createEncryptedBackup(plain, PASS)
    const kv2 = memoryStore()
    const repo2 = makeRepo()
    await restoreBackup(repo2, kv2, fileText, PASS)

    // The friend's side, after restore: their identity opens the
    // restored envelope and decrypts the restored payload.
    const friendIdentity = await identityFromSeed(seed(2))
    const shelf2 = await getOrCreateDoc(repo2, shelfGuidFor(p.friend))
    const { received, failures } = await processChannel(shelf2, friendIdentity)
    expect(failures).toEqual([])
    expect(received).toHaveLength(1)
    expect(received[0].recipe.title).toBe('Shared Soup')
    expect(received[0].recipe.photos).toEqual([PHOTO])
  })

  it('wrong passphrase fails closed with a clear error and no partial import', async () => {
    const p = await populate()
    const plain = await collectBackup(p.repo, p.kv, await getOrCreateIdentity(p.kv))
    const fileText = await createEncryptedBackup(plain, PASS)

    const kv2 = memoryStore()
    const repo2 = makeRepo()
    await expect(restoreBackup(repo2, kv2, fileText, WRONG_PASS)).rejects.toThrow(
      /passphrase was wrong/,
    )
    await expectWiped(kv2, repo2)
  })

  it('corrupt and truncated backups fail closed with no partial import', async () => {
    const p = await populate()
    const plain = await collectBackup(p.repo, p.kv, await getOrCreateIdentity(p.kv))
    const fileText = await createEncryptedBackup(plain, PASS)
    const file = JSON.parse(fileText) as { ciphertext: string }

    // Truncated ciphertext.
    const truncated = JSON.stringify({ ...JSON.parse(fileText), ciphertext: file.ciphertext.slice(0, 24) })
    const kv2 = memoryStore()
    const repo2 = makeRepo()
    await expect(restoreBackup(repo2, kv2, truncated, PASS)).rejects.toThrow(BackupError)
    await expectWiped(kv2, repo2)

    // One flipped character mid-ciphertext (MAC failure).
    const chars = file.ciphertext.split('')
    chars[10] = chars[10] === 'A' ? 'B' : 'A'
    const flipped = JSON.stringify({ ...JSON.parse(fileText), ciphertext: chars.join('') })
    const kv3 = memoryStore()
    const repo3 = makeRepo()
    await expect(restoreBackup(repo3, kv3, flipped, PASS)).rejects.toThrow(/passphrase was wrong/)
    await expectWiped(kv3, repo3)

    // Not JSON at all.
    const kv4 = memoryStore()
    const repo4 = makeRepo()
    await expect(restoreBackup(repo4, kv4, 'this is not json', PASS)).rejects.toThrow(BackupError)
    await expectWiped(kv4, repo4)
  })

  it('tampered inner payload (valid encryption, DID mismatch) fails closed', async () => {
    const p = await populate()
    const plain = await collectBackup(p.repo, p.kv, await getOrCreateIdentity(p.kv))
    const fileText = await createEncryptedBackup(plain, PASS)

    // Re-encrypt a payload whose DID no longer matches its key: the MAC
    // passes, so only the validator can catch this — before any write.
    const decrypted = await decryptBackupFile(fileText, PASS)
    const other = await identityFromSeed(seed(3))
    const tampered = { ...decrypted, identity: { ...decrypted.identity, did: other.did } }
    expect(() => validateBackupPlaintext(tampered)).toThrow(/does not match its DID/)
    const tamperedFile = await createEncryptedBackup(tampered, PASS)

    const kv2 = memoryStore()
    const repo2 = makeRepo()
    await expect(restoreBackup(repo2, kv2, tamperedFile, PASS)).rejects.toThrow(
      /does not match its DID/,
    )
    await expectWiped(kv2, repo2)
  })

  it('restore replaces existing state instead of merging', async () => {
    const p = await populate()
    const plain = await collectBackup(p.repo, p.kv, await getOrCreateIdentity(p.kv))
    const fileText = await createEncryptedBackup(plain, PASS)

    // A different device state: another identity, another recipe, another friend.
    const kv2 = memoryStore()
    const repo2 = makeRepo()
    const other = await identityFromSeed(seed(9))
    await restoreIdentitySecret(u8ToBase64(other.secretKey), kv2)
    const index2 = await getOrCreateIndex(repo2, kv2)
    await createRecipe(repo2, index2, sample('Old Recipe'))
    saveFriend(
      {
        did: (await identityFromSeed(seed(8))).did,
        name: 'Old Friend',
        pairSecret: u8ToBase64(new Uint8Array(32).fill(3)),
        pairId: await pairIdFor(u8ToBase64(new Uint8Array(32).fill(3))),
        signaling: 'wss://example.invalid/signaling',
        addedAt: FIXED_TS,
      },
      kv2,
    )

    await restoreBackup(repo2, kv2, fileText, PASS)
    expect((await getOrCreateIdentity(kv2)).did).toBe(p.meDid)
    const listed = await listRecipes(await getOrCreateIndex(repo2, kv2))
    expect(listed.map((s) => s.id).sort()).toEqual([...p.recipeIds].sort())
    expect(listed.some((s) => s.title === 'Old Recipe')).toBe(false)
    expect(listFriends(kv2).map((f) => f.name)).toEqual(['Test Friend'])
  })

  it('refuses a short passphrase at create time', async () => {
    const p = await populate()
    const plain = await collectBackup(p.repo, p.kv, await getOrCreateIdentity(p.kv))
    await expect(createEncryptedBackup(plain, 'short')).rejects.toThrow(/at least 8 characters/)
  })

  it('rejects KDF settings outside the sane bounds', async () => {
    const p = await populate()
    const plain = await collectBackup(p.repo, p.kv, await getOrCreateIdentity(p.kv))
    const fileText = await createEncryptedBackup(plain, PASS)
    const parsed = JSON.parse(fileText) as Record<string, unknown>
    // A crafted file demanding a 4 GiB derivation must fail before deriving.
    const hostile = JSON.stringify({ ...parsed, memLimit: 4 * 1024 * 1024 * 1024 })
    const kv2 = memoryStore()
    const repo2 = makeRepo()
    await expect(restoreBackup(repo2, kv2, hostile, PASS)).rejects.toThrow(/out of range/)
    await expectWiped(kv2, repo2)
  })
})
