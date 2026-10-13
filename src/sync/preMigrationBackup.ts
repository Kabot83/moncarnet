/**
 * Sauvegarde préalable à la première synchronisation, VÉRIFIÉE : l'archive est relue entièrement
 * et doit contenir chaque recette et chaque photo du téléphone. Sur Android, elle est enregistrée
 * dans les fichiers privés de l'application (hors IndexedDB) et la copie de sécurité automatique
 * est renouvelée. Si quoi que ce soit échoue, la migration n'a pas lieu.
 */
import { db } from '@/db/db'
import { isNative } from '@/platform/native'
import { exportBackup, readBackup } from '@/services/backup'
import { refreshSnapshot, securityDir, writeBlob } from '@/services/integrity'

export interface PreMigrationBackup {
  at: number
  recipes: number
  photos: number
  bytes: number
  /** Fichier dans l'espace privé de l'application (Android). */
  file: string | null
}

export async function preMigrationBackup(): Promise<PreMigrationBackup> {
  const [recipes, photos] = await Promise.all([db.recipes.count(), db.photos.count()])
  const blob = await exportBackup(undefined, { record: false })
  const parsed = await readBackup(blob)
  const bad = Object.values(parsed.invalid).reduce((a, b) => a + b, 0)
  if (parsed.recipes.length !== recipes || parsed.photos.length !== photos || bad > 0) {
    throw new Error(`Sauvegarde incomplète (${parsed.recipes.length}/${recipes} recettes, ${parsed.photos.length}/${photos} photos) : migration annulée.`)
  }
  let file: string | null = null
  if (isNative) {
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    file = `${securityDir()}/avant-synchronisation-${stamp}.zip`
    await writeBlob(file, blob)
    await refreshSnapshot(true)
  }
  return { at: Date.now(), recipes, photos, bytes: blob.size, file }
}
