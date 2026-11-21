/**
 * Wave 5B trust/verify/publish Lows (2026-11-21 review round).
 *
 * Covers, per finding:
 * - L-N1: upsertReceived staleness is a timestamp ORDER, not equality
 *   — an older share never overwrites a newer local copy; a
 *   same-timestamp re-edit still lands via the content hash.
 * - L-N2: refreshSession rejects a PDS response naming a different
 *   DID, without mutating the session.
 * - L-N4: a served record whose image ref is not a {$link} blob
 *   reference fails client verification as 'signature-invalid', never
 *   as a raw throw.
 * - Sec L11: the v2 device signature (bound to createdAt) verifies;
 *   a legacy v1 signature still verifies; a v2 signature does NOT
 *   verify a record transplanted to a different createdAt.
 * - Int L14: a friends-only → public flip flags the live friends
 *   shares in the returned warnings, and does not flag when none
 *   are live.
 *
 * No network: friends shares are published into a Y.Doc and imported
 * from it directly; the publish flow uses a stubbed global fetch.
 */
import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { identityFromSeed, signDetached, type Identity } from '../identity/identity'
import { u8ToBase64, utf8ToU8 } from '../identity/codec'
import {
  AtprotoClient,
  saveSession,
  type AtprotoBlob,
  type AtprotoSession,
} from '../public/atproto'
import {
  buildRecipeRecord,
  canonicalRecipeHash,
  legacyRecipeSignatureMessage,
  signRecipeRecord,
  type PublishableRecipe,
} from '../public/publish'
import {
  RecipeVerificationError,
  verifyPublicRecipe,
  type PublicRecipe,
} from '../public/discover'
import {
  ensureRecipeKey,
  publishShare,
  setKeyFriends,
} from '../friends/shelf'
import {
  importChannelDoc,
  listReceivedShares,
  loadReceivedMap,
  saveReceivedMap,
} from '../friends/service'
import { applyVisibilityFlow, FRIENDS_SHARES_LIVE_NOTICE } from '../recipeFlows'
import { createRepo, getRepo } from '../store/repo'
import {
  createRecipe,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  memoryStore,
} from '../store/recipes'
import type { Recipe } from '../types'

const seed = (n: number) => new Uint8Array(32).fill(n)

function mkLocalStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage
}

let dbCounter = 0
const makeRepo = () => createRepo(`longtable-wave5b-${++dbCounter}`)

/** A real blob object (Int L4): buildRecipeRecord no longer fabricates one. */
function blob(cid: string): AtprotoBlob {
  return { $type: 'blob', ref: { $link: cid }, mimeType: 'image/png', size: 8 }
}

beforeEach(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = mkLocalStorage()
})

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage
})

describe('L-N1 upsertReceived staleness', () => {
  const RECIPE: Recipe = {
    title: 'Secret Soup',
    ingredients: ['1 onion', '2 cloves garlic'],
    steps: ['Chop.', 'Simmer 20 minutes.'],
    prepMinutes: 5,
    cookMinutes: 20,
    photos: [],
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    visibility: 'friends-only',
  }

  it('an older share never overwrites a newer copy; a same-time re-edit lands', async () => {
    const owner = await identityFromSeed(seed(11))
    const receiver = await identityFromSeed(seed(55))
    const kvOwner = memoryStore()
    const kvRecv = memoryStore()
    const repoRecv = makeRepo()
    const ownerDoc = new Y.Doc()
    const keyRec = await ensureRecipeKey('recipe-ln1', kvOwner)
    const index = await getOrCreateIndex(repoRecv)

    const titleOf = async (localId: string): Promise<string | undefined> => {
      const summaries = await listRecipes(index)
      const loaded = await getRecipe(
        repoRecv,
        summaries.find((s) => s.id === localId)!.url,
      )
      return loaded?.title
    }
    const importNow = async () => {
      const mapping = loadReceivedMap(kvRecv)
      await importChannelDoc(
        ownerDoc,
        receiver,
        index,
        mapping,
        repoRecv,
        undefined,
        kvRecv,
        owner.did,
      )
      saveReceivedMap(kvRecv, mapping)
    }

    // Newer version first: lands.
    await publishShare(
      ownerDoc,
      owner,
      'Olga',
      { ...RECIPE, title: 'New Soup', updatedAt: '2026-10-12T00:00:00.000Z' },
      'recipe-ln1',
      keyRec,
      receiver.did,
    )
    await importNow()
    const listed = await listReceivedShares(kvRecv, repoRecv)
    expect(listed).toHaveLength(1)
    const localId = listed[0].localId
    expect(await titleOf(localId)).toBe('New Soup')

    // Older version (owner clock skew / restore from backup): must NOT
    // overwrite the newer local copy.
    await publishShare(
      ownerDoc,
      owner,
      'Olga',
      { ...RECIPE, title: 'Old Soup', updatedAt: '2026-10-11T00:00:00.000Z' },
      'recipe-ln1',
      keyRec,
      receiver.did,
    )
    await importNow()
    expect(await titleOf(localId)).toBe('New Soup')

    // Same timestamp, changed content: the same-millisecond re-edit
    // lands via the content-hash fallback.
    await publishShare(
      ownerDoc,
      owner,
      'Olga',
      { ...RECIPE, title: 'Same-Time Soup', updatedAt: '2026-10-12T00:00:00.000Z' },
      'recipe-ln1',
      keyRec,
      receiver.did,
    )
    await importNow()
    expect(await titleOf(localId)).toBe('Same-Time Soup')

    // Same timestamp, identical content: already current, no rewrite.
    await publishShare(
      ownerDoc,
      owner,
      'Olga',
      { ...RECIPE, title: 'Same-Time Soup', updatedAt: '2026-10-12T00:00:00.000Z' },
      'recipe-ln1',
      keyRec,
      receiver.did,
    )
    await importNow()
    expect(await titleOf(localId)).toBe('Same-Time Soup')
  })
})

describe('L-N2 refreshSession DID adoption', () => {
  const PDS = 'http://localhost:2583'
  const ACCT = 'did:plc:accttest'

  function fakeClient(didInResponse: string | undefined): AtprotoClient {
    const fetchFn = async (url: string): Promise<Response> => {
      const u = new URL(url)
      if (u.pathname.endsWith('com.atproto.server.refreshSession')) {
        return new Response(
          JSON.stringify({
            ...(didInResponse ? { did: didInResponse } : {}),
            handle: 'alice.test',
            accessJwt: 'access-2',
            refreshJwt: 'refresh-2',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ error: 'Unknown' }), { status: 404 })
    }
    return new AtprotoClient(PDS, { fetchFn })
  }

  const session = (): AtprotoSession => ({
    did: ACCT,
    handle: 'alice.test',
    pdsUrl: PDS,
    accessJwt: 'access-1',
    refreshJwt: 'refresh-1',
  })

  it('rejects a refresh naming a different DID, without mutating the session', async () => {
    const s = session()
    await expect(
      fakeClient('did:plc:someone-else').refreshSession(s),
    ).rejects.toThrow(/different account/)
    expect(s.did).toBe(ACCT)
    expect(s.accessJwt).toBe('access-1')
    expect(s.refreshJwt).toBe('refresh-1')
  })

  it('accepts a refresh naming the same DID, and one naming no DID', async () => {
    const same = session()
    await fakeClient(ACCT).refreshSession(same)
    expect(same.did).toBe(ACCT)
    expect(same.accessJwt).toBe('access-2')
    expect(same.refreshJwt).toBe('refresh-2')

    const none = session()
    await fakeClient(undefined).refreshSession(none)
    expect(none.did).toBe(ACCT)
    expect(none.accessJwt).toBe('access-2')
  })
})

describe('L-N4 + Sec L11 client verification', () => {
  const ACCT = 'did:plc:accttest'
  const SEED = new Uint8Array(32).fill(7)

  function fixtureRecipe(): PublishableRecipe {
    return {
      id: 'recipe-1',
      title: 'Tomato Soup',
      ingredients: ['tomatoes', 'salt'],
      steps: ['Chop', 'Simmer'],
      photos: [],
      prepMinutes: 5,
      cookMinutes: 25,
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-02T10:00:00.000Z',
    }
  }

  /** A valid served record, signed by `identity` over the canonical hash. */
  async function signedServedRecord(identity: Identity): Promise<PublicRecipe> {
    const unsigned = buildRecipeRecord(fixtureRecipe(), ACCT, [blob('bafyimg1')])
    const deviceSignature = await signRecipeRecord(identity, ACCT, unsigned)
    return {
      ...unsigned,
      uri: `at://${ACCT}/kitchen.longtable.recipe/recipe-1`,
      did: ACCT,
      rkey: 'recipe-1',
      deviceDid: identity.did,
      deviceSignature,
      deviceKey: u8ToBase64(identity.publicKey),
    }
  }

  /** The verification reason of a rejected promise, or 'no-throw'. */
  async function rejectionReason(p: Promise<unknown>): Promise<string> {
    try {
      await p
      return 'no-throw'
    } catch (e) {
      return e instanceof RecipeVerificationError
        ? e.reason
        : `other:${e instanceof Error ? e.message : String(e)}`
    }
  }

  it('a v2-signed record verifies', async () => {
    const identity = await identityFromSeed(SEED)
    const rec = await signedServedRecord(identity)
    await verifyPublicRecipe(rec, ACCT)
  })

  it('a legacy v1 signature still verifies', async () => {
    const identity = await identityFromSeed(SEED)
    const unsigned = buildRecipeRecord(fixtureRecipe(), ACCT, [blob('bafyimg1')])
    const hashHex = await canonicalRecipeHash(unsigned)
    const v1Sig = await signDetached(
      identity,
      utf8ToU8(legacyRecipeSignatureMessage(ACCT, 'recipe-1', hashHex)),
    )
    const rec: PublicRecipe = {
      ...unsigned,
      uri: `at://${ACCT}/kitchen.longtable.recipe/recipe-1`,
      did: ACCT,
      rkey: 'recipe-1',
      deviceDid: identity.did,
      deviceSignature: u8ToBase64(v1Sig),
      deviceKey: u8ToBase64(identity.publicKey),
    }
    await verifyPublicRecipe(rec, ACCT)
  })

  it('a v2 signature does not verify a record transplanted to another createdAt', async () => {
    const identity = await identityFromSeed(SEED)
    const rec = await signedServedRecord(identity)
    const moved: PublicRecipe = { ...rec, createdAt: '2099-01-01T00:00:00.000Z' }
    expect(await rejectionReason(verifyPublicRecipe(moved, ACCT))).toBe(
      'signature-invalid',
    )
  })

  it('a non-{$link} image ref fails as signature-invalid, never as a raw throw (L-N4)', async () => {
    const identity = await identityFromSeed(SEED)
    const rec = await signedServedRecord(identity)
    // A bare-string ref: the signer never emits this shape, so the
    // record has no well-defined hash — it must fail verification,
    // not crash the verifier.
    const malformed = {
      ...rec,
      images: [{ ref: 'bafyimg1' }],
    } as unknown as PublicRecipe
    expect(await rejectionReason(verifyPublicRecipe(malformed, ACCT))).toBe(
      'signature-invalid',
    )
  })
})

describe('Int L14 friends-only → public flag', () => {
  const PDS = 'http://localhost:2583'
  const ACCT = 'did:plc:accttest'

  /** Minimal fake PDS on the global fetch (applyVisibilityFlow builds its own client). */
  function installFakePds(): () => void {
    const origFetch = globalThis.fetch
    const fetchFn = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const u = new URL(String(url))
      const path = u.pathname.replace(/^\/xrpc\//, '')
      const json = (obj: unknown, status = 200) =>
        new Response(JSON.stringify(obj), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      if (path === 'com.atproto.repo.getRecord') {
        // No binding yet — ensurePubkeyBinding writes one.
        return json({ error: 'RecordNotFound', message: 'Record not found' }, 400)
      }
      if (path === 'com.atproto.repo.putRecord') {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
        return json({
          uri: `at://${body.repo as string}/${body.collection as string}/${body.rkey as string}`,
          cid: 'bafyfake',
        })
      }
      return json({ error: 'Unknown', message: `no fake endpoint: ${path}` }, 404)
    }
    globalThis.fetch = fetchFn as typeof fetch
    return () => {
      globalThis.fetch = origFetch
    }
  }

  async function friendsOnlyRecipe(): Promise<{ id: string; url: string; recipe: Recipe }> {
    const repo = getRepo()
    const index = await getOrCreateIndex(repo)
    const summary = await createRecipe(repo, index, {
      title: 'Shared Soup',
      ingredients: ['1 onion'],
      steps: ['Chop.'],
      photos: [],
      prepMinutes: 5,
      cookMinutes: 20,
      visibility: 'friends-only',
    })
    const recipe = await getRecipe(repo, summary.url)
    expect(recipe).not.toBeNull()
    return { id: summary.id, url: summary.url, recipe: recipe! }
  }

  it('flags live friends shares in the warnings when a friends-only recipe goes public', async () => {
    const restore = installFakePds()
    try {
      const identity = await identityFromSeed(seed(31))
      const friend = await identityFromSeed(seed(32))
      const kv = memoryStore()
      const { id, url, recipe } = await friendsOnlyRecipe()
      await ensureRecipeKey(id, kv)
      setKeyFriends(id, [friend.did], kv)
      saveSession({
        did: ACCT,
        handle: 'alice.test',
        pdsUrl: PDS,
        accessJwt: 'access-1',
        refreshJwt: 'refresh-1',
      })
      const warnings = await applyVisibilityFlow(id, recipe, 'public', {
        identity,
        kv,
      })
      expect(warnings).toContain(FRIENDS_SHARES_LIVE_NOTICE)
      // And the tier actually flipped.
      const after = await getRecipe(getRepo(), url)
      expect(after!.visibility).toBe('public')
    } finally {
      restore()
    }
  })

  it('does not flag when no friends shares are live', async () => {
    const restore = installFakePds()
    try {
      const identity = await identityFromSeed(seed(31))
      const kv = memoryStore()
      const { id, recipe } = await friendsOnlyRecipe()
      saveSession({
        did: ACCT,
        handle: 'alice.test',
        pdsUrl: PDS,
        accessJwt: 'access-1',
        refreshJwt: 'refresh-1',
      })
      const warnings = await applyVisibilityFlow(id, recipe, 'public', {
        identity,
        kv,
      })
      expect(warnings).not.toContain(FRIENDS_SHARES_LIVE_NOTICE)
    } finally {
      restore()
    }
  })
})
