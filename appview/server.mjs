/**
 * server.mjs — AppView HTTP API (plain node:http, JSON) + app factory.
 *
 * createAppView() wires the index, the verified-repo provider and the
 * ingestor together and registers the ingestor as ingest.mjs's default so
 * tests can call the module-level ingestClaim() hook against the live app.
 */
import http from 'node:http'
import { RecipeIndex } from './db.mjs'
import { createVerifiedRepoProvider } from './verify.mjs'
import { createIngestor, setDefaultIngestor } from './ingest.mjs'

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

export function createAppView({
  dbPath = './appview.db',
  pdsUrl = 'http://localhost:2583',
  plcUrl = 'http://localhost:2582',
  repoStateProvider,
  fetchImpl,
  log = console,
} = {}) {
  const index = new RecipeIndex(dbPath)
  const provider =
    repoStateProvider ?? createVerifiedRepoProvider({ pdsUrl, plcUrl, fetchImpl })
  const ingestor = createIngestor({ index, repoStateProvider: provider, pdsUrl, log })
  setDefaultIngestor(ingestor)

  const server = http.createServer((req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS)
        return res.end()
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
          fts5: index.ftsEnabled,
        })
      }
      if (req.method === 'GET' && path === '/search') {
        const q = url.searchParams.get('q') ?? undefined
        const ingParam = url.searchParams.get('ingredients')
        const ingredients = ingParam
          ? ingParam.split(',').map((s) => s.trim()).filter(Boolean)
          : []
        return sendJson(res, 200, { results: index.search({ q, ingredients }) })
      }
      if (req.method === 'GET' && path.startsWith('/recipe/')) {
        const parts = path.split('/').filter(Boolean) // ['recipe', did, rkey]
        if (parts.length === 3) {
          const did = decodeURIComponent(parts[1])
          const rkey = decodeURIComponent(parts[2])
          const recipe = index.getRecipe(did, rkey)
          if (recipe) return sendJson(res, 200, recipe)
        }
        return sendJson(res, 404, { error: 'recipe not found' })
      }
      if (req.method === 'GET' && path.startsWith('/author/')) {
        const did = decodeURIComponent(path.slice('/author/'.length))
        if (did) return sendJson(res, 200, { did, results: index.byAuthor(did) })
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
