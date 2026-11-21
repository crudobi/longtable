import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { initSecrets } from './secrets/secretStore'

// Wave 3 (Keystore): hydrate the secrets mirror BEFORE first render.
// The secret store is async (Keystore) behind a sync in-memory mirror,
// so any startup reader that runs before initSecrets resolves sees an
// empty store — the localStorage fallback only covers UNMIGRATED legacy
// values, not values already moved to the Keystore. That bit proof-p2p:
// rejoinShares() runs outside App's init-effect IIFE, concurrently with
// initSecrets(), and on a relaunched app it read an empty mirror and
// rejoined zero share rooms, so the peers never converged. Hydrating
// here closes the hole for every startup reader at once (render
// initializers, rejoinShares, the localhost-API effect); App's own
// initSecrets() call later is memoized and returns this same report.
// A rejected init still renders (degraded mode) and the init effect
// retries the memoized call. (A hung Keystore call would still delay
// first paint — same exposure as the init effect's await today; the
// plugin calls are local IPC and resolve in milliseconds in practice.)
void initSecrets()
  .catch((e) => {
    console.warn('[longtable] secret init failed before render', e)
  })
  .then(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
  })

// Manual service-worker registration (vite-plugin-pwa injectRegister is off).
// updateViaCache: 'all' lets the browser satisfy the SW's own update check
// from its HTTP cache, so a repeat visit needs zero network requests.
//
// NOTE: do NOT gate this on window 'load' alone. This module graph can
// finish evaluating after the document's load event — by the time the
// module body runs, readyState may already be 'complete' and a load
// listener registered then would never fire (measured).
if ('serviceWorker' in navigator) {
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'all' }).catch((err) => {
      // Offline-first: registration failure is non-fatal, but loud — a
      // missing service worker silently breaks the zero-network guarantee.
      console.warn('[longtable] service worker registration failed:', err)
    })
  }
  if (document.readyState === 'complete') {
    register()
  } else {
    window.addEventListener('load', register)
  }
}
