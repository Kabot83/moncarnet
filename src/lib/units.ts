/**
 * Unités, analyse et affichage des quantités.
 *
 * Principe : les valeurs internes ne sont JAMAIS arrondies. Seul l'affichage
 * arrondit, selon des règles pratiques en cuisine. Les conversions ne sont
 * faites qu'entre unités d'une même dimension (g ↔ kg, ml ↔ cl ↔ l), jamais
 * entre masse et volume.
 */

export type UnitKind = 'mass' | 'volume' | 'spoon' | 'count' | 'pinch' | 'other'

interface UnitDef {
  canonical: string
  kind: UnitKind
  /** Facteur vers l'unité de base de la dimension (g pour la masse, ml pour le volume). */
  toBase?: number
}

const UNIT_ALIASES: Array<[RegExp, UnitDef]> = [
  [/^(mg|milligrammes?)$/, { canonical: 'mg', kind: 'mass', toBase: 0.001 }],
  [/^(g|gr|grs|grammes?)$/, { canonical: 'g', kind: 'mass', toBase: 1 }],
  [/^(kg|kgs|kilos?|kilogrammes?)$/, { canonical: 'kg', kind: 'mass', toBase: 1000 }],
  [/^(ml|millilitres?)$/, { canonical: 'ml', kind: 'volume', toBase: 1 }],
  [/^(cl|centilitres?)$/, { canonical: 'cl', kind: 'volume', toBase: 10 }],
  [/^(dl|décilitres?|decilitres?)$/, { canonical: 'dl', kind: 'volume', toBase: 100 }],
  [/^(l|litres?)$/, { canonical: 'l', kind: 'volume', toBase: 1000 }],
  [
    /^(c\.? ?à\.? ?s\.?|cas|càs|c ?a ?s|cs|cuill?(e|è)res? à soupe|cuill?\.? à soupe|c\. à soupe|tbsp|tablespoons?)$/,
    { canonical: 'c. à soupe', kind: 'spoon' },
  ],
  [
    /^(c\.? ?à\.? ?c\.?|cac|càc|c ?a ?c|cc|cuill?(e|è)res? à café|cuill?\.? à café|c\. à café|tsp|teaspoons?)$/,
    { canonical: 'c. à café', kind: 'spoon' },
  ],
  [/^(pincées?|pinch(es)?)$/, { canonical: 'pincée', kind: 'pinch' }],
  [/^(tasses?|cups?|verres?|bols?)$/, { canonical: 'tasse', kind: 'spoon' }],
  [/^(pièces?|pcs?|unités?|u)$/, { canonical: '', kind: 'count' }],
  [/^(gousses?)$/, { canonical: 'gousse', kind: 'count' }],
  [/^(tranches?)$/, { canonical: 'tranche', kind: 'count' }],
  [/^(sachets?)$/, { canonical: 'sachet', kind: 'count' }],
  [/^(feuilles?)$/, { canonical: 'feuille', kind: 'count' }],
  [/^(brins?)$/, { canonical: 'brin', kind: 'count' }],
  [/^(bottes?)$/, { canonical: 'botte', kind: 'count' }],
  [/^(boîtes?|boites?|conserves?)$/, { canonical: 'boîte', kind: 'count' }],
  [/^(pots?)$/, { canonical: 'pot', kind: 'count' }],
  [/^(filets?)$/, { canonical: 'filet', kind: 'count' }],
]

export function normalizeUnit(raw: string | null | undefined): UnitDef {
  const u = (raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!u) return { canonical: '', kind: 'count' }
  for (const [re, def] of UNIT_ALIASES) if (re.test(u)) return def
  return { canonical: (raw ?? '').trim(), kind: 'other' }
}

export const unitKind = (unit: string) => normalizeUnit(unit).kind

/** Les deux unités sont-elles convertibles de manière fiable ? */
export function compatibleUnits(a: string, b: string): boolean {
  const da = normalizeUnit(a)
  const db = normalizeUnit(b)
  if (da.toBase && db.toBase) return da.kind === db.kind
  return da.canonical.toLowerCase() === db.canonical.toLowerCase()
}

/** Convertit vers l'unité de base (g ou ml) si possible, sinon `null`. */
export function toBaseUnit(quantity: number, unit: string): { value: number; unit: 'g' | 'ml' } | null {
  const d = normalizeUnit(unit)
  if (!d.toBase) return null
  return { value: quantity * d.toBase, unit: d.kind === 'mass' ? 'g' : 'ml' }
}

export const isEgg = (name: string) => /(?<!\p{L})(œufs?|oeufs?)(?!\p{L})/iu.test(name)

// ---------------------------------------------------------------------------
// Analyse des quantités saisies : « 1,5 », « 1/2 », « 1 ½ », « 2½ »…
// ---------------------------------------------------------------------------

const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 1 / 2,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 1 / 4,
  '¾': 3 / 4,
  '⅕': 1 / 5,
  '⅛': 1 / 8,
  '⅜': 3 / 8,
  '⅝': 5 / 8,
  '⅞': 7 / 8,
}

/**
 * Convertit un texte en nombre. Renvoie `null` si le texte n'est pas une
 * quantité numérique fiable (« quelques », « 2 à 3 »…).
 */
export function parseQuantity(input: string | number | null | undefined): number | null {
  if (input == null) return null
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null
  let s = input.trim().replace(/ /g, ' ')
  if (!s) return null
  // Fraction unicode isolée ou collée : « ½ », « 1½ », « 1 ½ »
  const uni = s.match(/^(\d+)?\s*([½⅓⅔¼¾⅕⅛⅜⅝⅞])$/)
  if (uni) return (uni[1] ? parseInt(uni[1], 10) : 0) + UNICODE_FRACTIONS[uni[2]]
  // Nombre mixte « 1 1/2 »
  const mixed = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/)
  if (mixed) {
    const den = parseInt(mixed[3], 10)
    return den === 0 ? null : parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / den
  }
  // Fraction simple « 3/4 »
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (frac) {
    const den = parseInt(frac[2], 10)
    return den === 0 ? null : parseInt(frac[1], 10) / den
  }
  // Décimal français ou anglais « 1,5 » / « 1.5 »
  s = s.replace(',', '.')
  if (/^\d+(\.\d+)?$|^\.\d+$/.test(s)) {
    const n = parseFloat(s)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Sépare une ligne d'ingrédient libre (« 200 g de farine T55 ») en
 * quantité / unité / nom. Utilisé par les imports (URL, texte).
 */
export function parseIngredientLine(line: string): {
  quantity: number | null
  unit: string
  name: string
  quantityText: string
} {
  const clean = line.replace(/\s+/g, ' ').replace(/^[-•*–]\s*/, '').trim()
  const m = clean.match(
    /^(\d+\s+\d+\/\d+|\d+\/\d+|\d*\s*[½⅓⅔¼¾⅛]|\d+(?:[.,]\d+)?)\s*(?:à\s*\d+(?:[.,]\d+)?\s*)?([a-zA-Zéèêàâîôûç.]+(?:\s(?:à|a)\s(?:soupe|café|cafe))?)?\.?\s*(?:d['’]\s*|de\s+|des\s+)?(.*)$/i,
  )
  if (!m) return { quantity: null, unit: '', name: clean, quantityText: '' }
  const quantity = parseQuantity(m[1])
  let unitRaw = (m[2] ?? '').trim()
  let name = (m[3] ?? '').trim()
  const def = normalizeUnit(unitRaw)
  if (unitRaw && def.kind === 'other') {
    // Le « mot unité » est en fait le début du nom (« 3 œufs »).
    name = `${unitRaw} ${name}`.trim()
    unitRaw = ''
  }
  return {
    quantity,
    unit: unitRaw ? def.canonical : '',
    name: name.replace(/^(de|d['’])\s*/i, '') || clean,
    quantityText: quantity == null ? m[1] : '',
  }
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

export type RoundingMode = 'precise' | 'practical'

const nf = (max: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: max, useGrouping: true })

export const formatNumber = (n: number, maxDecimals = 2) => nf(maxDecimals).format(n)

const roundTo = (n: number, step: number) => Math.round(n / step) * step

const FRACTION_GLYPHS: Array<[number, string]> = [
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [1 / 2, '½'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
]

/** 1,5 → « 1 ½ » ; 0,33 → « ⅓ ». Arrondit à la fraction usuelle la plus proche. */
export function toFractionString(n: number, allowed: number[] = [0, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1]): string {
  let whole = Math.floor(n)
  const rest = n - whole
  let best = allowed[0]
  for (const a of allowed) if (Math.abs(rest - a) < Math.abs(rest - best)) best = a
  if (best === 1) {
    whole += 1
    best = 0
  }
  if (whole === 0 && best === 0) return n > 0 ? formatNumber(n, 2) : '0'
  const glyph = FRACTION_GLYPHS.find(([v]) => Math.abs(v - best) < 1e-9)?.[1]
  if (!glyph) return String(whole)
  return whole === 0 ? glyph : `${whole} ${glyph}`
}

export interface DisplayOptions {
  rounding: RoundingMode
  allowHalfEggs?: boolean
  name?: string
}

export interface DisplayQuantity {
  /** Nombre formaté (« 133 », « 1 ½ », « 1,25 »). */
  value: string
  /** Unité éventuellement convertie (« kg » au lieu de « g » au-delà de 1000). */
  unit: string
  /** Valeur effectivement affichée, en nombre (pour comparer avec l'interne). */
  numeric: number
  /** Vrai si l'affichage s'écarte sensiblement de la valeur interne. */
  approximate: boolean
}

/**
 * Arrondi d'affichage, adapté à la cuisine.
 *
 * - Masses et volumes en mode « pratique » : 133,3 g → 135 g ; 7,3 g → 7,5 g ; 1 240 g → 1,25 kg.
 * - En mode « précis » : 133,3 g → 133 g ; 7,3 g → 7,3 g.
 * - Cuillères, tasses : fractions usuelles (¼, ⅓, ½, ⅔, ¾).
 * - Œufs : demi-œufs si autorisés, sinon entier le plus proche (jamais 0).
 * - Pièces : demi-unité.
 */
export function displayQuantity(q: number, unit: string, opts: DisplayOptions): DisplayQuantity {
  const def = normalizeUnit(unit)
  const practical = opts.rounding === 'practical'
  let value = q
  let outUnit = unit.trim()
  let text: string

  if (def.kind === 'mass' || def.kind === 'volume') {
    // Conversion fiable vers l'unité la plus lisible.
    const base = q * (def.toBase ?? 1)
    let internal = q
    const small = def.kind === 'mass' ? 'g' : 'ml'
    const big = def.kind === 'mass' ? 'kg' : 'l'
    if (def.canonical === 'cl' || def.canonical === 'dl' || def.canonical === 'mg') {
      // L'utilisateur a choisi une unité intermédiaire : on la respecte.
      const step = practical ? (q >= 10 ? 1 : 0.5) : 0.1
      value = roundTo(q, step)
      text = formatNumber(value, 1)
      internal = q
    } else if (base >= 1000) {
      const big1 = base / 1000
      value = practical ? roundTo(big1, 0.05) : roundTo(big1, 0.01)
      outUnit = big
      text = formatNumber(value, 2)
      internal = big1
    } else {
      outUnit = small
      let step: number
      if (practical) step = base < 10 ? 0.5 : base < 50 ? 1 : base < 250 ? 5 : 10
      else step = base < 10 ? 0.1 : 1
      value = roundTo(base, step)
      if (value === 0 && base > 0) value = step
      text = formatNumber(value, 1)
      internal = base
    }
    return { value: text, unit: outUnit, numeric: value, approximate: Math.abs(value - internal) / (internal || 1) > 0.005 }
  }

  if (def.kind === 'spoon') {
    text = toFractionString(q)
    const shown = parseQuantity(text) ?? q
    return { value: text, unit: def.canonical, numeric: shown, approximate: Math.abs(shown - q) > 0.02 }
  }

  if (def.kind === 'count' && opts.name && isEgg(opts.name)) {
    if (opts.allowHalfEggs !== false) {
      value = Math.max(0.5, roundTo(q, 0.5))
      text = toFractionString(value, [0, 1 / 2, 1])
    } else {
      value = Math.max(1, Math.round(q))
      text = String(value)
    }
    return { value: text, unit: outUnit, numeric: value, approximate: Math.abs(value - q) > 0.01 }
  }

  if (def.kind === 'count' || def.kind === 'pinch') {
    if (q < 10) {
      value = Math.max(0.25, roundTo(q, practical ? 0.5 : 0.25))
      text = toFractionString(value)
    } else {
      value = Math.round(q)
      text = formatNumber(value, 0)
    }
    return { value: text, unit: outUnit, numeric: value, approximate: Math.abs(value - q) > 0.01 }
  }

  // Unités inconnues : nombre décimal raisonnable, sans conversion.
  value = q >= 100 ? Math.round(q) : q >= 10 ? roundTo(q, 0.5) : roundTo(q, 0.05)
  text = formatNumber(value, 2)
  return { value: text, unit: outUnit, numeric: value, approximate: Math.abs(value - q) > 0.01 }
}

/** Accord simple de l'unité au pluriel pour l'affichage (« 2 gousses »). */
export function pluralizeUnit(unit: string, n: number): string {
  if (n < 2 || !unit) return unit
  const def = normalizeUnit(unit)
  if (def.kind === 'mass' || def.kind === 'volume' || def.kind === 'spoon') return unit
  if (/[sx]$/.test(unit)) return unit
  return `${unit}s`
}

// ---------------------------------------------------------------------------
// Incréments des boutons − / +
// ---------------------------------------------------------------------------

/** Pas d'incrément cohérent selon l'unité et l'ordre de grandeur (exprimé dans l'unité d'origine). */
export function stepFor(q: number, unit: string, name = ''): number {
  const def = normalizeUnit(unit)
  if (def.kind === 'count') {
    if (isEgg(name)) return 1
    return q < 2 ? 0.5 : 1
  }
  if (def.kind === 'pinch') return 1
  if (def.kind === 'spoon') return def.canonical === 'c. à café' ? 0.25 : 0.5
  if (def.kind === 'mass' || def.kind === 'volume') {
    const base = q * (def.toBase ?? 1)
    let stepBase: number
    if (base < 20) stepBase = 1
    else if (base < 100) stepBase = 5
    else if (base < 500) stepBase = 10
    else if (base < 2000) stepBase = 25
    else stepBase = 100
    return stepBase / (def.toBase ?? 1)
  }
  if (q < 1) return 0.25
  if (q < 10) return 0.5
  return Math.pow(10, Math.floor(Math.log10(q)) - 1) * 5
}

/**
 * Valeur suivante sur la grille d'incrément. Partant de 133,3 g avec un pas de
 * 10 : « + » donne 140, « − » donne 130. Renvoie `null` si on descendrait à 0.
 */
export function nextOnGrid(current: number, step: number, direction: 1 | -1): number | null {
  const EPS = 1e-9
  const k = current / step
  const next = direction === 1 ? (Math.floor(k + EPS) + 1) * step : (Math.ceil(k - EPS) - 1) * step
  if (next <= EPS) {
    // On autorise une dernière demi-marche pour ne jamais atteindre 0.
    const half = step / 2
    return direction === -1 && current - EPS > half ? half : null
  }
  // Corrige les erreurs binaires (0,1 + 0,2…).
  return Math.round(next * 1e9) / 1e9
}
