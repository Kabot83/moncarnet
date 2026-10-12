"""Lancement du service (HTTP sur le réseau interne Docker : HTTPS assuré par le reverse proxy
Synology, comme pour Carnet Media ; aucun journal d'accès, aucun jeton journalisé)."""
import logging
import os
import sys

import uvicorn

from .backup import apply_pending_restore
from .config import VERSION, Settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s', stream=sys.stdout)
    logging.getLogger('carnet-sync').info('Carnet Sync %s', VERSION)
    apply_pending_restore(Settings.from_env())  # restauration demandée par « app.admin restore »
    uvicorn.run('app.main:create_app', factory=True, host=os.environ.get('SYNC_HOST', '0.0.0.0'), port=int(os.environ.get('SYNC_PORT', '8090')),
                proxy_headers=False, server_header=False, access_log=False, log_level='warning', workers=1)


if __name__ == '__main__':
    main()
