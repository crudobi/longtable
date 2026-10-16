import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Content-Security-Policy (M-D), injected into the built index.html.
 *
 * Why build-only: the Vite dev server injects an inline HMR preamble
 * that script-src 'self' would block, breaking the dev loop outright.
 * The shipped artifact — what WebViews and browsers actually run — is
 * the build, so the policy lives there. Directive rationale:
 *  - script-src 'self': no inline or third-party script execution.
 *    With the (currently sink-free) escaping rendering this is the
 *    defense-in-depth layer: a future stored-XSS bug still can't run.
 *  - connect-src: hubs, PDS and AppView endpoints are user-configured
 *    arbitrary origins, so TLS schemes are open (https:/wss:); plain
 *    http/ws is allowed ONLY for loopback, which is where the dev
 *    rig's endpoints live (http://localhost:3210 etc.).
 *  - img-src: recipe photos are data URLs, blob URLs, or remote https.
 *  - style-src 'unsafe-inline': React style props emit style
 *    ATTRIBUTES (e.g. DiscoverPanel), which CSP governs; stylesheets
 *    themselves are same-origin files.
 *  - object-src 'none', base-uri/form-action 'self': no plugins, no
 *    base hijack, no form exfiltration.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self' https: wss: http://localhost:* ws://localhost:*",
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

function cspMeta(): Plugin {
  return {
    name: 'longtable-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      // String replacement, not a tag descriptor: Vite HTML-escapes
      // descriptor attribute values (every ' became &#39;), which a
      // browser would decode — but a policy nobody can grep verbatim
      // is a policy nobody audits. This writes the exact bytes.
      handler: (html) =>
        html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
        ),
    },
  }
}

export default defineConfig({
  plugins: [
    cspMeta(),
    wasm(),
    react(),
    VitePWA({
      // We register the service worker manually in main.tsx so we can pass
      // updateViaCache: 'all' (lets repeat visits serve everything, including
      // the SW script itself, with zero network requests).
      injectRegister: false,
      registerType: 'autoUpdate',
      manifest: {
        name: 'Longtable',
        short_name: 'Longtable',
        description: 'Local-first recipe box. Your recipes, on your device.',
        theme_color: '#2f5233',
        background_color: '#f7f4ec',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the entire app shell. The 6 MiB per-file limit is
        // load-bearing: the Phase 0 recovery migration chunk (the
        // Automerge WASM, pulled in dynamically by
        // src/store/migrateFromAutomerge.ts) still ships and exceeds
        // Workbox's 2 MiB default. The limit can only come down when
        // that migration retires.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  test: {
    environment: 'node',
  },
})
