"""Bound public request memory and per-process traffic; edge limits add a second layer."""
import time
import zlib
from collections import OrderedDict
from starlette.responses import JSONResponse
from .timing import timed

MAX_BODY = 8 * 1024 * 1024


class RequestLimits:
    def __init__(self, app):
        self.app = app
        self.clients = OrderedDict()

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        ip = (scope.get('client') or ('unknown',))[0]
        minute = int(time.monotonic() // 60)
        previous, count = self.clients.pop(ip, (minute, 0))
        count = count + 1 if previous == minute else 1
        self.clients[ip] = (minute, count)
        if len(self.clients) > 10000:
            self.clients.popitem(last=False)
        if count > 300:
            return await JSONResponse({'detail': 'Request limit reached; retry later'}, 429, headers={'Retry-After': '60'})(scope, receive, send)
        if not scope['path'].startswith('/api/v2'):
            return await self.app(scope, receive, send)
        headers = dict(scope.get('headers', []))
        standard = headers.get(b'content-encoding')
        mobile = headers.get(b'x-skymeasure-content-encoding')
        if standard is not None and mobile is not None and standard.strip().lower() != mobile.strip().lower():
            return await JSONResponse({'detail': 'Conflicting content encodings'}, 400)(scope, receive, send)
        # React Native Android removes Content-Encoding for ArrayBuffer bodies.
        # The negotiated v2 alias retains exact precompressed bytes/accounting;
        # both paths use the same strict encoded/decoded limits below.
        encoding = (standard or mobile or b'identity').strip().lower()
        if encoding not in (b'identity', b'gzip'):
            return await JSONResponse({'detail': 'Unsupported content encoding'}, 415)(scope, receive, send)
        body, encoded_bytes = bytearray(), 0
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if encoding == b'gzip' else None
        with timed('body'):
            try:
                while True:
                    message = await receive()
                    if message['type'] == 'http.disconnect':
                        return
                    chunk = message.get('body', b'')
                    encoded_bytes += len(chunk)
                    if encoded_bytes > MAX_BODY:
                        return await JSONResponse({'detail': 'Encoded batch exceeds 8 MiB'}, 413)(scope, receive, send)
                    if decoder:
                        body.extend(decoder.decompress(chunk, MAX_BODY + 1 - len(body)))
                        if decoder.unconsumed_tail or len(body) > MAX_BODY:
                            return await JSONResponse({'detail': 'Decoded batch exceeds 8 MiB'}, 413)(scope, receive, send)
                    else:
                        body.extend(chunk)
                    if not message.get('more_body'):
                        break
                if decoder and (not decoder.eof or decoder.unused_data):
                    raise ValueError('Incomplete or trailing gzip data')
            except (zlib.error, ValueError):
                return await JSONResponse({'detail': 'Invalid gzip body'}, 400)(scope, receive, send)
        if decoder:
            scope = {**scope, 'headers': [(k, v) for k, v in scope.get('headers', [])
                if k.lower() not in (b'content-encoding', b'x-skymeasure-content-encoding', b'content-length')] + [(b'content-length', str(len(body)).encode())]}
        sent = False
        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
            return await receive()
        await self.app(scope, replay, send)
