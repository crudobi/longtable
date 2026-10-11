import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Manual service-worker registration (vite-plugin-pwa injectRegister is off).
// updateViaCache: 'all' lets the browser satisfy the SW's own update check
// from its HTTP cache, so a repeat visit needs zero network requests.
//
// NOTE: do NOT gate this on window 'load'. The Automerge WASM initializes via
// top-level await in this module graph, which can take longer than the rest
// of the document load — by the time the module body runs, readyState is
// already 'complete' and a load listener would never fire (measured).
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
