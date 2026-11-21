/**
 * Device identity — Phase 2.
 *
 * Each device generates ONE Ed25519 keypair (libsodium) on first launch.
 * The public key becomes a `did:key` DID — fully offline, no registry, no
 * account. The same keypair doubles as the encryption identity: libsodium's
 * Ed25519→Curve25519 conversion derives the X25519 keys used for sealed-box
 * key wrapping, so a friend only ever needs your DID to encrypt to you.
 *
 * The secret key lives in the Android Keystore (src/secrets/secretStore.ts)
 * on native, in localStorage on web/PWA where no Keystore exists. The DID
 * and all wire formats stay identical, only the key's home changes.
 *
 * Structured for Phase 3+: a did:plc / ATProto binding can be layered on
 * later by publishing this same public key in a `kitchen.longtable.pubkey`
 * record — the DID below remains the local root identity and friends-only
 * crypto never depends on any server.
 */
import sodium from 'libsodium-wrappers'
import { base58btcDecode, base58btcEncode, base64ToU8, u8ToBase64 } from './codec'
import { flushSecrets, secretKv } from '../secrets/secretStore'
import {
  clearCorruptStore,
  noteCorruptStore,
  type CorruptStoreEntry,
} from '../store/corrupt'

/** Minimal key/value store (localStorage in the app, in-memory in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The stored Ed25519 secret key (base64, 64 bytes). */
export const IDENTITY_SECRET_KEY = 'longtable:identity-secret'
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
 * Thrown when the stored identity secret is present but unreadable
 * (H8). The app must NEVER silently mint a fresh DID in that case:
 * friends address the old DID, sealed envelopes are undecryptable
 * under a new key, and public records fail their binding — so a
 * corrupt secret enters a blocking "identity damaged" state instead,
 * and the only way out is restoring the identity from an encrypted
 * backup. Carries the quarantine key holding the preserved corrupt
 * bytes (a key NAME, never key material).
 */
export class IdentityDamagedError extends Error {
  /** Quarantine key holding the preserved corrupt bytes. */
  readonly quarantineKey: string
  /** Why the stored secret was judged corrupt (no key material). */
  readonly reason: string
  constructor(quarantineKey: string, reason: string) {
    super(
      'This device’s identity key is damaged. No new identity was created — ' +
        'that would orphan your friends and published recipes. ' +
        'Restore from an encrypted backup to recover it.',
    )
    this.name = 'IdentityDamagedError'
    this.quarantineKey = quarantineKey
    this.reason = reason
  }
}

/**
 * Load this device's identity, generating and persisting one on first run.
 * The secret is stored base64-encoded under IDENTITY_SECRET_KEY in `kv`.
 *
 * A stored value that is present but unreadable (not valid base64, or
 * the wrong length) is CORRUPT, not absent: it is quarantined (see
 * src/store/corrupt.ts — the bytes are preserved, never overwritten)
 * and this throws IdentityDamagedError. No fresh identity is minted
 * and the corrupt value is left in place, so a later restore can still
 * replace it — and so a read path (including the localhost API's
 * getIdentityDid) can never rotate the DID by merely asking for it.
 */
export async function getOrCreateIdentity(
  kv: KeyValueStore = secretKv,
): Promise<Identity> {
  await cryptoReady()
  const raw = kv.getItem(IDENTITY_SECRET_KEY)
  if (raw) {
    let secretKey: Uint8Array | null = null
    let reason: string | null = null
    try {
      secretKey = base64ToU8(raw)
      if (secretKey.length !== sodium.crypto_sign_SECRETKEYBYTES) {
        reason =
          `identity secret is ${secretKey.length} bytes, ` +
          `expected ${sodium.crypto_sign_SECRETKEYBYTES}`
        secretKey = null
      }
    } catch {
      reason = 'identity secret is not valid base64'
    }
    if (secretKey) {
      // A good value supersedes any earlier damage report for the key.
      clearCorruptStore(IDENTITY_SECRET_KEY)
      return identityFromEdSecret(secretKey)
    }
    const entry: CorruptStoreEntry = noteCorruptStore(
      kv,
      IDENTITY_SECRET_KEY,
      raw,
      reason as string,
    )
    // Make the quarantine copy durable before reporting the damage:
    // a restore later overwrites the live key, and the quarantine copy
    // is then the only copy of the corrupt bytes.
    await flushSecrets()
    throw new IdentityDamagedError(entry.quarantineKey, reason as string)
  }
  const identity = await generateIdentity()
  kv.setItem(IDENTITY_SECRET_KEY, u8ToBase64(identity.secretKey))
  // First launch mints the device identity: await the Keystore flush so
  // the key is durable before anything else proceeds. (With an explicit
  // test kv this flushes an empty queue - a no-op.)
  await flushSecrets()
  return identity
}

/** Test hook: build an identity deterministically from a 32-byte seed. */
export async function identityFromSeed(seed: Uint8Array): Promise<Identity> {
  await cryptoReady()
  const kp = sodium.crypto_sign_seed_keypair(seed)
  return identityFromEdSecret(kp.privateKey)
}

/**
 * Restore an identity from a backup: validate a base64 Ed25519 secret
 * key (64 bytes, and the DID it derives must match `expectedDid` when
 * given) and store it under the same key getOrCreateIdentity reads.
 * Added for the encrypted backup (Wave 3 C3); the storage itself —
 * key, encoding, location — is unchanged.
 *
 * The default store is secretKv (Keystore on native): a restored
 * identity secret is a crown-jewel secret and must land in the
 * Keystore like every other identity write, never in plaintext
 * localStorage. Callers that pass an explicit kv keep their own
 * routing — and on native that kv must itself be secretKv (the backup
 * restore flow passes it): the next launch's migration is
 * Keystore-authoritative, so a value restored only into localStorage
 * would be discarded in favour of the Keystore copy still holding the
 * damaged bytes. A successful restore clears any identity-damage
 * record: the stored value is good again.
 */
export async function restoreIdentitySecret(
  secretKeyB64: string,
  kv: KeyValueStore = secretKv,
  expectedDid?: string,
): Promise<string> {
  await cryptoReady()
  const secretKey = base64ToU8(secretKeyB64)
  if (secretKey.length !== sodium.crypto_sign_SECRETKEYBYTES) {
    throw new Error('identity secret key has the wrong length')
  }
  const identity = await identityFromEdSecret(secretKey)
  if (expectedDid !== undefined && identity.did !== expectedDid) {
    throw new Error('identity secret key does not match its DID')
  }
  kv.setItem(IDENTITY_SECRET_KEY, u8ToBase64(identity.secretKey))
  clearCorruptStore(IDENTITY_SECRET_KEY)
  return identity.did
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
