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
// So fixed ports are: { plc: { port: 2582 }, pds: { port: 2583 } }.
//
// DID registration/resolution stays fully local: the PDS is created with
// didPlcUrl = http://localhost:2582, and dev-env's mockNetworkUtilities()
// rewrites handle/DID resolution inside the PDS to the local services.
// Nothing talks to plc.directory or bsky.social.
//
// The package is CommonJS (dist/index.js, no "type": "module"), so it is
// loaded via createRequire instead of relying on ESM named-export interop.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { TestNetworkNoAppView } = require('@atproto/dev-env')

const PLC_PORT = 2582
const PDS_PORT = 2583

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
  network = await TestNetworkNoAppView.create({
    plc: { port: PLC_PORT },
    pds: { port: PDS_PORT },
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
