import asyncio
from backend.network_context import enrich

def test_forwarded_input_is_never_used_as_lookup_target(monkeypatch):
    monkeypatch.delenv('CAPSTONE_ASN_DB', raising=False)
    result = asyncio.run(enrich('127.0.0.1'))
    assert result['publicIp'] is None
    result = asyncio.run(enrich('8.8.8.8'))
    assert result['publicIp'] == '8.8.8.8'
    assert result['asn'] is None and result['asnUnavailable'] == 'database_not_configured'
    assert result['popCode'] is None
