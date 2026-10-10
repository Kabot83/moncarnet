"""Traitement des demandes en arrière-plan, une à la fois (ressources du NAS, respect des plateformes).

Chaque publication : métadonnées → miniature → vidéo MP4 → contrôle ffmpeg. Si la vidéo ne peut
pas être récupérée, la fiche et ses métadonnées sont conservées, avec la raison : Mon Carnet
proposera alors l'import depuis la galerie.
"""
from __future__ import annotations

import logging
import queue
import threading

from . import providers
from .config import Settings
from .links import parse
from .providers import ProviderError
from .store import Store
from .verify import VerifyError, verify_mp4

log = logging.getLogger('carnet-media')


class Worker:
    def __init__(self, store: Store, settings: Settings):
        self.store = store
        self.settings = settings
        self.q: queue.Queue[str] = queue.Queue()
        self._thread = threading.Thread(target=self._run, name='carnet-media-worker', daemon=True)

    def start(self) -> None:
        # Tâches interrompues par un redémarrage du NAS ou du conteneur : reprises.
        for j in self.store.q("SELECT id FROM jobs WHERE status IN ('queued','metadata','downloading','verifying')"):
            self.q.put(j['id'])
        self._thread.start()

    def submit(self, job_id: str) -> None:
        self.q.put(job_id)

    def _run(self) -> None:
        while True:
            jid = self.q.get()
            try:
                self.process(jid)
            except Exception:  # noqa: BLE001 — une tâche ne doit jamais arrêter le service
                log.exception('tâche %s : erreur interne', jid)
                self.store.update_job(jid, status='failed', error_kind='internal', message='Erreur interne du service.')

    def process(self, jid: str) -> None:
        s, st = self.settings, self.store
        job = st.job(jid)
        if not job:
            return
        link = parse(job['url'])
        if not link:
            st.update_job(jid, status='failed', error_kind='invalid_url', message='Lien non pris en charge.')
            return
        st.update_job(jid, status='metadata', progress=0)

        # 1. Métadonnées (légende, créateur, miniature).
        try:
            if link.platform == 'tiktok':
                link, meta = providers.tiktok_metadata(link)
                info = None
            else:
                link = providers.resolve_short(link)
                link, meta, info = providers.instagram_metadata(link, s.max_bytes, s.max_duration_s)
        except ProviderError as e:
            log.info('tâche %s : %s, métadonnées indisponibles (%s)', jid, link.platform, e.kind)
            st.update_job(jid, status='failed', error_kind=e.kind, message=e.message)
            return
        key = link.key
        assert key
        st.update_job(jid, key=key)
        existing = st.media(key)
        st.upsert_media(key, url=link.url, **{k: meta[k] for k in ('title', 'title_status', 'caption', 'caption_status', 'creator', 'handle', 'meta_source')})
        if not (existing and existing['thumbnail_file'] and (st.files / existing['thumbnail_file']).exists()):
            thumb = f"{key.replace(':', '-')}.jpg"
            if providers.fetch_thumbnail(meta.get('thumbnail_url'), st.files / thumb):
                st.upsert_media(key, thumbnail_file=thumb)

        # 2. Vidéo déjà présente sur le NAS : aucun nouveau téléchargement.
        if existing and existing['video_status'] == 'ready' and existing['video_file'] and (st.files / existing['video_file']).exists():
            st.update_job(jid, status='done', progress=1, message='Vidéo déjà enregistrée sur le NAS.')
            return
        if link.platform == 'tiktok' and not s.tiktok_video:
            st.upsert_media(key, video_status='not_available', video_message='Téléchargement TikTok désactivé sur ce service.')
            st.update_job(jid, status='done', progress=1, message='Métadonnées récupérées ; vidéo TikTok désactivée.')
            return
        if s.max_storage_bytes and st.used_bytes() >= s.max_storage_bytes:
            st.upsert_media(key, video_status='failed', video_message='Espace réservé au service plein : supprimez des vidéos ou augmentez la limite.')
            st.update_job(jid, status='failed', error_kind='storage_full', message='Espace réservé au service plein.')
            return

        # 3. Téléchargement puis contrôle réel du fichier.
        video = f"{key.replace(':', '-')}.mp4"
        dest = st.files / video
        part = dest.with_suffix('.part.mp4')
        st.update_job(jid, status='downloading', progress=0)
        st.upsert_media(key, video_status='downloading', video_message='')

        def progress(p: float) -> None:
            st.update_job(jid, progress=round(p, 3))

        try:
            if link.platform == 'tiktok':
                providers.tiktok_video(link, part, s.max_bytes, s.max_duration_s, progress)
            else:
                providers.instagram_video(info, part, s.max_bytes, s.max_duration_s, progress)
            st.update_job(jid, status='verifying', progress=0.99)
            v = verify_mp4(part, s.ffmpeg)
            if v['duration'] and v['duration'] > s.max_duration_s:
                raise ProviderError('too_long', 'Vidéo trop longue.')
        except (ProviderError, VerifyError) as e:
            part.unlink(missing_ok=True)
            kind = e.kind if isinstance(e, ProviderError) else 'verification_failed'
            msg = e.message if isinstance(e, ProviderError) else str(e)
            retry = isinstance(e, ProviderError) and e.retry
            log.info('tâche %s : %s vidéo non récupérée (%s)', jid, key, kind)
            st.upsert_media(key, video_status='failed' if retry else 'not_available', video_message=msg)
            # Les métadonnées sont acquises : la tâche aboutit, la vidéo est signalée indisponible.
            st.update_job(jid, status='done', progress=1, error_kind=kind, message=f'Métadonnées récupérées ; vidéo non récupérée : {msg}')
            return
        part.replace(dest)  # fichier visible seulement une fois vérifié
        st.upsert_media(key, video_file=video, video_bytes=v['bytes'], video_sha256=v['sha256'], duration=v['duration'], width=v['width'], height=v['height'], video_status='ready', video_message='')
        log.info('tâche %s : %s vidéo enregistrée (%d Ko, %.0f s)', jid, key, v['bytes'] // 1024, v['duration'] or 0)
        st.update_job(jid, status='done', progress=1, message='Vidéo enregistrée et vérifiée.')
