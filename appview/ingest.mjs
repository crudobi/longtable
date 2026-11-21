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
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { cborDecodeMulti } from '@atproto/common'
import { cidForRecord } from '@atproto/repo'
import { RECIPE_COLLECTION, PUBKEY_COLLECTION } from './db.mjs'
import { verifyPubkeyBindings, verifyRecipeDeviceSignature, cidObjectToString } from './device-signature.mjs'

export const WANTED_COLLECTIONS = [RECIPE_COLLECTION, PUBKEY_COLLECTION]

/** Cap on a single firehose frame (16 MiB): commit frames are small;
 * the ws default is unlimited, so one oversized frame could OOM us. */
export const MAX_FIREHOSE_FRAME_BYTES = 16 * 1024 * 1024

/**
 * H3 — persisted firehose cursor. subscribeRepos accepts a `cursor`
 * (a commit sequence number) and replays from there, so a restarted
 * AppView resumes where it left off instead of re-scanning the whole
 * firehose from scratch. The cursor lives in a small JSON file next
 * to the index DB (default `<db dir>/firehose-cursor.json`, overridable
 * via APPVIEW_FIREHOSE_CURSOR); it is written throttled (at most once
 * per save interval) while frames arrive, and once more on shutdown.
 * A corrupt/missing file means "no cursor" — the firehose is simply
 * subscribed without one, exactly as before this change.
 */
export function loadFirehoseCursor(cursorPath) {
  if (!cursorPath) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorPath, 'utf8'))
    const seq = Number(parsed?.seq)
    return Number.isFinite(seq) && seq >= 0 ? Math.trunc(seq) : null
  } catch {
    return null
  }
}

export function saveFirehoseCursor(cursorPath, seq) {
  if (!cursorPath) return
  const dir = path.dirname(cursorPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${cursorPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({ seq, updatedAt: new Date().toISOString() }) + '\n')
  fs.renameSync(tmp, cursorPath)
}

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

/**
 * S15 — per-repo reconcile budget. One huge repo used to head-of-line
 * block the shared queue: reconcileRepo verified every record in the
 * repo state before the next DID's reconcile could run (the 100 MiB
 * CAR cap bounds bytes, not record count). A reconcile now stops after
 * MAX_RECONCILE_RECORDS records or MAX_RECONCILE_MS milliseconds and
 * leaves the rest for the next periodic sweep — and, critically, SKIPS
 * the sweep-delete when it stops early, because `seen` is incomplete
 * and a sweep would delete rows for records it never looked at.
 * Defaults: 5000 records / 30 s — far above any real author's repo
 * (device-signature verification is sub-millisecond per record), low
 * enough that one DID cannot stall the queue for minutes.
 */
export const MAX_RECONCILE_RECORDS = 5000
export const MAX_RECONCILE_MS = 30_000

/**
 * Int M1 — lexicon/per-record validation on ingest. C2 verifies the
 * binding + every recipe signature, but nothing checked the record
 * shape: recordToRow coerces arbitrary values and never rejects. These
 * caps are the kitchen.longtable.recipe lexicon's own bounds
 * (lexicons/kitchen.longtable.recipe.json) — a record outside them is
 * not a conformant recipe, so reconcile rejects it, counts it
 * (stats.validationRejected) and never indexes it. The signature check
 * still runs for records that pass validation; validation runs first
 * because it is cheap and the signature check is not.
 */
export const RECIPE_LIMITS = {
  nameMaxLength: 300,
  descriptionMaxLength: 3000,
  ingredientsMax: 100,
  ingredientMaxLength: 1000,
  instructionsMax: 200,
  instructionMaxLength: 5000,
  minutesMax: 10080,
  yieldMaxLength: 100,
  tagsMax: 20,
  tagMaxLength: 64,
  imagesMax: 10,
  deviceSignatureMaxLength: 256,
  longtableIdMaxLength: 64,
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

function isStringArrayWithin(v, maxItems, maxItemLength) {
  return (
    Array.isArray(v) &&
    v.length <= maxItems &&
    v.every((s) => typeof s === 'string' && s.length <= maxItemLength)
  )
}

function isValidMinutes(v) {
  return (
    v === undefined ||
    (typeof v === 'number' &&
      Number.isInteger(v) &&
      v >= 0 &&
      v <= RECIPE_LIMITS.minutesMax)
  )
}

/**
 * Validate one recipe record against the lexicon shape. Returns null
 * when the record is conformant, else a short machine-readable reason
 * (no record content is ever logged — the caller logs the reason only).
 * Checks, in order: the record is an object; $type is exactly the
 * recipe collection; required fields are present with the right types;
 * every field is within its lexicon cap.
 */
export function validateRecipeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return 'invalid-record:not-an-object'
  }
  if (record.$type !== RECIPE_COLLECTION) {
    return 'invalid-record:bad-$type'
  }
  if (!isNonEmptyString(record.name) || record.name.length > RECIPE_LIMITS.nameMaxLength) {
    return 'invalid-record:bad-name'
  }
  if (!Array.isArray(record.ingredients) || !isStringArrayWithin(record.ingredients, RECIPE_LIMITS.ingredientsMax, RECIPE_LIMITS.ingredientMaxLength)) {
    return 'invalid-record:bad-ingredients'
  }
  if (!Array.isArray(record.instructions) || !isStringArrayWithin(record.instructions, RECIPE_LIMITS.instructionsMax, RECIPE_LIMITS.instructionMaxLength)) {
    return 'invalid-record:bad-instructions'
  }
  if (!isNonEmptyString(record.createdAt) || Number.isNaN(Date.parse(record.createdAt))) {
    return 'invalid-record:bad-createdAt'
  }
  if (!isNonEmptyString(record.longtableId) || record.longtableId.length > RECIPE_LIMITS.longtableIdMaxLength) {
    return 'invalid-record:bad-longtableId'
  }
  if (
    record.description !== undefined &&
    (typeof record.description !== 'string' || record.description.length > RECIPE_LIMITS.descriptionMaxLength)
  ) {
    return 'invalid-record:bad-description'
  }
  if (!isValidMinutes(record.prepTimeMinutes) || !isValidMinutes(record.cookTimeMinutes)) {
    return 'invalid-record:bad-minutes'
  }
  if (
    record.recipeYield !== undefined &&
    (typeof record.recipeYield !== 'string' || record.recipeYield.length > RECIPE_LIMITS.yieldMaxLength)
  ) {
    return 'invalid-record:bad-yield'
  }
  if (
    record.tags !== undefined &&
    !isStringArrayWithin(record.tags, RECIPE_LIMITS.tagsMax, RECIPE_LIMITS.tagMaxLength)
  ) {
    return 'invalid-record:bad-tags'
  }
  if (record.images !== undefined) {
    if (!Array.isArray(record.images) || record.images.length > RECIPE_LIMITS.imagesMax) {
      return 'invalid-record:bad-images'
    }
    for (const img of record.images) {
      const ref = img?.ref
      // Image refs accept the live CAR-decoded CID-object shape as well
      // as the JSON string / {$link} shapes: reconcile verifies records
      // from getAndParseRecord (dag-cbor), where a blob ref is a
      // multiformats CID object, not {$link}. See cidObjectToString.
      const ok =
        img !== null &&
        typeof img === 'object' &&
        (typeof ref === 'string' ||
          typeof ref?.$link === 'string' ||
          cidObjectToString(ref) !== null)
      if (!ok) return 'invalid-record:bad-images'
    }
  }
  if (
    record.deviceSignature !== undefined &&
    (typeof record.deviceSignature !== 'string' ||
      record.deviceSignature.length > RECIPE_LIMITS.deviceSignatureMaxLength)
  ) {
    return 'invalid-record:bad-deviceSignature'
  }
  if (
    record.updatedAt !== undefined &&
    (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt)))
  ) {
    return 'invalid-record:bad-updatedAt'
  }
  return null
}

export function createIngestor(
  {
    index,
    repoStateProvider,
    pdsUrl,
    log = console,
    // H1: the media cache — the reconcile sweep purges blobs for rows
    // it deletes (unpublish/delete). Optional; ingest without a cache
    // (unit tests) simply skips the purge.
    media = null,
    // H3: where the firehose cursor persists (null disables it).
    firehoseCursorPath = null,
    firehoseCursorSaveIntervalMs = 5000,
    // H3: a cursor'd connection that dies this fast having received
    // nothing almost certainly had its cursor rejected (too old) — drop
    // the cursor once and reconnect without it instead of looping.
    firehoseCursorStaleCloseMs = 10_000,
    // S15: per-repo reconcile budget (record count and/or wall time).
    maxReconcileRecords = MAX_RECONCILE_RECORDS,
    maxReconcileMs = MAX_RECONCILE_MS,
  } = {},
) {
  if (!index) throw new Error('createIngestor: index is required')
  if (typeof repoStateProvider !== 'function') {
    throw new Error('createIngestor: repoStateProvider function is required')
  }

  const stats = {
    indexed: 0,
    rejected: 0,
    signatureRejected: 0,
    validationRejected: 0,
    budgetExceeded: 0,
    sweepSkipped: 0,
    mediaPurged: 0,
    lastReconcileAt: null,
  }
  // H3 cursor state: last seen commit seq (resumed on restart), the
  // last time it was flushed to disk, and whether a stale cursor was
  // already dropped once this process (so the fallback cannot loop).
  let lastSeq = loadFirehoseCursor(firehoseCursorPath)
  let lastCursorSaveAt = 0
  let cursorDropped = false

  /** Flush the cursor to disk, throttled unless `force`. Never throws. */
  function maybeSaveCursor(force = false) {
    if (!firehoseCursorPath || lastSeq == null) return
    const now = Date.now()
    if (!force && now - lastCursorSaveAt < firehoseCursorSaveIntervalMs) return
    try {
      saveFirehoseCursor(firehoseCursorPath, lastSeq)
      lastCursorSaveAt = now
    } catch (err) {
      log.warn?.(`[appview] firehose cursor save failed: ${err?.message ?? err}`)
    }
  }
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
    let validationRejected = 0
    const reject = (entry, reason) => {
      signatureRejected++
      stats.rejected++
      stats.signatureRejected++
      log.warn?.(
        `[appview] reconcile ${did}: dropped ${entry.collection}/${entry.rkey}: device signature rejected (${reason})`,
      )
    }
    // Int M1 / S16: the record fails ingest acceptance before any
    // signature is checked — malformed shape, over-cap field, wrong
    // $type, or an rkey that is not the record's own longtableId
    // (the signature binds longtableId, not the repo rkey, so without
    // this assert the same signed record could be indexed under any
    // number of rkeys). Counted separately from signature failures.
    const rejectInvalid = (entry, reason) => {
      validationRejected++
      stats.rejected++
      stats.validationRejected++
      log.warn?.(
        `[appview] reconcile ${did}: dropped ${entry.collection}/${entry.rkey}: invalid record (${reason})`,
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
    let skipSweep = bindings.size === 0 && candidates === 0 && recipeCount > 0
    const seen = new Set()
    let changed = 0
    // S15: the budget clock starts with the per-record loop.
    const reconcileStartedAt = Date.now()
    let processed = 0
    let budgetExceeded = false
    for (const entry of records) {
      if (entry.collection !== RECIPE_COLLECTION) continue
      processed++
      // S15: stop here — do not handle this record or any after it.
      // The sweep below is skipped too (see skipSweep): `seen` is
      // incomplete, so sweeping would delete rows the budget never
      // looked at. The next periodic sweep retries the remainder.
      if (
        processed > maxReconcileRecords ||
        Date.now() - reconcileStartedAt >= maxReconcileMs
      ) {
        budgetExceeded = true
        stats.budgetExceeded++
        log.warn?.(
          `[appview] reconcile ${did}: budget exceeded after ${processed - 1} records (${maxReconcileRecords} records / ${maxReconcileMs} ms) — stopping early, sweep skipped`,
        )
        break
      }
      // Int M1: lexicon shape + field caps, before any crypto.
      const invalidReason = validateRecipeRecord(entry.record)
      if (invalidReason) {
        rejectInvalid(entry, invalidReason)
        continue
      }
      // S16: the repo rkey must be the record's own longtableId — the
      // client publishes rkey === longtableId (publish.ts puts
      // recipe.id in both), and the device signature binds longtableId,
      // not the rkey. Without this assert, one signed record could be
      // indexed under any number of rkeys.
      if (entry.rkey !== entry.record.longtableId) {
        rejectInvalid(entry, 'rkey-longtableId-mismatch')
        continue
      }
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
    // S15: an early stop leaves `seen` incomplete — sweeping would
    // delete rows for records the budget never examined. Skip it the
    // same way the missing-binding case does; the next sweep retries.
    if (budgetExceeded) skipSweep = true
    let deleted = 0
    if (skipSweep) {
      stats.sweepSkipped++
      log.warn?.(
        `[appview] reconcile ${did}: binding missing, sweep skipped — ${index.listUrisByDid(did).length} previously-indexed rows kept until re-verified`,
      )
    } else {
      for (const uri of index.listUrisByDid(did)) {
        if (!seen.has(uri)) {
          // H1: the recipe left the index (unpublished / deleted) — its
          // media must stop being served too, not linger in the cache
          // under a year-long immutable cache-control.
          if (media) {
            try {
              media.purgeImages(did, index.imagesForUri(uri))
            } catch (err) {
              log.warn?.(`[appview] reconcile ${did}: media purge failed for ${uri}: ${err?.message ?? err}`)
            }
          }
          index.deleteByUri(uri)
          deleted++
        }
      }
    }
    stats.lastReconcileAt = new Date().toISOString()
    return { ok: true, did, indexed: changed, deleted, total: seen.size, rejected: signatureRejected + validationRejected, signatureRejected, validationRejected, budgetExceeded, processed, sweepSkipped: skipSweep, bindingReason, bindings: bindings.size }
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
    // H3: every commit carries its sequence number — advance the
    // persisted cursor (throttled flush; the close path forces one).
    if (Number.isFinite(body.seq)) {
      const seq = Math.trunc(body.seq)
      if (lastSeq == null || seq > lastSeq) {
        lastSeq = seq
        maybeSaveCursor()
      }
    }
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
    const url = `${base.replace(/^http/, 'ws')}/xrpc/com.atproto.sync.subscribeRepos`
    // H3: resume from the persisted cursor when one exists.
    return lastSeq == null ? url : `${url}?cursor=${lastSeq}`
  }

  function startFirehose() {
    if (ws || closed) return
    const url = firehoseUrl()
    const cursorUsed = lastSeq != null
    log.info?.(`[appview] subscribing to firehose ${url}`)
    ws = new WebSocket(url, { maxPayload: MAX_FIREHOSE_FRAME_BYTES })
    let openAt = null
    let receivedAny = false
    ws.on('open', () => {
      openAt = Date.now()
    })
    ws.on('message', (data) => {
      receivedAny = true
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
      maybeSaveCursor(true)
      if (!closed) {
        // H3: a cursor'd connection that dies within the stale window
        // having received nothing had its cursor rejected — drop the
        // persisted cursor once and reconnect without it, instead of
        // reconnect-looping on a cursor the PDS will never accept.
        if (
          cursorUsed &&
          !cursorDropped &&
          !receivedAny &&
          openAt !== null &&
          Date.now() - openAt < firehoseCursorStaleCloseMs
        ) {
          cursorDropped = true
          lastSeq = null
          try {
            fs.unlinkSync(firehoseCursorPath)
          } catch {
            /* already gone / never persisted */
          }
          log.warn?.('[appview] firehose cursor rejected (stale) — reconnecting without a cursor')
        }
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
   * sweep: the sweep only revisits DIDs already in the index,
   * while the cursor resumes the live firehose itself.)
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
      // H1: after the sweep, drop cached blobs no indexed recipe
      // references anymore (orphans from pre-gating fetches and from
      // rows swept above whose purge ran per-recipe — this is the
      // backstop for both).
      if (media) {
        try {
          const purged = media.purgeUnreferenced(index)
          if (purged > 0) {
            stats.mediaPurged += purged
            log.info?.(`[appview] reconcile-all: purged ${purged} unreferenced media blob(s)`)
          }
        } catch (err) {
          log.warn?.(`[appview] reconcile-all: media orphan purge failed: ${err?.message ?? err}`)
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
    maybeSaveCursor(true)
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
    /** H3: last seen firehose commit seq (null when no cursor yet). */
    get firehoseSeq() {
      return lastSeq
    },
    get firehoseCursorPath() {
      return firehoseCursorPath
    },
    /** H3: flush the cursor to disk now (tests / shutdown paths). */
    persistFirehoseCursor() {
      maybeSaveCursor(true)
    },
  }
}
