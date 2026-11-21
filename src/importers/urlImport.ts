import type { RecipeInput } from '../types'
import { blobToDataUrl, MAX_PHOTO_BYTES } from './photoImport'

/**
 * URL recipe importer.
 *
 * SECURITY/AUDIT NOTE: this module contains the ONLY fetch() calls in the
 * entire Longtable Phase 0 app. URL import is strictly user-initiated
 * (paste a link, tap "Fetch") and clearly labeled in the UI. Everything
 * else in the app works fully offline; there are no CDN fonts, no
 * analytics, and no other external requests.
 *
 * PHOTOS (H10): a page's photo URLs are NOT stored as remote URLs. A
 * stored `https://…` photo can never be published (publishRecipe only
 * uploads data URLs), breaks offline viewing, and points at a server
 * the author does not control. So the importer fetches each photo,
 * checks it is really an image under the byte cap, and stores the
 * downscaled data URL via the photoImport path — the same path local
 * attaches use. A photo that cannot be fetched, is not an image, or is
 * over the cap is DROPPED and named in `photoWarnings`; the recipe
 * still imports (a photo is never worth losing the recipe over).
 */

/** Longest a photo fetch may hang before the photo is dropped. */
export const PHOTO_FETCH_TIMEOUT_MS = 15_000
/** Most photos kept from one page (matches the store's per-recipe cap). */
export const MAX_URL_PHOTOS = 20

/** What a URL import returns: the prefill plus any photos left out. */
export interface UrlImportResult {
  recipe: Partial<RecipeInput>
  /** One plain sentence per photo dropped, naming the URL + the reason. */
  photoWarnings: string[]
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface UrlImportOptions {
  /** Fetch implementation (default: global fetch). Injectable for tests. */
  fetchFn?: FetchFn
  /**
   * Downscale fetched bytes to a data URL (default: photoImport's
   * blobToDataUrl). Injectable for tests — node/jsdom have no canvas.
   */
  toDataUrl?: (blob: Blob) => Promise<string>
}

export class UrlImportError extends Error {
  readonly code: 'network' | 'http' | 'parse'
  constructor(code: 'network' | 'http' | 'parse', message: string) {
    super(message)
    this.name = 'UrlImportError'
    this.code = code
  }
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new UrlImportError('parse', 'Paste a recipe page URL first.')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withScheme).toString()
  } catch {
    throw new UrlImportError('parse', 'That does not look like a valid URL.')
  }
}

/** Fetch a page and prefill recipe fields from its metadata. */
export async function importRecipeFromUrl(
  rawUrl: string,
  options: UrlImportOptions = {},
): Promise<UrlImportResult> {
  const fetchFn: FetchFn =
    options.fetchFn ?? ((url, init) => fetch(url, init))
  const url = normalizeUrl(rawUrl)
  let res: Response
  try {
    res = await fetchFn(url, { headers: { accept: 'text/html,application/xhtml+xml' } })
  } catch {
    // A failed fetch in the browser is almost always CORS (or the host being
    // unreachable); either way the page cannot be read cross-origin.
    throw new UrlImportError(
      'network',
      'Could not read that page — the site blocked cross-origin reading. ' +
        'Copy the ingredients and steps by hand instead.',
    )
  }
  if (!res.ok) {
    throw new UrlImportError('http', `The page returned HTTP ${res.status}.`)
  }
  const html = await res.text()
  const recipe = parseRecipeHtml(html, url)
  // H10: re-host the page's photos as data URLs (see the header). The
  // recipe text imports even when every photo is dropped.
  const { photos, warnings } = await fetchRemotePhotos(
    recipe.photos ?? [],
    options,
  )
  return { recipe: { ...recipe, photos }, photoWarnings: warnings }
}

/**
 * Fetch remote photo URLs and re-host them as data URLs. Each failure
 * drops just that photo and records a warning — a photo host being down
 * must never lose the recipe. `fetchFn`/`toDataUrl` come from
 * UrlImportOptions (see importRecipeFromUrl).
 */
export async function fetchRemotePhotos(
  urls: string[],
  options: UrlImportOptions = {},
): Promise<{ photos: string[]; warnings: string[] }> {
  const fetchFn: FetchFn =
    options.fetchFn ?? ((url, init) => fetch(url, init))
  const toDataUrl = options.toDataUrl ?? blobToDataUrl
  const photos: string[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const raw of urls) {
    const href = raw.trim()
    if (!href || seen.has(href)) continue
    seen.add(href)
    if (photos.length >= MAX_URL_PHOTOS) {
      warnings.push(
        `Photo ${href} was left out: only the first ${MAX_URL_PHOTOS} photos from a page are kept.`,
      )
      continue
    }
    try {
      const res = await fetchFn(href, {
        signal: AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS),
      })
      if (!res.ok) {
        warnings.push(`Photo ${href} was left out: the photo server returned HTTP ${res.status}.`)
        continue
      }
      const contentType = res.headers?.get?.('content-type') ?? ''
      if (contentType && !contentType.toLowerCase().startsWith('image/')) {
        warnings.push(
          `Photo ${href} was left out: the server returned ${contentType.split(';')[0] || 'a non-image response'}, not an image.`,
        )
        continue
      }
      const declared = Number(res.headers?.get?.('content-length') ?? '')
      if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) {
        warnings.push(
          `Photo ${href} was left out: it is larger than the ${MAX_PHOTO_BYTES / (1024 * 1024)} MB photo limit.`,
        )
        continue
      }
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength > MAX_PHOTO_BYTES) {
        warnings.push(
          `Photo ${href} was left out: it is larger than the ${MAX_PHOTO_BYTES / (1024 * 1024)} MB photo limit.`,
        )
        continue
      }
      if (buf.byteLength === 0) {
        warnings.push(`Photo ${href} was left out: the server returned an empty file.`)
        continue
      }
      const blob = new Blob([buf.buffer as ArrayBuffer], {
        type: contentType.split(';')[0].trim() || 'image/jpeg',
      })
      photos.push(await toDataUrl(blob))
    } catch (e) {
      // Timeout, CORS, DNS, a downscale failure — the photo is dropped
      // and the reason is named; the import goes on without it.
      const why =
        e instanceof Error && e.name === 'TimeoutError'
          ? 'the photo server took too long to answer'
          : 'the photo could not be read (the photo server may block cross-origin reads)'
      warnings.push(`Photo ${href} was left out: ${why}.`)
    }
  }
  return { photos, warnings }
}

function metaContent(doc: Document, property: string): string | undefined {
  const el = doc.querySelector(`meta[property="${property}"], meta[name="${property}"]`)
  return el?.getAttribute('content')?.trim() || undefined
}

interface JsonLdRecipeNode {
  '@type'?: string | string[]
  name?: string
  recipeIngredient?: string[]
  recipeInstructions?: Array<string | { text?: string } | { itemListElement?: Array<{ text?: string }> }>
  image?: string | string[] | { url?: string } | Array<{ url?: string }>
  description?: string
}

function isRecipeNode(node: unknown): node is JsonLdRecipeNode {
  if (typeof node !== 'object' || node === null) return false
  const t = (node as JsonLdRecipeNode)['@type']
  const types = Array.isArray(t) ? t : [t]
  return types.some((x) => typeof x === 'string' && x.toLowerCase() === 'recipe')
}

function findRecipeNode(payload: unknown): JsonLdRecipeNode | undefined {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findRecipeNode(item)
      if (found) return found
    }
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) return undefined
  if (isRecipeNode(payload)) return payload
  const rec = payload as Record<string, unknown>
  // JSON-LD often nests the recipe under @graph.
  if (Array.isArray(rec['@graph'])) return findRecipeNode(rec['@graph'])
  return undefined
}

function stepsFromInstructions(
  instructions: JsonLdRecipeNode['recipeInstructions'],
): string[] {
  if (!instructions) return []
  const out: string[] = []
  for (const item of instructions) {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim())
    } else if (typeof item === 'object' && item !== null) {
      const step = item as { text?: string; itemListElement?: Array<{ text?: string }> }
      if (typeof step.text === 'string' && step.text.trim()) {
        out.push(step.text.trim())
      } else if (Array.isArray(step.itemListElement)) {
        for (const sub of step.itemListElement) {
          if (typeof sub?.text === 'string' && sub.text.trim()) out.push(sub.text.trim())
        }
      }
    }
  }
  return out
}

function photosFromImage(image: JsonLdRecipeNode['image']): string[] {
  if (!image) return []
  const urls: string[] = []
  const push = (u: unknown) => {
    if (typeof u === 'string' && u.trim()) urls.push(u.trim())
  }
  if (Array.isArray(image)) {
    for (const item of image) {
      if (typeof item === 'string') push(item)
      else if (typeof item === 'object' && item !== null) push((item as { url?: string }).url)
    }
  } else if (typeof image === 'string') {
    push(image)
  } else if (typeof image === 'object') {
    push(image.url)
  }
  // Photo URLs are resolved against the page URL here (relative image
  // URLs are common in JSON-LD); importRecipeFromUrl then fetches each
  // one and stores a data URL — remote URLs are never stored (H10).
  return urls
}

function parseJsonLdRecipe(doc: Document): JsonLdRecipeNode | undefined {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]')
  for (const script of scripts) {
    const text = script.textContent
    if (!text) continue
    try {
      const found = findRecipeNode(JSON.parse(text))
      if (found) return found
    } catch {
      // Malformed JSON-LD block — try the next one.
    }
  }
  return undefined
}

/** Parse OpenGraph tags + schema.org Recipe JSON-LD out of page HTML. Exported for tests. */
export function parseRecipeHtml(html: string, url: string): Partial<RecipeInput> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const jsonLd = parseJsonLdRecipe(doc)

  const title =
    jsonLd?.name?.trim() || metaContent(doc, 'og:title') || doc.title?.trim() || ''
  const ingredients = (jsonLd?.recipeIngredient ?? [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
  const steps = stepsFromInstructions(jsonLd?.recipeInstructions)
  // Resolve photo URLs against the page URL (relative image URLs are
  // common); importRecipeFromUrl fetches them from here.
  const resolvePhoto = (u: string): string => {
    try {
      return new URL(u, url).toString()
    } catch {
      return u
    }
  }
  const photos = photosFromImage(jsonLd?.image).map(resolvePhoto)
  const ogImage = metaContent(doc, 'og:image')
  if (photos.length === 0 && ogImage) photos.push(resolvePhoto(ogImage))

  const partial: Partial<RecipeInput> = {
    title,
    ingredients,
    steps,
    photos,
  }
  return partial
}
