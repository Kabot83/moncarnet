"""Administration (dans le conteneur : Container Manager → Conteneur → carnet-sync → Terminal).

  python -m app.admin setup                     → premier compte, en mode interactif (mot de passe masqué)
  python -m app.admin user create               → autre compte (interactif) ; ou invite create
  python -m app.admin user list | user disable <login> | user reset-password <login>
  python -m app.admin invite create --note "…"  → code d'invitation (7 jours, usage unique)
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

from . import auth
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


def _create_user(db: Database, login: str | None, name: str | None) -> None:
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
    i.add_parser('create').add_argument('--note', default='')
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
        _create_user(db, None, None)
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
        print(f'Code d’invitation (7 jours, usage unique) : {auth.create_invite(db, a.note)}')
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
