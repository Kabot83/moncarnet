"""Synchronisation incrémentale (par propriétaire) et fichiers.

Envoi : chaque modification porte la révision du serveur sur laquelle elle se base (`base_rev`).
- base_rev = révision actuelle → acceptée, nouvelle révision attribuée ;
- sinon → CONFLIT : rien n'est écrit, la version du serveur est renvoyée au téléphone, qui
  conserve les deux versions (aucune modification n'est écrasée en silence) ;
- même contenu que la version actuelle → succès sans nouvelle révision (nouvel envoi après une
  coupure : aucun doublon).
Réception : toutes les modifications d'un propriétaire après un curseur (suppressions comprises).
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any

from .config import COLLECTIONS, Settings
from .db import Database, now

ID_RE = re.compile(r'^[^\x00-\x1f]{1,300}$')
SHA_RE = re.compile(r'^[0-9a-f]{64}$')
MIME_OK = ('image/webp', 'image/jpeg', 'image/png', 'image/gif', 'image/svg+xml')


class SyncError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def _canon(data: Any) -> str:
    return json.dumps(data, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def blob_path(s: Settings, owner_id: str, sha: str) -> Path:
    return s.data_dir / 'files' / owner_id / sha[:2] / sha


def _photo_hashes(data: dict) -> list[str]:
    return [x for x in (data.get('sha256'), data.get('thumbSha256')) if x]


def _photo_in_use(c, owner_id: str, photo_id: str) -> bool:
    needle = json.dumps(photo_id, ensure_ascii=False)  # identifiant entre guillemets dans le JSON
    return c.execute(
        "SELECT 1 FROM records WHERE owner_id = ? AND collection IN ('recipes', 'posts', 'journal') AND deleted = 0 AND instr(data, ?) > 0 LIMIT 1",
        (owner_id, needle),
    ).fetchone() is not None


def push(db: Database, s: Settings, owner_id: str, changes: list[dict]) -> list[dict]:
    if len(changes) > 200:
        raise SyncError('too_many', 'Au plus 200 modifications par envoi.')
    results = []
    for ch in changes:
        coll, rid = ch.get('collection'), ch.get('id')
        if coll not in COLLECTIONS or not isinstance(rid, str) or not ID_RE.match(rid):
            results.append({'collection': coll, 'id': rid, 'status': 'rejected', 'error': 'Collection ou identifiant invalide.'})
            continue
        deleted = bool(ch.get('deleted'))
        data = None if deleted else ch.get('data')
        if not deleted and not isinstance(data, dict):
            results.append({'collection': coll, 'id': rid, 'status': 'rejected', 'error': 'Données manquantes.'})
            continue
        payload = None if deleted else _canon(data)
        if payload and len(payload.encode()) > s.max_record_bytes:
            results.append({'collection': coll, 'id': rid, 'status': 'rejected', 'error': 'Enregistrement trop volumineux.'})
            continue
        if coll == 'photos' and data:
            missing = [x for x in _photo_hashes(data) if not SHA_RE.match(x) or not db.one('SELECT 1 FROM blobs WHERE owner_id = ? AND sha256 = ?', (owner_id, x))]
            if missing:
                results.append({'collection': coll, 'id': rid, 'status': 'missing_blob', 'missing': missing})
                continue
        base = int(ch.get('base_rev') or 0)
        with db.tx() as c:
            cur = c.execute('SELECT rev, deleted, data FROM records WHERE owner_id = ? AND collection = ? AND id = ?', (owner_id, coll, rid)).fetchone()
            if cur and cur['data'] == payload and bool(cur['deleted']) == deleted:
                results.append({'collection': coll, 'id': rid, 'status': 'ok', 'rev': cur['rev']})
                continue
            if cur and deleted and coll == 'photos' and not cur['deleted'] and _photo_in_use(c, owner_id, rid):
                # Photo encore utilisée par une recette, une publication ou le journal du compte :
                # suppression refusée (protège d'une perte locale suivie d'un nettoyage des photos
                # « orphelines »). Le téléphone récupère la photo.
                results.append({
                    'collection': coll, 'id': rid, 'status': 'conflict',
                    'server': {'rev': cur['rev'], 'deleted': False, 'data': json.loads(cur['data'])},
                })
                continue
            if cur and cur['rev'] != base:
                results.append({
                    'collection': coll, 'id': rid, 'status': 'conflict',
                    'server': {'rev': cur['rev'], 'deleted': bool(cur['deleted']), 'data': json.loads(cur['data']) if cur['data'] else None},
                })
                continue
            if not cur and deleted:
                results.append({'collection': coll, 'id': rid, 'status': 'ok', 'rev': 0})
                continue
            rev = Database.next_rev(c)
            c.execute(
                'INSERT INTO records (owner_id, collection, id, rev, deleted, data, client_updated_at, server_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
                'ON CONFLICT(owner_id, collection, id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted, data = excluded.data, '
                'client_updated_at = excluded.client_updated_at, server_updated_at = excluded.server_updated_at',
                (owner_id, coll, rid, rev, int(deleted), payload, ch.get('updated_at'), now()),
            )
        results.append({'collection': coll, 'id': rid, 'status': 'ok', 'rev': rev})
    return results


def changes(db: Database, owner_id: str, since: int, limit: int = 500) -> dict:
    rows = db.q('SELECT collection, id, rev, deleted, data FROM records WHERE owner_id = ? AND rev > ? ORDER BY rev LIMIT ?', (owner_id, since, limit + 1))
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        'changes': [{'collection': r['collection'], 'id': r['id'], 'rev': r['rev'], 'deleted': bool(r['deleted']), 'data': json.loads(r['data']) if r['data'] else None} for r in rows],
        'cursor': rows[-1]['rev'] if rows else since,
        'more': more,
    }


# ---------------------------------------------------------------------------
# Fichiers (photos), par propriétaire
# ---------------------------------------------------------------------------

def missing_blobs(db: Database, owner_id: str, hashes: list[str]) -> list[str]:
    out = []
    for x in hashes[:1000]:
        if SHA_RE.match(x or '') and not db.one('SELECT 1 FROM blobs WHERE owner_id = ? AND sha256 = ?', (owner_id, x)):
            out.append(x)
    return out


def put_blob(db: Database, s: Settings, owner_id: str, sha: str, body: bytes, mime: str) -> None:
    if not SHA_RE.match(sha):
        raise SyncError('invalid_hash', 'Empreinte invalide.')
    if mime not in MIME_OK:
        raise SyncError('invalid_type', 'Type de fichier non accepté (images uniquement).')
    if len(body) > s.max_blob_bytes:
        raise SyncError('too_large', 'Fichier trop volumineux.', 413)
    if hashlib.sha256(body).hexdigest() != sha:
        raise SyncError('hash_mismatch', 'Le contenu ne correspond pas à son empreinte.')
    used = db.one('SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE owner_id = ?', (owner_id,))['n']
    if used + len(body) > s.max_user_bytes:
        raise SyncError('quota', 'Espace du compte plein.', 507)
    store_blob(db, s, owner_id, sha, body, mime)


def store_blob(db: Database, s: Settings, owner_id: str, sha: str, body: bytes, mime: str) -> None:
    p = blob_path(s, owner_id, sha)
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix('.tmp')
        tmp.write_bytes(body)
        tmp.replace(p)
    db.x('INSERT OR IGNORE INTO blobs (owner_id, sha256, size, mime, created_at) VALUES (?, ?, ?, ?, ?)', (owner_id, sha, len(body), mime, now()))


def get_blob(db: Database, s: Settings, owner_id: str, sha: str) -> tuple[Path, str] | None:
    row = db.one('SELECT mime FROM blobs WHERE owner_id = ? AND sha256 = ?', (owner_id, sha))
    p = blob_path(s, owner_id, sha)
    return (p, row['mime']) if row and p.exists() else None


def copy_blob(db: Database, s: Settings, src: Path, owner_id: str, sha: str, mime: str) -> None:
    dest = blob_path(s, owner_id, sha)
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)  # copie indépendante (aucun lien vers le fichier d'origine)
    db.x('INSERT OR IGNORE INTO blobs (owner_id, sha256, size, mime, created_at) VALUES (?, ?, ?, ?, ?)', (owner_id, sha, dest.stat().st_size, mime, now()))
