#!/bin/sh
# Certbot deploy hook: copy only SkyMeasure's renewed certificate.
set -eu
test "${RENEWED_LINEAGE:-}" = /etc/skymeasure/acme/live/api.hailemariam.com
openssl x509 -in "$RENEWED_LINEAGE/fullchain.pem" -noout -checkhost api.hailemariam.com >/dev/null
openssl x509 -in "$RENEWED_LINEAGE/fullchain.pem" -noout -checkend 86400 >/dev/null
cert_public=$(openssl x509 -in "$RENEWED_LINEAGE/fullchain.pem" -pubkey -noout)
key_public=$(openssl pkey -in "$RENEWED_LINEAGE/privkey.pem" -pubout)
test "$cert_public" = "$key_public"
# Keep the previous pair so a rejected reload cannot leave an unusable config.
backup_dir=$(mktemp -d /etc/skymeasure/tls/renewal-backup.XXXXXX)
cp -p /etc/skymeasure/tls/fullchain.pem "$backup_dir/fullchain.pem"
cp -p /etc/skymeasure/tls/privkey.pem "$backup_dir/privkey.pem"
install -m 0644 "$RENEWED_LINEAGE/fullchain.pem" /etc/skymeasure/tls/fullchain.pem
install -m 0600 "$RENEWED_LINEAGE/privkey.pem" /etc/skymeasure/tls/privkey.pem
if ! apache2ctl configtest || ! systemctl reload apache2; then
    cp -p "$backup_dir/fullchain.pem" /etc/skymeasure/tls/fullchain.pem
    cp -p "$backup_dir/privkey.pem" /etc/skymeasure/tls/privkey.pem
    echo 'SkyMeasure certificate reload failed; previous files restored.' >&2
    exit 1
fi
# Retain backups for recovery; this hook does not delete any files.
