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
 * in order, with the section name kept on the first step), plain
 * strings, or a single string. The `image` field names a file inside
 * the Mealie backup rather than carrying image data, so it cannot be
 * imported as a photo — the import warns about it instead of dropping
 * it silently (M21). An `image` that is already a web URL is kept as a
 * photo.
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
import { stepsFromInstructions } from './howtoSteps'
import { isoDurationToMinutes } from './isoDuration'

/** Kept for existing callers/tests: the shared ISO-8601 parser. */
export { isoDurationToMinutes } from './isoDuration'

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
  if (cook === undefined && prep !== undefined) {
    // Fall back to totalTime minus prep when only the total is given —
    // but only when prep is known (M21): deriving cook from the total
    // alone overstates it, because the total includes the prep.
    const total = isoDurationToMinutes(o.totalTime)
    if (total !== undefined && total > prep) cook = total - prep
  }
  const ingredients = Array.isArray(o.recipeIngredient)
    ? o.recipeIngredient.filter((x): x is string => typeof x === 'string')
    : []
  const warnings: string[] = []
  let photos: string[] | undefined
  if (typeof o.image === 'string' && o.image.trim()) {
    const image = o.image.trim()
    if (/^https?:\/\//i.test(image)) {
      photos = [image]
    } else {
      warnings.push(
        `Photo "${image}" is only a file name inside the Mealie backup, so it wasn't imported — attach the photo afterwards.`,
      )
    }
  }
  const tags = normalizeTags(o.tags)
  const categoryTags = normalizeTags(o.recipeCategory)
  const allTags =
    tags || categoryTags
      ? [...(tags ?? []), ...(categoryTags ?? []).filter((t) => !(tags ?? []).includes(t))]
      : undefined
  return {
    title: typeof o.name === 'string' ? o.name : '',
    ingredients,
    steps: stepsFromInstructions(o.recipeInstructions),
    prepMinutes: prep,
    cookMinutes: cook,
    ...(photos ? { photos } : {}),
    ...(typeof o.description === 'string' && o.description.trim()
      ? { description: o.description }
      : {}),
    ...(normalizeRecipeYield(o.recipeYield)
      ? { recipeYield: normalizeRecipeYield(o.recipeYield)! }
      : {}),
    ...(allTags && allTags.length > 0 ? { tags: allTags } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

export const mealieImporter: RecipeImporter = {
  apiVersion: IMPORTER_API_VERSION,
  id: 'mealie-json',
  name: 'Mealie export',
  description: 'A recipe.json from a Mealie backup (unzip the backup first). A photo file name is not imported — attach the photo afterwards.',
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
