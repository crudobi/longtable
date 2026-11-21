/**
 * media.mjs — public media cache for the hub AppView (Phase 4).
 *
 * Public recipe photos live as blobs on the author's PDS. The hub caches
 * them on first fetch so repeat views are served locally and keep working
 * while a PDS is briefly unreachable. The cache is content-addressed
 * (did + cid) and lives in ONE directory next to the index DB.
 *
 * Trust note: blobs are addressed by CID (a hash of their bytes). The
 * cache VERIFIES the fetched bytes against the CID's sha2-256 digest
 * before storing anything: a PDS (or a compromised cache upstream) that
 * serves bytes not matching the requested CID gets an error, and the
 * bytes are never stored or served. Nothing enters the cache on faith.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

// DIDs and CIDs are path segments — pin them to their character sets so a
// crafted path can never escape the cache directory.
const DID_RE = /^did:[a-z]+:[A-Za-z0-9._:%-]+$/
const CID_RE = /^[A-Za-z0-9]+$/
/** Per-blob cap (32 MiB), enforced DURING download: the read aborts the
 * moment the cap is crossed instead of buffering the whole body first. */
export const MAX_BLOB_BYTES = 32 * 1024 * 1024
/** Total cache bound (512 MiB): before a new blob is stored, the oldest
 * entries (by mtime) are evicted until the cache fits again. */
export const MAX_CACHE_BYTES = 512 * 1024 * 1024
/** Per-fetch timeout for the PDS blob fetch (30 s, same as verify.mjs's
 * fetch timeout): a hung PDS must abort the fetch, never pin the
 * inflight key forever (S11). The `.finally(() => inflight.delete(key))`
 * cleanup in get() then frees the (did, cid) for a later retry. */
export const MEDIA_FETCH_TIMEOUT_MS = 30_000

/**
 * H2 — Content-Type allowlist for served blobs. The PDS supplies the
 * stored type and a malicious/compromised PDS could claim `text/html`
 * (or another active type) for attacker bytes; served verbatim from
 * the AppView origin that is stored XSS. Only image types browsers
 * render inertly are passed through; everything else is served as
 * `application/octet-stream` (with `Content-Disposition: attachment`
 * at the HTTP layer) so it can never execute in the AppView origin.
 * SVG is deliberately NOT allowlisted: inline <script> / event
 * handlers make it an active type, not an image.
 */
export const MEDIA_CONTENT_TYPE_ALLOWLIST = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
])

/** Map a stored Content-Type through the H2 allowlist. */
export function safeMediaContentType(contentType) {
  const base = String(contentType ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  return MEDIA_CONTENT_TYPE_ALLOWLIST.has(base) ? base : 'application/octet-stream'
}

/**
 * The CID(s) an indexed recipe's `images` array references. Same
 * extraction as device-signature.mjs `imageCid`: `ref.$link` when it
 * is a string, otherwise the bare string ref; anything else is not a
 * CID and is skipped (it can never match a cached blob name).
 */
export function imageCids(images) {
  const out = []
  for (const img of Array.isArray(images) ? images : []) {
    const ref = img?.ref
    const cid = typeof ref?.$link === 'string' ? ref.$link : typeof ref === 'string' ? ref : null
    if (cid && CID_RE.test(cid)) out.push(cid)
  }
  return out
}

// --- CIDv1 / sha2-256 verification ---------------------------------------
// Blob CIDs are CIDv1 strings (multibase base32 'b…' or base58btc 'z…')
// wrapping: varint(version=1), varint(codec), varint(0x12 = sha2-256),
// varint(32), then the 32-byte digest. Parsing that by hand is short and
// keeps this module dependency-free. CIDv0 is rejected: its multihash
// covers a dag-pb wrapper, not the blob bytes, so raw bytes cannot be
// verified against it — and ATProto blob CIDs are always v1.

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base32Decode(str) {
  let bits = 0
  let value = 0
  const out = []
  for (const ch of str) {
    const idx = B32.indexOf(ch)
    if (idx === -1) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

function base58Decode(str) {
  const bytes = [0]
  for (const ch of str) {
    const idx = B58.indexOf(ch)
    if (idx === -1) return null
    let carry = idx
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i] * 58 + carry
      bytes[i] = v & 0xff
      carry = v >>> 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>>= 8
    }
  }
  let zeros = 0
  while (zeros < str.length && str[zeros] === '1') zeros++
  const out = new Uint8Array(zeros + bytes.length)
  out.set(bytes.reverse(), zeros)
  return out
}

function readVarint(bytes, off) {
  let result = 0
  let shift = 0
  let i = off
  while (i < bytes.length) {
    const b = bytes[i++]
    result += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) return [result, i]
    shift += 7
    if (shift > 35) return null
  }
  return null
}

/** The sha2-256 digest a CID promises, or null if it is not a sha2-256 CIDv1. */
export function cidSha256Digest(cid) {
  if (typeof cid !== 'string' || cid.length < 2) return null
  let bytes = null
  if (cid[0] === 'b') bytes = base32Decode(cid.slice(1))
  else if (cid[0] === 'z') bytes = base58Decode(cid.slice(1))
  if (!bytes) return null
  let r = readVarint(bytes, 0)
  if (!r || r[0] !== 1) return null // version must be 1
  r = readVarint(bytes, r[1])
  if (!r) return null // codec: any — the digest check is codec-agnostic
  r = readVarint(bytes, r[1])
  if (!r || r[0] !== 0x12) return null // multihash code must be sha2-256
  r = readVarint(bytes, r[1])
  if (!r || r[0] !== 32) return null
  if (bytes.length !== r[1] + 32) return null
  return bytes.slice(r[1], r[1] + 32)
}

/** True only when `bytes` hash to exactly the digest `cid` commits to. */
export function blobMatchesCid(cid, bytes) {
  const digest = cidSha256Digest(cid)
  if (!digest) return false
  const actual = createHash('sha256').update(bytes).digest()
  return Buffer.from(digest).equals(actual)
}

/** The CIDv1 (raw codec, sha2-256, base32) for bytes — used by tests. */
export function rawCidForBytes(bytes) {
  const digest = createHash('sha256').update(bytes).digest()
  const raw = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest])
  let bits = 0
  let value = 0
  let out = 'b'
  for (const byte of raw) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += B32[(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 0x1f]
  return out
}

/**
 * Read a fetch body enforcing maxBytes DURING the read. Returns a Buffer,
 * or null when the body exceeds the cap (the stream is cancelled, never
 * fully buffered).
 */
export async function readBodyWithCap(res, maxBytes) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > maxBytes ? null : buf
  }
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

export function isCacheableMediaId(did, cid) {
  return (
    typeof did === 'string' &&
    typeof cid === 'string' &&
    DID_RE.test(did) &&
    CID_RE.test(cid) &&
    !did.includes('..') &&
    !cid.includes('..')
  )
}

export function createMediaCache({
  dir,
  pdsUrl,
  fetchImpl = fetch,
  log = console,
  maxBlobBytes = MAX_BLOB_BYTES,
  maxCacheBytes = MAX_CACHE_BYTES,
  fetchTimeoutMs = MEDIA_FETCH_TIMEOUT_MS,
} = {}) {
  if (!dir) throw new Error('media cache requires a directory')
  const stats = { hits: 0, misses: 0, fetches: 0, errors: 0, purged: 0 }
  const inflight = new Map()

  const entryPaths = (did, cid) => {
    const sub = path.join(dir, encodeURIComponent(did))
    return { sub, bytes: path.join(sub, cid), meta: path.join(sub, `${cid}.json`) }
  }

  function readCached(did, cid) {
    const p = entryPaths(did, cid)
    try {
      const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'))
      const bytes = fs.readFileSync(p.bytes)
      // Sec L12: re-verify the CID hash on serve. fetchAndStore
      // verified these bytes once, but the cache dir is on-disk state
      // — a bit flip, a partial write, or a tampered file must never
      // be served as the CID's bytes. On mismatch the corrupt entry
      // is dropped so the next get() refetches (and re-verifies) it.
      if (!blobMatchesCid(cid, bytes)) {
        log.warn?.(`[media] cached blob failed CID re-verification, dropping: ${did}/${cid}`)
        try {
          fs.unlinkSync(p.bytes)
        } catch {
          /* already gone */
        }
        try {
          fs.unlinkSync(p.meta)
        } catch {
          /* already gone */
        }
        return null
      }
      return { bytes, contentType: meta.contentType || 'application/octet-stream' }
    } catch {
      return null
    }
  }

  /** All cache entries on disk + the cache's total size in bytes. */
  function cacheEntries() {
    const entries = []
    let total = 0
    let subs = []
    try {
      subs = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return { entries, total }
    }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue
      const subPath = path.join(dir, sub.name)
      let files = []
      try {
        files = fs.readdirSync(subPath)
      } catch {
        continue
      }
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(subPath, f))
          total += st.size
          if (!f.endsWith('.json') && !f.includes('.tmp-')) {
            entries.push({
              did: (() => {
                try {
                  return decodeURIComponent(sub.name)
                } catch {
                  return sub.name
                }
              })(),
              cid: f,
              bytesPath: path.join(subPath, f),
              metaPath: path.join(subPath, `${f}.json`),
              size: st.size,
              mtimeMs: st.mtimeMs,
            })
          }
        } catch {
          /* raced a delete — skip */
        }
      }
    }
    return { entries, total }
  }

  /**
   * Delete orphaned .tmp files (interrupted writes — tmp+rename means
   * a .tmp on disk is never a valid entry). Int L1: the cache is
   * created once per process start, so a full sweep at creation is
   * the startup sweep — no fetch is in flight yet, so every .tmp is
   * an orphan. Mid-run (evictToFit) only .tmp files older than an
   * hour go: a fresh one may be a concurrent fetchAndStore still
   * writing. Returns the number of files removed.
   */
  function sweepStaleTmp({ all = false } = {}) {
    let removed = 0
    let subs = []
    try {
      subs = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return removed
    }
    const cutoff = Date.now() - 3_600_000
    for (const sub of subs) {
      if (!sub.isDirectory()) continue
      const subPath = path.join(dir, sub.name)
      let files = []
      try {
        files = fs.readdirSync(subPath)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.includes('.tmp-')) continue
        const tmpPath = path.join(subPath, f)
        try {
          if (all || fs.statSync(tmpPath).mtimeMs < cutoff) {
            fs.unlinkSync(tmpPath)
            removed++
          }
        } catch {
          /* raced a delete — skip */
        }
      }
    }
    return removed
  }

  // Int L1: startup sweep — every .tmp left by an interrupted write
  // (or a crashed process) goes on cache creation, before any fetch
  // can be in flight. The .tmp bytes themselves already counted
  // toward the cache total in cacheEntries (they are on-disk files),
  // so orphans could never silently grow the cache past its bound
  // without counting — the sweep just reclaims the space.
  sweepStaleTmp({ all: true })

  /**
   * Evict entries until `incoming` more bytes fit the total bound.
   * Eviction is LRU: entries sort by mtime, and mtime is the last
   * ACCESS (get() refreshes it on every hit), so the entries evicted
   * first are the ones nobody has read in the longest — not the ones
   * fetched longest ago. Orphaned .tmp bytes count toward `total`
   * (cacheEntries sums every file on disk), so they can never push
   * the cache past its bound uncounted.
   */
  function evictToFit(incoming) {
    sweepStaleTmp()
    let { entries, total } = cacheEntries()
    if (total + incoming <= maxCacheBytes) return
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const e of entries) {
      if (total + incoming <= maxCacheBytes) break
      let freed = e.size
      try {
        fs.unlinkSync(e.bytesPath)
      } catch {
        /* already gone */
      }
      try {
        freed += fs.statSync(e.metaPath).size
        fs.unlinkSync(e.metaPath)
      } catch {
        /* no meta — fine */
      }
      total -= freed
    }
  }

  async function fetchAndStore(did, cid) {
    const url = `${pdsUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`
    stats.fetches++
    // S11: abort a hung PDS fetch — a bare fetch with no signal would
    // leave the shared inflight promise pending forever, making that
    // (did, cid) unservable for the process lifetime. The abort rejects
    // here, get()'s .catch counts it, and .finally frees the key.
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(fetchTimeoutMs) })
    if (!res.ok) return null
    const buf = await readBodyWithCap(res, maxBlobBytes)
    if (buf === null) {
      log.warn?.(`[media] blob too large, not caching: ${did}/${cid} (over ${maxBlobBytes} bytes)`)
      return null
    }
    // Fail closed on content-address mismatch: the PDS's bytes must hash
    // to the requested CID, or they are never stored or served.
    if (!blobMatchesCid(cid, buf)) {
      stats.errors++
      log.warn?.(`[media] CID mismatch, not caching: ${did}/${cid}`)
      return null
    }
    const contentType = res.headers?.get?.('content-type') || 'application/octet-stream'
    const p = entryPaths(did, cid)
    // +256: leave room for this entry's meta JSON too, so the on-disk
    // total (blobs + metas) — not just the blob bytes — stays bounded.
    evictToFit(buf.length + 256)
    fs.mkdirSync(p.sub, { recursive: true })
    const tmp = `${p.bytes}.tmp-${process.pid}`
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, p.bytes)
    fs.writeFileSync(
      p.meta,
      JSON.stringify({ contentType, size: buf.length, fetchedAt: new Date().toISOString() }),
    )
    return { bytes: buf, contentType }
  }

  /**
   * H1 — delete one cached blob (bytes + meta). Returns true when an
   * entry was removed. Used by the ingest sweep when a recipe leaves
   * the index (unpublish/delete) so its media stops being served.
   */
  function deleteBlob(did, cid) {
    if (!isCacheableMediaId(did, cid)) return false
    const p = entryPaths(did, cid)
    let removed = false
    for (const f of [p.bytes, p.meta]) {
      try {
        fs.unlinkSync(f)
        removed = true
      } catch {
        /* already gone */
      }
    }
    if (removed) stats.purged++
    return removed
  }

  /**
   * H1 — delete every cached blob a recipe's `images` array references.
   * Returns the number of blobs removed.
   */
  function purgeImages(did, images) {
    let n = 0
    for (const cid of imageCids(images)) {
      if (deleteBlob(did, cid)) n++
    }
    return n
  }

  /**
   * H1 — delete every cached blob no indexed recipe references anymore
   * (orphans: fetched under a recipe that has since left the index, or
   * cached before media gating). `index` is the RecipeIndex (its
   * listImageRefs() enumerates the live references). Returns the number
   * of blobs removed. Called after the periodic reconcile sweep, never
   * per-recipe, so it cannot race a concurrent ingest.
   */
  function purgeUnreferenced(index) {
    const live = new Set()
    for (const { did, cid } of index.listImageRefs()) live.add(`${did}/${cid}`)
    let n = 0
    for (const e of cacheEntries().entries) {
      if (live.has(`${e.did}/${e.cid}`)) continue
      try {
        fs.unlinkSync(e.bytesPath)
      } catch {
        /* already gone */
      }
      try {
        fs.unlinkSync(e.metaPath)
      } catch {
        /* no meta — fine */
      }
      stats.purged++
      n++
    }
    return n
  }

  /**
   * Resolve a blob: cache hit → stored bytes; miss → fetch from the PDS,
   * store, return. Returns null when the PDS has no such blob (or errors).
   */
  async function get(did, cid) {
    if (!isCacheableMediaId(did, cid)) return null
    const cached = readCached(did, cid)
    if (cached) {
      stats.hits++
      // Int L1 / LRU eviction: a hit refreshes the entry's mtime, so
      // evictToFit's oldest-first order evicts least-RECENTLY-used
      // entries, not least-recently-fetched ones. Best-effort: a
      // failed utime must never fail a serve.
      const p = entryPaths(did, cid)
      try {
        const now = new Date()
        fs.utimesSync(p.bytes, now, now)
        fs.utimesSync(p.meta, now, now)
      } catch (err) {
        // A failed refresh must never fail a serve — but it silently
        // degrades LRU to FIFO, so log it instead of swallowing it.
        // (An earlier draft called the non-existent fs.utimeSync
        // here; the silent catch hid it until the LRU test caught
        // the stale mtime. The correct name is fs.utimesSync.)
        log.warn?.(`[media] mtime refresh failed for ${did}/${cid}: ${err?.message ?? err}`)
      }
      return { ...cached, fromCache: true }
    }
    stats.misses++
    const key = `${did}/${cid}`
    if (!inflight.has(key)) {
      inflight.set(
        key,
        fetchAndStore(did, cid)
          .catch((err) => {
            stats.errors++
            log.warn?.(`[media] fetch failed ${key}: ${err?.message ?? err}`)
            return null
          })
          .finally(() => inflight.delete(key)),
      )
    }
    const fresh = await inflight.get(key)
    return fresh ? { ...fresh, fromCache: false } : null
  }

  return { get, delete: deleteBlob, purgeImages, purgeUnreferenced, sweepStaleTmp, stats, dir }
}
