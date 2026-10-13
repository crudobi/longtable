/**
 * Reference importer: Mealie recipe exports.
 *
 * Mealie (self-hosted recipe manager) exports each recipe as a JSON file
 * (`recipe.json` inside its backup .zip — unzip it, then import the
 * recipe.json here). The shape is schema.org-flavored:
 *
 *   {
 *     "name": "Pancakes",
 *     "recipeIngredient": ["200 g flour", …],
 *     "recipeInstructions": [{"@type": "HowToStep", "text": "Mix."}, …],
 *     "prepTime": "PT15M", "cookTime": "PT30M",   // ISO-8601 durations
 *     "recipeYield": "4 servings",
 *     "image": "pancakes.jpg"                     // a file name, not data
 *   }
 *
 * Instructions may be HowToStep objects, HowToSection groups (flattened,
 * in order), or plain strings. The `image` field names a file inside the
 * Mealie backup rather than carrying image data, so it is not imported —
 * attach the photo afterwards if you have it.
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

/** Parse an ISO-8601 duration ("PT1H30M", "PT45M", "PT90S") to minutes. */
export function isoDurationToMinutes(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value)
  }
  if (typeof value !== 'string') return undefined
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    value.trim(),
  )
  if (!m) return undefined
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  const minutes = Number(m[3] ?? 0)
  const seconds = Number(m[4] ?? 0)
  const total = days * 1440 + hours * 60 + minutes + seconds / 60
  return total > 0 ? Math.round(total) : undefined
}

function stepsFromInstructions(instructions: unknown): string[] {
  if (!Array.isArray(instructions)) return []
  const out: string[] = []
  const walk = (item: unknown) => {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim())
      return
    }
    if (typeof item !== 'object' || item === null) return
    const o = item as Record<string, unknown>
    if (typeof o.text === 'string' && o.text.trim()) out.push(o.text.trim())
    if (Array.isArray(o.itemListElement)) o.itemListElement.forEach(walk)
  }
  instructions.forEach(walk)
  return out
}

function mapMealie(raw: unknown, index: number): ImportedRecipe {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ImporterError(`Mealie import, recipe ${index + 1}: not a JSON object.`)
  }
  const o = raw as Record<string, unknown>
  const looksMealie =
    Array.isArray(o.recipeIngredient) || Array.isArray(o.recipeInstructions)
  if (!looksMealie) {
    throw new ImporterError(
      `Mealie import, recipe ${index + 1}: this doesn't look like a Mealie recipe — ` +
        'it has no "recipeIngredient" or "recipeInstructions" list.',
    )
  }
  const prep = isoDurationToMinutes(o.prepTime)
  let cook = isoDurationToMinutes(o.cookTime)
  if (cook === undefined) {
    // Fall back to totalTime minus prep when only the total is given.
    const total = isoDurationToMinutes(o.totalTime)
    if (total !== undefined) cook = Math.max(0, total - (prep ?? 0))
  }
  const ingredients = Array.isArray(o.recipeIngredient)
    ? o.recipeIngredient.filter((x): x is string => typeof x === 'string')
    : []
  return {
    title: typeof o.name === 'string' ? o.name : '',
    ingredients,
    steps: stepsFromInstructions(o.recipeInstructions),
    prepMinutes: prep,
    cookMinutes: cook,
  }
}

export const mealieImporter: RecipeImporter = {
  apiVersion: IMPORTER_API_VERSION,
  id: 'mealie-json',
  name: 'Mealie export',
  description: 'A recipe.json from a Mealie backup (unzip the backup first). Photos are not included.',
  accepts: ['file', 'text'],
  fileExtensions: ['.json'],
  async import(input: ImporterInput): Promise<ImportedRecipe[]> {
    const text = (input.text ?? '').trim()
    if (!text) throw new ImporterError('No Mealie JSON to import — choose a file or paste the JSON first.')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ImporterError('That is not valid JSON — a Mealie recipe.json should be plain JSON.')
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) throw new ImporterError('The JSON list is empty — no recipes to import.')
      return parsed.map(mapMealie)
    }
    return [mapMealie(parsed, 0)]
  },
}
