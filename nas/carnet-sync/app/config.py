"""Configuration (variables d'environnement, valeurs prudentes par défaut)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

VERSION = '0.2.0'

# Collections synchronisées : liste fermée (tables Dexie de Mon Carnet + partie personnelle des
# recettes familiales, « recipeMeta »).
COLLECTIONS = ('recipes', 'photos', 'journal', 'collections', 'shopping', 'posts', 'foods', 'foodMemory', 'recipeMeta')


def _int(name: str, default: int) -> int:
    v = os.environ.get(name)
    return int(v) if v else default


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    access_ttl_s: int
    refresh_ttl_s: int
    transfer_ttl_s: int
    max_record_bytes: int
    max_blob_bytes: int
    max_user_bytes: int
    cors_origins: tuple[str, ...]
    # Sauvegarde nocturne automatique (désactivée si aucun dossier n'est indiqué).
    backup_dir: Path | None = None
    backup_time: str = '03:15'
    backup_keep_daily: int = 14
    backup_keep_weekly: int = 8

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            data_dir=Path(os.environ.get('SYNC_DATA_DIR', '/data')),
            access_ttl_s=_int('SYNC_ACCESS_TTL_S', 3600),  # jeton d'accès : 1 h
            refresh_ttl_s=_int('SYNC_REFRESH_TTL_S', 90 * 86400),  # session : 90 jours sans utilisation
            transfer_ttl_s=_int('SYNC_TRANSFER_TTL_S', 30 * 86400),  # invitation : 30 jours
            max_record_bytes=_int('SYNC_MAX_RECORD_KB', 512) * 1024,
            max_blob_bytes=_int('SYNC_MAX_BLOB_MB', 25) * 1024 * 1024,
            max_user_bytes=_int('SYNC_MAX_USER_GB', 20) * 1024**3,
            cors_origins=tuple(o.strip() for o in os.environ.get('SYNC_CORS_ORIGINS', 'https://localhost,https://kabot83.github.io').split(',') if o.strip()),
            backup_dir=Path(os.environ['SYNC_BACKUP_DIR']) if os.environ.get('SYNC_BACKUP_DIR') else None,
            backup_time=os.environ.get('SYNC_BACKUP_TIME', '03:15'),
            backup_keep_daily=_int('SYNC_BACKUP_KEEP_DAILY', 14),
            backup_keep_weekly=_int('SYNC_BACKUP_KEEP_WEEKLY', 8),
        )
