/**
 * Localhost API settings (E9 — third-party extensibility).
 *
 * The API is OFF by default. Its settings — enabled flag, port, and the
 * per-install bearer token — live in localStorage next to the other
 * device-local preferences (hub list, friends, publications). This is
 * additive local state, not recipe storage: no recipe data format
 * changes, so no migration is involved.
 *
 * Security posture (spelled out in docs/localhost-api.md): on Android
 * ANY app on the device can open a loopback connection, so the token +
 * explicit opt-in is the whole access control. The token authorizes
 * full read/write access to the local cookbook — treat it like a
 * password for the cookbook.
 */
import type { KeyValueStore } from '../store/recipes'

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

export function loadLocalApiSettings(
  kv: KeyValueStore = localStorage,
): LocalApiSettings {
  try {
    const raw = kv.getItem(LOCAL_API_SETTINGS_KEY)
    if (!raw) return defaultLocalApiSettings()
    const parsed = JSON.parse(raw) as Partial<LocalApiSettings>
    return {
      enabled: parsed.enabled === true,
      port: validPort(parsed.port) ? parsed.port : LOCAL_API_DEFAULT_PORT,
      token: typeof parsed.token === 'string' ? parsed.token : '',
    }
  } catch {
    return defaultLocalApiSettings()
  }
}

export function saveLocalApiSettings(
  settings: LocalApiSettings,
  kv: KeyValueStore = localStorage,
): void {
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
