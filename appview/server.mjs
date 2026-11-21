/**
 * server.mjs — AppView HTTP API (plain node:http, JSON) + app factory.
 *
 * createAppView() wires the index, the verified-repo provider and the
 * ingestor together and registers the ingestor as ingest.mjs's default so
 * tests can call the module-level ingestClaim() hook against the live app.
 */
import http from 'node:http'
import path from 'node:path'
import { RecipeIndex } from './db.mjs'
import { createVerifiedRepoProvider } from './verify.mjs'
import { createIngestor, setDefaultIngestor } from './ingest.mjs'
import { createMediaCache, safeMediaContentType } from './media.mjs'

/**
 * M12 — per-IP fixed-window rate limiter for the public AppView API.
 * The AppView was an unauthenticated, un-rate-limited open endpoint;
 * one client could flood /search, /author/ and /media/ without bound.
 * Default: 300 requests per 60 s per source IP (far above any
 * legitimate client — the app issues a handful of reads per view —
 * and low enough to blunt a flood). Over-limit requests get 429 with
 * Retry-After; the limiter is in-memory per process, which is the
 * right scope for a single-hub daemon.
 */
export const DEFAULT_RATE_LIMIT = { windowMs: 60_000, maxRequests: 300 }
export const MAX_SEARCH_Q_CHARS = 500
export const MAX_SEARCH_INGREDIENTS = 20

export function createRateLimiter({ windowMs, maxRequests } = DEFAULT_RATE_LIMIT) {
  const windows = new Map() // ip -> { start, count }
  return {
    check(ip) {
      const now = Date.now()
      const w = windows.get(ip)
      if (!w || now - w.start >= windowMs) {
        windows.set(ip, { start: now, count: 1 })
        return { allowed: true, retryAfterMs: 0 }
      }
      if (w.count >= maxRequests) {
        return { allowed: false, retryAfterMs: windowMs - (now - w.start) }
      }
      w.count++
      return { allowed: true, retryAfterMs: 0 }
    },
  }
}

// The AppView is a PUBLIC read API: the Longtable app (origin
// https://localhost in Capacitor, or any other hub client) fetches it
// cross-origin, so every response carries CORS headers. Without them the
// WebView blocks the app from reading search results at all.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  })
  res.end(body)
}

/**
 * Serving rule (S2): a row is served only if it carries all three
 * device-signature fields. Rows indexed before C2 carry NULLs until a
 * verified reconcile re-upserts them; they stay in the store (so the
 * startup/periodic sweep can find their DID and re-verify them) but
 * are never served on /search, /recipe/ or /author/ in the meantime.
 * An unverified /recipe/ is a 404, indistinguishable from absent.
 */
function isVerifiedRow(row) {
  return Boolean(row?.deviceDid && row?.deviceSignature && row?.deviceKey)
}

export function createAppView({
  dbPath = './appview.db',
  pdsUrl = 'http://localhost:2583',
  plcUrl = 'http://localhost:2582',
  mediaDir,
  repoStateProvider,
  fetchImpl,
  log = console,
  rateLimit = DEFAULT_RATE_LIMIT,
  firehoseCursorPath,
} = {}) {
  const limiter = createRateLimiter(rateLimit)
  const index = new RecipeIndex(dbPath)
  // Public media cache: one directory next to the index DB by default.
  // With an in-memory index and no explicit dir, the cache is disabled
  // (unit tests pass a tmp dir when they exercise it).
  const media =
    mediaDir || dbPath !== ':memory:'
      ? createMediaCache({
          dir: mediaDir ?? path.join(path.dirname(path.resolve(dbPath)), 'media'),
          pdsUrl,
          fetchImpl: fetchImpl ?? fetch,
          log,
        })
      : null
  const provider =
    repoStateProvider ?? createVerifiedRepoProvider({ pdsUrl, plcUrl, fetchImpl })
  // H1/H3: the ingestor purges media for swept recipes (via the cache)
  // and persists the firehose cursor next to the DB (default path when
  // the caller does not pass one and the DB is on disk).
  const ingestor = createIngestor({
    index,
    repoStateProvider: provider,
    pdsUrl,
    log,
    media,
    firehoseCursorPath:
      firehoseCursorPath ??
      (dbPath !== ':memory:' ? path.join(path.dirname(path.resolve(dbPath)), 'firehose-cursor.json') : undefined),
  })
  setDefaultIngestor(ingestor)

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS)
        return res.end()
      }
      // M12: per-IP rate limit on every non-preflight request.
      const ip = req.socket?.remoteAddress ?? 'unknown'
      const limit = limiter.check(ip)
      if (!limit.allowed) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)),
          ...CORS_HEADERS,
        })
        return res.end(JSON.stringify({ error: 'rate limited' }))
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (req.method === 'GET' && path === '/health') {
        return sendJson(res, 200, { ok: true })
      }
      if (req.method === 'GET' && path === '/stats') {
        return sendJson(res, 200, {
          ...ingestor.stats,
          total: index.count(),
          unverified: index.countUnverified(),
          fts5: index.ftsEnabled,
          media: media ? media.stats : null,
        })
      }
      if (req.method === 'GET' && path.startsWith('/media/')) {
        const parts = path.split('/').filter(Boolean) // ['media', did, cid]
        if (parts.length === 3 && media) {
          const did = decodeURIComponent(parts[1])
          const cid = decodeURIComponent(parts[2])
          // M12 (media gating): only serve a blob an indexed recipe of
          // this DID actually references. Without this the cache was an
          // open blob-fetch oracle for any (did, cid) the caller named.
          // The 404 is indistinguishable from a cache miss, on purpose.
          if (index.hasImage(did, cid)) {
            const blob = await media.get(did, cid)
            if (blob) {
              // H2: serve through the Content-Type allowlist, not the
              // PDS-supplied type — a non-image blob is served as
              // application/octet-stream + attachment, and every media
              // response carries nosniff + a sandboxing CSP so that even
              // a sniffed type cannot execute in the AppView origin.
              const contentType = safeMediaContentType(blob.contentType)
              res.writeHead(200, {
                'content-type': contentType,
                'content-length': blob.bytes.length,
                'cache-control': 'public, max-age=31536000, immutable',
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'; sandbox",
                ...(contentType === 'application/octet-stream'
                  ? { 'content-disposition': 'attachment' }
                  : {}),
                'x-longtable-media-cache': blob.fromCache ? 'hit' : 'miss',
                ...CORS_HEADERS,
              })
              return res.end(blob.bytes)
            }
          }
        }
        return sendJson(res, 404, { error: 'media not found' })
      }
      if (req.method === 'GET' && path === '/search') {
        const q = url.searchParams.get('q') ?? undefined
        const ingParam = url.searchParams.get('ingredients')
        const ingredients = ingParam
          ? ingParam.split(',').map((s) => s.trim()).filter(Boolean)
          : []
        // M4(int): bound the query — an unbounded q + ingredient list
        // was one unbounded FTS/LIKE parse per request.
        if (q !== undefined && q.length > MAX_SEARCH_Q_CHARS) {
          return sendJson(res, 400, { error: `q exceeds ${MAX_SEARCH_Q_CHARS} characters` })
        }
        if (ingredients.length > MAX_SEARCH_INGREDIENTS) {
          return sendJson(res, 400, { error: `at most ${MAX_SEARCH_INGREDIENTS} ingredients` })
        }
        return sendJson(res, 200, { results: index.search({ q, ingredients }).filter(isVerifiedRow) })
      }
      if (req.method === 'GET' && path.startsWith('/recipe/')) {
        const parts = path.split('/').filter(Boolean) // ['recipe', did, rkey]
        if (parts.length === 3) {
          const did = decodeURIComponent(parts[1])
          const rkey = decodeURIComponent(parts[2])
          const recipe = index.getRecipe(did, rkey)
          if (recipe && isVerifiedRow(recipe)) return sendJson(res, 200, recipe)
        }
        return sendJson(res, 404, { error: 'recipe not found' })
      }
      if (req.method === 'GET' && path.startsWith('/author/')) {
        const did = decodeURIComponent(path.slice('/author/'.length))
        if (did) return sendJson(res, 200, { did, results: index.byAuthor(did).filter(isVerifiedRow) })
        return sendJson(res, 404, { error: 'author not found' })
      }
      return sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      log.error?.(`[appview] request error: ${err?.stack ?? err}`)
      return sendJson(res, 500, { error: 'internal error' })
    }
  })

  return {
    index,
    ingestor,
    media,
    server,
    stats: ingestor.stats,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, () => {
          server.removeListener('error', reject)
          resolve(server.address())
        })
      })
    },
    async close() {
      ingestor.close()
      await new Promise((resolve) => server.close(() => resolve()))
      index.close()
    },
  }
}
