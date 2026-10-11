import type { RecipeInput } from '../types'

/**
 * URL recipe importer.
 *
 * SECURITY/AUDIT NOTE: this module contains the ONLY fetch() call in the
 * entire Longtable Phase 0 app. URL import is strictly user-initiated
 * (paste a link, tap "Fetch") and clearly labeled in the UI. Everything
 * else in the app works fully offline; there are no CDN fonts, no
 * analytics, and no other external requests.
 */

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
export async function importRecipeFromUrl(rawUrl: string): Promise<Partial<RecipeInput>> {
  const url = normalizeUrl(rawUrl)
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'text/html,application/xhtml+xml' } })
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
  return parseRecipeHtml(html, url)
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
  // Remote photo URLs are kept as URLs (prefill only); the user can attach
  // local photos via the photo importer, which stores data URLs in the doc.
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
export function parseRecipeHtml(html: string, _url: string): Partial<RecipeInput> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const jsonLd = parseJsonLdRecipe(doc)

  const title =
    jsonLd?.name?.trim() || metaContent(doc, 'og:title') || doc.title?.trim() || ''
  const ingredients = (jsonLd?.recipeIngredient ?? [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
  const steps = stepsFromInstructions(jsonLd?.recipeInstructions)
  const photos = photosFromImage(jsonLd?.image)
  const ogImage = metaContent(doc, 'og:image')
  if (photos.length === 0 && ogImage) photos.push(ogImage)

  const partial: Partial<RecipeInput> = {
    title,
    ingredients,
    steps,
    photos,
  }
  void _url
  return partial
}
