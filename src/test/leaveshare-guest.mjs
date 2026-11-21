/**
 * Minimal second device for the leaveShare proof (leaveshare.test.ts).
 *
 * This is NOT the production join path — it is the OTHER device at the
 * y-webrtc level: a real WebrtcProvider on a real Y.Doc, syncing with the
 * host over BroadcastChannel (same-process) and rendezvousing through the
 * real local signaling server. The production join path (joinShare) is
 * covered in the main thread by the join/leave round-trip test; the guest
 * here exists so the host's provider has a live peer holding the doc —
 * without one, "the doc does not come back" would be vacuous.
 *
 * Plain .mjs (not .ts): node worker threads cannot import the repo's
 * extensionless .ts sources (type stripping needs explicit extensions),
 * so the guest drives the real y-webrtc/yjs packages directly.
 *
 * Protocol (workerData in, postMessage out):
 *   in:  { room, secret, signaling, recipeId, snapshot }
 *   out: { type: 'synced', title }      — title arrived (via snapshot or sync)
 *        { type: 'update', title }      — doc changed (local or remote edit)
 *        { type: 'title', title }       — reply to a getTitle request
 *        { type: 'destroyed' }          — reply to a destroy request
 *   in:  { type: 'getTitle' } | { type: 'edit', title } | { type: 'destroy' }
 */
import { Buffer } from 'node:buffer'
import { clearInterval, setInterval, setTimeout } from 'node:timers'
import { parentPort, workerData } from 'node:worker_threads'
import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'

const doc = new Y.Doc({ guid: workerData.recipeId })
if (workerData.snapshot) {
  Y.applyUpdate(doc, Buffer.from(workerData.snapshot, 'base64'))
}
const map = doc.getMap('recipe')
const provider = new WebrtcProvider(workerData.room, doc, {
  signaling: workerData.signaling,
  password: workerData.secret,
  peerOpts: { config: { iceServers: [] } },
})

function title() {
  const t = map.get('title')
  return typeof t === 'string' ? t : null
}

map.observe(() => {
  parentPort.postMessage({ type: 'update', title: title() })
})

// The snapshot usually carries the title already; otherwise wait for sync.
const t0 = Date.now()
const iv = setInterval(() => {
  if (title() !== null || Date.now() - t0 > 15000) {
    clearInterval(iv)
    parentPort.postMessage({ type: 'synced', title: title() })
  }
}, 100)

parentPort.on('message', (msg) => {
  if (msg.type === 'getTitle') {
    parentPort.postMessage({ type: 'title', title: title() })
  } else if (msg.type === 'edit') {
    doc.transact(() => {
      map.set('title', msg.title)
    })
  } else if (msg.type === 'destroy') {
    provider.destroy()
    setTimeout(() => parentPort.postMessage({ type: 'destroyed' }), 200)
  }
})
