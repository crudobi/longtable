/**
 * Localhost API unit tests.
 *
 * Two layers:
 *  - settings: defaults (off, documented port, no token), token minting
 *    on first enable, persistence round-trip, junk tolerance.
 *  - router + real host: the full HTTP surface driven through
 *    `handleApiRequest` against `createLocalApiHost` on an in-memory
 *    repo — auth rules (health open, everything else 401 without the
 *    token), CRUD, search, import atomicity, the visibility rules
 *    (friends-only refused plainly; public refused before anything is
 *    written when no publishing session exists; public honored through
 *    the host's byte-path hook when one does), and the friends surface
 *    (names + DIDs only, secrets never serialized).
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createRepo } from '../store/repo'
import { memoryStore, type KeyValueStore } from '../store/recipes'
import { saveFriend, type FriendRecord } from '../friends/friends'
import { createLocalApiHost, type LocalApiHost } from '../localapi/host'
import {
  handleApiRequest,
  type ApiRequest,
} from '../localapi/router'
import {
  LOCAL_API_DEFAULT_PORT,
  defaultLocalApiSettings,
  ensureLocalApiToken,
  generateLocalApiToken,
  loadLocalApiSettings,
  saveLocalApiSettings,
  type LocalApiSettings,
} from '../localapi/settings'
import type { Recipe } from '../types'

let dbCounter = 0
let kv: KeyValueStore
let host: LocalApiHost
let settings: LocalApiSettings

const TOKEN = 'test-token-0123456789abcdef'

function makeHost(hooks: Parameters<typeof createLocalApiHost>[0] = {}) {
  dbCounter += 1
  return createLocalApiHost({
    repo: createRepo(`longtable-localapi-test-${dbCounter}`),
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

beforeEach(() => {
  kv = memoryStore()
  host = makeHost()
  settings = { enabled: true, port: LOCAL_API_DEFAULT_PORT, token: TOKEN }
})

describe('localhost API settings', () => {
  it('defaults: off, documented port, no token', () => {
    const s = loadLocalApiSettings(memoryStore())
    expect(s).toEqual({ enabled: false, port: LOCAL_API_DEFAULT_PORT, token: '' })
    expect(defaultLocalApiSettings().enabled).toBe(false)
  })

  it('mints a 64-hex token on first enable, then keeps it', () => {
    const first = ensureLocalApiToken(defaultLocalApiSettings())
    expect(first.token).toMatch(/^[0-9a-f]{64}$/)
    const second = ensureLocalApiToken(first)
    expect(second.token).toBe(first.token)
    expect(generateLocalApiToken()).not.toBe(generateLocalApiToken())
  })

  it('round-trips through the kv store and tolerates junk', () => {
    const s: LocalApiSettings = { enabled: true, port: 19090, token: 'abc' }
    saveLocalApiSettings(s, kv)
    expect(loadLocalApiSettings(kv)).toEqual(s)
    kv.setItem('longtable:localapi', '{not json')
    expect(loadLocalApiSettings(kv).enabled).toBe(false)
    kv.setItem('longtable:localapi', JSON.stringify({ enabled: true, port: 80 }))
    // Privileged/out-of-range ports fall back to the default.
    expect(loadLocalApiSettings(kv).port).toBe(LOCAL_API_DEFAULT_PORT)
  })
})

describe('localhost API auth', () => {
  it('health is open and reports the version', async () => {
    const res = await call(req('GET', '/v1/health', { auth: null }))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, version: '1' })
  })

  it('everything else 401s without a token', async () => {
    for (const r of [
      req('GET', '/v1/recipes', { auth: null }),
      req('GET', '/v1/identity', { auth: null }),
      req('GET', '/v1/friends', { auth: null }),
      req('POST', '/v1/recipes', { auth: null, body: soupBody }),
    ]) {
      const res = await call(r)
      expect(res.status).toBe(401)
      expect((res.body as { error: string }).error).toMatch(/token/i)
    }
  })

  it('401s with a wrong token, 200s with the right one (any header case)', async () => {
    const wrong = await call(
      req('GET', '/v1/recipes', { auth: 'Bearer nope' }),
    )
    expect(wrong.status).toBe(401)
    const res = await handleApiRequest(
      {
        method: 'GET',
        path: '/v1/recipes',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: '',
      },
      host,
      settings,
    )
    expect(res.status).toBe(200)
  })

  it('503s (not 401s) when the app host is not up yet', async () => {
    const res = await handleApiRequest(req('GET', '/v1/recipes'), null, settings)
    expect(res.status).toBe(503)
  })
})

describe('localhost API recipes', () => {
  it('create → list → get → update → delete, with UI-shaped data', async () => {
    const created = await call(req('POST', '/v1/recipes', { body: soupBody }))
    expect(created.status).toBe(201)
    const { id } = created.body as { id: string }
    expect(id).toBeTruthy()
    expect((created.body as { visibility: string }).visibility).toBe('private')

    const list = await call(req('GET', '/v1/recipes'))
    expect(list.status).toBe(200)
    const recipes = (list.body as { recipes: unknown[] }).recipes
    expect(recipes).toHaveLength(1)
    expect(recipes[0]).toMatchObject({
      id,
      title: 'API Tomato Soup',
      visibility: 'private',
    })

    const got = await call(req('GET', `/v1/recipes/${id}`))
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({
      id,
      title: 'API Tomato Soup',
      ingredients: ['4 tomatoes', '1 onion', '2 cups stock'],
      steps: ['Chop.', 'Simmer 20 minutes.'],
      prepMinutes: 10,
      cookMinutes: 20,
      visibility: 'private',
    })

    const updated = await call(
      req('PUT', `/v1/recipes/${id}`, {
        body: { ...soupBody, title: 'API Tomato Soup v2', ingredients: ['5 tomatoes'] },
      }),
    )
    expect(updated.status).toBe(200)
    const got2 = await call(req('GET', `/v1/recipes/${id}`))
    expect(got2.body).toMatchObject({
      title: 'API Tomato Soup v2',
      ingredients: ['5 tomatoes'],
    })

    const del = await call(req('DELETE', `/v1/recipes/${id}`))
    expect(del.status).toBe(200)
    const got3 = await call(req('GET', `/v1/recipes/${id}`))
    expect(got3.status).toBe(404)
    const list2 = await call(req('GET', '/v1/recipes'))
    expect((list2.body as { recipes: unknown[] }).recipes).toHaveLength(0)
  })

  it('search matches titles and ingredients, case-insensitively', async () => {
    await call(req('POST', '/v1/recipes', { body: soupBody }))
    await call(
      req('POST', '/v1/recipes', {
        body: { title: 'Plain Rice', ingredients: ['rice', 'water'], steps: ['Boil.'] },
      }),
    )
    const byTitle = await call(req('GET', '/v1/recipes', { query: 'q=soup' }))
    expect((byTitle.body as { recipes: { title: string }[] }).recipes.map((r) => r.title)).toEqual(['API Tomato Soup'])
    const byIngredient = await call(req('GET', '/v1/recipes', { query: 'q=STOCK' }))
    expect((byIngredient.body as { recipes: { title: string }[] }).recipes.map((r) => r.title)).toEqual(['API Tomato Soup'])
    const none = await call(req('GET', '/v1/recipes', { query: 'q=chocolate' }))
    expect((none.body as { recipes: unknown[] }).recipes).toHaveLength(0)
  })

  it('rejects malformed writes with plain errors and correct statuses', async () => {
    const noBody = await call(req('POST', '/v1/recipes', { body: '' }))
    expect(noBody.status).toBe(400)
    const badJson = await call(req('POST', '/v1/recipes', { body: '{oops' }))
    expect(badJson.status).toBe(400)
    const noTitle = await call(
      req('POST', '/v1/recipes', { body: { ingredients: [], steps: [] } }),
    )
    expect(noTitle.status).toBe(422)
    expect((noTitle.body as { error: string }).error).toMatch(/title/i)
    const missing = await call(req('GET', '/v1/recipes/does-not-exist'))
    expect(missing.status).toBe(404)
    const missingPut = await call(
      req('PUT', '/v1/recipes/does-not-exist', { body: soupBody }),
    )
    expect(missingPut.status).toBe(404)
    const missingDel = await call(req('DELETE', '/v1/recipes/does-not-exist'))
    expect(missingDel.status).toBe(404)
    const unknown = await call(req('GET', '/v1/bogus'))
    expect(unknown.status).toBe(404)
    const wrongMethod = await call(req('PATCH', '/v1/recipes'))
    expect(wrongMethod.status).toBe(405)
  })

  it('identity returns this device\'s DID', async () => {
    const res = await call(req('GET', '/v1/identity'))
    expect(res.status).toBe(200)
    expect((res.body as { did: string }).did).toMatch(/^did:key:z/)
  })
})

describe('localhost API visibility rules', () => {
  it('refuses friends-only plainly, before writing anything', async () => {
    const res = await call(
      req('POST', '/v1/recipes', { body: { ...soupBody, visibility: 'friends-only' } }),
    )
    expect(res.status).toBe(422)
    expect((res.body as { error: string }).error).toMatch(/friends-only/i)
    const list = await call(req('GET', '/v1/recipes'))
    expect((list.body as { recipes: unknown[] }).recipes).toHaveLength(0)

    const created = await call(req('POST', '/v1/recipes', { body: soupBody }))
    const { id } = created.body as { id: string }
    const put = await call(
      req('PUT', `/v1/recipes/${id}`, { body: { ...soupBody, visibility: 'friends-only' } }),
    )
    expect(put.status).toBe(422)
    const got = await call(req('GET', `/v1/recipes/${id}`))
    expect((got.body as { visibility: string }).visibility).toBe('private')
  })

  it('refuses public before writing when no publishing session exists', async () => {
    // The store-backed test host has no applyVisibility/canPublish hooks.
    const res = await call(
      req('POST', '/v1/recipes', { body: { ...soupBody, visibility: 'public' } }),
    )
    expect(res.status).toBe(422)
    expect((res.body as { error: string }).error).toMatch(/publishing account/i)
    const list = await call(req('GET', '/v1/recipes'))
    expect((list.body as { recipes: unknown[] }).recipes).toHaveLength(0)
  })

  it('honors public through the byte-path hook when publishing is set up', async () => {
    const flips: { id: string; tier: string }[] = []
    let tier: 'private' | 'public' = 'private'
    host = makeHost({
      canPublish: () => true,
      applyVisibility: async (id, _recipe: Recipe, t) => {
        flips.push({ id, tier: t })
        tier = t
      },
    })
    // The hook above only records the flip; emulate the doc-side tier by
    // re-checking the recorded state through a second host read path:
    const created = await call(
      req('POST', '/v1/recipes', { body: { ...soupBody, visibility: 'public' } }),
    )
    expect(created.status).toBe(201)
    expect((created.body as { visibility: string }).visibility).toBe('public')
    expect(flips).toHaveLength(1)
    expect(flips[0].tier).toBe('public')
    expect(tier).toBe('public')
  })

  it('rejects nonsense tiers with 400', async () => {
    const res = await call(
      req('POST', '/v1/recipes', { body: { ...soupBody, visibility: 'everyone' } }),
    )
    expect(res.status).toBe(400)
  })
})

describe('localhost API import', () => {
  it('imports through a registered importer, atomically', async () => {
    const res = await call(
      req('POST', '/v1/import', {
        body: {
          importerId: 'longtable-json',
          text: JSON.stringify({
            title: 'Imported Via API',
            ingredients: ['pasta'],
            steps: ['Boil.'],
          }),
        },
      }),
    )
    expect(res.status).toBe(201)
    const body = res.body as { imported: string[]; count: number }
    expect(body.count).toBe(1)
    const got = await call(req('GET', `/v1/recipes/${body.imported[0]}`))
    expect((got.body as { title: string }).title).toBe('Imported Via API')
  })

  it('a bad import fails whole and saves nothing', async () => {
    const res = await call(
      req('POST', '/v1/import', {
        body: { importerId: 'longtable-json', text: '{"ingredients": []}' },
      }),
    )
    expect(res.status).toBe(422)
    const list = await call(req('GET', '/v1/recipes'))
    expect((list.body as { recipes: unknown[] }).recipes).toHaveLength(0)
    const unknown = await call(
      req('POST', '/v1/import', { body: { importerId: 'nope', text: 'x' } }),
    )
    expect(unknown.status).toBe(422)
  })
})

describe('localhost API friends surface', () => {
  it('lists names + DIDs only — pair secrets never serialize', async () => {
    const record: FriendRecord = {
      did: 'did:key:zFriendExample',
      name: 'Fay',
      pairSecret: 'TOPSECRET-PAIR-VALUE',
      pairId: 'deadbeefpairid',
      signaling: 'wss://hub.example:4444',
      addedAt: new Date().toISOString(),
    }
    saveFriend(record, kv)
    const res = await call(req('GET', '/v1/friends'))
    expect(res.status).toBe(200)
    expect((res.body as { friends: unknown[] }).friends).toEqual([
      { name: 'Fay', did: 'did:key:zFriendExample' },
    ])
    const wire = JSON.stringify(res.body)
    expect(wire).not.toContain('TOPSECRET-PAIR-VALUE')
    expect(wire).not.toContain('deadbeefpairid')
    expect(wire).not.toContain('pairSecret')
  })
})
