# Carnet Sync — Synology DS920+ (x86_64), Container Manager (DSM 7.4).
# Prototype (étape A) : image préparée, NON publiée et NON déployée.
FROM python:3.13-slim

LABEL org.opencontainers.image.source="https://github.com/Kabot83/moncarnet" \
      org.opencontainers.image.description="Carnet Sync : synchronisation privée de Mon Carnet (comptes individuels)"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin carnet
USER carnet

ENV SYNC_DATA_DIR=/data SYNC_PORT=8090 HOME=/tmp TZ=Europe/Paris PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8090
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request as u;u.urlopen('http://127.0.0.1:'+os.environ.get('SYNC_PORT','8090')+'/v1/health',timeout=4)"
CMD ["python", "-m", "app.serve"]
