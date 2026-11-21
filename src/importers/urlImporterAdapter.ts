/**
 * The built-in web-page importer, expressed in the Importer API v1
 * contract. Wraps `importRecipeFromUrl` (JSON-LD / OpenGraph parsing) so
 * the import UI offers it alongside file importers. In the recipe form the
 * same underlying importer is used in "prefill" mode via UrlImportDialog;
 * through the registry it creates a recipe directly, so a page with no
 * recipe title fails validation visibly instead of importing a stub —
 * and so does a title-only page with no ingredients and no steps (M15:
 * a bare title is not a recipe, it is a stub).
 */
import {
  IMPORTER_API_VERSION,
  ImporterError,
  type ImporterInput,
  type ImportedRecipe,
  type RecipeImporter,
} from './contract'
import { importRecipeFromUrl } from './urlImport'

export const urlImporterAdapter: RecipeImporter = {
  apiVersion: IMPORTER_API_VERSION,
  id: 'web-page',
  name: 'Web page',
  description: 'Fetch a recipe page and read its recipe data (JSON-LD / OpenGraph).',
  accepts: ['url'],
  async import(input: ImporterInput): Promise<ImportedRecipe[]> {
    const url = (input.url ?? '').trim()
    if (!url) throw new ImporterError('Paste a recipe page URL first.')
    const partial = await importRecipeFromUrl(url)
    if (
      (partial.ingredients?.length ?? 0) === 0 &&
      (partial.steps?.length ?? 0) === 0
    ) {
      throw new ImporterError(
        `The page “${partial.title || url}” has a title but no ingredients or steps — nothing was imported. Try a recipe page, or copy the ingredients and steps by hand.`,
      )
    }
    return [
      {
        title: partial.title ?? '',
        ingredients: partial.ingredients ?? [],
        steps: partial.steps ?? [],
        prepMinutes: partial.prepMinutes,
        cookMinutes: partial.cookMinutes,
        photos: partial.photos ?? [],
        ...(partial.description ? { description: partial.description } : {}),
        ...(partial.recipeYield ? { recipeYield: partial.recipeYield } : {}),
        ...(partial.tags ? { tags: partial.tags } : {}),
        ...(partial.author ? { author: partial.author } : {}),
        ...(partial.sourceUrl ? { sourceUrl: partial.sourceUrl } : {}),
      },
    ]
  },
}
