import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { robotsAllows } from '@/importers/robots'
import { isNative, notificationId } from '@/platform/native'

describe('robots.txt (import par lien sur Android)', () => {
  it('respecte les interdictions, les autorisations plus précises et les groupes', () => {
    const txt = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /recettes/privees/\nAllow: /recettes/privees/publique\n'
    expect(robotsAllows(txt, '/recettes/tarte')).toBe(true)
    expect(robotsAllows(txt, '/recettes/privees/x')).toBe(false)
    expect(robotsAllows(txt, '/recettes/privees/publique-1')).toBe(true)
    expect(robotsAllows('User-agent: MonCarnet\nUser-agent: Autre\nDisallow: /\n', '/x')).toBe(false)
    expect(robotsAllows('User-agent: *\nDisallow:\n', '/x')).toBe(true)
    expect(robotsAllows('', '/x')).toBe(true)
  })
})

describe('plateforme', () => {
  it('le navigateur et les tests ne sont pas considérés comme natifs', () => {
    expect(isNative).toBe(false)
  })

  it('identifiants de notification stables, positifs et distincts', () => {
    expect(notificationId('t_abc')).toBe(notificationId('t_abc'))
    expect(notificationId('t_abc')).toBeGreaterThan(0)
    expect(notificationId('t_abc')).not.toBe(notificationId('t_abd'))
  })

  it('configuration Android : identifiant, nom, origine fixe pour conserver les données', () => {
    const cfg = readFileSync('capacitor.config.ts', 'utf-8')
    expect(cfg).toContain("appId: 'fr.kabot83.moncarnet'")
    expect(cfg).toContain("appName: 'Mon Carnet'")
    expect(cfg).toContain("androidScheme: 'https'")
    expect(cfg).toContain("hostname: 'localhost'")
    const gradle = readFileSync('android/app/build.gradle', 'utf-8')
    expect(gradle).toContain('applicationId "fr.kabot83.moncarnet"')
    expect(gradle).toContain('versionCode mcVersionCode')
    const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf-8')
    expect(manifest).toContain('android:screenOrientation="portrait"')
  })

  it('aucune barre de titre native : thème de lancement sain et EdgeToEdge après Capacitor', () => {
    const styles = readFileSync('android/app/src/main/res/values/styles.xml', 'utf-8')
    // Un « android:background » dans un thème s'applique à toutes les vues (barre de titre étirée).
    expect(styles).not.toMatch(/<item name="android:background">@drawable/)
    const launch = styles.slice(styles.indexOf('name="AppTheme.NoActionBarLaunch"'))
    expect(launch).toContain('<item name="android:windowNoTitle">true</item>')
    expect(launch).toContain('<item name="android:windowActionBar">false</item>')
    const main = readFileSync('android/app/src/main/java/fr/kabot83/moncarnet/MainActivity.java', 'utf-8')
    expect(main.indexOf('super.onCreate(savedInstanceState)')).toBeGreaterThan(-1)
    expect(main.indexOf('EdgeToEdge.enable(this)')).toBeGreaterThan(main.indexOf('super.onCreate(savedInstanceState)'))
  })
})
