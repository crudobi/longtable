/**
 * Blob CID verification (client port of appview/media.mjs).
 *
 * ATProto blob CIDs are CIDv1 strings (multibase base32 `b…` or
 * base58btc `z…`) wrapping: varint(version=1), varint(codec),
 * varint(0x12 = sha2-256), varint(32), then the 32-byte digest. Parsing
 * that by hand is short and keeps this module dependency-free — the same
 * reason the AppView does it. CIDv0 is rejected: its multihash covers a
 * dag-pb wrapper, not the blob bytes, so raw bytes cannot be verified
 * against it — and ATProto blob CIDs are always v1.
 *
 * Two callers (M-N2, M2(int)):
 *   - save-a-copy (discover.ts) verifies PDS-served photo bytes against
 *     the CID in the record before storing them: the device signature
 *     covers only the CID string, so a PDS serving wrong bytes for a
 *     CID would otherwise be stored as the photo.
 *   - publish (publish.ts) verifies the bytes it just uploaded against
 *     the CID the PDS returned for them: a PDS that stores something
 *     else under the returned CID is caught before the record is
 *     signed, instead of publishing an unverifiable recipe.
 *
 * SHA-256 comes from WebCrypto (`crypto.subtle`, present in the app's
 * secure WebView context and in node). When it is unavailable the check
 * fails closed (throws) rather than silently passing: a verification
 * that cannot run is not a verification.
 */

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base32Decode(str: string): Uint8Array | null {
  let bits = 0
  let value = 0
  const out: number[] = []
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

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
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

function base58Decode(str: string): Uint8Array | null {
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

function readVarint(bytes: Uint8Array, off: number): [number, number] | null {
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
export function cidSha256Digest(cid: string): Uint8Array | null {
  if (typeof cid !== 'string' || cid.length < 2) return null
  let bytes: Uint8Array | null = null
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('SHA-256 is unavailable in this runtime — cannot verify blob bytes.')
  }
  const digest = await subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  )
  return new Uint8Array(digest)
}

/**
 * True only when `bytes` hash to exactly the digest `cid` commits to.
 * Throws when SHA-256 is unavailable (fail closed — see the header).
 * A CID that is not a sha2-256 CIDv1 returns false, never throws.
 */
export async function blobMatchesCid(cid: string, bytes: Uint8Array): Promise<boolean> {
  const digest = cidSha256Digest(cid)
  if (!digest) return false
  return sameBytes(digest, await sha256(bytes))
}

/**
 * The CIDv1 (dag-pb codec, sha2-256, base32) for bytes — the shape a PDS
 * returns for an uploaded blob. Used by tests (and any caller that needs
 * to name bytes it holds). The parser is codec-agnostic, so this also
 * round-trips through the AppView's raw-codec test helper.
 */
export async function cidForBytes(bytes: Uint8Array): Promise<string> {
  const digest = await sha256(bytes)
  const raw = new Uint8Array(4 + 32)
  raw.set([0x01, 0x70, 0x12, 0x20], 0)
  raw.set(digest, 4)
  return `b${base32Encode(raw)}`
}
