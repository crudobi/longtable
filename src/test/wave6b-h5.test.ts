/**
 * Wave 6B (H5): signed-out unpublish/delete honesty.
 *
 * A public→private or public→friends-only flip — or a delete — on a
 * recipe with a live public record while no publishing account is
 * signed in is REFUSED (PublicCopyLiveError) before any mutation:
 * the tier stays public, the local copy stays, friends shares and the
 * P2P room are untouched, and the message names the public copy still
 * listed. Signed in, the same calls unpublish first and then land.
 * The localhost API inherits the refusal through the same flows
 * (host maps it to 422 with the recipe as it stands).
 *
 * y-webrtc is mocked with a syncing fake (copied from wave4b): the
 * flows call leaveShare, which needs a channel doc without a network.
 */
import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  Y: null as typeof import('yjs') | null,
  rooms: new Map<string, Set<unknown>>(),
}))
mockState.Y = Y

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class {
    awareness = { getStates: () => new Map() }
    private room: string
    private doc: unknown
    private listener: ((update: Uint8Array) => void) | null = null
    constructor(room: string, doc: unknown) {
      this.room = room
      this.doc = doc
      const Y = mockState.Y
      if (!Y) throw new Error('y-webrtc mock used before Y was set')
      const thisDoc = doc as InstanceType<typeof Y.Doc>
      let peers = mockState.rooms.get(room)
      if (!peers) {
        peers = new Set()
        mockState.rooms.set(room, peers)
      }
      for (const other of peers) {
        const otherDoc = other as InstanceType<typeof Y.Doc>
        Y.applyUpdate(otherDoc, Y.encodeStateAsUpdate(thisDoc))
        Y.applyUpdate(thisDoc, Y.encodeStateAsUpdate(otherDoc))
      }
      peers.add(doc)
      this.listener = (update: Uint8Array) => {
        for (const other of [...(mockState.rooms.get(room) ?? [])]) {
          if (other === doc) continue
          Y.applyUpdate(other as InstanceType<typeof Y.Doc>, update)
        }
      }
      thisDoc.on('update', this.listener)
    }
    destroy() {
      if (this.listener) {
        ;(this.doc as InstanceType<typeof Y.Doc>).off('update', this.listener)
        this.listener = null
      }
      mockState.rooms.get(this.room)?.delete(this.doc)
    }
  },
}))

import { identityFromSeed } from '../identity/identity'
import { getRepo } from '../store/repo'
import {
  createRecipe,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  memoryStore,
} from '../store/recipes'
import {
  clearSession,
  loadSession,
  PUBLICATIONS_KEY,
  saveSession,
} from '../public/atproto'
import { getPublication } from '../public/publish'
import {
  applyVisibilityFlow,
  performDeleteFlow,
  PublicCopyLiveError,
} from '../recipeFlows'
import { createLocalApiHost, LocalApiError } from '../localapi/host'
import {
  resetSecretStoreForTests,
  type LocalStore,
  type SecretBackend,
} from '../secrets/secretStore'
import type { Recipe } from '../types'

/** Minimal fake Keystore backend (copied from secrets.test.ts). */
class FakeBackend implements SecretBackend {
  map = new Map<string, string>()
  available = true
  async isAvailable(): Promise<boolean> {
    return this.available
  }
  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()]
  }
}

const PDS = 'http://localhost:2583'
const ACCT = 'did:plc:accttest'
const seed = (n: number) => new Uint8Array(32).fill(n)

/** The flows read bare `localStorage` (node test env has none). */
function mkLocalStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(seed))
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage
}

beforeEach(() => {
  const stub = mkLocalStorage()
  ;(globalThis as { localStorage?: Storage }).localStorage = stub
  // Point secretKv at the same stub: in production the publications
  // key is non-secret, so secretKv and bare localStorage are one
  // store — but the module singleton binds its local store at import,
  // before the stub exists, so without this reset unpublishRecipe
  // (secretKv) and getPublication (bare localStorage) read different
  // registries and the drop is unobservable.
  resetSecretStoreForTests(new FakeBackend(), stub as unknown as LocalStore)
  clearSession()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { localStorage?: Storage }).localStorage
})

/**
 * Stage a live public record in the registry both readers use
 * (publicationOf via bare localStorage, unpublishRecipe via secretKv —
 * the publications key is non-secret, so both route to localStorage).
 */
function stagePublication(id: string): void {
  ;(globalThis as { localStorage: Storage }).localStorage.setItem(
    PUBLICATIONS_KEY,
    JSON.stringify({
      [id]: {
        did: ACCT,
        uri: `at://${ACCT}/kitchen.longtable.recipe/${id}`,
        rkey: id,
        cid: 'bafyrec1',
        pdsUrl: PDS,
        updatedAt: '2026-01-01T10:00:00.000Z',
      },
    }),
  )
}

function signIn(): void {
  saveSession({
    did: ACCT,
    handle: 'alice.test',
    pdsUrl: PDS,
    accessJwt: 'access-1',
    refreshJwt: 'refresh-1',
  })
}

/** Minimal fake PDS on the global fetch (the flows build their own client). */
function installFakePds(): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const origFetch = globalThis.fetch
  const fetchFn = async (url: string): Promise<Response> => {
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/xrpc\//, '')
    calls.push(path)
    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    if (path === 'com.atproto.repo.deleteRecord') return json({})
    if (path === 'com.atproto.repo.getRecord') {
      return json({ error: 'RecordNotFound', message: 'Record not found' }, 400)
    }
    if (path === 'com.atproto.server.getSession') {
      return json({ did: ACCT, handle: 'alice.test' })
    }
    return json({ error: 'Unknown', message: `no fake endpoint: ${path}` }, 404)
  }
  globalThis.fetch = fetchFn as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = origFetch) }
}

async function publicRecipe(): Promise<{ id: string; url: string; recipe: Recipe }> {
  const repo = getRepo()
  const index = await getOrCreateIndex(repo, memoryStore())
  const summary = await createRecipe(repo, index, {
    title: 'Public Soup',
    ingredients: ['1 onion'],
    steps: ['Simmer.'],
    photos: [],
    visibility: 'public',
  })
  const recipe = await getRecipe(repo, summary.url)
  expect(recipe).not.toBeNull()
  return { id: summary.id, url: summary.url, recipe: recipe! }
}

async function refusalOf(fn: () => Promise<unknown>): Promise<Error> {
  let refusal: unknown
  try {
    await fn()
  } catch (e) {
    refusal = e
  }
  expect(refusal).toBeInstanceOf(PublicCopyLiveError)
  expect((refusal as Error).message).toMatch(/public copy is still listed/)
  return refusal as Error
}

describe('H5 signed-out refusal (flow level)', () => {
  it('public→private flip while signed out is refused, tier stays public', async () => {
    const { id, url, recipe } = await publicRecipe()
    stagePublication(id)
    expect(loadSession()).toBeNull()
    await refusalOf(() => applyVisibilityFlow(id, recipe, 'private', { identity: null }))
    const after = await getRecipe(getRepo(), url)
    expect(after?.visibility).toBe('public')
    expect(getPublication(id)).not.toBeNull()
  })

  it('public→friends-only flip while signed out is refused, tier stays public', async () => {
    const { id, url, recipe } = await publicRecipe()
    stagePublication(id)
    await refusalOf(() =>
      applyVisibilityFlow(id, recipe, 'friends-only', { identity: null }),
    )
    const after = await getRecipe(getRepo(), url)
    expect(after?.visibility).toBe('public')
    expect(getPublication(id)).not.toBeNull()
  })

  it('delete while signed out is refused, local copy and registry stay', async () => {
    const repo = getRepo()
    const index = await getOrCreateIndex(repo, memoryStore())
    const { id } = await publicRecipe()
    stagePublication(id)
    await refusalOf(() => performDeleteFlow(id, { identity: null }))
    expect((await listRecipes(index)).some((r) => r.id === id)).toBe(true)
    expect(getPublication(id)).not.toBeNull()
  })

  it('signed-out flip of a never-published recipe still works', async () => {
    const { id, url, recipe } = await publicRecipe()
    // No publication staged: nothing live to take down, no refusal.
    const warnings = await applyVisibilityFlow(id, recipe, 'private', {
      identity: null,
    })
    expect(warnings).toEqual([])
    const after = await getRecipe(getRepo(), url)
    expect(after?.visibility ?? 'private').toBe('private')
  })

  it('signed-out delete of a never-published recipe still works', async () => {
    const repo = getRepo()
    const index = await getOrCreateIndex(repo, memoryStore())
    const { id } = await publicRecipe()
    const warnings = await performDeleteFlow(id, { identity: null })
    expect(warnings).toEqual([])
    expect((await listRecipes(index)).some((r) => r.id === id)).toBe(false)
  })
})

describe('H5 signed-in end-to-end (flow level)', () => {
  it('signed-in public→private flip unpublishes, then changes the tier', async () => {
    const fake = installFakePds()
    try {
      const owner = await identityFromSeed(seed(31))
      const { id, url, recipe } = await publicRecipe()
      stagePublication(id)
      signIn()
      const warnings = await applyVisibilityFlow(id, recipe, 'private', {
        identity: owner,
      })
      expect(warnings).toEqual([])
      expect(fake.calls).toContain('com.atproto.repo.deleteRecord')
      const after = await getRecipe(getRepo(), url)
      expect(after?.visibility ?? 'private').toBe('private')
      expect(getPublication(id)).toBeNull()
    } finally {
      fake.restore()
    }
  })

  it('signed-in delete unpublishes and removes the local copy', async () => {
    const fake = installFakePds()
    try {
      const owner = await identityFromSeed(seed(31))
      const repo = getRepo()
      const index = await getOrCreateIndex(repo, memoryStore())
      const { id } = await publicRecipe()
      stagePublication(id)
      signIn()
      const warnings = await performDeleteFlow(id, { identity: owner })
      expect(warnings).toEqual([])
      expect(fake.calls).toContain('com.atproto.repo.deleteRecord')
      expect((await listRecipes(index)).some((r) => r.id === id)).toBe(false)
      expect(getPublication(id)).toBeNull()
    } finally {
      fake.restore()
    }
  })
})

describe('H5 localhost API inherits the refusal', () => {
  // The host with the real UI flows as hooks (no repo/kv seams, so it
  // shares the getRepo() singleton the tests create recipes in) — the
  // same wiring App uses, minus the App-level 422 mapping, so these
  // tests prove the host's own mapping.
  function flowHost(identity: Awaited<ReturnType<typeof identityFromSeed>> | null) {
    return createLocalApiHost({
      applyDelete: (id) => performDeleteFlow(id, { identity }),
      applyVisibility: (id, recipe, tier) =>
        applyVisibilityFlow(id, recipe, tier, { identity }),
      canPublish: () => loadSession() != null,
    })
  }

  it('signed-out setVisibility to private answers 422, tier stays public', async () => {
    const host = flowHost(null)
    const { id, url } = await publicRecipe()
    stagePublication(id)
    expect(loadSession()).toBeNull()
    let err: unknown
    try {
      await host.setVisibility(id, 'private')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LocalApiError)
    expect((err as LocalApiError).status).toBe(422)
    expect((err as LocalApiError).message).toMatch(/public copy is still listed/)
    const changed = (err as LocalApiError).details?.changed as
      | { visibility?: string; publicRecord?: string }
      | undefined
    expect(changed?.visibility).toBe('public')
    expect(changed?.publicRecord).toBe('listed')
    const after = await getRecipe(getRepo(), url)
    expect(after?.visibility).toBe('public')
  })

  it('signed-out deleteRecipe answers 422, local copy stays', async () => {
    const host = flowHost(null)
    const repo = getRepo()
    const index = await getOrCreateIndex(repo, memoryStore())
    const { id } = await publicRecipe()
    stagePublication(id)
    let err: unknown
    try {
      await host.deleteRecipe(id)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LocalApiError)
    expect((err as LocalApiError).status).toBe(422)
    expect((err as LocalApiError).message).toMatch(/public copy is still listed/)
    expect((await listRecipes(index)).some((r) => r.id === id)).toBe(true)
    expect(getPublication(id)).not.toBeNull()
  })

  it('signed-in setVisibility to private succeeds and the record is unlisted', async () => {
    const fake = installFakePds()
    try {
      const owner = await identityFromSeed(seed(31))
      const host = flowHost(owner)
      const { id, url } = await publicRecipe()
      stagePublication(id)
      signIn()
      const result = await host.setVisibility(id, 'private')
      expect(result.warnings).toEqual([])
      expect(result.publicRecord).toBe('not listed')
      expect(fake.calls).toContain('com.atproto.repo.deleteRecord')
      const after = await getRecipe(getRepo(), url)
      expect(after?.visibility ?? 'private').toBe('private')
    } finally {
      fake.restore()
    }
  })
})
