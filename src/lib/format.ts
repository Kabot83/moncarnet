/** Durée lisible : 95 → « 1 h 35 », 45 → « 45 min ». */
export function formatDuration(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min <= 0) return ''
  const m = Math.round(min)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h >= 24) {
    const d = Math.floor(h / 24)
    const rh = h % 24
    return rh ? `${d} j ${rh} h` : `${d} j`
  }
  return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`
}

export function totalTime(r: { prepTime: number | null; cookTime: number | null; restTime: number | null }): number {
  return (r.prepTime ?? 0) + (r.cookTime ?? 0) + (r.restTime ?? 0)
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
const shortFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' })

export function formatDate(ts: number | null | undefined, withYear = true): string {
  if (!ts) return ''
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return (withYear && !sameYear ? dateFmt : shortFmt).format(d)
}

/** « aujourd'hui », « hier », « il y a 3 semaines »… */
export function relativeDays(ts: number | null | undefined): string {
  if (!ts) return 'jamais'
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / 86_400_000)
  if (days <= 0) return "aujourd'hui"
  if (days === 1) return 'hier'
  if (days < 7) return `il y a ${days} jours`
  if (days < 30) {
    const w = Math.round(days / 7)
    return `il y a ${w} semaine${w > 1 ? 's' : ''}`
  }
  if (days < 365) return `il y a ${Math.round(days / 30)} mois`
  const y = Math.round(days / 365)
  return `il y a ${y} an${y > 1 ? 's' : ''}`
}

function startOfDay(ts: number) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Date locale au format AAAA-MM-JJ (compteur d'appels IA). */
export function localDay(ts = Date.now()): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} Ko`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} Mo`
  return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} Go`
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n > 1 ? plural : singular}`
}

/** Minuterie : 125 000 ms → « 2:05 », 3 725 000 → « 1:02:05 ». */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}
