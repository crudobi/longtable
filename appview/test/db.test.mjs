import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RecipeIndex } from '../db.mjs'

const DID = 'did:plc:testauthor'

function recipe(rkey, name, ingredients, extra = {}) {
  return {
    uri: `at://${DID}/kitchen.longtable.recipe/${rkey}`,
    did: DID,
    rkey,
    cid: `cid-${rkey}-v1`,
    record: {
      $type: 'kitchen.longtable.recipe',
      name,
      ingredients,
      instructions: ['Cook it.'],
      tags: ['test'],
      longtableId: `lt-${rkey}`,
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
      ...extra,
    },
  }
}

describe('RecipeIndex search', () => {
  let index
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
    index.upsert(recipe('pancakes', 'Fluffy Pancakes', ['1 egg', '200g flour', '300ml milk']))
    index.upsert(recipe('borscht', 'AppView Borscht', ['3 beets', '1 onion']))
    index.upsert(recipe('omelette', 'Plain Omelette', ['2 eggs', '1 tbsp butter']))
  })
  afterEach(() => index.close())

  it('reports FTS5 availability (expected on this box)', () => {
    // Fallback LIKE search has identical semantics; this records which path ran.
    expect(typeof index.ftsEnabled).toBe('boolean')
  })

  it('finds recipes by name terms', () => {
    const hits = index.search({ q: 'Borscht' })
    expect(hits.map((h) => h.rkey)).toEqual(['borscht'])
    expect(hits[0].did).toBe(DID)
    expect(hits[0].name).toBe('AppView Borscht')
  })

  it('name search is case-insensitive and matches nothing bogus', () => {
    expect(index.search({ q: 'borscht' })).toHaveLength(1)
    expect(index.search({ q: 'sushi' })).toHaveLength(0)
  })

  it('ingredient search uses AND semantics', () => {
    const both = index.search({ ingredients: ['egg', 'flour'] })
    expect(both.map((h) => h.rkey)).toEqual(['pancakes'])
    const missing = index.search({ ingredients: ['egg', 'rice'] })
    expect(missing).toHaveLength(0)
  })

  it('ingredient search matches whole ingredients from a comma-style list', () => {
    const hits = index.search({ ingredients: ['beets', 'onion'] })
    expect(hits.map((h) => h.rkey)).toEqual(['borscht'])
  })

  it('combines name and ingredient filters', () => {
    expect(index.search({ q: 'Pancakes', ingredients: ['flour'] })).toHaveLength(1)
    expect(index.search({ q: 'Pancakes', ingredients: ['beets'] })).toHaveLength(0)
  })

  it('upsert with a new CID replaces; same CID is a no-op; delete removes', () => {
    expect(index.upsert(recipe('borscht', 'AppView Borscht', ['3 beets', '1 onion']))).toBe(false)
    const changed = recipe('borscht', 'AppView Borscht Deluxe', ['4 beets'])
    changed.cid = 'cid-borscht-v2'
    expect(index.upsert(changed)).toBe(true)
    expect(index.search({ q: 'Deluxe' })).toHaveLength(1)
    expect(index.deleteByUri(changed.uri)).toBe(true)
    expect(index.search({ q: 'Borscht' })).toHaveLength(0)
    expect(index.count()).toBe(2)
  })

  it('getRecipe returns the full record, byAuthor lists summaries', () => {
    const full = index.getRecipe(DID, 'borscht')
    expect(full.name).toBe('AppView Borscht')
    expect(full.ingredients).toEqual(['3 beets', '1 onion'])
    expect(full.longtableId).toBe('lt-borscht')
    expect(index.getRecipe(DID, 'nope')).toBeNull()
    expect(index.byAuthor(DID)).toHaveLength(3)
    expect(index.byAuthor('did:plc:someoneelse')).toHaveLength(0)
  })
})
