"""Carnet Sync 0.2 : catalogue familial — espaces, droits, fusion, corbeille, historique, verrou,
déplacements, retrait d'un membre."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import auth, family, spaces
from app.backup import check, create_backup, verify_backup
from app.config import Settings
from app.db import Database
from app.main import create_app

os.environ['SYNC_SCHEDULER'] = '0'
PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000') + b'\x01' * 64
PW = {'alice': 'mot-de-passe-alice', 'bob': 'mot-de-passe-bob1', 'carol': 'mot-de-passe-carol'}


def settings(d: Path) -> Settings:
    return Settings(data_dir=d, access_ttl_s=3600, refresh_ttl_s=86400, transfer_ttl_s=30 * 86400, max_record_bytes=512 * 1024, max_blob_bytes=5 * 2**20, max_user_bytes=2**30, cors_origins=())


@pytest.fixture
def fam(tmp_path):
    """alice (administratrice) et bob (membre) dans la famille ; carol hors famille."""
    s = settings(tmp_path)
    app = create_app(s)
    c, db = TestClient(app), app.state.db
    for u in PW:
        auth.create_user(db, u, u.capitalize(), PW[u])
    spaces.create_family(db, 'Famille Casta', 'alice')
    spaces.add_member(db, 'bob')
    tok = {u: c.post('/v1/auth/login', json={'login': u, 'password': PW[u]}).json() for u in PW}
    return c, db, s, tok


def H(t):
    return {'Authorization': f"Bearer {t['access_token']}"}


def push(c, t, *ch):
    r = c.post('/v1/sync/push', json={'changes': list(ch)}, headers=H(t))
    assert r.status_code == 200, r.text
    return r.json()['results']


def pull(c, t, space=None):
    q = f'&space={space}' if space else ''
    return c.get(f'/v1/sync/changes?since=0{q}', headers=H(t)).json()['changes']


def latest(c, t, rid, coll='recipes'):
    xs = [x for x in pull(c, t) if x['id'] == rid and x['collection'] == coll]
    return xs[-1] if xs else None


def recette(rid, title='Soupe', **kw):
    return {
        'id': rid, 'title': title, 'description': 'Gratinée', 'servings': 4, 'tags': ['hiver'], 'updatedAt': 1,
        'ingredients': [{'id': 'i1', 'name': 'oignon', 'quantity': 4, 'unit': ''}, {'id': 'i2', 'name': 'beurre', 'quantity': 30, 'unit': 'g'}],
        'steps': [{'id': 's1', 'text': 'Émincer'}, {'id': 's2', 'text': 'Cuire'}],
        'notes': {'tips': 'Un trait de vin blanc', 'modifications': 'Mon secret : du porto', 'mistakes': '', 'ideas': '', 'storage': '', 'reheating': ''},
        'nutrition': {'total': {'kcal': 800}, 'source': 'database', 'updatedAt': 1},
        'favorite': True, 'rating': 5, 'cookCount': 3, 'lastCookedAt': 9, 'sourceUrl': 'https://www.tiktok.com/@chef/video/1',
        **kw,
    }


def add_family(c, t, rid, **kw):
    r = push(c, t, {'space': 'family', 'collection': 'recipes', 'id': rid, 'base_rev': 0, 'data': recette(rid, **kw)})[0]
    assert r['status'] == 'ok', r
    return r['rev']


# ---------------------------------------------------------------------------
# Espaces : partage automatique dans la famille, données personnelles jamais partagées
# ---------------------------------------------------------------------------

def test_catalogue_commun_et_donnees_personnelles(fam):
    c, db, s, tok = fam
    add_family(c, tok['alice'], 'r_soupe')
    push(c, tok['alice'], {'collection': 'recipeMeta', 'id': 'r_soupe', 'base_rev': 0, 'data': recette('r_soupe')})
    push(c, tok['alice'], {'collection': 'recipes', 'id': 'r_privee', 'base_rev': 0, 'data': recette('r_privee', 'Recette privée')})
    push(c, tok['alice'], {'collection': 'journal', 'id': 'j1', 'base_rev': 0, 'data': {'id': 'j1', 'recipeId': 'r_soupe', 'comment': 'trop salé'}})

    vue_bob = pull(c, tok['bob'])
    assert [(x['space'], x['collection'], x['id']) for x in vue_bob] == [('family', 'recipes', 'r_soupe')]
    d = vue_bob[0]['data']
    # Partagé : fiche, ingrédients, quantités, étapes, nutrition, source, astuces.
    assert d['title'] == 'Soupe' and d['ingredients'][1]['quantity'] == 30 and d['nutrition']['total']['kcal'] == 800
    assert d['notes'] == {'tips': 'Un trait de vin blanc'} and d['sourceUrl'].startswith('https://www.tiktok.com')
    # Jamais partagé : favori, note, réalisations, notes personnelles (le serveur les retire).
    for k in ('favorite', 'rating', 'cookCount', 'lastCookedAt'):
        assert k not in d
    assert vue_bob[0]['info']['createdBy'] == {'login': 'alice', 'name': 'Alice'}
    # Alice garde sa partie personnelle, dans SON espace.
    meta = latest(c, tok['alice'], 'r_soupe', 'recipeMeta')
    assert meta['space'] == 'personal' and meta['data']['favorite'] is True and meta['data']['notes']['modifications'] == 'Mon secret : du porto'
    assert 'title' not in meta['data']
    # Carol (hors famille) ne voit rien.
    assert pull(c, tok['carol']) == []
    assert c.get('/v1/sync/changes?space=family', headers=H(tok['carol'])).status_code == 403


def test_non_membre_et_usurpation(fam):
    c, db, s, tok = fam
    add_family(c, tok['alice'], 'r_1')
    assert push(c, tok['carol'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recette('r_1', 'pirate')})[0]['error'] == 'not_member'
    # Données personnelles hors famille : refusées dans l'espace familial.
    r = push(c, tok['bob'], {'space': 'family', 'collection': 'journal', 'id': 'j', 'base_rev': 0, 'data': {'id': 'j'}})[0]
    assert r['status'] == 'rejected'
    # Auteur / modificateur envoyés par le téléphone : ignorés (fixés par le serveur).
    rev = latest(c, tok['bob'], 'r_1')['rev']
    push(c, tok['bob'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': recette('r_1', 'Soupe de Bob', createdBy='carol', info={'createdBy': 'carol'})})
    x = latest(c, tok['alice'], 'r_1')
    assert x['info']['createdBy']['login'] == 'alice' and x['info']['updatedBy']['login'] == 'bob'
    # Photo familiale : lisible par les membres seulement.
    sha = hashlib.sha256(PNG).hexdigest()
    assert c.put(f'/v1/blobs/{sha}?space=family', content=PNG, headers={**H(tok['bob']), 'Content-Type': 'image/png'}).status_code == 204
    assert c.get(f'/v1/blobs/{sha}', headers=H(tok['alice'])).status_code == 200
    assert c.get(f'/v1/blobs/{sha}', headers=H(tok['carol'])).status_code == 404
    assert c.put(f'/v1/blobs/{sha}?space=family', content=PNG, headers={**H(tok['carol']), 'Content-Type': 'image/png'}).status_code == 403


def test_un_identifiant_dans_un_seul_espace(fam):
    c, db, s, tok = fam
    add_family(c, tok['alice'], 'r_1')
    r = push(c, tok['alice'], {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recette('r_1')})[0]
    assert r['status'] == 'wrong_space' and r['space_actual'] == 'family'


# ---------------------------------------------------------------------------
# Modifications simultanées
# ---------------------------------------------------------------------------

def test_fusion_automatique_des_champs_independants(fam):
    c, db, s, tok = fam
    rev = add_family(c, tok['alice'], 'r_1')
    a = push(c, tok['alice'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': recette('r_1', 'Soupe gratinée', updatedAt=2)})[0]
    assert a['status'] == 'ok'
    # Bob, hors ligne depuis `rev` : change une étape, ajoute un ingrédient, une étiquette, une astuce.
    bob = recette('r_1', updatedAt=3, tags=['hiver', 'rapide'])
    bob['steps'][1] = {'id': 's2', 'text': 'Cuire 40 min'}
    bob['ingredients'].append({'id': 'i3', 'name': 'gruyère', 'quantity': 100, 'unit': 'g'})
    bob['notes']['tips'] = 'Un trait de vin blanc. Gratiner 5 min.'
    r = push(c, tok['bob'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': bob})[0]
    assert r['status'] == 'merged' and r['conflict'] is None
    d = r['data']
    assert d['title'] == 'Soupe gratinée' and d['steps'][1]['text'] == 'Cuire 40 min'
    assert [i['id'] for i in d['ingredients']] == ['i1', 'i2', 'i3'] and d['tags'] == ['hiver', 'rapide']
    assert d['notes']['tips'].endswith('Gratiner 5 min.') and d['updatedAt'] == 3
    assert latest(c, tok['alice'], 'r_1')['data'] == d


def test_meme_ingredient_modifie_des_deux_cotes_resolution_manuelle(fam):
    c, db, s, tok = fam
    rev = add_family(c, tok['alice'], 'r_1')
    a = recette('r_1')
    a['ingredients'][1]['quantity'] = 50
    a['steps'] = [a['steps'][0]]  # Alice retire l'étape s2…
    push(c, tok['alice'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': a})
    b = recette('r_1', title='Soupe de Bob')
    b['ingredients'][1]['quantity'] = 20  # … même ingrédient, autre quantité
    b['steps'][1]['text'] = 'Cuire doucement'  # … et Bob modifie l'étape qu'Alice a retirée
    r = push(c, tok['bob'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': b})[0]
    assert r['status'] == 'merged' and r['conflict']
    d = r['data']
    assert d['title'] == 'Soupe de Bob'  # champ indépendant : fusionné
    assert d['ingredients'][1]['quantity'] == 50  # désaccord : la version du serveur reste…
    assert [s_['id'] for s_ in d['steps']] == ['s1', 's2'] and d['steps'][1]['text'] == 'Cuire doucement'  # modification > suppression
    # … et les deux versions sont conservées pour une résolution manuelle.
    k = c.get('/v1/family/conflicts', headers=H(tok['alice'])).json()
    assert len(k) == 1 and k[0]['by']['login'] == 'bob' and k[0]['mine']['ingredients'][1]['quantity'] == 20
    paths = sorted(i['path'] for i in k[0]['items'])
    assert paths == ['ingredients[i2]', 'steps[s2]']
    assert latest(c, tok['bob'], 'r_1')['info']['openConflicts'] == 1
    # Résolution : Alice choisit 20 g ; périmée → refusée ; à jour → appliquée.
    cur = latest(c, tok['alice'], 'r_1')
    choix = {**cur['data']}
    choix['ingredients'] = [dict(i) for i in choix['ingredients']]
    choix['ingredients'][1]['quantity'] = 20
    assert c.post(f"/v1/family/conflicts/{k[0]['id']}/resolve", json={'data': choix, 'base_rev': cur['rev'] - 1}, headers=H(tok['alice'])).status_code == 409
    assert c.post(f"/v1/family/conflicts/{k[0]['id']}/resolve", json={'data': choix, 'base_rev': cur['rev']}, headers=H(tok['alice'])).json()['status'] == 'resolved'
    x = latest(c, tok['bob'], 'r_1')
    assert x['data']['ingredients'][1]['quantity'] == 20 and x['info']['openConflicts'] == 0
    assert c.get('/v1/family/conflicts', headers=H(tok['bob'])).json() == []
    kinds = {h['kind'] for h in c.get('/v1/family/recipes/r_1/history', headers=H(tok['bob'])).json()}
    assert {'edit', 'conflict', 'resolve'} <= kinds


def test_version_d_origine_trop_ancienne_tout_desaccord_est_conserve(fam):
    c, db, s, tok = fam
    add_family(c, tok['alice'], 'r_1')
    for i in range(55):  # plus de 50 versions : l'origine de Bob n'est plus dans l'historique
        rev = latest(c, tok['alice'], 'r_1')['rev']
        push(c, tok['alice'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': recette('r_1', f'v{i}')})
    assert len({h['rev'] for h in c.get('/v1/family/recipes/r_1/history', headers=H(tok['bob'])).json()}) == 50
    r = push(c, tok['bob'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': 1, 'data': recette('r_1', 'Titre de Bob')})[0]
    assert r['status'] == 'merged' and r['conflict'] and r['data']['title'] == 'v54'
    assert c.get('/v1/family/conflicts', headers=H(tok['alice'])).json()[0]['mine']['title'] == 'Titre de Bob'


# ---------------------------------------------------------------------------
# Corbeille, historique, verrou
# ---------------------------------------------------------------------------

def test_corbeille_restauration_suppression_definitive(fam):
    c, db, s, tok = fam
    rev = add_family(c, tok['alice'], 'r_1')
    assert push(c, tok['bob'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'deleted': True})[0]['status'] == 'ok'
    x = latest(c, tok['alice'], 'r_1')
    assert x['deleted'] and x.get('trashed')  # disparaît chez tous…
    t = c.get('/v1/family/trash', headers=H(tok['alice'])).json()
    assert t[0]['id'] == 'r_1' and t[0]['trashedBy']['login'] == 'bob' and t[0]['purgeAt'] - t[0]['trashedAt'] == 30 * 86400
    assert c.post('/v1/family/trash/r_1/restore', headers=H(tok['bob'])).json() == {'id': 'r_1'}  # … tout membre restaure
    assert latest(c, tok['alice'], 'r_1')['data']['title'] == 'Soupe'
    # Suppression définitive : administrateur seulement, depuis la corbeille.
    rev = latest(c, tok['alice'], 'r_1')['rev']
    push(c, tok['alice'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'deleted': True})
    assert c.post('/v1/family/trash/r_1/purge', headers=H(tok['bob'])).status_code == 403
    assert c.post('/v1/family/trash/r_1/purge', headers=H(tok['alice'])).status_code == 204
    assert c.get('/v1/family/trash', headers=H(tok['alice'])).json() == []
    assert c.get('/v1/family/recipes/r_1/history', headers=H(tok['alice'])).json() == []


def test_corbeille_automatique_apres_30_jours(fam):
    c, db, s, tok = fam
    rev = add_family(c, tok['alice'], 'r_1')
    push(c, tok['alice'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'deleted': True})
    assert family.auto_purge(db) == 0
    db.x("UPDATE records SET trashed_at = trashed_at - 31 * 86400 WHERE id = 'r_1'")
    assert family.auto_purge(db) == 1 and c.get('/v1/family/trash', headers=H(tok['alice'])).json() == []


def test_modification_contre_corbeille(fam):
    c, db, s, tok = fam
    rev = add_family(c, tok['alice'], 'r_1')
    # Bob modifie ; Alice, hors ligne depuis `rev`, met à la corbeille : refusé (modifiée depuis).
    push(c, tok['bob'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': recette('r_1', 'Modifiée par Bob')})
    r = push(c, tok['alice'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'deleted': True})[0]
    assert r['status'] == 'conflict' and r['server']['data']['title'] == 'Modifiée par Bob'
    # Alice met à la corbeille ; Bob, hors ligne, modifie : la modification la fait revenir.
    rev2 = latest(c, tok['alice'], 'r_1')['rev']
    push(c, tok['alice'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev2, 'deleted': True})
    r = push(c, tok['bob'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev2, 'data': recette('r_1', 'Encore modifiée')})[0]
    assert r['status'] in ('ok', 'merged')
    assert latest(c, tok['alice'], 'r_1')['data']['title'] == 'Encore modifiée'


def test_historique_et_retour_a_une_version(fam):
    c, db, s, tok = fam
    rev1 = add_family(c, tok['alice'], 'r_1')
    push(c, tok['bob'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': rev1, 'data': recette('r_1', 'Abîmée')})
    h = c.get('/v1/family/recipes/r_1/history', headers=H(tok['alice'])).json()
    assert [(x['kind'], x['by']['login']) for x in h] == [('edit', 'bob'), ('edit', 'alice')]
    assert c.get(f'/v1/family/recipes/r_1/history/{rev1}', headers=H(tok['alice'])).json()['title'] == 'Soupe'
    c.post('/v1/family/recipes/r_1/revert', json={'rev': rev1}, headers=H(tok['alice']))
    assert latest(c, tok['bob'], 'r_1')['data']['title'] == 'Soupe'


def test_verrou_de_l_auteur(fam):
    c, db, s, tok = fam
    add_family(c, tok['bob'], 'r_bob')
    add_family(c, tok['alice'], 'r_alice')
    # Bob ne verrouille pas la recette d'Alice ; il verrouille la sienne.
    assert c.post('/v1/family/recipes/r_alice/lock', json={'locked': True}, headers=H(tok['bob'])).status_code == 403
    v = c.post('/v1/family/recipes/r_bob/lock', json={'locked': True}, headers=H(tok['bob'])).json()
    assert v['info']['lockedBy']['login'] == 'bob'
    # Carol rejoint la famille : ni modification, ni corbeille, ni retour en arrière.
    spaces.add_member(db, 'carol')
    rev = latest(c, tok['carol'], 'r_bob')['rev']
    r = push(c, tok['carol'], {'space': 'family', 'collection': 'recipes', 'id': 'r_bob', 'base_rev': rev, 'data': recette('r_bob', 'x')})[0]
    assert r['status'] == 'locked' and r['server']['data']['title'] == 'Soupe'
    assert push(c, tok['carol'], {'space': 'family', 'collection': 'recipes', 'id': 'r_bob', 'base_rev': rev, 'deleted': True})[0]['status'] == 'locked'
    assert c.post('/v1/family/recipes/r_bob/revert', json={'rev': rev}, headers=H(tok['carol'])).status_code == 403
    # L'administratrice garde le droit de modifier.
    assert push(c, tok['alice'], {'space': 'family', 'collection': 'recipes', 'id': 'r_bob', 'base_rev': rev, 'data': recette('r_bob', 'Corrigée par Alice')})[0]['status'] == 'ok'
    c.post('/v1/family/recipes/r_bob/lock', json={'locked': False}, headers=H(tok['bob']))
    rev = latest(c, tok['carol'], 'r_bob')['rev']
    assert push(c, tok['carol'], {'space': 'family', 'collection': 'recipes', 'id': 'r_bob', 'base_rev': rev, 'data': recette('r_bob', 'Par Carol')})[0]['status'] == 'ok'


# ---------------------------------------------------------------------------
# Déplacements entre espaces
# ---------------------------------------------------------------------------

def put_photo(c, t, pid, space='personal'):
    sha = hashlib.sha256(PNG).hexdigest()
    c.put(f'/v1/blobs/{sha}?space={space}', content=PNG, headers={**H(t), 'Content-Type': 'image/png'})
    assert push(c, t, {'space': space, 'collection': 'photos', 'id': pid, 'base_rev': 0, 'data': {'id': pid, 'sha256': sha, 'thumbSha256': sha, 'mime': 'image/png'}})[0]['status'] == 'ok'
    return sha


def test_deplacement_personnel_vers_famille_et_retour(fam):
    c, db, s, tok = fam
    sha = put_photo(c, tok['alice'], 'ph_1')
    push(c, tok['alice'], {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recette('r_1', mainPhotoId='ph_1')})
    # Vers la famille : confirmation exigée (d'autres membres sont concernés).
    assert c.post('/v1/recipes/r_1/move', json={'to': 'family'}, headers=H(tok['alice'])).status_code == 409
    assert c.post('/v1/recipes/r_1/move', json={'to': 'family', 'confirm': True}, headers=H(tok['alice'])).json() == {'id': 'r_1', 'space': 'family'}
    vue = {(x['collection'], x['id']): x for x in pull(c, tok['bob'])}
    assert vue[('recipes', 'r_1')]['data']['mainPhotoId'] == 'ph_1' and 'favorite' not in vue[('recipes', 'r_1')]['data']
    assert c.get(f'/v1/blobs/{sha}', headers=H(tok['bob'])).content == PNG
    meta = latest(c, tok['alice'], 'r_1', 'recipeMeta')['data']
    assert meta['favorite'] is True and meta['notes']['modifications'] == 'Mon secret : du porto'
    perso = [x for x in pull(c, tok['alice'], 'personal') if x['collection'] == 'recipes' and x['id'] == 'r_1']
    assert perso[-1]['deleted'] is True  # plus dans l'espace personnel (même identifiant, autre espace)

    # Retour vers l'espace personnel : seul l'auteur (ou l'administratrice), avec confirmation.
    assert c.post('/v1/recipes/r_1/move', json={'to': 'personal', 'confirm': True}, headers=H(tok['bob'])).status_code == 403
    assert c.post('/v1/recipes/r_1/move', json={'to': 'personal'}, headers=H(tok['alice'])).status_code == 409
    c.post('/v1/recipes/r_1/move', json={'to': 'personal', 'confirm': True}, headers=H(tok['alice']))
    mine = latest(c, tok['alice'], 'r_1')
    assert mine['space'] == 'personal' and mine['data']['favorite'] is True and mine['data']['notes']['tips'] == 'Un trait de vin blanc'
    assert mine['data']['mainPhotoId'] != 'ph_1'  # photo copiée dans l'espace personnel
    # Pour les autres : en corbeille, restaurable (sous un nouvel identifiant).
    t = c.get('/v1/family/trash', headers=H(tok['bob'])).json()
    assert t[0]['id'] == 'r_1'
    new_id = c.post('/v1/family/trash/r_1/restore', headers=H(tok['bob'])).json()['id']
    assert new_id != 'r_1' and latest(c, tok['bob'], new_id)['data']['title'] == 'Soupe'
    assert check(s.data_dir / 'carnet-sync.sqlite3', s.data_dir, full=True)['ok']


def test_famille_vide_aucune_confirmation(tmp_path):
    s = settings(tmp_path)
    app = create_app(s)
    c, db = TestClient(app), app.state.db
    auth.create_user(db, 'seul', 'Seul', 'mot-de-passe-seul')
    spaces.create_family(db, 'Famille', 'seul')
    t = c.post('/v1/auth/login', json={'login': 'seul', 'password': 'mot-de-passe-seul'}).json()
    push(c, t, {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recette('r_1')})
    assert c.post('/v1/recipes/r_1/move', json={'to': 'family'}, headers=H(t)).status_code == 200


# ---------------------------------------------------------------------------
# Membres : retrait, invitation
# ---------------------------------------------------------------------------

def test_retrait_d_un_membre(fam):
    c, db, s, tok = fam
    add_family(c, tok['alice'], 'r_1')
    push(c, tok['bob'], {'collection': 'recipes', 'id': 'r_bob', 'base_rev': 0, 'data': recette('r_bob', 'Perso de Bob')})
    spaces.remove_member(db, 'bob')
    me = c.get('/v1/me', headers=H(tok['bob'])).json()
    assert me['family'] is None and me['family_revoked'] is True
    # Accès coupé immédiatement, même avec une session ouverte.
    assert [x['id'] for x in pull(c, tok['bob'])] == ['r_bob']
    assert c.get('/v1/sync/changes?space=family', headers=H(tok['bob'])).status_code == 403
    assert push(c, tok['bob'], {'space': 'family', 'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recette('r_1')})[0]['error'] == 'not_member'
    assert c.get('/v1/family/trash', headers=H(tok['bob'])).status_code == 403
    # Rien n'est converti : son espace personnel ne contient que ses propres recettes.
    assert [x['id'] for x in pull(c, tok['bob'], 'personal')] == ['r_bob']
    # Le dernier administrateur ne peut pas être retiré ; un membre réintégré retrouve l'accès.
    with pytest.raises(SystemExit):
        spaces.remove_member(db, 'alice')
    spaces.add_member(db, 'bob')
    assert c.get('/v1/me', headers=H(tok['bob'])).json()['family']['role'] == 'member'


def test_invitation_familiale(fam):
    c, db, s, tok = fam
    code = auth.create_invite(db, 'Julie', family_id=spaces.family_id(db))
    r = c.post('/v1/auth/register', json={'invite': code, 'login': 'julie', 'display_name': 'Julie', 'password': 'mot-de-passe-julie'})
    assert r.status_code == 200
    me = c.get('/v1/me', headers=H(r.json())).json()
    assert me['family']['name'] == 'Famille Casta' and [m['login'] for m in me['family']['members']] == ['alice', 'bob', 'julie']


def test_envoi_depuis_le_catalogue_familial(fam):
    c, db, s, tok = fam
    add_family(c, tok['alice'], 'r_1')
    t = c.post('/v1/transfers', json={'recipient': 'carol', 'id': 'r_1', 'include_tips': True}, headers=H(tok['alice'])).json()
    acc = c.post(f"/v1/transfers/{t['id']}/accept", headers=H(tok['carol'])).json()
    x = latest(c, tok['carol'], acc['id'])
    assert x['space'] == 'personal' and x['data']['notes']['tips'] == 'Un trait de vin blanc'


def test_sauvegarde_avec_famille(fam, tmp_path):
    c, db, s, tok = fam
    put_photo(c, tok['bob'], 'ph_f', 'family')
    add_family(c, tok['bob'], 'r_1', mainPhotoId='ph_f')
    r = create_backup(s, db, tmp_path / 'b')
    assert r['ok'] and r['counts']['photos'] == 1
    assert verify_backup(tmp_path / 'b' / r['backup'])['ok']


def test_base_0_1_refusee_sans_rien_modifier(tmp_path):
    p = tmp_path / 'carnet-sync.sqlite3'
    con = sqlite3.connect(p)
    con.execute('CREATE TABLE records (owner_id TEXT, collection TEXT, id TEXT, rev INTEGER, deleted INTEGER, data TEXT)')
    con.commit()
    con.close()
    before = p.read_bytes()
    with pytest.raises(RuntimeError, match='0.1'):
        Database(p)
    assert p.read_bytes() == before
