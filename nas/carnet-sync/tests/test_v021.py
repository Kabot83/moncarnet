"""Carnet Sync 0.2.1 : repartage d'une nouvelle version (mettre à jour / garder les deux / refuser)
et conversion du catalogue familial en carnets privés (commande d'administration)."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import auth, spaces
from app.config import Settings
from app.family import privatize
from app.main import create_app

os.environ['SYNC_SCHEDULER'] = '0'
PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000') + b'\x02' * 64
PW = {'alex': 'mot-de-passe-alex', 'jona': 'mot-de-passe-jona'}


@pytest.fixture
def two(tmp_path: Path):
    s = Settings(data_dir=tmp_path, access_ttl_s=3600, refresh_ttl_s=86400, transfer_ttl_s=30 * 86400, max_record_bytes=512 * 1024, max_blob_bytes=5 * 2**20, max_user_bytes=2**30, cors_origins=())
    app = create_app(s)
    c, db = TestClient(app), app.state.db
    for u in PW:
        auth.create_user(db, u, u.capitalize(), PW[u])
    tok = {u: c.post('/v1/auth/login', json={'login': u, 'password': PW[u]}).json() for u in PW}
    return c, db, s, tok


def H(t):
    return {'Authorization': f"Bearer {t['access_token']}"}


def push(c, t, *ch):
    return c.post('/v1/sync/push', json={'changes': list(ch)}, headers=H(t)).json()['results']


def latest(c, t, rid, coll='recipes'):
    xs = [x for x in c.get('/v1/sync/changes?since=0', headers=H(t)).json()['changes'] if x['id'] == rid and x['collection'] == coll]
    return xs[-1] if xs else None


def recette(rid, **kw):
    return {
        'id': rid, 'title': 'Soupe', 'description': 'v1', 'servings': 4, 'updatedAt': 1,
        'ingredients': [{'id': 'i1', 'name': 'oignon', 'quantity': 4}], 'steps': [{'id': 's1', 'text': 'Émincer'}],
        'notes': {'tips': 'Astuce v1', 'modifications': 'secret de l’expéditeur', 'mistakes': '', 'ideas': '', 'storage': '', 'reheating': ''},
        'favorite': True, 'rating': 5, **kw,
    }


def send(c, t, to='jona', rid='r_1', tips=True):
    r = c.post('/v1/transfers', json={'recipient': to, 'id': rid, 'include_tips': tips}, headers=H(t))
    assert r.status_code == 201, r.text
    return r.json()['id']


def accept(c, t, tid, **body):
    return c.post(f'/v1/transfers/{tid}/accept', json=body or None, headers=H(t))


def test_version_annoncee(two):
    c, *_ = two
    assert c.get('/v1/health').json()['version'] == '0.2.1'


def test_identifiant_d_origine_stable_et_opaque(two):
    c, db, s, tok = two
    push(c, tok['alex'], {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recette('r_1')})
    push(c, tok['alex'], {'collection': 'recipes', 'id': 'r_2', 'base_rev': 0, 'data': recette('r_2')})
    t1, t2 = send(c, tok['alex']), send(c, tok['alex'], rid='r_2')
    inbox = {x['id']: x for x in c.get('/v1/transfers/inbox', headers=H(tok['jona'])).json()}
    k1, k2 = inbox[t1]['source_key'], inbox[t2]['source_key']
    assert k1.startswith('src_') and k1 != k2 and 'r_1' not in k1  # aucun identifiant interne révélé
    a = accept(c, tok['jona'], t1).json()
    assert latest(c, tok['jona'], a['id'])['data']['receivedFrom']['sourceKey'] == k1


def test_nouvelle_version_mettre_a_jour_conserve_les_donnees_personnelles(two):
    c, db, s, tok = two
    sha = hashlib.sha256(PNG).hexdigest()
    c.put(f'/v1/blobs/{sha}', content=PNG, headers={**H(tok['alex']), 'Content-Type': 'image/png'})
    push(c, tok['alex'], {'collection': 'photos', 'id': 'ph_a', 'base_rev': 0, 'data': {'id': 'ph_a', 'sha256': sha, 'thumbSha256': sha, 'mime': 'image/png'}})
    push(c, tok['alex'], {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recette('r_1')})
    first = accept(c, tok['jona'], send(c, tok['alex'])).json()['id']
    # Jona personnalise sa copie : favori, note, réalisations, notes personnelles… et la fiche.
    cur = latest(c, tok['jona'], first)
    mine = {**cur['data'], 'favorite': True, 'rating': 4, 'cookCount': 2, 'notes': {**cur['data']['notes'], 'modifications': 'moins de sel'}, 'description': 'ma version'}
    push(c, tok['jona'], {'collection': 'recipes', 'id': first, 'base_rev': cur['rev'], 'data': mine})
    # Alex améliore sa recette (photo ajoutée) et la repartage.
    rev = latest(c, tok['alex'], 'r_1')['rev']
    push(c, tok['alex'], {'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': recette('r_1', description='v2', mainPhotoId='ph_a', notes={'tips': 'Astuce v2', 'modifications': 'secret v2'})})
    t2 = send(c, tok['alex'])
    item = [x for x in c.get('/v1/transfers/inbox', headers=H(tok['jona'])).json() if x['id'] == t2][0]
    assert item['source_key'] == mine['receivedFrom']['sourceKey'] or item['source_key'] == latest(c, tok['jona'], first)['data']['receivedFrom']['sourceKey']
    r = accept(c, tok['jona'], t2, mode='replace', target_id=first).json()
    assert r == {'id': first, 'already': False, 'mode': 'replace'}
    d = latest(c, tok['jona'], first)['data']
    assert d['description'] == 'v2' and d['notes']['tips'] == 'Astuce v2'  # contenu de la fiche : nouvelle version
    assert [d['favorite'], d['rating'], d['cookCount'], d['notes']['modifications']] == [True, 4, 2, 'moins de sel']  # personnel : conservé
    assert d['mainPhotoId'] and d['mainPhotoId'] != 'ph_a' and c.get(f'/v1/blobs/{sha}', headers=H(tok['jona'])).status_code == 200
    assert d['receivedFrom']['transferId'] == t2
    assert len([x for x in c.get('/v1/sync/changes?since=0', headers=H(tok['jona'])).json()['changes'] if x['collection'] == 'recipes']) == 1  # une seule recette
    # Toujours indépendantes : la modification d'Alex ne touche plus la copie.
    rev = latest(c, tok['alex'], 'r_1')['rev']
    push(c, tok['alex'], {'collection': 'recipes', 'id': 'r_1', 'base_rev': rev, 'data': recette('r_1', description='v3')})
    assert latest(c, tok['jona'], first)['data']['description'] == 'v2'
    assert 'secret' not in json.dumps(d)  # notes personnelles de l'expéditeur jamais transmises


def test_garder_les_deux_ou_refuser(two):
    c, db, s, tok = two
    push(c, tok['alex'], {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recette('r_1')})
    first = accept(c, tok['jona'], send(c, tok['alex'])).json()['id']
    second = accept(c, tok['jona'], send(c, tok['alex'])).json()['id']  # « garder les deux »
    assert second != first
    t3 = send(c, tok['alex'])
    assert c.post(f'/v1/transfers/{t3}/decline', headers=H(tok['jona'])).status_code == 204  # « refuser »
    ids = sorted(x['id'] for x in c.get('/v1/sync/changes?since=0', headers=H(tok['jona'])).json()['changes'] if x['collection'] == 'recipes')
    assert ids == sorted([first, second])


def test_remplacement_seulement_d_une_copie_de_la_meme_recette(two):
    c, db, s, tok = two
    push(c, tok['alex'], {'collection': 'recipes', 'id': 'r_1', 'base_rev': 0, 'data': recette('r_1')})
    push(c, tok['alex'], {'collection': 'recipes', 'id': 'r_2', 'base_rev': 0, 'data': recette('r_2')})
    other = accept(c, tok['jona'], send(c, tok['alex'], rid='r_2')).json()['id']
    push(c, tok['jona'], {'collection': 'recipes', 'id': 'r_jona', 'base_rev': 0, 'data': recette('r_jona')})
    t = send(c, tok['alex'])
    assert accept(c, tok['jona'], t, mode='replace', target_id=other).status_code == 409  # autre recette d'origine
    assert accept(c, tok['jona'], t, mode='replace', target_id='r_jona').status_code == 409  # recette personnelle
    assert accept(c, tok['jona'], t, mode='replace', target_id='r_1').status_code == 409  # recette d'Alex (autre espace)
    assert accept(c, tok['jona'], t, mode='replace').status_code == 422
    assert accept(c, tok['jona'], t, mode='autre').status_code == 422
    assert latest(c, tok['jona'], 'r_jona')['data']['description'] == 'v1'  # rien n'a été touché


def test_conversion_du_catalogue_familial_en_carnets_prives(two):
    c, db, s, tok = two
    spaces.create_family(db, 'Le Carnet Familial', 'alex')
    spaces.add_member(db, 'jona')
    sha = hashlib.sha256(PNG).hexdigest()
    c.put(f'/v1/blobs/{sha}?space=family', content=PNG, headers={**H(tok['alex']), 'Content-Type': 'image/png'})
    push(c, tok['alex'], {'space': 'family', 'collection': 'photos', 'id': 'ph_f', 'base_rev': 0, 'data': {'id': 'ph_f', 'sha256': sha, 'thumbSha256': sha, 'mime': 'image/png'}})
    push(c, tok['alex'], {'space': 'family', 'collection': 'recipes', 'id': 'r_fam', 'base_rev': 0, 'data': recette('r_fam', mainPhotoId='ph_f')})
    push(c, tok['alex'], {'collection': 'recipeMeta', 'id': 'r_fam', 'base_rev': 0, 'data': {'id': 'r_fam', 'favorite': True, 'rating': 5, 'notes': {'modifications': 'note d’Alex'}}})
    push(c, tok['jona'], {'collection': 'recipeMeta', 'id': 'r_fam', 'base_rev': 0, 'data': {'id': 'r_fam', 'favorite': False, 'rating': 2, 'notes': {'modifications': 'note de Jona'}}})
    push(c, tok['jona'], {'collection': 'journal', 'id': 'j_1', 'base_rev': 0, 'data': {'id': 'j_1', 'recipeId': 'r_fam', 'comment': 'fait hier'}})
    before = [(x['collection'], x['id'], x['rev']) for x in c.get('/v1/sync/changes?since=0', headers=H(tok['alex'])).json()['changes']]

    # Simulation : rien n'est écrit.
    r = privatize(db, s)
    assert r['recipes'] == 1 and [m['copies'] for m in r['members']] == [1, 1]
    assert [(x['collection'], x['id'], x['rev']) for x in c.get('/v1/sync/changes?since=0', headers=H(tok['alex'])).json()['changes']] == before

    privatize(db, s, apply=True)
    mine = {u: [x for x in c.get('/v1/sync/changes?space=personal&since=0', headers=H(tok[u])).json()['changes'] if x['collection'] == 'recipes'] for u in PW}
    a, j = mine['alex'][0]['data'], mine['jona'][0]['data']
    assert a['id'] != j['id'] != 'r_fam'  # copies distinctes, indépendantes
    assert [a['rating'], a['notes']['modifications']] == [5, 'note d’Alex'] and [j['rating'], j['notes']['modifications']] == [2, 'note de Jona']
    assert a['description'] == j['description'] == 'v1' and a['copiedFromFamily']['recipeId'] == 'r_fam'
    assert c.get(f'/v1/blobs/{sha}', headers=H(tok['jona'])).status_code == 200 and j['mainPhotoId'] != 'ph_f'
    assert latest(c, tok['jona'], 'j_1', 'journal')['data']['recipeId'] == j['id']  # son journal suit sa copie
    assert latest(c, tok['alex'], 'r_fam')['space'] == 'family'  # catalogue familial intact (rien supprimé)
    # Rejouable sans doublon.
    again = privatize(db, s, apply=True)
    assert [m['copies'] for m in again['members']] == [0, 0] and [m['already'] for m in again['members']] == [1, 1]
