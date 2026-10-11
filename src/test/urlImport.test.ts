// @vitest-environment jsdom
/**
 * URL importer tests: JSON-LD + OpenGraph parsing and graceful CORS failure.
 * fetch is stubbed — no network in tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UrlImportError, importRecipeFromUrl, parseRecipeHtml } from '../importers/urlImport'

const JSON_LD_PAGE = `<!doctype html><html><head>
<title>Fallback Title</title>
<meta property="og:title" content="OG Pancakes" />
<meta property="og:image" content="https://example.com/og.jpg" />
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Recipe",
  "name": "Fluffy Pancakes",
  "recipeIngredient": ["2 cups flour", "1 cup milk"],
  "recipeInstructions": [
    {"@type": "HowToStep", "text": "Mix the batter."},
    {"@type": "HowToStep", "text": "Cook on a hot griddle."}
  ],
  "image": ["https://example.com/pancakes.jpg"]
}
</script>
</head><body></body></html>`

const OG_ONLY_PAGE = `<!doctype html><html><head>
<title>Plain Page</title>
<meta property="og:title" content="Grandma's Soup" />
<meta property="og:description" content="A simple soup." />
</head><body></body></html>`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseRecipeHtml', () => {
  it('prefers schema.org Recipe JSON-LD', () => {
    const r = parseRecipeHtml(JSON_LD_PAGE, 'https://example.com/r')
    expect(r.title).toBe('Fluffy Pancakes')
    expect(r.ingredients).toEqual(['2 cups flour', '1 cup milk'])
    expect(r.steps).toEqual(['Mix the batter.', 'Cook on a hot griddle.'])
    expect(r.photos).toEqual(['https://example.com/pancakes.jpg'])
  })

  it('falls back to OpenGraph tags when no JSON-LD recipe exists', () => {
    const r = parseRecipeHtml(OG_ONLY_PAGE, 'https://example.com/r')
    expect(r.title).toBe("Grandma's Soup")
    expect(r.ingredients).toEqual([])
    expect(r.steps).toEqual([])
  })

  it('handles @graph-wrapped JSON-LD and string instructions', () => {
    const html = `<html><head><script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","name":"x"},
  {"@type":"Recipe","name":"Graph Cake",
   "recipeIngredient":["flour"],
   "recipeInstructions":["Stir.","Bake."]}
]}</script></head></html>`
    const r = parseRecipeHtml(html, 'https://example.com/r')
    expect(r.title).toBe('Graph Cake')
    expect(r.steps).toEqual(['Stir.', 'Bake.'])
  })
})

describe('importRecipeFromUrl', () => {
  it('reports CORS-blocked sites with a clear message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(importRecipeFromUrl('https://blocked.example/recipe')).rejects.toMatchObject({
      code: 'network',
    })
    await expect(importRecipeFromUrl('https://blocked.example/recipe')).rejects.toThrow(
      /blocked cross-origin reading/,
    )
  })

  it('reports HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response),
    )
    await expect(importRecipeFromUrl('https://example.com/missing')).rejects.toBeInstanceOf(
      UrlImportError,
    )
  })

  it('parses a fetched page into a prefill', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => JSON_LD_PAGE } as Response),
    )
    const r = await importRecipeFromUrl('example.com/pancakes')
    expect(r.title).toBe('Fluffy Pancakes')
    expect(r.ingredients).toHaveLength(2)
  })

  it('rejects empty input', async () => {
    await expect(importRecipeFromUrl('   ')).rejects.toThrow(/Paste a recipe page URL/)
  })
})
