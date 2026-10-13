/**
 * JS side of the LocalApi Capacitor plugin (native half:
 * android/app/src/main/java/kitchen/longtable/app/LocalApiPlugin.kt).
 *
 * The native side owns ONLY the socket: it binds 127.0.0.1, parses HTTP,
 * and forwards each request as a 'request' event. JS answers through
 * `respond({ id, status, body })`. No recipe logic lives natively.
 *
 * The plugin exists only inside the Android app. In a browser/PWA there
 * is no plugin; `localApiAvailable()` is the feature detection the
 * settings UI uses to explain that instead of failing silently.
 */
import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from '@capacitor/core'

export interface LocalApiRequestEvent {
  /** Correlation id minted natively; echo it back in `respond`. */
  id: string
  method: string
  /** Path only (no query string). */
  path: string
  /** Raw query string without the leading '?'. */
  query: string
  headers: Record<string, string>
  /** Raw body text ('' when none). */
  body: string
}

export interface LocalApiPlugin {
  /** Start (or restart, if the port changed) the loopback listener. */
  start(options: { port: number }): Promise<{ running: boolean; port: number }>
  stop(): Promise<{ running: boolean }>
  status(): Promise<{ running: boolean; port: number }>
  /** Answer one forwarded request. Body is the full response body. */
  respond(options: { id: string; status: number; body: string }): Promise<void>
  addListener(
    eventName: 'request',
    listenerFunc: (event: LocalApiRequestEvent) => void,
  ): Promise<PluginListenerHandle>
}

export const LocalApiNative = registerPlugin<LocalApiPlugin>('LocalApi')

/** True only where the native plugin actually exists (the Android app). */
export function localApiAvailable(): boolean {
  try {
    return Capacitor.isPluginAvailable('LocalApi')
  } catch {
    return false
  }
}
