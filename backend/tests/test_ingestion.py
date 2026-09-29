import sqlite3
from fastapi.testclient import TestClient
from backend.app import app
from backend.ingestion import MAX_BATCH_BYTES


def batch():
    return {'installationId': 'a'*32, 'records': [{'id':'b'*32,'type':'session','version':1,'payload':{'id':'b'*32,'state':'completed'}}]}


def test_durable_idempotent_ingestion(tmp_path, monkeypatch):
    path = tmp_path / 'records.sqlite'
    monkeypatch.setenv('CAPSTONE_INGEST_DB', str(path))
    monkeypatch.delenv('CAPSTONE_SYNC_TOKEN', raising=False)
    with TestClient(app) as client:
        for _ in range(2):
            response = client.post('/api/v1/ingest', json=batch())
            assert response.status_code == 200
            assert response.json()['acknowledged'][0]['id'] == 'b'*32
        conflict = batch()
        conflict['records'][0]['payload']['extra'] = 1
        assert client.post('/api/v1/ingest', json=conflict).status_code == 409
    with sqlite3.connect(path) as connection:
        assert connection.execute('SELECT COUNT(*) FROM records').fetchone()[0] == 1


def test_validation_and_auth(tmp_path, monkeypatch):
    monkeypatch.setenv('CAPSTONE_INGEST_DB', str(tmp_path / 'records.sqlite'))
    monkeypatch.setenv('CAPSTONE_SYNC_TOKEN','test-secret')
    with TestClient(app) as client:
        assert client.post('/api/v1/ingest',json=batch()).status_code == 401
        headers = {'Authorization':'Bearer test-secret'}
        invalid = batch()
        invalid['records'][0]['payload']['state'] = 'active'
        assert client.post('/api/v1/ingest',json=invalid,headers=headers).status_code == 422
        assert client.post('/api/v1/ingest',content=b'x'*(MAX_BATCH_BYTES+1),headers=headers).status_code == 413
        assert client.post('/api/v1/ingest',json=batch(),headers=headers).status_code == 200


def test_local_context_does_not_claim_public_ip_or_asn():
    with TestClient(app) as client:
        response = client.get('/api/v1/context')
        assert response.status_code == 200
        assert response.json() == {'publicIp':None,'asn':None}


def test_large_packet_record_is_preserved(tmp_path, monkeypatch):
    import json
    path = tmp_path / 'records.sqlite'
    monkeypatch.setenv('CAPSTONE_INGEST_DB', str(path))
    monkeypatch.delenv('CAPSTONE_SYNC_TOKEN', raising=False)
    data = batch()
    record = data['records'][0]
    record['type'] = 'measurement'
    record['payload'] = {'id': record['id'], 'packet': {'receivedHex': 'ab' * 600000}}
    with TestClient(app) as client:
        assert client.post('/api/v1/ingest', json=data).status_code == 200
    with sqlite3.connect(path) as connection:
        saved = json.loads(connection.execute('SELECT payload_json FROM records').fetchone()[0])
        assert saved == record['payload']
