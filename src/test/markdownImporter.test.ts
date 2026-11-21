/**
 * Markdown importer tests (integrity M20), driven through the real
 * plugin path: the drop-in plugin is loaded by ensurePluginsLoaded
 * and run by runImporter, the way the Import panel runs it.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { ensurePluginsLoaded, runImporter } from '../importers/registry'

const BASE = `# Tomato Pasta

Prep: 10 min
Cook: 20 min

## Ingredients
- 400 g pasta
- 2 tomatoes

## Steps
1. Boil the pasta in salted water.
2. Soften the garlic, add the tomatoes.
3. Stir everything together and serve.
`

beforeAll(async () => {
  await ensurePluginsLoaded()
})

async function runMarkdown(text: string) {
  return runImporter('markdown-recipe', { kind: 'text', text })
}

describe('markdown importer (M20)', () => {
  it('imports the documented format', async () => {
    const { recipes, warnings } = await runMarkdown(BASE)
    expect(recipes).toHaveLength(1)
    expect(recipes[0].title).toBe('Tomato Pasta')
    expect(recipes[0].ingredients).toEqual(['400 g pasta', '2 tomatoes'])
    expect(recipes[0].steps).toHaveLength(3)
    expect(recipes[0].prepMinutes).toBe(10)
    expect(recipes[0].cookMinutes).toBe(20)
    expect(warnings).toEqual([])
  })

  it('accepts + bullets in ingredients and steps', async () => {
    const { recipes } = await runMarkdown(
      `# Plus Soup\n\n## Ingredients\n+ water\n+ salt\n\n## Steps\n+ Boil.\n+ Serve.\n`,
    )
    expect(recipes[0].ingredients).toEqual(['water', 'salt'])
    expect(recipes[0].steps).toEqual(['Boil.', 'Serve.'])
  })

  it('joins continuation lines onto the previous item', async () => {
    const { recipes } = await runMarkdown(
      `# Continued\n\n## Ingredients\n- 200 g flour\n  sifted\n- 2 eggs\n\n## Steps\n1. Mix everything\n   until smooth.\n2. Bake.\n`,
    )
    expect(recipes[0].ingredients).toEqual(['200 g flour sifted', '2 eggs'])
    expect(recipes[0].steps).toEqual(['Mix everything until smooth.', 'Bake.'])
  })

  it('reads Prep/Cook lines anywhere, and derives a leg from Total', async () => {
    const { recipes } = await runMarkdown(
      `# Anywhere\n\n## Ingredients\n- water\n\n## Steps\n1. Boil.\n\n## Notes\nPrep: 5 min\nTotal: 25 min\n`,
    )
    expect(recipes[0].prepMinutes).toBe(5)
    expect(recipes[0].cookMinutes).toBe(20)
  })

  it('warns on empty steps instead of returning them silently', async () => {
    const { recipes, warnings } = await runMarkdown(
      `# No Method\n\n## Ingredients\n- water\n\n## Steps\n`,
    )
    expect(recipes).toHaveLength(1)
    expect(recipes[0].steps).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/no steps/)
  })

  it('keeps stray prose as the description instead of dropping it', async () => {
    const { recipes } = await runMarkdown(
      `# Described\n\nA quick weeknight pasta.\n\n## Ingredients\n- pasta\n\n## Steps\n1. Cook.\n`,
    )
    expect(recipes[0].description).toBe('A quick weeknight pasta.')
  })
})
