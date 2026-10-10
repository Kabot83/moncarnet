"""API HTTPS de Carnet Media (prototype).

Toutes les routes, sauf /v1/health, exigent un jeton d'appareil : « Authorization: Bearer mc_… ».
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .config import VERSION, Settings
from .links import parse
from .store import Store
from .worker import Worker

PUBLIC_MEDIA_FIELDS = (
    'key', 'platform', 'post_id', 'url', 'title', 'title_status', 'caption', 'caption_status', 'creator', 'handle',
    'video_status', 'video_message', 'video_bytes', 'video_sha256', 'duration', 'width', 'height', 'meta_source', 'created_at', 'updated_at',
)


class JobIn(BaseModel):
    url: str = Field(max_length=2000)
    #: Nouvel essai pour une vidéo restée indisponible.
    retry: bool = False


def create_app(settings: Settings | None = None, start_worker: bool = True) -> FastAPI:
    s = settings or Settings.from_env()
    store = Store(s.data_dir)
    worker = Worker(store, s)
    app = FastAPI(title='Carnet Media', version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store, app.state.worker, app.state.settings = store, worker, s
    app.add_middleware(CORSMiddleware, allow_origins=list(s.cors_origins), allow_methods=['GET', 'POST', 'DELETE'], allow_headers=['Authorization', 'Content-Type', 'Range'], expose_headers=['Content-Range', 'Accept-Ranges', 'Content-Length'])

    hits: dict[str, deque[float]] = defaultdict(deque)

    @app.middleware('http')
    async def guard(request: Request, call_next):
        if int(request.headers.get('content-length') or 0) > 4096:
            return JSONResponse({'error': 'too_large', 'message': 'Requête trop volumineuse.'}, status_code=413)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Cache-Control'] = response.headers.get('Cache-Control', 'no-store')
        response.headers['Strict-Transport-Security'] = 'max-age=31536000'
        return response

    def device(request: Request) -> str:
        auth = request.headers.get('authorization', '')
        token = auth[7:].strip() if auth.lower().startswith('bearer ') else ''
        tid = store.token_id_for(token) if token.startswith('mc_') else None
        if not tid:
            raise HTTPException(401, {'error': 'unauthorized', 'message': 'Jeton d’appareil absent ou invalide.'})
        return tid

    def limit(tid: str, per_hour: int) -> None:
        q, t = hits[tid], time.time()
        while q and q[0] < t - 3600:
            q.popleft()
        if len(q) >= per_hour:
            raise HTTPException(429, {'error': 'rate_limited', 'message': 'Trop de demandes : réessayez dans quelques minutes.'})
        q.append(t)

    def public(m: dict[str, Any] | None) -> dict[str, Any] | None:
        if not m:
            return None
        out = {k: m[k] for k in PUBLIC_MEDIA_FIELDS}
        out['has_thumbnail'] = bool(m['thumbnail_file'])
        return out

    def job_view(j: dict[str, Any]) -> dict[str, Any]:
        return {
            'id': j['id'], 'status': j['status'], 'progress': j['progress'], 'error': j['error_kind'], 'message': j['message'],
            'media': public(store.media(j['key'])) if j['key'] else None,
        }

    @app.get('/v1/health')
    def health() -> dict[str, str]:
        return {'status': 'ok', 'version': VERSION}

    @app.post('/v1/jobs', status_code=202)
    def create_job(body: JobIn, tid: str = Depends(device)) -> dict[str, Any]:
        link = parse(body.url)
        if not link:
            raise HTTPException(422, {'error': 'invalid_url', 'message': 'Seuls les liens de publications TikTok et Instagram sont acceptés.'})
        # Publication déjà traitée ou en cours : aucun doublon.
        if link.key:
            active = store.active_job_for(link.key)
            if active:
                return job_view(active)
            m = store.media(link.key)
            if m and (m['video_status'] == 'ready' or (m['video_status'] == 'not_available' and not body.retry)):
                jid = store.create_job(link.url, link.key, tid)
                store.update_job(jid, status='done', progress=1, message='Publication déjà connue du service.')
                return job_view(store.job(jid))
        limit(tid, s.jobs_per_hour)
        jid = store.create_job(link.url, link.key, tid)
        worker.submit(jid)
        return job_view(store.job(jid))

    @app.get('/v1/jobs/{jid}')
    def get_job(jid: str, tid: str = Depends(device)) -> dict[str, Any]:
        j = store.job(jid)
        if not j:
            raise HTTPException(404, {'error': 'not_found', 'message': 'Tâche inconnue.'})
        return job_view(j)

    def media_or_404(platform: str, post_id: str) -> dict[str, Any]:
        m = store.media(f'{platform}:{post_id}')
        if not m:
            raise HTTPException(404, {'error': 'not_found', 'message': 'Média inconnu.'})
        return m

    @app.get('/v1/media/{platform}/{post_id}')
    def get_media(platform: str, post_id: str, tid: str = Depends(device)) -> dict[str, Any]:
        return public(media_or_404(platform, post_id))

    @app.get('/v1/media/{platform}/{post_id}/video')
    def get_video(platform: str, post_id: str, tid: str = Depends(device)):
        m = media_or_404(platform, post_id)
        if m['video_status'] != 'ready' or not m['video_file']:
            raise HTTPException(404, {'error': 'no_video', 'message': m['video_message'] or 'Pas de vidéo pour cette publication.'})
        # FileResponse gère les requêtes partielles (Range) : avance / retour dans le lecteur.
        return FileResponse(store.files / m['video_file'], media_type='video/mp4', headers={'Cache-Control': 'private, max-age=86400'})

    @app.get('/v1/media/{platform}/{post_id}/thumbnail')
    def get_thumbnail(platform: str, post_id: str, tid: str = Depends(device)):
        m = media_or_404(platform, post_id)
        if not m['thumbnail_file']:
            raise HTTPException(404, {'error': 'no_thumbnail', 'message': 'Pas de miniature.'})
        return FileResponse(store.files / m['thumbnail_file'], media_type='image/jpeg', headers={'Cache-Control': 'private, max-age=86400'})

    @app.delete('/v1/media/{platform}/{post_id}', status_code=204)
    def delete_media(platform: str, post_id: str, tid: str = Depends(device)) -> None:
        if not store.delete_media(f'{platform}:{post_id}'):
            raise HTTPException(404, {'error': 'not_found', 'message': 'Média inconnu.'})

    @app.get('/v1/media')
    def list_media(since: int = 0, tid: str = Depends(device)) -> dict[str, Any]:
        """Bibliothèque du NAS (base de la future bibliothèque familiale)."""
        items = [public(m) for m in store.list_media(since)]
        return {'items': items, 'next_since': items[-1]['updated_at'] if items else since}

    @app.get('/v1/storage')
    def storage(tid: str = Depends(device)) -> dict[str, int]:
        return {'bytes': store.used_bytes(), 'media': len(store.q('SELECT key FROM media'))}

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {'error': 'error', 'message': str(exc.detail)}
        return JSONResponse(detail, status_code=exc.status_code, headers=exc.headers)

    if start_worker:
        worker.start()
    return app
