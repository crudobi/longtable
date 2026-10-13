/**
 * media.mjs — public media cache for the hub AppView (Phase 4).
 *
 * Public recipe photos live as blobs on the author's PDS. The hub caches
 * them on first fetch so repeat views are served locally and keep working
 * while a PDS is briefly unreachable. The cache is content-addressed
 * (did + cid) and lives in ONE directory next to the index DB.
 *
 * Trust note: blobs are addressed by CID (a hash of their bytes). The cache
 * stores what the PDS returned for that CID; consumers that verify the CID
 * against the bytes are unaffected by a compromised cache.
 */
import fs from 'node:fs'
import path from 'node:path'

// DIDs and CIDs are path segments — pin them to their character sets so a
// crafted path can never escape the cache directory.
const DID_RE = /^did:[a-z]+:[A-Za-z0-9._:%-]+$/
const CID_RE = /^[A-Za-z0-9]+$/
const MAX_BLOB_BYTES = 32 * 1024 * 1024

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

export function createMediaCache({ dir, pdsUrl, fetchImpl = fetch, log = console } = {}) {
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

  async function fetchAndStore(did, cid) {
    const url = `${pdsUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`
    stats.fetches++
    const res = await fetchImpl(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_BLOB_BYTES) {
      log.warn?.(`[media] blob too large, not caching: ${did}/${cid} (${buf.length} bytes)`)
      return null
    }
    const contentType = res.headers?.get?.('content-type') || 'application/octet-stream'
    const p = entryPaths(did, cid)
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
