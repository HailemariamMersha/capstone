"""Bound public request memory and per-process traffic; edge limits add a second layer."""
import time
from collections import OrderedDict
from starlette.responses import JSONResponse


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
        body = bytearray()
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            body.extend(message.get('body', b''))
            if len(body) > 8 * 1024 * 1024:
                return await JSONResponse({'detail': 'Batch exceeds 8 MiB'}, 413)(scope, receive, send)
            if not message.get('more_body'):
                break
        sent = False
        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
            return await receive()
        await self.app(scope, replay, send)
