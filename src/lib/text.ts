/** Normalise un texte pour la recherche : minuscules, sans accents, ligatures dépliées. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Mots significatifs d'une requête (au moins 2 caractères). */
export function tokens(query: string): string[] {
  return normalize(query)
    .split(/[\s,;]+/)
    .filter((t) => t.length >= 2)
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** Similarité très simple entre deux chaînes normalisées (pour les doublons). */
export function sameText(a: string, b: string): boolean {
  return normalize(a) === normalize(b)
}
