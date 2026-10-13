// Longtable Phase 3 — local ATProto testnet (PLC + PDS, no AppView).
//
// Boots Bluesky's own TestNetworkNoAppView from @atproto/dev-env:
// a real PLC server (@did-plc/server, in-memory mock DB) and a real PDS
// (@atproto/pds, SQLite + disk blobstore under a tmp data directory).
//
// Installed @atproto/dev-env@0.3.215 API (inspected in
// node_modules/@atproto/dev-env/dist/, not guessed):
//   TestNetworkNoAppView.create(params?: Partial<TestServerParams>)
//   TestServerParams.plc: Partial<PlcConfig>  // PlcConfig.port?: number
//   TestServerParams.pds: Partial<PdsConfig>  // PdsConfig = Partial<ServerEnvironment>
//                                             //   & { didPlcUrl: string }
//   network-no-appview.js create() does:
//     plc = TestPlc.create(params.plc ?? {})
//     pds = TestPds.create({ didPlcUrl: plc.url, ...params.pds })
//     TestPds.create() reads `config.port` for the listen port.
// Ports and the PDS data directory are env-configurable so multiple
// instances can run side by side (Phase 4: two packaged hubs on one box).
// Defaults are exactly the Phase 3 dev values. (TestPds spreads the pds
// params over its env defaults, so dataDirectory/blobstoreDiskLocation
// passed via params win over dev-env's tmpdir defaults.)
//
// DID registration/resolution stays fully local: the PDS is created with
// didPlcUrl = http://localhost:2582, and dev-env's mockNetworkUtilities()
// rewrites handle/DID resolution inside the PDS to the local services.
// Nothing talks to plc.directory or bsky.social.
//
// The package is CommonJS (dist/index.js, no "type": "module"), so it is
// loaded via createRequire instead of relying on ESM named-export interop.

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { TestNetworkNoAppView } = require('@atproto/dev-env')

// Ports and the PDS data directory are env-configurable so multiple
// instances can run side by side (Phase 4: two packaged hubs on one box).
// Defaults are exactly the Phase 3 dev values.
const PLC_PORT = Number(process.env.PLC_PORT ?? 2582)
const PDS_PORT = Number(process.env.PDS_PORT ?? 2583)
const PDS_DATA_DIR = process.env.PDS_DATA_DIR || ''

let network = null
let closing = false

async function close(signal) {
  if (closing) return
  closing = true
  console.log(`[atproto-testnet] ${signal} received, shutting down...`)
  try {
    if (network) await network.close()
    console.log('[atproto-testnet] closed cleanly')
  } catch (err) {
    console.error('[atproto-testnet] error during shutdown:', err)
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', () => void close('SIGINT'))
process.on('SIGTERM', () => void close('SIGTERM'))

try {
  const pdsParams = { port: PDS_PORT }
  if (PDS_DATA_DIR) {
    // TestPds spreads params over its env defaults, so these win: the
    // PDS repo DB + blobstore live under the hub's data directory.
    fs.mkdirSync(PDS_DATA_DIR, { recursive: true })
    pdsParams.dataDirectory = PDS_DATA_DIR
    pdsParams.blobstoreDiskLocation = path.join(PDS_DATA_DIR, 'blobs')
  }
  network = await TestNetworkNoAppView.create({
    plc: { port: PLC_PORT },
    pds: pdsParams,
  })
} catch (err) {
  console.error('[atproto-testnet] failed to start:', err)
  process.exit(1)
}

console.log(`[atproto-testnet] PLC: ${network.plc.url}`)
console.log(`[atproto-testnet] PDS: ${network.pds.url}`)
console.log(
  '[atproto-testnet] running (ephemeral: all accounts/DIDs vanish on restart; re-run `npm run seed` after every start)',
)

// Stay alive until signalled.
await new Promise(() => {})
