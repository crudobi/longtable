/**
 * Importer registry + plugin loader (Importer API v1).
 *
 * Built-in importers register at module load. Drop-in plugins are plain
 * modules placed in `src/importers/plugins/` (see plugins/README.md and
 * docs/importers.md): they are discovered with import.meta.glob and loaded
 * lazily by `ensurePluginsLoaded()`. A plugin that fails to load or fails
 * the shape check is recorded in the plugin-issue list — shown in the
 * import UI — and skipped; it can never stop the app or other importers.
 *
 * `runImporter` is the only path from importer output to the cookbook:
 * it runs the importer, then validates EVERY returned recipe with the
 * contract validator. One bad recipe fails the whole run (nothing is
 * imported) with a plain-language message.
 */
import type { RecipeInput } from '../types'
import {
  ImporterError,
  assertImporterShape,
  validateImportedRecipe,
  type ImporterInput,
  type RecipeImporter,
} from './contract'
import { jsonImporter } from './jsonImporter'
import { mealieImporter } from './mealieImporter'
import { urlImporterAdapter } from './urlImporterAdapter'

const registry = new Map<string, RecipeImporter>()

/** Register an importer. Throws (a developer error) on a bad shape or id clash. */
export function registerImporter(importer: RecipeImporter): void {
  assertImporterShape(importer)
  if (registry.has(importer.id)) {
    throw new Error(`duplicate importer id: ${importer.id}`)
  }
  registry.set(importer.id, importer)
}

export function listImporters(): RecipeImporter[] {
  return [...registry.values()]
}

export function getImporter(id: string): RecipeImporter | undefined {
  return registry.get(id)
}

// Built-ins.
registerImporter(urlImporterAdapter)
registerImporter(jsonImporter)
registerImporter(mealieImporter)

// ---------------------------------------------------------------------------
// Drop-in plugins
// ---------------------------------------------------------------------------

export interface PluginIssue {
  file: string
  message: string
}

const pluginIssues: PluginIssue[] = []
let pluginsLoaded = false

/** Load every module in ./plugins exactly once. Never rejects. */
export async function ensurePluginsLoaded(): Promise<void> {
  if (pluginsLoaded) return
  pluginsLoaded = true
  const modules = import.meta.glob('./plugins/*.{ts,tsx,js,mjs}', { eager: false })
  for (const [file, load] of Object.entries(modules)) {
    try {
      const mod = (await load()) as { default?: unknown; importer?: unknown }
      const candidate = mod.default ?? mod.importer
      assertImporterShape(candidate)
      if (registry.has(candidate.id)) {
        throw new Error(`an importer with id "${candidate.id}" is already registered`)
      }
      registry.set(candidate.id, candidate)
    } catch (e) {
      pluginIssues.push({
        file,
        message: e instanceof Error ? e.message : String(e),
      })
      console.warn(`[longtable] importer plugin ${file} not loaded:`, e)
    }
  }
}

/** Plugins that failed to load, with the reason — surfaced in the import UI. */
export function listPluginIssues(): PluginIssue[] {
  return [...pluginIssues]
}

// ---------------------------------------------------------------------------
// Running an import
// ---------------------------------------------------------------------------

/** Longest plugin-thrown message the UI will show. */
const PLUGIN_MESSAGE_MAX = 300

/**
 * Does this text look like raw machine output rather than a sentence
 * written for a user? Mirrors friendlyError's looksRaw heuristic —
 * duplicated here on purpose: friendlyError imports this package's
 * contract, so importing it back from here would close a cycle.
 */
function looksRawMessage(message: string): boolean {
  return (
    /^\s*[{[]/.test(message) ||
    /\s+at\s+\S+/.test(message) || // stack frames ("… at fn (file:1:2)")
    /HTTP \d{3}\b/.test(message) ||
    /^(TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(message)
  )
}

/**
 * Make a plugin-thrown message safe to show: collapse it to one line,
 * strip control characters, cap it at PLUGIN_MESSAGE_MAX characters.
 * Returns null when nothing showable remains — empty text, or text that
 * looks like raw machine output (a stack trace, a JSON blob, …) — so the
 * caller falls back to its generic failure sentence instead.
 */
export function sanitizePluginMessage(raw: string): string | null {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned || looksRawMessage(cleaned)) return null
  return cleaned.length > PLUGIN_MESSAGE_MAX
    ? `${cleaned.slice(0, PLUGIN_MESSAGE_MAX - 1).trimEnd()}…`
    : cleaned
}

/**
 * Run an importer and validate its output. Resolves with the recipes as
 * app-ready `RecipeInput[]`; rejects with an `ImporterError` whose message
 * is safe to show the user. Nothing is saved by this function — the caller
 * creates the recipes only after the whole run validates.
 */
export async function runImporter(
  id: string,
  input: ImporterInput,
): Promise<{ importer: RecipeImporter; recipes: RecipeInput[] }> {
  const importer = registry.get(id)
  if (!importer) throw new ImporterError('That importer is not available.')
  if (!importer.accepts.includes(input.kind)) {
    throw new ImporterError(`${importer.name} can't use ${input.kind} input.`)
  }
  let raw: unknown
  try {
    raw = await importer.import(input)
  } catch (e) {
    // ImporterErrors (thrown by the contract validator and built-ins) are
    // written for users and pass through as-is. A plugin's own Error is
    // also shown — that is the documented contract (docs/importers.md) —
    // after sanitization (see sanitizePluginMessage). Anything that
    // isn't an Error becomes the plain generic failure.
    if (e instanceof ImporterError) throw e
    if (e instanceof Error && e.name === 'UrlImportError') throw new ImporterError(e.message)
    if (e instanceof Error) {
      const msg = sanitizePluginMessage(e.message)
      if (msg) throw new ImporterError(msg)
    }
    throw new ImporterError(
      `${importer.name} failed — the source couldn't be read. Nothing was imported.`,
    )
  }
  if (!Array.isArray(raw)) {
    throw new ImporterError(`${importer.name} returned something that isn't a list of recipes. Nothing was imported.`)
  }
  if (raw.length === 0) {
    throw new ImporterError(`${importer.name} found no recipes in that source. Nothing was imported.`)
  }
  const recipes = raw.map((r, i) => validateImportedRecipe(r, importer.name, i))
  return { importer, recipes }
}
