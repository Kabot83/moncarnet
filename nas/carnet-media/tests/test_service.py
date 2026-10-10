"""Tests automatisés (réseau SIMULÉ) : sécurité, autorisations, doublons, contrôle des fichiers.
Les tests avec de vraies publications sont dans tests/live_smoke.py (réseau réel)."""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import providers
from app.config import Settings
from app.links import media_host_allowed, parse
from app.main import create_app
from app.providers import ProviderError, title_from_caption

FFMPEG = os.environ.get('CARNET_FFMPEG', 'ffmpeg')


def make_mp4(path: Path, seconds: int = 2) -> None:
    subprocess.run([FFMPEG, '-v', 'error', '-y', '-f', 'lavfi', '-i', f'testsrc=size=320x568:rate=25:duration={seconds}', '-f', 'lavfi', '-i', f'sine=duration={seconds}',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(path)], check=True)


@pytest.fixture
def env(tmp_path, monkeypatch):
    s = Settings(data_dir=tmp_path, max_duration_s=600, max_bytes=50 * 1024 * 1024, max_storage_bytes=0, tiktok_video=True,
                 cors_origins=('https://localhost',), jobs_per_hour=5, ffmpeg=FFMPEG)
    app = create_app(s, start_worker=False)
    client = TestClient(app)
    store, worker = app.state.store, app.state.worker
    _, token = store.create_token('test')
    h = {'Authorization': f'Bearer {token}'}

    def run_all():
        while not worker.q.empty():
            worker.process(worker.q.get())

    meta = {'caption': 'Pâtes crémeuses au citron 🍋\nIngrédients :\n- 200 g de pâtes\n#pasta #recette', 'creator': 'Julie Cuisine', 'handle': 'julie.cuisine', 'thumbnail_url': None}

    def fake_ig_meta(link, *_):
        return parse(f'https://www.instagram.com/reel/{link.post_id}/'), providers._meta(meta['caption'], meta['creator'], meta['handle'], None, 'instagram_public'), {'id': link.post_id}

    def fake_ig_video(info, dest, *_args):
        make_mp4(dest)

    monkeypatch.setattr(providers, 'instagram_metadata', fake_ig_meta)
    monkeypatch.setattr(providers, 'instagram_video', fake_ig_video)
    monkeypatch.setattr(providers, 'tiktok_metadata', lambda link: (parse('https://www.tiktok.com/@chloezeitoun/video/7158142848670387462'), providers._meta('Pâtes à la fêta #pourtoi', 'Chloe Zeitoun', 'chloezeitoun', None, 'tiktok_oembed')))
    monkeypatch.setattr(providers, 'tiktok_video', lambda link, dest, *a: make_mp4(dest, 3))
    monkeypatch.setattr(providers, 'fetch_thumbnail', lambda url, dest: False)
    return client, store, h, run_all


def test_liens_acceptes_et_refuses():
    assert parse('https://www.instagram.com/reel/DKw2J6TMZd7/?igsh=abc').key == 'instagram:DKw2J6TMZd7'
    assert parse('https://www.tiktok.com/@chloezeitoun/video/7158142848670387462?is_from_webapp=1').key == 'tiktok:7158142848670387462'
    assert parse('https://vm.tiktok.com/ZMabc/').short
    for bad in ['https://www.instagram.com/leomessi/', 'https://www.tiktok.com/@chloezeitoun', 'https://example.com/reel/abc12', 'http://127.0.0.1/x',
                'https://www.instagram.com:8443/reel/DKw2J6TMZd7/', 'https://user:pw@www.instagram.com/reel/DKw2J6TMZd7/', 'file:///etc/passwd', '']:
        assert parse(bad) is None, bad
    assert media_host_allowed('https://scontent.cdninstagram.com/v/x.jpg')
    assert not media_host_allowed('https://evil.example/x.jpg')
    assert not media_host_allowed('http://scontent.cdninstagram.com/x.jpg')
    assert not media_host_allowed('https://cdninstagram.com.evil.example/x.jpg')


def test_titre_jamais_un_pseudo():
    assert title_from_caption('Pâtes à la fêta #patesfeta #pourtoi') == 'Pâtes à la fêta'
    assert title_from_caption('#recette #food @julie') is None
    assert title_from_caption(None) is None
    assert title_from_caption('⁠Smooth Adi, Smooth 🤭') == 'Smooth Adi, Smooth 🤭'


def test_jeton_obligatoire(env):
    client, _, _, _ = env
    assert client.get('/v1/health').status_code == 200
    for r in (client.post('/v1/jobs', json={'url': 'https://www.instagram.com/reel/AAAAA1/'}), client.get('/v1/storage', headers={'Authorization': 'Bearer mc_faux'})):
        assert r.status_code == 401
        assert r.json()['error'] == 'unauthorized'


def test_lien_refuse(env):
    client, _, h, _ = env
    r = client.post('/v1/jobs', json={'url': 'https://www.youtube.com/watch?v=x'}, headers=h)
    assert r.status_code == 422 and r.json()['error'] == 'invalid_url'


def test_instagram_automatique_video_verifiee_lecture_partielle_doublon_suppression(env):
    client, store, h, run_all = env
    job = client.post('/v1/jobs', json={'url': 'https://www.instagram.com/reel/DKw2J6TMZd7/?igsh=abc'}, headers=h).json()
    run_all()
    m = client.get(f"/v1/jobs/{job['id']}", headers=h).json()['media']
    assert m['video_status'] == 'ready' and m['video_bytes'] > 1000 and len(m['video_sha256']) == 64
    assert m['width'] == 320 and m['height'] == 568 and 1.5 < m['duration'] < 2.5
    assert m['title'] == 'Pâtes crémeuses au citron 🍋' and m['title_status'] == 'from_caption'
    assert m['caption'].startswith('Pâtes crémeuses') and m['caption_status'] == 'full' and m['creator'] == 'Julie Cuisine'
    full = client.get('/v1/media/instagram/DKw2J6TMZd7/video', headers=h)
    assert full.status_code == 200 and full.headers['content-type'] == 'video/mp4'
    part = client.get('/v1/media/instagram/DKw2J6TMZd7/video', headers={**h, 'Range': 'bytes=0-99'})
    assert part.status_code == 206 and len(part.content) == 100  # avance / retour dans le lecteur
    again = client.post('/v1/jobs', json={'url': 'https://instagram.com/reels/DKw2J6TMZd7?igsh=x'}, headers=h).json()
    assert again['status'] == 'done' and again['message'] == 'Publication déjà connue du service.'
    assert [x['key'] for x in client.get('/v1/media', headers=h).json()['items']] == ['instagram:DKw2J6TMZd7']
    assert not list(store.files.glob('*.part*'))
    assert client.delete('/v1/media/instagram/DKw2J6TMZd7', headers=h).status_code == 204
    assert not list(store.files.glob('*.mp4'))


def test_tiktok_automatique(env):
    client, _, h, run_all = env
    job = client.post('/v1/jobs', json={'url': 'https://www.tiktok.com/@chloezeitoun/video/7158142848670387462?is_from_webapp=1'}, headers=h).json()
    run_all()
    m = client.get(f"/v1/jobs/{job['id']}", headers=h).json()['media']
    assert m['video_status'] == 'ready' and m['title'] == 'Pâtes à la fêta' and m['meta_source'] == 'tiktok_oembed'


def test_video_indisponible_fiche_conservee(env, monkeypatch):
    client, store, h, run_all = env

    def no_video(*a):
        raise ProviderError('not_available', 'Aucune vidéo téléchargeable dans cette publication.')

    monkeypatch.setattr(providers, 'instagram_video', no_video)
    job = client.post('/v1/jobs', json={'url': 'https://www.instagram.com/reel/DKw2J6TMZd7/'}, headers=h).json()
    run_all()
    j = client.get(f"/v1/jobs/{job['id']}", headers=h).json()
    assert j['status'] == 'done' and j['error'] == 'not_available'
    assert j['media']['video_status'] == 'not_available' and j['media']['caption']  # légende conservée
    assert client.get('/v1/media/instagram/DKw2J6TMZd7/video', headers=h).status_code == 404


def test_fichier_corrompu_jamais_declare_pret(env, monkeypatch):
    client, store, h, run_all = env
    monkeypatch.setattr(providers, 'instagram_video', lambda info, dest, *a: dest.write_bytes(b'\x00\x00\x00\x18ftypmp42' + os.urandom(5000)))
    job = client.post('/v1/jobs', json={'url': 'https://www.instagram.com/reel/DKw2J6TMZd7/'}, headers=h).json()
    run_all()
    j = client.get(f"/v1/jobs/{job['id']}", headers=h).json()
    assert j['error'] == 'verification_failed' and j['media']['video_status'] == 'not_available'
    assert not list(store.files.glob('*.mp4'))


def test_espace_plein(env, monkeypatch):
    client, store, h, run_all = env
    monkeypatch.setattr(store, 'used_bytes', lambda: 10**12)
    object.__setattr__(client.app.state.worker.settings, 'max_storage_bytes', 1)
    job = client.post('/v1/jobs', json={'url': 'https://www.instagram.com/reel/DKw2J6TMZd7/'}, headers=h).json()
    run_all()
    assert client.get(f"/v1/jobs/{job['id']}", headers=h).json()['error'] == 'storage_full'


def test_reseau_local_refuse():
    from app.providers import assert_public_host

    for url in ('https://127.0.0.1/x', 'https://localhost/x', 'https://10.0.0.1/x', 'https://192.168.1.20/x', 'https://[::1]/x', 'https://169.254.169.254/latest'):
        with pytest.raises(ProviderError) as e:
            assert_public_host(url)
        assert e.value.kind == 'blocked_address', url


def test_transfert_incomplet_detecte(tmp_path, monkeypatch):
    import httpx

    monkeypatch.setattr(providers, 'assert_public_host', lambda url: None)
    transport = httpx.MockTransport(lambda req: httpx.Response(200, headers={'content-type': 'video/mp4', 'content-length': '1000'}, content=b'x' * 400))
    with httpx.Client(transport=transport) as c, pytest.raises(ProviderError) as e:
        providers._stream(c, 'https://v16-webapp-prime.tiktok.com/video.mp4', tmp_path / 'v.mp4', 10**6, lambda p: None)
    assert e.value.kind in ('incomplete', 'network')


def test_erreurs_explicites(env, monkeypatch):
    client, _, h, run_all = env

    def boom(link, *_):
        raise ProviderError('login_required', 'Instagram demande une connexion.')

    monkeypatch.setattr(providers, 'instagram_metadata', boom)
    job = client.post('/v1/jobs', json={'url': 'https://www.instagram.com/reel/BBBBB2/'}, headers=h).json()
    run_all()
    j = client.get(f"/v1/jobs/{job['id']}", headers=h).json()
    assert j['status'] == 'failed' and j['error'] == 'login_required' and j['media'] is None


def test_limite_de_debit(env):
    client, _, h, _ = env
    codes = [client.post('/v1/jobs', json={'url': f'https://www.instagram.com/reel/CCCCC{i}x/'}, headers=h).status_code for i in range(7)]
    assert codes[:5] == [202] * 5 and codes[5] == 429


def test_requete_trop_grosse(env):
    client, _, h, _ = env
    r = client.post('/v1/jobs', content=b'{"url":"' + b'a' * 5000 + b'"}', headers={**h, 'Content-Type': 'application/json'})
    assert r.status_code == 413


def test_traduction_prudente_des_erreurs_ytdlp():
    from app.providers import _map_ytdlp_error as m
    assert m(Exception('ERROR: [Instagram] X: Requested format is not available.')).kind == 'not_available'
    assert m(Exception('Instagram sent an empty media response. ... use --cookies-from-browser')).kind == 'unavailable_logged_out'
    assert m(Exception('HTTP Error 429: Too Many Requests')).kind == 'rate_limited'
    assert m(Exception('Connection reset')).kind == 'network'
