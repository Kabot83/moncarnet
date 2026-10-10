// @vitest-environment jsdom
/** Lecture inerte du HTML renvoyé par l'oEmbed Instagram : seul un texte précis est lu, rien n'est exécuté ni inséré. */
import { describe, expect, it } from 'vitest'
import { instagramAuthorFromEmbed } from '@/social/meta'

describe('oEmbed Instagram', () => {
  it('auteur lu dans le texte, sans exécuter le HTML', () => {
    ;(globalThis as { __pwned?: boolean }).__pwned = false
    const html = '<blockquote><p><a href="x">A post shared by Chef Julie (@chef.julie)</a></p><script>globalThis.__pwned = true</script><img src=x onerror="globalThis.__pwned = true"></blockquote>'
    expect(instagramAuthorFromEmbed(html)).toBe('@chef.julie')
    expect((globalThis as { __pwned?: boolean }).__pwned).toBe(false)
    expect(instagramAuthorFromEmbed('<blockquote><a>View this post on Instagram</a></blockquote>')).toBeNull()
  })
})
