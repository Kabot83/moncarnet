"""Comptes et sessions.

- Mots de passe : Argon2id (argon2-cffi), paramètres par défaut recommandés (RFC 9106).
- Aucune inscription publique : compte créé par l'administrateur ou avec un code d'invitation
  à usage unique, valable 7 jours.
- Sessions : jeton d'accès (1 h) + jeton de renouvellement (rotation à chaque usage). Les jetons
  sont aléatoires (256 bits) et seule leur empreinte SHA-256 est stockée. La réutilisation d'un
  jeton de renouvellement déjà consommé (signe de vol) révoque la session.
- Tentatives de connexion : 5 échecs en 15 min par identifiant ou 20 par adresse → attente.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from .db import Database, now

_ph = PasswordHasher()
# Empreinte factice : même durée de calcul pour un identifiant inconnu (pas d'énumération par le temps).
_DUMMY = _ph.hash('identifiant-inconnu')
LOGIN_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{2,31}$')
FAIL_WINDOW_S = 15 * 60
MAX_FAIL_LOGIN = 5
MAX_FAIL_IP = 20


class AuthError(Exception):
    def __init__(self, code: str, message: str, status: int = 401):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def h(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_id(prefix: str) -> str:
    return f'{prefix}_{secrets.token_hex(12)}'


def check_password_strength(pw: str) -> None:
    if len(pw) < 10:
        raise AuthError('weak_password', 'Mot de passe trop court (10 caractères au moins).', 422)
    if len(pw) > 256:
        raise AuthError('weak_password', 'Mot de passe trop long.', 422)


def normalize_login(login: str) -> str:
    v = (login or '').strip().lower()
    if not LOGIN_RE.match(v):
        raise AuthError('invalid_login', 'Identifiant : 3 à 32 caractères (lettres, chiffres, . _ -).', 422)
    return v


def create_user(db: Database, login: str, display_name: str, password: str) -> str:
    login = normalize_login(login)
    check_password_strength(password)
    uid = new_id('u')
    with db.tx() as c:
        if c.execute('SELECT 1 FROM users WHERE login = ?', (login,)).fetchone():
            raise AuthError('login_taken', 'Identifiant déjà utilisé.', 409)
        c.execute('INSERT INTO users (id, login, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', (uid, login, display_name.strip()[:60] or login, _ph.hash(password), now()))
    return uid


def create_invite(db: Database, note: str, ttl_s: int = 7 * 86400) -> str:
    code = 'inv_' + secrets.token_urlsafe(18)
    db.x('INSERT INTO account_invites (code_hash, note, created_at, expires_at) VALUES (?, ?, ?, ?)', (h(code), note, now(), now() + ttl_s))
    return code


def register_with_invite(db: Database, code: str, login: str, display_name: str, password: str) -> str:
    inv = db.one('SELECT * FROM account_invites WHERE code_hash = ?', (h(code or ''),))
    if not inv or inv['used_at'] or inv['expires_at'] < now():
        raise AuthError('invalid_invite', 'Invitation invalide, expirée ou déjà utilisée.', 403)
    uid = create_user(db, login, display_name, password)
    with db.tx() as c:
        # Usage unique, même en cas de deux demandes simultanées.
        cur = c.execute('UPDATE account_invites SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL', (now(), uid, inv['code_hash']))
        if cur.rowcount != 1:
            c.execute('DELETE FROM users WHERE id = ?', (uid,))
            raise AuthError('invalid_invite', 'Invitation déjà utilisée.', 403)
    return uid


def _too_many_failures(db: Database, login: str, ip: str) -> bool:
    since = now() - FAIL_WINDOW_S
    by_login = db.one('SELECT COUNT(*) AS n FROM login_failures WHERE key = ? AND at > ?', (f'login:{login}', since))['n']
    by_ip = db.one('SELECT COUNT(*) AS n FROM login_failures WHERE key = ? AND at > ?', (f'ip:{ip}', since))['n']
    return by_login >= MAX_FAIL_LOGIN or by_ip >= MAX_FAIL_IP


@dataclass
class Tokens:
    session_id: str
    access_token: str
    refresh_token: str
    access_expires_at: int
    user: dict


def _issue(db: Database, user: dict, device: str, access_ttl: int, refresh_ttl: int, session_id: str | None = None) -> Tokens:
    access, refresh = 'mca_' + secrets.token_urlsafe(32), 'mcr_' + secrets.token_urlsafe(32)
    t = now()
    with db.tx() as c:
        if session_id is None:
            session_id = new_id('s')
            c.execute(
                'INSERT INTO sessions (id, user_id, device, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (session_id, user['id'], device[:80], h(access), t + access_ttl, h(refresh), t + refresh_ttl, t, t),
            )
        else:
            c.execute('UPDATE sessions SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?, last_used_at = ? WHERE id = ?', (h(access), t + access_ttl, h(refresh), t + refresh_ttl, t, session_id))
    return Tokens(session_id, access, refresh, t + access_ttl, {'id': user['id'], 'login': user['login'], 'display_name': user['display_name']})


def login(db: Database, login_: str, password: str, device: str, ip: str, access_ttl: int, refresh_ttl: int) -> Tokens:
    try:
        login_n = normalize_login(login_)
    except AuthError:
        login_n = '-'
    if _too_many_failures(db, login_n, ip):
        raise AuthError('too_many_attempts', 'Trop de tentatives : réessayez dans 15 minutes.', 429)
    user = db.one('SELECT * FROM users WHERE login = ? AND disabled_at IS NULL', (login_n,))
    try:
        _ph.verify(user['password_hash'] if user else _DUMMY, password or '')
        ok = user is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        ok = False
    if not ok:
        with db.tx() as c:
            c.execute('INSERT INTO login_failures VALUES (?, ?)', (f'login:{login_n}', now()))
            c.execute('INSERT INTO login_failures VALUES (?, ?)', (f'ip:{ip}', now()))
        raise AuthError('bad_credentials', 'Identifiant ou mot de passe incorrect.')
    db.x('DELETE FROM login_failures WHERE key = ?', (f'login:{login_n}',))
    if _ph.check_needs_rehash(user['password_hash']):
        db.x('UPDATE users SET password_hash = ? WHERE id = ?', (_ph.hash(password), user['id']))
    return _issue(db, user, device, access_ttl, refresh_ttl)


def refresh(db: Database, refresh_token: str, access_ttl: int, refresh_ttl: int) -> Tokens:
    rh = h(refresh_token or '')
    used = db.one('SELECT session_id FROM used_refresh WHERE refresh_hash = ?', (rh,))
    if used:
        # Jeton déjà consommé présenté de nouveau : vol probable → session révoquée.
        db.x('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', (now(), used['session_id']))
        raise AuthError('session_revoked', 'Session révoquée par sécurité : reconnectez-vous.')
    s = db.one('SELECT * FROM sessions WHERE refresh_hash = ?', (rh,))
    if not s or s['revoked_at'] or s['refresh_expires_at'] < now():
        raise AuthError('session_expired', 'Session expirée : reconnectez-vous.')
    user = db.one('SELECT * FROM users WHERE id = ? AND disabled_at IS NULL', (s['user_id'],))
    if not user:
        raise AuthError('session_expired', 'Compte désactivé.')
    db.x('INSERT INTO used_refresh VALUES (?, ?, ?)', (rh, s['id'], now()))
    return _issue(db, user, s['device'], access_ttl, refresh_ttl, session_id=s['id'])


def authenticate(db: Database, access_token: str) -> tuple[dict, str]:
    """Utilisateur et session d'un jeton d'accès valide. Seule source de l'identité côté serveur."""
    s = db.one('SELECT * FROM sessions WHERE access_hash = ?', (h(access_token or ''),))
    if not s or s['revoked_at'] or s['access_expires_at'] < now():
        raise AuthError('unauthorized', 'Session invalide ou expirée.')
    user = db.one('SELECT id, login, display_name FROM users WHERE id = ? AND disabled_at IS NULL', (s['user_id'],))
    if not user:
        raise AuthError('unauthorized', 'Compte désactivé.')
    return user, s['id']


def revoke(db: Database, user_id: str, session_id: str) -> bool:
    with db.tx() as c:
        cur = c.execute('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', (now(), session_id, user_id))
        return cur.rowcount == 1


def change_password(db: Database, user_id: str, old: str, new: str, keep_session: str) -> None:
    user = db.one('SELECT * FROM users WHERE id = ?', (user_id,))
    try:
        _ph.verify(user['password_hash'], old or '')
    except (VerifyMismatchError, VerificationError, InvalidHashError) as e:
        raise AuthError('bad_credentials', 'Mot de passe actuel incorrect.', 403) from e
    check_password_strength(new)
    with db.tx() as c:
        c.execute('UPDATE users SET password_hash = ? WHERE id = ?', (_ph.hash(new), user_id))
        # Toutes les autres sessions sont fermées.
        c.execute('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL', (now(), user_id, keep_session))
