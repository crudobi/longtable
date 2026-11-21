// @vitest-environment jsdom
/**
 * Storage hardening tests (integrity M11/M12/M13):
 * - pagehide flushes pending IndexedDB writes (M12);
 * - mutations flush before reporting success (M12);
 * - createRecipe is index-first and the startup pass removes orphans (M11);
 * - the schema version is stamped and malformed index entries are
 *   logged + removed (M13);
 * - descriptive fields round-trip through the store (M15/M21).
 */
import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vitest'
import {
  INDEX_GUID,
  createRepo,
  getOrCreateDoc,
  registerPagehideFlush,
} from '../store/repo'
import {
  INDEX_META_MAP,
  SCHEMA_VERSION,
  createRecipe,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  memoryStore,
  reconcileIndexOrphans,
  updateRecipe,
} from '../store/recipes'

let counter = 0
const uniq = (base: string) => `${base}-${++counter}`

describe('pagehide flush (M12)', () => {
  it('flushes when the page hides, and stops after unsubscribe', async () => {
    const repo = createRepo(uniq('longtable-pagehide'))
    const flush = vi.spyOn(repo, 'flush')
    const stop = registerPagehideFlush(repo)
    window.dispatchEvent(new window.Event('pagehide'))
    expect(flush).toHaveBeenCalledTimes(1)
    stop()
    window.dispatchEvent(new window.Event('pagehide'))
    expect(flush).toHaveBeenCalledTimes(1)
  })
})

describe('createRecipe index-first + reconciliation (M11)', () => {
  it('flushes after a mutation', async () => {
    const repo = createRepo(uniq('longtable-flush'))
    const flush = vi.spyOn(repo, 'flush')
    const index = await getOrCreateIndex(repo, memoryStore())
    await createRecipe(repo, index, { title: 'Flushed', ingredients: [], steps: [], photos: [] })
    expect(flush).toHaveBeenCalled()
  })

  it('reconciles an index entry whose document holds no recipe', async () => {
    const repo = createRepo(uniq('longtable-orphan'))
    const kv = memoryStore()
    const index = await getOrCreateIndex(repo, kv)
    const summary = await createRecipe(repo, index, {
      title: 'Orphan',
      ingredients: [],
      steps: [],
      photos: [],
    })
    expect(await listRecipes(index)).toHaveLength(1)
    // Simulate the crash window: the index entry exists but the
    // document never got its content.
    const doc = await getOrCreateDoc(repo, summary.id)
    doc.transact(() => {
      doc.getMap('recipe').delete('title')
    })
    const result = await reconcileIndexOrphans(repo)
    expect(result.checked).toBe(1)
    expect(result.removed).toEqual([summary.id])
    expect(await listRecipes(index)).toHaveLength(0)
  })
})

describe('schema versioning + malformed entries (M13)', () => {
  it('stamps the schema version on the index and on created recipes', async () => {
    const repo = createRepo(uniq('longtable-schema'))
    const kv = memoryStore()
    const index = await getOrCreateIndex(repo, kv)
    const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
    expect(indexDoc.getMap(INDEX_META_MAP).get('schemaVersion')).toBe(SCHEMA_VERSION)
    const summary = await createRecipe(repo, index, {
      title: 'Stamped',
      ingredients: [],
      steps: [],
      photos: [],
    })
    const doc = await getOrCreateDoc(repo, summary.id)
    expect(doc.getMap('recipe').get('schemaVersion')).toBe(SCHEMA_VERSION)
  })

  it('drops malformed index entries from listings, logs them, and reconciles them away', async () => {
    const repo = createRepo(uniq('longtable-malformed'))
    const kv = memoryStore()
    const index = await getOrCreateIndex(repo, kv)
    const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
    const bad = new Y.Map<unknown>()
    bad.set('title', 'Bad entry')
    // No url / updatedAt: the snapshot must drop this entry.
    indexDoc.transact(() => {
      indexDoc.getMap('recipes').set('bad1', bad)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await listRecipes(index)).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'))
      const result = await reconcileIndexOrphans(repo)
      expect(result.removed).toEqual(['bad1'])
      expect(await listRecipes(index)).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('descriptive fields through the store (M15/M21)', () => {
  it('round-trips description, yield, tags, author, and source URL', async () => {
    const repo = createRepo(uniq('longtable-fields'))
    const kv = memoryStore()
    const index = await getOrCreateIndex(repo, kv)
    const summary = await createRecipe(repo, index, {
      title: 'Full',
      ingredients: [],
      steps: [],
      photos: [],
      description: 'A note.',
      recipeYield: '4 servings',
      tags: ['soup', 'quick'],
      author: 'Chef A',
      sourceUrl: 'https://example.com/full',
    })
    const recipe = await getRecipe(repo, summary.url)
    expect(recipe!.description).toBe('A note.')
    expect(recipe!.recipeYield).toBe('4 servings')
    expect(recipe!.tags).toEqual(['soup', 'quick'])
    expect(recipe!.author).toBe('Chef A')
    expect(recipe!.sourceUrl).toBe('https://example.com/full')
    // Clearing one field leaves the others untouched.
    await updateRecipe(repo, index, summary.id, { description: undefined })
    const after = await getRecipe(repo, summary.url)
    expect(after!.description).toBeUndefined()
    expect(after!.recipeYield).toBe('4 servings')
    expect(after!.tags).toEqual(['soup', 'quick'])
  })
})
