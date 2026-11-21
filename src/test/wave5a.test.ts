/**
 * Wave 5A client reliability Lows (review-2026-11-20 reliability L1–L9,
 * N4; review-2026-11-15 misc Lows Int L10/L12/L13).
 *
 * L1 + N4 are VERIFIED ALREADY CLOSED by Wave 4F (see the report — no
 * tests here assert them twice): createRecipe is index-first with
 * rollback + startup reconcileIndexOrphans, and RecipeForm.attachPhotos
 * already surfaces failures. Everything else below pins a Wave 5A fix
 * and fails against the pre-fix code (checked with git stash where
 * noted in the test comments).
 */
import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const providerCalls = vi.hoisted(() => [] as Array<{ room: string; opts: Record<string, unknown> }>)
const destroyedRooms = vi.hoisted(() => [] as string[])

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class {
    awareness = { getStates: () => new Map() }
    constructor(room: string, _doc: unknown, opts: Record<string, unknown>) {
      providerCalls.push({ room, opts })
    }
    destroy() {
      destroyedRooms.push('destroyed')
    }
  },
}))

import { createRepo, docUrl, getOrCreateDoc, getRepo, INDEX_GUID } from '../store/repo'
import {
  createRecipe,
  filterSummaries,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  memoryStore,
  reconcileIndexOrphans,
  RECIPE_MAP,
  updateRecipe,
  type KeyValueStore,
} from '../store/recipes'
import type { RecipeInput, RecipeSummary } from '../types'
import { MAX_RECIPE_MINUTES } from '../types'
import { validateImportedRecipe } from '../importers/contract'
import { parseMinutes } from '../components/RecipeForm'
import { addStartupNotice, startupNotice, type StartupFailureKind } from '../startupNotices'
import {
  destroyAllShareProviders,
  getShare,
  hasShareProvider,
  joinShare,
  roomForRecipe,
  type SharePayload,
} from '../p2p/share'
import { publicRecordToInput, publicRecordTimestamps, type PublicRecipe } from '../public/discover'
import { createLocalApiHost } from '../localapi/host'

let dbCounter = 0
let kv: KeyValueStore

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

const makeRepo = () => {
  dbCounter += 1
  return createRepo(`longtable-wave5a-test-${dbCounter}`)
}

const sample = (title: string, extra: Partial<RecipeInput> = {}): RecipeInput => ({
  title,
  ingredients: ['2 cups flour', '1 tsp salt'],
  steps: ['Mix everything.', 'Bake 20 min.'],
  prepMinutes: 10,
  cookMinutes: 20,
  photos: [],
  ...extra,
})

const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64')

beforeEach(() => {
  kv = memoryStore()
  ;(globalThis as { localStorage?: Storage }).localStorage = mkLocalStorage()
  providerCalls.length = 0
  destroyedRooms.length = 0
})

afterEach(() => {
  destroyAllShareProviders()
  delete (globalThis as { localStorage?: Storage }).localStorage
})

// ---------------------------------------------------------------------------
// Rel L2 — per-field index update: a concurrent rename is not lost
// ---------------------------------------------------------------------------

describe('Rel L2 index entry per-field update', () => {
  it('a peer rename applied after the update snapshot is read survives an update that does not rename', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)
    const summary = await createRecipe(repo, index, sample('Original'))
    // Deterministic interleaving: updateRecipe takes its index snapshot
    // synchronously when invoked (index.doc() runs snapshotIndex inline),
    // then suspends on `await`. The rename below runs synchronously
    // after the call, so it lands AFTER the snapshot but BEFORE the
    // index write. The old wholesale rebuild wrote the stale title back
    // and lost the rename; the per-field update never touches the title.
    const p = updateRecipe(repo, index, summary.id, { ingredients: ['changed'] })
    const cachedIndex = repo.docs.get(INDEX_GUID)
    expect(cachedIndex).toBeDefined()
    const live = cachedIndex!.doc.getMap('recipes').get(summary.id)
    expect(live).toBeInstanceOf(Y.Map)
    ;(live as Y.Map<unknown>).set('title', 'Peer Rename')
    await p
    const listed = await listRecipes(index)
    expect(listed).toHaveLength(1)
    expect(listed[0].title).toBe('Peer Rename')
  })

  it('an update that does not touch visibility keeps the stamped tier', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)
    const summary = await createRecipe(repo, index, sample('Soup', { visibility: 'public' }))
    expect((await listRecipes(index))[0].visibility).toBe('public')
    await updateRecipe(repo, index, summary.id, { ingredients: ['changed'] })
    // The old wholesale rebuild dropped the tier from the entry (its
    // entryMap carried no visibility), so the list forgot the recipe
    // was public until its next visibility-carrying edit.
    expect((await listRecipes(index))[0].visibility).toBe('public')
  })

  it('a rename through the patch still renames', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)
    const summary = await createRecipe(repo, index, sample('Old'))
    await updateRecipe(repo, index, summary.id, { title: 'New' })
    expect((await listRecipes(index))[0].title).toBe('New')
  })

  it('a visibility flip through the patch updates the tier and a flip back to private clears it', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)
    const summary = await createRecipe(repo, index, sample('Soup'))
    await updateRecipe(repo, index, summary.id, { visibility: 'friends-only' })
    expect((await listRecipes(index))[0].visibility).toBe('friends-only')
    await updateRecipe(repo, index, summary.id, { visibility: 'private' })
    expect((await listRecipes(index))[0].visibility).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Rel L4 + Int L12 — minutes are type-checked on read and bounded everywhere
// ---------------------------------------------------------------------------

describe('Rel L4 / Int L12 minutes validation', () => {
  it('getRecipe drops a mistyped stored minute instead of casting it', async () => {
    const repo = makeRepo()
    const id = `wave5a-min-str-${dbCounter}`
    const doc = await getOrCreateDoc(repo, id)
    doc.transact(() => {
      const map = doc.getMap(RECIPE_MAP)
      map.set('title', 'Seeded')
      map.set('prepMinutes', 'ten')
    })
    const recipe = await getRecipe(repo, docUrl(id))
    expect(recipe).not.toBeNull()
    expect(recipe!.prepMinutes).toBeUndefined()
  })

  it('getRecipe drops an out-of-bounds stored minute', async () => {
    const repo = makeRepo()
    const id = `wave5a-min-big-${dbCounter}`
    const doc = await getOrCreateDoc(repo, id)
    doc.transact(() => {
      const map = doc.getMap(RECIPE_MAP)
      map.set('title', 'Seeded')
      map.set('prepMinutes', 1e9)
      map.set('cookMinutes', -5)
    })
    const recipe = await getRecipe(repo, docUrl(id))
    expect(recipe).not.toBeNull()
    expect(recipe!.prepMinutes).toBeUndefined()
    expect(recipe!.cookMinutes).toBeUndefined()
  })

  it('createRecipe drops minutes above the bound and keeps the bound itself', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)
    const huge = await createRecipe(repo, index, sample('Huge', { prepMinutes: 1e9 }))
    expect((await getRecipe(repo, huge.url))!.prepMinutes).toBeUndefined()
    const maxed = await createRecipe(
      repo,
      index,
      sample('Maxed', { prepMinutes: MAX_RECIPE_MINUTES }),
    )
    expect((await getRecipe(repo, maxed.url))!.prepMinutes).toBe(MAX_RECIPE_MINUTES)
    const over = await createRecipe(
      repo,
      index,
      sample('Over', { prepMinutes: MAX_RECIPE_MINUTES + 1 }),
    )
    expect((await getRecipe(repo, over.url))!.prepMinutes).toBeUndefined()
  })

  it('createRecipe still rounds fractional minutes (H-N3)', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)
    const s = await createRecipe(repo, index, sample('Frac', { prepMinutes: 0.4 }))
    expect((await getRecipe(repo, s.url))!.prepMinutes).toBe(0)
  })

  it('the importer validator rejects minutes above the bound', () => {
    expect(() =>
      validateImportedRecipe(
        { title: 'Huge', ingredients: [], steps: [], prepMinutes: 1e9 },
        'test',
      ),
    ).toThrow(/too large/)
    expect(
      validateImportedRecipe(
        { title: 'Maxed', ingredients: [], steps: [], prepMinutes: MAX_RECIPE_MINUTES },
        'test',
      ).prepMinutes,
    ).toBe(MAX_RECIPE_MINUTES)
  })

  it('parseMinutes drops out-of-bounds values like any other invalid input', () => {
    expect(parseMinutes('1000000000')).toBeUndefined()
    expect(parseMinutes(String(MAX_RECIPE_MINUTES))).toBe(MAX_RECIPE_MINUTES)
    expect(parseMinutes(String(MAX_RECIPE_MINUTES + 1))).toBeUndefined()
    expect(parseMinutes('12.5')).toBe(13)
    expect(parseMinutes('')).toBeUndefined()
    expect(parseMinutes('-3')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Int L10 part (b) — UI list search + listRecipes N+1 (host list)
// ---------------------------------------------------------------------------

describe('Int L10 part (b) list search + N+1', () => {
  const summaries = (titles: string[]): RecipeSummary[] =>
    titles.map((title, i) => ({
      id: `id-${i}`,
      title,
      url: `yjs:id-${i}`,
      updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
    }))

  it('filterSummaries matches titles case-insensitively, and an empty query returns the list', () => {
    const all = summaries(['Tomato Soup', 'tomato salad', 'Bread'])
    expect(filterSummaries(all, '')).toBe(all)
    expect(filterSummaries(all, 'TOMATO').map((s) => s.title)).toEqual([
      'Tomato Soup',
      'tomato salad',
    ])
    expect(filterSummaries(all, 'soup').map((s) => s.title)).toEqual(['Tomato Soup'])
    expect(filterSummaries(all, 'zzz')).toEqual([])
  })

  it('the API list answers visibility from the index, not from a full doc read per row', async () => {
    const repo = makeRepo()
    const host = createLocalApiHost({ repo, kv })
    const { id } = await host.createRecipe(sample('Soup', { visibility: 'public' }))
    await host.createRecipe(sample('Bread'))
    // Diverge the DOC from the index: the doc now says friends-only,
    // the index still says public. The old list loaded every full doc
    // (N+1 reads, photos included) and answered friends-only; the
    // fixed list answers from the index entry alone.
    const doc = await getOrCreateDoc(repo, id)
    doc.transact(() => {
      doc.getMap(RECIPE_MAP).set('visibility', 'friends-only')
    })
    const listed = await host.listRecipes()
    expect(listed).toHaveLength(2)
    expect(listed.find((s) => s.id === id)?.visibility).toBe('public')
    expect(listed.find((s) => s.title === 'Bread')?.visibility).toBe('private')
  })

  it('the startup reconcile backfills a missing index tier from the doc', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)
    const summary = await createRecipe(repo, index, sample('Soup', { visibility: 'public' }))
    // Simulate a pre-fix entry: strip the tier from the live map.
    const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
    const entry = indexDoc.getMap('recipes').get(summary.id)
    expect(entry).toBeInstanceOf(Y.Map)
    ;(entry as Y.Map<unknown>).delete('visibility')
    expect((await listRecipes(index))[0].visibility).toBeUndefined()
    await reconcileIndexOrphans(repo)
    expect((await listRecipes(index))[0].visibility).toBe('public')
  })
})

// ---------------------------------------------------------------------------
// Rel L6 — startup background failures get a banner notice, not just a log
// ---------------------------------------------------------------------------

describe('Rel L6 startup notices', () => {
  const kinds: StartupFailureKind[] = [
    'secrets-migration',
    'automerge-migration',
    'index-cleanup',
    'identity-setup',
    'received-shares-import',
    'friends-sweep',
    'rejoin-shares',
    'local-api-start',
  ]

  it('every kind maps to a plain non-empty sentence', () => {
    for (const kind of kinds) {
      const msg = startupNotice(kind)
      expect(typeof msg).toBe('string')
      expect(msg.length).toBeGreaterThan(20)
      expect(msg).not.toMatch(/undefined|Error:|stack/i)
    }
  })

  it('addStartupNotice appends once and dedupes repeats', () => {
    const once = addStartupNotice([], 'rejoin-shares')
    expect(once).toHaveLength(1)
    expect(addStartupNotice(once, 'rejoin-shares')).toBe(once)
    expect(addStartupNotice(once, 'index-cleanup')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Rel L5 residual — a timed-out fresh join tears itself down
// ---------------------------------------------------------------------------

describe('Rel L5 residual timed-out join teardown', () => {
  let n = 0
  const freshId = () => `wave5a-join-${++n}-${Date.now()}`

  function payloadWithoutSnapshot(id: string): SharePayload {
    return {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'Shared',
      snapshot: '',
    }
  }

  it('a content timeout leaves no provider, no share record, and no orphaned doc', async () => {
    const id = freshId()
    // No snapshot: joinShare waits for sync content that never arrives
    // (mocked provider never syncs). contentTimeoutMs keeps the test
    // fast; the production default is 20000.
    await expect(joinShare(payloadWithoutSnapshot(id), { contentTimeoutMs: 50 })).rejects.toThrow(
      /Timed out/,
    )
    expect(hasShareProvider(id)).toBe(false)
    expect(getShare(id)).toBeUndefined()
    // The doc is wiped from IndexedDB, not just unlisted: reloading it
    // yields an empty doc, so a later join starts clean.
    const reloaded = await getOrCreateDoc(getRepo(), id)
    expect(reloaded.getMap(RECIPE_MAP).size).toBe(0)
    // And the index never learned about it.
    const index = await getOrCreateIndex(getRepo(), memoryStore())
    const listed = await listRecipes(index)
    expect(listed.find((s) => s.id === id)).toBeUndefined()
  })

  it('a snapshot that fails validation tears down the same way', async () => {
    const id = freshId()
    // A snapshot carrying lists but no title: validateSharedDoc throws.
    const src = new Y.Doc({ guid: id })
    src.transact(() => {
      src.getMap(RECIPE_MAP).set('ingredients', new Y.Array<string>())
    })
    const snapshot = b64(Y.encodeStateAsUpdate(src))
    src.destroy()
    const payload: SharePayload = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'Shared',
      snapshot,
    }
    await expect(joinShare(payload)).rejects.toThrow(/readable recipe/)
    expect(hasShareProvider(id)).toBe(false)
    expect(getShare(id)).toBeUndefined()
    const reloaded = await getOrCreateDoc(getRepo(), id)
    expect(reloaded.getMap(RECIPE_MAP).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Save-a-copy preserves authorship + timestamps
// ---------------------------------------------------------------------------

describe('save-a-copy authorship + timestamps', () => {
  const AUTHOR = 'did:plc:author1'
  const CREATED = '2024-01-02T03:04:05.000Z'
  const UPDATED = '2024-05-06T07:08:09.000Z'

  function record(over: Record<string, unknown> = {}): PublicRecipe {
    return {
      $type: 'kitchen.longtable.recipe',
      name: 'Tomato Soup',
      description: 'Slow.',
      ingredients: ['tomatoes', 'salt'],
      instructions: ['Chop', 'Simmer'],
      prepTimeMinutes: 5,
      cookTimeMinutes: 25,
      recipeYield: '4 servings',
      tags: ['soup'],
      images: [],
      deviceDid: 'did:key:z6Mkdevice',
      deviceSignature: 'c2ln',
      createdAt: CREATED,
      updatedAt: UPDATED,
      longtableId: 'recipe-1',
      did: AUTHOR,
      rkey: 'recipe-1',
      ...over,
    } as unknown as PublicRecipe
  }

  it('publicRecordToInput keeps the author DID', async () => {
    const input = await publicRecordToInput(record())
    expect(input.author).toBe(AUTHOR)
    expect(input.title).toBe('Tomato Soup')
    // A bare record with no DID keeps no author.
    const bare = record({ did: undefined })
    delete (bare as unknown as Record<string, unknown>).did
    expect((await publicRecordToInput(bare)).author).toBeUndefined()
  })

  it('publicRecordTimestamps returns the original times, and undefined for malformed ones', () => {
    expect(publicRecordTimestamps(record())).toEqual({ createdAt: CREATED, updatedAt: UPDATED })
    expect(publicRecordTimestamps(record({ createdAt: 'not-a-date' }))).toBeUndefined()
    expect(publicRecordTimestamps(record({ updatedAt: '' }))).toBeUndefined()
  })

  it('a saved copy stores the original timestamps, not "now"', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)
    const input = await publicRecordToInput(record())
    const summary = await createRecipe(repo, index, input, publicRecordTimestamps(record()))
    const saved = await getRecipe(repo, summary.url)
    expect(saved).not.toBeNull()
    expect(saved!.createdAt).toBe(CREATED)
    expect(saved!.updatedAt).toBe(UPDATED)
    expect(saved!.author).toBe(AUTHOR)
    // The copy is private on this device — visibility is not carried over.
    expect(saved!.visibility).toBeUndefined()
    expect(summary.updatedAt).toBe(UPDATED)
  })
})
