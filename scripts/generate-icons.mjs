// Génère les icônes PWA (PNG) à partir d'un SVG unique. Usage : npm run icons
import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'node:fs'

const glyph = (scale = 1) => {
  // Livre ouvert crème + feuille sauge, centré sur un canevas de 512.
  const s = scale
  const t = (x) => 256 + (x - 256) * s
  return `
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M${t(116)} ${t(170)} Q${t(186)} ${t(140)} ${t(256)} ${t(178)} L${t(256)} ${t(372)} Q${t(186)} ${t(336)} ${t(116)} ${t(366)} Z" fill="#F7F2EA"/>
    <path d="M${t(396)} ${t(170)} Q${t(326)} ${t(140)} ${t(256)} ${t(178)} L${t(256)} ${t(372)} Q${t(326)} ${t(336)} ${t(396)} ${t(366)} Z" fill="#FFFDF9"/>
    <path d="M${t(256)} ${t(178)} L${t(256)} ${t(372)}" stroke="#9D4A2A" stroke-width="${6 * s}"/>
    <path d="M${t(150)} ${t(206)} Q${t(196)} ${t(192)} ${t(232)} ${t(212)}M${t(150)} ${t(240)} Q${t(196)} ${t(226)} ${t(232)} ${t(246)}M${t(150)} ${t(274)} Q${t(196)} ${t(260)} ${t(232)} ${t(280)}" stroke="#D9B8A6" stroke-width="${7 * s}"/>
    <path d="M${t(300)} ${t(300)} Q${t(318)} ${t(232)} ${t(372)} ${t(214)} Q${t(374)} ${t(282)} ${t(300)} ${t(300)} Z" fill="#6C7F5F"/>
    <path d="M${t(304)} ${t(296)} L${t(352)} ${t(240)}" stroke="#E3E8DA" stroke-width="${5 * s}"/>
  </g>`
}

const any = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect x="16" y="16" width="480" height="480" rx="112" fill="#B85C38"/>${glyph(1)}</svg>`
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#B85C38"/>${glyph(0.78)}</svg>`

mkdirSync('public/icons', { recursive: true })
writeFileSync('public/icons/favicon.svg', any)
await sharp(Buffer.from(any)).resize(192, 192).png().toFile('public/icons/icon-192.png')
await sharp(Buffer.from(any)).resize(512, 512).png().toFile('public/icons/icon-512.png')
await sharp(Buffer.from(maskable)).resize(512, 512).png().toFile('public/icons/maskable-512.png')
await sharp(Buffer.from(any)).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png')
console.log('Icônes générées dans public/icons')
