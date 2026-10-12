"""Espaces et droits.

- Espace PERSONNEL : un par compte, accessible à son seul propriétaire.
- Espace FAMILIAL : commun aux membres actifs (rôle « admin » ou « member »).
Le téléphone ne désigne jamais un espace par son identifiant : il dit « personal » ou « family »,
et le serveur résout l'espace à partir de l'utilisateur de la session, à chaque requête. Un membre
retiré perd donc l'accès immédiatement.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from .auth import AuthError, new_id
from .db import Database, now


@dataclass(frozen=True)
class Access:
    user_id: str
    personal: str
    family: str | None
    role: str | None  # rôle dans la famille

    def space(self, name: str | None) -> str:
        if name in (None, '', 'personal'):
            return self.personal
        if name == 'family':
            if not self.family:
                raise AuthError('not_member', 'Vous ne faites pas partie d’une famille.', 403)
            return self.family
        raise AuthError('invalid_space', 'Espace inconnu.', 422)

    def name_of(self, space_id: str) -> str:
        return 'family' if space_id == self.family else 'personal'

    @property
    def spaces(self) -> tuple[str, ...]:
        return (self.personal, self.family) if self.family else (self.personal,)

    @property
    def is_admin(self) -> bool:
        return self.role == 'admin'


def create_personal_space(c: sqlite3.Connection, user_id: str, login: str) -> str:
    sid = new_id('sp')
    c.execute("INSERT INTO spaces (id, kind, name, owner_id, created_at) VALUES (?, 'personal', ?, ?, ?)", (sid, f'Carnet de {login}', user_id, now()))
    return sid


def access(db: Database, user_id: str) -> Access:
    p = db.one("SELECT id FROM spaces WHERE kind = 'personal' AND owner_id = ?", (user_id,))
    if not p:
        raise AuthError('unauthorized', 'Compte incomplet.', 401)
    f = db.one(
        "SELECT m.space_id, m.role FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE m.user_id = ? AND m.removed_at IS NULL AND s.kind = 'family'",
        (user_id,),
    )
    return Access(user_id, p['id'], f['space_id'] if f else None, f['role'] if f else None)


def family_view(db: Database, a: Access) -> dict:
    """Ce que le téléphone sait de la famille (aucun identifiant interne)."""
    if a.family:
        fam = db.one('SELECT name FROM spaces WHERE id = ?', (a.family,))
        members = db.q('SELECT u.login, u.display_name, m.role FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? AND m.removed_at IS NULL ORDER BY m.joined_at, m.rowid', (a.family,))
        return {'family': {'name': fam['name'], 'role': a.role, 'members': members}, 'family_revoked': False}
    removed = db.one("SELECT 1 FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE m.user_id = ? AND m.removed_at IS NOT NULL AND s.kind = 'family'", (a.user_id,))
    return {'family': None, 'family_revoked': bool(removed)}


# ---------------------------------------------------------------------------
# Administration de la famille (ligne de commande du NAS)
# ---------------------------------------------------------------------------

def _user(c: sqlite3.Connection, login: str) -> sqlite3.Row:
    u = c.execute('SELECT id, login FROM users WHERE login = ?', (login.strip().lower(),)).fetchone()
    if not u:
        raise SystemExit(f'Compte inconnu : {login}')
    return u


def family_id(db: Database) -> str | None:
    f = db.one("SELECT id FROM spaces WHERE kind = 'family'")
    return f['id'] if f else None


def create_family(db: Database, name: str, admin_login: str) -> str:
    with db.tx() as c:
        if c.execute("SELECT 1 FROM spaces WHERE kind = 'family'").fetchone():
            raise SystemExit('Une famille existe déjà.')
        u = _user(c, admin_login)
        fid = new_id('sp')
        c.execute("INSERT INTO spaces (id, kind, name, owner_id, created_at) VALUES (?, 'family', ?, NULL, ?)", (fid, name.strip()[:60] or 'Famille', now()))
        c.execute("INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)", (fid, u['id'], now()))
    return fid


def add_member(db: Database, login: str, role: str = 'member') -> None:
    fid = family_id(db)
    if not fid:
        raise SystemExit('Aucune famille : créez-la d’abord (family create).')
    with db.tx() as c:
        u = _user(c, login)
        c.execute(
            'INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) '
            'ON CONFLICT(space_id, user_id) DO UPDATE SET role = excluded.role, joined_at = excluded.joined_at, removed_at = NULL',
            (fid, u['id'], role, now()),
        )


def join_family(c: sqlite3.Connection, fid: str, user_id: str) -> None:
    c.execute("INSERT OR IGNORE INTO space_members (space_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", (fid, user_id, now()))


def _admins_left(c: sqlite3.Connection, fid: str, except_user: str) -> int:
    return c.execute("SELECT COUNT(*) FROM space_members WHERE space_id = ? AND role = 'admin' AND removed_at IS NULL AND user_id != ?", (fid, except_user)).fetchone()[0]


def remove_member(db: Database, login: str) -> None:
    """Accès coupé immédiatement. Ses données personnelles restent à lui ; rien n'est converti."""
    fid = family_id(db)
    with db.tx() as c:
        u = _user(c, login)
        m = c.execute('SELECT role FROM space_members WHERE space_id = ? AND user_id = ? AND removed_at IS NULL', (fid, u['id'])).fetchone()
        if not m:
            raise SystemExit('Ce compte n’est pas membre de la famille.')
        if m['role'] == 'admin' and not _admins_left(c, fid, u['id']):
            raise SystemExit('Impossible de retirer le dernier administrateur.')
        c.execute('UPDATE space_members SET removed_at = ? WHERE space_id = ? AND user_id = ?', (now(), fid, u['id']))


def set_role(db: Database, login: str, role: str) -> None:
    fid = family_id(db)
    with db.tx() as c:
        u = _user(c, login)
        if role == 'member' and not _admins_left(c, fid, u['id']):
            raise SystemExit('Il doit rester au moins un administrateur.')
        cur = c.execute('UPDATE space_members SET role = ? WHERE space_id = ? AND user_id = ? AND removed_at IS NULL', (role, fid, u['id']))
        if cur.rowcount != 1:
            raise SystemExit('Ce compte n’est pas membre de la famille.')
