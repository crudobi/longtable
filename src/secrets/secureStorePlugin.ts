/**
 * JS side of the SecureStore Capacitor plugin (native half:
 * android/app/src/main/java/kitchen/longtable/app/SecureStorePlugin.kt).
 *
 * The native side owns ONLY encrypted key/value storage (AndroidX
 * EncryptedSharedPreferences over a Keystore MasterKey). It knows
 * nothing about what the keys mean — src/secrets/secretStore.ts
 * decides which keys are secrets and migrates them here.
 *
 * The plugin exists only inside the Android app. In a browser/PWA
 * there is no plugin; `secureStoreAvailable()` is the feature
 * detection the secret store uses to decide between Keystore mode
 * and its localStorage degraded mode.
 */
import {
  Capacitor,
  registerPlugin,
} from '@capacitor/core'

export interface SecureStorePlugin {
  /** True when the encrypted preferences could be opened. */
  isAvailable(): Promise<{ available: boolean }>
  /** Value for `key`, or null when absent. Rejects when unreadable. */
  get(options: { key: string }): Promise<{ value: string | null }>
  set(options: { key: string; value: string }): Promise<void>
  remove(options: { key: string }): Promise<void>
  /** Key names only — never values. Used for migration verification. */
  keys(): Promise<{ keys: string[] }>
}

export const SecureStoreNative =
  registerPlugin<SecureStorePlugin>('SecureStore')

/** True only where the native plugin actually exists (the Android app). */
export function secureStoreAvailable(): boolean {
  try {
    return Capacitor.isPluginAvailable('SecureStore')
  } catch {
    return false
  }
}
