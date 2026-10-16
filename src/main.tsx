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
