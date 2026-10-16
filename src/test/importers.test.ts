/**
 * Importer API v1: contract validation, reference importers, registry.
 * Fixtures are hand-built to the documented formats (docs/importers.md).
 */
import { describe, expect, it } from 'vitest'
import {
  IMPORTER_API_VERSION,
  ImporterError,
  assertImporterShape,
  validateImportedRecipe,
  type RecipeImporter,
} from '../importers/contract'
import { jsonImporter } from '../importers/jsonImporter'
import { isoDurationToMinutes, mealieImporter } from '../importers/mealieImporter'
import {
  ensurePluginsLoaded,
  getImporter,
  listImporters,
  registerImporter,
  runImporter,
} from '../importers/registry'

describe('contract: validateImportedRecipe', () => {
  it('normalizes a well-formed recipe', () => {
    const out = validateImportedRecipe(
      {
        title: '  Soup  ',
        ingredients: [' water ', '', 'salt'],
        steps: ['Boil'],
        prepMinutes: 5.4,
        photos: ['data:image/png;base64,xx', 'https://x.test/a.jpg', 'file:///etc/passwd'],
      },
      'Test',
      0,
    )
    expect(out.title).toBe('Soup')
    expect(out.ingredients).toEqual(['water', 'salt'])
    expect(out.prepMinutes).toBe(5)
    // Non-web photo references are dropped, never stored.
    expect(out.photos).toEqual(['data:image/png;base64,xx', 'https://x.test/a.jpg'])
  })

  it('rejects a missing title with the recipe number', () => {
    expect(() => validateImportedRecipe({ ingredients: [], steps: [] }, 'Test', 1)).toThrow(
      /recipe 2: missing a title/,
    )
  })

  it('rejects non-list ingredients and negative minutes', () => {
    expect(() =>
      validateImportedRecipe({ title: 'X', ingredients: 'flour', steps: [] }, 'Test'),
    ).toThrow(ImporterError)
    expect(() =>
      validateImportedRecipe({ title: 'X', ingredients: [], steps: [], cookMinutes: -3 }, 'Test'),
    ).toThrow(/minutes/)
  })

  it('coerces numeric-string minutes', () => {
    const out = validateImportedRecipe(
      { title: 'X', ingredients: [], steps: [], prepMinutes: '15' },
      'Test',
    )
    expect(out.prepMinutes).toBe(15)
  })
})

describe('assertImporterShape', () => {
  const good: RecipeImporter = {
    apiVersion: IMPORTER_API_VERSION,
    id: 'ok-importer',
    name: 'OK',
    accepts: ['text'],
    import: () => [],
  }
  it('accepts a well-formed importer', () => {
    expect(() => assertImporterShape(good)).not.toThrow()
  })
  it('rejects a wrong API version, naming both versions', () => {
    expect(() => assertImporterShape({ ...good, apiVersion: 99 })).toThrow(/API v99.*v1/)
  })
  it('rejects bad ids and missing import()', () => {
    expect(() => assertImporterShape({ ...good, id: 'Not Kebab!' })).toThrow(/kebab/)
    expect(() => assertImporterShape({ ...good, import: undefined })).toThrow(/import/)
  })
})

describe('jsonImporter (Longtable JSON)', () => {
  it('imports a single recipe with canonical fields', async () => {
    const out = await jsonImporter.import({
      kind: 'text',
      text: JSON.stringify({
        title: 'Solo Soup',
        ingredients: ['water'],
        steps: ['Boil'],
        prepMinutes: 5,
      }),
    })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Solo Soup')
  })

  it('imports arrays and {"recipes": [...]} files, mapping record-style aliases', async () => {
    const arr = await jsonImporter.import({
      kind: 'text',
      text: JSON.stringify([{ name: 'A', recipeIngredient: undefined, ingredients: [], instructions: [] }]),
    })
    expect(arr[0].title).toBe('A')
    expect(arr[0].steps).toEqual([])
    const wrapped = await jsonImporter.import({
      kind: 'file',
      fileName: 'x.json',
      text: JSON.stringify({ recipes: [{ title: 'B', ingredients: ['x'], steps: ['y'] }] }),
    })
    expect(wrapped[0].title).toBe('B')
  })

  it('fails plainly on invalid JSON and empty input', async () => {
    await expect(jsonImporter.import({ kind: 'text', text: '{nope' })).rejects.toThrow(
      /not valid JSON/,
    )
    await expect(jsonImporter.import({ kind: 'text', text: '  ' })).rejects.toThrow(ImporterError)
    await expect(jsonImporter.import({ kind: 'text', text: '[]' })).rejects.toThrow(/empty/)
  })
})

describe('mealieImporter', () => {
  it('parses ISO-8601 durations', () => {
    expect(isoDurationToMinutes('PT15M')).toBe(15)
    expect(isoDurationToMinutes('PT1H30M')).toBe(90)
    expect(isoDurationToMinutes('PT90S')).toBe(2)
    expect(isoDurationToMinutes('P1DT2H')).toBe(1560)
    expect(isoDurationToMinutes('soon')).toBeUndefined()
    expect(isoDurationToMinutes(undefined)).toBeUndefined()
  })

  // Fixture modeled on a real Mealie recipe.json export.
  const mealieFixture = {
    id: '9b0e2d52-0000-4000-8000-000000000000',
    slug: 'weeknight-pancakes',
    name: 'Weeknight Pancakes',
    description: 'Fast pancakes.',
    recipeIngredient: ['200 g flour', '2 eggs', '300 ml milk'],
    recipeInstructions: [
      { '@type': 'HowToStep', text: 'Whisk the flour and eggs.' },
      {
        '@type': 'HowToSection',
        name: 'Cooking',
        itemListElement: [
          { '@type': 'HowToStep', text: 'Fry ladles of batter 2 minutes per side.' },
        ],
      },
      'Serve warm.',
    ],
    prepTime: 'PT10M',
    cookTime: 'PT15M',
    totalTime: 'PT25M',
    recipeYield: '4 servings',
    image: 'weeknight-pancakes.jpg',
    recipeCategory: [{ name: 'Breakfast', slug: 'breakfast' }],
    tags: [{ name: 'easy', slug: 'easy' }],
  }

  it('imports a Mealie recipe.json: fields, flattened sections, durations', async () => {
    const out = await mealieImporter.import({
      kind: 'file',
      fileName: 'recipe.json',
      text: JSON.stringify(mealieFixture),
    })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Weeknight Pancakes')
    expect(out[0].ingredients).toEqual(['200 g flour', '2 eggs', '300 ml milk'])
    expect(out[0].steps).toEqual([
      'Whisk the flour and eggs.',
      'Fry ladles of batter 2 minutes per side.',
      'Serve warm.',
    ])
    expect(out[0].prepMinutes).toBe(10)
    expect(out[0].cookMinutes).toBe(15)
    // The Mealie "image" file name is not imported as a photo.
    expect(out[0].photos).toBeUndefined()
  })

  it('derives cook time from totalTime when cookTime is absent', async () => {
    const out = await mealieImporter.import({
      kind: 'text',
      text: JSON.stringify({
        name: 'Totals Only',
        recipeIngredient: ['x'],
        recipeInstructions: [],
        prepTime: 'PT5M',
        totalTime: 'PT40M',
      }),
    })
    expect(out[0].cookMinutes).toBe(35)
  })

  it('fails plainly when the JSON is not a Mealie recipe', async () => {
    await expect(
      mealieImporter.import({ kind: 'text', text: JSON.stringify({ title: 'Nope' }) }),
    ).rejects.toThrow(/doesn't look like a Mealie recipe/)
  })
})

describe('registry', () => {
  it('registers the three built-in importers', () => {
    const ids = listImporters().map((i) => i.id)
    expect(ids).toContain('web-page')
    expect(ids).toContain('longtable-json')
    expect(ids).toContain('mealie-json')
    expect(getImporter('longtable-json')?.name).toBe('JSON file')
  })

  it('plugin loading resolves cleanly with an empty plugins dir', async () => {
    await expect(ensurePluginsLoaded()).resolves.toBeUndefined()
  })

  it('runImporter validates output and returns app-ready recipes', async () => {
    const { recipes } = await runImporter('longtable-json', {
      kind: 'text',
      text: JSON.stringify({ title: 'Via Registry', ingredients: ['a'], steps: ['b'] }),
    })
    expect(recipes).toEqual([
      { title: 'Via Registry', ingredients: ['a'], steps: ['b'], photos: [] },
    ])
  })

  it('runImporter fails the whole run on one bad recipe — nothing imports', async () => {
    await expect(
      runImporter('longtable-json', {
        kind: 'text',
        text: JSON.stringify([
          { title: 'Good', ingredients: [], steps: [] },
          { ingredients: [], steps: [] },
        ]),
      }),
    ).rejects.toThrow(/recipe 2: missing a title/)
  })

  it('runImporter rejects the wrong input kind and unknown importers', async () => {
    await expect(runImporter('longtable-json', { kind: 'url', url: 'https://x.test' })).rejects.toThrow(
      /can't use url input/,
    )
    await expect(runImporter('nope', { kind: 'text', text: '{}' })).rejects.toThrow(
      /not available/,
    )
  })
})

describe('registry: plugin error contract (M-L)', () => {
  registerImporter({
    apiVersion: IMPORTER_API_VERSION,
    id: 'test-plain-thrower',
    name: 'Plain thrower',
    accepts: ['text'],
    import: () => {
      throw new Error("This file ended early — row 12 has no title, so nothing could be read.")
    },
  })
  registerImporter({
    apiVersion: IMPORTER_API_VERSION,
    id: 'test-stack-thrower',
    name: 'Stack thrower',
    accepts: ['text'],
    import: () => {
      throw new Error(
        'Error: boom\n    at parseIt (parser.js:10:5)\n    at runImporter (registry.ts:115:3)',
      )
    },
  })
  registerImporter({
    apiVersion: IMPORTER_API_VERSION,
    id: 'test-long-thrower',
    name: 'Long thrower',
    accepts: ['text'],
    import: () => {
      throw new Error(`Broken export: ${'x'.repeat(400)}`)
    },
  })

  it("surfaces a plugin's own plain-language error message", async () => {
    await expect(runImporter('test-plain-thrower', { kind: 'text', text: 'x' })).rejects.toThrow(
      'This file ended early — row 12 has no title, so nothing could be read.',
    )
  })

  it('replaces a stack-trace-shaped plugin message with the generic failure', async () => {
    await expect(runImporter('test-stack-thrower', { kind: 'text', text: 'x' })).rejects.toThrow(
      "Stack thrower failed — the source couldn't be read. Nothing was imported.",
    )
  })

  it('caps an over-long plugin message at 300 characters', async () => {
    const err = await runImporter('test-long-thrower', { kind: 'text', text: 'x' }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ImporterError)
    expect((err as Error).message.length).toBe(300)
    expect((err as Error).message.startsWith('Broken export: ')).toBe(true)
  })
})
