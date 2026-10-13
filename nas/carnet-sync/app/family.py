"""Opérations du catalogue familial : verrou, corbeille, historique, conflits, déplacements.

Droits (vérifiés ici, à partir de l'utilisateur de la session) :
- tout membre : ajouter, modifier, mettre à la corbeille, restaurer, revenir à une version,
  résoudre un conflit (hors recette verrouillée par un autre) ;
- auteur d'une recette : la verrouiller / déverrouiller ;
- administrateur : tout, plus la suppression définitive ;
- retirer une recette du catalogue (vers son espace personnel) : auteur ou administrateur.
Toute opération qui touche les autres membres exige `confirm` quand la famille en compte d'autres.
"""
from __future__ import annotations

import json
import sqlite3

from .auth import new_id
from .config import Settings
from .db import Database, now
from .fields import family_part, join, personal_part
from .spaces import Access
from .sync import (
    add_history, blob_path, canon, copy_blob, history_data, info, photo_in_use, server_version,
    trash_family, write_family, write_simple,
)

TRASH_DAYS = 30


class FamilyError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def _fam(a: Access) -> str:
    if not a.family:
        raise FamilyError('not_member', 'Vous ne faites pas partie d’une famille.', 403)
    return a.family


def _recipe(c: sqlite3.Connection, sid: str, rid: str):
    r = c.execute("SELECT * FROM records WHERE space_id = ? AND collection = 'recipes' AND id = ? AND deleted = 0", (sid, rid)).fetchone()
    if not r:
        raise FamilyError('not_found', 'Recette introuvable.', 404)
    return r


def _can_edit(a: Access, r) -> None:
    if r['locked_by'] and r['locked_by'] != a.user_id and not a.is_admin:
        raise FamilyError('locked', 'Recette verrouillée par son auteur.', 403)


def _others(c: sqlite3.Connection, a: Access) -> int:
    return c.execute('SELECT COUNT(*) FROM space_members WHERE space_id = ? AND removed_at IS NULL AND user_id != ?', (a.family, a.user_id)).fetchone()[0]


def _need_confirm(c: sqlite3.Connection, a: Access, confirm: bool) -> None:
    n = _others(c, a)
    if n and not confirm:
        raise FamilyError('confirmation_required', f'Cette action concerne {n} autre(s) membre(s) de la famille : confirmation nécessaire.', 409)


def _bump(c: sqlite3.Connection, sid: str, rid: str, user: str) -> int:
    """Nouvelle révision sans changer le contenu (verrou) : les autres appareils sont prévenus."""
    from .db import Database as _D

    rev = _D.next_rev(c)
    c.execute("UPDATE records SET rev = ?, updated_at = ? WHERE space_id = ? AND collection = 'recipes' AND id = ?", (rev, now(), sid, rid))
    return rev


# --- Verrou ------------------------------------------------------------------

def set_lock(db: Database, a: Access, rid: str, locked: bool) -> dict:
    sid = _fam(a)
    with db.tx() as c:
        r = _recipe(c, sid, rid)
        if r['created_by'] != a.user_id and not a.is_admin:
            raise FamilyError('forbidden', 'Seul l’auteur (ou l’administrateur) peut verrouiller cette recette.', 403)
        if r['locked_by'] and r['locked_by'] != a.user_id and not a.is_admin:
            raise FamilyError('locked', 'Verrou posé par un autre membre.', 403)
        c.execute("UPDATE records SET locked_by = ? WHERE space_id = ? AND collection = 'recipes' AND id = ?", (a.user_id if locked else None, sid, rid))
        _bump(c, sid, rid, a.user_id)
        return server_version(c, a, c.execute("SELECT * FROM records WHERE space_id = ? AND collection = 'recipes' AND id = ?", (sid, rid)).fetchone())


# --- Corbeille ---------------------------------------------------------------

def trash_list(db: Database, a: Access) -> list[dict]:
    sid = _fam(a)
    out, cache = [], {}
    with db.tx() as c:
        for r in c.execute("SELECT * FROM records WHERE space_id = ? AND collection = 'recipes' AND deleted = 0 AND trashed_at IS NOT NULL ORDER BY trashed_at DESC", (sid,)).fetchall():
            by = c.execute('SELECT login, display_name FROM users WHERE id = ?', (r['trashed_by'],)).fetchone()
            out.append({
                'id': r['id'], 'title': json.loads(r['data']).get('title', ''), 'trashedAt': r['trashed_at'],
                'trashedBy': {'login': by['login'], 'name': by['display_name']} if by else None,
                'purgeAt': r['trashed_at'] + TRASH_DAYS * 86400, **{'info': info(c, r, cache)},
            })
    return out


def restore(db: Database, a: Access, rid: str) -> dict:
    sid = _fam(a)
    with db.tx() as c:
        r = _recipe(c, sid, rid)
        if not r['trashed_at']:
            raise FamilyError('not_trashed', 'Cette recette n’est pas dans la corbeille.', 409)
        moved_out = c.execute("SELECT 1 FROM history WHERE space_id = ? AND collection = 'recipes' AND id = ? AND rev = ? AND kind = 'move-out'", (sid, rid, r['rev'])).fetchone()
        if moved_out:
            # Recette retirée du catalogue par son auteur (qui en garde une copie personnelle sous le
            # même identifiant) : la recette restaurée reçoit un nouvel identifiant ; les favoris et
            # notes personnelles des membres la suivent.
            new_rid = new_id('r')
            data = {**json.loads(r['data']), 'id': new_rid}
            write_family(c, sid, new_rid, a.user_id, canon(data), 'restore')
            for m in c.execute("SELECT s.id FROM space_members m JOIN spaces s ON s.owner_id = m.user_id AND s.kind = 'personal' WHERE m.space_id = ? AND m.removed_at IS NULL", (sid,)).fetchall():
                meta = c.execute("SELECT data FROM records WHERE space_id = ? AND collection = 'recipeMeta' AND id = ? AND deleted = 0", (m['id'], rid)).fetchone()
                if meta:
                    write_simple(c, m['id'], 'recipeMeta', new_rid, a.user_id, canon({**json.loads(meta['data']), 'id': new_rid}))
            return {'id': new_rid}
        write_family(c, sid, rid, a.user_id, r['data'], 'restore', r)
        return {'id': rid}


def purge(db: Database, a: Access, rid: str) -> None:
    """Suppression DÉFINITIVE (administrateur, recette déjà dans la corbeille)."""
    sid = _fam(a)
    if not a.is_admin:
        raise FamilyError('forbidden', 'Suppression définitive réservée à l’administrateur.', 403)
    with db.tx() as c:
        r = _recipe(c, sid, rid)
        if not r['trashed_at']:
            raise FamilyError('not_trashed', 'Mettez d’abord la recette à la corbeille.', 409)
        _purge(c, sid, rid, a.user_id)


def _purge(c: sqlite3.Connection, sid: str, rid: str, user: str | None) -> None:
    write_simple(c, sid, 'recipes', rid, user or '', None)
    c.execute("UPDATE records SET trashed_at = NULL, trashed_by = NULL, locked_by = NULL WHERE space_id = ? AND collection = 'recipes' AND id = ?", (sid, rid))
    c.execute("DELETE FROM history WHERE space_id = ? AND collection = 'recipes' AND id = ?", (sid, rid))
    c.execute("DELETE FROM conflicts WHERE space_id = ? AND collection = 'recipes' AND record_id = ?", (sid, rid))


def auto_purge(db: Database) -> int:
    """Tâche nocturne : corbeille vidée après 30 jours."""
    limit = now() - TRASH_DAYS * 86400
    rows = db.q("SELECT space_id, id FROM records WHERE collection = 'recipes' AND deleted = 0 AND trashed_at IS NOT NULL AND trashed_at < ?", (limit,))
    for r in rows:
        with db.tx() as c:
            _purge(c, r['space_id'], r['id'], None)
    return len(rows)


# --- Historique --------------------------------------------------------------

def history_list(db: Database, a: Access, rid: str) -> list[dict]:
    sid = _fam(a)
    rows = db.q("SELECT h.rev, h.kind, h.at, u.login, u.display_name FROM history h LEFT JOIN users u ON u.id = h.author_id WHERE h.space_id = ? AND h.collection = 'recipes' AND h.id = ? ORDER BY h.rev DESC, h.kind", (sid, rid))
    return [{'rev': r['rev'], 'kind': r['kind'], 'at': r['at'], 'by': {'login': r['login'], 'name': r['display_name']} if r['login'] else None} for r in rows]


def history_get(db: Database, a: Access, rid: str, rev: int, kind: str = 'edit') -> dict:
    sid = _fam(a)
    r = db.one("SELECT data FROM history WHERE space_id = ? AND collection = 'recipes' AND id = ? AND rev = ? AND kind = ?", (sid, rid, rev, kind))
    if not r or r['data'] is None:
        raise FamilyError('not_found', 'Version introuvable.', 404)
    return json.loads(r['data'])


def revert(db: Database, a: Access, rid: str, rev: int) -> dict:
    """Revenir à une version : elle devient la version actuelle (l'actuelle reste dans l'historique)."""
    sid = _fam(a)
    with db.tx() as c:
        r = _recipe(c, sid, rid)
        _can_edit(a, r)
        old = history_data(c, sid, 'recipes', rid, rev)
        if old is None:
            raise FamilyError('not_found', 'Version introuvable (50 dernières conservées).', 404)
        new_rev = write_family(c, sid, rid, a.user_id, canon(old), 'revert', r)
        return {'rev': new_rev}


# --- Conflits ----------------------------------------------------------------

def conflicts_list(db: Database, a: Access) -> list[dict]:
    sid = _fam(a)
    rows = db.q("SELECT c.*, u.login, u.display_name FROM conflicts c JOIN users u ON u.id = c.author_id WHERE c.space_id = ? AND c.status = 'open' ORDER BY c.created_at", (sid,))
    return [{
        'id': r['id'], 'recipeId': r['record_id'], 'createdAt': r['created_at'], 'by': {'login': r['login'], 'name': r['display_name']},
        'items': json.loads(r['items']), 'mine': json.loads(r['mine']),
    } for r in rows]


def resolve(db: Database, a: Access, cid: str, data: dict | None, base_rev: int | None) -> dict:
    """Résolution manuelle : `data` = version choisie (à partir de la révision actuelle `base_rev`),
    ou rien pour garder la version actuelle. La version écartée reste dans l'historique."""
    sid = _fam(a)
    with db.tx() as c:
        k = c.execute("SELECT * FROM conflicts WHERE id = ? AND space_id = ?", (cid, sid)).fetchone()
        if not k:
            raise FamilyError('not_found', 'Conflit introuvable.', 404)
        if k['status'] != 'open':
            return {'status': k['status']}
        rev = None
        if data is not None:
            r = _recipe(c, sid, k['record_id'])
            _can_edit(a, r)
            if base_rev != r['rev']:
                raise FamilyError('stale', 'La recette a encore changé : rechargez avant de choisir.', 409)
            rev = write_family(c, sid, k['record_id'], a.user_id, canon(family_part({**data, 'id': k['record_id']})), 'resolve', r)
        c.execute("UPDATE conflicts SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ?", (a.user_id, now(), cid))
        if rev is None:  # les autres appareils mettent à jour le compteur de conflits
            _bump(c, sid, k['record_id'], a.user_id)
        return {'status': 'resolved', 'rev': rev}


# --- Déplacements entre espaces ------------------------------------------------

def _photo_ids(data: dict) -> list[str]:
    ids = [data.get('mainPhotoId'), *(data.get('galleryPhotoIds') or []), *[st.get('photoId') for st in data.get('steps') or [] if isinstance(st, dict)]]
    return list(dict.fromkeys(i for i in ids if i))


def _remap(data: dict, m: dict[str, str]) -> dict:
    if not m:
        return data
    return {
        **data,
        'mainPhotoId': m.get(data.get('mainPhotoId'), data.get('mainPhotoId')),
        'galleryPhotoIds': [m.get(x, x) for x in data.get('galleryPhotoIds') or []],
        'steps': [{**st, 'photoId': m.get(st.get('photoId'), st.get('photoId'))} if isinstance(st, dict) else st for st in data.get('steps') or []],
    }


def _carry_photos(c, s: Settings, a: Access, src: str, dst: str, data: dict, rid: str, keep_ids: bool) -> dict:
    """Photos de la recette vers l'autre espace : déplacées (même identifiant) si elles ne servent
    qu'à cette recette et `keep_ids`, sinon copiées sous un nouvel identifiant. Fichiers copiés."""
    mapping = {}
    for pid in _photo_ids(data):
        rec = c.execute("SELECT data FROM records WHERE space_id = ? AND collection = 'photos' AND id = ? AND deleted = 0", (src, pid)).fetchone()
        if not rec:
            continue
        pd = json.loads(rec['data'])
        for sha in {pd.get('sha256'), pd.get('thumbSha256')} - {None, ''}:
            b = c.execute('SELECT mime FROM blobs WHERE space_id = ? AND sha256 = ?', (src, sha)).fetchone()
            if b:
                copy_blob(c, s, blob_path(s, src, sha), dst, sha, b['mime'])
        exclusive = keep_ids and not photo_in_use(c, src, pid, except_id=rid)
        new_pid = pid if exclusive else new_id('ph')
        if exclusive:
            write_simple(c, src, 'photos', pid, a.user_id, None)  # retirée de l'espace d'origine (avant la création : ordre des révisions)
        write_simple(c, dst, 'photos', new_pid, a.user_id, canon({**pd, 'id': new_pid}))
        if new_pid != pid:
            mapping[pid] = new_pid
    return _remap(data, mapping)


def move(db: Database, s: Settings, a: Access, rid: str, to: str, confirm: bool) -> dict:
    fid = _fam(a)
    with db.tx() as c:
        if to == 'family':
            _need_confirm(c, a, confirm)
            cur = c.execute("SELECT * FROM records WHERE space_id = ? AND collection = 'recipes' AND id = ? AND deleted = 0", (a.personal, rid)).fetchone()
            if not cur:
                raise FamilyError('not_found', 'Recette personnelle introuvable.', 404)
            if c.execute("SELECT 1 FROM records WHERE space_id = ? AND collection = 'recipes' AND id = ? AND deleted = 0 AND trashed_at IS NULL", (fid, rid)).fetchone():
                raise FamilyError('exists', 'Déjà dans le catalogue familial.', 409)
            full = json.loads(cur['data'])
            write_simple(c, a.personal, 'recipes', rid, a.user_id, None)
            shared = _carry_photos(c, s, a, a.personal, fid, family_part(full), rid, keep_ids=True)
            fam = c.execute("SELECT * FROM records WHERE space_id = ? AND collection = 'recipes' AND id = ?", (fid, rid)).fetchone()
            if fam:  # ancienne recette de la corbeille au même identifiant : remplacée (reste dans l'historique)
                c.execute("UPDATE records SET created_by = ?, locked_by = NULL WHERE space_id = ? AND collection = 'recipes' AND id = ?", (a.user_id, fid, rid))
            write_family(c, fid, rid, a.user_id, canon(shared), 'move-in', fam)
            write_simple(c, a.personal, 'recipeMeta', rid, a.user_id, canon({'id': rid, **personal_part(full)}))
            return {'id': rid, 'space': 'family'}
        if to == 'personal':
            r = _recipe(c, fid, rid)
            if r['trashed_at']:
                raise FamilyError('not_found', 'Recette dans la corbeille.', 404)
            if r['created_by'] != a.user_id and not a.is_admin:
                raise FamilyError('forbidden', 'Seul l’auteur ou l’administrateur peut retirer cette recette du catalogue. Vous pouvez en faire une copie personnelle.', 403)
            _can_edit(a, r)
            _need_confirm(c, a, confirm)
            meta = c.execute("SELECT data FROM records WHERE space_id = ? AND collection = 'recipeMeta' AND id = ? AND deleted = 0", (a.personal, rid)).fetchone()
            # Retirée du catalogue = corbeille familiale (les autres peuvent la restaurer 30 jours).
            trash_family(c, fid, rid, a.user_id, r['data'], 'move-out')
            full = join(_carry_photos(c, s, a, fid, a.personal, json.loads(r['data']), rid, keep_ids=False), json.loads(meta['data']) if meta else None)
            write_simple(c, a.personal, 'recipes', rid, a.user_id, canon(full))
            if meta:
                write_simple(c, a.personal, 'recipeMeta', rid, a.user_id, None)
            return {'id': rid, 'space': 'personal'}
    raise FamilyError('invalid_space', 'Destination inconnue.', 422)


# --- Conversion du catalogue familial en carnets privés (commande d'administration) ---------

def _pid(*parts: str) -> str:
    import hashlib

    return hashlib.sha256(':'.join(parts).encode()).hexdigest()[:20]


def privatize(db: Database, s: Settings, apply: bool = False) -> dict:
    """Copie PRIVÉE et indépendante de chaque recette familiale pour chaque membre actif : fiche,
    photos (fichiers copiés), et ses propres favoris / note / notes personnelles ; son journal, ses
    collections et ses publications sont rattachés à sa copie.
    Rien n'est supprimé ni déplacé : le catalogue familial reste intact (retrait ultérieur, à part).
    Simulation par défaut ; `apply` écrit. Rejouable sans doublon (identifiants déterministes)."""
    from .spaces import family_id

    fid = family_id(db)
    if not fid:
        return {'members': [], 'recipes': 0}
    recipes = db.q("SELECT id, data FROM records WHERE space_id = ? AND collection = 'recipes' AND deleted = 0 AND trashed_at IS NULL ORDER BY id", (fid,))
    members = db.q("SELECT u.id AS uid, u.login, s.id AS pid FROM space_members m JOIN users u ON u.id = m.user_id JOIN spaces s ON s.owner_id = u.id AND s.kind = 'personal' WHERE m.space_id = ? AND m.removed_at IS NULL ORDER BY u.login", (fid,))
    report = {'recipes': len(recipes), 'apply': apply, 'members': []}
    for m in members:
        mine = {'login': m['login'], 'copies': 0, 'already': 0, 'photos': 0, 'relinked': 0}
        with db.tx() as c:
            for r in recipes:
                new_id = f"rp_{_pid(m['uid'], r['id'])}"
                if c.execute("SELECT 1 FROM records WHERE space_id = ? AND collection = 'recipes' AND id = ? AND deleted = 0", (m['pid'], new_id)).fetchone():
                    mine['already'] += 1
                    continue
                shared = json.loads(r['data'])
                meta = c.execute("SELECT data FROM records WHERE space_id = ? AND collection = 'recipeMeta' AND id = ? AND deleted = 0", (m['pid'], r['id'])).fetchone()
                mapping = {}
                for pid in _photo_ids(shared):
                    rec = c.execute("SELECT data FROM records WHERE space_id = ? AND collection = 'photos' AND id = ? AND deleted = 0", (fid, pid)).fetchone()
                    if not rec:
                        continue
                    npid = f"pp_{_pid(m['uid'], pid)}"
                    mapping[pid] = npid
                    mine['photos'] += 1
                    if apply:
                        pd = json.loads(rec['data'])
                        for sha in {pd.get('sha256'), pd.get('thumbSha256')} - {None, ''}:
                            b = c.execute('SELECT mime FROM blobs WHERE space_id = ? AND sha256 = ?', (fid, sha)).fetchone()
                            if b:
                                copy_blob(c, s, blob_path(s, fid, sha), m['pid'], sha, b['mime'])
                        write_simple(c, m['pid'], 'photos', npid, m['uid'], canon({**pd, 'id': npid}))
                data = {**join(_remap(shared, mapping), json.loads(meta['data']) if meta else None), 'id': new_id, 'copiedFromFamily': {'recipeId': r['id'], 'at': now()}}
                mine['copies'] += 1
                if not apply:
                    continue
                write_simple(c, m['pid'], 'recipes', new_id, m['uid'], canon(data))
                # Son journal, ses collections, ses publications suivent sa copie.
                for coll, fix in (('journal', 'recipeId'), ('posts', 'recipeId'), ('collections', 'recipeIds')):
                    for row in c.execute('SELECT id, data FROM records WHERE space_id = ? AND collection = ? AND deleted = 0 AND instr(data, ?) > 0', (m['pid'], coll, json.dumps(r['id']))).fetchall():
                        d = json.loads(row['data'])
                        if fix == 'recipeIds' and r['id'] in (d.get('recipeIds') or []):
                            d['recipeIds'] = [new_id if x == r['id'] else x for x in d['recipeIds']]
                        elif d.get(fix) == r['id']:
                            d[fix] = new_id
                        else:
                            continue
                        write_simple(c, m['pid'], coll, row['id'], m['uid'], canon(d))
                        mine['relinked'] += 1
        report['members'].append(mine)
    return report
