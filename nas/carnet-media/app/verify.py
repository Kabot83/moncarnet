"""Contrôle réel des fichiers : un MP4 n'est déclaré prêt qu'après décodage complet par ffmpeg."""
from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path


class VerifyError(Exception):
    pass


def verify_mp4(path: Path, ffmpeg: str, timeout: int = 180) -> dict:
    if not path.exists() or path.stat().st_size < 1024:
        raise VerifyError('Fichier absent ou vide.')
    with path.open('rb') as f:
        if f.read(12)[4:8] != b'ftyp':
            raise VerifyError('Ce n’est pas un fichier MP4.')
    # Description des pistes.
    info = subprocess.run([ffmpeg, '-hide_banner', '-i', str(path)], capture_output=True, text=True, errors='replace', timeout=60).stderr
    video = re.search(r'Stream #\S+.*Video: (\w+).*?, (\d{2,5})x(\d{2,5})', info)
    if not video:
        raise VerifyError('Aucune piste vidéo.')
    if video.group(1) not in ('h264', 'hevc', 'av1', 'vp9'):
        raise VerifyError(f'Codec vidéo non pris en charge : {video.group(1)}.')
    dur = re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)', info)
    duration = int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3)) if dur else None
    # Décodage complet : la moindre erreur rend le fichier invalide.
    dec = subprocess.run([ffmpeg, '-v', 'error', '-i', str(path), '-f', 'null', '-'], capture_output=True, text=True, errors='replace', timeout=timeout)
    if dec.returncode != 0 or dec.stderr.strip():
        raise VerifyError('Le fichier ne se décode pas entièrement : ' + dec.stderr.strip()[:200])
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return {
        'codec': video.group(1),
        'width': int(video.group(2)),
        'height': int(video.group(3)),
        'duration': duration,
        'audio': 'Audio:' in info,
        'bytes': path.stat().st_size,
        'sha256': h.hexdigest(),
    }
