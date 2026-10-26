"""Small, explicitly lossy dashboard views; stored records and exports stay intact."""
import gzip
import json
from fastapi.responses import Response


def readable(value):
    if isinstance(value, list):
        return [readable(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        if key in ('rawResult', 'libraryResult') or key.endswith(('Hex', 'Base64')):
            continue
        if key == 'raw' and isinstance(item, dict):
            result[key] = {k: item[k] for k in ('library', 'version', 'source', 'unavailable') if k in item}
        else:
            result[key] = readable(item)
    return result


def evidence_response(data, accept_encoding=''):
    # Data was already validated at ingestion and read as JSON. Avoid FastAPI's
    # second recursive jsonable_encoder traversal over every nested callback.
    body = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()
    headers = {'Cache-Control': 'private, no-store', 'Vary': 'Accept-Encoding'}
    gzip_allowed = False
    for encoding in accept_encoding.lower().split(','):
        parts = [part.strip() for part in encoding.split(';')]
        if parts[0] == 'gzip':
            try:
                gzip_allowed = all(float(part[2:]) > 0 for part in parts[1:] if part.startswith('q='))
            except ValueError:
                gzip_allowed = False
    if gzip_allowed and len(body) >= 1024:
        body = gzip.compress(body, compresslevel=1)
        headers['Content-Encoding'] = 'gzip'
    return Response(body, media_type='application/json', headers=headers)
