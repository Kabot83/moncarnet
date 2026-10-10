"""Liens pris en charge : publications TikTok et Instagram précises, rien d'autre.

Liste fermée de domaines et de formes de chemins : le service ne peut pas être utilisé pour
télécharger n'importe quelle adresse (pas de profils, de listes, de directs, ni d'autres sites).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

TIKTOK_HOST = re.compile(r'^(?:(?:www|m|vm|vt)\.)?tiktok\.com$', re.I)
INSTAGRAM_HOST = re.compile(r'^(?:(?:www|m)\.)?(?:instagram\.com|instagr\.am)$', re.I)
IG_CODE = r'[A-Za-z0-9_-]{5,64}'


@dataclass(frozen=True)
class Link:
    platform: str  # 'tiktok' | 'instagram'
    kind: str  # 'video' | 'reel' | 'post' | 'unknown'
    post_id: str | None
    url: str
    short: bool
    handle: str | None = None

    @property
    def key(self) -> str | None:
        return f'{self.platform}:{self.post_id}' if self.post_id else None


def parse(raw: str) -> Link | None:
    s = (raw or '').strip()
    if len(s) > 2000:
        return None
    if not re.match(r'^[a-z][a-z0-9+.-]*://', s, re.I):
        s = 'https://' + s
    try:
        u = urlsplit(s)
    except ValueError:
        return None
    if u.scheme not in ('http', 'https') or u.username or u.password or u.port not in (None, 443):
        return None
    host = (u.hostname or '').lower()
    path = re.sub(r'/+$', '', u.path)

    if TIKTOK_HOST.match(host):
        if host.startswith(('vm.', 'vt.')):
            m = re.fullmatch(r'/([A-Za-z0-9]+)', path)
            return Link('tiktok', 'unknown', None, f'https://{host}/{m.group(1)}/', True) if m else None
        m = re.fullmatch(r'/t/([A-Za-z0-9]+)', path)
        if m:
            return Link('tiktok', 'unknown', None, f'https://www.tiktok.com/t/{m.group(1)}/', True)
        m = re.fullmatch(r'/@([^/]+)/video/(\d{8,25})', path)
        if m:
            return Link('tiktok', 'video', m.group(2), f'https://www.tiktok.com/@{m.group(1)}/video/{m.group(2)}', False, m.group(1))
        m = re.fullmatch(r'/(?:v/(\d{8,25})\.html|video/(\d{8,25}))', path)
        if m:
            vid = m.group(1) or m.group(2)
            return Link('tiktok', 'video', vid, f'https://www.tiktok.com/video/{vid}', False)
        return None

    if INSTAGRAM_HOST.match(host):
        m = re.fullmatch(rf'/share/(?:(reel|p)/)?({IG_CODE})', path)
        if m:
            return Link('instagram', 'reel' if m.group(1) == 'reel' else 'unknown', None, f'https://www.instagram.com{u.path}', True)
        m = re.fullmatch(rf'(?:/([A-Za-z0-9._]{{1,30}}))?/(p|reel|reels|tv)/({IG_CODE})', path)
        if m:
            kind = 'post' if m.group(2) == 'p' else 'reel'
            return Link('instagram', kind, m.group(3), f"https://www.instagram.com/{'p' if kind == 'post' else 'reel'}/{m.group(3)}/", False, m.group(1))
    return None


# Hôtes autorisés pour les fichiers (miniatures, vidéos) : CDN des deux plateformes uniquement.
MEDIA_HOSTS = re.compile(r'(^|\.)(cdninstagram\.com|fbcdn\.net|tiktokcdn\.com|tiktokcdn-eu\.com|tiktokcdn-us\.com|ibyteimg\.com|tiktok\.com|tiktokv\.com|byteoversea\.com)$', re.I)


def media_host_allowed(url: str) -> bool:
    try:
        u = urlsplit(url)
    except ValueError:
        return False
    return u.scheme == 'https' and bool(u.hostname) and bool(MEDIA_HOSTS.search(u.hostname or ''))
