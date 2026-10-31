#!/bin/sh
# Isolated ACME state. Do not edit the lab's existing Certbot configuration.
set -eu
if test ! -f /etc/skymeasure/acme/renewal/api.hailemariam.com.conf; then
    # Bootstrap only after the domain points exclusively to this host.
    if ! /opt/skymeasure/venv/bin/python - <<'PY'
import socket
addresses = {entry[4][0] for entry in socket.getaddrinfo('api.hailemariam.com', 443, type=socket.SOCK_STREAM)}
raise SystemExit(0 if addresses == {'23.235.205.53'} else 1)
PY
    then
        echo 'SkyMeasure DNS cutover is pending; retaining the existing certificate.'
        exit 0
    fi
    exec /opt/certbot-venv/bin/certbot certonly --non-interactive --agree-tos \
        --register-unsafely-without-email --webroot \
        --webroot-path /var/lib/skymeasure/acme-webroot \
        --cert-name api.hailemariam.com -d api.hailemariam.com \
        --config-dir /etc/skymeasure/acme --work-dir /var/lib/skymeasure/acme-work \
        --logs-dir /var/log/skymeasure-acme \
        --deploy-hook /opt/skymeasure/current/deploy/lab/install-certificate.sh
fi
exec /opt/certbot-venv/bin/certbot renew --quiet \
    --config-dir /etc/skymeasure/acme --work-dir /var/lib/skymeasure/acme-work \
    --logs-dir /var/log/skymeasure-acme \
    --deploy-hook /opt/skymeasure/current/deploy/lab/install-certificate.sh
