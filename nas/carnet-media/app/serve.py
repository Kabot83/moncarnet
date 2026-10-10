"""Lancement : HTTPS si un certificat existe dans /data/tls (réseau local), HTTP sinon
(uniquement derrière un tunnel, sur le réseau interne Docker).

Journal technique (Container Manager → Conteneur → Journal) : identifiants de tâches, plateformes,
types d'erreurs. Jamais de jeton ; aucun journal d'accès HTTP.
"""
import logging
import os
import sys

import uvicorn

from .config import VERSION, Settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s', stream=sys.stdout)
    log = logging.getLogger('carnet-media')
    # Bibliothèques réseau : silencieuses (elles journaliseraient les adresses complètes des fichiers).
    for noisy in ('httpx', 'httpcore', 'yt_dlp'):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    s = Settings.from_env()
    probe = s.data_dir / '.ecriture-test'
    try:
        s.data_dir.mkdir(parents=True, exist_ok=True)
        probe.write_text('ok')
        probe.unlink()
    except OSError:
        log.error('Écriture impossible dans %s : vérifiez les droits du dossier sur le NAS (voir README, étape « droits »).', s.data_dir)
        sys.exit(1)
    cert, key = s.data_dir / 'tls' / 'cert.pem', s.data_dir / 'tls' / 'key.pem'
    tls = cert.exists() and key.exists()
    port = int(os.environ.get('CARNET_PORT', '8443' if tls else '8080'))
    log.info('Carnet Media %s : %s sur le port %d ; vidéos TikTok %s ; limites %d Mo / %d s',
             VERSION, 'HTTPS' if tls else 'HTTP (réseau interne)', port, 'activées' if s.tiktok_video else 'désactivées', s.max_bytes // 1_048_576, s.max_duration_s)
    if not tls:
        log.warning('Aucun certificat : créez-le avec « python -m app.admin cert create --ip <IP du NAS> » puis redémarrez.')
    uvicorn.run(
        'app.main:create_app',
        factory=True,
        host=os.environ.get('CARNET_HOST', '0.0.0.0'),
        port=port,
        ssl_certfile=str(cert) if tls else None,
        ssl_keyfile=str(key) if tls else None,
        proxy_headers=False,
        server_header=False,
        access_log=False,
        log_level='warning',
        workers=1,
    )


if __name__ == '__main__':
    main()
