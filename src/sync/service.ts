/**
 * Synchronisation familiale : orchestration dans l'application (session, migration, automatisme).
 *
 * Automatique, sans bouton à presser :
 * - à l'ouverture, au retour au premier plan, au retour du réseau ;
 * - quelques secondes après chaque modification locale ;
 * - toutes les 5 minutes tant que l'application est ouverte ;
 * - une dernière tentative quand l'application passe en arrière-plan (Android peut l'interrompre :
 *   rien n'est perdu, l'envoi reprend à la prochaine ouverture).
 * Android ne garantit aucune exécution quand l'application est fermée : aucune synchronisation
 * « permanente » n'est promise. Les modifications restent sur le téléphone tant qu'elles ne sont
 * pas confirmées par le serveur.
 */
import type { CarnetDB } from '@/db/db'
import { type SessionBackend, SessionError, type SessionUser } from '@/platform/carnetSync'
import { httpSyncApi, type Me, type Space, type SyncApi, SyncHttpError } from './api'
import { migrationSummary } from './account'
import { localDbName, readBinding, signIn, signOut, writeBinding } from './binding'
import { OWNER_SETTING, SYNCED, SyncAccountError, SyncEngine, type SyncReport, trackDeletions } from './engine'
import { runInitialMigration } from './migration'

/** Même clé que services/recipes (NEW_RECIPE_SPACE_KEY), sans dépendance circulaire. */
const NEW_RECIPE_SPACE_KEY = 'syncNewRecipeSpace'

export type SyncStatus =
  | 'unavailable' // hors application Android
  | 'signed-out'
  | 'needs-migration' // connecté, premier envoi à confirmer
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'revoked' // session expirée ou révoquée : mot de passe à saisir de nouveau

export interface SyncState {
  status: SyncStatus
  url: string
  user: SessionUser | null
  family: Me['family']
  lastSyncAt: number | null
  lastError: string | null
  /** Modifications locales pas encore confirmées par le serveur. */
  pending: number
  synced: { family: number; personal: number }
  /** Conflits familiaux à résoudre. */
  conflicts: number
  /** Migration initiale vérifiée (null : pas encore faite ou interrompue). */
  migration: { at: number; ok: boolean; checked: number; issues: string[] } | null
  /** Message ponctuel (retrait de la famille, recettes récupérées…). */
  notice: string | null
  /** Recettes de démonstration : jamais synchronisées (restent sur ce téléphone). */
  localOnly: number
  /** Recettes reçues d'autres utilisateurs, en attente de décision. */
  received: number
}

const STATE_KEY = 'syncState'
const AUTO_INTERVAL = 5 * 60_000
const LOCAL_DEBOUNCE = 3_000

export interface SyncServiceDeps {
  backend: SessionBackend
  db: CarnetDB
  /** Change de base locale (compte) : recharge l'application. */
  reload: () => void
  fetchImpl?: typeof fetch
  device?: string
  now?: () => number
  /** Désactive minuteries et écouteurs (tests). */
  manual?: boolean
}

const isNetworkError = (e: unknown) => e instanceof TypeError || (e instanceof SessionError && e.code === 'network') || (e instanceof SyncHttpError && e.status >= 502)

export class SyncService {
  state: SyncState = {
    status: 'signed-out', url: '', user: null, family: null, lastSyncAt: null, lastError: null,
    pending: 0, synced: { family: 0, personal: 0 }, conflicts: 0, migration: null, notice: null, localOnly: 0, received: 0,
  }
  private listeners = new Set<(s: SyncState) => void>()
  private access: { token: string; exp: number } | null = null
  private apiInst: SyncApi | null = null
  private engineInst: SyncEngine | null = null
  private running: Promise<SyncReport | null> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private cleanup: (() => void)[] = []
  private now: () => number

  constructor(private deps: SyncServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  // --- État -------------------------------------------------------------------

  subscribe(fn: (s: SyncState) => void): () => void {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l(this.state)
  }

  private async persist(patch: Partial<Pick<SyncState, 'lastSyncAt' | 'migration'>>) {
    const cur = ((await this.deps.db.settings.get(STATE_KEY))?.value ?? {}) as Record<string, unknown>
    await this.deps.db.settings.put({ key: STATE_KEY, value: { ...cur, ...patch } })
  }

  get api(): SyncApi {
    if (!this.apiInst) throw new SessionError('no_session', 'Non connecté.')
    return this.apiInst
  }

  get engine(): SyncEngine {
    this.engineInst ??= new SyncEngine(this.deps.db, this.api, { deviceLabel: this.deps.device })
    return this.engineInst
  }

  /** Jeton d'accès en mémoire seulement ; renouvelé par la partie native (jeton chiffré). */
  private tokens = {
    access: async () => {
      if (this.access && this.access.exp - 60 > this.now() / 1000) return this.access.token
      return this.tokens.refresh()
    },
    refresh: async () => {
      try {
        const s = await this.deps.backend.refresh()
        this.access = { token: s.accessToken, exp: s.expiresAt }
        return s.accessToken
      } catch (e) {
        if (e instanceof SessionError && (e.code === 'session_revoked' || e.code === 'no_session')) this.revoked()
        throw e
      }
    },
  }

  private makeApi(url: string) {
    this.apiInst = httpSyncApi(url, this.tokens, this.deps.fetchImpl)
    this.engineInst = null
  }

  private revoked() {
    this.access = null
    this.stopAuto()
    this.set({ status: 'revoked', lastError: 'Session expirée ou révoquée : saisissez de nouveau votre mot de passe. Vos données restent sur ce téléphone.' })
  }

  // --- Démarrage, connexion ------------------------------------------------------

  async init(): Promise<void> {
    const { backend, db } = this.deps
    if (!backend.available) return this.set({ status: 'unavailable' })
    const saved = ((await db.settings.get(STATE_KEY))?.value ?? {}) as Partial<SyncState>
    this.set({ lastSyncAt: saved.lastSyncAt ?? null, migration: saved.migration ?? null })
    const session = await backend.getSession()
    const binding = readBinding()
    if (!session.configured || !session.user) {
      if (binding.currentUserId) return this.set({ status: 'revoked', url: session.url, lastError: 'Session expirée : reconnectez-vous pour reprendre la synchronisation.' })
      return this.set({ status: 'signed-out', url: session.url })
    }
    this.set({ url: session.url, user: session.user })
    this.makeApi(session.url)
    await this.afterSession(session.user)
  }

  async login(url: string, login: string, password: string): Promise<'ok' | 'needs-migration' | 'switching'> {
    const s = await this.deps.backend.login(url, login, password, this.deps.device ?? 'Android')
    this.access = { token: s.accessToken, exp: s.expiresAt }
    this.set({ url, user: s.user, lastError: null })
    this.makeApi(url)
    return this.afterSession(s.user)
  }

  /** Session valide : bonne base locale pour ce compte, puis migration ou synchronisation. */
  private async afterSession(user: SessionUser): Promise<'ok' | 'needs-migration' | 'switching'> {
    const { db } = this.deps
    const b = readBinding()
    const nb = b.currentUserId === user.id ? b : signIn(b, user.id)
    if (nb !== b) writeBinding(nb)
    if (localDbName(nb) !== db.name) {
      // Autre compte : sa propre base (l'actuelle reste intacte, invisible tant qu'il n'est pas reconnecté).
      this.set({ status: 'idle' })
      this.deps.reload()
      return 'switching'
    }
    trackDeletions(db)
    const owner = (await db.settings.get(OWNER_SETTING))?.value
    if (owner && owner !== user.id) {
      this.set({ status: 'error', lastError: 'Ce carnet appartient à un autre compte : synchronisation refusée. Déconnectez-vous.' })
      return 'ok'
    }
    if (!owner) {
      if ((await migrationSummary(db)).hasPersonalData) {
        this.set({ status: 'needs-migration' })
        return 'needs-migration'
      }
      await this.engine.bindToAccount() // carnet vide : rien à migrer, réception du catalogue
    }
    this.set({ status: 'idle' })
    this.startAuto()
    void this.syncNow('ouverture')
    return 'ok'
  }

  // --- Migration initiale ----------------------------------------------------------

  async migrate(share: string[], backup: () => Promise<unknown>): Promise<SyncState['migration']> {
    this.set({ status: 'syncing', lastError: null })
    try {
      const { verified } = await runInitialMigration(this.engine, { share, backup })
      const migration = { at: this.now(), ok: verified.ok, checked: verified.checked, issues: [...verified.missingOnServer, ...verified.different].slice(0, 20) }
      await this.persist({ migration, lastSyncAt: this.now() })
      this.set({ migration, lastSyncAt: this.now(), status: 'idle', family: this.engine.lastMe?.family ?? null })
      await this.updateDefaults()
      this.startAuto()
      await this.refreshCounters()
      return migration
    } catch (e) {
      this.fail(e)
      throw e
    }
  }

  /** Migration interrompue (coupure) : reprise sans doublon, puis vérification. */
  async resumeMigration(): Promise<SyncState['migration']> {
    const r = await this.syncNow('reprise')
    if (!r) return this.state.migration
    const v = await this.engine.verify()
    const migration = { at: this.now(), ok: v.ok, checked: v.checked, issues: [...v.missingOnServer, ...v.different].slice(0, 20) }
    await this.persist({ migration })
    this.set({ migration })
    return migration
  }

  // --- Synchronisation ---------------------------------------------------------------

  private canSync() {
    return ['idle', 'offline', 'error', 'syncing'].includes(this.state.status) && !!this.apiInst
  }

  /** Synchronise maintenant (une seule à la fois). Ne lève jamais : l'état décrit le résultat. */
  syncNow(_reason = 'manuel'): Promise<SyncReport | null> {
    if (!this.canSync()) return Promise.resolve(null)
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<SyncReport | null> {
    this.set({ status: 'syncing' })
    try {
      const report = await this.engine.sync()
      if (report.rejected.length) {
        // Jamais de « réussie » si le serveur a refusé un élément : il reste en attente, signalé.
        const r = report.rejected[0]
        throw new Error(`Le serveur a refusé ${report.rejected.length} élément(s) (${r.collection} « ${r.id} » : ${r.error}). Ils restent sur ce téléphone.`)
      }
      this.failures = 0
      const at = this.now()
      await this.persist({ lastSyncAt: at })
      const notice = report.removedFromFamily
        ? `Vous ne faites plus partie de la famille : ${report.removedFromFamily} recette(s) familiale(s) retirée(s) de ce téléphone.`
        : report.recovered.length
          ? 'Des éléments absents de ce téléphone ont été récupérés depuis le serveur.'
          : this.state.notice
      this.set({ status: 'idle', lastSyncAt: at, lastError: null, family: this.engine.lastMe?.family ?? null, notice })
      await this.updateDefaults()
      await this.refreshCounters()
      // Modifications faites pendant l'envoi : nouvel envoi aussitôt.
      if (this.state.pending > 0) this.schedule(1_000)
      return report
    } catch (e) {
      this.fail(e)
      return null
    }
  }

  private fail(e: unknown) {
    if (this.state.status === 'revoked') return
    if (e instanceof SyncAccountError) return this.set({ status: 'error', lastError: e.message })
    this.failures++
    if (isNetworkError(e)) this.set({ status: 'offline', lastError: 'Hors connexion : vos modifications sont gardées sur ce téléphone et seront envoyées au retour du réseau.' })
    else this.set({ status: 'error', lastError: e instanceof Error ? e.message : 'Erreur de synchronisation.' })
    this.schedule(Math.min(15 * 60_000, 30_000 * 2 ** Math.min(this.failures - 1, 5)))
  }

  /**
   * Nouvelles recettes : TOUJOURS privées (carnet personnel, synchronisé entre ses appareils).
   * Le réglage « familiales par défaut » des versions 1.5.x est retiré ; les recettes déjà
   * familiales restent inchangées.
   */
  private async updateDefaults() {
    await this.deps.db.settings.delete(NEW_RECIPE_SPACE_KEY)
  }

  async refreshCounters(): Promise<void> {
    if (!this.apiInst) return
    const [pending, synced, localOnly] = await Promise.all([this.engine.countPending(), this.engine.syncedCounts(), this.deps.db.recipes.filter((r) => !!r.isDemo).count()])
    let { conflicts, received } = this.state
    if (this.state.status !== 'offline') {
      if (this.state.family) conflicts = await this.api.familyConflicts().then((c) => c.length, () => conflicts)
      received = await this.api.inbox().then((x) => x.filter((t) => t.kind === 'recipe').length, () => received)
    }
    this.set({ pending, synced, conflicts, localOnly, received })
  }

  /** Synchronisation différée (regroupe les modifications rapprochées). */
  schedule(delay: number) {
    if (this.deps.manual) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.syncNow('automatique')
    }, delay)
  }

  /** Modification locale (création, modification, suppression) : envoi quelques secondes après. */
  noteLocalChange() {
    if (this.running) return // écritures du moteur lui-même (ou modification pendant l'envoi : rattrapée ensuite)
    this.set({ pending: Math.max(1, this.state.pending) })
    this.schedule(LOCAL_DEBOUNCE)
  }

  private startAuto() {
    if (this.deps.manual || this.cleanup.length) return
    const { db } = this.deps
    const onChange = (_k: unknown, _o: unknown, trans: { on(e: 'complete', f: () => void): void }) => trans.on('complete', () => this.noteLocalChange())
    for (const coll of SYNCED) {
      const t = (db as unknown as Record<string, { hook(e: string, f: unknown): void; hook(e: string): { unsubscribe(f: unknown): void } }>)[coll]
      for (const ev of ['creating', 'updating', 'deleting']) {
        const fn = (...a: unknown[]) => void onChange(a[0], a[1], a[a.length - 1] as never)
        t.hook(ev, fn)
        this.cleanup.push(() => t.hook(ev).unsubscribe(fn))
      }
    }
    const wake = () => {
      this.failures = 0
      void this.syncNow('reprise')
    }
    const visible = () => {
      if (document.visibilityState === 'visible') wake()
      else if (this.state.pending > 0) void this.syncNow('arrière-plan') // dernière tentative, au mieux
    }
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', visible)
    const every = setInterval(() => document.visibilityState === 'visible' && void this.syncNow('périodique'), AUTO_INTERVAL)
    this.cleanup.push(
      () => window.removeEventListener('online', wake),
      () => document.removeEventListener('visibilitychange', visible),
      () => clearInterval(every),
    )
  }

  private stopAuto() {
    for (const f of this.cleanup.splice(0)) f()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  // --- Déconnexion -------------------------------------------------------------

  /**
   * Déconnexion : dernière synchronisation si possible, session fermée sur le serveur et effacée du
   * téléphone, puis ouverture d'un carnet vide. Le carnet du compte reste intact sur le téléphone,
   * invisible jusqu'à la reconnexion de ce compte.
   */
  async logout(): Promise<void> {
    if (this.state.pending > 0 && this.canSync()) await Promise.race([this.syncNow('déconnexion'), new Promise((r) => setTimeout(r, 10_000))])
    this.stopAuto()
    await this.deps.backend.logout(this.access?.token ?? null).catch(() => undefined)
    this.access = null
    this.apiInst = null
    this.engineInst = null
    await this.deps.db.settings.delete(NEW_RECIPE_SPACE_KEY)
    writeBinding(signOut(readBinding()))
    this.set({ status: 'signed-out', user: null, family: null })
    this.deps.reload()
  }

  dispose() {
    this.stopAuto()
  }

  // --- Catalogue familial (actions de l'interface) ------------------------------------

  // --- Partage avec un autre utilisateur (copie indépendante, après acceptation) ---------

  /**
   * Envoie la version ENREGISTRÉE SUR LE SERVEUR de la recette : elle est d'abord synchronisée ;
   * si ce n'est pas possible (hors connexion), rien n'est envoyé.
   */
  async shareRecipe(recipeId: string, login: string, includeTips: boolean): Promise<{ to: string }> {
    await this.syncNow('partage')
    if (!(await this.engine.isSynced(recipeId))) {
      throw new Error('La dernière version de cette recette n’est pas encore sur le serveur (connexion ?) : réessayez dans un instant.')
    }
    const who = await this.api.lookupUser(login.trim().toLowerCase())
    if (!who) throw new Error('Aucun utilisateur avec cet identifiant.')
    await this.api.sendTransfer(who.login, 'recipe', recipeId, includeTips)
    return { to: who.display_name }
  }

  /**
   * Décision sur une recette reçue : ajout (nouvelle recette), mise à jour de ma copie existante
   * (après confirmation dans l'interface), ou refus. Rien n'est jamais remplacé implicitement.
   */
  async decideReceived(transferId: string, choice: { kind: 'add' } | { kind: 'replace'; targetId: string } | { kind: 'decline' }): Promise<string | null> {
    if (choice.kind === 'decline') {
      await this.api.declineTransfer(transferId)
      await this.refreshCounters()
      return null
    }
    // Mes modifications locales en attente partent d'abord (aucune perte, aucun conflit inutile).
    if (choice.kind === 'replace') await this.syncNow('avant remplacement')
    const r = await this.api.acceptTransfer(transferId, choice.kind === 'replace' ? { mode: 'replace', targetId: choice.targetId } : undefined)
    await this.syncNow('recette reçue')
    return r.id
  }

  /**
   * Recette de démonstration → vraie recette (avec l'accord de l'utilisateur) : elle sera
   * synchronisée, dans l'espace choisi, avec ses photos.
   */
  async adoptDemoRecipe(id: string, space: Space): Promise<void> {
    const { db } = this.deps
    await db.transaction('rw', db.recipes, db.photos, async () => {
      const r = await db.recipes.get(id)
      if (!r?.isDemo) return
      for (const pid of [r.mainPhotoId, ...r.galleryPhotoIds, ...r.steps.map((x) => x.photoId)]) if (pid) await db.photos.update(pid, { isDemo: false })
      await db.recipes.update(id, { isDemo: false, space, source: r.source === 'Démonstration Mon Carnet' ? '' : r.source, updatedAt: this.now() })
    })
    await this.syncNow('recette adoptée')
  }

  async moveRecipe(id: string, to: Space): Promise<void> {
    await this.engine.moveRecipe(id, to, true) // confirmation déjà donnée dans l'interface
    await this.refreshCounters()
  }
}
