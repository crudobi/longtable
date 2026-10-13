/**
 * Discovery — Phase 3.
 *
 * Reads public recipes through the hub AppView (a filtered, indexed view
 * over the testnet firehose — clients never crawl PDSes themselves):
 *
 *   searchAppView(appViewUrl, {q, ingredients}) → result summaries
 *   fetchPublicRecipe(appViewUrl, did, rkey)    → the full record
 *   publicRecordToInput(record, fetchBlob)      → a local RecipeInput, so
 *                                                 "Save a copy" lands an
 *                                                 ordinary local recipe
 *
 * The AppView responses are normalized defensively (flat or nested record,
 * `results`/`recipes`/bare-array envelopes) so the client tolerates the
 * hub's exact envelope choices.
 */
import type { RecipeInput } from '../types'
import { AtprotoError, type AtprotoBlob } from './atproto'
import { bytesToDataUrl, type RecipeRecord } from './publish'

export type { RecipeRecord }

export interface PublicSearchResult {
  did: string
  rkey: string
  uri?: string
  cid?: string
  title: string
  ingredients: string[]
  description?: string
}

/** A full public record plus its authoring account DID + rkey. */
export type PublicRecipe = RecipeRecord & { did: string; rkey: string; uri?: string }

export interface SearchQuery {
  q?: string
  ingredients?: string[] | string
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

async function getJson(
  fetchFn: FetchFn,
  url: string,
): Promise<{ status: number; data: unknown }> {
  const res = await fetchFn(url)
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* empty / non-JSON body */
  }
  return { status: res.status, data }
}

function didFromUri(uri: unknown): string {
  if (typeof uri !== 'string') return ''
  // at://did:plc:xxx/collection/rkey
  const m = /^at:\/\/([^/]+)\//.exec(uri)
  return m ? m[1] : ''
}

function rkeyFromUri(uri: unknown): string {
  if (typeof uri !== 'string') return ''
  const parts = uri.split('/')
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function normalizeResult(raw: unknown): PublicSearchResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const rec = (typeof o.record === 'object' && o.record !== null
    ? (o.record as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const did =
    (typeof o.did === 'string' && o.did) ||
    (typeof o.authorDid === 'string' && o.authorDid) ||
    (typeof o.author === 'string' && o.author) ||
    didFromUri(o.uri)
  const rkey =
    (typeof o.rkey === 'string' && o.rkey) || rkeyFromUri(o.uri) ||
    (typeof rec.longtableId === 'string' ? rec.longtableId : '')
  if (!did || !rkey) return null
  const title =
    (typeof o.title === 'string' && o.title) ||
    (typeof o.name === 'string' && o.name) ||
    (typeof rec.name === 'string' && rec.name) ||
    '(untitled)'
  const ingredients = asStringArray(o.ingredients ?? rec.ingredients)
  const description =
    (typeof o.description === 'string' && o.description) ||
    (typeof rec.description === 'string' && rec.description) ||
    undefined
  return {
    did,
    rkey,
    uri: typeof o.uri === 'string' ? o.uri : undefined,
    cid: typeof o.cid === 'string' ? o.cid : undefined,
    title,
    ingredients,
    description,
  }
}

/**
 * Search the AppView. `q` matches recipe names; `ingredients` (array or
 * comma-separated string) matches ingredient text.
 */
export async function searchAppView(
  appViewUrl: string,
  query: SearchQuery = {},
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): Promise<PublicSearchResult[]> {
  const base = trimSlash(appViewUrl)
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  const ings = Array.isArray(query.ingredients)
    ? query.ingredients
    : query.ingredients
      ? query.ingredients.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  if (ings.length > 0) params.set('ingredients', ings.join(','))
  const qs = params.toString()
  const suffix = qs ? `?${qs}` : ''

  let { status, data } = await getJson(fetchFn, `${base}/search${suffix}`)
  if (status === 404) {
    ;({ status, data } = await getJson(fetchFn, `${base}/api/search${suffix}`))
  }
  if (status < 200 || status >= 300) {
    throw new AtprotoError(`AppView search failed (${status})`, status)
  }
  const list: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { results?: unknown[] })?.results)
      ? (data as { results: unknown[] }).results
      : Array.isArray((data as { recipes?: unknown[] })?.recipes)
        ? (data as { recipes: unknown[] }).recipes
        : []
  return list
    .map(normalizeResult)
    .filter((r): r is PublicSearchResult => r !== null)
}

/** Fetch one full public record from the AppView by author DID + rkey. */
export async function fetchPublicRecipe(
  appViewUrl: string,
  did: string,
  rkey: string,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): Promise<PublicRecipe> {
  const base = trimSlash(appViewUrl)
  const attempts = [
    `${base}/recipe/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`,
    `${base}/recipe?${new URLSearchParams({ did, rkey }).toString()}`,
    `${base}/recipes/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`,
  ]
  let lastStatus = 0
  for (const url of attempts) {
    const { status, data } = await getJson(fetchFn, url)
    lastStatus = status
    if (status === 404) continue
    if (status < 200 || status >= 300) {
      throw new AtprotoError(`AppView recipe fetch failed (${status})`, status)
    }
    const o = (typeof data === 'object' && data !== null ? data : {}) as Record<
      string,
      unknown
    >
    const recRaw =
      (typeof o.record === 'object' && o.record !== null ? o.record : null) ??
      (typeof o.value === 'object' && o.value !== null ? o.value : null) ??
      (typeof o.recipe === 'object' && o.recipe !== null ? o.recipe : null) ??
      o
    const rec = recRaw as RecipeRecord
    // The AppView indexes optional fields as SQL NULLs — normalize to absent.
    const clean = { ...rec } as Record<string, unknown>
    for (const k of Object.keys(clean)) {
      if (clean[k] === null) delete clean[k]
    }
    return {
      ...(clean as unknown as RecipeRecord),
      ingredients: asStringArray(rec.ingredients),
      instructions: asStringArray(rec.instructions),
      did:
        (typeof o.did === 'string' && o.did) ||
        (typeof o.authorDid === 'string' && o.authorDid) ||
        did,
      rkey: (typeof o.rkey === 'string' && o.rkey) || rkey,
      uri: typeof o.uri === 'string' ? o.uri : undefined,
    }
  }
  throw new AtprotoError(`public recipe not found (${lastStatus})`, lastStatus || 404)
}

/**
 * Convert a public record into a local RecipeInput for "Save a copy".
 * `fetchBlobDataUrl(cid)` resolves one image blob to a data URL (the
 * caller wires it to the author's PDS via com.atproto.sync.getBlob);
 * blobs that fail to load are skipped, never fatal.
 */
export async function publicRecordToInput(
  record: PublicRecipe | RecipeRecord,
  fetchBlobDataUrl?: (cid: string, blob: AtprotoBlob) => Promise<string>,
): Promise<RecipeInput> {
  const photos: string[] = []
  if (fetchBlobDataUrl) {
    for (const blob of record.images ?? []) {
      try {
        photos.push(await fetchBlobDataUrl(blob.ref.$link, blob))
      } catch {
        /* skip an unloadable photo; the text recipe still copies */
      }
    }
  }
  return {
    title: record.name,
    ingredients: [...(record.ingredients ?? [])],
    steps: [...(record.instructions ?? [])],
    photos,
    prepMinutes: record.prepTimeMinutes,
    cookMinutes: record.cookTimeMinutes,
  }
}

/** Build a data URL for one blob fetched as raw bytes. */
export function blobBytesToDataUrl(bytes: Uint8Array, blob: AtprotoBlob): string {
  return bytesToDataUrl(bytes, blob.mimeType || 'image/jpeg')
}
