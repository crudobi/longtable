/**
 * ATProto client — Phase 3 (public publishing).
 *
 * Hand-rolled XRPC over fetch (no @atproto/api dependency): the local
 * testnet PDS speaks plain JSON XRPC, and the app only needs a handful of
 * endpoints — session create/refresh, repo put/delete/getRecord,
 * uploadBlob, and sync getBlob.
 *
 * Auth model: the session ({did, handle, pdsUrl, accessJwt, refreshJwt})
 * is persisted in localStorage under SESSION_KEY by the app layer. Authed
 * calls that meet a 401 / ExpiredToken refresh the session ONCE (via
 * com.atproto.server.refreshSession with the refreshJwt) and retry; the
 * refreshed tokens are written back into the passed session object and
 * into the optional onSessionRefresh callback so callers can persist them.
 */
import type { KeyValueStore } from '../identity/identity'
import { getActiveHub, updateHub } from '../hubs/hubs'

export const SESSION_KEY = 'longtable:atproto-session'
export const PUBLICATIONS_KEY = 'longtable:publications:v1'
export const APPVIEW_URL_KEY = 'longtable:appview-url'
export const DEFAULT_APPVIEW_URL = 'http://localhost:3210'

export const RECIPE_COLLECTION = 'kitchen.longtable.recipe'
export const PUBKEY_COLLECTION = 'kitchen.longtable.pubkey'

export type PublicKv = KeyValueStore & {
  removeItem?: (key: string) => void
}

export interface AtprotoSession {
  did: string
  handle: string
  pdsUrl: string
  accessJwt: string
  refreshJwt: string
}

/** One entry of the local publications registry (what this device put on the PDS). */
export interface Publication {
  did: string
  uri: string
  rkey: string
  cid: string
  pdsUrl: string
  updatedAt: string
}

/** ATProto blob object as it appears inside a record's `images` array. */
export interface AtprotoBlob {
  $type: 'blob'
  ref: { $link: string }
  mimeType: string
  size: number
}

export class AtprotoError extends Error {
  status: number
  /** XRPC error name (e.g. 'ExpiredToken', 'RecordNotFound'), when provided. */
  error?: string
  constructor(message: string, status: number, error?: string) {
    super(message)
    this.name = 'AtprotoError'
    this.status = status
    this.error = error
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// Session + settings stores
// ---------------------------------------------------------------------------

export function loadSession(kv: PublicKv = localStorage): AtprotoSession | null {
  try {
    const raw = kv.getItem(SESSION_KEY)
    if (!raw) return null
    const obj: unknown = JSON.parse(raw)
    if (typeof obj !== 'object' || obj === null) return null
    const s = obj as Partial<AtprotoSession>
    if (
      typeof s.did !== 'string' ||
      typeof s.accessJwt !== 'string' ||
      typeof s.refreshJwt !== 'string' ||
      typeof s.pdsUrl !== 'string'
    ) {
      return null
    }
    return {
      did: s.did,
      handle: typeof s.handle === 'string' ? s.handle : '',
      pdsUrl: s.pdsUrl,
      accessJwt: s.accessJwt,
      refreshJwt: s.refreshJwt,
    }
  } catch {
    return null
  }
}

export function saveSession(session: AtprotoSession, kv: PublicKv = localStorage): void {
  kv.setItem(SESSION_KEY, JSON.stringify(session))
}

export function clearSession(kv: PublicKv = localStorage): void {
  if (typeof kv.removeItem === 'function') kv.removeItem(SESSION_KEY)
  else kv.setItem(SESSION_KEY, '')
}

export function loadAppViewUrl(kv: PublicKv = localStorage): string {
  try {
    // An explicitly saved URL (the Discover settings field) wins; otherwise
    // the active hub supplies the AppView endpoint (Phase 4 multi-hub).
    return kv.getItem(APPVIEW_URL_KEY) || getActiveHub().appviewUrl || DEFAULT_APPVIEW_URL
  } catch {
    return DEFAULT_APPVIEW_URL
  }
}

export function saveAppViewUrl(url: string, kv: PublicKv = localStorage): void {
  const clean = trimSlash(url)
  kv.setItem(APPVIEW_URL_KEY, clean)
  // Keep the active hub in sync so the hub list shows where discovery
  // actually points. Best-effort: a registry write failure must not break
  // the explicit save above.
  try {
    updateHub(getActiveHub(kv).id, { appviewUrl: clean }, kv)
  } catch {
    /* registry unavailable — the explicit key still applies */
  }
}

// ---------------------------------------------------------------------------
// XRPC client
// ---------------------------------------------------------------------------

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface AtprotoClientOptions {
  fetchFn?: FetchFn
  /** Called with the session after a token refresh so callers can persist it. */
  onSessionRefresh?: (session: AtprotoSession) => void
}

interface XrpcErrorBody {
  error?: string
  message?: string
}

export class AtprotoClient {
  readonly pdsUrl: string
  private readonly fetchFn: FetchFn
  private readonly onSessionRefresh?: (session: AtprotoSession) => void

  constructor(pdsUrl: string, options: AtprotoClientOptions = {}) {
    this.pdsUrl = trimSlash(pdsUrl)
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init))
    this.onSessionRefresh = options.onSessionRefresh
  }

  private url(path: string): string {
    return `${this.pdsUrl}/xrpc/${path}`
  }

  private async parseError(res: Response): Promise<AtprotoError> {
    let body: XrpcErrorBody = {}
    try {
      body = (await res.json()) as XrpcErrorBody
    } catch {
      /* non-JSON error body */
    }
    return new AtprotoError(
      body.message || `XRPC request failed (${res.status})`,
      res.status,
      body.error,
    )
  }

  /** POST createSession → a full session bound to this client's PDS URL. */
  async createSession(identifier: string, password: string): Promise<AtprotoSession> {
    const res = await this.fetchFn(this.url('com.atproto.server.createSession'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    })
    if (!res.ok) throw await this.parseError(res)
    const data = (await res.json()) as {
      did: string
      handle: string
      accessJwt: string
      refreshJwt: string
    }
    return {
      did: data.did,
      handle: data.handle,
      pdsUrl: this.pdsUrl,
      accessJwt: data.accessJwt,
      refreshJwt: data.refreshJwt,
    }
  }

  /**
   * POST refreshSession (Bearer refreshJwt). Mutates `session` in place
   * with the fresh tokens and returns it.
   */
  async refreshSession(session: AtprotoSession): Promise<AtprotoSession> {
    const res = await this.fetchFn(this.url('com.atproto.server.refreshSession'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.refreshJwt}` },
    })
    if (!res.ok) throw await this.parseError(res)
    const data = (await res.json()) as {
      did?: string
      handle?: string
      accessJwt: string
      refreshJwt: string
    }
    session.accessJwt = data.accessJwt
    session.refreshJwt = data.refreshJwt
    if (data.did) session.did = data.did
    if (data.handle) session.handle = data.handle
    this.onSessionRefresh?.(session)
    return session
  }

  /**
   * Authed request with one refresh-and-retry on 401 / ExpiredToken.
   * `makeInit` is re-invoked for the retry so the fresh token is used.
   */
  private async authed(
    session: AtprotoSession,
    path: string,
    makeInit: (accessJwt: string) => RequestInit,
  ): Promise<Response> {
    let res = await this.fetchFn(this.url(path), makeInit(session.accessJwt))
    if (res.ok) return res
    const err = await this.parseError(res)
    const expired =
      err.status === 401 || err.error === 'ExpiredToken' || err.error === 'InvalidToken'
    if (!expired) throw err
    await this.refreshSession(session)
    res = await this.fetchFn(this.url(path), makeInit(session.accessJwt))
    if (!res.ok) throw await this.parseError(res)
    return res
  }

  private jsonInit(accessJwt: string, body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessJwt}`,
      },
      body: JSON.stringify(body),
    }
  }

  async putRecord(
    session: AtprotoSession,
    input: { repo: string; collection: string; rkey: string; record: Record<string, unknown> },
  ): Promise<{ uri: string; cid: string }> {
    const res = await this.authed(session, 'com.atproto.repo.putRecord', (jwt) =>
      this.jsonInit(jwt, input),
    )
    return (await res.json()) as { uri: string; cid: string }
  }

  async deleteRecord(
    session: AtprotoSession,
    input: { repo: string; collection: string; rkey: string },
  ): Promise<void> {
    await this.authed(session, 'com.atproto.repo.deleteRecord', (jwt) =>
      this.jsonInit(jwt, input),
    )
  }

  /**
   * GET a record (public read, no auth). Returns null when the record
   * does not exist (404, or a RecordNotFound-style 400 from the PDS).
   */
  async getRecord(
    repo: string,
    collection: string,
    rkey: string,
  ): Promise<{ uri: string; cid: string; value: Record<string, unknown> } | null> {
    const qs = new URLSearchParams({ repo, collection, rkey })
    const res = await this.fetchFn(`${this.url('com.atproto.repo.getRecord')}?${qs}`)
    if (res.ok) {
      return (await res.json()) as {
        uri: string
        cid: string
        value: Record<string, unknown>
      }
    }
    const err = await this.parseError(res)
    if (
      err.status === 404 ||
      err.error === 'RecordNotFound' ||
      /not found/i.test(err.message)
    ) {
      return null
    }
    throw err
  }

  /**
   * Upload raw bytes as a blob. The XRPC response wraps the blob object
   * ({blob: {...}}); this returns the inner blob for embedding in a record.
   */
  async uploadBlob(
    session: AtprotoSession,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<AtprotoBlob> {
    const res = await this.authed(session, 'com.atproto.repo.uploadBlob', (jwt) => ({
      method: 'POST',
      headers: { 'Content-Type': mimeType, Authorization: `Bearer ${jwt}` },
      body: bytes as unknown as BodyInit,
    }))
    const data = (await res.json()) as { blob: AtprotoBlob }
    return data.blob
  }

  /** Download a blob's raw bytes (public read). */
  async getBlob(did: string, cid: string): Promise<ArrayBuffer> {
    const qs = new URLSearchParams({ did, cid })
    const res = await this.fetchFn(`${this.url('com.atproto.sync.getBlob')}?${qs}`)
    if (!res.ok) throw await this.parseError(res)
    return res.arrayBuffer()
  }
}
