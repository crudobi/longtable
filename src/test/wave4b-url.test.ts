// @vitest-environment jsdom
/**
 * Wave 4B URL-import DOM tests (H10). Split out of wave4b.test.ts:
 * parseRecipeHtml needs DOMParser, and the jsdom realm's Uint8Array
 * breaks libsodium's instanceof checks — so every sodium-touching
 * test lives in the node-env wave4b.test.ts instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  importRecipeFromUrl,
  parseRecipeHtml,
} from '../importers/urlImport'
import { runImporter } from '../importers/registry'

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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('URL-import photos, DOM paths (H10)', () => {
  it('importRecipeFromUrl re-hosts page photos as data URLs', async () => {
    const fetchFn = async (url: string): Promise<Response> => {
      // String body, not bytes: a jsdom-realm Uint8Array body comes
      // back empty from undici's Response. The bytes' content does not
      // matter here — toDataUrl is stubbed; only non-emptiness does.
      if (url === 'https://example.com/pancakes.jpg') {
        return new Response('xxxx', {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      return new Response(JSON_LD_PAGE, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }
    const { recipe, photoWarnings } = await importRecipeFromUrl('example.com/pancakes', {
      fetchFn,
      toDataUrl: async () => 'data:image/png;base64,STUB',
    })
    expect(recipe.title).toBe('Fluffy Pancakes')
    expect(recipe.photos).toEqual(['data:image/png;base64,STUB'])
    expect(photoWarnings).toEqual([])
  })

  it('parseRecipeHtml resolves relative photo URLs against the page URL', () => {
    const html = `<html><head><script type="application/ld+json">
{"@context":"https://schema.org","@type":"Recipe","name":"Rel Cake",
 "recipeIngredient":["flour"],"recipeInstructions":["Stir."],
 "image":["/img/p.jpg"]}</script></head></html>`
    const r = parseRecipeHtml(html, 'https://example.com/r/x')
    expect(r.photos).toEqual(['https://example.com/img/p.jpg'])
  })

  it('the web-page importer surfaces dropped photos as warnings, never stored', async () => {
    const missingPage = JSON_LD_PAGE.replace(
      'https://example.com/pancakes.jpg',
      'https://example.com/missing.jpg',
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string): Promise<Response> => {
        if (url === 'https://example.com/missing.jpg') {
          return new Response('nope', { status: 404 })
        }
        return new Response(missingPage, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }),
    )
    const { recipes, warnings } = await runImporter('web-page', {
      kind: 'url',
      url: 'https://example.com/soup',
    })
    expect(recipes).toHaveLength(1)
    expect(recipes[0].photos).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/missing\.jpg.*HTTP 404/)
    // Warnings ride the import, never the stored recipe.
    expect('warnings' in recipes[0]).toBe(false)
  })
})
