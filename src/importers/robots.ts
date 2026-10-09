/**
 * Respect de robots.txt pour l'import par lien : si le site interdit la
 * récupération automatique d'une page, Mon Carnet ne la lit pas.
 */
export function robotsAllows(robotsTxt: string, path: string, agent = 'moncarnet'): boolean {
  let applies = false
  let inGroupHeader = false
  const disallow: string[] = []
  const allow: string[] = []
  for (const raw of robotsTxt.slice(0, 200_000).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    if (key === 'user-agent') {
      // Plusieurs lignes User-agent consécutives forment un même groupe.
      const match = value === '*' || value.toLowerCase().includes(agent)
      applies = inGroupHeader ? applies || match : match
      inGroupHeader = true
      continue
    }
    inGroupHeader = false
    if (!applies || !value) continue
    if (key === 'disallow') disallow.push(value.replace(/\*.*$/, '').replace(/\$$/, ''))
    if (key === 'allow') allow.push(value.replace(/\*.*$/, '').replace(/\$$/, ''))
  }
  // Règle la plus spécifique (préfixe le plus long) prioritaire, comme Google.
  const longest = (list: string[]) => Math.max(-1, ...list.filter((p) => path.startsWith(p)).map((p) => p.length))
  return longest(allow) >= longest(disallow)
}
