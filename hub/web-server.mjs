/**
 * web-server.mjs — zero-dependency static host for the Longtable web app.
 *
 * Serves the built SPA from WEB_ROOT with an index.html fallback for
 * client-side routes. The hub serves the app so a browser user needs
 * nothing else; the native app does not depend on this server at all.
 *
 * Env: WEB_PORT (default 8080), WEB_ROOT (default ./app)
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.WEB_PORT ?? 8080)
const ROOT = path.resolve(process.env.WEB_ROOT ?? './app')
// M15: opt-in TLS. When WEB_TLS_CERT + WEB_TLS_KEY point at existing
// files the host serves HTTPS with them (the hub passes its own cert
// when web.tls is set in hub.conf.json); otherwise plain HTTP, the
// historical behavior. The cert is normally the hub's self-signed one,
// so browsers warn on it — for a public deployment bring a CA cert.
//
// Sec L15 — fail closed on configured-but-missing TLS paths. The old
// check silently served plain HTTP when either file was absent, so a
// typo'd cert path dropped the web host to plaintext with no error.
// Now: paths that are SET must exist (exit 1 otherwise); only when
// neither is set at all is plain HTTP the intended default.
const TLS_CERT = process.env.WEB_TLS_CERT ?? ''
const TLS_KEY = process.env.WEB_TLS_KEY ?? ''
if ((TLS_CERT || TLS_KEY) && (!fs.existsSync(TLS_CERT) || !fs.existsSync(TLS_KEY))) {
  // Synchronous write: process.exit(1) below can truncate an async
  // console.error to a pipe, and a fail-closed refusal nobody sees
  // is a silent downgrade of a different kind.
  fs.writeSync(
    2,
    `[web] WEB_TLS_CERT/WEB_TLS_KEY are set but the files are missing: ${TLS_CERT || '(unset)'} / ${TLS_KEY || '(unset)'} — ` +
      'refusing to serve plain HTTP. Fix the paths or unset both for plain HTTP.\n',
  )
  process.exit(1)
}
const useTls = Boolean(TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY))

// Blocker #14: hub health endpoint. The hub supervisor passes its
// status file via HUB_STATUS_FILE; /healthz reports the supervisor's
// own heartbeat, not just "this process answers". A fresh heartbeat
// (< 60 s old — the supervisor rewrites the file every 15 s) is 200
// with the child states; anything else is 503: stale heartbeat (the
// supervisor is dead even if this child still serves), missing or
// unparseable file, or no status file configured at all (a standalone
// web server is not a hub). The endpoint is read-only and carries no
// secrets — hub-status.json holds PIDs, restart counts and endpoint
// URLs only, never credentials.
const HUB_STATUS_FILE = process.env.HUB_STATUS_FILE ?? ''
const HEALTHZ_MAX_HEARTBEAT_AGE_MS = 60_000

function hubHealth() {
  if (!HUB_STATUS_FILE) return { ok: false, reason: 'hub status not configured' }
  let status
  try {
    status = JSON.parse(fs.readFileSync(HUB_STATUS_FILE, 'utf8'))
  } catch {
    return { ok: false, reason: 'hub status unreadable' }
  }
  const heartbeatAt = Date.parse(status?.heartbeatAt ?? '')
  if (Number.isNaN(heartbeatAt)) return { ok: false, reason: 'hub status has no heartbeat' }
  const ageMs = Date.now() - heartbeatAt
  if (ageMs > HEALTHZ_MAX_HEARTBEAT_AGE_MS) {
    return { ok: false, reason: 'hub supervisor heartbeat stale', heartbeatAgeMs: ageMs }
  }
  return {
    ok: true,
    name: status.name ?? null,
    heartbeatAt: status.heartbeatAt,
    heartbeatAgeMs: ageMs,
    children: status.children ?? {},
    endpoints: status.endpoints ?? {},
  }
}

/**
 * M15 — security headers on every response. The host serves the SPA
 * from the hub's origin, so: nosniff (a served asset must never be
 * sniffed into an executable type), SAMEORIGIN framing only (the app
 * is not meant to be embedded cross-origin), no-referrer, and a CSP
 * that only forbids foreign framing — deliberately NOT a full
 * default-src CSP, which would break the app's own connections to the
 * signaling/AppView/PDS endpoints on other ports.
 */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "frame-ancestors 'self'",
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const server = (useTls
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, (req, res) => handle(req, res))
  : http.createServer((req, res) => handle(req, res)))

function handle(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS)
      return res.end()
    }
    // Blocker #14: /healthz is routed before the static containment
    // logic — it is not a file under WEB_ROOT, and must never fall
    // through to the SPA fallback (a dead hub answering 200 with the
    // app shell would read as "up").
    const rawTarget = (req.url ?? '/').split('?')[0]
    if (rawTarget === '/healthz') {
      const health = hubHealth()
      const body = JSON.stringify(health)
      res.writeHead(health.ok ? 200 : 503, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...SECURITY_HEADERS,
      })
      if (req.method === 'HEAD') return res.end()
      return res.end(body)
    }
    // Parse the RAW request target, not new URL(...): the WHATWG URL
    // parser normalizes dot segments (/.. collapses to /) before we
    // see them, which would hide a traversal from the containment
    // check below while an encoded separator (..%2f) still smuggles
    // it through decodeURIComponent. Split off the query ourselves
    // and decode the raw path, so every `..` reaches the check.
    const rawPath = (req.url ?? '/').split('?')[0]
    let rel = decodeURIComponent(rawPath).replace(/^\/+/, '')
    let file = path.join(ROOT, rel)
    // The containment check must be on a whole path segment: a bare
    // startsWith(ROOT) lets a sibling whose name shares the prefix
    // (ROOT /x/app vs /x/appview) escape (S5). path.relative is
    // '..'-led exactly when the resolved path leaves ROOT.
    const relToRoot = path.relative(ROOT, file)
    if (relToRoot === '..' || relToRoot.startsWith(`..${path.sep}`)) {
      res.writeHead(403, SECURITY_HEADERS)
      return res.end()
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // SPA fallback: unknown paths (and directories) get the app shell.
      file = path.join(ROOT, 'index.html')
    }
    const ext = path.extname(file).toLowerCase()
    const stat = fs.statSync(file)
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': stat.size,
      // The shell must revalidate so hub upgrades reach browsers; hashed
      // assets are effectively immutable and may be cached hard.
      'cache-control': file.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
      ...SECURITY_HEADERS,
    })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file).pipe(res)
  } catch (err) {
    // M15: never leak error strings to the client (the old handler
    // ended the response with String(err) — paths included). Log
    // server-side, answer generically.
    console.error(`[web] request error: ${err?.stack ?? err}`)
    try {
      res.writeHead(500, { 'content-type': 'text/plain', ...SECURITY_HEADERS })
      res.end('internal error')
    } catch {
      /* response already gone */
    }
  }
}

server.listen(PORT, () => {
  console.info(`[web] serving ${ROOT} on :${PORT} (${useTls ? 'https' : 'http'})`)
})
