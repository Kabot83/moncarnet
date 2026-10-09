import { AlertTriangle, Download, FileArchive, Share2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { Segmented } from '@/components/ui/Fields'
import { Page, TopBar } from '@/components/ui/Layout'
import { forgetPhoto } from '@/hooks/usePhotoUrl'
import { formatBytes, formatDate, relativeDays } from '@/lib/format'
import { BackupError, type RestoreMode, type RestorePreview, applyRestore, backupFileName, exportBackup, previewRestore, readBackup } from '@/services/backup'
import { useSettings } from '@/services/settings'
import { type SavedFile, isNative, saveFile, shareSavedFile } from '@/platform/native'

export default function BackupPage() {
  const settings = useSettings()
  const toast = useToast()
  const confirm = useConfirm()
  const fileRef = useRef<HTMLInputElement>(null)
  const [exporting, setExporting] = useState<string | null>(null)
  const [lastFile, setLastFile] = useState<File | null>(null)
  const [saved, setSaved] = useState<SavedFile | null>(null)
  const [reading, setReading] = useState(false)
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const [mode, setMode] = useState<RestoreMode>('merge')
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const doExport = async () => {
    setExporting('Préparation…')
    try {
      const blob = await exportBackup((d, t) => setExporting(`Photos : ${d}/${t}`))
      const file = new File([blob], backupFileName(), { type: 'application/zip' })
      setLastFile(file)
      const where = await saveFile(blob, file.name)
      setSaved(where)
      toast.success(`Sauvegarde créée (${formatBytes(file.size)})${isNative && where.location ? ` dans ${where.location}` : ''}`)
      // Android : on propose aussitôt de l'envoyer ailleurs (Drive, e-mail…).
      if (isNative) await shareSavedFile(where, 'Sauvegarde Mon Carnet')
    } catch {
      toast.error('La sauvegarde a échoué. Vérifiez l’espace disponible.')
    } finally {
      setExporting(null)
    }
  }

  const shareFile = async () => {
    if (!lastFile) return
    if (saved && (await shareSavedFile(saved, 'Sauvegarde Mon Carnet'))) return
    if (navigator.canShare?.({ files: [lastFile] })) {
      try {
        await navigator.share({ files: [lastFile], title: 'Sauvegarde Mon Carnet' })
      } catch {
        /* partage annulé */
      }
    } else toast.info('Le partage de fichiers n’est pas disponible ici : utilisez le fichier téléchargé.')
  }

  const pick = async (f: File | undefined) => {
    if (!f) return
    setError(null)
    setPreview(null)
    setReading(true)
    try {
      setPreview(await previewRestore(await readBackup(f)))
    } catch (e) {
      setError(e instanceof BackupError ? e.message : 'Fichier illisible.')
    } finally {
      setReading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const restore = async () => {
    if (!preview) return
    const ok = await confirm(
      mode === 'replace'
        ? {
            title: 'Remplacer tout mon carnet ?',
            message: `Les ${preview.local.recipes} recettes actuelles de ce téléphone seront effacées et remplacées par les ${preview.backup.recipes.length} recettes de la sauvegarde.`,
            confirmLabel: 'Remplacer',
            danger: true,
            acknowledge: 'Je comprends que mon carnet actuel sera effacé.',
          }
        : {
            title: 'Fusionner avec mon carnet ?',
            message: `${preview.newRecipes} nouvelle(s) recette(s) seront ajoutées. Pour les ${preview.duplicates} recette(s) déjà présentes, la version la plus récente est conservée.`,
            confirmLabel: 'Fusionner',
          },
    )
    if (!ok) return
    setRestoring(true)
    try {
      preview.backup.photos.forEach((p) => forgetPhoto(p.id))
      const r = await applyRestore(preview.backup, mode)
      toast.success(`Restauration terminée : ${r.recipes} recette(s), ${r.photos} photo(s)`)
      setPreview(null)
    } catch {
      toast.error('La restauration a échoué : aucune donnée n’a été modifiée.')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <>
      <TopBar back="/reglages" title="Sauvegarde" />
      <Page className="pt-4">
        <div className="flex gap-3 rounded-[var(--radius-card)] border border-gold/40 bg-[color-mix(in_oklab,var(--c-gold)_12%,transparent)] p-4 text-sm">
          <AlertTriangle size={22} className="shrink-0 text-gold" />
          <div>
            <p className="font-semibold">Vos recettes sont stockées uniquement sur ce téléphone.</p>
            <p className="mt-1 text-muted">
              Elles peuvent être perdues si vous changez de téléphone, désinstallez l’application ou effacez les données du navigateur (Chrome → Paramètres → Confidentialité). Sauvegardez régulièrement et gardez le fichier ailleurs (Drive, ordinateur, clé USB).
            </p>
          </div>
        </div>

        <section className="mt-6 rounded-[var(--radius-card)] bg-paper p-5 shadow-[var(--shadow-card)]">
          <h2 className="font-serif text-xl font-semibold">Sauvegarder mon carnet</h2>
          <p className="mt-1 text-sm text-muted">
            Un fichier ZIP contenant recettes, photos, journal, collections, liste de courses, conversations et préférences. Il ne contient jamais votre clé API ni votre jeton de proxy.
          </p>
          <p className="mt-2 text-sm">{settings.lastBackupAt ? `Dernière sauvegarde : ${formatDate(settings.lastBackupAt)} (${relativeDays(settings.lastBackupAt)})` : 'Aucune sauvegarde pour le moment.'}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button icon={<Download size={18} />} loading={!!exporting} onClick={() => void doExport()}>
              {exporting ?? 'Sauvegarder mon carnet'}
            </Button>
            {lastFile && (
              <Button variant="secondary" icon={<Share2 size={17} />} onClick={() => void shareFile()}>
                Envoyer vers…
              </Button>
            )}
          </div>
        </section>

        <section className="mt-5 rounded-[var(--radius-card)] bg-paper p-5 shadow-[var(--shadow-card)]">
          <h2 className="font-serif text-xl font-semibold">Restaurer mon carnet</h2>
          <p className="mt-1 text-sm text-muted">Le fichier est contrôlé (format, version, intégrité des photos, doublons) et un aperçu est affiché avant toute modification.</p>
          <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          <Button className="mt-4" variant="secondary" icon={<Upload size={18} />} loading={reading} onClick={() => fileRef.current?.click()}>
            Choisir un fichier de sauvegarde
          </Button>
          {error && (
            <p className="mt-3 rounded-2xl bg-danger-soft p-3 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          {preview && (
            <div className="mt-5 space-y-4 animate-fade-up">
              <div className="flex items-start gap-3 rounded-2xl bg-sunken p-4">
                <FileArchive size={22} className="mt-0.5 text-terra" />
                <dl className="grid flex-1 grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted">Créée le</dt>
                  <dd className="text-right">{formatDate(preview.backup.exportedAt)}</dd>
                  <dt className="text-muted">Recettes</dt>
                  <dd className="text-right font-semibold">{preview.backup.recipes.length}</dd>
                  <dt className="text-muted">Photos</dt>
                  <dd className="text-right">{preview.backup.photos.length}</dd>
                  <dt className="text-muted">Réalisations</dt>
                  <dd className="text-right">{preview.backup.journal.length}</dd>
                  <dt className="text-muted">Collections</dt>
                  <dd className="text-right">{preview.backup.collections.length}</dd>
                  <dt className="text-muted">Déjà présentes ici</dt>
                  <dd className="text-right">
                    {preview.duplicates}
                    {preview.newerInBackup ? ` (dont ${preview.newerInBackup} plus récentes)` : ''}
                  </dd>
                  {preview.sameTitle > 0 && (
                    <>
                      <dt className="text-muted">Même nom, autre fiche</dt>
                      <dd className="text-right">{preview.sameTitle}</dd>
                    </>
                  )}
                </dl>
              </div>
              {preview.backup.warnings.length > 0 && (
                <ul className="list-disc space-y-1 rounded-2xl bg-terra-soft p-4 pl-8 text-sm text-terra-strong">
                  {preview.backup.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <Segmented
                label="Mode de restauration"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'merge', label: 'Fusionner' },
                  { value: 'replace', label: 'Tout remplacer' },
                ]}
              />
              <p className="text-sm text-muted">
                {mode === 'merge'
                  ? 'Ajoute ce qui manque. Pour une recette présente des deux côtés, la version la plus récente est gardée. Rien n’est supprimé.'
                  : 'Efface le carnet de ce téléphone puis importe la sauvegarde. Votre clé API reste en place.'}
              </p>
              <Button block size="lg" variant={mode === 'replace' ? 'danger' : 'primary'} loading={restoring} onClick={() => void restore()}>
                {mode === 'merge' ? 'Fusionner avec mon carnet' : 'Remplacer mon carnet'}
              </Button>
            </div>
          )}
        </section>
      </Page>
    </>
  )
}
