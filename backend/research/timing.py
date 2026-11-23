"""Bounded operational timing; never record credentials, identities or payloads."""
import logging
import time
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import uuid4

metrics = ContextVar('research_request_metrics', default=None)
logger = logging.getLogger('uvicorn.error')


@contextmanager
def timed(phase):
    started = time.perf_counter()
    try:
        yield
    finally:
        value = metrics.get()
        if value is not None:
            value[phase] = value.get(phase, 0) + (time.perf_counter() - started) * 1000


class RequestTiming:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or not scope['path'].startswith('/api/v2'):
            return await self.app(scope, receive, send)
        values = {}
        token = metrics.set(values)
        started = time.perf_counter()
        request_id, status = uuid4().hex, 500

        async def observed(message):
            nonlocal status
            if message['type'] == 'http.response.start':
                status = message['status']
                values['headers'] = (time.perf_counter() - started) * 1000
                message = {**message, 'headers': [*message.get('headers', []),
                    (b'x-request-id', request_id.encode()), (b'x-skymeasure-sync', b'2'),
                    (b'server-timing', ', '.join(f'{key};dur={value:.2f}' for key, value in values.items()).encode())]}
            await send(message)

        try:
            await self.app(scope, receive, observed)
        finally:
            # The route template replaces object IDs. Rejected/unmatched paths are
            # deliberately not logged verbatim.
            route = getattr(scope.get('route'), 'path', '/api/v2/{unmatched}')
            logger.info('research_timing id=%s method=%s route=%s status=%d totalMs=%.2f phases=%s',
                        request_id, scope['method'], route, status,
                        (time.perf_counter() - started) * 1000,
                        {key: round(value, 2) for key, value in values.items()})
            metrics.reset(token)
