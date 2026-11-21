/**
 * hub.mjs — Longtable hub supervisor (Phase 4).
 *
 * One foreground process that runs the whole hub from one config file:
 *   web        static host for the Longtable web app
 *   signaling  y-webrtc signaling (wss) — rendezvous only, sees no content
 *   turn       coturn NAT relay — relays encrypted packets only
 *   atproto    optional managed PLC+PDS (dev-grade testnet, see README)
 *   appview    public-recipe index (verify-then-index) + media cache
 *   tls-*      optional TLS proxies so devices can reach appview/PDS
 *
 * The hub is trusted for availability and NAT traversal, NEVER for
 * content: friend traffic is end-to-end encrypted, public recipes are
 * signature-verified before indexing, and the hub makes no outbound
 * connections of its own (see TELEMETRY.md).
 *
 * Usage: node hub.mjs [--config hub.conf.json]
 * Normally started via ./longtable-hub start.
 */
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_ROOT = HUB_DIR

const args = process.argv.slice(2)
const cfgIdx = args.indexOf('--config')
const CONFIG_PATH = path.resolve(
  cfgIdx >= 0 ? args[cfgIdx + 1] : path.join(BUNDLE_ROOT, 'hub.conf.json'),
)
const CONFIG_DIR = path.dirname(CONFIG_PATH)

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(
    `[hub] config not found: ${CONFIG_PATH}\n` +
      'Copy hub.conf.example.json to hub.conf.json and edit it first (see README.md).',
  )
  process.exit(2)
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))

const rel = (p, base = CONFIG_DIR) => (path.isAbsolute(p) ? p : path.resolve(base, p))
const DATA_DIR = rel(cfg.dataDir ?? './data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const name = cfg.name ?? 'longtable-hub'
const publicHost = cfg.publicHost ?? 'localhost'

const webPort = cfg.web?.port ?? 8080
const webRoot = cfg.web?.root ? rel(cfg.web.root, BUNDLE_ROOT) : path.join(BUNDLE_ROOT, 'app')
const signalingPort = cfg.signaling?.port ?? 4444
const turnCfg = cfg.turn ?? {}
const turnEnabled = turnCfg.enabled !== false
const turnPort = turnCfg.port ?? 3478
const appviewPort = cfg.appview?.port ?? 3210
const pdsEnabled = cfg.pds?.enabled !== false
const plcPort = cfg.pds?.plcPort ?? 2582
const pdsPort = cfg.pds?.pdsPort ?? 2583
const tlsCfg = cfg.tls ?? {}
const tlsProxies = tlsCfg.proxies ?? null

// ---------------------------------------------------------------- TLS ----
// Signaling is always wss: if the operator provided no certificate, mint a
// self-signed one into the data dir. Devices must trust it (or the CA that
// signed the provided cert) — see README.
function ensureTls() {
  // Sec L15 — fail closed on configured-but-missing TLS paths. The
  // old certDir branch returned paths it never checked, so an
  // operator typo (or a deleted cert dir) silently handed the
  // signaling child missing files — and the signaling server used to
  // downgrade to ws:// on that. Now a configured path that does not
  // exist is a startup error, not a downgrade. (The mint-a-cert
  // branch below is the only path that creates files, and it runs
  // only when the operator configured neither certDir nor cert/key.)
  if (tlsCfg.certDir) {
    const dir = rel(tlsCfg.certDir)
    const cert = path.join(dir, 'server.crt')
    const key = path.join(dir, 'server.key')
    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
      console.error(
        `[hub] tls.certDir is configured (${dir}) but server.crt/server.key are missing there — ` +
          'refusing to start with no TLS certificate. Fix the paths or remove tls.certDir to mint a self-signed cert.',
      )
      process.exit(2)
    }
    return { cert, key, certDir: dir }
  }
  if (tlsCfg.cert && tlsCfg.key) {
    const cert = rel(tlsCfg.cert)
    const key = rel(tlsCfg.key)
    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
      console.error(
        `[hub] tls.cert/tls.key are configured but missing: ${cert} / ${key} — refusing to start. Fix the paths.`,
      )
      process.exit(2)
    }
    const dir = path.join(DATA_DIR, 'tls')
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(cert, path.join(dir, 'server.crt'))
    fs.copyFileSync(key, path.join(dir, 'server.key'))
    return { cert, key, certDir: dir }
  }
  const dir = path.join(DATA_DIR, 'tls')
  const cert = path.join(dir, 'server.crt')
  const key = path.join(dir, 'server.key')
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    fs.mkdirSync(dir, { recursive: true })
    const san = tlsCfg.san ?? 'IP:127.0.0.1,DNS:localhost'
    console.info(`[hub] generating self-signed TLS cert (SAN ${san}) in ${dir}`)
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert,
        '-days', '825', '-subj', '/CN=longtable-hub',
        '-addext', `subjectAltName=${san}`,
      ],
      { stdio: 'inherit' },
    )
  }
  return { cert, key, certDir: dir }
}
const tls = ensureTls()

// ------------------------------------------------------------- children ----
const children = new Map()
let shuttingDown = false

function writeStatus() {
  // M5-rel hardening (rel N2): writeStatus runs inside the child-exit
  // handler, and an unguarded throw there used to crash the supervisor
  // itself — which has no restart of its own. A status write must never
  // be fatal; log and continue.
  try {
    return writeStatusInner()
  } catch (err) {
    console.error(`[hub] writeStatus failed (non-fatal): ${err?.message ?? err}`)
    return null
  }
}

function writeStatusInner() {
  const status = {
    name,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    // Blocker #14: heartbeat — rewritten every 15 s by the supervisor
    // itself, so /healthz can tell a live supervisor (fresh heartbeat)
    // from a dead one serving a stale file. Consumers must not treat
    // the file's mere existence as "up": only a fresh heartbeat is.
    heartbeatAt: new Date().toISOString(),
    endpoints: {
      web: `http://${publicHost}:${webPort}/`,
      signaling: `wss://${publicHost}:${signalingPort}`,
      turn: turnEnabled ? `turn:${publicHost}:${turnPort}` : null,
      appview: `http://${publicHost}:${appviewPort}`,
      appviewTls: tlsProxies ? `https://${publicHost}:${tlsProxies.appviewPort}` : null,
      pds: pdsEnabled ? `http://${publicHost}:${pdsPort}` : (cfg.appview?.pdsUrl ?? null),
      pdsTls: tlsProxies && pdsEnabled ? `https://${publicHost}:${tlsProxies.pdsPort}` : null,
      plc: pdsEnabled ? `http://${publicHost}:${plcPort}` : null,
    },
    children: Object.fromEntries(
      [...children.entries()].map(([k, v]) => [k, { pid: v.proc?.pid ?? null, restarts: v.restarts }]),
    ),
  }
  fs.writeFileSync(path.join(DATA_DIR, 'hub-status.json'), JSON.stringify(status, null, 2) + '\n')
  return status
}

function startChild(id, cmd, argv, opts = {}) {
  const entry = children.get(id) ?? { restarts: 0, lastStart: 0 }
  entry.lastStart = Date.now()
  const proc = spawn(cmd, argv, { cwd: opts.cwd ?? BUNDLE_ROOT, env: { ...process.env, ...opts.env }, stdio: 'inherit' })
  entry.proc = proc
  children.set(id, entry)
  console.info(`[hub] started ${id} (pid ${proc.pid})`)
  proc.on('exit', (code, signal) => {
    if (shuttingDown) return
    const uptime = Date.now() - entry.lastStart
    if (uptime > 60_000) entry.restarts = 0
    entry.restarts++
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(entry.restarts, 5))
    console.error(`[hub] ${id} exited (code=${code} signal=${signal}); restart #${entry.restarts} in ${delay}ms`)
    setTimeout(() => {
      if (!shuttingDown) {
        startChild(id, cmd, argv, opts)
        writeStatus()
      }
    }, delay)
    writeStatus()
  })
  return proc
}

// ---------------------------------------------------------------- TURN ----
// Peer ranges a hub TURN relay must never reach: "this network", RFC1918,
// CGNAT, link-local, multicast, and the v6 equivalents. TURN credentials
// are shared with every client of the hub BY DESIGN, so the relay itself
// must refuse to proxy toward the operator's LAN or the hub host —
// otherwise anyone with the (effectively public) credential can allocate
// relays to internal addresses. coturn's denied-peer-ip takes address
// RANGES (lo-hi), not CIDRs, hence the spelled-out bounds.
const DENIED_PEER_RANGES = [
  '0.0.0.0-0.255.255.255', // 0.0.0.0/8
  '10.0.0.0-10.255.255.255', // 10.0.0.0/8
  '100.64.0.0-100.127.255.255', // 100.64.0.0/10 (CGNAT)
  '127.0.0.0-127.255.255.255', // 127.0.0.0/8 (loopback)
  '169.254.0.0-169.254.255.255', // 169.254.0.0/16 (link-local)
  '172.16.0.0-172.31.255.255', // 172.16.0.0/12
  '192.168.0.0-192.168.255.255', // 192.168.0.0/16
  '224.0.0.0-239.255.255.255', // 224.0.0.0/4 (multicast)
  '192.0.0.0-192.0.0.255', // 192.0.0.0/24 (IETF protocol assignments)
  '198.18.0.0-198.19.255.255', // 198.18.0.0/15 (benchmarking)
  '240.0.0.0-255.255.255.255', // 240.0.0.0/4 (reserved; includes 255.255.255.255/32)
  '::1', // v6 loopback
  'ff00::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', // ff00::/8 (v6 multicast)
  'fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', // fc00::/7 (ULA)
  'fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', // fe80::/10 (link-local)
]
// Passwords that mean "not set": the pre-hardening shipped default and
// the example config's placeholder. Either one surviving into a real
// config would leave the relay effectively open, so both are treated as
// unset and replaced with a generated password (below).
const UNSET_TURN_PASSWORDS = new Set(['change-me', 'SET-A-STRONG-PASSWORD'])
const turnPasswordFile = path.join(DATA_DIR, 'turn-password.txt')

let turnPasswordSource = 'config'
function resolveTurnPassword() {
  const configured = turnCfg.password
  if (configured && !UNSET_TURN_PASSWORDS.has(configured)) return configured
  turnPasswordSource = 'generated'
  // Reuse the previously generated password across restarts, so clients
  // configured with it keep working (same pattern as the minted TLS cert).
  try {
    const saved = fs.readFileSync(turnPasswordFile, 'utf8').trim()
    if (saved) return saved
  } catch {
    /* not generated yet */
  }
  const generated = randomBytes(24).toString('base64url')
  fs.writeFileSync(turnPasswordFile, generated + '\n', { mode: 0o600 })
  return generated
}
const turnPassword = turnEnabled ? resolveTurnPassword() : null

// M10 — TURN quotas/caps. The relay credential is shared with every
// client of the hub by design, so the relay itself is capped: at most
// 100 concurrent allocations in total (total-quota; user-quota matches
// it because the hub has exactly one TURN user), 1 MiB/s per session
// (max-bps, bytes/s) and 50 MiB/s of relay capacity overall
// (bps-capacity, bytes/s). A single abusive client can still burn its
// own share, but it cannot take the relay — or the host's uplink —
// without bound. Rotation: delete data/turn-password.txt (or set a new
// turn.password) and restart the hub; clients must update their hub
// entry to the new credential (see README "Rotating the TURN password").
const TURN_TOTAL_QUOTA = 100
const TURN_USER_QUOTA = 100
const TURN_MAX_BPS = 1024 * 1024
const TURN_BPS_CAPACITY = 50 * 1024 * 1024

function writeTurnConfig() {
  const lines = [
    `listening-port=${turnPort}`,
    `realm=${turnCfg.realm ?? 'longtable'}`,
    `user=${turnCfg.username ?? 'longtable'}:${turnPassword}`,
    'lt-cred-mech',
    'fingerprint',
    // No 'no-loopback-peers' line: coturn 4.6.1's config parser rejects
    // it ("Bad configuration format", verified against the real binary);
    // loopback is covered by the 127.0.0.0/8 and ::1 denied ranges.
    ...DENIED_PEER_RANGES.map((r) => `denied-peer-ip=${r}`),
    // M10 quotas/caps (see TURN_* above).
    `total-quota=${TURN_TOTAL_QUOTA}`,
    `user-quota=${TURN_USER_QUOTA}`,
    `max-bps=${TURN_MAX_BPS}`,
    `bps-capacity=${TURN_BPS_CAPACITY}`,
    `log-file=${path.join(DATA_DIR, 'turn.log')}`,
    'simple-log',
  ]
  if (turnCfg.externalIp) lines.push(`external-ip=${turnCfg.externalIp}`)
  if (turnCfg.relayIp) lines.push(`relay-ip=${turnCfg.relayIp}`)
  const file = path.join(DATA_DIR, 'turnserver.conf')
  // L18: the config embeds the plaintext TURN credential, so it is
  // written 0600 via tmp+rename — never 0644 (the old default mode).
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 })
  // mode: only applies at creation — a reused tmp name could keep a
  // wider mode, so pin it explicitly before the rename.
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
  return file
}

function turnserverAvailable() {
  try {
    execFileSync('which', ['turnserver'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// -------------------------------------------------------------- startup ----
console.info(`[hub] starting "${name}" — data dir ${DATA_DIR}`)

// M15: web.tls opts the static host into HTTPS with the hub's own
// certificate (same cert as signaling). Default is plain HTTP — the
// historical behavior — because the hub mints a self-signed cert and
// browsers would warn on it; see README "Web server TLS".
const webTlsEnv =
  cfg.web?.tls === true
    ? { WEB_TLS_CERT: tls.cert, WEB_TLS_KEY: tls.key }
    : {}
// Blocker #14: the web child serves the hub health endpoint (/healthz)
// from the supervisor's status file — it needs the path, not a guess.
const hubStatusFile = path.join(DATA_DIR, 'hub-status.json')
startChild('web', process.execPath, [path.join(HUB_DIR, 'web-server.mjs')], {
  env: { WEB_PORT: String(webPort), WEB_ROOT: webRoot, HUB_STATUS_FILE: hubStatusFile, ...webTlsEnv },
})
startChild('signaling', process.execPath, [path.join(BUNDLE_ROOT, 'signaling', 'server.mjs')], {
  env: { PORT: String(signalingPort), TLS_CERT: tls.cert, TLS_KEY: tls.key },
})
// Blocker #14: whether the TURN child actually started decides
// whether the readiness gate below waits for it — a missing
// turnserver binary is a warning, not a readiness failure.
const turnStarted = turnEnabled && turnserverAvailable()
if (turnStarted) {
  startChild('turn', 'turnserver', ['-c', writeTurnConfig()])
} else if (turnEnabled) {
  console.warn('[hub] WARNING: turnserver binary not found — TURN relay disabled (direct/LAN sync still works). Install coturn to enable it.')
}
if (pdsEnabled) {
  startChild('atproto', process.execPath, [path.join(BUNDLE_ROOT, 'services', 'atproto-testnet', 'start.mjs')], {
    cwd: path.join(BUNDLE_ROOT, 'services', 'atproto-testnet'),
    env: {
      PLC_PORT: String(plcPort),
      PDS_PORT: String(pdsPort),
      PDS_DATA_DIR: path.join(DATA_DIR, 'pds'),
    },
  })
}
startChild('appview', process.execPath, [path.join(BUNDLE_ROOT, 'appview', 'index.mjs')], {
  cwd: path.join(BUNDLE_ROOT, 'appview'),
  env: {
    APPVIEW_PORT: String(appviewPort),
    APPVIEW_DB: path.join(DATA_DIR, 'appview.db'),
    APPVIEW_MEDIA: path.join(DATA_DIR, 'media'),
    PDS_URL: pdsEnabled ? `http://localhost:${pdsPort}` : (cfg.appview?.pdsUrl ?? `http://localhost:${pdsPort}`),
    PLC_URL: pdsEnabled ? `http://localhost:${plcPort}` : (cfg.appview?.plcUrl ?? `http://localhost:${plcPort}`),
  },
})
if (tlsProxies) {
  const proxy = path.join(BUNDLE_ROOT, 'services', 'atproto-testnet', 'tls-proxy.mjs')
  startChild('tls-appview', process.execPath, [proxy, String(tlsProxies.appviewPort), `http://localhost:${appviewPort}`, tls.certDir])
  if (pdsEnabled) {
    startChild('tls-pds', process.execPath, [proxy, String(tlsProxies.pdsPort), `http://localhost:${pdsPort}`, tls.certDir])
  }
}

const status = writeStatus()

// Blocker #14: supervisor heartbeat — rewrite the status file every
// 15 s so /healthz (served by the web child from this file) can tell
// a live supervisor from a dead one. writeStatus is already guarded
// (rel N2: a failed write never crashes the supervisor), and the
// timer is unref'd so it never keeps the process alive on its own.
setInterval(() => writeStatus(), 15_000).unref()

// ------------------------------------------------------------ readiness ----
function httpOk(port, pathName, expectBody = null) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout: 1500 }, (res) => {
      let body = ''
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => {
        // Any HTTP response is NOT enough: another local service squatting
        // on the port must not read as "ready" (bit us on :8081/:8082).
        if (res.statusCode !== 200) return resolve(false)
        resolve(expectBody ? body.includes(expectBody) : true)
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}
function tcpOk(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    sock.once('connect', () => {
      sock.end()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
  })
}
// Blocker #14: same shape as httpOk, over TLS. rejectUnauthorized is
// off on purpose — this is a loopback readiness probe against the
// hub's own (usually self-signed) cert, not a trust decision; the
// check is "does the proxy answer with the backend's bytes", and the
// body match below is what proves it is the right backend.
function httpsOk(port, pathName, expectBody = null) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: '127.0.0.1', port, path: pathName, timeout: 1500, rejectUnauthorized: false },
      (res) => {
        let body = ''
        res.on('data', (c) => {
          body += c
        })
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(false)
          resolve(expectBody ? body.includes(expectBody) : true)
        })
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

// Blocker #14: readiness used to cover web/signaling/appview/pds
// only — TURN and the TLS proxies were never waited for, so the hub
// could report "up" while the relay or the https front door was
// still down. TURN gets a TCP connect (coturn speaks no HTTP);
// the TLS proxies get the same body-matched GETs as their backends,
// through TLS, so a proxy answering with the wrong backend (or a
// stale one) does not read as ready.
const checks = [
  ['web', () => httpOk(webPort, '/', '<title>Longtable</title>')],
  ['signaling', () => tcpOk(signalingPort)],
  ['appview', () => httpOk(appviewPort, '/health', '"ok":true')],
  ...(pdsEnabled ? [['pds', () => httpOk(pdsPort, '/')]] : []),
  ...(turnStarted ? [['turn', () => tcpOk(turnPort)]] : []),
  ...(tlsProxies ? [['tls-appview', () => httpsOk(tlsProxies.appviewPort, '/health', '"ok":true')]] : []),
  ...(tlsProxies && pdsEnabled ? [['tls-pds', () => httpsOk(tlsProxies.pdsPort, '/')]] : []),
]
const deadline = Date.now() + 120_000
for (const [id, check] of checks) {
  let ok = false
  while (!ok && Date.now() < deadline) {
    ok = await check()
    if (!ok) await new Promise((r) => setTimeout(r, 1000))
  }
  console.info(`[hub] ${id}: ${ok ? 'ready' : 'NOT READY (still starting or failed — see child output above)'}`)
}

if (turnEnabled) {
  // M9: the password VALUE is never printed — stdout goes to data/hub.log
  // (world-readable by default), so printing it there published the
  // credential. Operators read it from the 0600 file instead.
  if (turnPasswordSource === 'generated') {
    console.info(
      `[hub] TURN password: GENERATED for this hub (turn.password is unset or ` +
        `still the placeholder) — ${turnPassword.length} chars, stored 0600 in ${turnPasswordFile}. ` +
        `Clients need it in their hub entry; set turn.password in hub.conf.json to choose your own.`,
    )
  } else {
    console.info('[hub] TURN password: as configured in hub.conf.json.')
  }
}

console.info(
  `\n[hub] "${name}" is up. Add it in the Longtable app under Hubs → Add hub:\n` +
    `  Signaling: ${status.endpoints.signaling}\n` +
    `  TURN:      ${status.endpoints.turn ?? '(disabled)'}\n` +
    `  AppView:   ${status.endpoints.appviewTls ?? status.endpoints.appview}\n` +
    `  PDS:       ${status.endpoints.pdsTls ?? status.endpoints.pds ?? '(external)'}\n` +
    `  Web app:   ${status.endpoints.web}\n`,
)

// ------------------------------------------------------------- shutdown ----
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.info(`[hub] ${signal} — stopping children`)
  for (const { proc } of children.values()) {
    try {
      proc?.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    for (const { proc } of children.values()) {
      try {
        proc?.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    process.exit(0)
  }, 5000).unref()
  setTimeout(() => process.exit(0), 5500).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
