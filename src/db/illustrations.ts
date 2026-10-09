/**
 * Illustrations temporaires des recettes de démonstration (SVG générés,
 * aucun fichier externe). Elles sont stockées comme de vraies photos et
 * disparaissent avec les données de démonstration.
 */

interface Motif {
  bg: string
  plate: string
  base: string
  pieces: Array<{ cx: number; cy: number; r: number; fill: string; rx?: number; rot?: number }>
  garnish?: string
  label: string
}

const MOTIFS: Record<string, Motif> = {
  jarret: {
    bg: '#E9DCC8',
    plate: '#F8F3EA',
    base: '#7A3B22',
    label: 'Jarret mijoté',
    garnish: '#6E8B5E',
    pieces: [
      { cx: 380, cy: 300, r: 95, fill: '#5E2A17', rx: 120, rot: -15 },
      { cx: 380, cy: 300, r: 32, fill: '#E8D3B0' },
      { cx: 270, cy: 230, r: 26, fill: '#D8722F' },
      { cx: 500, cy: 380, r: 24, fill: '#D8722F' },
      { cx: 300, cy: 390, r: 20, fill: '#C9A46A' },
      { cx: 480, cy: 220, r: 18, fill: '#C9A46A' },
    ],
  },
  cottage: {
    bg: '#DDE3D3',
    plate: '#F4EEE2',
    base: '#E7C27B',
    label: 'Cottage pie',
    garnish: '#5F7A4F',
    pieces: [
      { cx: 330, cy: 260, r: 60, fill: '#F0D59A' },
      { cx: 440, cy: 250, r: 55, fill: '#EBCB86' },
      { cx: 390, cy: 350, r: 70, fill: '#F2DCA6' },
      { cx: 300, cy: 360, r: 40, fill: '#D9A757' },
      { cx: 480, cy: 350, r: 45, fill: '#D9A757' },
    ],
  },
  pancakes: {
    bg: '#F1E3CF',
    plate: '#FBF7F0',
    base: '#D9A25A',
    label: 'Pancakes',
    garnish: '#7C2D3A',
    pieces: [
      { cx: 380, cy: 300, r: 130, fill: '#C98A43' },
      { cx: 380, cy: 290, r: 112, fill: '#DDA65E' },
      { cx: 380, cy: 280, r: 40, fill: '#F6E7B8' },
      { cx: 300, cy: 220, r: 14, fill: '#5A2A6E' },
      { cx: 460, cy: 230, r: 14, fill: '#5A2A6E' },
      { cx: 440, cy: 360, r: 14, fill: '#B3263E' },
      { cx: 320, cy: 350, r: 14, fill: '#B3263E' },
    ],
  },
  poulet: {
    bg: '#E6D9C3',
    plate: '#F7F1E6',
    base: '#B86B2F',
    label: 'Poulet rôti',
    garnish: '#6B8A57',
    pieces: [
      { cx: 380, cy: 290, r: 105, fill: '#A65421', rx: 135, rot: 10 },
      { cx: 370, cy: 280, r: 70, fill: '#C9792E', rx: 95, rot: 10 },
      { cx: 250, cy: 400, r: 30, fill: '#E3A44A' },
      { cx: 520, cy: 390, r: 28, fill: '#D45B2C' },
      { cx: 520, cy: 200, r: 26, fill: '#E3A44A' },
      { cx: 240, cy: 200, r: 24, fill: '#D45B2C' },
    ],
  },
  chocolat: {
    bg: '#E8D7D0',
    plate: '#FAF5EF',
    base: '#3B2119',
    label: 'Fondant chocolat',
    garnish: '#E9DCC0',
    pieces: [
      { cx: 380, cy: 300, r: 140, fill: '#2E1A13' },
      { cx: 380, cy: 300, r: 118, fill: '#45281D' },
      { cx: 350, cy: 260, r: 22, fill: '#F3E9DC' },
      { cx: 420, cy: 330, r: 14, fill: '#F3E9DC' },
    ],
  },
  crepes: {
    bg: '#F3E6D2',
    plate: '#FBF7F0',
    base: '#E8C07A',
    label: 'Crêpes',
    garnish: '#C0563A',
    pieces: [
      { cx: 380, cy: 300, r: 150, fill: '#E9BE72' },
      { cx: 380, cy: 300, r: 150, fill: '#F0CD8B', rx: 150, rot: 0 },
      { cx: 330, cy: 250, r: 18, fill: '#D29B4E' },
      { cx: 440, cy: 270, r: 12, fill: '#D29B4E' },
      { cx: 390, cy: 360, r: 15, fill: '#D29B4E' },
      { cx: 470, cy: 360, r: 22, fill: '#C0563A' },
    ],
  },
}

export function demoIllustration(key: keyof typeof MOTIFS): string {
  const m = MOTIFS[key]
  const pieces = m.pieces
    .map((p) =>
      p.rx
        ? `<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.r}" fill="${p.fill}" transform="rotate(${p.rot ?? 0} ${p.cx} ${p.cy})"/>`
        : `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="${p.fill}"/>`,
    )
    .join('')
  const leaves = m.garnish
    ? [
        [230, 290, -30],
        [540, 300, 40],
        [380, 140, 0],
        [400, 460, 15],
      ]
        .map(([x, y, r]) => `<ellipse cx="${x}" cy="${y}" rx="16" ry="7" fill="${m.garnish}" transform="rotate(${r} ${x} ${y})"/>`)
        .join('')
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 600" width="760" height="600">
<defs>
<radialGradient id="g" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></radialGradient>
<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#3b2a1e" flood-opacity=".22"/></filter>
<pattern id="lin" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M0 9h18M9 0v18" stroke="#000" stroke-opacity=".035" stroke-width="2"/></pattern>
</defs>
<rect width="760" height="600" fill="${m.bg}"/><rect width="760" height="600" fill="url(#lin)"/>
<rect x="560" y="-40" width="120" height="700" fill="#fff" fill-opacity=".18" transform="rotate(14 620 300)"/>
<g filter="url(#s)"><circle cx="380" cy="300" r="230" fill="${m.plate}"/></g>
<circle cx="380" cy="300" r="185" fill="none" stroke="#000" stroke-opacity=".05" stroke-width="2"/>
<circle cx="380" cy="300" r="170" fill="${m.base}" fill-opacity=".18"/>
${pieces}${leaves}
<circle cx="380" cy="300" r="230" fill="url(#g)"/>
</svg>`
}

export type DemoKey = keyof typeof MOTIFS
