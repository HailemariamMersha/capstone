"""Bounded enrichment of the transport-observed client address only."""
import asyncio
import ipaddress
import os
import socket
import time
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict

_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='sky-ptr')
_cache = OrderedDict()
_pending = set()

def lookup_asn(ip):
    path = os.environ.get('CAPSTONE_ASN_DB')
    if not path:
        return {'asn': None, 'asnOrganization': None, 'asnDatabaseBuild': None, 'asnUnavailable': 'database_not_configured'}
    try:
        import geoip2.database
        with geoip2.database.Reader(path) as reader:
            build = reader.metadata().build_epoch
            if time.time() - build > 35 * 86400:
                return {'asn': None, 'asnDatabaseBuild': build, 'asnUnavailable': 'database_stale'}
            record = reader.asn(ip)
            return {'asn': record.autonomous_system_number, 'asnOrganization': record.autonomous_system_organization,
                    'asnDatabaseBuild': build, 'asnUnavailable': None}
    except Exception:
        return {'asn': None, 'asnUnavailable': 'lookup_unavailable'}

async def enrich(address):
    try:
        address = str(ipaddress.ip_address(address))
        if not ipaddress.ip_address(address).is_global: address = None
    except (ValueError, TypeError): address = None
    result = {'publicIp': address, 'asn': None, 'reverseDns': None, 'popCode': None,
              'observedAt': time.time(), 'lookupSource': 'transport_peer_and_local_geolite_asn'}
    if not address:
        return {**result, 'asnUnavailable': 'public_address_unavailable'}
    result.update(await asyncio.to_thread(lookup_asn, address))
    if result.get('asn') != 14593: return result
    cached = _cache.get(address)
    if cached and cached[0] > time.monotonic():
        host = cached[1]
    else:
        # Timed-out system resolver calls can keep their threads: never enqueue
        # unbounded requests behind them.
        if len(_pending) >= 2: return {**result, 'ptrUnavailable': 'resolver_busy'}
        future = _pool.submit(socket.gethostbyaddr, address)
        _pending.add(future)
        future.add_done_callback(lambda f: _pending.discard(f))
        try:
            host = (await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(future)), 2))[0].lower().rstrip('.')
        except Exception:
            return {**result, 'ptrUnavailable': 'lookup_timeout_or_unavailable'}
        _cache[address] = (time.monotonic() + 300, host)
        while len(_cache) > 512: _cache.popitem(last=False)
    result['reverseDns'] = host[:253]
    import re
    match = re.fullmatch(r'customer\.([a-z0-9-]{1,63})\.pop\.starlinkisp\.net', host)
    result['popCode'] = match.group(1) if match else None
    return result
