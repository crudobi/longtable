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
import { buildExport, serializeExport } from '../backup/export'
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
      // The HowToSection name is kept on its first step (M15/M21).
      'Cooking: Fry ladles of batter 2 minutes per side.',
      'Serve warm.',
    ])
    expect(out[0].prepMinutes).toBe(10)
    expect(out[0].cookMinutes).toBe(15)
    expect(out[0].description).toBe('Fast pancakes.')
    expect(out[0].recipeYield).toBe('4 servings')
    expect(out[0].tags).toEqual(['easy', 'Breakfast'])
    // The Mealie "image" file name is not imported as a photo — but it
    // is warned about instead of dropped silently (M21).
    expect(out[0].photos).toBeUndefined()
    expect(out[0].warnings).toHaveLength(1)
    expect(out[0].warnings![0]).toMatch(/weeknight-pancakes\.jpg/)
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

describe('jsonImporter (M16/M-N6)', () => {
  it('accepts the recipeIngredient alias', async () => {
    const out = await jsonImporter.import({
      kind: 'text',
      text: JSON.stringify({ name: 'Alias Soup', recipeIngredient: ['water'], instructions: ['Boil'] }),
    })
    expect(out[0].title).toBe('Alias Soup')
    expect(out[0].ingredients).toEqual(['water'])
    expect(out[0].steps).toEqual(['Boil'])
  })

  it('a populated instructions list beats an empty steps list', async () => {
    const out = await jsonImporter.import({
      kind: 'text',
      text: JSON.stringify({ title: 'Empty Steps', steps: [], instructions: ['Real step'] }),
    })
    expect(out[0].steps).toEqual(['Real step'])
  })

  it('a numeric title stringifies instead of throwing', async () => {
    const out = await jsonImporter.import({
      kind: 'text',
      text: JSON.stringify({ title: 42, name: 'Named', ingredients: [], steps: [] }),
    })
    expect(out[0].title).toBe('42')
  })

  it('keeps description, yield, tags, author, and source URL', async () => {
    const out = await jsonImporter.import({
      kind: 'text',
      text: JSON.stringify({
        title: 'Kept',
        ingredients: [],
        steps: [],
        description: 'A note.',
        recipeYield: '4 servings',
        tags: ['soup', 'quick'],
        author: 'Chef A',
        sourceUrl: 'https://example.com/kept',
      }),
    })
    expect(out[0].description).toBe('A note.')
    expect(out[0].recipeYield).toBe('4 servings')
    expect(out[0].tags).toEqual(['soup', 'quick'])
    expect(out[0].author).toBe('Chef A')
    expect(out[0].sourceUrl).toBe('https://example.com/kept')
  })

  it('surfaces a public record images[] as imageCids (M-N6)', async () => {
    const out = await jsonImporter.import({
      kind: 'text',
      text: JSON.stringify({
        $type: 'kitchen.longtable.recipe',
        name: 'Public Soup',
        ingredients: ['water'],
        instructions: ['Boil'],
        images: [
          { $type: 'blob', ref: { $link: 'bafyAAA' }, mimeType: 'image/jpeg', size: 10 },
          { ref: { $link: 'bafyBBB' } },
          { ref: 'bafyCCC' },
          'bafyDDD',
        ],
      }),
    })
    expect(out[0].title).toBe('Public Soup')
    expect(out[0].imageCids).toEqual(['bafyAAA', 'bafyBBB', 'bafyCCC', 'bafyDDD'])
    expect(out[0].photos).toBeUndefined()
  })

  it('round-trips the C3 export: photos, tier, and description survive', async () => {
    const exp = buildExport(
      [
        {
          id: 'r1',
          recipe: {
            title: 'Export Soup',
            ingredients: ['water'],
            steps: ['Boil'],
            photos: ['data:image/png;base64,xx'],
            visibility: 'public',
            description: 'Exported.',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
      [],
    )
    const out = await jsonImporter.import({ kind: 'text', text: serializeExport(exp) })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Export Soup')
    expect(out[0].photos).toEqual(['data:image/png;base64,xx'])
    expect(out[0].visibility).toBe('public')
    expect(out[0].description).toBe('Exported.')
  })
})

describe('mealieImporter (M21)', () => {
  it('parses ISO-8601 weeks, months, and years', () => {
    expect(isoDurationToMinutes('P1W')).toBe(10080)
    expect(isoDurationToMinutes('P2M')).toBe(86400)
    expect(isoDurationToMinutes('P1Y')).toBe(525600)
    expect(isoDurationToMinutes('P1DT2H')).toBe(1560)
  })

  it('keeps a name-only HowToStep as a step', async () => {
    const out = await mealieImporter.import({
      kind: 'text',
      text: JSON.stringify({
        name: 'Name Only',
        recipeIngredient: ['x'],
        recipeInstructions: [{ '@type': 'HowToStep', name: 'Rest the dough.' }],
      }),
    })
    expect(out[0].steps).toEqual(['Rest the dough.'])
  })

  it('accepts single-string instructions', async () => {
    const oneLine = await mealieImporter.import({
      kind: 'text',
      text: JSON.stringify({
        name: 'One Line',
        recipeIngredient: ['x'],
        recipeInstructions: 'Mix. Bake.',
      }),
    })
    expect(oneLine[0].steps).toEqual(['Mix. Bake.'])
    const multiLine = await mealieImporter.import({
      kind: 'text',
      text: JSON.stringify({
        name: 'Multi Line',
        recipeIngredient: ['x'],
        recipeInstructions: 'Mix.\nBake.',
      }),
    })
    expect(multiLine[0].steps).toEqual(['Mix.', 'Bake.'])
  })

  it('does not derive cook time from totalTime when prep is unknown', async () => {
    const out = await mealieImporter.import({
      kind: 'text',
      text: JSON.stringify({
        name: 'Total Only',
        recipeIngredient: ['x'],
        recipeInstructions: [],
        totalTime: 'PT40M',
      }),
    })
    expect(out[0].prepMinutes).toBeUndefined()
    expect(out[0].cookMinutes).toBeUndefined()
  })

  it('keeps a web-URL image as a photo', async () => {
    const out = await mealieImporter.import({
      kind: 'text',
      text: JSON.stringify({
        name: 'Web Photo',
        recipeIngredient: ['x'],
        recipeInstructions: [],
        image: 'https://example.com/p.jpg',
      }),
    })
    expect(out[0].photos).toEqual(['https://example.com/p.jpg'])
    expect(out[0].warnings).toBeUndefined()
  })
})

describe('contract caps (M17)', () => {
  it('rejects more than 20 photos', () => {
    const photos = Array.from({ length: 21 }, (_, i) => `data:image/png;base64,${i}`)
    expect(() =>
      validateImportedRecipe({ title: 'X', ingredients: [], steps: [], photos }, 'Test'),
    ).toThrow(/too many photos/)
  })

  it('rejects a photo over 5 MB decoded', () => {
    const big = `data:image/jpeg;base64,${'A'.repeat(7_000_000)}`
    expect(() =>
      validateImportedRecipe({ title: 'X', ingredients: [], steps: [], photos: [big] }, 'Test'),
    ).toThrow(/too large/)
  })

  it('rejects an over-long description and too many tags, drops a non-web source URL', () => {
    expect(() =>
      validateImportedRecipe(
        { title: 'X', ingredients: [], steps: [], description: 'd'.repeat(5001) },
        'Test',
      ),
    ).toThrow(/too long/)
    expect(() =>
      validateImportedRecipe(
        { title: 'X', ingredients: [], steps: [], tags: Array.from({ length: 51 }, (_, i) => `t${i}`) },
        'Test',
      ),
    ).toThrow(/too many "tags"/)
    const out = validateImportedRecipe(
      { title: 'X', ingredients: [], steps: [], sourceUrl: 'ftp://example.com/r' },
      'Test',
    )
    expect(out.sourceUrl).toBeUndefined()
  })
})

describe('registry: warnings, run cap, image-CID resolution (M17/M-N6)', () => {
  registerImporter({
    apiVersion: IMPORTER_API_VERSION,
    id: 'test-warner',
    name: 'Warner',
    accepts: ['text'],
    import: () => [
      { title: 'W', ingredients: [], steps: [], warnings: ['Careful now.'] },
    ],
  })
  registerImporter({
    apiVersion: IMPORTER_API_VERSION,
    id: 'test-cid-holder',
    name: 'CID holder',
    accepts: ['text'],
    import: () => [
      { title: 'C', ingredients: [], steps: [], imageCids: ['cid1', 'cid2'] },
    ],
  })

  it('surfaces importer warnings alongside the recipes', async () => {
    const { recipes, warnings } = await runImporter('test-warner', {
      kind: 'text',
      text: 'x',
    })
    expect(recipes).toHaveLength(1)
    expect(warnings).toEqual(['Careful now.'])
  })

  it('resolves image CIDs through the caller resolver (M-N6)', async () => {
    const { recipes, warnings } = await runImporter('test-cid-holder', {
      kind: 'text',
      text: 'x',
      resolveImageCid: async (cid: string) => `data:image/jpeg;base64,${cid}`,
    })
    expect(recipes[0].photos).toEqual([
      'data:image/jpeg;base64,cid1',
      'data:image/jpeg;base64,cid2',
    ])
    expect(warnings).toEqual([])
  })

  it('warns when image CIDs cannot be resolved (M-N6)', async () => {
    const { recipes, warnings } = await runImporter('test-cid-holder', {
      kind: 'text',
      text: 'x',
    })
    expect(recipes[0].photos).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/2 photos.*couldn't fetch/)
  })

  it('rejects a run with more than 500 recipes', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({
      title: `R${i}`,
      ingredients: [],
      steps: [],
    }))
    await expect(
      runImporter('longtable-json', { kind: 'text', text: JSON.stringify(many) }),
    ).rejects.toThrow(/at most 500/)
  })
})
