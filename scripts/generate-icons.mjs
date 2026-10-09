// Génère les icônes PWA (PNG) à partir d'un SVG unique. Usage : npm run icons
// Avec --android : génère aussi les icônes et écrans de lancement de l'APK (dossier android/).
import sharp from 'sharp'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

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

if (process.argv.includes('--android')) {
  const res = 'android/app/src/main/res'
  if (!existsSync(res)) throw new Error('Dossier android/ absent : lancer d’abord « npx cap add android ».')
  const round = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="248" fill="#B85C38"/>${glyph(0.9)}</svg>`
  // Avant-plan adaptatif : 108 dp, logo dans la zone sûre centrale de 66 dp.
  const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${glyph(0.62)}</svg>`
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
  for (const [d, k] of Object.entries(densities)) {
    const dir = `${res}/mipmap-${d}`
    mkdirSync(dir, { recursive: true })
    await sharp(Buffer.from(any)).resize(Math.round(48 * k), Math.round(48 * k)).png().toFile(`${dir}/ic_launcher.png`)
    await sharp(Buffer.from(round)).resize(Math.round(48 * k), Math.round(48 * k)).png().toFile(`${dir}/ic_launcher_round.png`)
    await sharp(Buffer.from(foreground)).resize(Math.round(108 * k), Math.round(108 * k)).png().toFile(`${dir}/ic_launcher_foreground.png`)
  }
  // Écrans de lancement (Android 11 et antérieurs) : fond crème, logo centré.
  const splash = async (w, h, file) => {
    const size = Math.round(Math.min(w, h) * 0.32)
    const logo = await sharp(Buffer.from(any)).resize(size, size).png().toBuffer()
    await sharp({ create: { width: w, height: h, channels: 4, background: '#F7F2EA' } })
      .composite([{ input: logo, gravity: 'center' }])
      .png()
      .toFile(file)
  }
  const sizes = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] }
  for (const [d, [w, h]] of Object.entries(sizes)) {
    await splash(w, h, `${res}/drawable-port-${d}/splash.png`)
    await splash(h, w, `${res}/drawable-land-${d}/splash.png`)
  }
  await splash(480, 800, `${res}/drawable/splash.png`)
  console.log('Icônes Android générées dans android/app/src/main/res')
}
