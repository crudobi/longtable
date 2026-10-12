/**
 * Recovery-migration tests: seed a Phase 0 (Automerge) database in the
 * exact on-disk format @automerge/automerge-repo's IndexedDB adapter used
 * (object store `documents`, array keys `[docId, "snapshot"|"incremental",
 * hash]`, values `{ key, binary }`), then run the one-time migration and
 * assert the recipes land in the Yjs store intact.
 */
import 'fake-indexeddb/auto'
import * as Automerge from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import { createRepo } from '../store/repo'
import {
  MIGRATED_KEY,
  asRecoveredRecipe,
  migrateFromAutomergeIfNeeded,
  recipeFingerprint,
} from '../store/migrateFromAutomerge'
import {
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  memoryStore,
} from '../store/recipes'
import type { KeyValueStore } from '../store/recipes'

const PHOTO = 'data:image/jpeg;base64,/9j/FAKEPHOTO'

let counter = 0
const uniq = (base: string) => `${base}-${++counter}`

async function seedOldDb(
  dbName: string,
  entries: { key: string[]; binary: Uint8Array }[],
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('documents')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite')
    const store = tx.objectStore('documents')
    for (const e of entries) store.put({ key: e.key, binary: e.binary }, e.key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

/** Build an Automerge recipe doc the way Phase 0's repo stored it. */
function recipeDocBinary(): { snapshot: Uint8Array; incremental: Uint8Array } {
  let doc = Automerge.from<Record<string, unknown>>({
    title: 'Migration Stew',
    ingredients: ['1 onion'],
    steps: ['Chop.'],
    photos: [],
    prepMinutes: 5,
    cookMinutes: 15,
    createdAt: '2026-10-11T10:00:00.000Z',
    updatedAt: '2026-10-11T10:00:00.000Z',
  })
  const snapshot = Automerge.save(doc)
  doc = Automerge.change(doc, (d) => {
    ;(d.ingredients as string[]).push('2 carrots')
    ;(d.photos as string[]).push(PHOTO)
    d.updatedAt = '2026-10-11T11:30:00.000Z'
  })
  const incremental = Automerge.saveIncremental(doc)
  return { snapshot, incremental }
}

describe('automerge recovery migration', () => {
  it('imports a Phase 0 recipe (snapshot + incremental) with photo and timestamps', async () => {
    const oldDb = uniq('longtable-old')
    const { snapshot, incremental } = recipeDocBinary()
    const indexDoc = Automerge.from<Record<string, unknown>>({
      recipes: { someid: { title: 'Migration Stew', url: 'automerge:x', updatedAt: 'x' } },
    })
    await seedOldDb(oldDb, [
      { key: ['docA', 'snapshot', 'h1'], binary: snapshot },
      { key: ['docA', 'incremental', 'h2'], binary: incremental },
      { key: ['indexDoc', 'snapshot', 'h1'], binary: Automerge.save(indexDoc) },
      // Corrupt chunk set: must be skipped, not fatal.
      { key: ['corruptDoc', 'snapshot', 'h1'], binary: new Uint8Array([1, 2, 3, 4]) },
    ])

    const store = createRepo(uniq('longtable-new'))
    const kv: KeyValueStore = memoryStore()
    const outcome = await migrateFromAutomergeIfNeeded({ store, kv, oldDbName: oldDb })

    expect(outcome.ran).toBe(true)
    expect(outcome.imported).toBe(1)
    expect(outcome.failedDocs).toBe(1) // the corrupt doc only
    expect(kv.getItem(MIGRATED_KEY)).toBeTruthy()

    const index = await getOrCreateIndex(store, kv)
    const listed = await listRecipes(index)
    expect(listed).toHaveLength(1)
    expect(listed[0].title).toBe('Migration Stew')
    expect(listed[0].updatedAt).toBe('2026-10-11T11:30:00.000Z')

    const recipe = await getRecipe(store, listed[0].url)
    expect(recipe).not.toBeNull()
    expect(recipe!.ingredients).toEqual(['1 onion', '2 carrots'])
    expect(recipe!.steps).toEqual(['Chop.'])
    expect(recipe!.photos).toEqual([PHOTO])
    expect(recipe!.prepMinutes).toBe(5)
    expect(recipe!.cookMinutes).toBe(15)
    expect(recipe!.createdAt).toBe('2026-10-11T10:00:00.000Z')
    expect(recipe!.updatedAt).toBe('2026-10-11T11:30:00.000Z')
  })

  it('is a no-op when the flag is already set', async () => {
    const store = createRepo(uniq('longtable-new'))
    const kv = memoryStore()
    kv.setItem(MIGRATED_KEY, '{"at":"earlier"}')
    const outcome = await migrateFromAutomergeIfNeeded({
      store,
      kv,
      oldDbName: uniq('longtable-old'),
    })
    expect(outcome.ran).toBe(false)
    expect(outcome.imported).toBe(0)
  })

  it('no-ops cleanly when there is no old database (fresh install)', async () => {
    const store = createRepo(uniq('longtable-new'))
    const kv = memoryStore()
    const outcome = await migrateFromAutomergeIfNeeded({
      store,
      kv,
      oldDbName: uniq('longtable-never-existed'),
    })
    expect(outcome.ran).toBe(true)
    expect(outcome.imported).toBe(0)
    expect(kv.getItem(MIGRATED_KEY)).toBeTruthy()
    // The probe must not leave an empty database behind.
    const names = (await indexedDB.databases()).map((d) => d.name)
    expect(names.some((n) => n?.startsWith('longtable-never-existed'))).toBe(false)
  })

  it('dedupes by content if the flag is lost and migration re-runs', async () => {
    const oldDb = uniq('longtable-old')
    const { snapshot, incremental } = recipeDocBinary()
    await seedOldDb(oldDb, [
      { key: ['docA', 'snapshot', 'h1'], binary: snapshot },
      { key: ['docA', 'incremental', 'h2'], binary: incremental },
    ])
    const store = createRepo(uniq('longtable-new'))

    const first = await migrateFromAutomergeIfNeeded({
      store,
      kv: memoryStore(),
      oldDbName: oldDb,
    })
    expect(first.imported).toBe(1)

    // Flag lost (fresh kv): scan runs again but must import nothing twice.
    const kv2 = memoryStore()
    const second = await migrateFromAutomergeIfNeeded({ store, kv: kv2, oldDbName: oldDb })
    expect(second.imported).toBe(0)
    expect(second.skippedDuplicates).toBe(1)

    const index = await getOrCreateIndex(store, kv2)
    expect(await listRecipes(index)).toHaveLength(1)
  })

  it('recovers a snapshot-only recipe with no photos field', async () => {
    const oldDb = uniq('longtable-old')
    const doc = Automerge.from<Record<string, unknown>>({
      title: 'Plain Toast',
      ingredients: ['bread'],
      steps: ['Toast it.'],
      createdAt: '2026-10-10T09:00:00.000Z',
      updatedAt: '2026-10-10T09:00:00.000Z',
    })
    await seedOldDb(oldDb, [
      { key: ['docB', 'snapshot', 'h1'], binary: Automerge.save(doc) },
    ])
    const store = createRepo(uniq('longtable-new'))
    const kv = memoryStore()
    const outcome = await migrateFromAutomergeIfNeeded({ store, kv, oldDbName: oldDb })
    expect(outcome.imported).toBe(1)
    const index = await getOrCreateIndex(store, kv)
    const listed = await listRecipes(index)
    const recipe = await getRecipe(store, listed[0].url)
    expect(recipe!.title).toBe('Plain Toast')
    expect(recipe!.photos).toEqual([])
    expect(recipe!.prepMinutes).toBeUndefined()
  })
})

describe('shape check + fingerprint', () => {
  it('rejects non-recipe documents', () => {
    expect(asRecoveredRecipe(null)).toBeNull()
    expect(asRecoveredRecipe({ recipes: {} })).toBeNull() // old index doc
    expect(asRecoveredRecipe({ title: 'x' })).toBeNull()
    expect(asRecoveredRecipe({ title: 'x', ingredients: 'nope', steps: [] })).toBeNull()
    expect(asRecoveredRecipe({ title: 'x', ingredients: [1], steps: [] })).toBeNull()
  })

  it('fingerprint ignores timestamps but catches content changes', () => {
    const base = {
      title: 'T',
      ingredients: ['a'],
      steps: ['s'],
      photos: [] as string[],
      prepMinutes: 1,
      cookMinutes: 2,
    }
    expect(recipeFingerprint(base)).toBe(recipeFingerprint({ ...base }))
    expect(recipeFingerprint(base)).not.toBe(
      recipeFingerprint({ ...base, ingredients: ['a', 'b'] }),
    )
    expect(recipeFingerprint(base)).not.toBe(
      recipeFingerprint({ ...base, prepMinutes: undefined }),
    )
  })
})
