import { defineConfig, devices } from '@playwright/test'

/**
 * Tests de bout en bout sur le BUILD DE PRODUCTION (service worker compris),
 * en format téléphone Android. Utilise le Chrome installé sur la machine.
 * Lancer : npm run build && npm run test:e2e
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Pixel 7'],
    channel: 'chrome',
    baseURL: 'http://localhost:4173',
    locale: 'fr-FR',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
