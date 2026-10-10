/**
 * Partages Android reçus par l'APK (ShareReceiverPlugin.java).
 *
 * Protocole sans perte : le natif garde chaque partage dans une file persistante ; ici, on le
 * lit, on l'enregistre dans la base, et seulement ensuite on le retire de la file (ack).
 * La file est relue au démarrage, à chaque nouveau partage et au retour dans l'application.
 */
import { registerPlugin } from '@capacitor/core'
import { type IncomingShare, type ShareOutcome, processShare } from '@/social/share'
import { isNative } from './native'

interface PendingShare extends IncomingShare {
  id: string
  receivedAt: number
}

interface ShareReceiverPlugin {
  getPending(): Promise<{ items: PendingShare[] }>
  ack(o: { ids: string[] }): Promise<void>
  moveToBack(): Promise<void>
  openExternal(o: { url: string }): Promise<void>
  addListener(event: 'shareReceived', cb: () => void): Promise<{ remove: () => Promise<void> }>
}

const MonCarnetShare = registerPlugin<ShareReceiverPlugin>('MonCarnetShare')

let started = false

export function startShareReceiver(onOutcome: (o: ShareOutcome) => void): void {
  if (!isNative || started) return
  started = true
  let busy = false
  let again = false
  const drain = async () => {
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      do {
        again = false
        const { items } = await MonCarnetShare.getPending()
        for (const item of items) {
          let outcome: ShareOutcome
          try {
            outcome = await processShare(item)
          } catch {
            continue // non confirmé : sera retraité au prochain passage
          }
          await MonCarnetShare.ack({ ids: [item.id] })
          onOutcome(outcome)
        }
      } while (again)
    } catch {
      /* pont natif indisponible : nouvel essai au prochain événement */
    } finally {
      busy = false
    }
  }
  void MonCarnetShare.addListener('shareReceived', () => void drain())
  void import('@capacitor/app').then(({ App }) => App.addListener('resume', () => void drain()))
  void drain()
}

/** Revient à l'application d'où vient le partage (TikTok, Instagram…). */
export async function returnToSourceApp(): Promise<boolean> {
  if (!isNative) return false
  try {
    await MonCarnetShare.moveToBack()
    return true
  } catch {
    return false
  }
}

/** Ouvre la publication dans l'application TikTok / Instagram (APK) ou un nouvel onglet (PWA). */
export async function openExternal(url: string): Promise<void> {
  if (isNative) {
    try {
      await MonCarnetShare.openExternal({ url })
      return
    } catch {
      /* repli ci-dessous */
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
