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
 * Reconcile is verify-then-index, at TWO levels: reconcileRepo(did)
 * asks the repo-state provider (verify.mjs in production) for the DID's
 * *signature-verified* repo state and diffs the index against it, and then
 * verifies every recipe's DEVICE signature against the author's
 * kitchen.longtable.pubkey bindings from that same verified state
 * (device-signature.mjs) — one binding per device (H-N1), each recipe
 * checked against its own device's binding. The repo-commit signature
 * alone is not the device guarantee — the PDS holds the repo key and
 * produces it — so a record whose device signature is missing, mismatched
 * or forged is dropped and counted (stats.rejected /
 * stats.signatureRejected), never indexed. Records that are merely
 * *claimed* (by a firehose frame, a hub, or a direct ingestClaim call)
 * are never indexed on their own.
 */
import WebSocket from 'ws'
import { cborDecodeMulti } from '@atproto/common'
import { cidForRecord } from '@atproto/repo'
import { RECIPE_COLLECTION, PUBKEY_COLLECTION } from './db.mjs'
import { verifyPubkeyBindings, verifyRecipeDeviceSignature } from './device-signature.mjs'

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

  const stats = { indexed: 0, rejected: 0, signatureRejected: 0, sweepSkipped: 0, lastReconcileAt: null }
  let ws = null
  let reconnectTimer = null
  let reconcileTimer = null
  let closed = false
  let queue = Promise.resolve()

  /**
   * Fetch the verified repo state for `did` and diff the index against it:
   * upsert new/changed recipes, delete recipes that vanished from the repo.
   * On any verification failure: index nothing, stats.rejected++, {ok:false}.
   *
   * Binding-failure sweep rule (N1 / M-N5): NO binding at all is
   * ambiguous — a binding commit may simply not have arrived yet — so
   * new records are rejected but the sweep is skipped and
   * previously-verified rows stay until re-verified. A recipe whose
   * device has no binding while OTHER devices are bound is positive
   * evidence that device is unbound (its binding was deleted or never
   * existed), so it is rejected and its old row IS swept. Any other
   * binding failure is positive evidence the binding is wrong, so the
   * sweep runs. The one exception is a verified-EMPTY repo state: with
   * no recipe records at all there is nothing ambiguous left, so the
   * sweep runs as the author's deletion.
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
    // Device-signature gate (C2, per-device since H-N1): the repo state
    // is commit-verified, but the PDS holds the repo key — only the device
    // signature proves the author's device wrote the recipe. Load ALL of
    // the author's kitchen.longtable.pubkey bindings from the SAME verified
    // CAR (one record per device at its per-device rkey; the legacy `self`
    // record counts as one device's binding), verify each binding
    // signature, then verify each recipe against ITS OWN device's binding.
    // Records that fail any check are dropped and counted
    // (stats.rejected + stats.signatureRejected) — never indexed — and any
    // previously-indexed row for a dropped record is deleted by the sweep
    // below (it is not added to `seen`). A device publishing a binding
    // never affects another device's recipes: rebind is additive now.
    const records = state.records ?? []
    const {
      bindings,
      candidates,
      firstInvalidReason,
      ignoredRkeys,
    } = await verifyPubkeyBindings(did, records)
    if (ignoredRkeys.length > 0) {
      log.warn?.(
        `[appview] reconcile ${did}: ignored ${ignoredRkeys.length} pubkey record(s) at unexpected rkey(s): ${ignoredRkeys.join(', ')}`,
      )
    }
    // The single binding reason the result reports: null while at least
    // one device is bound; 'missing-binding' when the repo carries no
    // binding record at all; otherwise the first invalid binding's
    // reason (positive evidence the binding is wrong).
    const bindingReason =
      bindings.size > 0
        ? null
        : candidates === 0
          ? 'missing-binding'
          : firstInvalidReason
    let signatureRejected = 0
    const reject = (entry, reason) => {
      signatureRejected++
      stats.rejected++
      stats.signatureRejected++
      log.warn?.(
        `[appview] reconcile ${did}: dropped ${entry.collection}/${entry.rkey}: device signature rejected (${reason})`,
      )
    }
    if (bindings.size === 0) {
      for (const entry of records) {
        if (entry.collection !== RECIPE_COLLECTION) continue
        reject(entry, bindingReason)
      }
    }
    // N1 sweep-skip: no binding at all + recipe records present in the
    // verified state means the evidence is ambiguous (transient gap),
    // so keep previously-verified rows. No binding with zero recipe
    // records is a verified-empty repo — the sweep is the author's
    // deletion, so it runs. Any other binding failure (invalid key /
    // bad binding signature / key mismatch) is positive evidence the
    // binding is wrong — so the sweep runs as before and rows for the
    // unbound device leave. A recipe whose device has no binding while
    // OTHER devices are bound is the same positive evidence (its binding
    // was deleted or never existed) — it is dropped below and its old row
    // is swept, while the bound devices' rows stay.
    const recipeCount = records.filter((r) => r.collection === RECIPE_COLLECTION).length
    const skipSweep = bindings.size === 0 && candidates === 0 && recipeCount > 0
    const seen = new Set()
    let changed = 0
    for (const entry of records) {
      if (entry.collection !== RECIPE_COLLECTION) continue
      const binding = bindings.get(entry.record?.deviceDid)
      if (!binding) {
        // No verified binding for THIS device. When no device is bound
        // at all the recipe was already rejected above with the
        // account-level reason; here the account HAS bindings, so this
        // device specifically is unbound — reject with missing-binding
        // and let the sweep drop its previously-indexed row.
        if (bindings.size > 0) reject(entry, 'missing-binding')
        continue
      }
      const check = await verifyRecipeDeviceSignature(did, entry.record, binding)
      if (!check.ok) {
        reject(entry, check.reason)
        continue
      }
      const uri = `at://${did}/${entry.collection}/${entry.rkey}`
      seen.add(uri)
      if (
        index.upsert({
          uri,
          did,
          rkey: entry.rkey,
          cid: entry.cid,
          record: entry.record,
          deviceKey: binding.devicePublicKey,
        })
      ) {
        changed++
        stats.indexed++
      }
    }
    let deleted = 0
    if (skipSweep) {
      stats.sweepSkipped++
      log.warn?.(
        `[appview] reconcile ${did}: binding missing, sweep skipped — ${index.listUrisByDid(did).length} previously-indexed rows kept until re-verified`,
      )
    } else {
      for (const uri of index.listUrisByDid(did)) {
        if (!seen.has(uri)) {
          index.deleteByUri(uri)
          deleted++
        }
      }
    }
    stats.lastReconcileAt = new Date().toISOString()
    return { ok: true, did, indexed: changed, deleted, total: seen.size, rejected: signatureRejected, signatureRejected, sweepSkipped: skipSweep, bindingReason, bindings: bindings.size }
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
   * claimed bytes). Reconcile additionally enforces the device
   * signature (see reconcileRepo): a record present in the repo but
   * failing device verification is dropped there, so ingestClaim reports
   * indexed:false with reason 'device-signature-rejected'.
   *
   * Sweep-skip + periodic sweep (N1 / M-N5, S2): a *missing* pubkey
   * binding is ambiguous (the binding commit may not have arrived yet),
   * so reconcile rejects new records but skips the sweep-delete and keeps
   * previously-verified rows; a periodic sweep (reconcileAllDids, hourly
   * by default, plus a startup reconcile in index.mjs) re-verifies every
   * DID in the index, so a healed binding re-indexes the author without
   * waiting for their next repo commit.
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
    // S12: route the reconcile through the same serialized queue as the
    // firehose path. Two concurrent reconciles for one DID used to
    // interleave upsert/delete sweeps, so a stale-state reconcile
    // finishing last could delete a record the fresh one just indexed.
    // `queue` takes the caught copy so a throwing reconcile never
    // poisons the chain; `run` itself is awaited, so its error still
    // propagates to this caller exactly as before.
    const run = queue.then(() => reconcileRepo(did))
    queue = run.catch(() => {})
    const reconciled = await run
    const uri = `at://${did}/${collection}/${rkey}`
    const indexed = collection === RECIPE_COLLECTION && index.hasUri(uri)
    if (!reconciled.ok) {
      return { indexed: false, verified: true, claimedCid, reason: 'verification-failed' }
    }
    if (!indexed && collection === RECIPE_COLLECTION) {
      // The record IS in the verified repo state, but reconcile dropped it:
      // the only gate left after CID equality is the device signature.
      return { indexed: false, verified: true, claimedCid, reason: 'device-signature-rejected' }
    }
    return { indexed, verified: true, claimedCid }
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

  /**
   * Reconcile every DID present in the index, serialized through the
   * same queue as firehose reconciles. This is the healing path for
   * N1/S2 (and the reconcile half of prior H3): a DID whose binding
   * was missing (sweep skipped, rows kept) or whose rows predate
   * device verification (NULL signature fields) is re-verified here
   * without waiting for the author's next repo commit — which, for a
   * dormant author, may never come. The startup reconcile in index.mjs
   * and the periodic timer both call this. One DID's failure never
   * aborts the rest. (The firehose cursor itself is Wave 4, not this
   * sweep: the sweep only revisits DIDs already in the index.)
   */
  async function reconcileAllDids() {
    const run = queue.then(async () => {
      const results = []
      for (const did of index.listDids()) {
        try {
          results.push(await reconcileRepo(did))
        } catch (err) {
          stats.rejected++
          log.warn?.(`[appview] reconcile-all ${did} failed: ${err?.message ?? err}`)
          results.push({ ok: false, did, error: String(err?.message ?? err) })
        }
      }
      return results
    })
    queue = run.catch(() => {})
    return run
  }

  /**
   * Start the periodic reconcile sweep (default hourly). The timer is
   * unref'd so it never keeps the process alive on its own, and a
   * sweep already in flight is never overlapped — the next one chains
   * behind it on the queue.
   */
  function startPeriodicReconcile(intervalMs = 3600000) {
    if (reconcileTimer) return reconcileTimer
    reconcileTimer = setInterval(() => {
      reconcileAllDids().catch(() => {})
    }, intervalMs)
    reconcileTimer.unref?.()
    return reconcileTimer
  }

  function stopPeriodicReconcile() {
    if (reconcileTimer) {
      clearInterval(reconcileTimer)
      reconcileTimer = null
    }
  }

  function close() {
    closed = true
    stopPeriodicReconcile()
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
    reconcileAllDids,
    startPeriodicReconcile,
    stopPeriodicReconcile,
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
