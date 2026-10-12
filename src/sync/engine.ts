/**
 * Moteur de synchronisation (prototype, étape A — non branché à l'interface).
 *
 * Dexie reste la base de l'application : tout fonctionne hors ligne, le serveur n'est qu'une copie
 * synchronisée par compte.
 *
 * Détection des modifications : pour chaque enregistrement, on mémorise (base annexe
 * « <base>~sync ») la révision du serveur et l'empreinte du contenu synchronisé. Un enregistrement
 * dont l'empreinte diffère, ou qui a disparu, est à envoyer. Cette comparaison tient lieu de file
 * d'attente persistante : elle survit aux redémarrages, aux coupures et aux écritures groupées
 * (`clear()`, imports), sans jamais rater une modification.
 *
 * Règles de conflit (jamais d'écrasement silencieux) :
 * - recettes, journal, publications : la version du serveur garde l'identifiant, celle de cet
 *   appareil est conservée en copie « (conflit) » ;
 * - collections : union des recettes ;
 * - courses, aliments, mémoire, photos : la plus récente gagne, la perdante est journalisée ;
 * - modifié ici / supprimé ailleurs : la modification l'emporte (rien n'est perdu) ;
 * - supprimé ici / modifié ailleurs : la version modifiée est restaurée.
 *
 * Suppressions : seules les suppressions VOLONTAIRES sont transmises. `trackDeletions()` est
 * branché sur la base dès son ouverture : chaque suppression faite par l'application (et validée)
 * laisse une trace. Un enregistrement disparu SANS trace (perte partielle ou totale d'IndexedDB,
 * effacement par le système) est considéré comme perdu : il est re-téléchargé, jamais supprimé du
 * serveur. Le serveur refuse en plus de supprimer une photo encore utilisée par une recette ; les
 * suppressions de photos sont envoyées en dernier.
 *
 * Comptes : une base locale est liée à UN compte (`bindToAccount`, après accord de migration).
 * Toute synchronisation avec un autre compte est refusée avant le moindre échange de données.
 */
import Dexie, { type Table } from 'dexie'
import type { CarnetDB } from '@/db/db'
import type { PushChange, ServerChange, ServerVersion, SyncApi, SyncCollection } from './api'

/** Clé (table `settings` de la base locale) du compte auquel cette base est liée. */
export const OWNER_SETTING = 'syncOwner'

export const SYNCED: SyncCollection[] = ['photos', 'recipes', 'journal', 'collections', 'shopping', 'posts', 'foods', 'foodMemory']
const KEY: Record<SyncCollection, string> = {
  recipes: 'id', photos: 'id', journal: 'id', collections: 'id', shopping: 'id', posts: 'id', foods: 'key', foodMemory: 'nameKey',
}
/** Champs propres à l'appareil (vidéo enregistrée localement, état du téléchargement NAS). */
const POST_DEVICE_FIELDS = ['video', 'mediaStatus', 'mediaJobId', 'mediaProgress', 'mediaMessage'] as const
const PHOTO_FIELDS = ['id', 'mime', 'width', 'height', 'size', 'createdAt', 'isDemo'] as const
const BATCH = 200

type Row = Record<string, unknown>
type Item = { change: PushChange; row: Row | null }

interface MetaRow {
  collection: SyncCollection
  id: string
  rev: number
  /** Empreinte du contenu synchronisé ('' : à renvoyer). */
  hash: string
  deleted: boolean
}

export interface ConflictLog {
  seq?: number
  at: number
  collection: SyncCollection
  id: string
  kind: 'copy' | 'merged' | 'kept-local' | 'kept-server' | 'resurrected' | 'restored' | 'rejected'
  /** Version écartée (jamais perdue : consultable et récupérable). */
  loser?: Row | null
  copyId?: string
  note?: string
}

interface Tombstone {
  collection: SyncCollection
  id: string
  at: number
}

class SyncMetaDB extends Dexie {
  meta!: Table<MetaRow, [SyncCollection, string]>
  state!: Table<{ key: string; value: unknown }, string>
  conflicts!: Table<ConflictLog, number>
  /** Suppressions volontaires (faites par l'application) en attente d'envoi. */
  tombstones!: Table<Tombstone, [SyncCollection, string]>
  constructor(name: string) {
    super(name)
    this.version(1).stores({ meta: '[collection+id], collection', state: 'key', conflicts: '++seq, at', tombstones: '[collection+id], collection' })
  }
}

const metaDbs = new Map<string, SyncMetaDB>()
function metaDbFor(name: string): SyncMetaDB {
  let m = metaDbs.get(name)
  if (!m) metaDbs.set(name, (m = new SyncMetaDB(`${name}~sync`)))
  return m
}

const tracked = new WeakSet<CarnetDB>()

/**
 * À appeler juste après l'ouverture de la base, avant toute interface : chaque suppression
 * validée par l'application est notée comme volontaire. Une écriture `clear()` (restauration,
 * import « remplacer ») n'est PAS une suppression volontaire : rien n'est effacé du serveur.
 */
export function trackDeletions(db: CarnetDB): void {
  if (tracked.has(db)) return
  tracked.add(db)
  const meta = metaDbFor(db.name)
  for (const coll of SYNCED) {
    ;(db as unknown as Record<string, Table<Row, string>>)[coll].hook('deleting', (key, _obj, trans) => {
      // Notée seulement si la suppression est réellement validée. Si l'application s'arrête entre
      // les deux, l'élément sera re-téléchargé : le sens sûr (rien n'est perdu).
      trans.on('complete', () => void meta.tombstones.put({ collection: coll, id: String(key), at: Date.now() }))
    })
  }
}

export class SyncAccountError extends Error {
  constructor(
    public code: 'not_bound' | 'other_account',
    message: string,
  ) {
    super(message)
  }
}

export interface SyncReport {
  pushed: number
  pulled: number
  conflicts: ConflictLog[]
  /** Éléments disparus de l'appareil sans suppression volontaire : re-téléchargés (aucune suppression envoyée). */
  recovered: { collection: SyncCollection; count: number }[]
  rejected: { collection: SyncCollection; id: string; error: string }[]
}

export interface SyncOptions {
  /** Synchroniser aussi les données de démonstration (seulement avec l'accord de l'utilisateur). */
  includeDemo?: boolean
  /** Nom de l'appareil (étiquette des copies de conflit). */
  deviceLabel?: string
  now?: () => number
}

// ---------------------------------------------------------------------------
// Empreintes
// ---------------------------------------------------------------------------

export function canonical(v: unknown): string {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const o = v as Row
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}'
}

export async function sha256Hex(data: string | Blob | ArrayBuffer): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Blob ? await data.arrayBuffer() : data
  const d = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Partie synchronisée d'un enregistrement (identique côté téléphone et côté serveur). */
export function syncedPart(coll: SyncCollection, row: Row): Row {
  if (coll === 'photos') return Object.fromEntries(PHOTO_FIELDS.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]))
  if (coll === 'posts') {
    const out = { ...row }
    for (const k of POST_DEVICE_FIELDS) delete out[k]
    return out
  }
  return row
}

const fingerprint = (coll: SyncCollection, row: Row) => sha256Hex(canonical(syncedPart(coll, row)))

// ---------------------------------------------------------------------------
// Moteur
// ---------------------------------------------------------------------------

export class SyncEngine {
  readonly meta: SyncMetaDB
  private running: Promise<SyncReport> | null = null
  private now: () => number

  constructor(
    readonly db: CarnetDB,
    private api: SyncApi,
    private opts: SyncOptions = {},
  ) {
    this.meta = metaDbFor(db.name)
    trackDeletions(db)
    this.now = opts.now ?? Date.now
  }

  private table(coll: SyncCollection): Table<Row, string> {
    return (this.db as unknown as Record<string, Table<Row, string>>)[coll]
  }

  private included(row: Row): boolean {
    return this.opts.includeDemo || !row.isDemo
  }

  /** Une seule synchronisation à la fois ; un appel concurrent attend la même. */
  sync(): Promise<SyncReport> {
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  /**
   * Lie cette base locale au compte connecté (après le résumé de migration et l'accord de
   * l'utilisateur, ou sur une base vide). Refuse si elle appartient déjà à un autre compte.
   */
  async bindToAccount(): Promise<void> {
    const me = await this.api.me()
    const cur = (await this.db.settings.get(OWNER_SETTING))?.value
    if (cur && cur !== me.id) throw new SyncAccountError('other_account', 'Ce carnet appartient à un autre compte.')
    await this.db.settings.put({ key: OWNER_SETTING, value: me.id })
  }

  private async checkAccount(): Promise<void> {
    const owner = (await this.db.settings.get(OWNER_SETTING))?.value
    if (!owner) throw new SyncAccountError('not_bound', 'Carnet non lié à un compte : migration à confirmer.')
    const me = await this.api.me()
    if (me.id !== owner) throw new SyncAccountError('other_account', 'Ce carnet appartient à un autre compte : synchronisation refusée.')
  }

  private async run(): Promise<SyncReport> {
    await this.checkAccount() // avant tout échange de données
    const report: SyncReport = { pushed: 0, pulled: 0, conflicts: [], recovered: [], rejected: [] }
    // Plusieurs tours : un conflit résolu (fusion, résurrection, copie) produit un nouvel envoi.
    for (let round = 0; round < 4; round++) {
      const sent = await this.pushRound(report)
      await this.pull(report)
      if (!sent) break
    }
    return report
  }

  // --- Envoi --------------------------------------------------------------

  /** Modifications à envoyer d'une collection : ajouts, modifications, suppressions volontaires. */
  private async pending(coll: SyncCollection, report: SyncReport): Promise<Item[]> {
    const key = KEY[coll]
    const all = await this.table(coll).toArray()
    const rows = all.filter((r) => this.included(r))
    const metas = new Map((await this.meta.meta.where('collection').equals(coll).toArray()).map((m) => [m.id, m]))
    const tombs = new Set((await this.meta.tombstones.where('collection').equals(coll).toArray()).map((t) => t.id))
    const out: Item[] = []
    const present = new Set(all.map((r) => String(r[key])))
    for (const row of rows) {
      const id = String(row[key])
      const m = metas.get(id)
      const h = await fingerprint(coll, row)
      if (!m || m.deleted || m.hash !== h) {
        out.push({ change: { collection: coll, id, base_rev: m?.rev ?? 0, data: syncedPart(coll, row), updated_at: (row.updatedAt as number) ?? undefined }, row })
      }
    }
    const lost: string[] = []
    for (const m of metas.values()) {
      if (m.deleted || present.has(m.id)) continue
      if (tombs.has(m.id)) out.push({ change: { collection: coll, id: m.id, base_rev: m.rev, deleted: true }, row: null })
      else lost.push(m.id)
    }
    // Traces sans objet (élément recréé, jamais synchronisé, déjà supprimé) : effacées.
    const stale = [...tombs].filter((id) => present.has(id) || !metas.get(id) || metas.get(id)!.deleted)
    if (stale.length) await this.meta.tombstones.bulkDelete(stale.map((id) => [coll, id] as [SyncCollection, string]))
    if (lost.length) {
      // Disparus sans suppression volontaire : on oublie leur état et on relit tout le serveur.
      report.recovered.push({ collection: coll, count: lost.length })
      await this.meta.meta.bulkDelete(lost.map((id) => [coll, id] as [SyncCollection, string]))
      await this.meta.state.put({ key: 'cursor', value: 0 })
    }
    return out
  }

  private async uploadPhoto(row: Row): Promise<Row> {
    const [sha, thumbSha] = await Promise.all([sha256Hex(row.blob as Blob), sha256Hex(row.thumb as Blob)])
    const missing = await this.api.missingBlobs([sha, thumbSha])
    if (missing.includes(sha)) await this.api.putBlob(sha, row.blob as Blob, String(row.mime || 'image/webp'))
    if (missing.includes(thumbSha) && thumbSha !== sha) await this.api.putBlob(thumbSha, row.thumb as Blob, (row.thumb as Blob).type || 'image/webp')
    return { ...syncedPart('photos', row), sha256: sha, thumbSha256: thumbSha }
  }

  private async pushRound(report: SyncReport): Promise<number> {
    const queue: [SyncCollection, Item[]][] = []
    for (const coll of SYNCED) queue.push([coll, await this.pending(coll, report)])
    // Suppressions de photos en dernier : la recette qui les utilisait est supprimée avant.
    const entry = queue.find(([c]) => c === 'photos')!
    const photos = entry[1]
    entry[1] = photos.filter((it) => !it.change.deleted)
    queue.push(['photos', photos.filter((it) => it.change.deleted)])
    let sent = 0
    for (const [coll, items] of queue) {
      for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH)
        if (coll === 'photos') {
          for (const it of batch) if (it.row) it.change.data = await this.uploadPhoto(it.row)
        }
        const results = await this.api.push(batch.map((b) => b.change))
        sent += batch.length
        for (const [j, res] of results.entries()) {
          const { change, row } = batch[j]
          if (change.deleted) await this.meta.tombstones.delete([coll, change.id])
          if (res.status === 'ok') {
            report.pushed++
            if (change.deleted) await this.meta.meta.delete([coll, change.id])
            else await this.meta.meta.put({ collection: coll, id: change.id, rev: res.rev, hash: await fingerprint(coll, row!), deleted: false })
          } else if (res.status === 'conflict') {
            await this.resolve(coll, change.id, row, res.server, report)
          } else if (res.status === 'rejected') {
            report.rejected.push({ collection: coll, id: change.id, error: res.error })
            await this.log(report, { collection: coll, id: change.id, kind: 'rejected', note: res.error })
          }
          // missing_blob : le fichier sera renvoyé au prochain tour (rien n'est marqué synchronisé).
        }
      }
    }
    return sent
  }

  // --- Réception ----------------------------------------------------------

  private async pull(report: SyncReport): Promise<void> {
    let cursor = ((await this.meta.state.get('cursor'))?.value as number) ?? 0
    for (;;) {
      const page = await this.api.changes(cursor, 200)
      for (const ch of page.changes) await this.applyRemote(ch, report)
      // Le curseur n'avance qu'une fois la page entièrement appliquée (reprise après coupure).
      cursor = page.cursor
      await this.meta.state.put({ key: 'cursor', value: cursor })
      if (!page.more) break
    }
  }

  private async applyRemote(ch: ServerChange, report: SyncReport): Promise<void> {
    const coll = ch.collection
    if (!SYNCED.includes(coll)) return
    const m = await this.meta.meta.get([coll, ch.id])
    if (m && m.rev >= ch.rev) return // déjà appliquée (notre propre envoi, ou page rejouée)
    const local = (await this.table(coll).get(ch.id)) ?? null
    let dirty: boolean
    if (!m) dirty = !!local && (await fingerprint(coll, local)) !== (ch.data ? await fingerprint(coll, ch.data) : '')
    else dirty = local ? m.deleted || (await fingerprint(coll, local)) !== m.hash : !m.deleted
    if (local && !this.included(local)) dirty = false // une donnée de démonstration ne bloque rien
    if (dirty) return this.resolve(coll, ch.id, local, ch, report)
    report.pulled++
    await this.write(coll, ch.id, local, ch)
  }

  /** Écrit la version du serveur localement, puis mémorise son empreinte (dans cet ordre). */
  private async write(coll: SyncCollection, id: string, local: Row | null, v: ServerVersion): Promise<void> {
    if (v.deleted || !v.data) {
      if (local) await this.table(coll).delete(id)
      await this.meta.meta.put({ collection: coll, id, rev: v.rev, hash: '', deleted: true })
      return
    }
    let row: Row = v.data
    if (coll === 'photos') {
      const same = local && local.blob && (await sha256Hex(local.blob as Blob)) === v.data.sha256
      const blob = same ? (local!.blob as Blob) : await this.api.getBlob(String(v.data.sha256))
      const thumb = same ? (local!.thumb as Blob) : await this.api.getBlob(String(v.data.thumbSha256 || v.data.sha256))
      row = { ...syncedPart('photos', v.data), blob, thumb }
    } else if (coll === 'posts' && local) {
      for (const k of POST_DEVICE_FIELDS) if (local[k] !== undefined) row = { ...row, [k]: local[k] }
    }
    await this.table(coll).put(row)
    await this.meta.meta.put({ collection: coll, id, rev: v.rev, hash: await fingerprint(coll, row), deleted: false })
  }

  // --- Conflits -----------------------------------------------------------

  private async log(report: SyncReport, entry: Omit<ConflictLog, 'at'>): Promise<void> {
    const e = { ...entry, at: this.now() }
    report.conflicts.push(e)
    await this.meta.conflicts.add(e)
  }

  /** `local` : version actuelle de cet appareil (null si supprimée ici). */
  private async resolve(coll: SyncCollection, id: string, local: Row | null, server: ServerVersion, report: SyncReport): Promise<void> {
    const markPending = (rev: number) => this.meta.meta.put({ collection: coll, id, rev, hash: '', deleted: false })
    if (!local && (server.deleted || !server.data)) {
      await this.meta.meta.put({ collection: coll, id, rev: server.rev, hash: '', deleted: true })
      return
    }
    if (local && (server.deleted || !server.data)) {
      // Modifié ici, supprimé ailleurs : la modification l'emporte.
      await markPending(server.rev)
      return this.log(report, { collection: coll, id, kind: 'resurrected', note: 'Supprimé sur un autre appareil, modifié sur celui-ci : conservé.' })
    }
    if (!local) {
      // Supprimé ici, modifié ailleurs : la version modifiée revient.
      await this.write(coll, id, null, server)
      return this.log(report, { collection: coll, id, kind: 'restored', note: 'Modifié sur un autre appareil : suppression annulée.' })
    }
    const data = server.data!
    if ((await fingerprint(coll, local)) === (await fingerprint(coll, data))) {
      await this.write(coll, id, local, server)
      return
    }
    if (coll === 'recipes' || coll === 'journal' || coll === 'posts') {
      const copyId = `${id}~${this.now().toString(36)}`
      const copy: Row = { ...local, id: copyId }
      const label = this.opts.deviceLabel ? ` — ${this.opts.deviceLabel}` : ''
      if (coll === 'recipes') copy.title = `${String(local.title ?? '')} (conflit${label})`
      if (coll === 'posts') {
        copy.title = `${String(local.title ?? '')} (conflit${label})`
        copy.dedupeKey = `${String(local.dedupeKey)}#${copyId}`
      }
      await this.db.transaction('rw', this.table(coll), async () => {
        await this.table(coll).put(copy)
      })
      await this.write(coll, id, local, server)
      return this.log(report, { collection: coll, id, kind: 'copy', copyId, loser: local, note: 'Les deux versions sont conservées.' })
    }
    if (coll === 'collections') {
      const ids = [...(data.recipeIds as string[]), ...(local.recipeIds as string[]).filter((x) => !(data.recipeIds as string[]).includes(x))]
      await this.table(coll).put({ ...data, recipeIds: ids, updatedAt: Math.max(Number(data.updatedAt) || 0, Number(local.updatedAt) || 0) })
      await markPending(server.rev)
      return this.log(report, { collection: coll, id, kind: 'merged', loser: local })
    }
    const localNewer = (Number(local.updatedAt ?? local.lastUsedAt) || 0) > (Number(data.updatedAt ?? data.lastUsedAt) || 0)
    if (localNewer) {
      await markPending(server.rev)
      return this.log(report, { collection: coll, id, kind: 'kept-local', loser: data })
    }
    await this.write(coll, id, local, server)
    return this.log(report, { collection: coll, id, kind: 'kept-server', loser: coll === 'photos' ? syncedPart(coll, local) : local })
  }

  // --- Vérification (migration : les données locales restent tant que ce n'est pas validé) ----

  /** Compare chaque enregistrement local avec le serveur. */
  async verify(): Promise<{ ok: boolean; checked: number; missingOnServer: string[]; different: string[] }> {
    const server = new Map<string, ServerChange>()
    for (let since = 0; ; ) {
      const p = await this.api.changes(since, 500)
      for (const c of p.changes) server.set(`${c.collection}/${c.id}`, c)
      since = p.cursor
      if (!p.more) break
    }
    const missingOnServer: string[] = []
    const different: string[] = []
    let checked = 0
    for (const coll of SYNCED) {
      for (const row of await this.table(coll).toArray()) {
        if (!this.included(row)) continue
        checked++
        const k = `${coll}/${String(row[KEY[coll]])}`
        const s = server.get(k)
        if (!s || s.deleted || !s.data) missingOnServer.push(k)
        else if ((await fingerprint(coll, row)) !== (await fingerprint(coll, s.data))) different.push(k)
        else if (coll === 'photos' && (await sha256Hex(row.blob as Blob)) !== s.data.sha256) different.push(k)
      }
    }
    return { ok: !missingOnServer.length && !different.length, checked, missingOnServer, different }
  }

  async conflictLog(): Promise<ConflictLog[]> {
    return this.meta.conflicts.orderBy('at').toArray()
  }
}
