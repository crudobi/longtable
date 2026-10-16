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
}

/**
 * One recipe as an importer returns it. Exactly the app's `RecipeInput`
 * fields. Extra source fields (description, yield, tags, …) are NOT part
 * of API v1: the local recipe shape doesn't store them yet, so importers
 * should fold anything essential into the title/ingredients/steps.
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
  return out
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
  return {
    title,
    ingredients: cleanStringList(r.ingredients, 'ingredients', source),
    steps: cleanStringList(r.steps, 'steps', source),
    prepMinutes: cleanMinutes(r.prepMinutes, 'prepMinutes', source),
    cookMinutes: cleanMinutes(r.cookMinutes, 'cookMinutes', source),
    photos: cleanPhotos(r.photos, source),
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
