// @vitest-environment jsdom
/**
 * Wave 5H API tests (M22/M23/M24).
 *
 * jsdom: the URL-import test needs DOMParser (parseRecipeHtml); the
 * host/store tests are plain JS and run fine under jsdom too.
 *
 * Driven through `handleApiRequest` against `createLocalApiHost` on an
 * in-memory repo, like localapi.test.ts:
 *  - M22: PATCH is partial (untouched fields stay), `null` clears an
 *    optional field, and `expectedUpdatedAt` is a lost-update
 *    precondition — a stale value is refused with 412 and nothing is
 *    written (the race: two writers, one stale precondition), on both
 *    PATCH and PUT.
 *  - M23: a visibility flip that fails part-way answers 502 with a
 *    `changed` block describing the recipe as it actually stands —
 *    publish landed / tier did not, unpublish landed / tier did not,
 *    flip landed / content write did not.
 *  - M24: POST /v1/import takes `{url}` for the URL importer, and
 *    source timestamps ride through an import (and a create) so a
 *    backup restores with its original times.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRepo, type YjsStore } from '../store/repo'
import {
  getOrCreateIndex,
  memoryStore,
  updateRecipe as storeUpdateRecipe,
  type KeyValueStore,
} from '../store/recipes'
import { createLocalApiHost, type LocalApiHost } from '../localapi/host'
import {
  handleApiRequest,
  type ApiRequest,
} from '../localapi/router'
import {
  LOCAL_API_DEFAULT_PORT,
  type LocalApiSettings,
} from '../localapi/settings'
import { PUBLICATIONS_KEY } from '../public/atproto'
import type { Recipe } from '../types'

let dbCounter = 0
let kv: KeyValueStore
let repo: YjsStore
let host: LocalApiHost
let settings: LocalApiSettings

const TOKEN = 'test-token-0123456789abcdef'

function makeHost(hooks: Parameters<typeof createLocalApiHost>[0] = {}) {
  dbCounter += 1
  repo = createRepo(`longtable-wave5h-test-${dbCounter}`)
  return createLocalApiHost({
    repo,
    kv,
    ...hooks,
  })
}

function req(
  method: string,
  path: string,
  opts: { query?: string; body?: unknown; auth?: string | null } = {},
): ApiRequest {
  const headers: Record<string, string> = {}
  if (opts.auth !== null) {
    headers.authorization = opts.auth ?? `Bearer ${TOKEN}`
  }
  return {
    method,
    path,
    query: opts.query ?? '',
    headers,
    body:
      opts.body === undefined
        ? ''
        : typeof opts.body === 'string'
          ? opts.body
          : JSON.stringify(opts.body),
  }
}

const call = (r: ApiRequest) => handleApiRequest(r, host, settings)

const soupBody = {
  title: 'API Tomato Soup',
  ingredients: ['4 tomatoes', '1 onion', '2 cups stock'],
  steps: ['Chop.', 'Simmer 20 minutes.'],
  prepMinutes: 10,
  cookMinutes: 20,
}

async function createSoup(): Promise<string> {
  const created = await call(req('POST', '/v1/recipes', { body: soupBody }))
  expect(created.status).toBe(201)
  return (created.body as { id: string }).id
}

async function getRecipe(id: string) {
  const got = await call(req('GET', `/v1/recipes/${id}`))
  expect(got.status).toBe(200)
  return got.body as Record<string, unknown>
}

beforeEach(() => {
  kv = memoryStore()
  host = makeHost()
  settings = { enabled: true, port: LOCAL_API_DEFAULT_PORT, token: TOKEN }
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { localStorage?: Storage }).localStorage
})

// The flows under test read bare `localStorage` through default
// parameters (getPublication) — the node test env has none, so the
// M23 tests install one (leaveshare/wave4b pattern).
function mkLocalStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(seed))
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage
}

function seedPublication(id: string): void {
  const entry = {
    did: 'did:key:zTestAuthor',
    uri: `at://did:key:zTestAuthor/kitchen.longtable.recipe/${id}`,
    rkey: id,
    cid: 'bafkreitestcid',
    pdsUrl: 'https://pds.example',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const ls = (globalThis as { localStorage: Storage }).localStorage
  ls.setItem(PUBLICATIONS_KEY, JSON.stringify({ [id]: entry }))
}

function readRegistry(): Record<string, unknown> {
  const ls = (globalThis as { localStorage: Storage }).localStorage
  const raw = ls.getItem(PUBLICATIONS_KEY)
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

async function setTierDirect(id: string, tier: 'private' | 'public') {
  const idx = await getOrCreateIndex(repo, kv)
  await storeUpdateRecipe(repo, idx, id, { visibility: tier })
}

describe('M22: PATCH + lost-update precondition', () => {
  it('PATCH changes only the fields sent; the rest stay put', async () => {
    const id = await createSoup()
    const before = await getRecipe(id)
    const patched = await call(
      req('PATCH', `/v1/recipes/${id}`, { body: { title: 'Patched Soup' } }),
    )
    expect(patched.status).toBe(200)
    expect((patched.body as { warnings: unknown }).warnings).toEqual([])
    const updatedAt = (patched.body as { updatedAt: string }).updatedAt
    expect(updatedAt).toBeTruthy()
    expect(updatedAt).not.toBe(before.updatedAt)
    const after = await getRecipe(id)
    expect(after.title).toBe('Patched Soup')
    expect(after.ingredients).toEqual(before.ingredients)
    expect(after.steps).toEqual(before.steps)
    expect(after.prepMinutes).toBe(10)
    expect(after.cookMinutes).toBe(20)
    expect(after.updatedAt).toBe(updatedAt)
  })

  it('PATCH null clears an optional field; PATCH can set descriptive fields', async () => {
    const id = await createSoup()
    const cleared = await call(
      req('PATCH', `/v1/recipes/${id}`, { body: { prepMinutes: null } }),
    )
    expect(cleared.status).toBe(200)
    expect((await getRecipe(id)).prepMinutes).toBeUndefined()
    const described = await call(
      req('PATCH', `/v1/recipes/${id}`, {
        body: { description: 'A test soup.', author: 'Test Cook' },
      }),
    )
    expect(described.status).toBe(200)
    const after = await getRecipe(id)
    expect(after.description).toBe('A test soup.')
    expect(after.author).toBe('Test Cook')
    const undescribed = await call(
      req('PATCH', `/v1/recipes/${id}`, { body: { description: null } }),
    )
    expect(undescribed.status).toBe(200)
    expect((await getRecipe(id)).description).toBeUndefined()
  })

  it('lost-update race: a stale expectedUpdatedAt is 412 and writes nothing', async () => {
    const id = await createSoup()
    const firstRead = await getRecipe(id)
    const t0 = firstRead.updatedAt as string
    // Writer A read at t0 and writes first: lands.
    const a = await call(
      req('PATCH', `/v1/recipes/${id}`, {
        body: { title: 'Writer A wins', expectedUpdatedAt: t0 },
      }),
    )
    expect(a.status).toBe(200)
    const t1 = (a.body as { updatedAt: string }).updatedAt
    expect(t1).not.toBe(t0)
    // Writer B still holds t0: refused, nothing overwritten.
    const b = await call(
      req('PATCH', `/v1/recipes/${id}`, {
        body: { title: 'Writer B overwrites', expectedUpdatedAt: t0 },
      }),
    )
    expect(b.status).toBe(412)
    expect((b.body as { error: string }).error).toMatch(/changed since you last read/i)
    expect((await getRecipe(id)).title).toBe('Writer A wins')
    // Writer B re-reads and retries against t1: lands.
    const c = await call(
      req('PATCH', `/v1/recipes/${id}`, {
        body: { title: 'Writer B retries', expectedUpdatedAt: t1 },
      }),
    )
    expect(c.status).toBe(200)
    expect((await getRecipe(id)).title).toBe('Writer B retries')
  })

  it('PUT takes the same precondition: stale 412, matching 200', async () => {
    const id = await createSoup()
    const t0 = (await getRecipe(id)).updatedAt as string
    const stale = await call(
      req('PUT', `/v1/recipes/${id}`, {
        body: { ...soupBody, title: 'Stale PUT', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' },
      }),
    )
    expect(stale.status).toBe(412)
    expect((await getRecipe(id)).title).toBe('API Tomato Soup')
    const ok = await call(
      req('PUT', `/v1/recipes/${id}`, {
        body: { ...soupBody, title: 'Fresh PUT', expectedUpdatedAt: t0 },
      }),
    )
    expect(ok.status).toBe(200)
    expect((ok.body as { updatedAt: string }).updatedAt).not.toBe(t0)
    expect((await getRecipe(id)).title).toBe('Fresh PUT')
  })

  it('PATCH rejects unknown fields, an empty patch, and a null title', async () => {
    const id = await createSoup()
    const unknown = await call(
      req('PATCH', `/v1/recipes/${id}`, { body: { tittle: 'typo' } }),
    )
    expect(unknown.status).toBe(400)
    expect((unknown.body as { error: string }).error).toMatch(/not a recipe field/i)
    const empty = await call(req('PATCH', `/v1/recipes/${id}`, { body: {} }))
    expect(empty.status).toBe(400)
    const nullTitle = await call(
      req('PATCH', `/v1/recipes/${id}`, { body: { title: null } }),
    )
    expect(nullTitle.status).toBe(422)
    const missing = await call(
      req('PATCH', '/v1/recipes/does-not-exist', { body: { title: 'x' } }),
    )
    expect(missing.status).toBe(404)
    expect((await getRecipe(id)).title).toBe('API Tomato Soup')
  })

  it('PATCH visibility runs the tier flow (confirm gate included)', async () => {
    const flips: { id: string; tier: string }[] = []
    host = makeHost({
      canPublish: () => true,
      applyVisibility: async (id, _recipe: Recipe, t) => {
        flips.push({ id, tier: t })
        return []
      },
    })
    const id = await createSoup()
    const noConfirm = await call(
      req('PATCH', `/v1/recipes/${id}`, { body: { visibility: 'public' } }),
    )
    expect(noConfirm.status).toBe(422)
    expect(flips).toHaveLength(0)
    const refused = await call(
      req('PATCH', `/v1/recipes/${id}`, { body: { visibility: 'friends-only' } }),
    )
    expect(refused.status).toBe(422)
    const ok = await call(
      req('PATCH', `/v1/recipes/${id}`, {
        body: { visibility: 'public', confirm: true },
      }),
    )
    expect(ok.status).toBe(200)
    expect((ok.body as { visibility: string }).visibility).toBe('public')
    expect(flips).toHaveLength(1)
    expect(flips[0].tier).toBe('public')
  })

  it('PATCH through the UI update hook merges over the stored recipe', async () => {
    const seen: unknown[] = []
    host = makeHost({
      applyUpdate: async (_id, input) => {
        seen.push(input)
      },
    })
    const id = await createSoup()
    const res = await call(
      req('PATCH', `/v1/recipes/${id}`, {
        body: { title: 'Hooked Patch', prepMinutes: null },
      }),
    )
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    const merged = seen[0] as Record<string, unknown>
    expect(merged.title).toBe('Hooked Patch')
    // Untouched fields ride along from the stored recipe…
    expect(merged.ingredients).toEqual(soupBody.ingredients)
    expect(merged.steps).toEqual(soupBody.steps)
    // …and the null clear arrives as a present-but-undefined key,
    // the signal the UI flow's `'field' in input` checks read.
    expect('prepMinutes' in merged).toBe(true)
    expect(merged.prepMinutes).toBeUndefined()
  })
})

describe('M23: partial visibility flips answer 502 with what changed', () => {
  beforeEach(() => {
    ;(globalThis as { localStorage?: Storage }).localStorage = mkLocalStorage()
  })

  it('publish lands, tier-mark fails: 502 says still private, public copy listed', async () => {
    host = makeHost({
      canPublish: () => true,
      applyVisibility: async (flipId) => {
        // The publish went live (registry entry recorded), then the
        // local tier-mark threw.
        seedPublication(flipId)
        throw new Error('PDS boom')
      },
    })
    const id = await createSoup()
    const res = await call(
      req('PUT', `/v1/recipes/${id}`, {
        body: { ...soupBody, title: 'Public Title', visibility: 'public', confirm: true },
      }),
    )
    expect(res.status).toBe(502)
    const body = res.body as {
      error: string
      changed: {
        id: string
        visibility: string
        updatedAt: string
        publicRecord: string
      }
    }
    expect(body.error).toMatch(/still private/i)
    expect(body.error).toMatch(/still listed/i)
    expect(body.changed).toMatchObject({
      id,
      visibility: 'private',
      publicRecord: 'listed',
    })
    expect(body.changed.updatedAt).toBeTruthy()
    // The content write DID land (it runs before the flip).
    const after = await getRecipe(id)
    expect(after.title).toBe('Public Title')
    expect(after.visibility).toBe('private')
  })

  it('unpublish lands, tier-mark fails: 502 says still public, no public copy recorded', async () => {
    host = makeHost({
      canPublish: () => true,
      applyVisibility: async (flipId) => {
        // The unpublish went through (registry entry dropped), then
        // the local tier-mark threw.
        const ls = (globalThis as { localStorage: Storage }).localStorage
        ls.setItem(PUBLICATIONS_KEY, JSON.stringify({}))
        void flipId
        throw new Error('tier-mark boom')
      },
    })
    const id = await createSoup()
    await setTierDirect(id, 'public')
    seedPublication(id)
    const res = await call(
      req('PUT', `/v1/recipes/${id}`, {
        body: { ...soupBody, visibility: 'private' },
      }),
    )
    expect(res.status).toBe(502)
    const body = res.body as { error: string; changed: Record<string, unknown> }
    expect(body.error).toMatch(/still public/i)
    expect(body.error).toMatch(/no public copy is recorded/i)
    expect(body.changed).toMatchObject({
      id,
      visibility: 'public',
      publicRecord: 'not listed',
    })
    expect(readRegistry()).toEqual({})
    expect((await getRecipe(id)).visibility).toBe('public')
  })

  it('flip lands, content write fails: 502 says now private, old content kept', async () => {
    host = makeHost({
      canPublish: () => true,
      applyVisibility: async (flipId) => {
        // The real flow: unpublish (registry entry dropped), then
        // mark the tier. Both land here; the content write after
        // them throws.
        const idx = await getOrCreateIndex(repo, kv)
        await storeUpdateRecipe(repo, idx, flipId, { visibility: 'private' })
        const ls = (globalThis as { localStorage: Storage }).localStorage
        ls.setItem(PUBLICATIONS_KEY, JSON.stringify({}))
        return []
      },
      applyUpdate: async () => {
        throw new Error('store boom')
      },
    })
    const id = await createSoup()
    await setTierDirect(id, 'public')
    seedPublication(id)
    const res = await call(
      req('PUT', `/v1/recipes/${id}`, {
        body: { ...soupBody, title: 'New Title', visibility: 'private' },
      }),
    )
    expect(res.status).toBe(502)
    const body = res.body as { error: string; changed: Record<string, unknown> }
    expect(body.error).toMatch(/now private/i)
    expect(body.error).toMatch(/previous content/i)
    expect(body.changed).toMatchObject({
      id,
      visibility: 'private',
      publicRecord: 'not listed',
    })
    const after = await getRecipe(id)
    expect(after.visibility).toBe('private')
    expect(after.title).toBe('API Tomato Soup')
  })
})

describe('M24: URL import + source timestamps', () => {
  const JSON_LD_PAGE = `<!doctype html><html><head>
<title>Fallback Title</title>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Recipe",
  "name": "Fluffy Pancakes",
  "recipeIngredient": ["2 cups flour", "1 cup milk"],
  "recipeInstructions": [
    {"@type": "HowToStep", "text": "Mix the batter."},
    {"@type": "HowToStep", "text": "Cook on a hot griddle."}
  ]
}
</script>
</head><body></body></html>`

  it('import keeps source timestamps instead of re-stamping now', async () => {
    const res = await call(
      req('POST', '/v1/import', {
        body: {
          importerId: 'longtable-json',
          text: JSON.stringify({
            title: 'Old Soup',
            ingredients: ['water'],
            steps: ['Boil.'],
            createdAt: '2020-01-02T03:04:05.000Z',
            updatedAt: '2021-06-07T08:09:10.000Z',
          }),
        },
      }),
    )
    expect(res.status).toBe(201)
    const importedId = (res.body as { imported: string[] }).imported[0]
    const got = await getRecipe(importedId)
    expect(got.createdAt).toBe('2020-01-02T03:04:05.000Z')
    expect(got.updatedAt).toBe('2021-06-07T08:09:10.000Z')
  })

  it('import of a full export document keeps every recipe’s times', async () => {
    const res = await call(
      req('POST', '/v1/import', {
        body: {
          importerId: 'longtable-json',
          text: JSON.stringify({
            format: 'longtable-export',
            version: 1,
            exportedAt: '2026-11-20T00:00:00.000Z',
            notes: 'test export',
            recipes: [
              {
                id: 'exported-1',
                title: 'Exported Soup',
                ingredients: [],
                steps: [],
                photos: [],
                createdAt: '2019-05-06T07:08:09.000Z',
                updatedAt: '2020-05-06T07:08:09.000Z',
              },
            ],
            friends: [],
          }),
        },
      }),
    )
    expect(res.status).toBe(201)
    const importedId = (res.body as { imported: string[] }).imported[0]
    const got = await getRecipe(importedId)
    expect(got.title).toBe('Exported Soup')
    expect(got.createdAt).toBe('2019-05-06T07:08:09.000Z')
    expect(got.updatedAt).toBe('2020-05-06T07:08:09.000Z')
  })

  it('a lone timestamp stands in for the missing one; a bad one fails the run', async () => {
    const onlyUpdated = await call(
      req('POST', '/v1/import', {
        body: {
          importerId: 'longtable-json',
          text: JSON.stringify({
            title: 'One Time',
            ingredients: [],
            steps: [],
            updatedAt: '2022-02-02T02:02:02.000Z',
          }),
        },
      }),
    )
    expect(onlyUpdated.status).toBe(201)
    const oneId = (onlyUpdated.body as { imported: string[] }).imported[0]
    const one = await getRecipe(oneId)
    expect(one.updatedAt).toBe('2022-02-02T02:02:02.000Z')
    expect(one.createdAt).toBe('2022-02-02T02:02:02.000Z')
    const bad = await call(
      req('POST', '/v1/import', {
        body: {
          importerId: 'longtable-json',
          text: JSON.stringify({
            title: 'Bad Time',
            ingredients: [],
            steps: [],
            createdAt: 'not-a-date',
          }),
        },
      }),
    )
    expect(bad.status).toBe(422)
    expect((bad.body as { error: string }).error).toMatch(/createdAt/i)
    const list = await call(req('GET', '/v1/recipes'))
    expect((list.body as { recipes: unknown[] }).recipes).toHaveLength(1)
  })

  it('create keeps source timestamps and echoes them; a bad one is 400', async () => {
    const created = await call(
      req('POST', '/v1/recipes', {
        body: {
          ...soupBody,
          createdAt: '2018-03-04T05:06:07.000Z',
          updatedAt: '2019-03-04T05:06:07.000Z',
        },
      }),
    )
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      createdAt: '2018-03-04T05:06:07.000Z',
      updatedAt: '2019-03-04T05:06:07.000Z',
    })
    const id = (created.body as { id: string }).id
    const got = await getRecipe(id)
    expect(got.createdAt).toBe('2018-03-04T05:06:07.000Z')
    expect(got.updatedAt).toBe('2019-03-04T05:06:07.000Z')
    const bad = await call(
      req('POST', '/v1/recipes', {
        body: { ...soupBody, title: 'Bad Time Soup', updatedAt: 'yesterday' },
      }),
    )
    expect(bad.status).toBe(400)
    const list = await call(req('GET', '/v1/recipes'))
    expect((list.body as { recipes: unknown[] }).recipes).toHaveLength(1)
  })

  it('import accepts {url} for the URL importer (fetch stubbed, no network)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('example.com/pancakes')) {
          return new Response(JSON_LD_PAGE, {
            headers: { 'content-type': 'text/html' },
          })
        }
        return new Response('not found', { status: 404 })
      }),
    )
    const res = await call(
      req('POST', '/v1/import', {
        body: { importerId: 'web-page', url: 'https://example.com/pancakes' },
      }),
    )
    expect(res.status).toBe(201)
    const importedId = (res.body as { imported: string[] }).imported[0]
    const got = await getRecipe(importedId)
    expect(got.title).toBe('Fluffy Pancakes')
    expect(got.ingredients).toEqual(['2 cups flour', '1 cup milk'])
    expect(got.sourceUrl).toBe('https://example.com/pancakes')
  })

  it('import url errors: both sources, wrong importer, bad shapes', async () => {
    const both = await call(
      req('POST', '/v1/import', {
        body: { importerId: 'web-page', text: 'x', url: 'https://example.com/x' },
      }),
    )
    expect(both.status).toBe(400)
    const neither = await call(
      req('POST', '/v1/import', { body: { importerId: 'web-page' } }),
    )
    expect(neither.status).toBe(400)
    const blankUrl = await call(
      req('POST', '/v1/import', { body: { importerId: 'web-page', url: '   ' } }),
    )
    expect(blankUrl.status).toBe(400)
    const wrongKind = await call(
      req('POST', '/v1/import', {
        body: { importerId: 'longtable-json', url: 'https://example.com/x' },
      }),
    )
    expect(wrongKind.status).toBe(422)
    expect((wrongKind.body as { error: string }).error).toMatch(/url/i)
    const nonString = await call(
      req('POST', '/v1/import', { body: { importerId: 'web-page', url: 42 } }),
    )
    expect(nonString.status).toBe(400)
    const list = await call(req('GET', '/v1/recipes'))
    expect((list.body as { recipes: unknown[] }).recipes).toHaveLength(0)
  })
})
