/**
 * Résolution manuelle des conflits familiaux.
 *
 * Le serveur a gardé la version enregistrée et conservé la proposition écartée ; pour chaque
 * désaccord (« ingredients[i2] », « title », « notes.tips »…), l'utilisateur choisit l'une ou
 * l'autre. Les autres modifications, déjà fusionnées, ne sont pas touchées.
 */
type Row = Record<string, unknown>

export interface ConflictItem {
  path: string
  theirs: unknown
  mine: unknown
}

const ID_PATH = /^([A-Za-z0-9_]+)\[(.+)\]$/

/** Applique la valeur choisie pour un désaccord (null pour un élément supprimé). */
export function applyChoice(data: Row, path: string, value: unknown): Row {
  const m = ID_PATH.exec(path)
  if (m) {
    const [, key, id] = m
    const list = Array.isArray(data[key]) ? [...(data[key] as Row[])] : []
    const i = list.findIndex((x) => x?.id === id)
    if (value == null) {
      if (i >= 0) list.splice(i, 1)
    } else if (i >= 0) list[i] = value as Row
    else list.push(value as Row)
    return { ...data, [key]: list }
  }
  const keys = path.split('.')
  const out: Row = { ...data }
  let cur = out
  for (const k of keys.slice(0, -1)) {
    cur[k] = { ...((cur[k] as Row) ?? {}) }
    cur = cur[k] as Row
  }
  cur[keys[keys.length - 1]] = value
  return out
}

/** Version finale : la version actuelle, avec les propositions retenues. */
export function applyChoices(current: Row, items: ConflictItem[], takeProposal: boolean[]): Row {
  return items.reduce((d, it, i) => (takeProposal[i] ? applyChoice(d, it.path, it.mine) : d), current)
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Titre', description: 'Description', servings: 'Nombre de parts', prepTime: 'Préparation', cookTime: 'Cuisson', restTime: 'Repos',
  category: 'Catégorie', difficulty: 'Difficulté', source: 'Source', sourceUrl: 'Lien', 'notes.tips': 'Astuces', nutrition: 'Nutrition',
  cookedWeightG: 'Poids après cuisson', mainPhotoId: 'Photo principale',
}

/** Libellé lisible d'un désaccord. */
export function describePath(path: string, it: ConflictItem): string {
  const m = ID_PATH.exec(path)
  if (m) {
    const x = (it.theirs ?? it.mine) as Row | null
    if (m[1] === 'ingredients') return `Ingrédient « ${String(x?.name ?? '?')} »`
    if (m[1] === 'steps') return 'Étape de préparation'
    return m[1]
  }
  return FIELD_LABELS[path] ?? FIELD_LABELS[path.split('.')[0]] ?? path
}

/** Valeur lisible (ingrédient, étape, texte, nombre). */
export function describeValue(path: string, v: unknown): string {
  if (v == null) return '(supprimé)'
  const m = ID_PATH.exec(path)
  if (m && typeof v === 'object') {
    const x = v as Row
    if (m[1] === 'ingredients') return [x.quantity, x.unit, x.name].filter((p) => p != null && p !== '').join(' ')
    if (m[1] === 'steps') return String(x.text ?? '')
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
