/**
 * Importer plugin contract — Longtable Importer API v1.
 *
 * An importer is a self-contained module that turns source material (a
 * file's text, pasted text, or a URL) into recipes in the app's shape
 * (`RecipeInput`). Importers never touch the store, the network (beyond
 * fetching a user-supplied URL), or any other part of the app: input in,
 * recipe data out. The app validates every returned recipe with
 * `validateImportedRecipe` before anything is saved, so a broken or
 * malicious importer can fail visibly but can never corrupt the cookbook.
 *
 * Developer documentation: docs/importers.md.
 */
import type { RecipeInput } from '../types'

/** The plugin API version this app implements. Importers must declare it. */
export const IMPORTER_API_VERSION = 1

/** Where an importer's source material comes from. */
export type ImporterInputKind = 'file' | 'text' | 'url'

export interface ImporterInput {
  kind: ImporterInputKind
  /** File contents as text, or pasted text. Present for 'file' and 'text'. */
  text?: string
  /** Original file name (kind 'file' only) — useful for format sniffing. */
  fileName?: string
  /** File MIME type (kind 'file' only), when the browser knows it. */
  mimeType?: string
  /** The page to fetch (kind 'url' only). */
  url?: string
  /**
   * Optional app-provided resolver for image CIDs (M-N6): when an
   * importer returns `imageCids` (e.g. a saved public record's
   * `images[].ref.$link`), `runImporter` calls this for each CID and
   * stores the returned data URL as a photo. It receives only the CID
   * string; it returns a `data:image/…` URL, or null when the blob
   * cannot be fetched. Importers never call it themselves — the
   * registry does, after validation. Absent when the caller has no
   * blob source (a bare JSON file carries no author DID to fetch
   * from), in which case the photos are left out and warned about.
   */
  resolveImageCid?: (cid: string) => Promise<string | null>
}

/**
 * One recipe as an importer returns it. The app's `RecipeInput` fields
 * plus the optional descriptive fields the store now keeps
 * (`description`, `recipeYield`, `tags`, `author`, `sourceUrl`) — a
 * source that records them no longer has to drop them or fold them
 * into the steps. `imageCids` and `warnings` are import-time only:
 * they never reach the store (see below).
 */
export interface ImportedRecipe {
  title: string
  ingredients: string[]
  steps: string[]
  /** Optional, minutes. */
  prepMinutes?: number
  /** Optional, minutes. */
  cookMinutes?: number
  /** Data URLs or http(s) URLs. Anything else is dropped by validation. */
  photos?: string[]
  /**
   * Sharing tier, when the source records one (Wave 3 C3: the
   * longtable-json export writes it, so an export round-trips with its
   * tier intact). Importers that do not set it leave the recipe
   * private, as before.
   */
  visibility?: 'private' | 'friends-only' | 'public'
  /** Free-text description, when the source records one. */
  description?: string
  /** Yield as written in the source ("4 servings"), when recorded. */
  recipeYield?: string
  /** Tags / keywords / categories, when the source records them. */
  tags?: string[]
  /** Author name as written in the source, when recorded. */
  author?: string
  /** The page or file the recipe came from, when known. */
  sourceUrl?: string
  /**
   * Photo CIDs the importer could not turn into bytes itself (M-N6: a
   * saved `kitchen.longtable.recipe` record carries photos as
   * `images[].ref.$link`). `runImporter` resolves these through
   * `input.resolveImageCid` when one is provided; otherwise it warns
   * that the photos were left out. Never stored as-is — a bare CID is
   * not a renderable photo.
   */
  imageCids?: string[]
  /**
   * Non-fatal notes for the user (M20: a Markdown recipe with no
   * steps; M21: a Mealie `image` file name that could not be fetched).
   * `runImporter` collects these and the Import panel shows them
   * alongside the success message; the import itself still lands.
   */
  warnings?: string[]
}

export interface RecipeImporter {
  /** Must equal IMPORTER_API_VERSION (1). */
  apiVersion: number
  /** Stable, unique, kebab-case — shown in diagnostics, never renamed. */
  id: string
  /** Human-readable name shown in the import UI. */
  name: string
  /** One line shown under the name in the import UI. */
  description?: string
  /** Which input kinds this importer can consume (at least one). */
  accepts: ImporterInputKind[]
  /** File picker filter, e.g. ['.json', '.md'] (kind 'file' only). */
  fileExtensions?: string[]
  /**
   * Do the import. May return one recipe or many (a file can hold a whole
   * collection). Throw an `Error` with a plain-language message on any
   * problem — the app shows it (sanitized: one line, control characters
   * stripped, capped at 300 characters; anything that looks like raw
   * machine output, e.g. a stack trace, is replaced with a generic
   * failure sentence) and imports nothing.
   */
  import: (input: ImporterInput) => Promise<ImportedRecipe[]> | ImportedRecipe[]
}

/** An importer failure the user should see. Message must be plain language. */
export class ImporterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImporterError'
  }
}

// ---------------------------------------------------------------------------
// Import limits (integrity M17). A malicious or buggy source cannot make
// the app persist unbounded data: photos are capped by count and by
// decoded bytes, recipes per run are capped, and the file picker caps
// the file itself (ImportPanel checks MAX_IMPORT_FILE_BYTES before
// reading). Over-cap input fails the run visibly — it is never silently
// truncated, so the user knows something was left out.
// ---------------------------------------------------------------------------

/** At most this many photos on one imported recipe. */
export const MAX_IMPORT_PHOTOS = 20
/** At most this many decoded bytes in one imported photo (5 MiB). */
export const MAX_IMPORT_PHOTO_BYTES = 5 * 1024 * 1024
/** At most this many recipes in one import run. */
export const MAX_IMPORT_RECIPES = 500
/** At most this many bytes in a file chosen in the Import panel (10 MiB). */
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024
/** At most this many characters in an imported description. */
export const MAX_IMPORT_DESCRIPTION_CHARS = 5000
/** At most this many characters in an imported yield string. */
export const MAX_IMPORT_YIELD_CHARS = 200
/** At most this many characters in an imported author name. */
export const MAX_IMPORT_AUTHOR_CHARS = 200
/** At most this many tags on one imported recipe. */
export const MAX_IMPORT_TAGS = 50
/** At most this many characters in one imported tag. */
export const MAX_IMPORT_TAG_CHARS = 200

// ---------------------------------------------------------------------------
// Validation — the app's side of the contract. Every recipe an importer
// returns passes through here before it can become a stored recipe.
// ---------------------------------------------------------------------------

const MAX_TITLE = 500
const MAX_ITEMS = 500
const MAX_ITEM = 2000

function cleanStringList(value: unknown, field: string, source: string): string[] {
  if (!Array.isArray(value)) {
    throw new ImporterError(`${source}: "${field}" must be a list.`)
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ImporterError(`${source}: every "${field}" entry must be text.`)
    }
    const trimmed = item.trim()
    if (!trimmed) continue
    if (trimmed.length > MAX_ITEM) {
      throw new ImporterError(`${source}: a "${field}" entry is too long (${trimmed.length} characters).`)
    }
    out.push(trimmed)
  }
  if (out.length > MAX_ITEMS) {
    throw new ImporterError(`${source}: too many "${field}" entries (${out.length}).`)
  }
  return out
}

function cleanMinutes(value: unknown, field: string, source: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new ImporterError(`${source}: "${field}" must be a number of minutes (0 or more).`)
  }
  return Math.round(n)
}

/** Approximate decoded byte size of a data URL (base64 inflates by 4/3). */
export function dataUrlApproxBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return dataUrl.length
  const head = dataUrl.slice(0, comma)
  const body = dataUrl.slice(comma + 1)
  if (/;base64$/i.test(head)) {
    const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor((body.length * 3) / 4) - padding)
  }
  // Non-base64 data URLs (e.g. URL-encoded SVG): the text is the payload.
  return body.length
}

function cleanPhotos(value: unknown, source: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ImporterError(`${source}: "photos" must be a list.`)
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ImporterError(`${source}: every "photos" entry must be text.`)
    }
    // Only data URLs and web URLs survive; anything else (file paths,
    // javascript:, blobs from another origin) is dropped, not stored.
    if (item.startsWith('data:image/') || /^https?:\/\//i.test(item)) out.push(item)
  }
  if (out.length > MAX_IMPORT_PHOTOS) {
    throw new ImporterError(
      `${source}: too many photos (${out.length}; at most ${MAX_IMPORT_PHOTOS}).`,
    )
  }
  for (let i = 0; i < out.length; i++) {
    const item = out[i]
    if (item.startsWith('data:image/')) {
      const bytes = dataUrlApproxBytes(item)
      if (bytes > MAX_IMPORT_PHOTO_BYTES) {
        throw new ImporterError(
          `${source}: photo ${i + 1} is too large (about ${Math.round(bytes / 1048576)} MB; at most 5 MB).`,
        )
      }
    }
  }
  return out
}

function cleanText(
  value: unknown,
  field: string,
  source: string,
  maxChars: number,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ImporterError(`${source}: "${field}" must be text.`)
  }
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > maxChars) {
    throw new ImporterError(`${source}: "${field}" is too long (${trimmed.length} characters).`)
  }
  return trimmed
}

function cleanTags(value: unknown, source: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new ImporterError(`${source}: "tags" must be a list.`)
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ImporterError(`${source}: every "tags" entry must be text.`)
    }
    const trimmed = item.trim()
    if (!trimmed) continue
    if (trimmed.length > MAX_IMPORT_TAG_CHARS) {
      throw new ImporterError(`${source}: a "tags" entry is too long (${trimmed.length} characters).`)
    }
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  if (out.length > MAX_IMPORT_TAGS) {
    throw new ImporterError(`${source}: too many "tags" entries (${out.length}).`)
  }
  return out.length > 0 ? out : undefined
}

function cleanSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  // Only web URLs survive; anything else is dropped, not stored.
  if (!/^https?:\/\//i.test(trimmed) || trimmed.length > 2000) return undefined
  return trimmed
}

/**
 * Normalize a yield value from a source format into the plain string the
 * store keeps: "4 servings" stays as-is; a bare number becomes "4"; a
 * list like ["4", "servings"] joins with spaces. Anything else yields
 * undefined (the field is optional — an unparseable yield is dropped,
 * never stored as "[object Object]").
 */
export function normalizeRecipeYield(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) {
    const parts = value.filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean)
    return parts.length > 0 ? parts.join(' ') : undefined
  }
  return undefined
}

/**
 * Normalize a tags/categories value into a deduped string list: plain
 * strings stay; objects with a `name` string contribute the name
 * (Mealie tags/categories are `{name, slug}` objects); anything else is
 * dropped. Returns undefined when nothing usable remains.
 */
export function normalizeTags(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const tags = value.split(',').map((t) => t.trim()).filter(Boolean)
    return tags.length > 0 ? [...new Set(tags)] : undefined
  }
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (trimmed && !out.includes(trimmed)) out.push(trimmed)
    } else if (typeof item === 'object' && item !== null) {
      const name = (item as Record<string, unknown>).name
      if (typeof name === 'string') {
        const trimmed = name.trim()
        if (trimmed && !out.includes(trimmed)) out.push(trimmed)
      }
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Validate one importer-returned recipe and normalize it to the app's
 * `RecipeInput`. Throws `ImporterError` with a plain-language message
 * naming the importer and the problem. `index` is the recipe's position
 * in the importer's result, for messages like "recipe 2 has no title".
 */
export function validateImportedRecipe(
  raw: unknown,
  importerName: string,
  index = 0,
): RecipeInput {
  const source = `${importerName}, recipe ${index + 1}`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ImporterError(`${source}: not a recipe object.`)
  }
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title) {
    throw new ImporterError(`${source}: missing a title.`)
  }
  if (title.length > MAX_TITLE) {
    throw new ImporterError(`${source}: the title is too long (${title.length} characters).`)
  }
  const description = cleanText(r.description, 'description', source, MAX_IMPORT_DESCRIPTION_CHARS)
  const recipeYield = cleanText(r.recipeYield, 'recipeYield', source, MAX_IMPORT_YIELD_CHARS)
  const tags = cleanTags(r.tags, source)
  const author = cleanText(r.author, 'author', source, MAX_IMPORT_AUTHOR_CHARS)
  const sourceUrl = cleanSourceUrl(r.sourceUrl)
  return {
    title,
    ingredients: cleanStringList(r.ingredients, 'ingredients', source),
    steps: cleanStringList(r.steps, 'steps', source),
    prepMinutes: cleanMinutes(r.prepMinutes, 'prepMinutes', source),
    cookMinutes: cleanMinutes(r.cookMinutes, 'cookMinutes', source),
    photos: cleanPhotos(r.photos, source),
    // A tier the source recorded (e.g. a longtable-json export) survives
    // validation; anything else is not a tier and is dropped, never stored.
    ...(r.visibility === 'private' || r.visibility === 'friends-only' || r.visibility === 'public'
      ? { visibility: r.visibility }
      : {}),
    // Descriptive fields the store keeps (M15/M21): validated and
    // capped like everything else, never silently invented.
    ...(description ? { description } : {}),
    ...(recipeYield ? { recipeYield } : {}),
    ...(tags ? { tags } : {}),
    ...(author ? { author } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  }
}

/**
 * Check an importer's own shape (used when registering built-ins and when
 * loading drop-in plugins). Throws a plain `Error` describing what's wrong.
 */
export function assertImporterShape(candidate: unknown): asserts candidate is RecipeImporter {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('not an object — an importer module must export an importer object')
  }
  const imp = candidate as Partial<RecipeImporter>
  if (imp.apiVersion !== IMPORTER_API_VERSION) {
    throw new Error(
      `declares plugin API v${String(imp.apiVersion)}; this app supports v${IMPORTER_API_VERSION}`,
    )
  }
  if (typeof imp.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(imp.id)) {
    throw new Error('"id" must be a kebab-case string like "my-importer"')
  }
  if (typeof imp.name !== 'string' || !imp.name.trim()) {
    throw new Error('"name" must be a non-empty string')
  }
  if (
    !Array.isArray(imp.accepts) ||
    imp.accepts.length === 0 ||
    !imp.accepts.every((k) => k === 'file' || k === 'text' || k === 'url')
  ) {
    throw new Error('"accepts" must list at least one of "file", "text", "url"')
  }
  if (typeof imp.import !== 'function') {
    throw new Error('"import" must be a function')
  }
}
