import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
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
        // Precache the entire app shell, including the Automerge WASM blob
        // (3.6 MB — above workbox's 2 MiB default precache limit).
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
