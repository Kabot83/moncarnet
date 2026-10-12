"""Sauvegardes du serveur (distinctes de la synchronisation) et contrôles de cohérence.

Sauvegarde : `<racine>/carnet-sync-AAAAMMJJ-HHMMSS/`
- `carnet-sync.sqlite3` : copie par l'API de sauvegarde SQLite (instantané cohérent, compatible
  avec le mode WAL, sans arrêter le service) ;
- `files/…` et `transfers/…` : exactement les fichiers référencés par CET instantané. Les photos
  étant adressées par leur contenu (jamais modifiées), un fichier identique à la sauvegarde
  précédente y est relié (lien physique) au lieu d'être recopié : chaque version est complète,
  sans multiplier l'espace occupé ;
- `manifest.json` : empreinte SHA-256 de chaque fichier.
La sauvegarde est écrite dans un dossier temporaire, contrôlée, puis renommée : une sauvegarde
visible est toujours complète. Historique : 14 dernières nuits + 1 par semaine sur 8 semaines.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from .config import VERSION, Settings
from .db import Database, now

log = logging.getLogger('carnet-sync')
PREFIX = 'carnet-sync-'
TMP_PREFIX = '.en-cours-'
DB_FILE = 'carnet-sync.sqlite3'


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _ro(db_path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(f'file:{db_path.as_posix()}?mode=ro', uri=True)
    c.row_factory = sqlite3.Row
    return c


# ---------------------------------------------------------------------------
# Cohérence base ↔ fichiers
# ---------------------------------------------------------------------------

def check(db_path: Path, data_dir: Path, full: bool = False) -> dict:
    """Contrôle : intégrité SQLite, chaque fichier déclaré présent (taille, et empreinte si `full`),
    chaque photo synchronisée rattachée à un fichier, fichiers des invitations en attente."""
    errors: list[str] = []
    warnings: list[str] = []
    c = _ro(db_path)
    try:
        ic = c.execute('PRAGMA integrity_check').fetchone()[0]
        if ic != 'ok':
            errors.append(f'Base SQLite endommagée : {ic}')
        known: set[tuple[str, str]] = set()
        blobs = c.execute('SELECT owner_id, sha256, size FROM blobs').fetchall()
        for b in blobs:
            known.add((b['owner_id'], b['sha256']))
            p = data_dir / 'files' / b['owner_id'] / b['sha256'][:2] / b['sha256']
            if not p.exists():
                errors.append(f'Fichier manquant : files/{b["owner_id"]}/…/{b["sha256"][:12]}')
            elif p.stat().st_size != b['size']:
                errors.append(f'Taille incorrecte : {b["sha256"][:12]}')
            elif full and sha256_file(p) != b['sha256']:
                errors.append(f'Contenu altéré : {b["sha256"][:12]}')
        photos = c.execute("SELECT owner_id, id, data FROM records WHERE collection = 'photos' AND deleted = 0").fetchall()
        for r in photos:
            d = json.loads(r['data'])
            for sha in {d.get('sha256'), d.get('thumbSha256')} - {None, ''}:
                if (r['owner_id'], sha) not in known:
                    errors.append(f'Photo {r["id"]} sans fichier enregistré ({sha[:12]})')
        pending = c.execute("SELECT id, blob_hashes FROM transfers WHERE status = 'pending'").fetchall()
        for t in pending:
            for sha in json.loads(t['blob_hashes']):
                if not (data_dir / 'transfers' / t['id'] / sha).exists():
                    errors.append(f'Invitation {t["id"]} : fichier figé manquant ({sha[:12]})')
        counts = {
            'users': c.execute('SELECT COUNT(*) FROM users').fetchone()[0],
            'records': c.execute('SELECT COUNT(*) FROM records WHERE deleted = 0').fetchone()[0],
            'photos': len(photos),
            'files': len(blobs),
            'pending_transfers': len(pending),
        }
    finally:
        c.close()
    files_root = data_dir / 'files'
    if files_root.exists():
        for p in files_root.rglob('*'):
            if p.is_file():
                owner = p.relative_to(files_root).parts[0]
                if (owner, p.name) not in known:
                    warnings.append(f'Fichier non référencé (sans danger) : {p.name[:12]}')
    return {'ok': not errors, 'errors': errors, 'warnings': warnings, 'counts': counts}


# ---------------------------------------------------------------------------
# Sauvegarde
# ---------------------------------------------------------------------------

def list_backups(root: Path) -> list[Path]:
    """Sauvegardes complètes, de la plus récente à la plus ancienne."""
    if not root.exists():
        return []
    return sorted((p for p in root.iterdir() if p.is_dir() and p.name.startswith(PREFIX) and (p / 'manifest.json').exists()), key=lambda p: p.name, reverse=True)


def _place(src: Path, dest: Path, sha: str, prev: Path | None, prev_files: dict[str, str], rel: str) -> bool:
    """Lien physique vers la sauvegarde précédente si le fichier est identique, sinon copie vérifiée."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if prev and prev_files.get(rel) == sha and (prev / rel).exists():
        try:
            os.link(prev / rel, dest)
            return True
        except OSError:
            pass  # système de fichiers sans liens physiques : copie
    if not src.exists():
        return False
    shutil.copyfile(src, dest)
    return sha256_file(dest) == sha


def create_backup(s: Settings, db: Database, root: Path) -> dict:
    t0 = time.time()
    root.mkdir(parents=True, exist_ok=True)
    name = PREFIX + datetime.now().strftime('%Y%m%d-%H%M%S')
    final, tmp = root / name, root / (TMP_PREFIX + name)
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    try:
        db.backup_to(tmp / DB_FILE)  # instantané cohérent (WAL compris)
        snap = _ro(tmp / DB_FILE)
        try:
            wanted = [(f'files/{r["owner_id"]}/{r["sha256"][:2]}/{r["sha256"]}', r['sha256']) for r in snap.execute('SELECT owner_id, sha256 FROM blobs')]
            for t in snap.execute("SELECT id, blob_hashes FROM transfers WHERE status = 'pending'"):
                wanted += [(f'transfers/{t["id"]}/{sha}', sha) for sha in json.loads(t['blob_hashes'])]
        finally:
            snap.close()
        backups = list_backups(root)
        prev = backups[0] if backups else None
        prev_files = json.loads((prev / 'manifest.json').read_text())['files'] if prev else {}
        problems = [rel for rel, sha in wanted if not _place(s.data_dir / rel, tmp / rel, sha, prev, prev_files, rel)]
        manifest = {
            'format': 'carnet-sync-backup', 'version': 2, 'app': VERSION, 'created_at': now(),
            'database_sha256': sha256_file(tmp / DB_FILE), 'files': dict(wanted), 'problems': problems,
        }
        (tmp / 'manifest.json').write_text(json.dumps(manifest, indent=1))
        report = check(tmp / DB_FILE, tmp)
        os.replace(tmp, final)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    ok = report['ok'] and not problems
    return {'ok': ok, 'backup': final.name, 'errors': report['errors'] + [f'Fichier illisible : {p}' for p in problems], 'counts': report['counts'], 'duration_s': round(time.time() - t0, 1)}


def rotate(root: Path, keep_daily: int, keep_weekly: int) -> list[str]:
    """Garde les `keep_daily` plus récentes + la plus récente de chacune des `keep_weekly` semaines précédentes."""
    backups = list_backups(root)
    keep = set(backups[:keep_daily])
    weeks: dict[tuple[int, int], Path] = {}
    for b in backups[keep_daily:]:
        try:
            iso = datetime.strptime(b.name[len(PREFIX):], '%Y%m%d-%H%M%S').isocalendar()
        except ValueError:
            keep.add(b)  # nom inattendu : on ne touche pas
            continue
        weeks.setdefault((iso[0], iso[1]), b)
    keep |= set(sorted(weeks.values(), key=lambda p: p.name, reverse=True)[:keep_weekly])
    removed = []
    for b in backups:
        if b not in keep:
            shutil.rmtree(b, ignore_errors=True)
            removed.append(b.name)
    for t in root.glob(TMP_PREFIX + '*'):  # sauvegarde interrompue (arrêt du NAS…)
        if time.time() - t.stat().st_mtime > 86400:
            shutil.rmtree(t, ignore_errors=True)
    return removed


# ---------------------------------------------------------------------------
# Vérification et restauration
# ---------------------------------------------------------------------------

def verify_backup(src: Path) -> dict:
    """Relit TOUT : empreinte de la base et de chaque fichier, intégrité et cohérence."""
    errors = []
    try:
        manifest = json.loads((src / 'manifest.json').read_text())
    except (OSError, ValueError):
        return {'ok': False, 'errors': ['Ce dossier n’est pas une sauvegarde Carnet Sync (manifeste absent ou illisible).']}
    if manifest.get('format') != 'carnet-sync-backup':
        return {'ok': False, 'errors': ['Ce dossier n’est pas une sauvegarde Carnet Sync.']}
    if not (src / DB_FILE).exists() or sha256_file(src / DB_FILE) != manifest['database_sha256']:
        return {'ok': False, 'errors': ['Base de la sauvegarde absente ou corrompue (empreinte différente).']}
    for rel, sha in manifest['files'].items():
        p = src / rel
        if rel not in manifest.get('problems', []) and (not p.exists() or sha256_file(p) != sha):
            errors.append(f'Fichier corrompu ou manquant : {rel}')
    report = check(src / DB_FILE, src, full=False)
    return {'ok': not errors and report['ok'], 'errors': errors + report['errors'], 'counts': report['counts']}


def restore(s: Settings, src: Path) -> dict:
    """Restauration vérifiée, uniquement dans un dossier de données VIDE (jamais par-dessus)."""
    v = verify_backup(src)
    if not v['ok']:
        raise SystemExit('Sauvegarde corrompue : restauration annulée.\n' + '\n'.join(v['errors'][:20]))
    if (s.data_dir / DB_FILE).exists():
        raise SystemExit('Le dossier de données contient déjà une base : arrêtez le service et videz-le avant de restaurer.')
    manifest = json.loads((src / 'manifest.json').read_text())
    s.data_dir.mkdir(parents=True, exist_ok=True)
    for rel in manifest['files']:
        (s.data_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src / rel, s.data_dir / rel)
    shutil.copyfile(src / DB_FILE, s.data_dir / DB_FILE)  # la base en dernier : restauration interrompue = dossier sans base
    after = check(s.data_dir / DB_FILE, s.data_dir, full=True)
    if not after['ok']:
        raise SystemExit('Restauration incohérente :\n' + '\n'.join(after['errors'][:20]))
    return {'files': len(manifest['files']), 'counts': after['counts']}


def restore_test(src: Path, scratch: Path) -> dict:
    """Restauration « à blanc » dans un dossier temporaire, contrôlée puis effacée."""
    shutil.rmtree(scratch, ignore_errors=True)
    try:
        r = restore(Settings(data_dir=scratch, access_ttl_s=0, refresh_ttl_s=0, transfer_ttl_s=0, max_record_bytes=0, max_blob_bytes=0, max_user_bytes=0, cors_origins=()), src)
        return {'ok': True, **r}
    except SystemExit as e:
        return {'ok': False, 'errors': str(e).splitlines()}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


# ---------------------------------------------------------------------------
# Tâche nocturne
# ---------------------------------------------------------------------------

def nightly(s: Settings, db: Database) -> dict:
    """Expiration des invitations, sauvegarde + rotation, PUIS nettoyage des fichiers figés."""
    from .transfers import cleanup_frozen, expire_old

    status: dict = {'at': now(), 'expired_transfers': expire_old(db, s)}
    try:
        if s.backup_dir:
            status.update(create_backup(s, db, s.backup_dir))
            status['removed'] = rotate(s.backup_dir, s.backup_keep_daily, s.backup_keep_weekly)
        status['cleaned_transfers'] = cleanup_frozen(db, s)
    except Exception as e:  # noqa: BLE001 — consigné dans l'état de la sauvegarde
        status.update(ok=False, errors=[f'{type(e).__name__}: {e}'])
    if s.backup_dir:
        (s.backup_dir / 'etat.json').write_text(json.dumps(status, indent=1, ensure_ascii=False))
        level = logging.INFO if status.get('ok') else logging.ERROR
        log.log(level, 'Sauvegarde nocturne : %s', 'réussie' if status.get('ok') else 'ÉCHEC — ' + '; '.join(status.get('errors', [])[:3]))
    return status


def _next_run(hhmm: str, ref: datetime) -> datetime:
    h, m = (int(x) for x in hhmm.split(':'))
    t = ref.replace(hour=h, minute=m, second=0, microsecond=0)
    return t if t > ref else t + timedelta(days=1)


def start_scheduler(s: Settings, db: Database) -> threading.Thread:
    def loop() -> None:
        while True:
            wait = (_next_run(s.backup_time, datetime.now()) - datetime.now()).total_seconds()
            time.sleep(max(1.0, wait))
            nightly(s, db)

    th = threading.Thread(target=loop, name='sauvegarde-nocturne', daemon=True)
    th.start()
    log.info('Sauvegarde nocturne programmée à %s dans %s', s.backup_time, s.backup_dir)
    return th


# ---------------------------------------------------------------------------
# Restauration sur le NAS : demandée par commande, appliquée au redémarrage
# ---------------------------------------------------------------------------

def _marker(s: Settings) -> Path:
    return s.data_dir.parent / 'restauration-demandee.json'


def request_restore(s: Settings, src: Path) -> dict:
    """Vérifie la sauvegarde puis programme sa restauration au prochain démarrage du conteneur."""
    v = verify_backup(src)
    if not v['ok']:
        raise SystemExit('Sauvegarde corrompue : restauration refusée.\n' + '\n'.join(v['errors'][:20]))
    _marker(s).write_text(json.dumps({'source': str(src), 'requested_at': now()}))
    return v


def apply_pending_restore(s: Settings) -> dict | None:
    """Au démarrage, AVANT d'ouvrir la base : l'ancienne base est mise de côté (jamais effacée),
    la sauvegarde est restaurée et contrôlée ; en cas d'échec, l'ancienne base est remise."""
    m = _marker(s)
    if not m.exists():
        return None
    src = Path(json.loads(m.read_text())['source'])
    aside = s.data_dir.parent / ('data-avant-restauration-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
    if s.data_dir.exists():
        os.replace(s.data_dir, aside)
    try:
        r = restore(s, src)
    except SystemExit as e:
        shutil.rmtree(s.data_dir, ignore_errors=True)
        if aside.exists():
            os.replace(aside, s.data_dir)
        m.unlink()
        log.error('Restauration annulée, données précédentes remises en place : %s', e)
        return {'ok': False, 'error': str(e)}
    m.unlink()
    log.info('Restauration appliquée depuis %s (%s enregistrement(s)) ; ancienne base conservée dans %s', src.name, r['counts']['records'], aside.name)
    return {'ok': True, 'aside': aside.name, **r}
