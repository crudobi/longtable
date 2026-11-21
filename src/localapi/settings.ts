/**
 * Localhost API settings (E9 — third-party extensibility).
 *
 * The API is OFF by default. Its settings — enabled flag, port, and the
 * per-install bearer token — live in the Android Keystore
 * (src/secrets/secretStore.ts) on native, in localStorage on web where no
 * Keystore exists. The token is a crown-jewel secret; the flag and port
 * ride along as one stored value. This is additive local state, not
 * recipe storage: no recipe data format changes, so no migration is
 * involved.
 *
 * Security posture (spelled out in docs/localhost-api.md): on Android
 * ANY app on the device can open a loopback connection, so the token +
 * explicit opt-in is the whole access control. The token authorizes
 * full read/write access to the local cookbook — treat it like a
 * password for the cookbook.
 */
import type { KeyValueStore } from '../store/recipes'
import { secretKv } from '../secrets/secretStore'
import {
  assertStoreWritable,
  noteCorruptStore,
  readStoredJson,
} from '../store/corrupt'

export const LOCAL_API_SETTINGS_KEY = 'longtable:localapi'
export const LOCAL_API_DEFAULT_PORT = 17337
/** Wire version of the API; also the major in the /v1/ path prefix. */
export const LOCAL_API_VERSION = '1'

export interface LocalApiSettings {
  enabled: boolean
  port: number
  /** Bearer token (64 hex chars); empty until the API is first enabled. */
  token: string
}

export function defaultLocalApiSettings(): LocalApiSettings {
  return { enabled: false, port: LOCAL_API_DEFAULT_PORT, token: '' }
}

function validPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1024 && n <= 65535
}

/**
 * Load the localhost API settings (H9). Absent reads as the defaults;
 * corrupt JSON — or a top-level value that is not an object — is
 * quarantined (bytes preserved, see src/store/corrupt.ts) and reads
 * as the defaults. Individual fields keep the old per-field fallback
 * (a wrong-typed field falls back to its default, never the whole
 * settings object).
 */
export function loadLocalApiSettings(
  kv: KeyValueStore = secretKv,
): LocalApiSettings {
  const read = readStoredJson(kv, LOCAL_API_SETTINGS_KEY)
  if (read.status === 'absent') return defaultLocalApiSettings()
  if (read.status === 'corrupt') return defaultLocalApiSettings()
  if (typeof read.value !== 'object' || read.value === null || Array.isArray(read.value)) {
    noteCorruptStore(kv, LOCAL_API_SETTINGS_KEY, read.raw, 'not a JSON object')
    return defaultLocalApiSettings()
  }
  const parsed = read.value as Partial<LocalApiSettings>
  return {
    enabled: parsed.enabled === true,
    port: validPort(parsed.port) ? parsed.port : LOCAL_API_DEFAULT_PORT,
    token: typeof parsed.token === 'string' ? parsed.token : '',
  }
}

/**
 * Persist the settings. Refuses (throws CorruptStoreError) when the
 * stored settings are corrupt: saving the defaults over them would
 * destroy the API token. The settings modal loads at mount, so the
 * corruption record exists before any save is attempted. Backup
 * restore does not cover API settings (they are re-enterable) — a
 * corrupt settings value heals by discarding the damaged copy from
 * the app's corruption banner.
 */
export function saveLocalApiSettings(
  settings: LocalApiSettings,
  kv: KeyValueStore = secretKv,
): void {
  assertStoreWritable(LOCAL_API_SETTINGS_KEY)
  kv.setItem(LOCAL_API_SETTINGS_KEY, JSON.stringify(settings))
}

/** 32 random bytes as hex (64 chars). */
export function generateLocalApiToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Return settings with a token guaranteed present: the token is minted
 * the first time the API is enabled, and only then — a never-enabled
 * install has no token at all.
 */
export function ensureLocalApiToken(
  settings: LocalApiSettings,
): LocalApiSettings {
  return settings.token
    ? settings
    : { ...settings, token: generateLocalApiToken() }
}
