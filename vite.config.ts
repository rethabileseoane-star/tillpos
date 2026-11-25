import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * HTTPS on the LAN, when certs/ exists and the environment asks for it.
 *
 * `npm run cert` generates a self-signed pair. The phone needs this before the
 * camera will open, because getUserMedia requires a secure context and a plain
 * http://192.168.x.x origin is not one.
 *
 * Off by default so `npm run dev` on a desktop opens at plain http://localhost
 * with no certificate warning to click through. localhost is already a secure
 * context, so TLS buys nothing there. Set TILL_HTTPS=1 to turn it on.
 */
function lanHttps() {
  if (process.env.TILL_HTTPS !== '1') return undefined
  const key = resolve('certs/key.pem')
  const cert = resolve('certs/cert.pem')
  if (!existsSync(key) || !existsSync(cert)) {
    console.warn('[till] TILL_HTTPS=1 but certs/ is missing. Run: npm run cert')
    return undefined
  }
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

/**
 * A short fingerprint of this build, shown in Settings.
 *
 * Cloudflare Pages sets CF_PAGES_COMMIT_SHA and Netlify sets COMMIT_REF, so the
 * shopkeeper can look at the phone and tell instantly whether it is running the
 * latest push. A local build falls back to the date.
 */
const buildId =
  (process.env.CF_PAGES_COMMIT_SHA ?? process.env.COMMIT_REF)?.slice(0, 7) ??
  new Date().toISOString().slice(0, 10)

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: true,
    port: 5173,
    https: lanHttps(),
    // Design artifacts are written by the screenshot tooling while the server
    // runs. Watching them adds no value and can crash the watcher on Windows
    // when a file is still locked.
    watch: { ignored: ['**/design/**', '**/dist/**', '**/lab/backgrounds/assets/**'] },
  },
  preview: {
    host: true,
    port: 4173,
    https: lanHttps(),
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          xlsx: ['xlsx'],
          scan: ['zxing-wasm'],
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      workbox: {
        // Everything is precached so the app boots with no network at all.
        // wasm must be included or the Safari/Firefox barcode decoder will try
        // to fetch it at runtime and fail with the radio off.
        // The screen backdrops live in public/backgrounds as JPEGs. Without
        // jpg in the glob the service worker precaches the whole app except
        // the pictures, so an installed till loses every background offline.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,wasm,jpg,jpeg,webp}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/],
      },
      manifest: {
        name: 'Till',
        short_name: 'Till',
        description: 'Offline barcode point-of-sale and cash reconciliation',
        // Match the light ice shell in index.html. A dark manifest colour
        // makes the standalone splash flash navy before the app paints.
        theme_color: '#f7fcff',
        background_color: '#f7fcff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        categories: ['business', 'finance'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-monochrome.png', sizes: '512x512', type: 'image/png', purpose: 'monochrome' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
})