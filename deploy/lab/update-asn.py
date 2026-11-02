#!/usr/bin/env python3
"""Scoped GeoLite ASN updater. Account/license arrive through protected systemd env."""
import base64
import io
import os
from pathlib import Path
import tarfile
import tempfile
import urllib.request
from urllib.parse import urlparse
import geoip2.database

class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        result = super().redirect_request(request, fp, code, msg, headers, newurl)
        if urlparse(newurl).scheme != 'https': raise RuntimeError('Non-HTTPS redirect refused')
        if urlparse(newurl).hostname != urlparse(request.full_url).hostname:
            result.remove_header('Authorization')
        return result

def main():
    auth = base64.b64encode((os.environ['MAXMIND_ACCOUNT_ID'] + ':' + os.environ['MAXMIND_LICENSE_KEY']).encode()).decode()
    request = urllib.request.Request('https://download.maxmind.com/geoip/databases/GeoLite2-ASN/download?suffix=tar.gz', headers={'Authorization': 'Basic '+auth})
    with urllib.request.build_opener(Redirect()).open(request, timeout=30) as response:
        package = response.read(32*1048576 + 1)
    if len(package) > 32*1048576: raise RuntimeError('Download exceeds bound')
    destination = Path('/var/lib/skymeasure/geoip/GeoLite2-ASN.mmdb')
    destination.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(package), mode='r:gz') as archive:
        matches = [m for m in archive.getmembers() if m.isfile() and Path(m.name).name == 'GeoLite2-ASN.mmdb']
        if len(matches) != 1 or matches[0].size > 64*1048576: raise RuntimeError('Invalid ASN archive')
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temp:
            path = Path(temp.name)
            try:
                temp.write(archive.extractfile(matches[0]).read()); temp.flush(); os.fsync(temp.fileno())
                with geoip2.database.Reader(str(path)) as reader:
                    if reader.metadata().database_type != 'GeoLite2-ASN': raise RuntimeError('Incorrect database')
                os.chmod(path, 0o640)
                os.replace(path, destination)
            finally:
                path.unlink(missing_ok=True)
    print('SkyMeasure ASN database updated.')

if __name__ == '__main__':
    try: main()
    except Exception: raise SystemExit('SkyMeasure ASN update failed; previous database retained. Check protected configuration and connectivity.')
