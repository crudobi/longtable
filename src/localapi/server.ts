/**
 * Localhost API server lifecycle (JS side).
 *
 * The native plugin owns the socket; this module owns the behavior. It
 * registers the request listener exactly once, dispatches every
 * forwarded request through the router against the CURRENT settings —
 * so token changes apply to the very next request without a restart —
 * and starts/stops the native listener to match the settings toggle.
 *
 * The host (what the router executes against) is registered by App once
 * the store and identity are up: `setLocalApiHost(createLocalApiHost({
 * ...UI flows... }))`. Requests that arrive before that get a plain 503
 * from the router.
 *
 * Lifecycle honesty: the server exists only while the app process is
 * alive (there is deliberately no foreground service in this scope), and
 * answers are computed by the app's JS — a fully backgrounded/suspended
 * WebView can delay them. docs/localhost-api.md says the same to users.
 */
import type { PluginListenerHandle } from '@capacitor/core'
import {
  LocalApiNative,
  localApiAvailable,
  type LocalApiRequestEvent,
} from './plugin'
import { handleApiRequest, type ApiRequest } from './router'
import { loadLocalApiSettings } from './settings'
import type { LocalApiHost } from './host'

let host: LocalApiHost | null = null
let listener: PluginListenerHandle | null = null
/** Port the native socket is currently bound to (null = not running). */
let nativePort: number | null = null

export function setLocalApiHost(h: LocalApiHost): void {
  host = h
}

async function ensureListener(): Promise<void> {
  if (listener) return
  listener = await LocalApiNative.addListener('request', (event) => {
    void answer(event)
  })
}

async function answer(event: LocalApiRequestEvent): Promise<void> {
  let status = 500
  let payload: unknown = {
    error: 'Something went wrong on the device while handling that request.',
  }
  try {
    const req: ApiRequest = {
      method: event.method,
      path: event.path,
      query: event.query ?? '',
      headers: event.headers ?? {},
      body: event.body ?? '',
    }
    const res = await handleApiRequest(req, host, loadLocalApiSettings())
    status = res.status
    payload = res.body
  } catch (e) {
    console.warn('[longtable] localhost API dispatch failed', e)
  }
  try {
    await LocalApiNative.respond({
      id: event.id,
      status,
      body: JSON.stringify(payload),
    })
  } catch (e) {
    console.warn('[longtable] localhost API respond failed', e)
  }
}

/**
 * Make the native socket match the settings: enabled → listening on
 * the configured port; disabled → stopped. Idempotent — safe at app
 * startup and after every settings change. A no-op where the plugin
 * doesn't exist (browser/PWA).
 */
export async function syncLocalApiServer(): Promise<{
  running: boolean
  port: number
}> {
  if (!localApiAvailable()) return { running: false, port: 0 }
  const settings = loadLocalApiSettings()
  if (!settings.enabled) {
    if (nativePort !== null) {
      await LocalApiNative.stop().catch(() => undefined)
      nativePort = null
    }
    return { running: false, port: settings.port }
  }
  await ensureListener()
  if (nativePort !== settings.port) {
    const res = await LocalApiNative.start({ port: settings.port })
    nativePort = res.port
  }
  return { running: true, port: nativePort }
}

/** Ask the native side what's actually bound (ground truth for the UI). */
export async function localApiServerStatus(): Promise<{
  running: boolean
  port: number
}> {
  if (!localApiAvailable()) return { running: false, port: 0 }
  try {
    const s = await LocalApiNative.status()
    nativePort = s.running ? s.port : null
    return s
  } catch {
    return { running: false, port: 0 }
  }
}
