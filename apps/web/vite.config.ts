import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// envDir = repo-root .env. Only VITE_* and the domain-restricted browser map key reach client code (B3).
// strictPort: the browser key only allows localhost:5173-5175 (one per parallel stream: npm run dev:web -- --port 5174).
// PWA icons in public/ come from public/icon.svg: npx @vite-pwa/assets-generator --preset minimal-2023 public/icon.svg
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'icon.svg'],
      manifest: {
        name: 'Trippy',
        short_name: 'Trippy',
        description: 'Tell it what the car needs. It finds real places on your route.',
        theme_color: '#E89A0C',
        background_color: '#FBF8F2',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // App shell only. Map tiles, Places and the LLM relay always go to the network (live data, no stale answers).
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,ico}'] },
    }),
  ],
  envDir: fileURLToPath(new URL('../..', import.meta.url)), // absolute: a relative one was lost on Vite's config-change restart
  envPrefix: ['VITE_', 'GOOGLE_MAPS_BROWSER_'],
  server: { port: 5173, strictPort: true },
})
