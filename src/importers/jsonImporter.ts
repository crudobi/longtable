/**
 * Reference importer: Longtable JSON files.
 *
 * The simplest possible file format — the app's own recipe shape as JSON.
 * Accepts a single recipe object, an array of recipe objects, or an
 * object with a "recipes" array. Field aliases from the public record
 * format (`name` / `instructions` / `prepTimeMinutes` / `cookTimeMinutes`)
 * are accepted alongside the canonical names (`title` / `steps` /
 * `prepMinutes` / `cookMinutes`), so a `kitchen.longtable.recipe` record
 * saved to a file imports as-is.
 *
 * Format documentation: docs/importers.md.
 */
import {
  IMPORTER_API_VERSION,
  ImporterError,
  type ImporterInput,
  type ImportedRecipe,
  type RecipeImporter,
} from './contract'

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function mapOne(raw: unknown, index: number): ImportedRecipe {
  const o = asObject(raw)
  if (!o) {
    throw new ImporterError(`Longtable JSON, recipe ${index + 1}: not a JSON object.`)
  }
  const title = o.title ?? o.name
  const steps = o.steps ?? o.instructions
  return {
    title: typeof title === 'string' ? title : '',
    ingredients: (o.ingredients ?? []) as string[],
    steps: (steps ?? []) as string[],
    prepMinutes: (o.prepMinutes ?? o.prepTimeMinutes) as number | undefined,
    cookMinutes: (o.cookMinutes ?? o.cookTimeMinutes) as number | undefined,
    photos: o.photos as string[] | undefined,
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
