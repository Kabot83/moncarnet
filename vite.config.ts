import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// `vite build --mode android` : variante pour l'APK Capacitor, sans service worker
// (l'APK embarque déjà tous ses fichiers ; un service worker y créerait des conflits de cache).
export default defineConfig(({ mode }) => ({
  // Chemins relatifs : l'app fonctionne à la racine d'un domaine, dans un sous-dossier
  // (GitHub Pages) et dans une coquille Capacitor.
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      disable: mode === 'android',
      registerType: 'prompt',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        id: './',
        name: 'Mon Carnet — recettes personnelles',
        short_name: 'Mon Carnet',
        description: 'Mon livre de recettes personnel, hors ligne, avec un assistant culinaire.',
        lang: 'fr',
        dir: 'ltr',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#F7F2EA',
        theme_color: '#F7F2EA',
        categories: ['food', 'lifestyle'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Nouvelle recette', url: './#/recettes/nouvelle', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Mon Chef IA', url: './#/chef', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Liste de courses', url: './#/courses', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
        ],
        // Partager un lien depuis Chrome Android → « Mon Carnet » ouvre l'import par URL.
        share_target: {
          action: './',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
  },
}))
