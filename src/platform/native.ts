/**
 * Adaptations Android (Capacitor). Dans le navigateur (PWA), chaque fonction
 * se replie sur le comportement web existant : un seul code pour les deux.
 *
 * Les plugins natifs sont chargés à la demande : la PWA ne les télécharge jamais.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

/** Plugin natif de l'app (android/…/MonCarnetUiPlugin.java). */
const MonCarnetUi = registerPlugin<{ setTheme(o: { dark: boolean; color: string }): Promise<void> }>('MonCarnetUi')

export const isNative = Capacitor.isNativePlatform()
export const platform = Capacitor.getPlatform() as 'web' | 'android' | 'ios'

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

/** Initialisation native : bouton Retour, service worker, barres système. */
export async function initNative(): Promise<void> {
  if (!isNative) return
  // L'APK embarque ses fichiers : un service worker y serait inutile et pourrait
  // servir d'anciennes versions après une mise à jour. On retire tout reste éventuel.
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? []
    await Promise.all(regs.map((r) => r.unregister()))
  } catch {
    /* pas de service worker */
  }
  const { App } = await import('@capacitor/app')
  // Bouton Retour Android : on passe par l'historique pour que les panneaux
  // ouverts se ferment (useOverlayHistory) ; à la racine, l'app passe en arrière-plan.
  await App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) window.history.back()
    else void App.minimizeApp()
  })
}

/** Barres système accordées au thème : même fond que l'app, icônes contrastées. */
export async function setSystemBarsDark(dark: boolean): Promise<void> {
  if (!isNative) return
  try {
    await MonCarnetUi.setTheme({ dark, color: dark ? '#1B1916' : '#F7F2EA' })
  } catch {
    /* sans effet */
  }
}

// ---------------------------------------------------------------------------
// Fichiers : sauvegardes ZIP
// ---------------------------------------------------------------------------

/** Encode un bloc binaire en base64 (par tranches, sans saturer la mémoire). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP))
  return btoa(bin)
}

export interface SavedFile {
  /** Emplacement lisible (« Documents/MonCarnet/… »), si l'écriture publique a réussi. */
  location: string | null
  /** URI du fichier local, utilisable pour le partage. */
  uri: string | null
}

/**
 * Enregistre un fichier.
 * - Web : téléchargement classique.
 * - Android : écriture dans Documents/MonCarnet (visible dans « Mes fichiers »),
 *   et copie dans le cache de l'app pour le partage. Écriture par tranches :
 *   une sauvegarde de plusieurs dizaines de Mo ne passe pas d'un bloc par le pont natif.
 */
export async function saveFile(blob: Blob, name: string): Promise<SavedFile> {
  if (!isNative) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return { location: 'Téléchargements', uri: null }
  }
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const CHUNK = 3 * 1024 * 1024 // multiple de 3 : base64 sans remplissage intermédiaire
  const write = async (directory: (typeof Directory)[keyof typeof Directory], path: string) => {
    let uri = ''
    for (let i = 0; i < Math.max(1, bytes.length); i += CHUNK) {
      const data = bytesToBase64(bytes.subarray(i, i + CHUNK))
      if (i === 0) uri = (await Filesystem.writeFile({ path, data, directory, recursive: true })).uri
      else await Filesystem.appendFile({ path, data, directory })
    }
    return uri
  }
  const cacheUri = await write(Directory.Cache, name)
  let location: string | null = null
  try {
    await write(Directory.Documents, `MonCarnet/${name}`)
    location = `Documents/MonCarnet/${name}`
  } catch {
    // Selon la version d'Android, l'écriture publique peut être refusée : le partage reste possible.
  }
  return { location, uri: cacheUri }
}

/** Ouvre la feuille de partage Android pour un fichier déjà enregistré. */
export async function shareSavedFile(file: SavedFile, title: string): Promise<boolean> {
  if (!isNative || !file.uri) return false
  const { Share } = await import('@capacitor/share')
  try {
    await Share.share({ title, files: [file.uri], dialogTitle: title })
    return true
  } catch {
    return false // partage annulé
  }
}

/** Partage de texte : feuille native sur Android, Web Share sinon. */
export async function nativeShareText(title: string, text: string): Promise<boolean> {
  if (!isNative) return false
  const { Share } = await import('@capacitor/share')
  try {
    await Share.share({ title, text, dialogTitle: title })
  } catch {
    /* partage annulé */
  }
  return true
}

// ---------------------------------------------------------------------------
// Écran allumé (mode cuisine)
// ---------------------------------------------------------------------------

export async function nativeKeepAwake(on: boolean): Promise<boolean> {
  if (!isNative) return false
  try {
    const { KeepAwake } = await import('@capacitor-community/keep-awake')
    await (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep())
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Minuteries : notification programmée, même écran éteint ou app fermée
// ---------------------------------------------------------------------------

/** Identifiant numérique stable (exigé par les notifications Android). */
export function notificationId(timerId: string): number {
  let h = 0
  for (let i = 0; i < timerId.length; i++) h = (Math.imul(31, h) + timerId.charCodeAt(i)) | 0
  return Math.abs(h) % 2_000_000_000 || 1
}

export async function scheduleTimerNotification(timerId: string, label: string, at: number): Promise<void> {
  if (!isNative || at <= Date.now()) return
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    const perm = await LocalNotifications.checkPermissions()
    if (perm.display !== 'granted' && (await LocalNotifications.requestPermissions()).display !== 'granted') return
    const id = notificationId(timerId)
    await LocalNotifications.cancel({ notifications: [{ id }] })
    await LocalNotifications.schedule({
      notifications: [{ id, title: 'Minuterie terminée', body: `${label} : c’est prêt !`, schedule: { at: new Date(at), allowWhileIdle: true } }],
    })
  } catch {
    /* notifications indisponibles : l'alerte dans l'app reste active */
  }
}

export async function cancelTimerNotification(timerId: string): Promise<void> {
  if (!isNative) return
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    await LocalNotifications.cancel({ notifications: [{ id: notificationId(timerId) }] })
  } catch {
    /* rien à annuler */
  }
}

// ---------------------------------------------------------------------------
// Réseau : lecture de pages web sans restriction CORS (import par lien)
// ---------------------------------------------------------------------------

export interface NativeResponse {
  status: number
  contentType: string
  text?: string
  base64?: string
}

/**
 * Requête HTTP native (Android). Équivaut à l'ouverture de la page dans un
 * navigateur : aucune restriction d'accès n'est contournée (connexion, paywall).
 */
export async function nativeGet(url: string, kind: 'text' | 'blob'): Promise<NativeResponse> {
  const { CapacitorHttp } = await import('@capacitor/core')
  const res = await CapacitorHttp.get({
    url,
    headers: { 'User-Agent': 'MonCarnet/1.0 (Android; import de recette a usage personnel)', Accept: kind === 'text' ? 'text/html,application/xhtml+xml' : 'image/*' },
    responseType: kind === 'text' ? 'text' : 'blob',
    connectTimeout: 15_000,
    readTimeout: 20_000,
  })
  const contentType = String(res.headers['Content-Type'] ?? res.headers['content-type'] ?? '')
  return kind === 'text'
    ? { status: res.status, contentType, text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) }
    : { status: res.status, contentType, base64: String(res.data) }
}
