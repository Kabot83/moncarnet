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

describe('partage Android → Mon Carnet', () => {
  it('cible de partage texte, file persistante, aucun partage perdu au démarrage', () => {
    const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf-8')
    expect(manifest).toMatch(/<action android:name="android\.intent\.action\.SEND" \/>\s*<category android:name="android\.intent\.category\.DEFAULT" \/>\s*<data android:mimeType="text\/plain" \/>/)
    expect(manifest).toContain('android:launchMode="singleTask"')
    const main = readFileSync('android/app/src/main/java/fr/kabot83/moncarnet/MainActivity.java', 'utf-8')
    // Mise en file AVANT super.onCreate (démarrage à froid) et dans onNewIntent (application ouverte).
    expect(main.indexOf('consumeShareIntent(getIntent())')).toBeLessThan(main.indexOf('super.onCreate(savedInstanceState)'))
    expect(main).toMatch(/onNewIntent[\s\S]*consumeShareIntent\(intent\)[\s\S]*notifyShare\(\)/)
    expect(main).toContain('registerPlugin(ShareReceiverPlugin.class)')
    const plugin = readFileSync('android/app/src/main/java/fr/kabot83/moncarnet/ShareReceiverPlugin.java', 'utf-8')
    expect(plugin).toContain('.commit()') // écriture synchrone sur le disque
    expect(plugin).toMatch(/notifyListeners\("shareReceived", new JSObject\(\), true\)/) // conservé si l'interface n'écoute pas encore
    expect(plugin).toMatch(/public void ack\(/)
  })
})

describe('sauvegarde Android (Auto Backup)', () => {
  it('gros fichiers et jeton exclus du cloud (limite de 25 Mo), base des recettes incluse', () => {
    const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf-8')
    expect(manifest).toContain('android:fullBackupContent="@xml/backup_rules"')
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"')
    for (const f of ['backup_rules.xml', 'data_extraction_rules.xml']) {
      const xml = readFileSync(`android/app/src/main/res/xml/${f}`, 'utf-8')
      expect(xml).toContain('<exclude domain="file" path="carnet-videos/" />')
      expect(xml).toContain('<exclude domain="file" path="securite/" />')
      expect(xml).toContain('<exclude domain="sharedpref" path="carnet_media.xml" />')
      expect(xml).toContain('<exclude domain="sharedpref" path="carnet_sync.xml" />') // session Carnet Sync : clé liée au téléphone
      expect(xml).not.toMatch(/domain="(root|database)"/) // la base de la WebView reste sauvegardée
      expect(xml).not.toMatch(/<include /) // aucune liste blanche : tout le reste est sauvegardé
    }
    // Liste EXACTE des exclusions : toute exclusion ajoutée par erreur fait échouer ce test.
    const excludes = (xml: string) => [...xml.matchAll(/<exclude domain="(\w+)" path="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`)
    expect(excludes(readFileSync('android/app/src/main/res/xml/backup_rules.xml', 'utf-8'))).toEqual(['file:carnet-videos/', 'file:securite/', 'sharedpref:carnet_media.xml', 'sharedpref:carnet_sync.xml'])
    const rules = readFileSync('android/app/src/main/res/xml/data_extraction_rules.xml', 'utf-8')
    const cloud = rules.slice(rules.indexOf('<cloud-backup>'), rules.indexOf('</cloud-backup>'))
    const transfer = rules.slice(rules.indexOf('<device-transfer>'), rules.indexOf('</device-transfer>'))
    expect(excludes(cloud)).toEqual(['file:carnet-videos/', 'file:securite/', 'sharedpref:carnet_media.xml', 'sharedpref:carnet_sync.xml'])
    expect(excludes(transfer)).toEqual(['sharedpref:carnet_media.xml', 'sharedpref:carnet_sync.xml']) // transfert direct : vidéos conservées
    // Données essentielles jamais exclues : base de la WebView (app_webview), file des partages, préférences.
    for (const xml of [rules, readFileSync('android/app/src/main/res/xml/backup_rules.xml', 'utf-8')]) {
      expect(xml).not.toMatch(/app_webview|IndexedDB|moncarnet_shares|CapacitorStorage/)
    }
  })

  it('Carnet Sync : session native chiffrée, HTTPS seul, aucun journal, plugin enregistré', () => {
    const java = readFileSync('android/app/src/main/java/fr/kabot83/moncarnet/CarnetSyncPlugin.java', 'utf-8')
    expect(java).toContain('AndroidKeyStore')
    expect(java).toContain('AES/GCM/NoPadding')
    expect(java).toContain('"carnet_sync_session_key"') // clé distincte de Carnet Media
    expect(java).toContain('instanceof HttpsURLConnection')
    expect(java).toContain('setInstanceFollowRedirects(false)')
    expect(java).not.toMatch(/Log\.|printStackTrace|TrustManager|HostnameVerifier|setSSLSocketFactory/) // ni journal, ni exception de confiance
    expect(java).not.toMatch(/putString\("password"/) // le mot de passe n'est jamais enregistré
    expect(readFileSync('android/app/src/main/java/fr/kabot83/moncarnet/MainActivity.java', 'utf-8')).toContain('registerPlugin(CarnetSyncPlugin.class)')
  })
})
