"""Configuration du service (variables d'environnement, valeurs prudentes par défaut)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

VERSION = '0.2.0'


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in ('1', 'true', 'yes', 'oui')


def _int(name: str, default: int) -> int:
    v = os.environ.get(name)
    return default if not v else int(v)


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    #: Durée et taille maximales d'une vidéo.
    max_duration_s: int
    max_bytes: int
    #: Espace maximal occupé par les vidéos et miniatures (0 = sans limite).
    max_storage_bytes: int
    #: TikTok : vidéo du lecteur intégré officiel (interrupteur de secours si TikTok change).
    tiktok_video: bool
    #: Origines autorisées (application Capacitor, PWA).
    cors_origins: tuple[str, ...]
    #: Nombre de demandes d'import par heure et par appareil.
    jobs_per_hour: int
    ffmpeg: str

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            data_dir=Path(os.environ.get('CARNET_DATA_DIR', '/data')),
            max_duration_s=_int('CARNET_MAX_DURATION_S', 600),
            max_bytes=_int('CARNET_MAX_MB', 200) * 1024 * 1024,
            max_storage_bytes=_int('CARNET_MAX_STORAGE_GB', 200) * 1024**3,
            tiktok_video=_bool('CARNET_TIKTOK_VIDEO', True),
            cors_origins=tuple(o.strip() for o in os.environ.get('CARNET_CORS_ORIGINS', 'https://localhost,https://kabot83.github.io').split(',') if o.strip()),
            jobs_per_hour=_int('CARNET_JOBS_PER_HOUR', 20),
            ffmpeg=os.environ.get('CARNET_FFMPEG', 'ffmpeg'),
        )
