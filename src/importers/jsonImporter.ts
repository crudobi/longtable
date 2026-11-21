/**
 * Reference importer: Longtable JSON files.
 *
 * The simplest possible file format — the app's own recipe shape as JSON.
 * Accepts a single recipe object, an array of recipe objects, or an
 * object with a "recipes" array. Field aliases from the public record
 * format (`name` / `instructions` / `prepTimeMinutes` / `cookTimeMinutes`
 * / `recipeIngredient`) are accepted alongside the canonical names
 * (`title` / `steps` / `prepMinutes` / `cookMinutes` / `ingredients`),
 * so a `kitchen.longtable.recipe` record saved to a file imports as-is.
 *
 * A public record carries its photos as `images[].ref.$link` (blob
 * CIDs), not as `photos` data URLs (M-N6): those CIDs are surfaced as
 * `imageCids` on the returned recipe, and `runImporter` resolves them
 * through the caller's `resolveImageCid` when one is available — or
 * warns that the photos were left out when there is none. A bare JSON
 * file carries no author DID to fetch blobs from, so the Import panel
 * cannot resolve them; the CIDs are never silently dropped.
 *
 * Format documentation: docs/importers.md.
 */
import {
  IMPORTER_API_VERSION,
  ImporterError,
  normalizeRecipeYield,
  normalizeTags,
  type ImporterInput,
  type ImportedRecipe,
  type RecipeImporter,
} from './contract'

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/** First non-empty array among the candidates, else undefined. */
function firstNonEmptyList(...values: unknown[]): unknown[] | undefined {
  for (const v of values) {
    if (Array.isArray(v) && v.length > 0) return v
  }
  return undefined
}

/** A title as text: strings as-is, numbers/booleans stringified. */
function asTitle(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** An author name as text: a string, or an object with a `name` string. */
function asAuthor(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (typeof value === 'object' && value !== null) {
    const name = (value as Record<string, unknown>).name
    if (typeof name === 'string' && name.trim()) return name
  }
  return undefined
}

/**
 * Photo CIDs from a public record's `images` array: `{ref: {$link}}`
 * blob objects (the shape the publisher writes), `{ref: "<cid>"}`
 * objects, or bare CID strings. Anything else is ignored.
 */
export function imageCidsFromRecord(images: unknown): string[] {
  if (!Array.isArray(images)) return []
  const out: string[] = []
  for (const item of images) {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim())
    } else if (typeof item === 'object' && item !== null) {
      const ref = (item as Record<string, unknown>).ref
      if (typeof ref === 'string') {
        if (ref.trim()) out.push(ref.trim())
      } else if (typeof ref === 'object' && ref !== null) {
        const link = (ref as Record<string, unknown>).$link
        if (typeof link === 'string' && link.trim()) out.push(link.trim())
      }
    }
  }
  return out
}

function mapOne(raw: unknown, index: number): ImportedRecipe {
  const o = asObject(raw)
  if (!o) {
    throw new ImporterError(`Longtable JSON, recipe ${index + 1}: not a JSON object.`)
  }
  // A populated alias beats an empty canonical field (M16): `steps: []`
  // next to a populated `instructions` used to win and wipe the steps.
  // Likewise a numeric `title` with a string `name` used to yield ''
  // and throw "missing a title" — a number stringifies instead.
  const title = asTitle(o.title) || asTitle(o.name)
  const ingredients = firstNonEmptyList(o.ingredients, o.recipeIngredient) ?? []
  const steps = firstNonEmptyList(o.steps, o.instructions) ?? []
  const imageCids = imageCidsFromRecord(o.images)
  const visibility = o.visibility
  return {
    title,
    ingredients: ingredients as string[],
    steps: steps as string[],
    prepMinutes: (o.prepMinutes ?? o.prepTimeMinutes) as number | undefined,
    cookMinutes: (o.cookMinutes ?? o.cookTimeMinutes) as number | undefined,
    photos: o.photos as string[] | undefined,
    // The export writes the tier so a round-trip keeps it; only a real
    // tier passes through — anything else is dropped by validation.
    ...(visibility === 'private' || visibility === 'friends-only' || visibility === 'public'
      ? { visibility }
      : {}),
    ...(typeof o.description === 'string' && o.description.trim()
      ? { description: o.description }
      : {}),
    ...(normalizeRecipeYield(o.recipeYield)
      ? { recipeYield: normalizeRecipeYield(o.recipeYield)! }
      : {}),
    ...(normalizeTags(o.tags) ? { tags: normalizeTags(o.tags)! } : {}),
    ...(asAuthor(o.author) ? { author: asAuthor(o.author)! } : {}),
    ...(typeof o.sourceUrl === 'string' && o.sourceUrl.trim()
      ? { sourceUrl: o.sourceUrl }
      : {}),
    ...(imageCids.length > 0 ? { imageCids } : {}),
    // NB: invalid field types are caught by the app's validator, which
    // reports them with the recipe number — this importer only shapes data.
  }
}

export const jsonImporter: RecipeImporter = {
  apiVersion: IMPORTER_API_VERSION,
  id: 'longtable-json',
  name: 'JSON file',
  description: 'Recipes saved as JSON — one recipe, a list, or a {"recipes": […]} file.',
  accepts: ['file', 'text'],
  fileExtensions: ['.json'],
  async import(input: ImporterInput): Promise<ImportedRecipe[]> {
    const text = (input.text ?? '').trim()
    if (!text) throw new ImporterError('No JSON to import — choose a file or paste the JSON first.')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ImporterError('That is not valid JSON — check the file and try again.')
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) throw new ImporterError('The JSON list is empty — no recipes to import.')
      return parsed.map(mapOne)
    }
    const obj = asObject(parsed)
    if (obj && Array.isArray(obj.recipes)) {
      if (obj.recipes.length === 0) {
        throw new ImporterError('The "recipes" list is empty — no recipes to import.')
      }
      return obj.recipes.map(mapOne)
    }
    if (obj) return [mapOne(obj, 0)]
    throw new ImporterError('The JSON is not a recipe, a list of recipes, or a {"recipes": […]} file.')
  },
}
