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
} = {}) {
  if (!dir) throw new Error('media cache requires a directory')
  const stats = { hits: 0, misses: 0, fetches: 0, errors: 0 }
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

  /** Evict oldest entries until `incoming` more bytes fit the total bound. */
  function evictToFit(incoming) {
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
    const res = await fetchImpl(url)
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
   * Resolve a blob: cache hit → stored bytes; miss → fetch from the PDS,
   * store, return. Returns null when the PDS has no such blob (or errors).
   */
  async function get(did, cid) {
    if (!isCacheableMediaId(did, cid)) return null
    const cached = readCached(did, cid)
    if (cached) {
      stats.hits++
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

  return { get, stats, dir }
}
