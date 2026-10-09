import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Application Android Mon Carnet (Capacitor).
 * Le même build web sert la PWA (GitHub Pages) et l'APK : `npm run build:android`
 * produit une variante sans service worker, inutile et source de conflits dans l'APK.
 */
const config: CapacitorConfig = {
  appId: 'fr.kabot83.moncarnet',
  appName: 'Mon Carnet',
  webDir: 'dist',
  android: {
    // Origine fixe https://localhost : IndexedDB (donc le carnet) est lié à cette origine
    // et doit rester identique d'une version à l'autre pour ne perdre aucune donnée.
    // Ne pas modifier hostname / androidScheme une fois l'application installée.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
  plugins: {
    SystemBars: { insetsHandling: 'css', initialViewportFitValueHint: 'cover' },
    LocalNotifications: { smallIcon: 'ic_stat_moncarnet', iconColor: '#B85C38' },
  },
}

export default config
