import type { AutomergeUrl, DocHandle, Repo } from '@automerge/automerge-repo'
import { getRepo } from './repo'
import type {
  Recipe,
  RecipeIndexDoc,
  RecipeInput,
  RecipePatch,
  RecipeSummary,
} from '../types'

const INDEX_URL_KEY = 'longtable:recipe-index-url'

/** Minimal key/value store (localStorage in the app, in-memory in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
  }
}

/**
 * Load the dedicated index document (recipe list -> doc URLs), creating it on
 * first run. The index URL itself is kept in the provided key/value store.
 */
export async function getOrCreateIndex(
  repo: Repo = getRepo(),
  kv: KeyValueStore = localStorage,
): Promise<DocHandle<RecipeIndexDoc>> {
  const stored = kv.getItem(INDEX_URL_KEY)
  if (stored) {
    return repo.find<RecipeIndexDoc>(stored as AutomergeUrl)
  }
  const handle = repo.create<RecipeIndexDoc>({ recipes: {} })
  kv.setItem(INDEX_URL_KEY, handle.url)
  return handle
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Create one Automerge document for the recipe and register it in the index. */
export async function createRecipe(
  repo: Repo,
  index: DocHandle<RecipeIndexDoc>,
  input: RecipeInput,
): Promise<RecipeSummary> {
  const createdAt = nowIso()
  const doc: Recipe = {
    title: input.title,
    ingredients: [...input.ingredients],
    steps: [...input.steps],
    photos: [...input.photos],
    createdAt,
    updatedAt: createdAt,
  }
  // Automerge rejects `undefined` values, so only set optional fields when present.
  if (input.prepMinutes !== undefined) doc.prepMinutes = input.prepMinutes
  if (input.cookMinutes !== undefined) doc.cookMinutes = input.cookMinutes

  const handle = repo.create<Recipe>(doc)
  const id = handle.documentId
  const summary: RecipeSummary = {
    id,
    title: input.title,
    url: handle.url,
    updatedAt: createdAt,
  }
  index.change((d) => {
    d.recipes[id] = { title: input.title, url: handle.url, updatedAt: createdAt }
  })
  return summary
}

/** List all recipes (newest first) from the index document. */
export async function listRecipes(index: DocHandle<RecipeIndexDoc>): Promise<RecipeSummary[]> {
  const doc = await index.doc()
  if (!doc) return []
  return Object.entries(doc.recipes)
    .map(([id, entry]) => ({
      id,
      title: entry.title,
      url: entry.url,
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Load a full recipe document by its Automerge URL. Returns plain (unfrozen) data. */
export async function getRecipe(repo: Repo, url: string): Promise<Recipe | null> {
  const handle = await repo.find<Recipe>(url as AutomergeUrl)
  const doc = await handle.doc()
  if (!doc) return null
  return {
    title: doc.title,
    ingredients: [...doc.ingredients],
    steps: [...doc.steps],
    photos: [...doc.photos],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(doc.prepMinutes !== undefined ? { prepMinutes: doc.prepMinutes } : {}),
    ...(doc.cookMinutes !== undefined ? { cookMinutes: doc.cookMinutes } : {}),
  }
}

/** Patch a recipe document and refresh its index entry. */
export async function updateRecipe(
  repo: Repo,
  index: DocHandle<RecipeIndexDoc>,
  id: string,
  patch: RecipePatch,
): Promise<void> {
  const idx = await index.doc()
  const entry = idx?.recipes[id]
  if (!entry) throw new Error(`recipe not found: ${id}`)

  const handle = await repo.find<Recipe>(entry.url as AutomergeUrl)
  const updatedAt = nowIso()
  handle.change((d) => {
    if (patch.title !== undefined) d.title = patch.title
    if (patch.ingredients !== undefined) d.ingredients = patch.ingredients
    if (patch.steps !== undefined) d.steps = patch.steps
    if (patch.photos !== undefined) d.photos = patch.photos
    // Optional fields are only touched when the patch explicitly mentions them,
    // so a partial patch never clobbers them; explicit `undefined` clears.
    if ('prepMinutes' in patch) {
      if (patch.prepMinutes === undefined) {
        delete d.prepMinutes
      } else {
        d.prepMinutes = patch.prepMinutes
      }
    }
    if ('cookMinutes' in patch) {
      if (patch.cookMinutes === undefined) {
        delete d.cookMinutes
      } else {
        d.cookMinutes = patch.cookMinutes
      }
    }
    d.updatedAt = updatedAt
  })
  index.change((d) => {
    d.recipes[id].updatedAt = updatedAt
    if (patch.title !== undefined) d.recipes[id].title = patch.title
  })
}

/**
 * Remove a recipe from the index and delete its Automerge document so it no
 * longer loads from storage. Other recipes are untouched.
 */
export async function deleteRecipe(
  repo: Repo,
  index: DocHandle<RecipeIndexDoc>,
  id: string,
): Promise<void> {
  const idx = await index.doc()
  const entry = idx?.recipes[id]
  if (!entry) return
  index.change((d) => {
    delete d.recipes[id]
  })
  repo.delete(entry.url as AutomergeUrl)
}
