"""Administration (dans le conteneur : Container Manager → Conteneur → carnet-sync → Terminal).

  python -m app.admin setup                     → premier compte + famille (interactif, mot de passe masqué)
  python -m app.admin user create               → autre compte (interactif) ; ou invite create --family
  python -m app.admin family show | family add <login> | family remove <login> | family role <login> admin|member
  python -m app.admin family privatize [--apply]  → copie privée de chaque recette familiale pour chaque membre
                                                  (simulation sans --apply ; rien n'est supprimé ni déplacé)
  python -m app.admin user list | user disable <login> | user reset-password <login>
  python -m app.admin invite create --note "…" [--family] → code d'invitation (7 jours, usage unique)
  python -m app.admin backup                    → sauvegarde immédiate (comme celle de la nuit)
  python -m app.admin status                    → état de la dernière sauvegarde, versions disponibles
  python -m app.admin verify <sauvegarde>       → relit et contrôle une sauvegarde
  python -m app.admin restore-test <sauvegarde> → restauration à blanc contrôlée (rien n'est modifié)
  python -m app.admin restore <sauvegarde>      → vérifie puis programme la restauration au redémarrage
                                                  (l'ancienne base est conservée à côté, jamais effacée)
  python -m app.admin check [--full]            → cohérence base ↔ fichiers photos
  python -m app.admin purge                     → invitations expirées, fichiers figés traités
  python -m app.admin selftest                  → essai réel : connexion, lecture, déconnexion (interactif)

Aucun mot de passe n'est généré, affiché ni journalisé : il est saisi deux fois, masqué.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from . import auth, spaces
from .backup import DB_FILE, check, create_backup, list_backups, request_restore, restore_test, rotate, verify_backup
from .config import Settings
from .db import Database, now
from .transfers import cleanup_frozen, expire_old


def _ask(prompt: str) -> str:
    print(prompt, end='', flush=True)
    return sys.stdin.readline().strip()


def _ask_password() -> str:
    """Saisie masquée (terminal) ; sans terminal (automatisation), deux lignes lues sur l'entrée."""
    for _ in range(3):
        if sys.stdin.isatty():
            pw = getpass.getpass('Mot de passe (10 caractères au moins, rien ne s’affiche) : ')
            pw2 = getpass.getpass('Confirmer le mot de passe : ')
        else:
            pw, pw2 = sys.stdin.readline().rstrip('\n'), sys.stdin.readline().rstrip('\n')
        if pw != pw2:
            print('Les deux saisies diffèrent, recommencez.')
            continue
        try:
            auth.check_password_strength(pw)
            return pw
        except auth.AuthError as e:
            print(e.message)
    raise SystemExit('Abandon : aucun compte modifié.')


def _create_user(db: Database, login: str | None, name: str | None) -> str:
    login = login or _ask('Identifiant de connexion (ex. alexandre) : ')
    try:
        login = auth.normalize_login(login)
    except auth.AuthError as e:
        raise SystemExit(e.message) from None
    if db.one('SELECT 1 FROM users WHERE login = ?', (login,)):
        raise SystemExit('Identifiant déjà utilisé.')
    name = name if name is not None else _ask('Nom affiché (ex. Alexandre) : ')
    pw = _ask_password()
    auth.create_user(db, login, name or login, pw)
    print(f'Compte « {login} » créé. Connectez-vous dans Mon Carnet avec ce mot de passe.')
    return login


def _selftest() -> None:
    """Essai de bout en bout par l'API du service en marche (comme le fera Mon Carnet)."""
    base = f"http://127.0.0.1:{os.environ.get('SYNC_PORT', '8090')}"

    def call(method: str, path: str, body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
        req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None)
        req.add_header('Content-Type', 'application/json')
        if token:
            req.add_header('Authorization', f'Bearer {token}')
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                raw = r.read()
                return r.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')

    print('1. Service :', 'en marche' if call('GET', '/v1/health')[0] == 200 else 'NE RÉPOND PAS')
    print('2. Accès sans session refusé :', 'oui' if call('GET', '/v1/sync/changes')[0] == 401 else 'NON (anomalie)')
    login = _ask('Identifiant : ')
    pw = getpass.getpass('Mot de passe (rien ne s’affiche) : ') if sys.stdin.isatty() else sys.stdin.readline().rstrip('\n')
    st, t = call('POST', '/v1/auth/login', {'login': login, 'password': pw, 'device': 'essai administrateur'})
    if st != 200:
        raise SystemExit(f"3. Connexion refusée : {t.get('message', st)}")
    st, me = call('GET', '/v1/me', token=t['access_token'])
    print(f"3. Connexion réussie : {me['user']['display_name']}")
    fam = me.get('family')
    print('   Catalogue familial :', f"{fam['name']} ({'administrateur' if fam['role'] == 'admin' else 'membre'}, {len(fam['members'])} membre(s))" if fam else 'aucun')
    st, ch = call('GET', '/v1/sync/changes?since=0&page_size=1', token=t['access_token'])
    print('4. Lecture du carnet :', 'oui' if st == 200 else f'NON ({st})')
    st, _ = call('POST', '/v1/auth/logout', token=t['access_token'])
    print('5. Session d’essai fermée :', 'oui' if st == 204 else f'NON ({st})')


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog='carnet-sync-admin')
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('setup')
    u = sub.add_parser('user').add_subparsers(dest='action', required=True)
    uc = u.add_parser('create')
    uc.add_argument('login', nargs='?')
    uc.add_argument('--name')
    u.add_parser('list')
    u.add_parser('disable').add_argument('login')
    u.add_parser('reset-password').add_argument('login')
    i = sub.add_parser('invite').add_subparsers(dest='action', required=True)
    ic = i.add_parser('create')
    ic.add_argument('--note', default='')
    ic.add_argument('--family', action='store_true', help='le nouveau compte rejoint la famille')
    f = sub.add_parser('family').add_subparsers(dest='action', required=True)
    fc = f.add_parser('create')
    fc.add_argument('name')
    fc.add_argument('--admin', required=True)
    f.add_parser('show')
    f.add_parser('add').add_argument('login')
    f.add_parser('remove').add_argument('login')
    f.add_parser('privatize').add_argument('--apply', action='store_true')
    fr = f.add_parser('role')
    fr.add_argument('login')
    fr.add_argument('role', choices=['admin', 'member'])
    sub.add_parser('backup')
    sub.add_parser('status')
    sub.add_parser('verify').add_argument('src')
    sub.add_parser('restore-test').add_argument('src')
    sub.add_parser('restore').add_argument('src')
    sub.add_parser('check').add_argument('--full', action='store_true')
    sub.add_parser('purge')
    sub.add_parser('selftest')
    a = p.parse_args(argv)
    s = Settings.from_env()

    if a.cmd == 'restore':
        r = request_restore(s, Path(a.src))
        print(f"Sauvegarde vérifiée ({r['counts']['records']} enregistrement(s)). Redémarrez le conteneur pour appliquer la restauration :")
        print('la base actuelle sera conservée dans « data-avant-restauration-… », jamais effacée.')
        return
    if a.cmd == 'verify':
        r = verify_backup(Path(a.src))
        print(('Sauvegarde intacte.' if r['ok'] else 'SAUVEGARDE INCORRECTE :\n' + '\n'.join(r['errors'][:30])))
        sys.exit(0 if r['ok'] else 1)
    if a.cmd == 'restore-test':
        scratch = (s.backup_dir or Path('/tmp')) / '.essai-restauration'
        r = restore_test(Path(a.src), scratch)
        print(f"Restauration à blanc réussie : {r['counts']['users']} compte(s), {r['counts']['records']} enregistrement(s), {r['files']} fichier(s) contrôlés." if r['ok'] else 'ÉCHEC :\n' + '\n'.join(r['errors'][:30]))
        sys.exit(0 if r['ok'] else 1)
    if a.cmd == 'selftest':
        _selftest()
        return
    if a.cmd == 'status':
        st = s.backup_dir / 'etat.json' if s.backup_dir else None
        print(st.read_text() if st and st.exists() else 'Aucune sauvegarde nocturne effectuée pour l’instant.')
        for b in list_backups(s.backup_dir) if s.backup_dir else []:
            print(' -', b.name)
        return

    db = Database(s.data_dir / DB_FILE)
    if a.cmd == 'setup':
        if db.one('SELECT 1 FROM users'):
            raise SystemExit('Un compte existe déjà : utilisez « user create » pour en ajouter un autre.')
        print('Création du compte principal de Carnet Sync.')
        login = _create_user(db, None, None)
        name = _ask('Nom du catalogue familial (Entrée : « Famille ») : ') or 'Famille'
        spaces.create_family(db, name, login)
        print(f'Catalogue « {name} » créé ; vous en êtes l’administrateur.')
    elif a.cmd == 'user':
        if a.action == 'create':
            _create_user(db, a.login, a.name)
        elif a.action == 'list':
            for r in db.q('SELECT login, display_name, disabled_at FROM users ORDER BY created_at'):
                print(r['login'], '·', r['display_name'], '· désactivé' if r['disabled_at'] else '')
        elif a.action == 'disable':
            with db.tx() as c:
                uid = c.execute('SELECT id FROM users WHERE login = ?', (a.login.lower(),)).fetchone()
                if not uid:
                    raise SystemExit('Compte inconnu.')
                c.execute('UPDATE users SET disabled_at = ? WHERE id = ?', (now(), uid['id']))
                c.execute('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', (now(), uid['id']))
            print('Compte désactivé, sessions fermées (données conservées).')
        else:
            uid = db.one('SELECT id FROM users WHERE login = ?', (a.login.lower(),))
            if not uid:
                raise SystemExit('Compte inconnu.')
            pw = _ask_password()
            with db.tx() as c:
                c.execute('UPDATE users SET password_hash = ? WHERE id = ?', (auth._ph.hash(pw), uid['id']))
                c.execute('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', (now(), uid['id']))
            print('Mot de passe changé ; tous les appareils devront se reconnecter.')
    elif a.cmd == 'invite':
        fid = spaces.family_id(db) if a.family else None
        if a.family and not fid:
            raise SystemExit('Aucune famille : créez-la d’abord.')
        print(f'Code d’invitation (7 jours, usage unique{", rejoint la famille" if fid else ""}) : {auth.create_invite(db, a.note, family_id=fid)}')
    elif a.cmd == 'family':
        if a.action == 'create':
            spaces.create_family(db, a.name, a.admin)
            print('Famille créée.')
        elif a.action == 'add':
            spaces.add_member(db, a.login)
            print(f'{a.login} fait maintenant partie de la famille.')
        elif a.action == 'remove':
            spaces.remove_member(db, a.login)
            print(f'{a.login} n’a plus accès au catalogue familial (effet immédiat). Ses données personnelles sont conservées.')
            print('Ses appareils retireront les recettes familiales à leur prochaine connexion ; une copie déjà faite hors ligne ne peut pas être effacée à distance.')
        elif a.action == 'privatize':
            from .family import privatize

            r = privatize(db, s, apply=a.apply)
            print(('Copies créées' if a.apply else 'SIMULATION (rien n’est écrit ; ajoutez --apply)') + f" — {r['recipes']} recette(s) familiale(s) :")
            for m in r['members']:
                print(f"  {m['login']} : {m['copies']} copie(s) privée(s), {m['photos']} photo(s), {m['already']} déjà faite(s), {m['relinked']} lien(s) de journal/collection rattaché(s)")
            print('Le catalogue familial reste intact : son retrait est une étape distincte, après vérification.')
        elif a.action == 'role':
            spaces.set_role(db, a.login, a.role)
            print('Rôle modifié.')
        else:
            fid = spaces.family_id(db)
            if not fid:
                print('Aucune famille.')
            else:
                print(db.one('SELECT name FROM spaces WHERE id = ?', (fid,))['name'])
                for m in db.q('SELECT u.login, u.display_name, m.role, m.removed_at FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? ORDER BY m.joined_at', (fid,)):
                    print(' -', m['login'], '·', m['display_name'], '·', m['role'], '· retiré' if m['removed_at'] else '')
    elif a.cmd == 'backup':
        if not s.backup_dir:
            raise SystemExit('Aucun dossier de sauvegarde configuré (SYNC_BACKUP_DIR).')
        r = create_backup(s, db, s.backup_dir)
        rotate(s.backup_dir, s.backup_keep_daily, s.backup_keep_weekly)
        print(f"Sauvegarde {r['backup']} : {'réussie' if r['ok'] else 'INCOMPLÈTE'} ({r['counts']['records']} enregistrement(s), {r['counts']['files']} fichier(s), {r['duration_s']} s).")
        for e in r['errors'][:30]:
            print(' !', e)
        sys.exit(0 if r['ok'] else 1)
    elif a.cmd == 'check':
        r = check(s.data_dir / DB_FILE, s.data_dir, full=a.full)
        print(json.dumps(r['counts'], ensure_ascii=False))
        print('Cohérence : OK' if r['ok'] else 'PROBLÈMES :\n' + '\n'.join(r['errors'][:30]))
        for w in r['warnings'][:10]:
            print(' ·', w)
        sys.exit(0 if r['ok'] else 1)
    elif a.cmd == 'purge':
        print(f'{expire_old(db, s)} invitation(s) expirée(s), {cleanup_frozen(db, s)} dossier(s) figé(s) supprimé(s).')


if __name__ == '__main__':
    main()
