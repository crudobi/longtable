/**
 * ingest.mjs — filtered firehose ingest + reconcile + the forge-test hook.
 *
 * Filtering principle (wantedCollections at the consumer): the firehose
 * carries every collection on the PDS. We subscribe to the PDS's own
 * repo firehose and, for each #commit event, look only at its ops. Unless
 * at least one op path starts with `kitchen.longtable.recipe/` or
 * `kitchen.longtable.pubkey/`, the event is ignored entirely — no fetch,
 * no reconcile, no index write.
 *
 * Reconcile is verify-then-index: reconcileRepo(did) asks the repo-state
 * provider (verify.mjs in production) for the DID's *signature-verified*
 * repo state and diffs the index against it. Records that are merely
 * *claimed* (by a firehose frame, a hub, or a direct ingestClaim call) are
 * never indexed on their own.
 */
import WebSocket from 'ws'
import { cborDecodeMulti } from '@atproto/common'
import { cidForRecord } from '@atproto/repo'
import { RECIPE_COLLECTION, PUBKEY_COLLECTION } from './db.mjs'

export const WANTED_COLLECTIONS = [RECIPE_COLLECTION, PUBKEY_COLLECTION]

/** Cap on a single firehose frame (16 MiB): commit frames are small;
 * the ws default is unlimited, so one oversized frame could OOM us. */
export const MAX_FIREHOSE_FRAME_BYTES = 16 * 1024 * 1024

export function isWantedPath(path) {
  return (
    typeof path === 'string' &&
    WANTED_COLLECTIONS.some((c) => path === c || path.startsWith(`${c}/`))
  )
}

/**
 * Module-level convenience: server.mjs registers the app's ingestor as the
 * default, so tests can `import { ingestClaim } from './ingest.mjs'` and
 * call ingestClaim({did, collection, rkey, record}) directly.
 */
let defaultIngestor = null
export function setDefaultIngestor(ingestor) {
  defaultIngestor = ingestor
}
export async function ingestClaim(claim) {
  if (!defaultIngestor) {
    throw new Error('ingestClaim: no ingestor registered (call createIngestor/setDefaultIngestor first)')
  }
  return defaultIngestor.ingestClaim(claim)
}

export function createIngestor({ index, repoStateProvider, pdsUrl, log = console } = {}) {
  if (!index) throw new Error('createIngestor: index is required')
  if (typeof repoStateProvider !== 'function') {
    throw new Error('createIngestor: repoStateProvider function is required')
  }

  const stats = { indexed: 0, rejected: 0, lastReconcileAt: null }
  let ws = null
  let reconnectTimer = null
  let closed = false
  let queue = Promise.resolve()

  /**
   * Fetch the verified repo state for `did` and diff the index against it:
   * upsert new/changed recipes, delete recipes that vanished from the repo.
   * On any verification failure: index nothing, stats.rejected++, {ok:false}.
   */
  async function reconcileRepo(did) {
    let state
    try {
      state = await repoStateProvider(did)
    } catch (err) {
      stats.rejected++
      log.warn?.(`[appview] reconcile ${did} rejected: ${err?.message ?? err}`)
      return { ok: false, did, error: String(err?.message ?? err) }
    }
    const seen = new Set()
    let changed = 0
    for (const entry of state.records ?? []) {
      if (entry.collection !== RECIPE_COLLECTION) continue
      const uri = `at://${did}/${entry.collection}/${entry.rkey}`
      seen.add(uri)
      if (index.upsert({ uri, did, rkey: entry.rkey, cid: entry.cid, record: entry.record })) {
        changed++
        stats.indexed++
      }
    }
    let deleted = 0
    for (const uri of index.listUrisByDid(did)) {
      if (!seen.has(uri)) {
        index.deleteByUri(uri)
        deleted++
      }
    }
    stats.lastReconcileAt = new Date().toISOString()
    return { ok: true, did, indexed: changed, deleted, total: seen.size }
  }

  /**
   * Forge-injection hook (tests): simulates a hostile firehose/hub claim
   * "DID <did> has record <record> at <collection>/<rkey>".
   *
   * The claim is believed only if the record's CID — computed here with
   * @atproto/repo's cidForRecord (DAG-CBOR + sha-256, the same CID the repo
   * itself assigns) — is present, with that exact collection+rkey+CID, in
   * the DID's signature-verified repo state. Otherwise stats.rejected++
   * and nothing is indexed. If it *is* present, a full reconcile runs
   * (which is what indexes it, from the verified state — not from the
   * claimed bytes).
   */
  async function ingestClaim({ did, collection, rkey, record } = {}) {
    let claimedCid
    try {
      claimedCid = (await cidForRecord(record)).toString()
    } catch (err) {
      stats.rejected++
      return { indexed: false, reason: 'unencodable-record', error: String(err?.message ?? err) }
    }
    let state
    try {
      state = await repoStateProvider(did)
    } catch (err) {
      stats.rejected++
      return { indexed: false, reason: 'verification-failed', error: String(err?.message ?? err) }
    }
    const found = (state.records ?? []).find(
      (r) => r.collection === collection && r.rkey === rkey && r.cid === claimedCid,
    )
    if (!found) {
      stats.rejected++
      return { indexed: false, reason: 'not-in-verified-repo', claimedCid }
    }
    await reconcileRepo(did)
    const uri = `at://${did}/${collection}/${rkey}`
    return { indexed: collection === RECIPE_COLLECTION && index.hasUri(uri), verified: true, claimedCid }
  }

  /** Handle one decoded firehose frame header/body pair. Returns true if it triggered work. */
  function handleFrame(header, body) {
    if (!header || header.op !== 1 || header.t !== '#commit' || !body) return false
    const ops = Array.isArray(body.ops) ? body.ops : []
    if (!ops.some((op) => isWantedPath(op?.path))) return false
    const did = body.repo
    if (typeof did !== 'string' || !did.startsWith('did:')) return false
    // Serialize reconciles so overlapping commits for many repos stay ordered.
    queue = queue.then(() => reconcileRepo(did)).catch(() => {})
    return true
  }

  function handleMessage(data) {
    let frames
    try {
      frames = cborDecodeMulti(new Uint8Array(data))
    } catch {
      return false
    }
    if (!Array.isArray(frames) || frames.length < 2) return false
    return handleFrame(frames[0], frames[1])
  }

  function firehoseUrl() {
    const base = (pdsUrl ?? '').replace(/\/$/, '')
    return `${base.replace(/^http/, 'ws')}/xrpc/com.atproto.sync.subscribeRepos`
  }

  function startFirehose() {
    if (ws || closed) return
    const url = firehoseUrl()
    log.info?.(`[appview] subscribing to firehose ${url}`)
    ws = new WebSocket(url, { maxPayload: MAX_FIREHOSE_FRAME_BYTES })
    ws.on('message', (data) => {
      try {
        handleMessage(data)
      } catch (err) {
        log.warn?.(`[appview] firehose frame error: ${err?.message ?? err}`)
      }
    })
    ws.on('error', (err) => {
      log.warn?.(`[appview] firehose error: ${err?.message ?? err}`)
    })
    ws.on('close', () => {
      ws = null
      if (!closed) {
        reconnectTimer = setTimeout(() => startFirehose(), 2000)
        reconnectTimer.unref?.()
      }
    })
  }

  function close() {
    closed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (ws) {
      try {
        ws.terminate()
      } catch {
        // already gone
      }
      ws = null
    }
  }

  return {
    stats,
    reconcileRepo,
    ingestClaim,
    handleFrame,
    handleMessage,
    startFirehose,
    close,
    get pending() {
      return queue
    },
  }
}
