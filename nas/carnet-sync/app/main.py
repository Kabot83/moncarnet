"""API HTTPS de Carnet Sync (prototype).

Toutes les routes, sauf /v1/health et l'authentification, exigent « Authorization: Bearer mca_… ».
L'identité de l'utilisateur provient UNIQUEMENT de la session : aucun identifiant de propriétaire
n'est jamais lu dans une requête.
"""
from __future__ import annotations

import os
import time
from collections import defaultdict, deque
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from . import auth, family, spaces, sync, transfers
from .config import VERSION, Settings
from .db import Database


class LoginIn(BaseModel):
    login: str = Field(max_length=64)
    password: str = Field(max_length=256)
    device: str = Field(default='appareil', max_length=80)


class RegisterIn(LoginIn):
    invite: str = Field(max_length=100)
    display_name: str = Field(default='', max_length=60)


class RefreshIn(BaseModel):
    refresh_token: str = Field(max_length=200)


class PasswordIn(BaseModel):
    old_password: str = Field(max_length=256)
    new_password: str = Field(max_length=256)


class PushIn(BaseModel):
    changes: list[dict[str, Any]] = Field(max_length=200)


class MissingIn(BaseModel):
    hashes: list[str] = Field(max_length=1000)
    space: str = Field(default='personal', max_length=10)


class LockIn(BaseModel):
    locked: bool


class RevertIn(BaseModel):
    rev: int


class ResolveIn(BaseModel):
    data: dict[str, Any] | None = None
    base_rev: int | None = None


class MoveIn(BaseModel):
    to: str = Field(max_length=10)
    confirm: bool = False


class SendIn(BaseModel):
    recipient: str = Field(max_length=64)
    kind: str = Field(default='recipe', max_length=10)
    id: str = Field(max_length=300)
    include_tips: bool = False


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or Settings.from_env()
    db = Database(s.data_dir / 'carnet-sync.sqlite3')
    app = FastAPI(title='Carnet Sync', version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db, app.state.settings = db, s
    if s.backup_dir and os.environ.get('SYNC_SCHEDULER', '1') == '1':
        from .backup import start_scheduler

        start_scheduler(s, db)
    app.add_middleware(CORSMiddleware, allow_origins=list(s.cors_origins), allow_methods=['GET', 'POST', 'PUT', 'DELETE'], allow_headers=['Authorization', 'Content-Type'])
    trust_proxy = os.environ.get('SYNC_TRUST_PROXY') == '1'
    hits: dict[str, deque[float]] = defaultdict(deque)

    def client_ip(request: Request) -> str:
        if trust_proxy:  # derrière le reverse proxy Synology uniquement
            fwd = request.headers.get('x-forwarded-for', '')
            if fwd:
                return fwd.split(',')[-1].strip()
        return request.client.host if request.client else '?'

    def limit(key: str, per_minute: int) -> None:
        q, t = hits[key], time.time()
        while q and q[0] < t - 60:
            q.popleft()
        if len(q) >= per_minute:
            raise HTTPException(429, {'error': 'rate_limited', 'message': 'Trop de demandes : réessayez dans un instant.'})
        q.append(t)

    @app.middleware('http')
    async def guard(request: Request, call_next):
        max_len = s.max_blob_bytes + 1024 if request.url.path.startswith('/v1/blobs/') else 8 * 1024 * 1024
        if int(request.headers.get('content-length') or 0) > max_len:
            return JSONResponse({'error': 'too_large', 'message': 'Requête trop volumineuse.'}, status_code=413)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers.setdefault('Cache-Control', 'no-store')
        response.headers['Strict-Transport-Security'] = 'max-age=31536000'
        return response

    def current(request: Request) -> tuple[dict, str]:
        h = request.headers.get('authorization', '')
        token = h[7:].strip() if h.lower().startswith('bearer ') else ''
        user, session_id = auth.authenticate(db, token)
        limit(f'user:{user["id"]}', 600)
        return user, session_id

    def tokens_view(t: auth.Tokens) -> dict:
        return {'access_token': t.access_token, 'refresh_token': t.refresh_token, 'expires_at': t.access_expires_at, 'session_id': t.session_id, 'user': t.user}

    @app.get('/v1/health')
    def health() -> dict:
        return {'status': 'ok', 'service': 'carnet-sync'}

    # --- Comptes -------------------------------------------------------------
    @app.post('/v1/auth/login')
    def login(body: LoginIn, request: Request) -> dict:
        limit(f'ip:{client_ip(request)}', 30)
        return tokens_view(auth.login(db, body.login, body.password, body.device, client_ip(request), s.access_ttl_s, s.refresh_ttl_s))

    @app.post('/v1/auth/register')
    def register(body: RegisterIn, request: Request) -> dict:
        limit(f'ip:{client_ip(request)}', 10)
        auth.register_with_invite(db, body.invite, body.login, body.display_name, body.password)
        return tokens_view(auth.login(db, body.login, body.password, body.device, client_ip(request), s.access_ttl_s, s.refresh_ttl_s))

    @app.post('/v1/auth/refresh')
    def refresh(body: RefreshIn, request: Request) -> dict:
        limit(f'ip:{client_ip(request)}', 60)
        return tokens_view(auth.refresh(db, body.refresh_token, s.access_ttl_s, s.refresh_ttl_s))

    @app.post('/v1/auth/logout', status_code=204)
    def logout(cur: tuple = Depends(current)) -> None:
        auth.revoke(db, cur[0]['id'], cur[1])

    @app.post('/v1/auth/password', status_code=204)
    def password(body: PasswordIn, cur: tuple = Depends(current)) -> None:
        auth.change_password(db, cur[0]['id'], body.old_password, body.new_password, cur[1])

    @app.get('/v1/me')
    def me(cur: tuple = Depends(current)) -> dict:
        return {'user': cur[0], 'session_id': cur[1], **spaces.family_view(db, spaces.access(db, cur[0]['id']))}

    @app.get('/v1/sessions')
    def sessions(cur: tuple = Depends(current)) -> list[dict]:
        return db.q('SELECT id, device, created_at, last_used_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_used_at DESC', (cur[0]['id'],))

    @app.delete('/v1/sessions/{sid}', status_code=204)
    def revoke_session(sid: str, cur: tuple = Depends(current)) -> None:
        if not auth.revoke(db, cur[0]['id'], sid):
            raise HTTPException(404, {'error': 'not_found', 'message': 'Session introuvable.'})

    def acc(cur: tuple) -> spaces.Access:
        return spaces.access(db, cur[0]['id'])

    # --- Synchronisation -----------------------------------------------------
    @app.get('/v1/sync/changes')
    def changes(since: int = 0, page_size: int = 500, space: str | None = None, cur: tuple = Depends(current)) -> dict:
        return sync.changes(db, acc(cur), max(0, since), max(1, min(500, page_size)), space)

    @app.post('/v1/sync/push')
    def push(body: PushIn, cur: tuple = Depends(current)) -> dict:
        return {'results': sync.push(db, s, acc(cur), body.changes)}

    @app.post('/v1/blobs/missing')
    def missing(body: MissingIn, cur: tuple = Depends(current)) -> dict:
        return {'missing': sync.missing_blobs(db, acc(cur).space(body.space), body.hashes)}

    @app.put('/v1/blobs/{sha}', status_code=204)
    async def put_blob(sha: str, request: Request, space: str = 'personal', cur: tuple = Depends(current)) -> None:
        a = acc(cur)
        body = await request.body()
        quota = s.max_user_bytes * (2 if space == 'family' else 1)
        sync.put_blob(db, s, a.space(space), sha, body, request.headers.get('content-type', '').split(';')[0].strip(), quota)

    @app.get('/v1/blobs/{sha}')
    def get_blob(sha: str, cur: tuple = Depends(current)):
        found = sync.get_blob(db, s, acc(cur), sha)
        if not found:
            raise HTTPException(404, {'error': 'not_found', 'message': 'Fichier introuvable.'})
        return FileResponse(found[0], media_type=found[1], headers={'Cache-Control': 'private, max-age=31536000, immutable'})

    # --- Catalogue familial ------------------------------------------------------
    @app.get('/v1/family')
    def family_info(cur: tuple = Depends(current)) -> dict:
        return spaces.family_view(db, acc(cur))

    @app.post('/v1/family/recipes/{rid}/lock')
    def lock(rid: str, body: LockIn, cur: tuple = Depends(current)) -> dict:
        return family.set_lock(db, acc(cur), rid, body.locked)

    @app.get('/v1/family/trash')
    def trash(cur: tuple = Depends(current)) -> list[dict]:
        return family.trash_list(db, acc(cur))

    @app.post('/v1/family/trash/{rid}/restore')
    def restore(rid: str, cur: tuple = Depends(current)) -> dict:
        return family.restore(db, acc(cur), rid)

    @app.post('/v1/family/trash/{rid}/purge', status_code=204)
    def purge(rid: str, cur: tuple = Depends(current)) -> None:
        family.purge(db, acc(cur), rid)

    @app.get('/v1/family/recipes/{rid}/history')
    def history(rid: str, cur: tuple = Depends(current)) -> list[dict]:
        return family.history_list(db, acc(cur), rid)

    @app.get('/v1/family/recipes/{rid}/history/{rev}')
    def history_version(rid: str, rev: int, kind: str = 'edit', cur: tuple = Depends(current)) -> dict:
        return family.history_get(db, acc(cur), rid, rev, kind)

    @app.post('/v1/family/recipes/{rid}/revert')
    def revert(rid: str, body: RevertIn, cur: tuple = Depends(current)) -> dict:
        return family.revert(db, acc(cur), rid, body.rev)

    @app.get('/v1/family/conflicts')
    def conflicts(cur: tuple = Depends(current)) -> list[dict]:
        return family.conflicts_list(db, acc(cur))

    @app.post('/v1/family/conflicts/{cid}/resolve')
    def resolve(cid: str, body: ResolveIn, cur: tuple = Depends(current)) -> dict:
        return family.resolve(db, acc(cur), cid, body.data, body.base_rev)

    @app.post('/v1/recipes/{rid}/move')
    def move(rid: str, body: MoveIn, cur: tuple = Depends(current)) -> dict:
        return family.move(db, s, acc(cur), rid, body.to, body.confirm)

    # --- Envois de recettes ----------------------------------------------------
    @app.get('/v1/users/lookup')
    def lookup(login: str, cur: tuple = Depends(current)) -> dict:
        limit(f'lookup:{cur[0]["id"]}', 20)
        found = transfers.lookup_user(db, login, cur[0]['id'])
        if not found:
            raise HTTPException(404, {'error': 'not_found', 'message': 'Aucun utilisateur avec cet identifiant.'})
        return found

    @app.post('/v1/transfers', status_code=201)
    def send(body: SendIn, cur: tuple = Depends(current)) -> dict:
        limit(f'send:{cur[0]["id"]}', 20)
        return transfers.send(db, s, acc(cur), cur[0], body.recipient, body.kind, body.id, body.include_tips)

    @app.get('/v1/transfers/inbox')
    def inbox(cur: tuple = Depends(current)) -> list[dict]:
        return transfers.inbox(db, s, cur[0]['id'])

    @app.get('/v1/transfers/outbox')
    def outbox(cur: tuple = Depends(current)) -> list[dict]:
        return transfers.outbox(db, cur[0]['id'])

    @app.get('/v1/transfers/{tid}/cover')
    def cover(tid: str, cur: tuple = Depends(current)):
        found = transfers.cover(db, s, cur[0]['id'], tid)
        if not found:
            return Response(status_code=404)
        return FileResponse(found[0], media_type=found[1])

    @app.post('/v1/transfers/{tid}/accept')
    def accept(tid: str, cur: tuple = Depends(current)) -> dict:
        return transfers.accept(db, s, acc(cur), cur[0], tid)

    @app.post('/v1/transfers/{tid}/decline', status_code=204)
    def decline(tid: str, cur: tuple = Depends(current)) -> None:
        transfers.decline(db, s, cur[0]['id'], tid)

    # --- Erreurs : messages clairs, aucun détail interne -------------------
    for exc_type in (auth.AuthError, sync.SyncError, transfers.TransferError, family.FamilyError):
        @app.exception_handler(exc_type)
        async def known(_: Request, e: Exception):
            return JSONResponse({'error': e.code, 'message': e.message}, status_code=e.status)  # type: ignore[attr-defined]

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {'error': 'error', 'message': str(exc.detail)}
        return JSONResponse(detail, status_code=exc.status_code)

    return app
