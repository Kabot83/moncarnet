/**
 * Moteur de synchronisation (prototype — non branché à l'interface avant l'étape C).
 *
 * Dexie reste la base de l'application : tout fonctionne hors ligne, le serveur n'est qu'une copie.
 *
 * Deux espaces (Carnet Sync 0.2) :
 * - FAMILIAL : recettes communes (fiche, ingrédients, étapes, photos, nutrition, source, astuces) ;
 * - PERSONNEL : tout le reste — recettes privées, favoris, note, réalisations, notes personnelles,
 *   journal, collections, courses, aliments, publications « À essayer ».
 * Une recette familiale est UNE ligne Dexie (l'interface ne change pas) : le moteur l'envoie en deux
 * parties (commune → famille ; personnelle → `recipeMeta` de l'espace personnel) et la réassemble
 * à la réception. `row.space` ('family' | 'personal', absent = personnel) indique où créer une
 * recette nouvelle ; une recette déjà synchronisée reste dans son espace (déplacement : `moveRecipe`).
 *
 * Détection des modifications : empreinte du contenu synchronisé de chaque enregistrement (base
 * annexe « <base>~sync »). Cette comparaison tient lieu de file d'attente persistante : elle survit
 * aux redémarrages, aux coupures et aux écritures groupées, sans jamais rater une modification.
 *
 * Modifications simultanées (jamais d'écrasement silencieux) :
 * - recettes familiales : fusion par le serveur (champs indépendants fusionnés ; désaccord sur un
 *   même élément → les deux versions conservées, résolution manuelle) ; recette verrouillée par
 *   un autre : la version de cet appareil est gardée en copie personnelle ;
 * - recettes personnelles, journal, publications : copie « (conflit) » ;
 * - collections : union ; courses, aliments, photos : la plus récente, la perdante journalisée ;
 * - modifié ici / supprimé ailleurs : la modification l'emporte ; l'inverse : restauration.
 *
 * Suppressions : seules les suppressions VOLONTAIRES (faites par l'application, notées par
 * `trackDeletions`) sont transmises — une recette familiale va alors à la corbeille (30 jours).
 * Un élément disparu sans trace (perte d'IndexedDB) est re-téléchargé, jamais supprimé du serveur.
 *
 * Comptes : une base locale est liée à UN compte (`bindToAccount`) ; synchronisation refusée avec
 * un autre. Membre retiré de la famille (annoncé explicitement par le serveur) : les recettes
 * familiales sont retirées de l'appareil au mieux ; rien n'est converti en recette personnelle,
 * sauf ses propres créations jamais envoyées.
 */
import Dexie, { type Table } from 'dexie'
import type { CarnetDB } from '@/db/db'
import type { Me, PushChange, PushResult, ServerChange, ServerVersion, Space, SyncApi, SyncCollection } from './api'

/** Clé (table `settings` de la base locale) du compte auquel cette base est liée. */
export const OWNER_SETTING = 'syncOwner'

/** Tables Dexie synchronisées (`recipeMeta` n'existe que sur le serveur). */
export const SYNCED: SyncCollection[] = ['photos', 'recipes', 'journal', 'collections', 'shopping', 'posts', 'foods', 'foodMemory']
const KEY: Record<string, string> = {
  recipes: 'id', photos: 'id', journal: 'id', collections: 'id', shopping: 'id', posts: 'id', foods: 'key', foodMemory: 'nameKey',
}
/** Champs propres à l'appareil (vidéo enregistrée localement, état du téléchargement NAS). */
const POST_DEVICE_FIELDS = ['video', 'mediaStatus', 'mediaJobId', 'mediaProgress', 'mediaMessage'] as const
const PHOTO_FIELDS = ['id', 'mime', 'width', 'height', 'size', 'createdAt', 'isDemo'] as const
/** Champs locaux d'une recette (jamais envoyés tels quels). */
const LOCAL_ONLY = ['space', 'familyInfo'] as const
/** Partie personnelle d'une recette familiale (identique à `fields.py` côté serveur). */
export const PERSONAL_FIELDS = ['favorite', 'toTry', 'rating', 'cookCount', 'lastCookedAt', 'sourcePostId', 'receivedFrom', 'isDemo'] as const
export const PERSONAL_NOTES = ['modifications', 'mistakes', 'ideas', 'storage', 'reheating'] as const
const PERSONAL_DEFAULTS: Row = { favorite: false, toTry: false, rating: 0, cookCount: 0, lastCookedAt: null, sourcePostId: null }
const BATCH = 200

type Row = Record<string, unknown>
type MetaColl = SyncCollection | 'recipeMeta'
type Item = { change: PushChange; row: Row | null }

interface MetaRow {
  collection: MetaColl
  id: string
  space: Space
  rev: number
  /** Empreinte du contenu synchronisé ('' : à renvoyer). */
  hash: string
  deleted: boolean
}

export interface ConflictLog {
  seq?: number
  at: number
  collection: MetaColl
  id: string
  kind: 'copy' | 'merged' | 'family-conflict' | 'locked-copy' | 'kept-local' | 'kept-server' | 'resurrected' | 'restored' | 'rejected'
  /** Version écartée (jamais perdue : consultable et récupérable). */
  loser?: Row | null
  copyId?: string
  /** Conflit familial à résoudre (identifiant côté serveur). */
  conflictId?: string
  note?: string
}

interface Tombstone {
  collection: SyncCollection
  id: string
  at: number
}

class SyncMetaDB extends Dexie {
  meta!: Table<MetaRow, [MetaColl, string]>
  state!: Table<{ key: string; value: unknown }, string>
  conflicts!: Table<ConflictLog, number>
  /** Suppressions volontaires (faites par l'application) en attente d'envoi. */
  tombstones!: Table<Tombstone, [SyncCollection, string]>
  /** Partie personnelle reçue des recettes familiales (favori, note, notes…). */
  overlays!: Table<Row & { id: string }, string>
  constructor(name: string) {
    super(name)
    this.version(1).stores({ meta: '[collection+id], collection', state: 'key', conflicts: '++seq, at', tombstones: '[collection+id], collection', overlays: 'id' })
  }
}

const metaDbs = new Map<string, SyncMetaDB>()
function metaDbFor(name: string): SyncMetaDB {
  let m = metaDbs.get(name)
  if (!m) metaDbs.set(name, (m = new SyncMetaDB(`${name}~sync`)))
  return m
}

const tracked = new WeakSet<CarnetDB>()
/** Suppressions faites par le moteur lui-même (application d'une décision du serveur) : pas de trace. */
const engineDeletes = new Set<string>()

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
      if (engineDeletes.has(`${db.name}|${coll}|${String(key)}`)) return
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
  rejected: { collection: MetaColl; id: string; error: string }[]
  /** Recettes familiales retirées de l'appareil après le retrait de la famille. */
  removedFromFamily: number
  /** Recettes marquées « famille » en attente (compte sans famille). */
  waitingForFamily: number
}

export interface SyncOptions {
  /** Synchroniser aussi les données de démonstration (seulement avec l'accord de l'utilisateur). */
  includeDemo?: boolean
  /** Nom de l'appareil (étiquette des copies de conflit). */
  deviceLabel?: string
  now?: () => number
}

// ---------------------------------------------------------------------------
// Empreintes et répartition des champs
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

const notesOf = (row: Row): Row => (row.notes && typeof row.notes === 'object' ? (row.notes as Row) : {})

/** Partie commune d'une recette familiale (ce que voient tous les membres). */
export function familyShared(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) {
    if (k !== 'notes' && !(PERSONAL_FIELDS as readonly string[]).includes(k) && !(LOCAL_ONLY as readonly string[]).includes(k)) out[k] = v
  }
  out.notes = { tips: notesOf(row).tips ?? '' }
  return out
}

/** Partie personnelle d'une recette familiale (visible de soi seul). */
export function personalOf(row: Row): Row {
  const out: Row = { id: row.id }
  for (const k of PERSONAL_FIELDS) if (row[k] !== undefined) out[k] = row[k]
  const n = notesOf(row)
  out.notes = Object.fromEntries(PERSONAL_NOTES.map((k) => [k, n[k] ?? '']))
  return out
}

function isDefaultPersonal(p: Row): boolean {
  const n = p.notes as Row
  return PERSONAL_NOTES.every((k) => !n[k]) && Object.entries(PERSONAL_DEFAULTS).every(([k, v]) => p[k] === undefined || p[k] === v) && !p.receivedFrom
}

/** Recette locale = partie commune + partie personnelle. */
function joinRecipe(shared: Row, personal: Row | null, info: unknown): Row {
  const p = personal ?? {}
  const row: Row = { ...shared, ...PERSONAL_DEFAULTS }
  for (const k of PERSONAL_FIELDS) if (p[k] !== undefined) row[k] = p[k]
  row.notes = { ...Object.fromEntries(PERSONAL_NOTES.map((k) => [k, notesOf(p)[k] ?? ''])), tips: notesOf(shared).tips ?? '' }
  row.space = 'family'
  if (info) row.familyInfo = info
  return row
}

/** Partie synchronisée d'un enregistrement (identique côté téléphone et côté serveur). */
export function syncedPart(coll: MetaColl, row: Row, space: Space = 'personal'): Row {
  if (coll === 'photos') return Object.fromEntries(PHOTO_FIELDS.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]))
  if (coll === 'posts') {
    const out = { ...row }
    for (const k of POST_DEVICE_FIELDS) delete out[k]
    return out
  }
  if (coll === 'recipes') {
    if (space === 'family') return familyShared(row)
    const out = { ...row }
    for (const k of LOCAL_ONLY) delete out[k]
    return out
  }
  if (coll === 'recipeMeta') return personalOf(row)
  return row
}

const fingerprint = (coll: MetaColl, row: Row, space: Space = 'personal') => sha256Hex(canonical(syncedPart(coll, row, space)))

function photoRefs(r: Row): string[] {
  const steps = Array.isArray(r.steps) ? (r.steps as Row[]) : []
  return [r.mainPhotoId, ...((r.galleryPhotoIds as string[]) ?? []), ...steps.map((s) => s.photoId)].filter((x): x is string => typeof x === 'string' && !!x)
}

// ---------------------------------------------------------------------------
// Moteur
// ---------------------------------------------------------------------------

export class SyncEngine {
  readonly meta: SyncMetaDB
  private running: Promise<SyncReport> | null = null
  private now: () => number
  private family = false

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

  private async engineDelete(coll: SyncCollection, id: string): Promise<void> {
    const k = `${this.db.name}|${coll}|${id}`
    engineDeletes.add(k)
    try {
      await this.table(coll).delete(id)
    } finally {
      engineDeletes.delete(k)
    }
  }

  /** Espace où vit (ou vivra) une recette. */
  private recipeSpace(row: Row, m: MetaRow | undefined): Space {
    if (m && !m.deleted) return m.space
    return row.space === 'family' ? 'family' : 'personal'
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

  private async checkAccount(): Promise<Me> {
    const owner = (await this.db.settings.get(OWNER_SETTING))?.value
    if (!owner) throw new SyncAccountError('not_bound', 'Carnet non lié à un compte : migration à confirmer.')
    const me = await this.api.me()
    if (me.id !== owner) throw new SyncAccountError('other_account', 'Ce carnet appartient à un autre compte : synchronisation refusée.')
    return me
  }

  private async run(): Promise<SyncReport> {
    const me = await this.checkAccount() // avant tout échange de données
    const report: SyncReport = { pushed: 0, pulled: 0, conflicts: [], recovered: [], rejected: [], removedFromFamily: 0, waitingForFamily: 0 }
    this.family = !!me.family
    const known = (await this.meta.state.get('familyKnown'))?.value === true
    if (me.family && !known) {
      await this.pull(report, 'family') // arrivée dans la famille : tout le catalogue
      await this.meta.state.put({ key: 'familyKnown', value: true })
    } else if (!me.family && me.family_revoked) {
      await this.leaveFamily(report)
    }
    // Plusieurs tours : un conflit résolu (fusion, résurrection, copie) produit un nouvel envoi.
    for (let round = 0; round < 4; round++) {
      report.waitingForFamily = 0
      const sent = await this.pushRound(report)
      await this.pull(report)
      if (!sent) break
    }
    return report
  }

  // --- Envoi --------------------------------------------------------------

  /** Modifications à envoyer d'une collection : ajouts, modifications, suppressions volontaires. */
  private async pending(coll: SyncCollection, report: SyncReport, familyPhotos: Set<string>): Promise<Item[]> {
    const key = KEY[coll]
    const all = await this.table(coll).toArray()
    const rows = all.filter((r) => this.included(r))
    const metas = new Map((await this.meta.meta.where('collection').equals(coll).toArray()).map((m) => [m.id, m]))
    const pmetas = coll === 'recipes' ? new Map((await this.meta.meta.where('collection').equals('recipeMeta').toArray()).map((m) => [m.id, m])) : null
    const tombs = new Set((await this.meta.tombstones.where('collection').equals(coll).toArray()).map((t) => t.id))
    const out: Item[] = []
    const present = new Set(all.map((r) => String(r[key])))
    for (const row of rows) {
      const id = String(row[key])
      const m = metas.get(id)
      let space: Space = m && !m.deleted ? m.space : 'personal'
      if (coll === 'recipes') space = this.recipeSpace(row, m)
      if (coll === 'photos' && !(m && !m.deleted)) space = familyPhotos.has(id) ? 'family' : 'personal'
      if (space === 'family' && !this.family) {
        report.waitingForFamily++
        continue
      }
      const h = await fingerprint(coll, row, space)
      if (!m || m.deleted || m.hash !== h) {
        out.push({ change: { collection: coll, id, space, base_rev: m?.rev ?? 0, data: syncedPart(coll, row, space), updated_at: (row.updatedAt as number) ?? undefined }, row })
      }
      if (coll === 'recipes' && space === 'family') {
        // Partie personnelle (favori, note, notes…) dans l'espace personnel.
        const pm = pmetas!.get(id)
        const p = personalOf(row)
        const ph = await sha256Hex(canonical(p))
        if ((pm && !pm.deleted && pm.hash !== ph) || ((!pm || pm.deleted) && !isDefaultPersonal(p))) {
          out.push({ change: { collection: 'recipeMeta', id, space: 'personal', base_rev: pm?.rev ?? 0, data: p }, row })
        }
      }
    }
    const lost: string[] = []
    for (const m of metas.values()) {
      if (m.deleted || present.has(m.id)) continue
      if (tombs.has(m.id)) out.push({ change: { collection: coll, id: m.id, space: m.space, base_rev: m.rev, deleted: true }, row: null })
      else lost.push(m.id)
    }
    // Traces sans objet (élément recréé, jamais synchronisé, déjà supprimé) : effacées.
    const stale = [...tombs].filter((id) => present.has(id) || !metas.get(id) || metas.get(id)!.deleted)
    if (stale.length) await this.meta.tombstones.bulkDelete(stale.map((id) => [coll, id] as [SyncCollection, string]))
    if (lost.length) {
      // Disparus sans suppression volontaire : on oublie leur état et on relit tout le serveur.
      report.recovered.push({ collection: coll, count: lost.length })
      await this.meta.meta.bulkDelete(lost.map((id) => [coll, id] as [MetaColl, string]))
      if (coll === 'recipes') await this.meta.meta.bulkDelete(lost.map((id) => ['recipeMeta', id] as [MetaColl, string]))
      await this.meta.state.put({ key: 'cursor', value: 0 })
    }
    return out
  }

  /**
   * Une recette familiale ne peut utiliser qu'une photo de la famille (sinon les autres membres
   * ne la verraient pas) : une photo déjà rangée dans l'espace personnel est dupliquée.
   */
  private async familyPhotoIds(): Promise<Set<string>> {
    const ids = new Set<string>()
    const rmeta = new Map((await this.meta.meta.where('collection').equals('recipes').toArray()).map((m) => [m.id, m]))
    for (const r of await this.table('recipes').toArray()) {
      if (!this.included(r) || this.recipeSpace(r, rmeta.get(String(r.id))) !== 'family') continue
      const remap: Record<string, string> = {}
      for (const pid of photoRefs(r)) {
        const pm = await this.meta.meta.get(['photos', pid])
        if (pm && !pm.deleted && pm.space === 'personal') {
          const p = await this.table('photos').get(pid)
          if (!p) continue
          const nid = `${pid}-f${this.now().toString(36)}`
          await this.table('photos').put({ ...p, id: nid })
          remap[pid] = nid
        }
      }
      let row = r
      if (Object.keys(remap).length) {
        const steps = Array.isArray(r.steps) ? (r.steps as Row[]).map((s) => (s.photoId && remap[s.photoId as string] ? { ...s, photoId: remap[s.photoId as string] } : s)) : r.steps
        row = { ...r, steps, mainPhotoId: remap[r.mainPhotoId as string] ?? r.mainPhotoId, galleryPhotoIds: ((r.galleryPhotoIds as string[]) ?? []).map((x) => remap[x] ?? x) }
        await this.table('recipes').put(row)
      }
      for (const pid of photoRefs(row)) ids.add(pid)
    }
    return ids
  }

  private async uploadPhoto(row: Row, space: Space): Promise<Row> {
    const [sha, thumbSha] = await Promise.all([sha256Hex(row.blob as Blob), sha256Hex(row.thumb as Blob)])
    const missing = await this.api.missingBlobs([sha, thumbSha], space)
    if (missing.includes(sha)) await this.api.putBlob(sha, row.blob as Blob, String(row.mime || 'image/webp'), space)
    if (missing.includes(thumbSha) && thumbSha !== sha) await this.api.putBlob(thumbSha, row.thumb as Blob, (row.thumb as Blob).type || 'image/webp', space)
    return { ...syncedPart('photos', row), sha256: sha, thumbSha256: thumbSha }
  }

  private async pushRound(report: SyncReport): Promise<number> {
    const familyPhotos = this.family ? await this.familyPhotoIds() : new Set<string>()
    const queue: [SyncCollection, Item[]][] = []
    for (const coll of SYNCED) queue.push([coll, await this.pending(coll, report, familyPhotos)])
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
          for (const it of batch) if (it.row) it.change.data = await this.uploadPhoto(it.row, it.change.space ?? 'personal')
        }
        const results = await this.api.push(batch.map((b) => b.change))
        sent += batch.length
        for (const [j, res] of results.entries()) await this.handleResult(batch[j], res, report)
      }
    }
    return sent
  }

  private async handleResult({ change, row }: Item, res: PushResult, report: SyncReport): Promise<void> {
    const coll = change.collection as MetaColl
    const space = change.space ?? 'personal'
    if (change.deleted) await this.meta.tombstones.delete([coll as SyncCollection, change.id])
    switch (res.status) {
      case 'ok':
        report.pushed++
        if (change.deleted) await this.meta.meta.delete([coll, change.id])
        else {
          const hash = coll === 'recipeMeta' ? await sha256Hex(canonical(personalOf(row!))) : await fingerprint(coll, row!, space)
          await this.meta.meta.put({ collection: coll, id: change.id, space, rev: res.rev, hash, deleted: false })
        }
        return
      case 'merged': {
        // Fusion par le serveur : la version fusionnée devient la version locale (partie
        // personnelle conservée) ; un désaccord éventuel reste ouvert sur le serveur.
        report.pushed++
        const local = (await this.table('recipes').get(change.id)) ?? null
        await this.write('recipes', change.id, local, { rev: res.rev, deleted: false, data: res.data, space: 'family', info: res.info })
        await this.log(report, res.conflict
          ? { collection: coll, id: change.id, kind: 'family-conflict', conflictId: res.conflict, note: 'Modification incompatible : les deux versions sont conservées, à résoudre.' }
          : { collection: coll, id: change.id, kind: 'merged', note: 'Fusionné avec les modifications des autres membres.' })
        return
      }
      case 'locked': {
        // Recette verrouillée par son auteur : la version de cet appareil devient une recette personnelle.
        if (row) {
          const copyId = `${change.id}~${this.now().toString(36)}`
          await this.table('recipes').put({ ...row, id: copyId, space: 'personal', familyInfo: undefined, title: `${String(row.title ?? '')} (ma version)` })
          await this.log(report, { collection: coll, id: change.id, kind: 'locked-copy', copyId, loser: row, note: 'Recette verrouillée : votre version est gardée dans votre carnet personnel.' })
        }
        await this.write('recipes', change.id, row, res.server)
        return
      }
      case 'wrong_space':
        // L'élément existe déjà dans l'autre espace : on s'y range, le serveur fusionnera.
        await this.meta.meta.put({ collection: coll, id: change.id, space: res.space_actual, rev: 0, hash: '', deleted: false })
        if (coll === 'recipes' && row) await this.table('recipes').update(change.id, { space: res.space_actual })
        await this.meta.state.put({ key: 'cursor', value: 0 })
        return
      case 'conflict':
        return this.resolve(coll, change.id, coll === 'recipeMeta' ? (row ? personalOf(row) : null) : row, res.server, report, space)
      case 'rejected':
        report.rejected.push({ collection: coll, id: change.id, error: res.error })
        return this.log(report, { collection: coll, id: change.id, kind: 'rejected', note: res.error })
      // missing_blob : le fichier sera renvoyé au prochain tour (rien n'est marqué synchronisé).
    }
  }

  // --- Réception ----------------------------------------------------------

  private async pull(report: SyncReport, space?: Space): Promise<void> {
    // Rattrapage d'un espace (arrivée dans la famille) : sans toucher au curseur général.
    let cursor = space ? 0 : (((await this.meta.state.get('cursor'))?.value as number) ?? 0)
    for (;;) {
      const page = await this.api.changes(cursor, 200, space)
      for (const ch of page.changes) await this.applyRemote(ch, report)
      // Le curseur n'avance qu'une fois la page entièrement appliquée (reprise après coupure).
      cursor = page.cursor
      if (!space) await this.meta.state.put({ key: 'cursor', value: cursor })
      if (!page.more) break
    }
  }

  private async applyRemote(ch: ServerChange, report: SyncReport): Promise<void> {
    const coll = ch.collection as MetaColl
    if (coll === 'recipeMeta') return this.applyOverlay(ch, report)
    if (!SYNCED.includes(coll as SyncCollection)) return
    const m = await this.meta.meta.get([coll, ch.id])
    if (m && m.rev >= ch.rev) return // déjà appliquée (notre propre envoi, ou page rejouée)
    const local = (await this.table(coll as SyncCollection).get(ch.id)) ?? null
    const space = ch.space ?? 'personal'
    let dirty: boolean
    if (!m) dirty = !!local && (await fingerprint(coll, local, space)) !== (ch.data ? await fingerprint(coll, ch.data, space) : '')
    else dirty = local ? m.deleted || (await fingerprint(coll, local, m.space)) !== m.hash : !m.deleted
    if (local && !this.included(local)) dirty = false // une donnée de démonstration ne bloque rien
    if (dirty && coll === 'recipes' && space === 'family' && local && (!m || m.space === 'family')) {
      // Recette familiale modifiée ici et ailleurs : rien n'est écrit ; l'envoi suivant (avec la
      // version d'origine) laisse le serveur fusionner. Origine inconnue : le serveur garde les deux.
      if (!m) await this.meta.meta.put({ collection: 'recipes', id: ch.id, space: 'family', rev: 0, hash: '', deleted: false })
      return
    }
    if (dirty) return this.resolve(coll, ch.id, local, ch, report, space)
    report.pulled++
    await this.write(coll as SyncCollection, ch.id, local, ch)
  }

  private async applyOverlay(ch: ServerChange, report: SyncReport): Promise<void> {
    const m = await this.meta.meta.get(['recipeMeta', ch.id])
    if (m && m.rev >= ch.rev) return
    if (ch.deleted || !ch.data) {
      await this.meta.overlays.delete(ch.id)
      await this.meta.meta.put({ collection: 'recipeMeta', id: ch.id, space: 'personal', rev: ch.rev, hash: '', deleted: true })
      return
    }
    const local = await this.table('recipes').get(ch.id)
    const rm = await this.meta.meta.get(['recipes', ch.id])
    if (local && m && !m.deleted && rm?.space === 'family' && (await sha256Hex(canonical(personalOf(local)))) !== m.hash) {
      return this.resolve('recipeMeta', ch.id, personalOf(local), ch, report, 'personal') // modifiée ici aussi
    }
    report.pulled++
    await this.writeOverlay(ch.id, ch.data, ch.rev)
  }

  private async writeOverlay(id: string, data: Row, rev: number): Promise<void> {
    await this.meta.overlays.put({ ...data, id })
    const local = await this.table('recipes').get(id)
    const rm = await this.meta.meta.get(['recipes', id])
    if (local && rm?.space === 'family') await this.table('recipes').put(joinRecipe(familyShared(local), data, local.familyInfo))
    await this.meta.meta.put({ collection: 'recipeMeta', id, space: 'personal', rev, hash: await sha256Hex(canonical(personalOf({ ...data, id }))), deleted: false })
  }

  /** Écrit la version du serveur localement, puis mémorise son empreinte (dans cet ordre). */
  private async write(coll: SyncCollection, id: string, local: Row | null, v: ServerVersion): Promise<void> {
    const space = v.space ?? 'personal'
    if (v.deleted || !v.data) {
      if (local) await this.engineDelete(coll, id)
      await this.meta.meta.put({ collection: coll, id, space, rev: v.rev, hash: '', deleted: true })
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
    } else if (coll === 'recipes' && space === 'family') {
      // Partie personnelle : celle reçue du serveur, sinon celle déjà présente sur l'appareil.
      const overlay = (await this.meta.overlays.get(id)) ?? (local ? personalOf(local) : null)
      row = joinRecipe(v.data, overlay, v.info)
    } else if (coll === 'recipes') {
      row = { ...v.data, space: 'personal' }
    }
    await this.table(coll).put(row)
    await this.meta.meta.put({ collection: coll, id, space, rev: v.rev, hash: await fingerprint(coll, row, space), deleted: false })
  }

  /** Retrait de la famille, annoncé par le serveur : recettes familiales retirées de l'appareil. */
  private async leaveFamily(report: SyncReport): Promise<void> {
    for (const coll of ['recipes', 'photos'] as const) {
      for (const m of await this.meta.meta.where('collection').equals(coll).toArray()) {
        if (m.space !== 'family') continue
        if (await this.table(coll).get(m.id)) {
          await this.engineDelete(coll, m.id)
          if (coll === 'recipes') report.removedFromFamily++
        }
        await this.meta.meta.delete([coll, m.id])
      }
    }
    // Ses propres créations jamais envoyées restent à lui, dans son carnet personnel.
    for (const r of await this.table('recipes').toArray()) {
      if (r.space === 'family' && !(await this.meta.meta.get(['recipes', String(r.id)]))) await this.table('recipes').update(String(r.id), { space: 'personal' })
    }
    await this.meta.state.put({ key: 'familyKnown', value: false })
  }

  // --- Conflits -----------------------------------------------------------

  private async log(report: SyncReport, entry: Omit<ConflictLog, 'at'>): Promise<void> {
    const e = { ...entry, at: this.now() }
    report.conflicts.push(e)
    await this.meta.conflicts.add(e)
  }

  /** `local` : version actuelle de cet appareil (null si supprimée ici). */
  private async resolve(coll: MetaColl, id: string, local: Row | null, server: ServerVersion, report: SyncReport, space: Space): Promise<void> {
    const markPending = (rev: number) => this.meta.meta.put({ collection: coll, id, space, rev, hash: '', deleted: false })
    if (coll === 'recipeMeta') {
      // Partie personnelle modifiée sur deux de ses appareils : celle de cet appareil est renvoyée
      // (la précédente reste dans le journal des conflits).
      if (local && server.data) {
        await markPending(server.rev)
        return this.log(report, { collection: coll, id, kind: 'kept-local', loser: server.data })
      }
      if (server.data) return this.writeOverlay(id, server.data, server.rev)
      return
    }
    const c = coll as SyncCollection
    if (!local && (server.deleted || !server.data)) {
      await this.meta.meta.put({ collection: coll, id, space, rev: server.rev, hash: '', deleted: true })
      return
    }
    if (local && (server.deleted || !server.data)) {
      // Modifié ici, supprimé ailleurs : la modification l'emporte.
      await markPending(server.rev)
      return this.log(report, { collection: coll, id, kind: 'resurrected', note: 'Supprimé ailleurs, modifié sur cet appareil : conservé.' })
    }
    if (!local) {
      // Supprimé ici, modifié ailleurs (ou photo encore utilisée) : la version du serveur revient.
      await this.write(c, id, null, server)
      return this.log(report, { collection: coll, id, kind: 'restored', note: 'Modifié ailleurs ou encore utilisé : suppression annulée.' })
    }
    const data = server.data!
    if ((await fingerprint(coll, local, space)) === (await fingerprint(coll, data, space))) {
      await this.write(c, id, local, server)
      return
    }
    if (coll === 'recipes' || coll === 'journal' || coll === 'posts') {
      const copyId = `${id}~${this.now().toString(36)}`
      const copy: Row = { ...local, id: copyId }
      const label = this.opts.deviceLabel ? ` — ${this.opts.deviceLabel}` : ''
      if (coll === 'recipes') Object.assign(copy, { title: `${String(local.title ?? '')} (conflit${label})`, space: 'personal', familyInfo: undefined })
      if (coll === 'posts') {
        copy.title = `${String(local.title ?? '')} (conflit${label})`
        copy.dedupeKey = `${String(local.dedupeKey)}#${copyId}`
      }
      await this.table(c).put(copy)
      await this.write(c, id, local, server)
      return this.log(report, { collection: coll, id, kind: 'copy', copyId, loser: local, note: 'Les deux versions sont conservées.' })
    }
    if (coll === 'collections') {
      const ids = [...(data.recipeIds as string[]), ...(local.recipeIds as string[]).filter((x) => !(data.recipeIds as string[]).includes(x))]
      await this.table(c).put({ ...data, recipeIds: ids, updatedAt: Math.max(Number(data.updatedAt) || 0, Number(local.updatedAt) || 0) })
      await markPending(server.rev)
      return this.log(report, { collection: coll, id, kind: 'merged', loser: local })
    }
    const localNewer = (Number(local.updatedAt ?? local.lastUsedAt) || 0) > (Number(data.updatedAt ?? data.lastUsedAt) || 0)
    if (localNewer) {
      await markPending(server.rev)
      return this.log(report, { collection: coll, id, kind: 'kept-local', loser: data })
    }
    await this.write(c, id, local, server)
    return this.log(report, { collection: coll, id, kind: 'kept-server', loser: coll === 'photos' ? syncedPart(coll, local) : local })
  }

  // --- Déplacements (après confirmation de l'utilisateur dans l'interface) -----------

  /** Déplace une recette entre l'espace personnel et le catalogue familial. */
  async moveRecipe(id: string, to: Space, confirm: boolean): Promise<SyncReport> {
    await this.sync() // modifications locales envoyées d'abord : rien n'est perdu
    await this.api.moveRecipe(id, to, confirm)
    return this.sync()
  }

  // --- Vérification (migration : les données locales restent tant que ce n'est pas validé) ----

  /** Compare chaque enregistrement local avec le serveur (partie commune et partie personnelle). */
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
        const space = s?.space ?? 'personal'
        if (!s || s.deleted || !s.data) missingOnServer.push(k)
        else if ((await fingerprint(coll, row, space)) !== (await fingerprint(coll, s.data, space))) different.push(k)
        else if (coll === 'photos' && (await sha256Hex(row.blob as Blob)) !== s.data.sha256) different.push(k)
        else if (coll === 'recipes' && space === 'family') {
          const p = personalOf(row)
          const sm = server.get(`recipeMeta/${String(row.id)}`)
          if (sm?.data && !sm.deleted ? canonical(personalOf(sm.data)) !== canonical(p) : !isDefaultPersonal(p)) different.push(`recipeMeta/${String(row.id)}`)
        }
      }
    }
    return { ok: !missingOnServer.length && !different.length, checked, missingOnServer, different }
  }

  async conflictLog(): Promise<ConflictLog[]> {
    return this.meta.conflicts.orderBy('at').toArray()
  }
}
