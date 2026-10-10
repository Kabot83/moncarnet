"""Stockage : SQLite (jetons d'appareils, médias, tâches) + fichiers dans le dossier de données."""
from __future__ import annotations

import hashlib
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS media (
  key TEXT PRIMARY KEY, platform TEXT NOT NULL, post_id TEXT NOT NULL, url TEXT NOT NULL,
  title TEXT, title_status TEXT NOT NULL DEFAULT 'unavailable',
  caption TEXT, caption_status TEXT NOT NULL DEFAULT 'unavailable',
  creator TEXT, handle TEXT, thumbnail_file TEXT,
  video_file TEXT, video_bytes INTEGER, video_sha256 TEXT, duration REAL, width INTEGER, height INTEGER,
  video_status TEXT NOT NULL DEFAULT 'pending', video_message TEXT NOT NULL DEFAULT '',
  meta_source TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, key TEXT, token_id TEXT NOT NULL,
  status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, error_kind TEXT, message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_key ON jobs(key);
"""


def now() -> int:
    return int(time.time())


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Store:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.files = data_dir / 'files'
        self.files.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(data_dir / 'carnet-media.sqlite3', check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute('PRAGMA journal_mode=WAL')
        self._db.executescript(SCHEMA)

    def q(self, sql: str, args: tuple = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, args).fetchall()]

    def x(self, sql: str, args: tuple = ()) -> None:
        with self._lock:
            self._db.execute(sql, args)
            self._db.commit()

    # --- Jetons -------------------------------------------------------------
    def create_token(self, name: str) -> tuple[str, str]:
        """Renvoie (identifiant, jeton). Le jeton n'est affiché qu'une fois ; seule son empreinte est gardée."""
        token = 'mc_' + secrets.token_urlsafe(32)
        tid = 'tk_' + secrets.token_hex(6)
        self.x('INSERT INTO tokens (id, name, hash, created_at) VALUES (?, ?, ?, ?)', (tid, name, token_hash(token), now()))
        return tid, token

    def token_id_for(self, token: str) -> str | None:
        rows = self.q('SELECT id, hash FROM tokens WHERE hash = ? AND revoked_at IS NULL', (token_hash(token),))
        if rows and secrets.compare_digest(rows[0]['hash'], token_hash(token)):
            return rows[0]['id']
        return None

    def revoke_token(self, tid: str) -> None:
        self.x('UPDATE tokens SET revoked_at = ? WHERE id = ?', (now(), tid))

    # --- Médias -------------------------------------------------------------
    def media(self, key: str) -> dict[str, Any] | None:
        rows = self.q('SELECT * FROM media WHERE key = ?', (key,))
        return rows[0] if rows else None

    def upsert_media(self, key: str, **fields: Any) -> None:
        with self._lock:
            if self.media(key) is None:
                platform, post_id = key.split(':', 1)
                self._db.execute('INSERT INTO media (key, platform, post_id, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', (key, platform, post_id, fields.get('url', ''), now(), now()))
            if fields:
                cols = ', '.join(f'{k} = ?' for k in fields)
                self._db.execute(f'UPDATE media SET {cols}, updated_at = ? WHERE key = ?', (*fields.values(), now(), key))
            self._db.commit()

    def delete_media(self, key: str) -> bool:
        m = self.media(key)
        if not m:
            return False
        for f in (m['video_file'], m['thumbnail_file']):
            if f:
                (self.files / f).unlink(missing_ok=True)
        self.x('DELETE FROM media WHERE key = ?', (key,))
        return True

    def used_bytes(self) -> int:
        return sum(p.stat().st_size for p in self.files.iterdir() if p.is_file())

    def list_media(self, since: int = 0, limit: int = 200) -> list[dict[str, Any]]:
        """Bibliothèque du NAS (future bibliothèque familiale) : médias modifiés depuis `since`."""
        return self.q('SELECT * FROM media WHERE updated_at > ? ORDER BY updated_at LIMIT ?', (since, limit))

    # --- Tâches -------------------------------------------------------------
    def create_job(self, url: str, key: str | None, token_id: str) -> str:
        jid = 'job_' + secrets.token_hex(8)
        self.x('INSERT INTO jobs (id, url, key, token_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', (jid, url, key, token_id, 'queued', now(), now()))
        return jid

    def job(self, jid: str) -> dict[str, Any] | None:
        rows = self.q('SELECT * FROM jobs WHERE id = ?', (jid,))
        return rows[0] if rows else None

    def update_job(self, jid: str, **fields: Any) -> None:
        cols = ', '.join(f'{k} = ?' for k in fields)
        self.x(f'UPDATE jobs SET {cols}, updated_at = ? WHERE id = ?', (*fields.values(), now(), jid))

    def active_job_for(self, key: str) -> dict[str, Any] | None:
        rows = self.q("SELECT * FROM jobs WHERE key = ? AND status IN ('queued','metadata','downloading','verifying') ORDER BY created_at DESC LIMIT 1", (key,))
        return rows[0] if rows else None
