// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/platform/native', () => ({ isNative: true }))

describe('clavier Android (événement natif)', () => {
  it('ouvre et ferme l’état clavier sur <html>, sans doublon', async () => {
    const { initKeyboard, isEditable } = await import('@/platform/keyboard')
    initKeyboard()
    const html = document.documentElement
    expect(html.dataset.keyboard).toBe('closed')
    window.dispatchEvent(new CustomEvent('mc-keyboard', { detail: { open: true } }))
    expect(html.dataset.keyboard).toBe('open')
    window.dispatchEvent(new CustomEvent('mc-keyboard', { detail: { open: true } }))
    expect(html.dataset.keyboard).toBe('open')
    window.dispatchEvent(new CustomEvent('mc-keyboard', { detail: { open: false } }))
    expect(html.dataset.keyboard).toBe('closed')

    const input = document.createElement('input')
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' })
    const area = document.createElement('textarea')
    expect(isEditable(input)).toBe(true)
    expect(isEditable(area)).toBe(true)
    expect(isEditable(box)).toBe(false)
    expect(isEditable(null)).toBe(false)
  })
})

describe('clavier dans le navigateur (PWA)', () => {
  it('ne confond pas barre d’adresse, rotation et clavier', async () => {
    const { webKeyboardOpen } = await import('@/platform/keyboard')
    expect(webKeyboardOpen(800, 480, true)).toBe(true) // clavier
    expect(webKeyboardOpen(800, 740, true)).toBe(false) // barre d'adresse
    expect(webKeyboardOpen(800, 480, false)).toBe(false) // pas de champ actif
  })
})
