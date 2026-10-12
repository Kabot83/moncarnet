"""Carnet Sync : tests automatisés du serveur (HTTP réel en mémoire via TestClient, SQLite réel)."""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import admin, auth
from app.backup import check, create_backup, nightly, restore, restore_test, rotate, verify_backup
from app.config import Settings
from app.db import Database
from app.main import create_app
from app.transfers import cleanup_frozen

os.environ['SYNC_SCHEDULER'] = '0'  # pas de tâche nocturne pendant les tests

PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000') + b'\x00' * 64


def settings(d: Path, **kw) -> Settings:
    base = dict(data_dir=d, access_ttl_s=3600, refresh_ttl_s=86400, transfer_ttl_s=30 * 86400, max_record_bytes=512 * 1024, max_blob_bytes=5 * 2**20, max_user_bytes=2**30, cors_origins=('https://localhost',))
    base.update(kw)
    return Settings(**base)


@pytest.fixture
def srv(tmp_path):
    s = settings(tmp_path)
    app = create_app(s)
    c = TestClient(app)
    db: Database = app.state.db
    auth.create_user(db, 'alice', 'Alice', 'mot-de-passe-alice')
    auth.create_user(db, 'bob', 'Bob', 'mot-de-passe-bob1')

    def login(user: str, pw: str | None = None, device: str = 'test') -> dict:
        r = c.post('/v1/auth/login', json={'login': user, 'password': pw or f'mot-de-passe-{user}' + ('1' if user == 'bob' else ''), 'device': device})
        assert r.status_code == 200, r.text
        return r.json()

    return c, db, s, login


def H(t: dict) -> dict:
    return {'Authorization': f"Bearer {t['access_token']}"}


def recipe(rid: str, title: str, **kw) -> dict:
    return {
        'id': rid, 'title': title, 'description': 'Une soupe', 'servings': 4, 'prepTime': 15, 'cookTime': 40, 'tags': ['hiver'],
        'ingredients': [{'id': 'i1', 'name': 'oignon', 'quantity': 4, 'unit': '', 'nutrition': {'food': {'source': 'ciqual', 'id': '20034', 'name': 'Oignon, cru'}, 'gramsPerUnit': 150}}],
        'steps': [{'id': 's1', 'text': 'Émincer', 'photoId': None}],
        'notes': {'tips': 'Bien caraméliser', 'modifications': 'Ma version perso', 'mistakes': '', 'ideas': '', 'storage': '', 'reheating': ''},
        'favorite': True, 'rating': 5, 'cookCount': 3, 'lastCookedAt': 1, 'mainPhotoId': None, 'galleryPhotoIds': [], **kw,
    }


def push(c, t, *changes):
    r = c.post('/v1/sync/push', json={'changes': list(changes)}, headers=H(t))
    assert r.status_code == 200, r.text
    return r.json()['results']


def with_photo(c, t, pid='ph_1') -> str:
    sha = hashlib.sha256(PNG).hexdigest()
    assert c.put(f'/v1/blobs/{sha}', content=PNG, headers={**H(t), 'Content-Type': 'image/png'}).status_code == 204
    assert push(c, t, {'collection': 'photos', 'id': pid, 'base_rev': 0, 'data': {'id': pid, 'sha256': sha, 'thumbSha256': sha, 'mime': 'image/png', 'width': 1, 'height': 1}})[0]['status'] == 'ok'
    return sha


# ---------------------------------------------------------------------------
# 1–3. Comptes indépendants, isolation stricte, tentatives d'accès
# ---------------------------------------------------------------------------

def test_comptes_independants_et_isolation(srv):
    c, _, _, login = srv
    a, b = login('alice'), login('bob')
    push(c, a, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recipe('r_1', 'Soupe d’Alice')})
    assert c.get('/v1/sync/changes?since=0', headers=H(b)).json()['changes'] == []
    # Même identifiant chez Bob : enregistrement distinct, l'original d'Alice est intact.
    push(c, b, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recipe('r_1', 'Tarte de Bob')})
    assert c.get('/v1/sync/changes?since=0', headers=H(a)).json()['changes'][0]['data']['title'] == 'Soupe d’Alice'
    assert [x['data']['title'] for x in c.get('/v1/sync/changes?since=0', headers=H(b)).json()['changes']] == ['Tarte de Bob']


def test_tentatives_acces_aux_donnees_d_un_autre(srv):
    c, _, _, login = srv
    a, b = login('alice'), login('bob')
    sha = with_photo(c, a)
    push(c, a, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recipe('r_1', 'Secret d’Alice')})
    # Lecture du fichier d'Alice avec la session de Bob : refusée (même empreinte connue).
    assert c.get(f'/v1/blobs/{sha}', headers=H(b)).status_code == 404
    # Tentative de suppression / d'écrasement : ne touche que l'espace de Bob.
    push(c, b, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'deleted': True})
    push(c, b, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 1, 'data': recipe('r_1', 'pirate')})
    assert c.get('/v1/sync/changes?since=0', headers=H(a)).json()['changes'][-1]['data']['title'] == 'Secret d’Alice'
    # Champ « propriétaire » injecté par le téléphone : ignoré (l'identité vient de la session).
    push(c, b, {'collection': 'recipes', 'id': 'r_2', 'base_rev': 0, 'owner_id': 'u_alice', 'data': recipe('r_2', 'x')})
    assert all(x['id'] != 'r_2' for x in c.get('/v1/sync/changes?since=0', headers=H(a)).json()['changes'])
    # Photo de Bob pointant vers le fichier d'Alice : refusée tant que Bob ne possède pas ce fichier.
    r = push(c, b, {'collection': 'photos', 'id': 'ph_x', 'base_rev': 0, 'data': {'id': 'ph_x', 'sha256': sha}})
    assert r[0]['status'] == 'missing_blob'
    # Sans jeton, faux jeton, collection hors liste.
    assert c.get('/v1/sync/changes').status_code == 401
    assert c.get('/v1/sync/changes', headers={'Authorization': 'Bearer mca_faux'}).status_code == 401
    assert push(c, a, {'collection': 'secrets', 'id': 'k', 'base_rev': 0, 'data': {}})[0]['status'] == 'rejected'


# ---------------------------------------------------------------------------
# 6. Conflits : jamais d'écrasement silencieux ; envoi répété sans doublon
# ---------------------------------------------------------------------------

def test_conflit_et_idempotence(srv):
    c, _, _, login = srv
    a1, a2 = login('alice', device='téléphone'), login('alice', device='tablette')
    rev = push(c, a1, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recipe('r_1', 'v1')})[0]['rev']
    # Les deux appareils modifient la même version.
    r1 = push(c, a1, {'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': recipe('r_1', 'téléphone')})[0]
    r2 = push(c, a2, {'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': recipe('r_1', 'tablette')})[0]
    assert r1['status'] == 'ok' and r2['status'] == 'conflict'
    assert r2['server']['data']['title'] == 'téléphone' and r2['server']['rev'] == r1['rev']
    # Renvoi identique après une coupure : succès, aucune nouvelle révision.
    again = push(c, a1, {'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': recipe('r_1', 'téléphone')})[0]
    assert again == {'collection': 'recipes', 'id': 'r_1', 'status': 'ok', 'rev': r1['rev']}
    # Suppression transmise comme un enregistrement (tombstone).
    push(c, a1, {'collection': 'recipes', 'id': 'r_1', 'base_rev': r1['rev'], 'deleted': True})
    last = c.get('/v1/sync/changes?since=0', headers=H(a2)).json()['changes'][-1]
    assert last['deleted'] is True and last['data'] is None


def test_synchronisation_incrementale(srv):
    c, _, _, login = srv
    a = login('alice')
    for i in range(7):
        push(c, a, {'collection': 'shopping', 'id': f'sh_{i}', 'base_rev': 0, 'data': {'id': f'sh_{i}', 'name': f'article {i}'}})
    p1 = c.get('/v1/sync/changes?since=0&page_size=5', headers=H(a)).json()
    assert len(p1['changes']) == 5 and p1['more'] is True
    p2 = c.get(f"/v1/sync/changes?since={p1['cursor']}&page_size=5", headers=H(a)).json()
    assert len(p2['changes']) == 2 and p2['more'] is False


# ---------------------------------------------------------------------------
# 7–13. Envoi d'une recette par copie
# ---------------------------------------------------------------------------

def test_envoi_par_copie_independante(srv):
    c, db, s, login = srv
    a, b = login('alice'), login('bob')
    sha = with_photo(c, a, 'ph_main')
    rev = push(c, a, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recipe('r_1', 'Soupe à l’oignon', mainPhotoId='ph_main')})[0]['rev']
    push(c, a, {'collection': 'journal', 'id': 'j_1', 'base_rev': 0, 'data': {'id': 'j_1', 'recipeId': 'r_1', 'comment': 'Journal privé'}})

    # Recherche exacte du destinataire uniquement (aucune liste).
    assert c.get('/v1/users/lookup?login=bob', headers=H(a)).json() == {'login': 'bob', 'display_name': 'Bob'}
    assert c.get('/v1/users/lookup?login=bo', headers=H(a)).status_code == 404
    t = c.post('/v1/transfers', json={'recipient': 'bob', 'id': 'r_1', 'include_tips': True}, headers=H(a)).json()

    # 11. L'original est modifié puis supprimé après l'envoi : la recette reçue reste celle de l'envoi.
    rev2 = push(c, a, {'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': recipe('r_1', 'Titre modifié après envoi')})[0]['rev']
    push(c, a, {'collection': 'recipes', 'id': 'r_1', 'base_rev': rev2, 'deleted': True})

    inbox = c.get('/v1/transfers/inbox', headers=H(b)).json()
    assert [(x['title'], x['sender']['login'], x['has_cover']) for x in inbox] == [('Soupe à l’oignon', 'alice', True)]
    cov = c.get(f"/v1/transfers/{t['id']}/cover", headers=H(b))
    assert cov.status_code == 200 and cov.headers['content-type'] == 'image/png' and cov.content == PNG  # format réel de la miniature

    acc = c.post(f"/v1/transfers/{t['id']}/accept", headers=H(b)).json()
    # 9. Acceptation répétée : même copie, aucun doublon.
    assert c.post(f"/v1/transfers/{t['id']}/accept", headers=H(b)).json() == {'id': acc['id'], 'already': True}
    got = {x['id']: x for x in c.get('/v1/sync/changes?since=0', headers=H(b)).json()['changes']}
    copy = got[acc['id']]['data']
    assert copy['title'] == 'Soupe à l’oignon' and copy['description'] == 'Une soupe' and copy['servings'] == 4 and copy['cookTime'] == 40
    # 12. Nutrition et photos conservées ; la photo est une copie appartenant à Bob.
    assert copy['ingredients'][0]['nutrition']['food']['id'] == '20034'
    assert copy['mainPhotoId'] in got and got[copy['mainPhotoId']]['data']['sha256'] == sha
    assert c.get(f'/v1/blobs/{sha}', headers=H(b)).status_code == 200
    # 13. Notes privées, favori, note, réalisations : jamais transférés ; astuces partagées sur demande.
    assert copy['notes'] == {'tips': 'Bien caraméliser', 'modifications': '', 'mistakes': '', 'ideas': '', 'storage': '', 'reheating': ''}
    assert (copy['favorite'], copy['rating'], copy['cookCount'], copy['lastCookedAt']) == (False, 0, 0, None)
    assert all(x['collection'] != 'journal' for x in got.values())
    assert copy['receivedFrom']['login'] == 'alice'
    # 10. Copie indépendante : Bob la modifie, l'espace d'Alice n'est pas touché, et inversement.
    push(c, b, {'collection': 'recipes', 'id': acc['id'], 'base_rev': got[acc['id']]['rev'], 'data': {**copy, 'title': 'Ma soupe (Bob)'}})
    assert all(x['id'] != acc['id'] for x in c.get('/v1/sync/changes?since=0', headers=H(a)).json()['changes'])
    # Les fichiers figés restent jusqu'à la maintenance nocturne (après la sauvegarde), puis disparaissent.
    assert (s.data_dir / 'transfers' / t['id']).exists()
    assert cleanup_frozen(db, s) == 1 and not (s.data_dir / 'transfers' / t['id']).exists()


def test_refus_expiration_et_usurpation(srv):
    c, db, s, login = srv
    a, b = login('alice'), login('bob')
    push(c, a, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recipe('r_1', 'Tarte')})
    t = c.post('/v1/transfers', json={'recipient': 'bob', 'id': 'r_1'}, headers=H(a)).json()
    # 8. Refus : rien n'est créé chez Bob ; l'invitation ne peut plus être acceptée.
    assert c.post(f"/v1/transfers/{t['id']}/decline", headers=H(b)).status_code == 204
    assert c.post(f"/v1/transfers/{t['id']}/accept", headers=H(b)).status_code == 409
    assert c.get('/v1/sync/changes?since=0', headers=H(b)).json()['changes'] == []
    # Un tiers (Alice elle-même, ou un autre compte) ne peut ni voir ni accepter l'invitation.
    t2 = c.post('/v1/transfers', json={'recipient': 'bob', 'id': 'r_1'}, headers=H(a)).json()
    assert c.post(f"/v1/transfers/{t2['id']}/accept", headers=H(a)).status_code == 404
    assert c.get(f"/v1/transfers/{t2['id']}/cover", headers=H(a)).status_code == 404
    # Bob ne peut pas envoyer la recette d'Alice (lue dans SON espace) ni se l'envoyer.
    assert c.post('/v1/transfers', json={'recipient': 'alice', 'id': 'r_1'}, headers=H(b)).status_code == 404
    assert c.post('/v1/transfers', json={'recipient': 'alice', 'id': 'r_1'}, headers=H(a)).status_code == 404
    # Expiration : après 30 jours, l'invitation disparaît et ne peut plus être acceptée.
    db.x("UPDATE transfers SET expires_at = ? WHERE id = ?", (int(time.time()) - 1, t2['id']))
    assert c.get('/v1/transfers/inbox', headers=H(b)).json() == []
    assert c.post(f"/v1/transfers/{t2['id']}/accept", headers=H(b)).status_code == 409


def test_publication_tiktok_partagee_sans_video(srv):
    c, _, _, login = srv
    a, b = login('alice'), login('bob')
    post = {'id': 'p_1', 'platform': 'tiktok', 'url': 'https://www.tiktok.com/@chef/video/7301234567890123456', 'title': 'Pâtes', 'description': 'Légende',
            'notes': 'note privée', 'video': {'name': 'tiktok-7301.mp4', 'bytes': 20_000_000}, 'favorite': True}
    push(c, a, {'collection': 'posts', 'id': 'p_1', 'base_rev': 0, 'data': post})
    t = c.post('/v1/transfers', json={'recipient': 'bob', 'kind': 'post', 'id': 'p_1'}, headers=H(a)).json()
    acc = c.post(f"/v1/transfers/{t['id']}/accept", headers=H(b)).json()
    copy = next(x['data'] for x in c.get('/v1/sync/changes?since=0', headers=H(b)).json()['changes'] if x['id'] == acc['id'])
    assert copy['url'] == post['url'] and copy['title'] == 'Pâtes' and copy['video'] is None and copy['notes'] == '' and copy['favorite'] is False


# ---------------------------------------------------------------------------
# Comptes et sessions
# ---------------------------------------------------------------------------

def test_sessions_rotation_revocation_tentatives(srv):
    c, db, _, login = srv
    t = login('alice')
    r1 = c.post('/v1/auth/refresh', json={'refresh_token': t['refresh_token']}).json()
    assert r1['access_token'] != t['access_token']
    # Ancien jeton d'accès invalidé, ancien jeton de renouvellement réutilisé → session révoquée.
    assert c.get('/v1/me', headers=H(t)).status_code == 401
    assert c.post('/v1/auth/refresh', json={'refresh_token': t['refresh_token']}).json()['error'] == 'session_revoked'
    assert c.get('/v1/me', headers=H(r1)).status_code == 401
    # Déconnexion et révocation d'une autre session.
    t2, t3 = login('alice', device='a'), login('alice', device='b')
    assert c.delete(f"/v1/sessions/{t3['session_id']}", headers=H(t2)).status_code == 204
    assert c.get('/v1/me', headers=H(t3)).status_code == 401
    # Bob ne peut pas révoquer une session d'Alice.
    tb = login('bob')
    assert c.delete(f"/v1/sessions/{t2['session_id']}", headers=H(tb)).status_code == 404
    # Mot de passe : message identique pour un identifiant inconnu ; 5 échecs → attente.
    bad = c.post('/v1/auth/login', json={'login': 'inconnu', 'password': 'x'}).json()
    assert bad['error'] == 'bad_credentials'
    for _ in range(5):
        c.post('/v1/auth/login', json={'login': 'alice', 'password': 'faux'})
    assert c.post('/v1/auth/login', json={'login': 'alice', 'password': 'mot-de-passe-alice'}).status_code == 429
    stored = db.one("SELECT password_hash FROM users WHERE login = 'alice'")['password_hash']
    assert stored.startswith('$argon2id$') and 'mot-de-passe' not in stored


def test_aucune_inscription_publique_invitation_unique(srv):
    c, db, _, _ = srv
    assert c.post('/v1/auth/register', json={'invite': 'inv_faux', 'login': 'eve', 'password': 'mot-de-passe-eve'}).status_code == 403
    code = auth.create_invite(db, 'Compte de Julie')
    r = c.post('/v1/auth/register', json={'invite': code, 'login': 'julie', 'display_name': 'Julie', 'password': 'mot-de-passe-julie'})
    assert r.status_code == 200 and r.json()['user']['login'] == 'julie'
    assert c.post('/v1/auth/register', json={'invite': code, 'login': 'julie2', 'password': 'mot-de-passe-julie'}).status_code == 403


# ---------------------------------------------------------------------------
# 15. Sauvegarde et restauration du serveur
# ---------------------------------------------------------------------------

def test_sauvegarde_versions_verification_restauration(srv, tmp_path):
    c, db, s, login = srv
    a, b = login('alice'), login('bob')
    sha = with_photo(c, a)
    push(c, a, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recipe('r_1', 'Soupe', mainPhotoId='ph_1')})
    t = c.post('/v1/transfers', json={'recipient': 'bob', 'id': 'r_1'}, headers=H(a)).json()  # invitation en attente
    root = tmp_path / 'sauvegardes'

    # Écritures simultanées pendant la sauvegarde (mode WAL) : l'instantané reste cohérent.
    stop = threading.Event()

    def writer():
        n = 0
        while not stop.is_set():
            n += 1
            push(c, b, {'collection': 'shopping', 'id': f'sh_{n}', 'base_rev': 0, 'data': {'id': f'sh_{n}', 'name': 'x'}})

    th = threading.Thread(target=writer)
    th.start()
    try:
        r1 = create_backup(s, db, root)
    finally:
        stop.set()
        th.join()
    assert r1['ok'], r1
    time.sleep(1.1)  # nom de version à la seconde
    r2 = create_backup(s, db, root)
    b1, b2 = root / r1['backup'], root / r2['backup']
    owner = db.one('SELECT owner_id FROM blobs')['owner_id']
    rel = f'files/{owner}/{sha[:2]}/{sha}'
    # Photo inchangée : reliée à la version précédente (pas d'espace en double), chaque version reste complète.
    assert (b2 / rel).read_bytes() == PNG and os.path.samefile(b1 / rel, b2 / rel)
    assert verify_backup(b1)['ok'] and verify_backup(b2)['ok']
    assert (b2 / 'transfers' / t['id']).is_dir()  # fichiers de l'invitation en attente sauvegardés

    # Restauration à blanc : contrôlée puis effacée ; rien n'est modifié.
    rt = restore_test(b2, tmp_path / 'essai')
    assert rt['ok'] and rt['counts']['users'] == 2 and not (tmp_path / 'essai').exists()

    # Serveur perdu → dossier vide → restauration vérifiée → tout est là, invitation comprise.
    s2 = settings(tmp_path / 'nouveau-nas')
    restore(s2, b2)
    c2 = TestClient(create_app(s2))
    ta = c2.post('/v1/auth/login', json={'login': 'alice', 'password': 'mot-de-passe-alice'}).json()
    tb = c2.post('/v1/auth/login', json={'login': 'bob', 'password': 'mot-de-passe-bob1'}).json()
    assert c2.get(f'/v1/blobs/{sha}', headers=H(ta)).content == PNG
    assert c2.post(f"/v1/transfers/{t['id']}/accept", headers=H(tb)).status_code == 200

    # Sauvegarde altérée : détectée ; restauration refusée ; jamais par-dessus une base existante.
    (b1 / rel).unlink()  # le lien physique est rompu : seule la version 1 est altérée
    (b1 / rel).write_bytes(b'altere')
    assert not verify_backup(b1)['ok'] and verify_backup(b2)['ok']
    with pytest.raises(SystemExit, match='corrompue'):
        restore(settings(tmp_path / 'autre'), b1)
    with pytest.raises(SystemExit):
        restore(s2, b2)


def test_rotation_des_versions(tmp_path):
    from datetime import datetime, timedelta

    root = tmp_path / 'r'
    start = datetime(2026, 10, 12, 3, 15)
    for d in range(60):  # 60 nuits
        p = root / ('carnet-sync-' + (start - timedelta(days=d)).strftime('%Y%m%d-%H%M%S'))
        p.mkdir(parents=True)
        (p / 'manifest.json').write_text('{}')
    rotate(root, 14, 8)
    kept = sorted(p.name for p in root.iterdir())
    assert len(kept) == 14 + 8 and kept[-1].endswith('20261012-031500')


def test_coherence_base_et_fichiers(srv):
    c, db, s, login = srv
    a = login('alice')
    sha = with_photo(c, a)
    dbf = s.data_dir / 'carnet-sync.sqlite3'
    assert check(dbf, s.data_dir, full=True)['ok']
    owner = db.one('SELECT owner_id FROM blobs')['owner_id']
    f = s.data_dir / 'files' / owner / sha[:2] / sha
    f.write_bytes(PNG[:-1] + b'!')  # même taille, contenu altéré
    r = check(dbf, s.data_dir, full=True)
    assert not r['ok'] and 'altéré' in r['errors'][0]
    f.unlink()
    r = check(dbf, s.data_dir)
    assert not r['ok'] and 'manquant' in r['errors'][0]


def test_tache_nocturne(srv, tmp_path):
    c, db, s, login = srv
    s2 = settings(s.data_dir, backup_dir=tmp_path / 'b')
    a, b = login('alice'), login('bob')
    push(c, a, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recipe('r_1', 'Soupe')})
    with_photo(c, a)
    push(c, a, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 1, 'data': recipe('r_1', 'Soupe', mainPhotoId='ph_1')})
    t = c.post('/v1/transfers', json={'recipient': 'bob', 'id': 'r_1'}, headers=H(a)).json()
    c.post(f"/v1/transfers/{t['id']}/decline", headers=H(b))
    st = nightly(s2, db)
    assert st['ok'] and st['cleaned_transfers'] == 1  # fichiers figés supprimés APRÈS la sauvegarde
    assert json.loads((tmp_path / 'b' / 'etat.json').read_text())['ok'] is True


def test_photo_utilisee_jamais_supprimee(srv):
    """Perte locale + nettoyage des photos « orphelines » sur le téléphone : le serveur refuse."""
    c, _, _, login = srv
    a = login('alice')
    with_photo(c, a, 'ph_main')
    push(c, a, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recipe('r_1', 'Soupe', mainPhotoId='ph_main')})
    revs = {x['id']: x['rev'] for x in c.get('/v1/sync/changes?since=0', headers=H(a)).json()['changes']}
    r = push(c, a, {'collection': 'photos', 'id': 'ph_main', 'base_rev': revs['ph_main'], 'deleted': True})[0]
    assert r['status'] == 'conflict' and r['server']['data']['id'] == 'ph_main'
    # Recette supprimée d'abord (suppression volontaire) : la photo peut l'être ensuite.
    push(c, a, {'collection': 'recipes', 'id': 'r_1', 'base_rev': revs['r_1'], 'deleted': True})
    assert push(c, a, {'collection': 'photos', 'id': 'ph_main', 'base_rev': revs['ph_main'], 'deleted': True})[0]['status'] == 'ok'


def test_creation_interactive_du_compte(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv('SYNC_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(sys, 'stdin', io.StringIO('alexandre\nAlexandre\nune phrase secrète\nune phrase secrète\n'))
    admin.main(['setup'])
    out = capsys.readouterr().out
    assert 'créé' in out and 'secrète' not in out  # le mot de passe n'est jamais affiché
    db = Database(tmp_path / 'carnet-sync.sqlite3')
    assert db.one('SELECT login, display_name FROM users') == {'login': 'alexandre', 'display_name': 'Alexandre'}
    with pytest.raises(SystemExit, match='existe déjà'):
        admin.main(['setup'])
    # Trop court, puis saisies différentes, trois fois : abandon, aucun compte créé.
    monkeypatch.setattr(sys, 'stdin', io.StringIO('julie\nJulie\ncourt\ncourt\nabcdefghijk\nautre-chose\nabcdefghijk\nabcdefghijkl\n'))
    with pytest.raises(SystemExit, match='Abandon'):
        admin.main(['user', 'create'])
    assert db.one("SELECT 1 FROM users WHERE login = 'julie'") is None

def test_fichiers_controles(srv):
    c, _, _, login = srv
    a = login('alice')
    sha = hashlib.sha256(PNG).hexdigest()
    assert c.put(f'/v1/blobs/{sha}', content=b'autre contenu', headers={**H(a), 'Content-Type': 'image/png'}).json()['error'] == 'hash_mismatch'
    assert c.put(f'/v1/blobs/{sha}', content=PNG, headers={**H(a), 'Content-Type': 'text/html'}).json()['error'] == 'invalid_type'
    assert c.post('/v1/blobs/missing', json={'hashes': [sha]}, headers=H(a)).json() == {'missing': [sha]}


def test_restauration_au_redemarrage_sans_rien_effacer(tmp_path):
    """Sur le NAS : « app.admin restore » vérifie et programme ; le redémarrage applique.
    L'ancienne base est mise de côté (jamais effacée) ; une sauvegarde corrompue est refusée."""
    from app.backup import apply_pending_restore, request_restore

    root = tmp_path / 'carnet'  # = dossier partagé du NAS (data + backups)
    s = settings(root / 'data', backup_dir=root / 'backups')
    app = create_app(s)
    cl, d = TestClient(app), app.state.db
    auth.create_user(d, 'alice', 'Alice', 'mot-de-passe-alice')
    t = cl.post('/v1/auth/login', json={'login': 'alice', 'password': 'mot-de-passe-alice'}).json()
    push(cl, t, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recipe('r_1', 'Avant')})
    b = root / 'backups' / create_backup(s, d, root / 'backups')['backup']
    push(cl, t, {'collection': 'recipes', 'id': 'r_2', 'base_rev': 0, 'data': recipe('r_2', 'Après la sauvegarde')})

    assert apply_pending_restore(s) is None  # rien de demandé : rien ne bouge
    request_restore(s, b)
    d._db.close()  # arrêt du service
    r = apply_pending_restore(s)
    assert r and r['ok'] and r['counts']['records'] == 1
    aside = root / r['aside']
    assert (aside / 'carnet-sync.sqlite3').exists()  # ancienne base conservée intacte
    cl2 = TestClient(create_app(s))
    t2 = cl2.post('/v1/auth/login', json={'login': 'alice', 'password': 'mot-de-passe-alice'}).json()
    assert [x['id'] for x in cl2.get('/v1/sync/changes?since=0', headers=H(t2)).json()['changes']] == ['r_1']

    # Sauvegarde altérée : la demande est refusée d'emblée.
    (b / 'carnet-sync.sqlite3').write_bytes(b'abime')
    with pytest.raises(SystemExit, match='corrompue'):
        request_restore(s, b)
