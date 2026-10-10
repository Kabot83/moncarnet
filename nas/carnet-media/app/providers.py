"""Récupération des métadonnées et des vidéos publiques.

Garde-fous verrouillés dans le code (aucune option pour les lever) :
- jamais de cookies, de compte, ni d'imitation de navigateur ; aucun contenu privé, aucun DRM ;
- uniquement des publications TikTok / Instagram précises (liste fermée, voir links.py) ;
- fichiers récupérés seulement depuis les CDN des plateformes, sur des adresses IP publiques
  (aucun accès au réseau local ni au NAS lui-même, même par redirection ou DNS piégé).

TikTok : métadonnées par l'oEmbed officiel ; vidéo par le lecteur intégré officiel (embed/v2).
Instagram : yt-dlp, en accès anonyme (sans connexion).
"""
from __future__ import annotations

import ipaddress
import json
import logging
import re
import socket
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from .links import Link, media_host_allowed, parse

log = logging.getLogger('carnet-media')
UA = 'CarnetMedia/0.2 (service familial Mon Carnet)'
Progress = Callable[[float], None]


class ProviderError(Exception):
    """kind : short_link_unresolved, private_or_removed, unavailable_logged_out, rate_limited,
    not_available, too_long, too_large, incomplete, blocked_address, network.
    `retry` : un nouvel essai plus tard a des chances d'aboutir."""

    def __init__(self, kind: str, message: str, retry: bool = False):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.retry = retry


# ---------------------------------------------------------------------------
# Réseau : adresses publiques uniquement
# ---------------------------------------------------------------------------

def assert_public_host(url: str) -> None:
    """Refuse toute adresse qui résout vers le réseau local, la boucle locale ou une plage réservée."""
    host = urlsplit(url).hostname or ''
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError as e:
        raise ProviderError('network', f'Nom de serveur introuvable ({host}).', retry=True) from e
    for info in infos:
        if not ipaddress.ip_address(info[4][0]).is_global:
            raise ProviderError('blocked_address', 'Adresse refusée : elle mène au réseau local.')


def _client() -> httpx.Client:
    # Client neuf à chaque appel : aucune redirection automatique, aucun cookie conservé.
    return httpx.Client(headers={'User-Agent': UA}, timeout=httpx.Timeout(20, read=60), follow_redirects=False)


def _get(c: httpx.Client, url: str, **kw: Any) -> httpx.Response:
    assert_public_host(url)
    try:
        r = c.get(url, **kw)
    except httpx.HTTPError as e:
        raise ProviderError('network', f'Service injoignable ({type(e).__name__}).', retry=True) from e
    c.cookies.clear()
    return r


# ---------------------------------------------------------------------------
# Liens courts
# ---------------------------------------------------------------------------

_VIDEO_IN_PAGE = re.compile(r'https?:\\?/\\?/(?:www\.)?tiktok\.com\\?/@([\w.]+)\\?/(video|photo)\\?/(\d{8,25})')


def resolve_short(link: Link) -> Link:
    """Lien court → publication : redirections publiques suivies une à une (sans cookies), puis,
    si la dernière page est une page de vidéo, lecture de son adresse canonique."""
    if not link.short:
        return link
    url, last = link.url, None
    with _client() as c:
        for _ in range(8):
            r = _get(c, url, headers={'Accept': 'text/html'})
            loc = r.headers.get('location')
            if r.status_code in (301, 302, 303, 307, 308) and loc:
                url = str(httpx.URL(url).join(loc))
                target = parse(url)
                if target and not target.short:
                    return target
                continue
            last = r
            break
    if last is not None and last.status_code == 200:
        m = _VIDEO_IN_PAGE.search(last.text[:400_000])
        if m:
            target = parse(f'https://www.tiktok.com/@{m.group(1)}/{m.group(2)}/{m.group(3)}')
            if target:
                return target
    log.info('lien court non résolu (%s) : arrivée sur %s', link.platform, urlsplit(url).path or '/')
    raise ProviderError('short_link_unresolved', 'Lien court non résolu : la plateforme renvoie vers sa page d’accueil (lien expiré ou réservé à l’application). La fiche est conservée.')


# ---------------------------------------------------------------------------
# Titre et légende
# ---------------------------------------------------------------------------

_INVISIBLE = re.compile('[​-‏⁠-⁤﻿]')


def title_from_caption(caption: str | None) -> str | None:
    """Première phrase utile de la légende, sans mots-dièse ni mentions. Jamais un pseudo."""
    for line in _INVISIBLE.sub('', caption or '').splitlines():
        t = re.sub(r'(^|\s)[#@][\w.À-ɏ]+', ' ', line)
        t = re.sub(r'\s+', ' ', t).strip(' -–—|•·:')
        if len(t) >= 3:
            return t[:120]
    return None


def _meta(caption: str | None, creator: str | None, handle: str | None, thumbnail: str | None, source: str) -> dict[str, Any]:
    caption = _INVISIBLE.sub('', caption).strip() if caption else None
    title = title_from_caption(caption)
    return {
        'caption': caption or None,
        # Légende lue dans le champ officiel de la publication : complète telle que publiée.
        'caption_status': 'full' if caption else 'unavailable',
        'title': title,
        # Ni TikTok ni Instagram n'ont de vrai titre : il est tiré de la légende, et signalé comme tel.
        'title_status': 'from_caption' if title else 'unavailable',
        'creator': creator,
        'handle': handle,
        'thumbnail_url': thumbnail,
        'meta_source': source,
    }


# ---------------------------------------------------------------------------
# TikTok
# ---------------------------------------------------------------------------

def tiktok_metadata(link: Link) -> tuple[Link, dict[str, Any]]:
    link = resolve_short(link)
    with _client() as c:
        r = _get(c, 'https://www.tiktok.com/oembed', params={'url': link.url})
    if r.status_code == 429:
        raise ProviderError('rate_limited', 'TikTok limite les requêtes pour le moment.', retry=True)
    if r.status_code >= 500:
        raise ProviderError('network', 'TikTok ne répond pas pour le moment.', retry=True)
    try:
        o = r.json()
    except ValueError:
        o = {}
    if r.status_code != 200 or not o.get('embed_product_id'):
        raise ProviderError('private_or_removed', 'Vidéo privée, supprimée, introuvable ou non intégrable.')
    vid = str(o['embed_product_id'])
    handle = o.get('author_unique_id') or link.handle
    kind = 'photo' if o.get('embed_type') == 'photo' or link.kind == 'photo' else 'video'
    url = f'https://www.tiktok.com/@{handle}/{kind}/{vid}' if handle else f'https://www.tiktok.com/video/{vid}'
    return Link('tiktok', kind, vid, url, False, handle), _meta(o.get('title') or None, o.get('author_name'), handle, o.get('thumbnail_url'), 'tiktok_oembed')


def tiktok_video(link: Link, dest: Path, max_bytes: int, max_duration: int, progress: Progress) -> None:
    """Fichier MP4 public servi par le lecteur intégré officiel (embed/v2)."""
    if link.kind == 'photo':
        raise ProviderError('not_available', 'Publication TikTok composée de photos : aucune vidéo à enregistrer.')
    with _client() as c:
        r = _get(c, f'https://www.tiktok.com/embed/v2/{link.post_id}')
        m = re.search(r'<script[^>]+id="__FRONTITY_CONNECT_STATE__"[^>]*>(.*?)</script>', r.text, re.S)
        try:
            data = json.loads(m.group(1)) if m else {}
            item = data['source']['data'][f'/embed/v2/{link.post_id}']['videoData']['itemInfos']
            urls = [u for u in item['video']['urls'] if media_host_allowed(u)]
            duration = (item['video'].get('videoMeta') or {}).get('duration') or 0
        except (KeyError, IndexError, TypeError, ValueError, AttributeError) as e:
            raise ProviderError('not_available', 'Le lecteur officiel ne fournit pas de vidéo pour cette publication.', retry=True) from e
        if duration and duration > max_duration:
            raise ProviderError('too_long', f'Vidéo trop longue ({duration} s).')
        if not urls:
            raise ProviderError('not_available', 'Aucune adresse vidéo utilisable dans le lecteur officiel.')
        last: ProviderError | None = None
        for u in urls[:3]:
            try:
                _stream(c, u, dest, max_bytes, progress)
                return
            except ProviderError as e:  # adresse de secours suivante
                last = e
                dest.unlink(missing_ok=True)
        assert last is not None
        raise last


# ---------------------------------------------------------------------------
# Instagram (yt-dlp, accès anonyme)
# ---------------------------------------------------------------------------

class _YdlLogger:
    """Messages de yt-dlp : seulement la première ligne, au niveau « debug » (les erreurs sont
    traduites et journalisées par le service lui-même)."""

    def debug(self, msg: str) -> None:
        pass

    info = warning = debug

    def error(self, msg: str) -> None:
        log.debug('yt-dlp : %s', str(msg).splitlines()[0][:200])


def _ydl_opts(max_bytes: int, max_duration: int) -> dict[str, Any]:
    return {
        'logger': _YdlLogger(),
        'quiet': True,
        'no_warnings': True,
        'noprogress': True,
        'noplaylist': True,
        'cachedir': False,  # conteneur en lecture seule
        'cookiefile': None,
        'cookiesfrombrowser': None,
        'socket_timeout': 20,
        'retries': 2,
        'max_filesize': max_bytes,
        # Instagram ne déclare pas toujours ses codecs : meilleur MP4 progressif, puis ffmpeg
        # vérifie réellement le fichier (verify.py) avant de le déclarer prêt.
        'format': 'best[ext=mp4][protocol^=http]/best[protocol^=http]',
        'match_filter': lambda info, *, incomplete=False: (
            f'Vidéo trop longue ({int(info["duration"])} s)' if info.get('duration') and info['duration'] > max_duration else None
        ),
    }


def _map_ytdlp_error(e: Exception) -> ProviderError:
    """Traduction prudente : quand la cause est ambiguë, le message le dit, sans deviner."""
    msg = str(e).lower()
    if 'no video formats' in msg or 'requested format is not available' in msg:
        return ProviderError('not_available', 'Aucune vidéo téléchargeable dans cette publication (photo, carrousel ou format non pris en charge).')
    if 'rate-limit' in msg or 'rate limit' in msg or 'too many requests' in msg or '429' in msg:
        return ProviderError('rate_limited', 'Instagram limite les accès anonymes pour le moment.', retry=True)
    if 'empty media response' in msg or 'login' in msg or 'cookies' in msg:
        return ProviderError('unavailable_logged_out', 'Publication introuvable, privée, ou visible seulement avec un compte connecté (non utilisé par ce service).', retry=True)
    if 'private' in msg or 'does not exist' in msg or '404' in msg or 'not found' in msg:
        return ProviderError('private_or_removed', 'Publication privée, supprimée ou introuvable.')
    if 'trop longue' in msg:
        return ProviderError('too_long', str(e))
    if 'larger than max-filesize' in msg:
        return ProviderError('too_large', 'Vidéo trop volumineuse.')
    return ProviderError('network', 'Instagram n’a pas répondu comme prévu (nouvel essai plus tard ; yt-dlp est peut-être à mettre à jour).', retry=True)


def instagram_metadata(link: Link, max_bytes: int, max_duration: int) -> tuple[Link, dict[str, Any], dict[str, Any]]:
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL(_ydl_opts(max_bytes, max_duration)) as ydl:
            info = ydl.extract_info(link.url, download=False)
    except Exception as e:  # noqa: BLE001 — erreurs yt-dlp hétérogènes
        raise _map_ytdlp_error(e) from e
    code = info.get('id') or link.post_id
    handle = info.get('channel') or link.handle  # pseudo public (yt-dlp : « channel »)
    kind = 'post' if link.kind == 'post' else 'reel'
    link = Link('instagram', kind, code, f"https://www.instagram.com/{'p' if kind == 'post' else 'reel'}/{code}/", False, handle)
    # « Video by … » est fabriqué par yt-dlp : ce n'est pas un titre, il est ignoré.
    return link, _meta(info.get('description') or None, info.get('uploader'), handle, info.get('thumbnail'), 'instagram_public'), info


def instagram_video(info: dict[str, Any], dest: Path, max_bytes: int, max_duration: int, progress: Progress) -> None:
    import yt_dlp

    # Adresse(s) du fichier choisies par yt-dlp : contrôlées avant tout téléchargement.
    for f in info.get('requested_formats') or [info]:
        u = f.get('url') or ''
        if u and not media_host_allowed(u):
            raise ProviderError('blocked_address', 'Adresse vidéo inattendue : refusée.')
        if u:
            assert_public_host(u)

    def hook(d: dict[str, Any]) -> None:
        total = d.get('total_bytes') or d.get('total_bytes_estimate')
        if d.get('status') == 'downloading' and total:
            progress(min(0.99, d.get('downloaded_bytes', 0) / total))

    opts = {**_ydl_opts(max_bytes, max_duration), 'outtmpl': str(dest.with_suffix('.%(ext)s')), 'progress_hooks': [hook]}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.process_ie_result(info, download=True)
    except Exception as e:  # noqa: BLE001
        raise _map_ytdlp_error(e) from e
    if not dest.exists():
        raise ProviderError('not_available', 'Aucun fichier MP4 compatible n’a été obtenu.')


# ---------------------------------------------------------------------------
# Fichiers
# ---------------------------------------------------------------------------

def _stream(c: httpx.Client, url: str, dest: Path, max_bytes: int, progress: Progress) -> None:
    assert_public_host(url)
    total = got = 0
    try:
        with c.stream('GET', url) as r:
            if r.status_code != 200:
                raise ProviderError('not_available', f'Fichier refusé par la plateforme (HTTP {r.status_code}).', retry=r.status_code in (403, 429, 503))
            if not r.headers.get('content-type', '').startswith(('video/', 'application/octet-stream')):
                raise ProviderError('not_available', 'La plateforme n’a pas renvoyé de vidéo.')
            total = int(r.headers.get('content-length') or 0)
            if total > max_bytes:
                raise ProviderError('too_large', f'Vidéo trop volumineuse ({total // 1_048_576} Mo).')
            with dest.open('wb') as f:
                for chunk in r.iter_bytes(1 << 16):
                    got += len(chunk)
                    if got > max_bytes:
                        raise ProviderError('too_large', 'Vidéo trop volumineuse.')
                    f.write(chunk)
                    if total:
                        progress(min(0.99, got / total))
    except httpx.HTTPError as e:
        raise ProviderError('network', 'Transfert interrompu.', retry=True) from e
    if total and got != total:
        raise ProviderError('incomplete', f'Fichier incomplet ({got} octets sur {total}).', retry=True)


def fetch_thumbnail(url: str | None, dest: Path) -> bool:
    if not url or not media_host_allowed(url):
        return False
    try:
        with _client() as c:
            r = _get(c, url)
        if r.status_code != 200 or not r.headers.get('content-type', '').startswith('image/') or len(r.content) > 5 * 1024 * 1024:
            return False
        dest.write_bytes(r.content)
        return True
    except ProviderError:
        return False
