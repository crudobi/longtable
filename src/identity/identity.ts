/**
 * Device identity — Phase 2.
 *
 * Each device generates ONE Ed25519 keypair (libsodium) on first launch.
 * The public key becomes a `did:key` DID — fully offline, no registry, no
 * account. The same keypair doubles as the encryption identity: libsodium's
 * Ed25519→Curve25519 conversion derives the X25519 keys used for sealed-box
 * key wrapping, so a friend only ever needs your DID to encrypt to you.
 *
 * The secret key lives in localStorage (app-private storage on Android,
 * same trust level as the rest of the app's local data). Future hardening:
 * Android Keystore via a Capacitor plugin — the DID and all wire formats
 * stay identical, only the key's home changes.
 *
 * Structured for Phase 3+: a did:plc / ATProto binding can be layered on
 * later by publishing this same public key in a `kitchen.longtable.pubkey`
 * record — the DID below remains the local root identity and friends-only
 * crypto never depends on any server.
 */
import sodium from 'libsodium-wrappers'
import { base58btcDecode, base58btcEncode, base64ToU8, u8ToBase64 } from './codec'

/** Minimal key/value store (localStorage in the app, in-memory in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const SECRET_KEY = 'longtable:identity-secret'
/** multicodec varint for ed25519-pub (0xed) — the did:key prefix bytes. */
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01])
const DID_PREFIX = 'did:key:z'

let readyPromise: Promise<void> | null = null

/** Await libsodium's async (WASM) initialization. Idempotent. */
export function cryptoReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = sodium.ready.then(() => undefined)
  }
  return readyPromise
}

export interface Identity {
  /** did:key DID derived from the Ed25519 public key. */
  did: string
  /** Ed25519 public key (32 bytes). */
  publicKey: Uint8Array
  /** Ed25519 secret key (64 bytes, libsodium format). */
  secretKey: Uint8Array
  /** Curve25519 public key converted from the Ed25519 key (32 bytes). */
  encPublicKey: Uint8Array
  /** Curve25519 secret key converted from the Ed25519 key (32 bytes). */
  encSecretKey: Uint8Array
}

async function identityFromEdSecret(secretKey: Uint8Array): Promise<Identity> {
  await cryptoReady()
  // libsodium's Ed25519 secret key is seed(32) || publicKey(32); the JS
  // wrappers don't expose crypto_sign_ed25519_sk_to_pk, so slice it off.
  const publicKey = secretKey.slice(sodium.crypto_sign_SEEDBYTES)
  return {
    did: didFromPublicKey(publicKey),
    publicKey,
    secretKey,
    encPublicKey: sodium.crypto_sign_ed25519_pk_to_curve25519(publicKey),
    encSecretKey: sodium.crypto_sign_ed25519_sk_to_curve25519(secretKey),
  }
}

/** Generate a fresh identity (new random Ed25519 keypair). */
export async function generateIdentity(): Promise<Identity> {
  await cryptoReady()
  const kp = sodium.crypto_sign_keypair()
  return identityFromEdSecret(kp.privateKey)
}

/**
 * Load this device's identity, generating and persisting one on first run.
 * The secret is stored base64-encoded under SECRET_KEY in `kv`.
 */
export async function getOrCreateIdentity(
  kv: KeyValueStore = localStorage,
): Promise<Identity> {
  await cryptoReady()
  const raw = kv.getItem(SECRET_KEY)
  if (raw) {
    try {
      const secretKey = base64ToU8(raw)
      if (secretKey.length === sodium.crypto_sign_SECRETKEYBYTES) {
        return identityFromEdSecret(secretKey)
      }
    } catch {
      /* corrupted entry — fall through and regenerate */
    }
  }
  const identity = await generateIdentity()
  kv.setItem(SECRET_KEY, u8ToBase64(identity.secretKey))
  return identity
}

/** Test hook: build an identity deterministically from a 32-byte seed. */
export async function identityFromSeed(seed: Uint8Array): Promise<Identity> {
  await cryptoReady()
  const kp = sodium.crypto_sign_seed_keypair(seed)
  return identityFromEdSecret(kp.privateKey)
}

/** Encode an Ed25519 public key as a did:key DID. */
export function didFromPublicKey(publicKey: Uint8Array): string {
  const payload = new Uint8Array(ED25519_MULTICODEC.length + publicKey.length)
  payload.set(ED25519_MULTICODEC, 0)
  payload.set(publicKey, ED25519_MULTICODEC.length)
  return DID_PREFIX + base58btcEncode(payload)
}

/** Decode a did:key DID back to its Ed25519 public key. Throws if invalid. */
export function publicKeyFromDid(did: string): Uint8Array {
  if (!did.startsWith(DID_PREFIX)) {
    throw new Error(`not a did:key DID: ${did}`)
  }
  const payload = base58btcDecode(did.slice(DID_PREFIX.length))
  if (
    payload.length !== ED25519_MULTICODEC.length + 32 ||
    payload[0] !== ED25519_MULTICODEC[0] ||
    payload[1] !== ED25519_MULTICODEC[1]
  ) {
    throw new Error(`unsupported did:key payload: ${did}`)
  }
  return payload.slice(ED25519_MULTICODEC.length)
}

/** The Curve25519 (encryption) public key for any identity DID. */
export async function encPublicKeyForDid(did: string): Promise<Uint8Array> {
  await cryptoReady()
  return sodium.crypto_sign_ed25519_pk_to_curve25519(publicKeyFromDid(did))
}

/** Detached Ed25519 signature over `message` by `identity`. */
export async function signDetached(
  identity: Identity,
  message: Uint8Array,
): Promise<Uint8Array> {
  await cryptoReady()
  return sodium.crypto_sign_detached(message, identity.secretKey)
}

/** Verify a detached Ed25519 signature against the signer's DID. */
export async function verifyDetached(
  did: string,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  await cryptoReady()
  try {
    return sodium.crypto_sign_verify_detached(
      signature,
      message,
      publicKeyFromDid(did),
    )
  } catch {
    return false
  }
}
