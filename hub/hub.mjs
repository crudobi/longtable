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
import fs from 'node:fs'
import http from 'node:http'
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
  if (tlsCfg.certDir) {
    const dir = rel(tlsCfg.certDir)
    return { cert: path.join(dir, 'server.crt'), key: path.join(dir, 'server.key'), certDir: dir }
  }
  if (tlsCfg.cert && tlsCfg.key) {
    const cert = rel(tlsCfg.cert)
    const key = rel(tlsCfg.key)
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
  const status = {
    name,
    pid: process.pid,
    startedAt: new Date().toISOString(),
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
function writeTurnConfig() {
  const lines = [
    `listening-port=${turnPort}`,
    `realm=${turnCfg.realm ?? 'longtable'}`,
    `user=${turnCfg.username ?? 'longtable'}:${turnCfg.password ?? 'change-me'}`,
    'lt-cred-mech',
    'fingerprint',
    `log-file=${path.join(DATA_DIR, 'turn.log')}`,
    'simple-log',
  ]
  if (turnCfg.externalIp) lines.push(`external-ip=${turnCfg.externalIp}`)
  if (turnCfg.relayIp) lines.push(`relay-ip=${turnCfg.relayIp}`)
  const file = path.join(DATA_DIR, 'turnserver.conf')
  fs.writeFileSync(file, lines.join('\n') + '\n')
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

startChild('web', process.execPath, [path.join(HUB_DIR, 'web-server.mjs')], {
  env: { WEB_PORT: String(webPort), WEB_ROOT: webRoot },
})
startChild('signaling', process.execPath, [path.join(BUNDLE_ROOT, 'signaling', 'server.mjs')], {
  env: { PORT: String(signalingPort), TLS_CERT: tls.cert, TLS_KEY: tls.key },
})
if (turnEnabled && turnserverAvailable()) {
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

const checks = [
  ['web', () => httpOk(webPort, '/', '<title>Longtable</title>')],
  ['signaling', () => tcpOk(signalingPort)],
  ['appview', () => httpOk(appviewPort, '/health', '"ok":true')],
  ...(pdsEnabled ? [['pds', () => httpOk(pdsPort, '/')]] : []),
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
