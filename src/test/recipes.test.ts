/**
 * Store-layer unit tests: create/read/update/delete, doc-per-recipe
 * isolation, and IndexedDB persistence round-trips.
 *
 * Runs in Node with fake-indexeddb shimming the browser's IndexedDB.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createRepo } from '../store/repo'
import {
  createRecipe,
  deleteRecipe,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  memoryStore,
  updateRecipe,
} from '../store/recipes'
import type { KeyValueStore } from '../store/recipes'
import type { RecipeInput } from '../types'

let dbCounter = 0
let kv: KeyValueStore

const makeRepo = () => {
  dbCounter += 1
  return createRepo(`longtable-test-${dbCounter}`)
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

beforeEach(() => {
  kv = memoryStore()
})

describe('recipe store', () => {
  it('creates and reads back a recipe', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)

    const summary = await createRecipe(repo, index, sample('Pancakes'))

    expect(summary.id).toBeTruthy()
    expect(summary.title).toBe('Pancakes')
    expect(summary.url).toMatch(/^yjs:/)

    const listed = await listRecipes(index)
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(summary.id)

    const recipe = await getRecipe(repo, summary.url)
    expect(recipe).not.toBeNull()
    expect(recipe!.title).toBe('Pancakes')
    expect(recipe!.ingredients).toEqual(['2 cups flour', '1 tsp salt'])
    expect(recipe!.steps).toEqual(['Mix everything.', 'Bake 20 min.'])
    expect(recipe!.prepMinutes).toBe(10)
    expect(recipe!.cookMinutes).toBe(20)
    expect(recipe!.photos).toEqual([])
    expect(recipe!.createdAt).toBeTruthy()
    expect(recipe!.updatedAt).toBe(recipe!.createdAt)
  })

  it('updates a recipe and bumps updatedAt in doc and index', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)
    const summary = await createRecipe(repo, index, sample('Soup'))
    const before = await getRecipe(repo, summary.url)

    await updateRecipe(repo, index, summary.id, {
      title: 'Tomato Soup',
      ingredients: ['3 tomatoes'],
    })

    const after = await getRecipe(repo, summary.url)
    expect(after!.title).toBe('Tomato Soup')
    expect(after!.ingredients).toEqual(['3 tomatoes'])
    // untouched fields survive
    expect(after!.steps).toEqual(before!.steps)
    expect(after!.cookMinutes).toBe(20)
    expect(after!.createdAt).toBe(before!.createdAt)

    const listed = await listRecipes(index)
    expect(listed[0].title).toBe('Tomato Soup')
  })

  it('deletes a recipe and leaves others untouched (doc-per-recipe isolation)', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)
    const a = await createRecipe(repo, index, sample('Alpha'))
    const b = await createRecipe(repo, index, sample('Beta'))

    // update A: B must be unaffected
    await updateRecipe(repo, index, a.id, { title: 'Alpha v2' })
    const bDoc = await getRecipe(repo, b.url)
    expect(bDoc!.title).toBe('Beta')

    // delete A: B must remain listed and readable
    await deleteRecipe(repo, index, a.id)
    const listed = await listRecipes(index)
    expect(listed.map((s) => s.id)).toEqual([b.id])
    const bAfter = await getRecipe(repo, b.url)
    expect(bAfter!.title).toBe('Beta')
    expect(bAfter!.ingredients).toEqual(['2 cups flour', '1 tsp salt'])
  })

  it('persists across repo reloads (IndexedDB round-trip)', async () => {
    const dbName = `longtable-roundtrip-${Date.now()}`
    const repo1 = createRepo(dbName)
    const index1 = await getOrCreateIndex(repo1, kv)
    const summary = await createRecipe(
      repo1,
      index1,
      sample('Overnight Oats', { photos: ['data:image/png;base64,AAA'] }),
    )
    await updateRecipe(repo1, index1, summary.id, { cookMinutes: 0 })
    // Flush pending writes to IndexedDB before "reloading" (the persistence
    // layer writes asynchronously; a real reload happens much later).
    await repo1.flush()

    // Simulate a full reload: brand-new store over the same IndexedDB
    // namespace, same persisted index URL.
    const repo2 = createRepo(dbName)
    const index2 = await getOrCreateIndex(repo2, kv)

    const listed = await listRecipes(index2)
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(summary.id)
    expect(listed[0].title).toBe('Overnight Oats')

    const recipe = await getRecipe(repo2, listed[0].url)
    expect(recipe!.title).toBe('Overnight Oats')
    expect(recipe!.ingredients).toEqual(['2 cups flour', '1 tsp salt'])
    expect(recipe!.cookMinutes).toBe(0)
    expect(recipe!.photos).toEqual(['data:image/png;base64,AAA'])
  })

  it('partial patches do not clobber optional fields; explicit undefined clears', async () => {
    const repo = makeRepo()
    const index = await getOrCreateIndex(repo, kv)
    const summary = await createRecipe(repo, index, sample('Stew'))

    await updateRecipe(repo, index, summary.id, { title: 'Stew v2' })
    const kept = await getRecipe(repo, summary.url)
    expect(kept!.prepMinutes).toBe(10)
    expect(kept!.cookMinutes).toBe(20)

    await updateRecipe(repo, index, summary.id, { prepMinutes: undefined })
    const cleared = await getRecipe(repo, summary.url)
    expect(cleared!.prepMinutes).toBeUndefined()
    expect(cleared!.cookMinutes).toBe(20)
  })

  it('getOrCreateIndex reuses the stored index URL across instances', async () => {
    const repo = makeRepo()
    const first = await getOrCreateIndex(repo, kv)
    const second = await getOrCreateIndex(repo, kv)
    expect(second.url).toBe(first.url)
    await createRecipe(repo, first, sample('One'))
    expect(await listRecipes(second)).toHaveLength(1)
  })

  it('deleteRecipe wipes the doc from IndexedDB (no resurrection on reload)', async () => {
    dbCounter += 1
    const dbName = `longtable-delete-${dbCounter}`
    const repo1 = createRepo(dbName)
    const index1 = await getOrCreateIndex(repo1, kv)
    const doomed = await createRecipe(repo1, index1, sample('Doomed'))
    const survivor = await createRecipe(repo1, index1, sample('Survivor'))

    await deleteRecipe(repo1, index1, doomed.id)
    await repo1.flush()

    // Fresh store over the same IndexedDB namespace: the deleted recipe is
    // gone from the index AND its document data no longer loads.
    const repo2 = createRepo(dbName)
    const index2 = await getOrCreateIndex(repo2, kv)
    const listed = await listRecipes(index2)
    expect(listed.map((s) => s.id)).toEqual([survivor.id])
    expect(await getRecipe(repo2, doomed.url)).toBeNull()
    const kept = await getRecipe(repo2, survivor.url)
    expect(kept!.title).toBe('Survivor')
    expect(kept!.ingredients).toEqual(['2 cups flour', '1 tsp salt'])
  })

  it('concurrent offline edits merge with zero field loss (no duplicate items)', async () => {
    // Simulates two devices: A and B share a doc via sync, go offline,
    // edit different fields, then sync. Yjs must merge cleanly.
    const Y = await import('yjs')
    const { getOrCreateDoc } = await import('../store/repo')
    dbCounter += 1
    const repoA = createRepo(`longtable-merge-${dbCounter}`)
    const indexA = await getOrCreateIndex(repoA, kv)
    const summary = await createRecipe(repoA, indexA, sample('Merge Soup'))
    await repoA.flush()

    // B gets the doc via sync (same mechanism as the share snapshot)
    const docA = await getOrCreateDoc(repoA, summary.id)
    const updateAB = Y.encodeStateAsUpdate(docA)
    const docB = new Y.Doc({ guid: summary.id })
    Y.applyUpdate(docB, updateAB)

    // Concurrent offline edits: A renames title (ingredients untouched),
    // B adds an ingredient (title untouched)
    await updateRecipe(repoA, indexA, summary.id, { title: 'Merge Soup REMIXED' })
    const mapB = docB.getMap('recipe')
    docB.transact(() => {
      const arr = mapB.get('ingredients')
      if (arr instanceof Y.Array) arr.push(['1 tbsp sugar'])
    })

    // Sync both ways (what y-webrtc would do automatically)
    const docA2 = await getOrCreateDoc(repoA, summary.id)
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA2))
    Y.applyUpdate(docA2, Y.encodeStateAsUpdate(docB))

    // Both converge: title from A, all three ingredients, no duplicates
    for (const doc of [docA2, docB]) {
      const m = doc.getMap('recipe')
      expect(m.get('title')).toBe('Merge Soup REMIXED')
      const ings = (m.get('ingredients') as any).toArray()
      expect(ings).toEqual(['2 cups flour', '1 tsp salt', '1 tbsp sugar'])
    }
  })
})
