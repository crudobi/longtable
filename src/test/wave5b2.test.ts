// @vitest-environment jsdom
/**
 * Wave 5B2 — client infrastructure Lows:
 * - L-N3: IndexedDB fallback (in-memory degraded mode, no throw);
 * - Sec L7: constant-time localhost-API token compare;
 * - Sec L13: attach-path photo byte cap + XRPC timeouts;
 * - Sec L14: scheme validation on PDS/AppView/signaling URLs;
 * - S20: localhost API connection cap (native; no JS test — see the
 *   LocalApiPlugin.kt change, proven by the CI APK build);
 * - atproto loadSession corrupt-JSON shape (Wave 4A open item 1);
 * - listShares default kv (merge-worker nit).
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INDEX_GUID,
  createRepo,
  getOrCreateDoc,
  getPersistenceErrorMessage,
  isPersistenceDegraded,
  resetPersistenceStateForTests,
} from '../store/repo'
import {
  createRecipe,
  getOrCreateIndex,
  listRecipes,
  memoryStore,
  type KeyValueStore,
} from '../store/recipes'
import { constantTimeEqual, handleApiRequest, type ApiRequest } from '../localapi/router'
import { LOCAL_API_DEFAULT_PORT } from '../localapi/settings'
import {
  dataUrlByteSize,
  filesToDataUrls,
  filesToDataUrlsDetailed,
  MAX_PHOTO_BYTES,
} from '../importers/photoImport'
import {
  AtprotoClient,
  SESSION_KEY,
  loadSession,
  saveAppViewUrl,
  saveSession,
  type AtprotoSession,
} from '../public/atproto'
import { fetchAuthorBinding } from '../public/binding'
import {
  isSafeEndpointUrl,
  assertSafeHttpUrl,
} from '../hubs/endpointUrls'
import { addHub, updateHub } from '../hubs/hubs'
import {
  SHARES_KEY,
  listShares,
  loadShares,
  type ShareRecord,
} from '../p2p/share'
import { searchAppView } from '../public/discover'
import {
  CorruptStoreError,
  isStoreCorrupt,
  quarantineKeyFor,
  resetCorruptRegistryForTests,
} from '../store/corrupt'
import {
  initSecrets,
  memoryLocalStore,
  resetSecretStoreForTests,
  type SecretBackend,
} from '../secrets/secretStore'

let counter = 0
const uniq = (base: string) => `${base}-${++counter}`

function memKv(seed: Record<string, string> = {}): KeyValueStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
  }
}

const GOOD_SESSION: AtprotoSession = {
  did: 'did:plc:alice',
  handle: 'alice.test',
  pdsUrl: 'http://localhost:2583',
  accessJwt: 'access',
  refreshJwt: 'refresh',
}

/** Fake <img> (same shape as photoImport.test.ts): bytes containing
 *  GOODIMAGE decode as a 100x50 image, so no downscale runs. */
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  width = 0
  height = 0
  private _src = ''
  set src(v: string) {
    this._src = v
    queueMicrotask(() => {
      try {
        const decoded = atob(v.split(',')[1] ?? '')
        if (decoded.includes('GOODIMAGE')) {
          this.width = 100
          this.height = 50
          this.onload?.()
          return
        }
      } catch {
        /* not decodable base64 */
      }
      this.onerror?.()
    })
  }
  get src(): string {
    return this._src
  }
}

class FakeBackend implements SecretBackend {
  map = new Map<string, string>()
  async isAvailable(): Promise<boolean> {
    return true
  }
  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()]
  }
}

beforeEach(() => {
  resetCorruptRegistryForTests()
  resetPersistenceStateForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetCorruptRegistryForTests()
  resetPersistenceStateForTests()
  resetSecretStoreForTests(new FakeBackend(), memoryLocalStore())
})

// ---------------------------------------------------------------------------
// L-N3 — IndexedDB fallback
// ---------------------------------------------------------------------------
describe('L-N3 IndexedDB fallback', () => {
  let origIndexedDB: unknown

  beforeEach(() => {
    origIndexedDB = (globalThis as unknown as Record<string, unknown>).indexedDB
  })

  afterEach(() => {
    ;(globalThis as unknown as Record<string, unknown>).indexedDB = origIndexedDB
  })

  it('returns a usable in-memory doc instead of throwing when IndexedDB fails', async () => {
    // Quota-exceeded / unavailable IndexedDB: open() throws.
    ;(globalThis as unknown as Record<string, unknown>).indexedDB = {
      open: () => {
        throw new Error('QuotaExceededError: quota exceeded')
      },
    }
    const repo = createRepo(uniq('longtable-degraded'))
    const doc = await getOrCreateDoc(repo, INDEX_GUID)
    expect(doc).toBeDefined()
    expect(isPersistenceDegraded()).toBe(true)
    expect(getPersistenceErrorMessage()).toMatch(/QuotaExceededError/)
    expect(repo.docs.get(INDEX_GUID)?.persistence).toBeNull()

    // The whole store keeps working in memory: create + list + flush.
    const index = await getOrCreateIndex(repo, memoryStore())
    await createRecipe(repo, index, {
      title: 'Degraded Soup',
      ingredients: [],
      steps: [],
      photos: [],
    })
    expect(await listRecipes(index)).toHaveLength(1)
    await expect(repo.flush()).resolves.toBeUndefined()
  })

  it('a second doc after degradation is in-memory without re-attempting IndexedDB', async () => {
    let opens = 0
    ;(globalThis as unknown as Record<string, unknown>).indexedDB = {
      open: () => {
        opens += 1
        throw new Error('QuotaExceededError: quota exceeded')
      },
    }
    const repo = createRepo(uniq('longtable-degraded-2'))
    await getOrCreateDoc(repo, INDEX_GUID)
    expect(opens).toBe(1)
    const doc2 = await getOrCreateDoc(repo, 'recipe-second')
    expect(doc2).toBeDefined()
    expect(repo.docs.get('recipe-second')?.persistence).toBeNull()
    // No second attempt at the dead IndexedDB.
    expect(opens).toBe(1)
    expect(isPersistenceDegraded()).toBe(true)
  })

  it('a healthy IndexedDB is not degraded (control)', async () => {
    const repo = createRepo(uniq('longtable-healthy'))
    await getOrCreateDoc(repo, INDEX_GUID)
    expect(isPersistenceDegraded()).toBe(false)
    expect(getPersistenceErrorMessage()).toBeNull()
    expect(repo.docs.get(INDEX_GUID)?.persistence).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Sec L7 — constant-time token compare
// ---------------------------------------------------------------------------
describe('Sec L7 constant-time token compare', () => {
  it('equal strings compare true, any difference false, regardless of length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('', '')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'ab')).toBe(false)
    expect(constantTimeEqual('ab', 'abc')).toBe(false)
    expect(constantTimeEqual('', 'x')).toBe(false)
    expect(constantTimeEqual('Bearer token-a', 'Bearer token-b')).toBe(false)
  })

  it('health stays open, wrong tokens 401 (same or different length), right token passes auth', async () => {
    const settings = { enabled: true, port: LOCAL_API_DEFAULT_PORT, token: 'test-token-abc' }
    const req = (auth: string | null): ApiRequest => ({
      method: 'GET',
      path: '/v1/identity',
      query: '',
      headers: auth === null ? {} : { authorization: auth },
      body: '',
    })
    // No host yet: a right token gets past auth to the 503, a wrong one 401s.
    expect((await handleApiRequest(req(null), null, settings)).status).toBe(401)
    expect((await handleApiRequest(req('Bearer test-token-abd'), null, settings)).status).toBe(401)
    expect((await handleApiRequest(req('Bearer short'), null, settings)).status).toBe(401)
    expect((await handleApiRequest(req('Bearer test-token-abc'), null, settings)).status).toBe(503)
    const health = await handleApiRequest(
      { method: 'GET', path: '/v1/health', query: '', headers: {}, body: '' },
      null,
      settings,
    )
    expect(health.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Sec L13 — attach-path photo cap + XRPC timeout
// ---------------------------------------------------------------------------
describe('Sec L13 photo byte cap', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('createImageBitmap', undefined as never)
  })

  it('dataUrlByteSize measures decoded bytes, not the base64 string', () => {
    // 'hello' is 5 bytes; base64 'aGVsbG8=' is 8 chars.
    expect(dataUrlByteSize('data:image/jpeg;base64,aGVsbG8=')).toBe(5)
    expect(dataUrlByteSize('data:image/jpeg;base64,')).toBe(0)
    expect(dataUrlByteSize('not-a-data-url')).toBe('not-a-data-url'.length)
    expect(MAX_PHOTO_BYTES).toBe(5 * 1024 * 1024)
  })

  it('a photo still over the cap after downscaling lands in tooLarge, never stored', async () => {
    const filler = new Uint8Array(6 * 1024 * 1024 - 9)
    const huge = new File(['GOODIMAGE', filler], 'huge.jpg', { type: 'image/jpeg' })
    const good = new File(['GOODIMAGE-bytes'], 'good.jpg', { type: 'image/jpeg' })
    const { urls, failed, tooLarge } = await filesToDataUrlsDetailed([huge, good])
    expect(urls).toHaveLength(1)
    expect(urls[0].startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(failed).toEqual([])
    expect(tooLarge).toEqual(['huge.jpg'])
  })

  it('filesToDataUrls fails the batch naming the oversized file', async () => {
    const filler = new Uint8Array(6 * 1024 * 1024 - 9)
    const huge = new File(['GOODIMAGE', filler], 'huge.jpg', { type: 'image/jpeg' })
    await expect(filesToDataUrls([huge])).rejects.toThrow(/huge\.jpg/)
  })
})

describe('Sec L13 XRPC timeout', () => {
  it('passes an AbortSignal to every XRPC call', async () => {
    const signals: unknown[] = []
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          did: 'did:plc:alice',
          handle: 'alice.test',
          accessJwt: 'a',
          refreshJwt: 'r',
        }),
      } as unknown as Response
    }) as (url: string, init?: RequestInit) => Promise<Response>
    const client = new AtprotoClient('http://localhost:2583', { fetchFn })
    await client.createSession('alice.test', 'pw')
    expect(signals).toHaveLength(1)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })

  it('a hung PDS aborts the request instead of hanging forever', async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      // A fetch that respects the signal, like the real one: it only
      // settles when the signal aborts.
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation timed out.', 'TimeoutError'))
        })
      })
      throw new Error('unreachable')
    }) as (url: string, init?: RequestInit) => Promise<Response>
    const client = new AtprotoClient('http://localhost:2583', { fetchFn, timeoutMs: 5 })
    await expect(client.createSession('alice.test', 'pw')).rejects.toThrow(/timed out|abort/i)
  })
})

// ---------------------------------------------------------------------------
// Sec L14 — scheme validation
// ---------------------------------------------------------------------------
describe('Sec L14 endpoint scheme validation', () => {
  it('https/wss always safe; http/ws only for loopback hosts', () => {
    expect(isSafeEndpointUrl('https://pds.example:2583', 'http')).toBe(true)
    expect(isSafeEndpointUrl('wss://hub.example:4444', 'ws')).toBe(true)
    expect(isSafeEndpointUrl('http://localhost:2583', 'http')).toBe(true)
    expect(isSafeEndpointUrl('http://127.0.0.1:2583', 'http')).toBe(true)
    expect(isSafeEndpointUrl('http://[::1]:2583', 'http')).toBe(true)
    expect(isSafeEndpointUrl('ws://10.0.2.2:4444', 'ws')).toBe(true)
    expect(isSafeEndpointUrl('http://pds.example:2583', 'http')).toBe(false)
    expect(isSafeEndpointUrl('ws://hub.example:4444', 'ws')).toBe(false)
    expect(isSafeEndpointUrl('http://user:pass@localhost:2583', 'http')).toBe(false)
    expect(isSafeEndpointUrl('ftp://pds.example', 'http')).toBe(false)
    expect(isSafeEndpointUrl('not a url', 'http')).toBe(false)
    expect(isSafeEndpointUrl('https://pds.example', 'ws')).toBe(false)
  })

  it('addHub/updateHub refuse plaintext remote URLs, accept https + localhost', () => {
    const kv = memKv()
    const hub = {
      name: 'Hub B',
      signalingUrl: 'wss://hub-b.example:4444',
      appviewUrl: 'https://hub-b.example:3211',
      pdsUrl: 'https://hub-b.example:2584',
    }
    expect(() => addHub({ ...hub, pdsUrl: 'http://hub-b.example:2583' }, kv)).toThrow(/https/)
    expect(() => addHub({ ...hub, appviewUrl: 'http://hub-b.example:3210' }, kv)).toThrow(/https/)
    expect(() =>
      addHub({ ...hub, signalingUrl: 'ws://hub-b.example:4444' }, kv),
    ).toThrow(/wss/)
    const added = addHub(hub, kv)
    expect(added.id).toBeTruthy()
    expect(() => updateHub(added.id, { pdsUrl: 'http://hub-b.example:2583' }, kv)).toThrow(
      /https/,
    )
    expect(updateHub(added.id, { pdsUrl: 'http://localhost:2583' }, kv).pdsUrl).toBe(
      'http://localhost:2583',
    )
  })

  it('AtprotoClient refuses a plaintext remote PDS, accepts localhost + https', () => {
    expect(() => new AtprotoClient('http://pds.example:2583')).toThrow(/https/)
    expect(() => new AtprotoClient('http://localhost:2583')).not.toThrow()
    expect(() => new AtprotoClient('https://pds.example:2583')).not.toThrow()
  })

  it('saveAppViewUrl refuses a plaintext remote AppView URL', () => {
    const kv = memKv()
    expect(() => saveAppViewUrl('http://appview.example:3210', kv)).toThrow(/https/)
    expect(kv.map.get('longtable:appview-url')).toBeUndefined()
    saveAppViewUrl('https://appview.example:3211', kv)
    expect(kv.map.get('longtable:appview-url')).toBe('https://appview.example:3211')
  })

  it('searchAppView refuses a plaintext remote AppView URL without fetching', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }))
    await expect(
      searchAppView('http://appview.example:3210', { q: 'soup' }, fetchFn as never),
    ).rejects.toThrow(/https/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('binding fetch never contacts a plaintext remote PDS hint', async () => {
    const seen: string[] = []
    const fetchFn = (async (url: string) => {
      seen.push(url)
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    }) as (url: string, init?: RequestInit) => Promise<Response>
    await expect(
      fetchAuthorBinding('did:plc:alice', 'did:key:z6MkTest', fetchFn, {
        authorPdsUrl: 'http://pds.example:2583',
      }),
    ).rejects.toThrow(/binding-unavailable/)
    expect(seen.some((u) => u.includes('pds.example'))).toBe(false)
  })

  it('assertSafeHttpUrl names the problem in plain language', () => {
    expect(() => assertSafeHttpUrl('http://pds.example', 'PDS URL')).toThrow(
      /PDS URL must use https/,
    )
  })
})

// ---------------------------------------------------------------------------
// atproto loadSession corrupt-JSON shape (Wave 4A open item 1)
// ---------------------------------------------------------------------------
describe('loadSession corrupt-JSON handling (H9 pattern)', () => {
  it('absent reads as null and is not corrupt', () => {
    const kv = memKv()
    expect(loadSession(kv)).toBeNull()
    expect(isStoreCorrupt(SESSION_KEY)).toBe(false)
  })

  it('corrupt JSON reads as null, is quarantined, and saveSession refuses to overwrite it', () => {
    const kv = memKv({ [SESSION_KEY]: '{not json' })
    expect(loadSession(kv)).toBeNull()
    expect(isStoreCorrupt(SESSION_KEY)).toBe(true)
    expect(kv.map.get(quarantineKeyFor(SESSION_KEY, '{not json'))).toBe('{not json')
    expect(kv.map.get(SESSION_KEY)).toBe('{not json')
    expect(() => saveSession(GOOD_SESSION, kv)).toThrow(CorruptStoreError)
    expect(kv.map.get(SESSION_KEY)).toBe('{not json')
  })

  it('valid JSON with the wrong shape is corrupt, not a silent null', () => {
    const kv = memKv({ [SESSION_KEY]: JSON.stringify({ did: 42 }) })
    expect(loadSession(kv)).toBeNull()
    expect(isStoreCorrupt(SESSION_KEY)).toBe(true)
  })

  it('a valid session round-trips, and a later corrupt read blocks the next save', () => {
    const kv = memKv()
    saveSession(GOOD_SESSION, kv)
    expect(loadSession(kv)).toEqual(GOOD_SESSION)
    kv.map.set(SESSION_KEY, '{broken')
    expect(loadSession(kv)).toBeNull()
    expect(() => saveSession(GOOD_SESSION, kv)).toThrow(CorruptStoreError)
  })
})

// ---------------------------------------------------------------------------
// listShares default kv (merge-worker nit)
// ---------------------------------------------------------------------------
describe('listShares default kv', () => {
  it('reads through secretKv, not raw localStorage', async () => {
    const backend = new FakeBackend()
    const share: ShareRecord = {
      recipeId: 'recipe-1',
      room: 'longtable-share-recipe-1',
      signaling: 'wss://example.invalid/signaling',
      role: 'host',
      secret: 'c2VjcmV0',
    }
    backend.map.set(SHARES_KEY, JSON.stringify([share]))
    const local = memoryLocalStore()
    resetSecretStoreForTests(backend, local)
    // secretKv reads secret keys through its in-memory mirror, which
    // the Keystore migration (initSecrets) populates from the backend.
    await initSecrets()
    // localStorage holds nothing: the old raw-localStorage default
    // would read [] here.
    expect(window.localStorage.getItem(SHARES_KEY)).toBeNull()
    expect(listShares()).toEqual([share])
    expect(loadShares()).toEqual([share])
  })
})
