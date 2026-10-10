# Carnet Media — Synology DS920+ (x86_64), Container Manager (DSM 7.4).
FROM python:3.13-slim

LABEL org.opencontainers.image.source="https://github.com/Kabot83/moncarnet" \
      org.opencontainers.image.description="Carnet Media : récupération des vidéos de recettes pour Mon Carnet (usage familial)"

# ffmpeg : contrôle réel des fichiers (décodage complet).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
# Volontairement SANS curl_cffi : aucune imitation de navigateur n'est possible.
RUN pip install --no-cache-dir -r requirements.txt \
 && ! python -c "import curl_cffi" 2>/dev/null
COPY app ./app

# Utilisateur sans privilèges (remplaçable dans la configuration par l'utilisateur Synology).
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin carnet
USER carnet

ENV CARNET_DATA_DIR=/data HOME=/tmp TZ=Europe/Paris PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8443
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import ssl,os,urllib.request as u;p=os.environ.get('CARNET_PORT','8443');s='https' if os.path.exists('/data/tls/cert.pem') else 'http';u.urlopen(f'{s}://127.0.0.1:{p}/v1/health',context=ssl._create_unverified_context(),timeout=4)"
CMD ["python", "-m", "app.serve"]
