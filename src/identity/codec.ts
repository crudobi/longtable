/**
 * Encoding helpers for the identity/friends layer.
 *
 * base64: browser-safe (btoa/atob exist in browsers and Node >= 16).
 * base58btc: the multibase encoding used by did:key — implemented here
 * (the alphabet and big-number conversion are the well-known Bitcoin
 * base58 scheme) and pinned by a fixed test vector in identity.test.ts.
 */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function u8ToBase64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s)
}

export function base64ToU8(b64: string): Uint8Array {
  const s = atob(b64)
  const u8 = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i)
  return u8
}

export function utf8ToU8(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

export function u8ToUtf8(u8: Uint8Array): string {
  return new TextDecoder().decode(u8)
}

export function u8ToHex(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0')
  return s
}

export function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  // Little-endian base-58 digits, classic conversion algorithm.
  const digits: number[] = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  // A zero value is encoded purely by its leading '1's.
  if (digits.every((d) => d === 0)) return '1'.repeat(zeros)
  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]]
  return out
}

export function base58btcDecode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0)
  let zeros = 0
  while (zeros < str.length && str[zeros] === '1') zeros++
  // Leading '1's are pure zero-byte markers; convert only the suffix.
  const bytes: number[] = []
  for (let i = zeros; i < str.length; i++) {
    const value = B58_ALPHABET.indexOf(str[i])
    if (value < 0) throw new Error(`invalid base58 character: ${str[i]}`)
    let carry = value
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const out = new Uint8Array(zeros + bytes.length)
  out.set(bytes.reverse(), zeros)
  return out
}
