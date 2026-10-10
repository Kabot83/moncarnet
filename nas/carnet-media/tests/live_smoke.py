"""Test RÉEL de bout en bout : service lancé en HTTPS, vraies publications publiques.

Usage : python tests/live_smoke.py https://127.0.0.1:8443 <jeton> <cert.pem> [lien …]
Le certificat du service est épinglé (seul ce certificat est accepté).
Sans liens en argument, un jeu de publications publiques connues est utilisé.
"""
from __future__ import annotations

import sys
import time

import httpx

BASE, TOKEN, CERT = sys.argv[1], sys.argv[2], sys.argv[3]
LINKS = sys.argv[4:] or [
    'https://www.tiktok.com/@chloezeitoun/video/7158142848670387462?is_from_webapp=1&sender_device=pc',
    'https://www.tiktok.com/@chloezeitoun/video/7683930014508682528',
    'https://www.tiktok.com/@scout2015/video/6718335390845095173',
    'https://www.instagram.com/reel/DMmxU4bKcsR/?igsh=test',
    'https://www.instagram.com/reel/DPL6xC_jJQU/',
    'https://www.instagram.com/reel/C8CaBfWs1mr/',
    'https://www.tiktok.com/t/ZTNu7ujjT/',
    'https://www.instagram.com/p/CUbHfhpswxt/',
    'https://www.instagram.com/reel/DZZZZZZZZZZ/',
]
H = {'Authorization': f'Bearer {TOKEN}'}
c = httpx.Client(base_url=BASE, verify=CERT, timeout=120)


def job(url: str) -> dict:
    r = c.post('/v1/jobs', json={'url': url}, headers=H)
    if r.status_code != 202:
        return {'http': r.status_code, **r.json()}
    j = r.json()
    t = time.time()
    while j['status'] not in ('done', 'failed') and time.time() - t < 300:
        time.sleep(1)
        j = c.get(f"/v1/jobs/{j['id']}", headers=H).json()
    j['seconds'] = round(time.time() - t, 1)
    return j


print('health :', c.get('/v1/health').json(), '| sans jeton :', c.get('/v1/storage').status_code)
print('lien refusé :', c.post('/v1/jobs', json={'url': 'https://www.youtube.com/watch?v=abc'}, headers=H).status_code)
for url in LINKS:
    j = job(url)
    m = j.get('media') or {}
    print(f'\n### {url[:90]}')
    print(f"  tâche : {j.get('status', j.get('http'))} en {j.get('seconds')} s | erreur : {j.get('error')} | {j.get('message')}")
    if not m:
        continue
    cap = (m.get('caption') or '').replace('\n', ' ⏎ ')
    print(f"  titre [{m['title_status']}] : {m['title']!r}")
    print(f"  légende [{m['caption_status']}] ({len(m.get('caption') or '')} car.) : {cap[:100]!r}")
    print(f"  créateur : {m['creator']!r} (@{m['handle']}) | miniature : {m['has_thumbnail']} | source : {m['meta_source']}")
    print(f"  vidéo : {m['video_status']} {('— ' + m['video_message'][:100]) if m['video_message'] else ''}")
    if m['video_status'] == 'ready':
        print(f"  fichier vérifié : {m['video_bytes'] / 1_048_576:.1f} Mo, {m['width']}x{m['height']}, {m['duration']:.1f} s")
        r = c.get(f"/v1/media/{m['platform']}/{m['post_id']}/video", headers={**H, 'Range': 'bytes=1000-1999'})
        print(f"  lecture partielle : {r.status_code} {r.headers.get('content-range')}")
        again = job(url)
        print(f"  même lien renvoyé : {again.get('message')}")
print('\nespace occupé sur le « NAS » :', c.get('/v1/storage', headers=H).json())
