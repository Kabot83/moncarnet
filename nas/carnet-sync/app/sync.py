"""Synchronisation incrémentale par espace, et fichiers.

Envoi : chaque modification porte la révision du serveur sur laquelle elle se base (`base_rev`) et
son espace (« personal » par défaut, ou « family »).

Espace PERSONNEL (et photos de la famille) :
- base_rev = révision actuelle → acceptée ;
- sinon → CONFLIT : rien n'est écrit, la version du serveur est renvoyée ; le téléphone garde les
  deux versions ;
- même contenu → succès sans nouvelle révision (renvoi après coupure : aucun doublon).

Recettes de l'espace FAMILIAL :
- version périmée → fusion à trois voies côté serveur (voir fields.py) : statut « merged » avec la
  version fusionnée ; un désaccord sur un même élément crée un CONFLIT à résoudre à la main (les
  deux versions sont conservées) ;
- suppression → CORBEILLE (restaurable 30 jours) ; refusée si la recette a été modifiée ailleurs
  depuis (la modification l'emporte) ;
- recette verrouillée : seuls son auteur et l'administrateur la modifient ;
- chaque version est conservée dans l'historique (50 dernières) ;
- auteur et dernier modificateur sont fixés par le serveur.

Un même identifiant ne vit que dans un seul espace (« wrong_space » sinon).
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
from pathlib import Path
from typing import Any

from .auth import new_id
from .config import COLLECTIONS, Settings
from .db import Database, now
from .fields import family_part, merge3, personal_part
from .spaces import Access

ID_RE = re.compile(r'^[^\x00-\x1f]{1,300}$')
SHA_RE = re.compile(r'^[0-9a-f]{64}$')
MIME_OK = ('image/webp', 'image/jpeg', 'image/png', 'image/gif', 'image/svg+xml')
FAMILY_COLLECTIONS = ('recipes', 'photos')
HISTORY_KEEP = 50
VERSION_KINDS = ('edit', 'trash', 'restore', 'move-in', 'move-out', 'revert', 'resolve')


class SyncError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def canon(data: Any) -> str:
    return json.dumps(data, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def blob_path(s: Settings, space_id: str, sha: str) -> Path:
    return s.data_dir / 'files' / space_id / sha[:2] / sha


def _photo_hashes(data: dict) -> list[str]:
    return [x for x in (data.get('sha256'), data.get('thumbSha256')) if x]


def photo_in_use(c: sqlite3.Connection, space_id: str, photo_id: str, except_id: str | None = None) -> bool:
    """Photo utilisée par une recette (corbeille comprise), une publication ou le journal de l'espace."""
    needle = json.dumps(photo_id, ensure_ascii=False)
    return c.execute(
        "SELECT 1 FROM records WHERE space_id = ? AND collection IN ('recipes', 'posts', 'journal') AND deleted = 0 AND id IS NOT ? AND instr(data, ?) > 0 LIMIT 1",
        (space_id, except_id, needle),
    ).fetchone() is not None


# ---------------------------------------------------------------------------
# Historique et informations de la famille
# ---------------------------------------------------------------------------

def add_history(c: sqlite3.Connection, sid: str, coll: str, rid: str, rev: int, kind: str, data: str | None, author: str) -> None:
    c.execute('INSERT OR REPLACE INTO history (space_id, collection, id, rev, kind, data, author_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', (sid, coll, rid, rev, kind, data, author, now()))
    c.execute(
        'DELETE FROM history WHERE space_id = ? AND collection = ? AND id = ? AND rev NOT IN '
        '(SELECT DISTINCT rev FROM history WHERE space_id = ? AND collection = ? AND id = ? ORDER BY rev DESC LIMIT ?)',
        (sid, coll, rid, sid, coll, rid, HISTORY_KEEP),
    )


def history_data(c: sqlite3.Connection, sid: str, coll: str, rid: str, rev: int) -> dict | None:
    marks = ','.join('?' * len(VERSION_KINDS))
    r = c.execute(f'SELECT data FROM history WHERE space_id = ? AND collection = ? AND id = ? AND rev = ? AND kind IN ({marks}) AND data IS NOT NULL', (sid, coll, rid, rev, *VERSION_KINDS)).fetchone()
    return json.loads(r['data']) if r else None


def _label(c: sqlite3.Connection, uid: str | None, cache: dict) -> dict | None:
    if not uid:
        return None
    if uid not in cache:
        u = c.execute('SELECT login, display_name FROM users WHERE id = ?', (uid,)).fetchone()
        cache[uid] = {'login': u['login'], 'name': u['display_name']} if u else None
    return cache[uid]


def info(c: sqlite3.Connection, row, cache: dict | None = None) -> dict:
    """Informations de la famille pour une recette : auteur, modificateur, verrou, conflits."""
    cache = {} if cache is None else cache
    open_c = c.execute("SELECT COUNT(*) FROM conflicts WHERE space_id = ? AND collection = ? AND record_id = ? AND status = 'open'", (row['space_id'], row['collection'], row['id'])).fetchone()[0]
    return {
        'createdBy': _label(c, row['created_by'], cache), 'createdAt': row['created_at'],
        'updatedBy': _label(c, row['updated_by'], cache), 'updatedAt': row['updated_at'],
        'lockedBy': _label(c, row['locked_by'], cache), 'openConflicts': open_c,
    }


def server_version(c: sqlite3.Connection, a: Access, row) -> dict:
    gone = bool(row['deleted'] or row['trashed_at'])
    v = {'rev': row['rev'], 'deleted': gone, 'data': None if gone else json.loads(row['data']), 'space': a.name_of(row['space_id'])}
    if row['space_id'] == a.family and row['collection'] == 'recipes':
        v['info'] = info(c, row)
    return v


# ---------------------------------------------------------------------------
# Envoi
# ---------------------------------------------------------------------------

def push(db: Database, s: Settings, a: Access, changes: list[dict]) -> list[dict]:
    if len(changes) > 200:
        raise SyncError('too_many', 'Au plus 200 modifications par envoi.')
    return [_push_one(db, s, a, ch) for ch in changes]


def _push_one(db: Database, s: Settings, a: Access, ch: dict) -> dict:
    coll, rid, space = ch.get('collection'), ch.get('id'), ch.get('space') or 'personal'
    res = {'collection': coll, 'id': rid, 'space': space}
    if coll not in COLLECTIONS or not isinstance(rid, str) or not ID_RE.match(rid) or space not in ('personal', 'family'):
        return {**res, 'status': 'rejected', 'error': 'Collection, identifiant ou espace invalide.'}
    if space == 'family' and coll not in FAMILY_COLLECTIONS:
        return {**res, 'status': 'rejected', 'error': 'Cette donnée reste personnelle.'}
    if space == 'family' and not a.family:
        return {**res, 'status': 'rejected', 'error': 'not_member'}
    sid = a.space(space)
    deleted = bool(ch.get('deleted'))
    data = None if deleted else ch.get('data')
    if not deleted and not isinstance(data, dict):
        return {**res, 'status': 'rejected', 'error': 'Données manquantes.'}
    if data is not None:
        # Tri imposé par le serveur : rien de personnel dans la famille, rien de commun dans recipeMeta.
        if space == 'family' and coll == 'recipes':
            data = family_part(data)
        elif coll == 'recipeMeta':
            data = {'id': rid, **personal_part(data)}
    payload = None if deleted else canon(data)
    if payload and len(payload.encode()) > s.max_record_bytes:
        return {**res, 'status': 'rejected', 'error': 'Enregistrement trop volumineux.'}
    if coll == 'photos' and data:
        missing = [x for x in _photo_hashes(data) if not SHA_RE.match(x) or not db.one('SELECT 1 FROM blobs WHERE space_id = ? AND sha256 = ?', (sid, x))]
        if missing:
            return {**res, 'status': 'missing_blob', 'missing': missing}
    base = int(ch.get('base_rev') or 0)
    with db.tx() as c:
        if not deleted:
            for other in a.spaces:
                if other != sid and c.execute('SELECT 1 FROM records WHERE space_id = ? AND collection = ? AND id = ? AND deleted = 0 AND trashed_at IS NULL', (other, coll, rid)).fetchone():
                    return {**res, 'status': 'wrong_space', 'space_actual': a.name_of(other)}
        cur = c.execute('SELECT * FROM records WHERE space_id = ? AND collection = ? AND id = ?', (sid, coll, rid)).fetchone()
        if space == 'family' and coll == 'recipes':
            return {**res, **_push_family_recipe(c, a, sid, rid, base, deleted, data, payload, cur)}
        return {**res, **_push_simple(c, a, sid, coll, rid, base, deleted, payload, cur)}


def _push_simple(c, a: Access, sid: str, coll: str, rid: str, base: int, deleted: bool, payload: str | None, cur) -> dict:
    if cur and cur['data'] == payload and bool(cur['deleted']) == deleted:
        return {'status': 'ok', 'rev': cur['rev']}
    if cur and deleted and coll == 'photos' and not cur['deleted'] and photo_in_use(c, sid, rid):
        # Photo encore utilisée : suppression refusée, le téléphone la récupère.
        return {'status': 'conflict', 'server': server_version(c, a, cur)}
    if cur and cur['rev'] != base:
        return {'status': 'conflict', 'server': server_version(c, a, cur)}
    if not cur and deleted:
        return {'status': 'ok', 'rev': 0}
    rev, t = Database.next_rev(c), now()
    if cur:
        c.execute('UPDATE records SET rev = ?, deleted = ?, data = ?, updated_by = ?, updated_at = ? WHERE space_id = ? AND collection = ? AND id = ?', (rev, int(deleted), payload, a.user_id, t, sid, coll, rid))
    else:
        c.execute('INSERT INTO records (space_id, collection, id, rev, deleted, data, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)', (sid, coll, rid, rev, payload, a.user_id, t, a.user_id, t))
    return {'status': 'ok', 'rev': rev}


def write_simple(c, sid: str, coll: str, rid: str, user: str, data_json: str | None) -> int:
    """Écriture directe (opérations du serveur : déplacement, copie) ; data None = suppression."""
    rev, t = Database.next_rev(c), now()
    c.execute(
        'INSERT INTO records (space_id, collection, id, rev, deleted, data, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        'ON CONFLICT(space_id, collection, id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted, data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
        (sid, coll, rid, rev, int(data_json is None), data_json, user, t, user, t),
    )
    return rev


def write_family(c, sid: str, rid: str, user: str, data_json: str, kind: str, cur=None) -> int:
    """Écrit une version d'une recette familiale (et son historique). Sort de la corbeille."""
    rev, t = Database.next_rev(c), now()
    if cur is not None:
        c.execute("UPDATE records SET rev = ?, deleted = 0, data = ?, updated_by = ?, updated_at = ?, trashed_at = NULL, trashed_by = NULL WHERE space_id = ? AND collection = 'recipes' AND id = ?", (rev, data_json, user, t, sid, rid))
    else:
        c.execute("INSERT INTO records (space_id, collection, id, rev, deleted, data, created_by, created_at, updated_by, updated_at) VALUES (?, 'recipes', ?, ?, 0, ?, ?, ?, ?, ?)", (sid, rid, rev, data_json, user, t, user, t))
    add_history(c, sid, 'recipes', rid, rev, kind, data_json, user)
    return rev


def trash_family(c, sid: str, rid: str, user: str, data_json: str, kind: str = 'trash') -> int:
    rev, t = Database.next_rev(c), now()
    c.execute("UPDATE records SET rev = ?, trashed_at = ?, trashed_by = ?, updated_by = ?, updated_at = ? WHERE space_id = ? AND collection = 'recipes' AND id = ?", (rev, t, user, user, t, sid, rid))
    add_history(c, sid, 'recipes', rid, rev, kind, data_json, user)
    return rev


def _push_family_recipe(c, a: Access, sid: str, rid: str, base: int, deleted: bool, mine: dict | None, payload: str | None, cur) -> dict:
    alive = cur is not None and not cur['deleted']
    if alive and cur['locked_by'] and cur['locked_by'] != a.user_id and not a.is_admin:
        return {'status': 'locked', 'server': server_version(c, a, cur)}
    if deleted:
        if not alive or cur['trashed_at']:
            return {'status': 'ok', 'rev': cur['rev'] if cur else 0}
        if cur['rev'] != base and canon(history_data(c, sid, 'recipes', rid, base)) != cur['data']:
            # Modifiée ailleurs depuis : la modification l'emporte sur la mise à la corbeille.
            return {'status': 'conflict', 'server': server_version(c, a, cur)}
        return {'status': 'ok', 'rev': trash_family(c, sid, rid, a.user_id, cur['data'])}
    if not alive:
        return {'status': 'ok', 'rev': write_family(c, sid, rid, a.user_id, payload, 'edit', cur)}
    if cur['data'] == payload and not cur['trashed_at']:
        return {'status': 'ok', 'rev': cur['rev']}
    theirs = json.loads(cur['data'])
    if cur['rev'] == base:
        merged, conflicts = mine, []
    else:
        merged, conflicts = merge3(history_data(c, sid, 'recipes', rid, base), theirs, mine)
    merged_json = canon(merged)
    rev = cur['rev']
    if merged_json != cur['data'] or cur['trashed_at']:
        rev = write_family(c, sid, rid, a.user_id, merged_json, 'restore' if cur['trashed_at'] else 'edit', cur)
    cid = None
    if conflicts:
        # Les deux versions sont conservées : la version envoyée entière, et la liste des désaccords.
        cid = new_id('c')
        c.execute('INSERT INTO conflicts (id, space_id, collection, record_id, author_id, created_at, items, mine) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', (cid, sid, 'recipes', rid, a.user_id, now(), json.dumps(conflicts, ensure_ascii=False), payload))
        add_history(c, sid, 'recipes', rid, rev, 'conflict', payload, a.user_id)
    if merged is mine:
        return {'status': 'ok', 'rev': rev}
    row = c.execute("SELECT * FROM records WHERE space_id = ? AND collection = 'recipes' AND id = ?", (sid, rid)).fetchone()
    return {'status': 'merged', 'rev': rev, 'data': merged, 'conflict': cid, 'info': info(c, row)}


# ---------------------------------------------------------------------------
# Réception
# ---------------------------------------------------------------------------

def changes(db: Database, a: Access, since: int, limit: int = 500, space: str | None = None) -> dict:
    spaces = (a.space(space),) if space else a.spaces
    marks = ','.join('?' * len(spaces))
    rows = db.q(f'SELECT * FROM records WHERE space_id IN ({marks}) AND rev > ? ORDER BY rev LIMIT ?', (*spaces, since, limit + 1))
    more = len(rows) > limit
    rows = rows[:limit]
    out, cache = [], {}
    with db.tx() as c:  # lecture cohérente des informations de la famille
        for r in rows:
            gone = bool(r['deleted'] or r['trashed_at'])
            item = {'space': a.name_of(r['space_id']), 'collection': r['collection'], 'id': r['id'], 'rev': r['rev'], 'deleted': gone, 'data': None if gone else json.loads(r['data'])}
            if r['trashed_at'] and not r['deleted']:
                item['trashed'] = True
            if r['space_id'] == a.family and r['collection'] == 'recipes' and not gone:
                item['info'] = info(c, r, cache)
            out.append(item)
    return {'changes': out, 'cursor': rows[-1]['rev'] if rows else since, 'more': more}


# ---------------------------------------------------------------------------
# Fichiers (photos), par espace
# ---------------------------------------------------------------------------

def missing_blobs(db: Database, space_id: str, hashes: list[str]) -> list[str]:
    return [x for x in hashes[:1000] if SHA_RE.match(x or '') and not db.one('SELECT 1 FROM blobs WHERE space_id = ? AND sha256 = ?', (space_id, x))]


def put_blob(db: Database, s: Settings, space_id: str, sha: str, body: bytes, mime: str, quota: int) -> None:
    if not SHA_RE.match(sha):
        raise SyncError('invalid_hash', 'Empreinte invalide.')
    if mime not in MIME_OK:
        raise SyncError('invalid_type', 'Type de fichier non accepté (images uniquement).')
    if len(body) > s.max_blob_bytes:
        raise SyncError('too_large', 'Fichier trop volumineux.', 413)
    if hashlib.sha256(body).hexdigest() != sha:
        raise SyncError('hash_mismatch', 'Le contenu ne correspond pas à son empreinte.')
    used = db.one('SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE space_id = ?', (space_id,))['n']
    if used + len(body) > quota:
        raise SyncError('quota', 'Espace plein.', 507)
    store_blob(db, s, space_id, sha, body, mime)


def store_blob(db: Database, s: Settings, space_id: str, sha: str, body: bytes, mime: str) -> None:
    p = blob_path(s, space_id, sha)
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix('.tmp')
        tmp.write_bytes(body)
        tmp.replace(p)
    db.x('INSERT OR IGNORE INTO blobs (space_id, sha256, size, mime, created_at) VALUES (?, ?, ?, ?, ?)', (space_id, sha, len(body), mime, now()))


def get_blob(db: Database, s: Settings, a: Access, sha: str) -> tuple[Path, str] | None:
    for sid in a.spaces:
        row = db.one('SELECT mime FROM blobs WHERE space_id = ? AND sha256 = ?', (sid, sha))
        p = blob_path(s, sid, sha)
        if row and p.exists():
            return p, row['mime']
    return None


def copy_blob(c: sqlite3.Connection, s: Settings, src: Path, space_id: str, sha: str, mime: str) -> None:
    """Copie indépendante d'un fichier dans un espace (aucun lien vers l'original)."""
    dest = blob_path(s, space_id, sha)
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
    c.execute('INSERT OR IGNORE INTO blobs (space_id, sha256, size, mime, created_at) VALUES (?, ?, ?, ?, ?)', (space_id, sha, dest.stat().st_size, mime, now()))
