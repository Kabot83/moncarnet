"""Base SQLite de Carnet Sync.

Isolation : chaque enregistrement et fichier appartient à un ESPACE (personnel ou familial).
L'accès à un espace est calculé à chaque requête à partir de l'utilisateur de la SESSION
(propriétaire de l'espace personnel, membre actif de la famille) — jamais d'un identifiant
envoyé par le téléphone.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

-- Création de compte sur invitation (aucune inscription publique). `family_id` : le nouveau compte
-- rejoint la famille (membre) à sa création.
CREATE TABLE IF NOT EXISTS account_invites (
  code_hash TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  family_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT REFERENCES users(id)
);

-- Sessions : jeton d'accès court + jeton de renouvellement à usage unique (rotation).
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at INTEGER NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Ancien jeton de renouvellement déjà utilisé : sa réutilisation révèle un vol → session révoquée.
CREATE TABLE IF NOT EXISTS used_refresh (
  refresh_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  used_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_failures (
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_key ON login_failures(key, at);

-- Espaces : un espace PERSONNEL par compte (visible de lui seul) et l'espace FAMILIAL commun.
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'family')),
  name TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS spaces_personal ON spaces(owner_id) WHERE kind = 'personal';

-- Membres de la famille. Un retrait (removed_at) coupe l'accès immédiatement (vérifié à chaque requête).
CREATE TABLE IF NOT EXISTS space_members (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  joined_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (space_id, user_id)
);

-- Données synchronisées. `rev` : numéro d'ordre global, croissant à chaque écriture.
-- Auteur, dernier modificateur, verrou et corbeille : fixés par le serveur (jamais par le téléphone).
CREATE TABLE IF NOT EXISTS records (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  data TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  locked_by TEXT,
  trashed_at INTEGER,
  trashed_by TEXT,
  PRIMARY KEY (space_id, collection, id)
);
CREATE INDEX IF NOT EXISTS records_changes ON records(space_id, rev);

-- Historique des recettes familiales (50 dernières versions par recette) : modifications,
-- corbeille, restaurations, versions écartées par un conflit.
CREATE TABLE IF NOT EXISTS history (
  space_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT,
  author_id TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (space_id, collection, id, rev, kind)
);

-- Modifications incompatibles à résoudre à la main : les deux versions sont conservées.
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  items TEXT NOT NULL,
  mine TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS conflicts_open ON conflicts(space_id, status);

-- Fichiers (photos) adressés par leur empreinte, PAR ESPACE.
CREATE TABLE IF NOT EXISTS blobs (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, sha256)
);

-- Envois de recettes : contenu FIGÉ au moment de l'envoi, fichiers copiés à part.
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  blob_hashes TEXT NOT NULL,
  cover_sha256 TEXT,
  cover_mime TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  result_id TEXT
);
CREATE INDEX IF NOT EXISTS transfers_recipient ON transfers(recipient_id, status);
CREATE INDEX IF NOT EXISTS transfers_sender ON transfers(sender_id, status);

CREATE TABLE IF NOT EXISTS seq (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO seq VALUES ('rev', 0);
CREATE TABLE IF NOT EXISTS schema_info (version INTEGER NOT NULL);
"""
SCHEMA_VERSION = 2


def now() -> int:
    return int(time.time())


class Database:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        # Contrôle du format AVANT toute écriture (le passage en WAL modifie déjà le fichier).
        old = self._db.execute("SELECT 1 FROM sqlite_master WHERE name = 'records'").fetchone()
        if old and not self._db.execute("SELECT 1 FROM pragma_table_info('records') WHERE name = 'space_id'").fetchone():
            self._db.close()
            raise RuntimeError('Base Carnet Sync 0.1 détectée : format incompatible avec 0.2 (aucune donnée n’a été modifiée).')
        self._db.execute('PRAGMA journal_mode=WAL')
        self._db.execute('PRAGMA synchronous=FULL')  # aucune écriture confirmée sans être sur le disque
        self._db.executescript(SCHEMA)
        if not self._db.execute('SELECT 1 FROM schema_info').fetchone():
            self._db.execute('INSERT INTO schema_info VALUES (?)', (SCHEMA_VERSION,))

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """Transaction exclusive : écriture atomique (tout ou rien)."""
        with self._lock:
            self._db.execute('BEGIN IMMEDIATE')
            try:
                yield self._db
                self._db.execute('COMMIT')
            except BaseException:
                self._db.execute('ROLLBACK')
                raise

    def q(self, sql: str, args: tuple = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, args).fetchall()]

    def one(self, sql: str, args: tuple = ()) -> dict[str, Any] | None:
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def x(self, sql: str, args: tuple = ()) -> None:
        with self.tx() as c:
            c.execute(sql, args)

    @staticmethod
    def next_rev(c: sqlite3.Connection) -> int:
        c.execute("UPDATE seq SET value = value + 1 WHERE name = 'rev'")
        return c.execute("SELECT value FROM seq WHERE name = 'rev'").fetchone()[0]

    def backup_to(self, dest: Path) -> None:
        """Copie cohérente de la base (API de sauvegarde SQLite), même pendant l'utilisation."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        target = sqlite3.connect(dest)
        with self._lock:
            self._db.backup(target)
        target.close()
