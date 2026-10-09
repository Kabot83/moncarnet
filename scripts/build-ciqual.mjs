// Génère le catalogue nutritionnel local à partir de la table officielle CIQUAL 2025 (ANSES).
//
//   node scripts/build-ciqual.mjs [chemin du fichier .xlsx]
//
// Source : https://ciqual.anses.fr/ — « Table Ciqual 2025_FR_2025_11_03.xlsx »
// Licence Ouverte (Etalab). Mention obligatoire :
//   « Anses. 2025. Table de composition nutritionnelle des aliments Ciqual »
//
// Les valeurs ne sont PAS modifiées : un nombre reste un nombre (virgule → point),
// « traces » reste « traces », « < x » reste « < x », et un tiret (valeur inconnue)
// devient null — jamais zéro, conformément à la documentation officielle (§ 3.2.2).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import JSZip from 'jszip'

const input = process.argv[2] ?? 'scripts/sources/ciqual2025_FR.xlsx'
const output = 'src/data/ciqual-2025.json'

/** Colonnes retenues (intitulés officiels, retours à la ligne normalisés). */
const COLUMNS = {
  kcal: 'Energie, Règlement UE N° 1169 2011 (kcal 100 g)',
  kj: 'Energie, Règlement UE N° 1169 2011 (kJ 100 g)',
  protein: 'Protéines, N x 6.25 (g 100 g)',
  carbs: 'Glucides (g 100 g)',
  fat: 'Lipides (g 100 g)',
  fiber: 'Fibres alimentaires (g 100 g)',
  sugars: 'Sucres (g 100 g)',
  satFat: 'AG saturés (g 100 g)',
  salt: 'Sel chlorure de sodium (g 100 g)',
}

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')

const buf = readFileSync(input)
const zip = await JSZip.loadAsync(buf)
const shared = []
const ss = await zip.file('xl/sharedStrings.xml')?.async('string')
if (ss)
  for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>/g))
    shared.push(decode([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')))

const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string')
const colIndex = (ref) => {
  const letters = ref.replace(/\d+/g, '')
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}
const rows = []
for (const row of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
  const cells = []
  for (const c of row[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, ref, attrs, inner = ''] = c
    const type = /t="([^"]+)"/.exec(attrs)?.[1]
    let value = null
    const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
    if (type === 's') value = shared[Number(v)]
    else if (type === 'inlineStr') value = decode([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))
    else if (v != null) value = decode(v)
    cells[colIndex(ref)] = value
  }
  rows.push(cells)
}

const header = rows[0].map((h) => String(h ?? '').replace(/\s+/g, ' ').trim())
const idx = (name) => {
  const i = header.indexOf(name)
  if (i < 0) throw new Error(`Colonne introuvable : « ${name} »`)
  return i
}
const keys = Object.keys(COLUMNS)
const valueIdx = keys.map((k) => idx(COLUMNS[k]))
const [iCode, iName, iGrp, iSsgrp] = ['alim_code', 'alim_nom_fr', 'alim_grp_nom_fr', 'alim_ssgrp_nom_fr'].map(idx)

/** Valeur brute → nombre | null (tiret) | "t" (traces) | "<x" (sous le seuil). */
function convert(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '-' || s === '') return null
  if (s === 'traces') return 't'
  const lt = /^<\s*(\d+(?:[.,]\d+)?)$/.exec(s)
  if (lt) return `<${Number(lt[1].replace(',', '.'))}`
  const n = Number(s.replace(',', '.'))
  if (!Number.isFinite(n)) throw new Error(`Valeur non reconnue : « ${s} »`)
  return n
}

const groups = []
const groupOf = (g, sg) => {
  const label = [g, sg].filter((x) => x && x !== '-').join(' › ')
  let i = groups.indexOf(label)
  if (i < 0) i = groups.push(label) - 1
  return i
}
const foods = rows
  .slice(1)
  .filter((r) => r[iCode] != null && r[iName])
  .map((r) => [String(r[iCode]).trim(), String(r[iName]).trim(), groupOf(r[iGrp], r[iSsgrp]), ...valueIdx.map((i) => convert(r[i]))])

const catalog = {
  format: 'mon-carnet-ciqual',
  edition: 'Ciqual 2025',
  file: 'Table Ciqual 2025_FR_2025_11_03.xlsx',
  sha256: createHash('sha256').update(buf).digest('hex'),
  publishedAt: '2025-11-03',
  url: 'https://ciqual.anses.fr/',
  doi: 'https://doi.org/10.57745/RDMHWY',
  license: 'Licence Ouverte (Etalab)',
  citation: 'Anses. 2025. Table de composition nutritionnelle des aliments Ciqual',
  basis: 'pour 100 g de partie comestible',
  nutrients: keys,
  conventions: { null: 'valeur inconnue (tiret)', t: 'traces', '<x': 'inférieur au seuil x' },
  groups,
  foods,
}
writeFileSync(output, JSON.stringify(catalog))
console.log(`${foods.length} aliments, ${groups.length} groupes → ${output} (${Math.round(JSON.stringify(catalog).length / 1024)} Ko)`)
