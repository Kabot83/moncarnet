/** Identifiant unique, lisible et triable par date de création. */
export function newId(prefix = ''): string {
  const time = Date.now().toString(36)
  const rand =
    typeof crypto !== 'undefined' && 'getRandomValues' in crypto
      ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10)
      : Math.random().toString(36).slice(2, 12)
  return `${prefix}${time}${rand}`
}
