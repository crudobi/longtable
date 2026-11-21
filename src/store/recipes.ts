import * as Y from 'yjs'
import { INDEX_GUID, docUrl, getOrCreateDoc, getRepo, guidFromUrl } from './repo'
import type { YjsStore } from './repo'
import type {
  Recipe,
  RecipeIndexDoc,
  RecipeInput,
  RecipePatch,
  RecipeSummary,
} from '../types'

const INDEX_URL_KEY = 'longtable:recipe-index-url'
export const RECIPE_MAP = 'recipe'
const INDEX_MAP = 'recipes'

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
 * Opaque handle for the recipe index document (replaces Automerge's
 * `DocHandle<RecipeIndexDoc>`). `doc()` returns a plain-object snapshot —
 * Yjs types never leak to callers.
 */
export interface IndexHandle {
  /** Stable URL of the index document (`yjs:longtable-index`). */
  url: string
  doc(): Promise<RecipeIndexDoc | null>
}

interface IndexEntry {
  title: string
  url: string
  updatedAt: string
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Bounds for recipe fields persisted by the store (S9). These match the
 * importer contract (src/importers/contract.ts: MAX_TITLE 500, MAX_ITEMS
 * 500, MAX_ITEM 2000, photos capped at 20): anything a friend share or a
 * share code hands us is held to the same limits as an imported file, so
 * a malicious or buggy peer cannot persist unbounded strings or huge
 * arrays into IndexedDB and the render path. Over-long text values are
 * truncated (arrays are cut to the cap, non-string entries dropped);
 * only a non-string title is rejected — a recipe without a usable title
 * cannot be listed or opened. Photos are the exception: they are data
 * URLs, kept whole and capped by COUNT only (see cleanPhotos) — slicing
 * one corrupts the image.
 */
export const RECIPE_LIMITS = {
  titleChars: 500,
  listItems: 500,
  itemChars: 2000,
  photos: 20,
} as const

/** Whole, non-negative minutes or undefined. Non-numeric, negative, or
 * non-finite values are dropped (a missing minute is harmless; a NaN
 * minute is poison). Fractional values round (H-N3): the AppView serves
 * minutes truncated, so a stored fraction would make a published recipe
 * permanently unverifiable — no fractional minute ever reaches the store.
 */
function cleanMinutesValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined
  }
  return Math.round(value)
}

function cleanStringList(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    out.push(item.slice(0, RECIPE_LIMITS.itemChars))
    if (out.length >= RECIPE_LIMITS.listItems) break
  }
  return out
}

/**
 * Photos are data URLs (or web URLs), not short text: a real photo is
 * tens to hundreds of kilobytes of base64, so slicing one to
 * RECIPE_LIMITS.itemChars corrupts it — the <img> then renders with
 * naturalWidth 0 (caught by the migration proof: a 46 KB fixture photo
 * is a ~61 KB data URL, sliced to a 2000-char stub). Keep entries
 * whole, cap the COUNT at RECIPE_LIMITS.photos, and drop non-strings
 * and anything that is not a data:image/ URL or an http(s) URL — the
 * same shape rule as the importer contract (cleanPhotos in
 * src/importers/contract.ts).
 */
function cleanPhotos(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    if (item.startsWith('data:image/') || /^https?:\/\//i.test(item)) out.push(item)
    if (out.length >= RECIPE_LIMITS.photos) break
  }
  return out
}

/**
 * Validate + cap a recipe input before persistence. Throws on a
 * non-string title; truncates everything else to RECIPE_LIMITS; rounds
 * minutes (H-N3). Applied by createRecipe, so the friends-share upsert
 * path (service.ts upsertReceived) is covered without trusting the
 * decrypted payload's shape.
 */
export function sanitizeRecipeInput(input: RecipeInput): RecipeInput {
  if (typeof input.title !== 'string') {
    throw new Error('Recipe title must be text.')
  }
  const out: RecipeInput = {
    title: input.title.slice(0, RECIPE_LIMITS.titleChars),
    ingredients: cleanStringList(input.ingredients),
    steps: cleanStringList(input.steps),
    photos: cleanPhotos(input.photos),
  }
  if (input.visibility !== undefined) out.visibility = input.visibility
  const prep = cleanMinutesValue(input.prepMinutes)
  if (prep !== undefined) out.prepMinutes = prep
  const cook = cleanMinutesValue(input.cookMinutes)
  if (cook !== undefined) out.cookMinutes = cook
  return out
}

/**
 * Validate + cap a partial recipe patch before persistence. Same rules
 * as sanitizeRecipeInput, preserving the patch's "key present" signals:
 * an explicitly-undefined minutes field still clears the field, and an
 * invalid minutes value clears it too (dropped, never stored as NaN).
 */
export function sanitizeRecipePatch(patch: RecipePatch): RecipePatch {
  const out: RecipePatch = {}
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string') {
      throw new Error('Recipe title must be text.')
    }
    out.title = patch.title.slice(0, RECIPE_LIMITS.titleChars)
  }
  if ('visibility' in patch) out.visibility = patch.visibility
  if (patch.ingredients !== undefined) out.ingredients = cleanStringList(patch.ingredients)
  if (patch.steps !== undefined) out.steps = cleanStringList(patch.steps)
  if (patch.photos !== undefined) {
    out.photos = cleanPhotos(patch.photos)
  }
  if ('prepMinutes' in patch) out.prepMinutes = cleanMinutesValue(patch.prepMinutes)
  if ('cookMinutes' in patch) out.cookMinutes = cleanMinutesValue(patch.cookMinutes)
  return out
}

function strArray(items: string[]): Y.Array<string> {
  const arr = new Y.Array<string>()
  arr.push(items)
  return arr
}

/**
 * Build a nested Y.Map for an index entry. (Yjs does NOT auto-convert plain
 * objects set as map values — they land as inert `Object`s — so the Y.Map
 * must be constructed explicitly for the entry to be a real CRDT map.)
 */
function entryMap(entry: IndexEntry): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  m.set('title', entry.title)
  m.set('url', entry.url)
  m.set('updatedAt', entry.updatedAt)
  return m
}

function toStringArray(value: unknown): string[] {
  if (value instanceof Y.Array) {
    return (value.toArray() as unknown[]).filter(
      (x): x is string => typeof x === 'string',
    )
  }
  return []
}

function replaceArray(map: Y.Map<unknown>, key: string, items: string[]): void {
  const cur = map.get(key)
  if (cur instanceof Y.Array) {
    // If the content is identical, do nothing: delete+push would mint new
    // Yjs item IDs for the same strings, which breaks concurrent merge
    // (a peer holding the old IDs would see duplicates after sync).
    const current = cur.toArray() as string[]
    if (current.length === items.length && current.every((v, i) => v === items[i])) {
      return
    }
    cur.delete(0, cur.length)
    cur.push(items)
  } else {
    map.set(key, strArray(items))
  }
}

function snapshotIndex(doc: Y.Doc): RecipeIndexDoc {
  const recipes: Record<string, IndexEntry> = {}
  doc.getMap(INDEX_MAP).forEach((raw, id) => {
    if (raw instanceof Y.Map) {
      const e = raw.toJSON() as IndexEntry
      if (
        typeof e.title === 'string' &&
        typeof e.url === 'string' &&
        typeof e.updatedAt === 'string'
      ) {
        recipes[id] = { title: e.title, url: e.url, updatedAt: e.updatedAt }
      }
    }
  })
  return { recipes }
}

/**
 * Load the dedicated index document (recipe list -> doc URLs), creating it on
 * first run. The index URL itself is kept in the provided key/value store.
 */
export async function getOrCreateIndex(
  repo: YjsStore = getRepo(),
  kv: KeyValueStore = localStorage,
): Promise<IndexHandle> {
  const url = docUrl(INDEX_GUID)
  if (!kv.getItem(INDEX_URL_KEY)) {
    kv.setItem(INDEX_URL_KEY, url)
  }
  const doc = await getOrCreateDoc(repo, INDEX_GUID)
  return {
    url,
    doc: async () => snapshotIndex(doc),
  }
}

/** Create one Y.Doc for the recipe and register it in the index. */
export async function createRecipe(
  repo: YjsStore,
  // Named for call-shape compatibility; the index doc is resolved from the
  // store (its guid is deterministic), so the handle itself is not needed here.
  _index: IndexHandle,
  input: RecipeInput,
  // Optional preserved timestamps (used by the Phase 0 recovery migration so
  // an imported recipe keeps its original created/updated times). Defaults
  // to "now" for normal creation.
  timestamps?: { createdAt?: string; updatedAt?: string },
): Promise<RecipeSummary> {
  // Central validation/caps (S9): the friends-share upsert path funnels
  // through here, so unbounded or mistyped fields are rejected/truncated
  // before they reach IndexedDB or the render path.
  input = sanitizeRecipeInput(input)
  const id = crypto.randomUUID()
  const createdAt = timestamps?.createdAt ?? nowIso()
  const updatedAt = timestamps?.updatedAt ?? createdAt
  // Fresh UUID: the document cannot already exist in IndexedDB.
  const doc = await getOrCreateDoc(repo, id)
  doc.transact(() => {
    const map = doc.getMap(RECIPE_MAP)
    map.set('title', input.title)
    map.set('ingredients', strArray(input.ingredients))
    map.set('steps', strArray(input.steps))
    map.set('photos', strArray(input.photos))
    map.set('createdAt', createdAt)
    map.set('updatedAt', updatedAt)
    if (input.visibility !== undefined) map.set('visibility', input.visibility)
    // Only set optional fields when present.
    if (input.prepMinutes !== undefined) map.set('prepMinutes', input.prepMinutes)
    if (input.cookMinutes !== undefined) map.set('cookMinutes', input.cookMinutes)
  })

  const url = docUrl(id)
  const summary: RecipeSummary = { id, title: input.title, url, updatedAt }
  const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
  indexDoc.transact(() => {
    indexDoc
      .getMap(INDEX_MAP)
      .set(id, entryMap({ title: input.title, url, updatedAt }))
  })
  return summary
}

/**
 * Restore one recipe under a GIVEN id with GIVEN content and timestamps
 * (Wave 3 C3: the encrypted backup restores recipes under their original
 * ids, so the vault, share records, and received-shares mapping — all
 * keyed by recipe id — keep working with no remapping). Like
 * createRecipe, but the id is the caller's, not a fresh UUID; an
 * existing doc under that id is overwritten in place. The index entry
 * is (re)registered with the restored timestamps.
 */
export async function restoreRecipe(
  repo: YjsStore,
  // Named for call-shape compatibility; the index doc is resolved from
  // the store (its guid is deterministic), so the handle itself is not needed here.
  _index: IndexHandle,
  id: string,
  recipe: Recipe,
): Promise<RecipeSummary> {
  const input = sanitizeRecipeInput({
    title: recipe.title,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    photos: recipe.photos,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    visibility: recipe.visibility,
  })
  const createdAt = typeof recipe.createdAt === 'string' && recipe.createdAt ? recipe.createdAt : nowIso()
  const updatedAt = typeof recipe.updatedAt === 'string' && recipe.updatedAt ? recipe.updatedAt : createdAt
  const doc = await getOrCreateDoc(repo, id)
  doc.transact(() => {
    const map = doc.getMap(RECIPE_MAP)
    map.set('title', input.title)
    map.set('ingredients', strArray(input.ingredients))
    map.set('steps', strArray(input.steps))
    map.set('photos', strArray(input.photos))
    map.set('createdAt', createdAt)
    map.set('updatedAt', updatedAt)
    if (input.visibility !== undefined) map.set('visibility', input.visibility)
    else map.delete('visibility')
    if (input.prepMinutes !== undefined) map.set('prepMinutes', input.prepMinutes)
    else map.delete('prepMinutes')
    if (input.cookMinutes !== undefined) map.set('cookMinutes', input.cookMinutes)
    else map.delete('cookMinutes')
  })
  const url = docUrl(id)
  const summary: RecipeSummary = { id, title: input.title, url, updatedAt }
  const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
  indexDoc.transact(() => {
    indexDoc.getMap(INDEX_MAP).set(id, entryMap({ title: input.title, url, updatedAt }))
  })
  return summary
}

/**
 * Register a recipe received via P2P share in the local index so it appears
 * in the list. The document content itself arrives via Yjs sync; this only
 * adds the index entry. Idempotent — a second join is a no-op.
 */
export async function registerSharedRecipe(
  repo: YjsStore,
  id: string,
  title: string,
): Promise<void> {
  const url = docUrl(id)
  const updatedAt = new Date().toISOString()
  const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
  indexDoc.transact(() => {
    const map = indexDoc.getMap(INDEX_MAP)
    if (!map.has(id)) {
      map.set(id, entryMap({ title, url, updatedAt }))
    }
  })
}

/** List all recipes (newest first) from the index document. */
export async function listRecipes(index: IndexHandle): Promise<RecipeSummary[]> {
  const snap = await index.doc()
  if (!snap) return []
  return Object.entries(snap.recipes)
    .map(([id, entry]) => ({
      id,
      title: entry.title,
      url: entry.url,
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Load a full recipe document by its `yjs:` URL. Returns a plain object. */
export async function getRecipe(repo: YjsStore, url: string): Promise<Recipe | null> {
  const guid = guidFromUrl(url)
  if (!guid) return null
  const doc = await getOrCreateDoc(repo, guid)
  const map = doc.getMap(RECIPE_MAP)
  const title = map.get('title')
  // A missing title means the document holds no recipe (e.g. deleted).
  if (typeof title !== 'string') return null
  const createdAt = map.get('createdAt')
  const updatedAt = map.get('updatedAt')
  return {
    title,
    ingredients: toStringArray(map.get('ingredients')),
    steps: toStringArray(map.get('steps')),
    photos: toStringArray(map.get('photos')),
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    ...(map.get('visibility') === 'friends-only'
      ? { visibility: 'friends-only' as const }
      : map.get('visibility') === 'public'
        ? { visibility: 'public' as const }
        : {}),
    ...(map.has('prepMinutes') ? { prepMinutes: map.get('prepMinutes') as number } : {}),
    ...(map.has('cookMinutes') ? { cookMinutes: map.get('cookMinutes') as number } : {}),
  }
}

/** Patch a recipe document and refresh its index entry. */
export async function updateRecipe(
  repo: YjsStore,
  index: IndexHandle,
  id: string,
  patch: RecipePatch,
): Promise<void> {
  // Defense in depth (H-N3 + S9): fractional minutes are rounded and
  // oversized/mistyped fields capped/rejected here as well as at the form,
  // so no write path can persist them.
  patch = sanitizeRecipePatch(patch)
  const snap = await index.doc()
  const entry = snap?.recipes[id]
  if (!entry) throw new Error(`recipe not found: ${id}`)

  const doc = await getOrCreateDoc(repo, guidFromUrl(entry.url) ?? id)
  const updatedAt = nowIso()
  doc.transact(() => {
    const map = doc.getMap(RECIPE_MAP)
    // Skip scalar writes whose value is unchanged (same rationale as
    // replaceArray's identical-content guard): map.set() mints a new Yjs
    // item even for an identical value, and that item is a *concurrent*
    // write against any peer edit made while partitioned. Y.Map conflict
    // resolution awards the key to the item from the higher clientID, so
    // an unchanged-value write from the higher-ID peer silently reverts
    // the other peer's genuine edit on merge. That was the proof-p2p
    // post-heal flake: a form save re-wrote the old title, and whenever
    // the saver's random per-install clientID outranked the renamer's,
    // both devices converged onto the pre-rename title.
    const setIfChanged = (key: string, value: unknown) => {
      if (map.get(key) !== value) map.set(key, value)
    }
    if (patch.title !== undefined) setIfChanged('title', patch.title)
    if ('visibility' in patch) {
      if (patch.visibility === undefined || patch.visibility === 'private') {
        map.delete('visibility')
      } else {
        setIfChanged('visibility', patch.visibility)
      }
    }
    if (patch.ingredients !== undefined) replaceArray(map, 'ingredients', patch.ingredients)
    if (patch.steps !== undefined) replaceArray(map, 'steps', patch.steps)
    if (patch.photos !== undefined) replaceArray(map, 'photos', patch.photos)
    // Optional fields are only touched when the patch explicitly mentions them,
    // so a partial patch never clobbers them; explicit `undefined` clears.
    if ('prepMinutes' in patch) {
      if (patch.prepMinutes === undefined) {
        map.delete('prepMinutes')
      } else {
        setIfChanged('prepMinutes', patch.prepMinutes)
      }
    }
    if ('cookMinutes' in patch) {
      if (patch.cookMinutes === undefined) {
        map.delete('cookMinutes')
      } else {
        setIfChanged('cookMinutes', patch.cookMinutes)
      }
    }
    map.set('updatedAt', updatedAt)
  })
  const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
  indexDoc.transact(() => {
    indexDoc.getMap(INDEX_MAP).set(
      id,
      entryMap({
        title: patch.title !== undefined ? patch.title : entry.title,
        url: entry.url,
        updatedAt,
      }),
    )
  })
}

/**
 * Remove a recipe from the index and wipe its Y.Doc from IndexedDB so it no
 * longer loads. Other recipes are untouched.
 */
export async function deleteRecipe(
  repo: YjsStore,
  index: IndexHandle,
  id: string,
): Promise<void> {
  const snap = await index.doc()
  const entry = snap?.recipes[id]
  if (!entry) return
  const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
  indexDoc.transact(() => {
    indexDoc.getMap(INDEX_MAP).delete(id)
  })
  const guid = guidFromUrl(entry.url)
  if (!guid) return
  // Ensure the doc is loaded so we hold its persistence, then destroy the
  // persistence and delete the doc's IndexedDB database.
  await getOrCreateDoc(repo, guid)
  const cached = repo.docs.get(guid)
  repo.docs.delete(guid)
  repo.pending.delete(guid)
  if (cached) {
    await cached.persistence.clearData()
  }
}
