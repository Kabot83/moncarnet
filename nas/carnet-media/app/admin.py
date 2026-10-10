"""Administration (à lancer dans le conteneur) :

  python -m app.admin token create "Téléphone d'Alexandre"   → affiche le jeton UNE seule fois
  python -m app.admin token list | token revoke tk_xxxx
  python -m app.admin cert create --ip 192.168.1.20 --name nas.local   → certificat HTTPS du réseau local
"""
from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import sys

from .config import Settings
from .store import Store


def cert_create(data_dir, ips: list[str], names: list[str]) -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0] if names else 'carnet-media')])
    san = [x509.DNSName(n) for n in names] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    tls = data_dir / 'tls'
    tls.mkdir(exist_ok=True)
    (tls / 'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (tls / 'key.pem').chmod(0o600)
    (tls / 'cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    pin = cert.fingerprint(hashes.SHA256()).hex(':').upper()
    print(f'Certificat créé ({tls / "cert.pem"}). Empreinte SHA-256 à épingler dans Mon Carnet :\n{pin}')


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog='carnet-media-admin')
    sub = p.add_subparsers(dest='cmd', required=True)
    t = sub.add_parser('token').add_subparsers(dest='action', required=True)
    t.add_parser('create').add_argument('name')
    t.add_parser('list')
    t.add_parser('revoke').add_argument('id')
    c = sub.add_parser('cert').add_subparsers(dest='action', required=True)
    cc = c.add_parser('create')
    cc.add_argument('--ip', action='append', default=[])
    cc.add_argument('--name', action='append', default=[])
    args = p.parse_args(argv)

    s = Settings.from_env()
    store = Store(s.data_dir)
    if args.cmd == 'token':
        if args.action == 'create':
            tid, token = store.create_token(args.name)
            print(f'Appareil {tid} « {args.name} »\nJeton (affiché une seule fois, à saisir dans Mon Carnet) :\n{token}')
        elif args.action == 'list':
            for r_ in store.q('SELECT id, name, created_at, revoked_at FROM tokens ORDER BY created_at'):
                print(r_['id'], r_['name'], 'révoqué' if r_['revoked_at'] else 'actif')
        else:
            store.revoke_token(args.id)
            print('Jeton révoqué.')
    elif args.cmd == 'cert':
        if not args.ip and not args.name:
            sys.exit('Indiquez au moins --ip ou --name.')
        cert_create(s.data_dir, args.ip, args.name)


if __name__ == '__main__':
    main()
