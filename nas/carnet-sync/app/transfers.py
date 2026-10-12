"""« Envoyer à un utilisateur » : transfert ponctuel PAR COPIE.

- L'expéditeur est toujours l'utilisateur de la session ; la recette est lue dans SON espace sur
  le serveur (jamais fournie par le téléphone) : impossible d'envoyer la recette d'un autre ni
  d'usurper un expéditeur.
- Le contenu est figé à l'envoi, nettoyé des données privées (notes personnelles sauf astuces
  explicitement partagées, journal, favori, note, réalisations…), et ses photos sont copiées à part.
- Le destinataire accepte explicitement : une copie indépendante est créée dans SON espace, avec
  des identifiants dérivés du transfert (accepter deux fois ne crée jamais de doublon).
- Invitations non acceptées : expirées après 30 jours. Les fichiers figés d'une invitation traitée
  sont supprimés par la maintenance nocturne, APRÈS la sauvegarde : une sauvegarde contient donc
  toujours les fichiers des invitations qu'elle décrit comme « en attente ».
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from .auth import new_id
from .config import Settings
from .db import Database, now
from .sync import blob_path, copy_blob

RECIPE_SHARED_FIELDS = (
    'title', 'description', 'category', 'tags', 'prepTime', 'cookTime', 'restTime', 'servings', 'difficulty',
    'source', 'sourceUrl', 'ingredients', 'steps', 'nutrition', 'cookedWeightG', 'cookedWeightRawG',
    'mainPhotoId', 'galleryPhotoIds',  # identifiants de l'expéditeur : remplacés à l'acceptation
)
POST_SHARED_FIELDS = ('platform', 'kind', 'originalUrl', 'url', 'postId', 'dedupeKey', 'title', 'description', 'author', 'authorHandle', 'authorUrl')


class TransferError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def _frozen_dir(s: Settings, tid: str) -> Path:
    return s.data_dir / 'transfers' / tid


def _record(db: Database, owner_id: str, coll: str, rid: str) -> dict | None:
    r = db.one('SELECT data FROM records WHERE owner_id = ? AND collection = ? AND id = ? AND deleted = 0', (owner_id, coll, rid))
    return json.loads(r['data']) if r else None


def lookup_user(db: Database, login: str, requester_id: str) -> dict | None:
    """Recherche EXACTE d'un identifiant (aucune liste, aucun accès au carnet)."""
    u = db.one('SELECT id, login, display_name FROM users WHERE login = ? AND disabled_at IS NULL', ((login or '').strip().lower(),))
    if not u or u['id'] == requester_id:
        return None
    return {'login': u['login'], 'display_name': u['display_name']}


def send(db: Database, s: Settings, sender: dict, recipient_login: str, kind: str, source_id: str, include_tips: bool) -> dict:
    if kind not in ('recipe', 'post'):
        raise TransferError('invalid_kind', 'Seules les recettes et les publications peuvent être envoyées.')
    rcp = db.one('SELECT id, login, display_name FROM users WHERE login = ? AND disabled_at IS NULL', ((recipient_login or '').strip().lower(),))
    if not rcp or rcp['id'] == sender['id']:
        raise TransferError('unknown_recipient', 'Destinataire introuvable.', 404)
    src = _record(db, sender['id'], 'recipes' if kind == 'recipe' else 'posts', source_id)
    if not src:
        raise TransferError('not_found', 'Élément introuvable dans votre carnet synchronisé : synchronisez puis réessayez.', 404)

    if kind == 'recipe':
        payload: dict[str, Any] = {k: src.get(k) for k in RECIPE_SHARED_FIELDS if k in src}
        notes = src.get('notes') or {}
        payload['notes'] = {'tips': notes.get('tips', '') if include_tips else '', 'modifications': '', 'mistakes': '', 'ideas': '', 'storage': '', 'reheating': ''}
        photo_ids = [src.get('mainPhotoId'), *(src.get('galleryPhotoIds') or []), *[st.get('photoId') for st in (src.get('steps') or [])]]
    else:
        payload = {k: src.get(k) for k in POST_SHARED_FIELDS if k in src}
        photo_ids = [src.get('thumbnailPhotoId')]

    # Photos : fiches et fichiers de l'expéditeur, copiés dans le dossier figé du transfert.
    tid = new_id('t')
    photos, hashes = [], []
    fdir = _frozen_dir(s, tid)
    for pid in dict.fromkeys(p for p in photo_ids if p):
        meta = _record(db, sender['id'], 'photos', pid)
        if not meta:
            continue
        files = []
        for sha in (meta.get('sha256'), meta.get('thumbSha256')):
            if sha and blob_path(s, sender['id'], sha).exists():
                fdir.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(blob_path(s, sender['id'], sha), fdir / sha)
                files.append(sha)
        if meta.get('sha256') in files:
            photos.append({'id': pid, **{k: meta.get(k) for k in ('sha256', 'thumbSha256', 'mime', 'width', 'height')}})
            hashes += files
    payload['photos'] = photos
    cover, cover_mime = None, None
    first = src.get('mainPhotoId') if kind == 'recipe' else src.get('thumbnailPhotoId')
    for p in photos:
        if p['id'] == first:
            cover = p.get('thumbSha256') or p['sha256']
            row = db.one('SELECT mime FROM blobs WHERE owner_id = ? AND sha256 = ?', (sender['id'], cover))
            cover_mime = row['mime'] if row else p.get('mime')

    t = now()
    with db.tx() as c:
        # Nouvel envoi de la même recette au même destinataire : l'invitation en attente est remplacée.
        old = c.execute("SELECT id FROM transfers WHERE sender_id = ? AND recipient_id = ? AND status = 'pending' AND json_extract(payload, '$.__source') = ?", (sender['id'], rcp['id'], source_id)).fetchall()
        for o in old:
            c.execute("UPDATE transfers SET status = 'replaced', decided_at = ? WHERE id = ?", (t, o['id']))
        c.execute(
            'INSERT INTO transfers (id, sender_id, recipient_id, kind, title, payload, blob_hashes, cover_sha256, cover_mime, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (tid, sender['id'], rcp['id'], kind, str(payload.get('title') or 'Sans titre')[:200], json.dumps({**payload, '__source': source_id}, ensure_ascii=False), json.dumps(sorted(set(hashes))), cover, cover_mime, 'pending', t, t + s.transfer_ttl_s),
        )
    return {'id': tid, 'recipient': {'login': rcp['login'], 'display_name': rcp['display_name']}, 'expires_at': t + s.transfer_ttl_s}


def _view(db: Database, t: dict, role: str) -> dict:
    other = db.one('SELECT login, display_name FROM users WHERE id = ?', (t['sender_id'] if role == 'recipient' else t['recipient_id'],))
    return {
        'id': t['id'], 'kind': t['kind'], 'title': t['title'], 'status': t['status'], 'has_cover': bool(t['cover_sha256']),
        'created_at': t['created_at'], 'expires_at': t['expires_at'], 'result_id': t['result_id'],
        ('sender' if role == 'recipient' else 'recipient'): other,
    }


def expire_old(db: Database, s: Settings) -> int:
    rows = db.q("SELECT id FROM transfers WHERE status = 'pending' AND expires_at < ?", (now(),))
    for r in rows:
        db.x("UPDATE transfers SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", (now(), r['id']))
    return len(rows)


def cleanup_frozen(db: Database, s: Settings) -> int:
    """Supprime les fichiers figés des invitations traitées (à lancer après la sauvegarde)."""
    root = s.data_dir / 'transfers'
    if not root.exists():
        return 0
    pending = {r['id'] for r in db.q("SELECT id FROM transfers WHERE status = 'pending'")}
    removed = 0
    for d in root.iterdir():
        if d.is_dir() and d.name not in pending:
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    return removed


def inbox(db: Database, s: Settings, user_id: str) -> list[dict]:
    expire_old(db, s)
    return [_view(db, t, 'recipient') for t in db.q("SELECT * FROM transfers WHERE recipient_id = ? AND status = 'pending' ORDER BY created_at DESC", (user_id,))]


def outbox(db: Database, user_id: str) -> list[dict]:
    return [_view(db, t, 'sender') for t in db.q('SELECT * FROM transfers WHERE sender_id = ? ORDER BY created_at DESC LIMIT 100', (user_id,))]


def _mine(db: Database, user_id: str, tid: str) -> dict:
    t = db.one('SELECT * FROM transfers WHERE id = ?', (tid,))
    if not t or t['recipient_id'] != user_id:
        # Même réponse qu'une invitation inexistante : rien n'est révélé à un tiers.
        raise TransferError('not_found', 'Invitation introuvable.', 404)
    return t


def cover(db: Database, s: Settings, user_id: str, tid: str) -> tuple[Path, str] | None:
    t = _mine(db, user_id, tid)
    if t['status'] != 'pending' or not t['cover_sha256']:
        return None
    p = _frozen_dir(s, tid) / t['cover_sha256']
    return (p, t['cover_mime'] or 'image/webp') if p.exists() else None


def accept(db: Database, s: Settings, user: dict, tid: str) -> dict:
    t = _mine(db, user['id'], tid)
    if t['status'] == 'accepted':
        return {'id': t['result_id'], 'already': True}  # acceptation répétée : aucun doublon
    if t['status'] != 'pending' or t['expires_at'] < now():
        raise TransferError('not_pending', 'Invitation expirée, refusée ou remplacée.', 409)
    payload = json.loads(t['payload'])
    payload.pop('__source', None)
    photos = payload.pop('photos', [])
    sender = db.one('SELECT login, display_name FROM users WHERE id = ?', (t['sender_id'],))
    ts_ms = now() * 1000
    fdir = _frozen_dir(s, tid)

    # Photos : copie indépendante dans l'espace du destinataire, identifiants nouveaux et stables.
    id_map: dict[str, str] = {}
    photo_records = []
    for i, p in enumerate(photos):
        for sha in (p.get('sha256'), p.get('thumbSha256')):
            if sha and (fdir / sha).exists():
                copy_blob(db, s, fdir / sha, user['id'], sha, p.get('mime') or 'image/webp')
        new_pid = f"ph_{tid[2:]}_{i}"
        id_map[p['id']] = new_pid
        photo_records.append((new_pid, {'id': new_pid, 'sha256': p['sha256'], 'thumbSha256': p.get('thumbSha256') or p['sha256'], 'mime': p.get('mime') or 'image/webp', 'width': p.get('width') or 0, 'height': p.get('height') or 0, 'createdAt': ts_ms, 'isDemo': False}))

    received = {'login': sender['login'], 'name': sender['display_name'], 'at': ts_ms, 'transferId': tid}
    if t['kind'] == 'recipe':
        coll, new_id_ = 'recipes', f"r_{tid[2:]}"
        data = {
            **payload, 'id': new_id_, 'createdAt': ts_ms, 'updatedAt': ts_ms, 'favorite': False, 'toTry': True, 'rating': 0,
            'cookCount': 0, 'lastCookedAt': None, 'isDemo': False, 'variantOf': None, 'sourcePostId': None, 'receivedFrom': received,
            # Photos : identifiants de l'expéditeur remplacés par ceux des copies du destinataire.
            'mainPhotoId': id_map.get(payload.get('mainPhotoId') or ''),
            'galleryPhotoIds': [id_map[x] for x in payload.get('galleryPhotoIds') or [] if x in id_map],
            'steps': [{**st, 'photoId': id_map.get(st.get('photoId') or '')} for st in payload.get('steps') or []],
        }
    else:
        coll, new_id_ = 'posts', f"p_{tid[2:]}"
        data = {
            **payload, 'id': new_id_, 'createdAt': ts_ms, 'updatedAt': ts_ms, 'notes': '', 'tags': [], 'status': 'toTry', 'favorite': False,
            'recipeId': None, 'thumbnailPhotoId': photo_records[0][0] if photo_records else None, 'video': None, 'mediaStatus': 'none',
            'edited': [], 'metaStatus': 'ok', 'sharedText': '', 'receivedFrom': received,
        }

    with db.tx() as c:
        cur = c.execute('SELECT status, result_id FROM transfers WHERE id = ?', (tid,)).fetchone()
        if cur['status'] == 'accepted':
            return {'id': cur['result_id'], 'already': True}
        for pid, pdata in photo_records:
            if not c.execute("SELECT 1 FROM records WHERE owner_id = ? AND collection = 'photos' AND id = ?", (user['id'], pid)).fetchone():
                c.execute("INSERT INTO records (owner_id, collection, id, rev, deleted, data, client_updated_at, server_updated_at) VALUES (?, 'photos', ?, ?, 0, ?, ?, ?)", (user['id'], pid, Database.next_rev(c), json.dumps(pdata, ensure_ascii=False), ts_ms, now()))
        if not c.execute('SELECT 1 FROM records WHERE owner_id = ? AND collection = ? AND id = ?', (user['id'], coll, new_id_)).fetchone():
            c.execute('INSERT INTO records (owner_id, collection, id, rev, deleted, data, client_updated_at, server_updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)', (user['id'], coll, new_id_, Database.next_rev(c), json.dumps(data, ensure_ascii=False), ts_ms, now()))
        c.execute("UPDATE transfers SET status = 'accepted', decided_at = ?, result_id = ? WHERE id = ?", (now(), new_id_, tid))
    return {'id': new_id_, 'already': False}


def decline(db: Database, s: Settings, user_id: str, tid: str) -> None:
    t = _mine(db, user_id, tid)
    if t['status'] == 'declined':
        return
    if t['status'] != 'pending':
        raise TransferError('not_pending', 'Invitation déjà traitée.', 409)
    db.x("UPDATE transfers SET status = 'declined', decided_at = ? WHERE id = ? AND status = 'pending'", (now(), tid))
