/**
 * Endpoint-URL scheme validation (Sec L14).
 *
 * User-configured PDS, AppView, and signaling URLs used to accept any
 * scheme, so a JWT (or a pairing handshake) could be sent over plain
 * http:// or ws:// to a non-local host, where anyone on the path reads
 * it. The rule now:
 *
 *   - https:// / wss://: always accepted.
 *   - http:// / ws://: accepted ONLY for loopback hosts — localhost,
 *     127.0.0.1, ::1, and 10.0.2.2 (the Android emulator's alias for the
 *     host loopback, where the dev PDS/AppView/signaling run). The
 *     built-in default hub uses exactly these.
 *   - anything else (other schemes, unparseable URLs, credentials
 *     embedded in the URL): refused.
 *
 * Enforcement is at the points where a URL enters the app or is first
 * used: addHub/updateHub (hub registry writes), the AtprotoClient
 * constructor (every XRPC call carries a JWT), saveAppViewUrl, and the
 * discover/binding fetch paths. A hub registry saved before this rule
 * keeps loading as-is (loadRegistry does not re-validate — dropping a
 * saved hub would strand the user), but its URLs fail closed the first
 * time they are used, with a plain-language error, so no token ever
 * goes out over plaintext to a remote host.
 *
 * TURN/STUN URLs (turn:/turns:/stun:/stuns:) are NOT validated here:
 * they are a different scheme family with no JWTs, and turn: is
 * plaintext by design (turns: is the encrypted form). Pairing-invite
 * signaling URLs are peer-supplied, not user-configured, and are
 * covered by the pairing trust model instead.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '10.0.2.2'])

/** Hosts whose plaintext http/ws endpoints are loopback-only. */
export function isLoopbackHost(hostname: string): boolean {
  // WHATWG URL keeps the IPv6 brackets in .hostname ('[::1]').
  const bare = hostname.replace(/^\[|\]$/g, '')
  return LOOPBACK_HOSTS.has(bare.toLowerCase())
}

/**
 * Whether `url` is safe to send credentials over: an encrypted scheme,
 * or a plaintext scheme to a loopback host. False for anything
 * unparseable, credential-bearing, or plaintext to a remote host.
 * Never throws; the assert* variants below throw with UI copy.
 */
export function isSafeEndpointUrl(url: string, scheme: 'http' | 'ws'): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '') return false
  const encrypted = scheme === 'http' ? 'https:' : 'wss:'
  const plain = scheme === 'http' ? 'http:' : 'ws:'
  if (parsed.protocol === encrypted) return true
  if (parsed.protocol === plain) return isLoopbackHost(parsed.hostname)
  return false
}

/** Plain-language refusal for an unsafe endpoint URL (no URL credentials in it). */
export function unsafeEndpointMessage(url: string, label: string, scheme: 'http' | 'ws'): string {
  let detail = 'it could not be read as a URL'
  try {
    const parsed = new URL(url)
    if (parsed.username !== '' || parsed.password !== '') {
      detail = 'it has a username or password in it — put credentials in the sign-in fields, not the URL'
    } else if (parsed.protocol === (scheme === 'http' ? 'http:' : 'ws:')) {
      detail = `it uses plain ${parsed.protocol.slice(0, -1)} to ${parsed.hostname}, so your sign-in token would travel unencrypted`
    } else {
      detail = `it uses the ${parsed.protocol} scheme`
    }
  } catch {
    /* unparseable — keep the generic detail */
  }
  const secure = scheme === 'http' ? 'https://' : 'wss://'
  return (
    `${label} must use ${secure} — ${detail}. ` +
    `Plain ${scheme === 'http' ? 'http://' : 'ws://'} is only allowed for this device itself (localhost).`
  )
}

/** Throw (plain-language Error) unless `url` is a safe http(s) endpoint URL. */
export function assertSafeHttpUrl(url: string, label: string): void {
  if (!isSafeEndpointUrl(url, 'http')) {
    throw new Error(unsafeEndpointMessage(url, label, 'http'))
  }
}

/** Throw (plain-language Error) unless `url` is a safe ws(s) endpoint URL. */
export function assertSafeWsUrl(url: string, label: string): void {
  if (!isSafeEndpointUrl(url, 'ws')) {
    throw new Error(unsafeEndpointMessage(url, label, 'ws'))
  }
}
