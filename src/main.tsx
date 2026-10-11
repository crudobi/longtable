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
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'all' })
      .catch(() => {
        /* offline-first: registration failure is non-fatal */
      })
  })
}
