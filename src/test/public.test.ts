/**
 * Phase 3 public-publishing unit tests.
 *
 * A fake fetch implements the XRPC endpoints in-memory (session, repo
 * put/get/delete, uploadBlob), so publish/unpublish/binding are exercised
 * end to end — including the byte-exact device-signature payloads, which
 * the tests recompute independently and verify against the device key.
 */
import { describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers'
import {
  AtprotoClient,
  loadSession,
  saveSession,
  type AtprotoSession,
} from '../public/atproto'
import {
  buildRecipeRecord,
  canonicalRecipeHash,
  dataUrlToBytes,
  ensurePubkeyBinding,
  getPublication,
  publishRecipe,
  pubkeyBindingMessage,
  pubkeyRkeyForDeviceDid,
  recipeSignatureMessage,
  signRecipeRecord,
  unpublishRecipe,
  type PublishableRecipe,
} from '../public/publish'
import { publicRecordToInput, searchAppView } from '../public/discover'
import { cidForBytes } from '../public/blobCid'
import {
  identityFromSeed,
  publicKeyFromDid,
  verifyDetached,
} from '../identity/identity'
import { base64ToU8, u8ToBase64, utf8ToU8 } from '../identity/codec'
import { memoryStore } from '../store/recipes'

const PDS = 'http://localhost:2583'
const ACCT = 'did:plc:accttest'
const SEED = new Uint8Array(32).fill(9)

// ---------------------------------------------------------------------------
// Fake PDS over fetch
// ---------------------------------------------------------------------------

interface FakeCall {
  path: string
  body: Record<string, unknown>
}

function makeFakePds(opts: { expireAccess1?: boolean } = {}) {
  const records = new Map<string, { record: Record<string, unknown>; cid: string }>()
  const blobs = new Map<string, { bytes: Uint8Array; mime: string }>()
  const calls: FakeCall[] = []
  let recN = 0

  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  const key = (repo: string, collection: string, rkey: string) =>
    `${repo}/${collection}/${rkey}`

  const fetchFn = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url)
    const path = u.pathname.replace(/^\/xrpc\//, '')
    const headers = (init.headers ?? {}) as Record<string, string>
    const auth = headers.Authorization ?? ''
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {}

    switch (path) {
      case 'com.atproto.server.createSession':
        calls.push({ path, body })
        return json({
          did: ACCT,
          handle: body.identifier,
          accessJwt: 'access-1',
          refreshJwt: 'refresh-1',
        })
      case 'com.atproto.server.refreshSession': {
        calls.push({ path, body })
        if (auth !== 'Bearer refresh-1') return json({ error: 'InvalidToken' }, 401)
        return json({
          did: ACCT,
          handle: 'alice.test',
          accessJwt: 'access-2',
          refreshJwt: 'refresh-2',
        })
      }
      case 'com.atproto.repo.putRecord': {
        calls.push({ path, body })
        if (opts.expireAccess1 && auth === 'Bearer access-1') {
          return json({ error: 'ExpiredToken', message: 'token expired' }, 401)
        }
        if (auth !== 'Bearer access-1' && auth !== 'Bearer access-2') {
          return json({ error: 'InvalidToken' }, 401)
        }
        const cid = `bafyrec${++recN}`
        records.set(key(body.repo as string, body.collection as string, body.rkey as string), {
          record: body.record as Record<string, unknown>,
          cid,
        })
        return json({
          uri: `at://${body.repo as string}/${body.collection as string}/${body.rkey as string}`,
          cid,
        })
      }
      case 'com.atproto.repo.deleteRecord': {
        calls.push({ path, body })
        if (auth !== 'Bearer access-1' && auth !== 'Bearer access-2') {
          return json({ error: 'InvalidToken' }, 401)
        }
        records.delete(
          key(body.repo as string, body.collection as string, body.rkey as string),
        )
        return json({})
      }
      case 'com.atproto.repo.getRecord': {
        const repo = u.searchParams.get('repo')!
        const collection = u.searchParams.get('collection')!
        const rkey = u.searchParams.get('rkey')!
        const hit = records.get(key(repo, collection, rkey))
        if (!hit) return json({ error: 'RecordNotFound', message: 'Record not found' }, 400)
        return json({ uri: `at://${repo}/${collection}/${rkey}`, cid: hit.cid, value: hit.record })
      }
      case 'com.atproto.repo.uploadBlob': {
        calls.push({ path, body: {} })
        if (auth !== 'Bearer access-1' && auth !== 'Bearer access-2') {
          return json({ error: 'InvalidToken' }, 401)
        }
        const bytes = init.body as Uint8Array
        const mime = headers['Content-Type'] ?? 'application/octet-stream'
        // A real PDS names the stored bytes by their content hash —
        // the publish path verifies the returned CID against the
        // uploaded bytes (M2(int)), so the fake must return a real
        // CID too, not a placeholder.
        const cid = await cidForBytes(new Uint8Array(bytes))
        blobs.set(cid, { bytes: new Uint8Array(bytes), mime })
        return json({
          blob: { $type: 'blob', ref: { $link: cid }, mimeType: mime, size: bytes.length },
        })
      }
      default:
        return json({ error: 'Unknown', message: `no fake endpoint: ${path}` }, 404)
    }
  }

  return { fetchFn, records, blobs, calls, key }
}

async function makeSession(client: AtprotoClient): Promise<AtprotoSession> {
  return client.createSession('alice.test', 'app-password-1')
}

const PHOTO_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 250])
const PHOTO_URL = `data:image/png;base64,${u8ToBase64(PHOTO_BYTES)}`

function fixtureRecipe(): PublishableRecipe {
  return {
    id: 'recipe-1',
    title: 'Tomato Soup',
    ingredients: ['tomatoes', 'salt'],
    steps: ['Chop', 'Simmer'],
    photos: [PHOTO_URL],
    prepMinutes: 5,
    cookMinutes: 25,
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-02T10:00:00.000Z',
  }
}

// ---------------------------------------------------------------------------
// Session + client
// ---------------------------------------------------------------------------

describe('atproto session', () => {
  it('createSession maps the XRPC response onto the stored session shape', async () => {
    const fake = makeFakePds()
    const client = new AtprotoClient(PDS, { fetchFn: fake.fetchFn })
    const session = await makeSession(client)
    expect(session).toEqual({
      did: ACCT,
      handle: 'alice.test',
      pdsUrl: PDS,
      accessJwt: 'access-1',
      refreshJwt: 'refresh-1',
    })
    expect(fake.calls[0].path).toBe('com.atproto.server.createSession')
    expect(fake.calls[0].body).toEqual({
      identifier: 'alice.test',
      password: 'app-password-1',
    })

    const kv = memoryStore()
    saveSession(session, kv)
    expect(loadSession(kv)).toEqual(session)
  })

  it('refreshes once on ExpiredToken and retries with the new token', async () => {
    const fake = makeFakePds({ expireAccess1: true })
    const client = new AtprotoClient(PDS, { fetchFn: fake.fetchFn })
    const session = await makeSession(client)
    const out = await client.putRecord(session, {
      repo: ACCT,
      collection: 'kitchen.longtable.recipe',
      rkey: 'r1',
      record: { $type: 'kitchen.longtable.recipe', name: 'x' },
    })
    expect(out.uri).toBe(`at://${ACCT}/kitchen.longtable.recipe/r1`)
    expect(session.accessJwt).toBe('access-2')
    expect(session.refreshJwt).toBe('refresh-2')
    expect(
      fake.calls.filter((c) => c.path === 'com.atproto.server.refreshSession'),
    ).toHaveLength(1)
    expect(
      fake.calls.filter((c) => c.path === 'com.atproto.repo.putRecord'),
    ).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Record building + signatures
// ---------------------------------------------------------------------------

describe('buildRecipeRecord', () => {
  it('maps local fields to the lexicon shape', () => {
    const recipe = fixtureRecipe()
    const rec = buildRecipeRecord(recipe, ACCT, ['bafyimg1'])
    expect(rec.$type).toBe('kitchen.longtable.recipe')
    expect(rec.name).toBe('Tomato Soup')
    expect(rec.ingredients).toEqual(['tomatoes', 'salt'])
    expect(rec.instructions).toEqual(['Chop', 'Simmer'])
    expect(rec.prepTimeMinutes).toBe(5)
    expect(rec.cookTimeMinutes).toBe(25)
    expect(rec.createdAt).toBe(recipe.createdAt)
    expect(rec.updatedAt).toBe(recipe.updatedAt)
    expect(rec.longtableId).toBe('recipe-1')
    expect(rec.images).toHaveLength(1)
    expect(rec.images![0].ref.$link).toBe('bafyimg1')
    // Unsigned + no local-only fields leak in.
    expect(rec.deviceSignature).toBeUndefined()
    expect(rec.deviceDid).toBeUndefined()
    expect(rec).not.toHaveProperty('recipeYield')
    expect(rec).not.toHaveProperty('tags')
    expect(rec).not.toHaveProperty('description')
    expect(rec).not.toHaveProperty('photos')
    expect(rec).not.toHaveProperty('title')
  })

  it('is pure: returned arrays are copies', () => {
    const recipe = fixtureRecipe()
    const rec = buildRecipeRecord(recipe, ACCT, [])
    rec.ingredients.push('MUTATED')
    expect(recipe.ingredients).toEqual(['tomatoes', 'salt'])
    expect(rec.images).toBeUndefined()
  })
})

describe('device signatures', () => {
  it('canonical hash matches an independent recomputation', async () => {
    await sodium.ready
    const rec = buildRecipeRecord(fixtureRecipe(), ACCT, ['bafyimg1', 'bafyimg2'])
    const canonical = JSON.stringify([
      'Tomato Soup',
      '',
      ['tomatoes', 'salt'],
      ['Chop', 'Simmer'],
      5,
      25,
      '',
      [],
      ['bafyimg1', 'bafyimg2'],
    ])
    const expected = sodium.to_hex(
      sodium.crypto_generichash(32, sodium.from_string(canonical), null),
    )
    expect(await canonicalRecipeHash(rec)).toBe(expected)
    expect(
      await canonicalRecipeHash(rec, ['bafyimg1', 'bafyimg2']),
    ).toBe(expected)
  })

  it('signRecipeRecord verifies against the device DID with the exact payload', async () => {
    await sodium.ready
    const identity = await identityFromSeed(SEED)
    const rec = buildRecipeRecord(fixtureRecipe(), ACCT, ['bafyimg1'])
    const sigB64 = await signRecipeRecord(identity, ACCT, rec)
    const hashHex = await canonicalRecipeHash(rec)
    const msg = utf8ToU8(recipeSignatureMessage(ACCT, 'recipe-1', hashHex))
    expect(msg).toEqual(
      utf8ToU8(`longtable-recipe:v1\n${ACCT}\nrecipe-1\n${hashHex}`),
    )
    const sig = base64ToU8(sigB64)
    expect(await verifyDetached(identity.did, msg, sig)).toBe(true)
    // Also verify directly from the DID-decoded public key.
    expect(
      sodium.crypto_sign_verify_detached(sig, msg, publicKeyFromDid(identity.did)),
    ).toBe(true)
    // A tampered account DID or recipe id must fail.
    const wrong = utf8ToU8(`longtable-recipe:v1\ndid:plc:other\nrecipe-1\n${hashHex}`)
    expect(await verifyDetached(identity.did, wrong, sig)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pubkey binding
// ---------------------------------------------------------------------------

describe('ensurePubkeyBinding', () => {
  it('writes the per-device rkey once, with a verifiable signature, and not again', async () => {
    await sodium.ready
    const fake = makeFakePds()
    const client = new AtprotoClient(PDS, { fetchFn: fake.fetchFn })
    const session = await makeSession(client)
    const identity = await identityFromSeed(SEED)
    const kv = memoryStore()

    expect(await ensurePubkeyBinding(client, session, identity, kv)).toBe(true)
    const putCalls = fake.calls.filter(
      (c) => c.path === 'com.atproto.repo.putRecord',
    )
    expect(putCalls).toHaveLength(1)
    expect(putCalls[0].body.repo).toBe(ACCT)
    expect(putCalls[0].body.collection).toBe('kitchen.longtable.pubkey')
    // Per-device rkey (H-N1), not the legacy single-slot 'self'.
    expect(putCalls[0].body.rkey).toBe(await pubkeyRkeyForDeviceDid(identity.did))
    expect(putCalls[0].body.rkey).toMatch(/^dev-[0-9a-f]{32}$/)

    const record = putCalls[0].body.record as Record<string, string>
    expect(record.$type).toBe('kitchen.longtable.pubkey')
    expect(record.deviceDid).toBe(identity.did)
    expect(record.devicePublicKey).toBe(u8ToBase64(identity.publicKey))
    expect(typeof record.createdAt).toBe('string')

    const msg = utf8ToU8(
      pubkeyBindingMessage(ACCT, identity.did, u8ToBase64(identity.publicKey)),
    )
    expect(
      await verifyDetached(identity.did, msg, base64ToU8(record.signature)),
    ).toBe(true)
    expect(
      sodium.crypto_sign_verify_detached(
        base64ToU8(record.signature),
        msg,
        publicKeyFromDid(identity.did),
      ),
    ).toBe(true)

    // Second ensure: record already binds this device — no rewrite.
    expect(await ensurePubkeyBinding(client, session, identity, kv)).toBe(false)
    expect(
      fake.calls.filter((c) => c.path === 'com.atproto.repo.putRecord'),
    ).toHaveLength(1)
  })

  it('a second device writes only its own per-device rkey and never touches the first device binding (H-N1)', async () => {
    await sodium.ready
    const fake = makeFakePds()
    const client = new AtprotoClient(PDS, { fetchFn: fake.fetchFn })
    const session = await makeSession(client)
    const deviceA = await identityFromSeed(SEED)
    const deviceB = await identityFromSeed(new Uint8Array(32).fill(11))
    const kv = memoryStore()

    // Device A binds first (per-device rkey, as the current client does).
    expect(await ensurePubkeyBinding(client, session, deviceA, kv)).toBe(true)
    const rkeyA = await pubkeyRkeyForDeviceDid(deviceA.did)
    // Plus a legacy 'self' binding for A, as an older client would have left.
    fake.records.set(fake.key(ACCT, 'kitchen.longtable.pubkey', 'self'), {
      record: {
        $type: 'kitchen.longtable.pubkey',
        deviceDid: deviceA.did,
        devicePublicKey: u8ToBase64(deviceA.publicKey),
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      cid: 'bafylegacy',
    })
    const selfBefore = fake.records.get(fake.key(ACCT, 'kitchen.longtable.pubkey', 'self'))

    // Device B binds: exactly one putRecord, at B's own per-device rkey.
    expect(await ensurePubkeyBinding(client, session, deviceB, kv)).toBe(true)
    const rkeyB = await pubkeyRkeyForDeviceDid(deviceB.did)
    expect(rkeyB).not.toBe(rkeyA)
    const putCalls = fake.calls.filter(
      (c) => c.path === 'com.atproto.repo.putRecord',
    )
    expect(putCalls).toHaveLength(2)
    expect(putCalls[1].body.rkey).toBe(rkeyB)
    expect(putCalls[1].body.collection).toBe('kitchen.longtable.pubkey')
    // Neither A's per-device binding nor the legacy 'self' record moved.
    expect(fake.records.get(fake.key(ACCT, 'kitchen.longtable.pubkey', rkeyA))).toBeDefined()
    expect(fake.records.get(fake.key(ACCT, 'kitchen.longtable.pubkey', 'self'))).toBe(selfBefore)
    // B's binding verifies as B's.
    const recordB = putCalls[1].body.record as Record<string, string>
    expect(recordB.deviceDid).toBe(deviceB.did)
    expect(
      await verifyDetached(
        deviceB.did,
        utf8ToU8(pubkeyBindingMessage(ACCT, deviceB.did, u8ToBase64(deviceB.publicKey))),
        base64ToU8(recordB.signature),
      ),
    ).toBe(true)
  })
})

describe('pubkeyRkeyForDeviceDid', () => {
  it('derives a deterministic dev-<hex> rkey and pins the cross-implementation vector', async () => {
    // BLAKE2b-256 of the deviceDid string, computed independently
    // (python hashlib.blake2b, digest_size=32) — the AppView pins the
    // same vector, so the two halves agree on every binding's address.
    expect(
      await pubkeyRkeyForDeviceDid(
        'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      ),
    ).toBe('dev-af0042b31ec6679cc02818a49bf60f70')
    const identity = await identityFromSeed(SEED)
    const rkey = await pubkeyRkeyForDeviceDid(identity.did)
    expect(rkey).toMatch(/^dev-[0-9a-f]{32}$/)
    expect(await pubkeyRkeyForDeviceDid(identity.did)).toBe(rkey)
    const other = await identityFromSeed(new Uint8Array(32).fill(12))
    expect(await pubkeyRkeyForDeviceDid(other.did)).not.toBe(rkey)
  })
})

// ---------------------------------------------------------------------------
// Publish / unpublish lifecycle
// ---------------------------------------------------------------------------

describe('publish → unpublish', () => {
  it('uploads blobs, puts a lexicon-shaped signed record, and tracks the registry', async () => {
    const fake = makeFakePds()
    const client = new AtprotoClient(PDS, { fetchFn: fake.fetchFn })
    const session = await makeSession(client)
    const identity = await identityFromSeed(SEED)
    const kv = memoryStore()
    const recipe = fixtureRecipe()

    const uri = await publishRecipe(client, session, identity, recipe, kv)
    expect(uri).toBe(`at://${ACCT}/kitchen.longtable.recipe/recipe-1`)

    // Registry lifecycle: present after publish.
    const pub = getPublication('recipe-1', kv)
    expect(pub).not.toBeNull()
    expect(pub!.did).toBe(ACCT)
    expect(pub!.uri).toBe(uri)
    expect(pub!.rkey).toBe('recipe-1')
    expect(pub!.pdsUrl).toBe(PDS)
    expect(pub!.cid).toBeTruthy()

    // The blob was uploaded with the photo bytes + mime.
    expect(fake.blobs.size).toBe(1)
    const [blobCid, blob] = [...fake.blobs.entries()][0]
    expect(blob.bytes).toEqual(PHOTO_BYTES)
    expect(blob.mime).toBe('image/png')

    // The stored record is lexicon-shaped and device-signed.
    const stored = fake.records.get(
      fake.key(ACCT, 'kitchen.longtable.recipe', 'recipe-1'),
    )!
    const rec = stored.record as Record<string, unknown>
    expect(rec.$type).toBe('kitchen.longtable.recipe')
    expect(rec.name).toBe('Tomato Soup')
    expect(rec.longtableId).toBe('recipe-1')
    expect(rec.deviceDid).toBe(identity.did)
    const images = rec.images as Array<{ ref: { $link: string } }>
    expect(images[0].ref.$link).toBe(blobCid)

    const hashHex = await canonicalRecipeHash(
      buildRecipeRecord(recipe, ACCT, [blobCid]),
    )
    const msg = utf8ToU8(recipeSignatureMessage(ACCT, 'recipe-1', hashHex))
    expect(
      await verifyDetached(
        identity.did,
        msg,
        base64ToU8(rec.deviceSignature as string),
      ),
    ).toBe(true)

    // Unpublish: deleteRecord with the right repo/collection/rkey + registry drop.
    await unpublishRecipe(client, session, 'recipe-1', kv)
    const del = fake.calls.find((c) => c.path === 'com.atproto.repo.deleteRecord')!
    expect(del.body).toEqual({
      repo: ACCT,
      collection: 'kitchen.longtable.recipe',
      rkey: 'recipe-1',
    })
    expect(
      fake.records.has(fake.key(ACCT, 'kitchen.longtable.recipe', 'recipe-1')),
    ).toBe(false)
    expect(getPublication('recipe-1', kv)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Helpers + discovery conversion
// ---------------------------------------------------------------------------

describe('dataUrlToBytes', () => {
  it('round-trips base64 data URLs', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 250, 255])
    const { bytes: out, mime } = dataUrlToBytes(
      `data:image/jpeg;base64,${u8ToBase64(bytes)}`,
    )
    expect(out).toEqual(bytes)
    expect(mime).toBe('image/jpeg')
  })

  it('decodes plain (URL-escaped) data URLs', () => {
    const { bytes, mime } = dataUrlToBytes('data:text/plain,hello%20world')
    expect(new TextDecoder().decode(bytes)).toBe('hello world')
    expect(mime).toBe('text/plain')
  })

  it('rejects non-data URLs', () => {
    expect(() => dataUrlToBytes('https://example.com/x.png')).toThrow()
  })
})

describe('discovery conversion', () => {
  it('searchAppView normalizes AppView results', async () => {
    const fetchFn = async (url: string) => {
      expect(url).toContain('/search?')
      expect(url).toContain('q=soup')
      return new Response(
        JSON.stringify({
          results: [
            {
              did: ACCT,
              rkey: 'recipe-1',
              record: { name: 'Tomato Soup', ingredients: ['tomatoes'] },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const results = await searchAppView('http://localhost:3210', { q: 'soup' }, fetchFn)
    expect(results).toEqual([
      {
        did: ACCT,
        rkey: 'recipe-1',
        uri: undefined,
        cid: undefined,
        title: 'Tomato Soup',
        ingredients: ['tomatoes'],
        description: undefined,
      },
    ])
  })

  it('publicRecordToInput maps fields and resolves photo blobs', async () => {
    const rec = buildRecipeRecord(fixtureRecipe(), ACCT, [
      {
        $type: 'blob',
        ref: { $link: 'bafyimg1' },
        mimeType: 'image/png',
        size: 8,
      },
    ])
    const input = await publicRecordToInput(
      { ...rec, did: ACCT, rkey: 'recipe-1' },
      async (cid, blob) => `data:${blob.mimeType};base64,${cid}`,
    )
    expect(input.title).toBe('Tomato Soup')
    expect(input.ingredients).toEqual(['tomatoes', 'salt'])
    expect(input.steps).toEqual(['Chop', 'Simmer'])
    expect(input.prepMinutes).toBe(5)
    expect(input.cookMinutes).toBe(25)
    expect(input.photos).toEqual(['data:image/png;base64,bafyimg1'])
  })
})
