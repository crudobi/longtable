/**
 * tls-proxy.mjs — test-only TLS terminator for the local testnet.
 *
 * The Longtable app runs on an https://localhost origin (Capacitor), so from
 * the Android emulator it cannot fetch plain-http services (mixed content +
 * cleartext policy). This proxy terminates TLS with the e2e fixture CA's
 * server cert (SAN IP:10.0.2.2, already in the emulator's user trust store;
 * the debug build trusts user CAs) and forwards to a local http service.
 *
 * Usage: node tls-proxy.mjs <listenPort> <targetBaseUrl> [certDir]
 *   node tls-proxy.mjs 2584 http://localhost:2583   (PDS)
 *   node tls-proxy.mjs 3211 http://localhost:3210   (AppView)
 * certDir defaults to /home/devbox/tools/android-emu/fixture-certs
 * (server.crt/server.key, machine-level test CA — never committed).
 */
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const [listenPort, targetBase, certDirArg] = process.argv.slice(2)
if (!listenPort || !targetBase) {
  console.error('usage: tls-proxy.mjs <listenPort> <targetBaseUrl> [certDir]')
  process.exit(2)
}
const certDir = certDirArg || '/home/devbox/tools/android-emu/fixture-certs'
const target = new URL(targetBase)

const server = https.createServer(
  {
    cert: fs.readFileSync(path.join(certDir, 'server.crt')),
    key: fs.readFileSync(path.join(certDir, 'server.key')),
  },
  (req, res) => {
    const opts = {
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    }
    const upstream = http.request(opts, (up) => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'proxy upstream failed', detail: String(e) }))
    })
    req.pipe(upstream)
  },
)
server.listen(Number(listenPort), '0.0.0.0', () => {
  console.log(`tls-proxy :${listenPort} -> ${targetBase}`)
})
