import os
import csv
import io
import json
from pathlib import Path
import pytest
from fastapi import Header, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from sqlalchemy import select
from backend.app import app
from backend.research.auth import identity
from backend.research.api import CONSENT_VERSION
from backend.research.database import Base, Account, engine, engine_for, ResearchSession, Record, Sample
from backend.research.exports import combined_rows


@pytest.fixture
def client(tmp_path, monkeypatch):
    external = os.environ.get('SKYMEASURE_TEST_DATABASE_URL')
    if external:
        assert external.split('?')[0].endswith('/skymeasure_test'), 'Only the disposable skymeasure_test database is allowed'
        monkeypatch.setenv('DATABASE_URL', external)
        Base.metadata.drop_all(engine())
    else:
        monkeypatch.setenv('DATABASE_URL', 'sqlite:///' + str(tmp_path / 'research.sqlite'))
    Base.metadata.create_all(engine())
    def user(authorization: str = Header(default='')):
        if authorization not in ('Bearer a', 'Bearer b', 'Bearer researcher', 'Bearer admin'):
            raise HTTPException(401, 'Invalid token')
        return authorization.split()[1]
    app.dependency_overrides[identity] = user
    with TestClient(app) as c:
        for who in ['a', 'b', 'researcher', 'admin']:
            c.patch('/api/v2/profile', headers=auth(who), json={'consentVersion': CONSENT_VERSION})
        with Session(engine()) as db:
            db.get(Account, 'researcher').role = 'researcher'
            db.get(Account, 'admin').role = 'administrator'
            db.commit()
        yield c
    app.dependency_overrides.clear()


def auth(who='a'):
    return {'Authorization': 'Bearer ' + who}


def experiment():
    sid, mid = 'a'*32, 'b'*32
    session = {'id': sid, 'state': 'completed', 'startedAt': '2026-10-12T12:00:00Z', 'config': {'httpEnabled': False}}
    measurement = {'id': mid, 'sessionId': sid, 'type': 'udp_echo', 'timestamp': '2026-10-12T12:00:01Z', 'success': True,
                   'details': {'samples': [{'sequence': 0, 'rttMs': 0, 'timestampNs': '9999999999999999999'}, {'sequence': 1, 'rttMs': None, 'errorType': 'timeout'}], 'baselineSamples': [{'sequence': 0, 'rttMs': 5}]}, 'futureField': {'x': 4}}
    records = [{'id': sid, 'type': 'session', 'version': 2, 'payload': session}, {'id': mid, 'type': 'measurement', 'version': 1, 'payload': measurement}]
    manifest = {'collectorVersion': 'library-test', 'schemaVersion': 3, 'session': session, 'expected': [{k: r[k] for k in ['id', 'type', 'version']} for r in records]}
    return sid, manifest, records


def register(c):
    sid, manifest, records = experiment()
    assert c.put(f'/api/v2/sessions/{sid}/manifest', json=manifest, headers=auth()).status_code == 200
    return sid, manifest, records


def test_ownership_roles_and_expired_tokens(client):
    sid, manifest, records = register(client)
    for path in ['/research/overview', '/research/sessions', '/research/participants', f'/research/sessions/{sid}', '/admin/members']:
        assert client.get('/api/v2' + path, headers=auth()).status_code == 403
        assert client.get('/api/v2' + path).status_code == 401
    assert client.put(f'/api/v2/sessions/{sid}/manifest', json=manifest, headers=auth('b')).status_code == 404
    for suffix, body in [('records', {'records': records}), ('complete', {})]:
        assert client.post(f'/api/v2/sessions/{sid}/{suffix}', json=body, headers=auth('b')).status_code == 404
    assert client.get('/api/v2/sessions', headers=auth('b')).json()['items'] == []
    assert client.patch('/api/v2/profile', json={'role': 'administrator'}, headers=auth()).status_code == 422


def test_partial_duplicate_and_reconciliation(client):
    sid, manifest, records = register(client)
    path = f'/api/v2/sessions/{sid}'
    assert client.post(path + '/complete', headers=auth()).json()['complete'] is False
    assert client.post(path + '/records', json={'records': records[:1]}, headers=auth()).status_code == 200
    partial = client.get('/api/v2/research/sessions', headers=auth('researcher')).json()['items'][0]
    assert partial['receivedRecords'] == 1 and partial['completedAt'] is None
    for _ in range(2):
        assert client.post(path + '/records', json={'records': records}, headers=auth()).status_code == 200
    assert client.post(path + '/complete', headers=auth()).json() == {'complete': True, 'missing': []}
    records[1]['payload']['futureField'] = {'x': 6}
    assert client.post(path + '/records', json={'records': records}, headers=auth()).status_code == 409
    detail = client.get('/api/v2/research/sessions/' + sid, headers=auth('researcher')).json()
    assert detail['measurements'][0]['futureField'] == {'x': 4}
    assert detail['receipt']['measurements'] == 1
    rows = list(csv.DictReader(io.StringIO(client.get('/api/v2/research/sessions/' + sid + '?format=csv', headers=auth('researcher')).text)))
    assert len(rows) == 3
    assert rows[0]['sample.rttMs'] == '0' and rows[1]['sample.rttMs'] == ''
    assert rows[0]['sample.timestampNs'] == '9999999999999999999'
    assert rows[2]['sample.phase'] == 'baseline'


def test_atomic_rejection_and_parent_validation(client):
    sid, manifest, records = register(client)
    records[1]['payload']['sessionId'] = 'c'*32
    assert client.post(f'/api/v2/sessions/{sid}/records', json={'records': records}, headers=auth()).status_code == 422
    with Session(engine()) as db:
        assert list(db.scalars(select(Record))) == []
    manifest['expected'].append(manifest['expected'][0])
    assert client.put(f'/api/v2/sessions/{sid}/manifest', json=manifest, headers=auth()).status_code == 422


def test_deletion_blocks_replay_and_keeps_other_account(client):
    sid, manifest, records = register(client)
    client.post(f'/api/v2/sessions/{sid}/records', json={'records': records}, headers=auth())
    assert client.delete('/api/v2/account', headers=auth()).status_code == 200
    assert client.put(f'/api/v2/sessions/{sid}/manifest', json=manifest, headers=auth()).status_code == 403
    assert client.get('/api/v2/profile', headers=auth('b')).status_code == 200
    with Session(engine()) as db:
        assert list(db.scalars(select(Record))) == []
        assert list(db.scalars(select(Sample))) == []
        assert list(db.scalars(select(ResearchSession))) == []


def test_admin_only_grants_access(client):
    pid = client.get('/api/v2/profile', headers=auth('a')).json()['participantId']
    url = '/api/v2/admin/members/' + pid
    assert client.put(url, json={'role': 'researcher'}, headers=auth('researcher')).status_code == 403
    assert client.put(url, json={'role': 'researcher'}, headers=auth('admin')).status_code == 200
    assert client.get('/api/v2/research/overview', headers=auth()).status_code == 200
    assert client.put(url, json={'role': 'participant'}, headers=auth('admin')).status_code == 200
    assert client.get('/api/v2/research/overview', headers=auth()).status_code == 403


def test_legacy_requires_explicit_development(client, monkeypatch):
    monkeypatch.delenv('CAPSTONE_LOCAL_DEV')
    assert client.post('/api/v1/ingest', json={}, headers=auth()).status_code == 404


def test_complete_export_agrees_with_saved_experiment():
    path = Path('backend/data/experiments/2026-10-12-library-ten-minute/source-session.json')
    if not path.exists():
        pytest.skip('Original private dataset stays local')
    data = json.loads(path.read_text())
    rows = list(combined_rows(data))
    assert len(data['measurements']) == 41
    assert len(rows) == 246
    assert sum(r['row.kind'] == 'sample' for r in rows) == 232
    assert sum(r['row.kind'] == 'measurement' for r in rows) == 14
    for protocol, replies, count in [('icmp_burst', 98, 100), ('udp_echo', 40, 40)]:
        probes = [r for r in rows if r['measurement.type'] == protocol]
        assert len(probes) == count
        assert sum(r.get('sample.rttMs') is not None for r in probes) == replies


def test_postgres_browser_roles_cannot_read_research_rows(client, monkeypatch):
    if engine().dialect.name != 'postgresql':
        pytest.skip('Run with SKYMEASURE_TEST_DATABASE_URL for PostgreSQL policy validation')
    import sys
    from sqlalchemy import text
    from backend.research.manage import main
    with engine().begin() as connection:
        connection.execute(text("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$"))
    monkeypatch.setattr(sys, 'argv', ['manage', 'migrate'])
    main()
    with engine().connect() as connection:
        for role in ['anon', 'authenticated']:
            transaction = connection.begin()
            connection.execute(text(f'GRANT SELECT ON sky_accounts TO {role}'))
            connection.execute(text(f'SET LOCAL ROLE {role}'))
            # Even an accidental SELECT grant cannot bypass the deny-by-default RLS.
            assert connection.execute(text('SELECT user_id FROM sky_accounts')).all() == []
            transaction.rollback()


def test_saved_experiment_round_trip_through_ingestion_and_exports(client):
    path = Path('backend/data/experiments/2026-10-12-library-ten-minute/source-session.json')
    if not path.exists():
        pytest.skip('Original private dataset stays local')
    data = json.loads(path.read_text())
    session = data['session']
    sid = session['id']
    records = [{'id': sid, 'type': 'session', 'version': 1, 'payload': session}]
    for key, kind in [('measurements', 'measurement'), ('events', 'event'), ('snapshots', 'snapshot')]:
        for payload in data[key]:
            records.append({'id': payload['id'], 'type': kind, 'version': 1, 'payload': {**payload, 'sessionId': sid}})
    manifest = {'collectorVersion': 'saved-ten-minute-libraries', 'schemaVersion': data['schemaVersion'], 'session': session, 'expected': [{k: r[k] for k in ['id', 'type', 'version']} for r in records]}
    assert client.put(f'/api/v2/sessions/{sid}/manifest', json=manifest, headers=auth()).status_code == 200
    for start in range(0, len(records), 25):
        assert client.post(f'/api/v2/sessions/{sid}/records', json={'records': records[start:start+25]}, headers=auth()).status_code == 200
    assert client.post(f'/api/v2/sessions/{sid}/complete', headers=auth()).json()['complete']
    overview = client.get('/api/v2/research/overview', headers=auth('researcher')).json()
    assert overview['measurements'] == 41 and overview['sessions'] == 1
    result = client.get(f'/api/v2/research/sessions/{sid}', headers=auth('researcher')).json()
    assert result['measurements'] == sorted(data['measurements'], key=lambda m: (m['timestamp'], m['id']))
    rows = list(csv.DictReader(io.StringIO(client.get(f'/api/v2/research/sessions/{sid}?format=csv', headers=auth('researcher')).text)))
    assert len(rows) == 246
    assert sum(r['row.kind'] == 'sample' for r in rows) == 232
    for protocol, replies, count in [('icmp_burst', 98, 100), ('udp_echo', 40, 40)]:
        probes = [r for r in rows if r['measurement.type'] == protocol]
        assert len(probes) == count
        assert sum(r.get('sample.rttMs', '') != '' for r in probes) == replies


def test_real_auth_dependency_uses_verified_identity_and_ignores_metadata_role(client, monkeypatch):
    import httpx
    from backend.research import auth as auth_module
    app.dependency_overrides.pop(identity)
    monkeypatch.setenv('SUPABASE_URL', 'https://staging.example.invalid')
    monkeypatch.setenv('SUPABASE_PUBLISHABLE_KEY', 'public-test-key')
    seen = []
    def verified(url, **kwargs):
        seen.append((url, kwargs))
        return httpx.Response(200, json={'id': 'a', 'user_metadata': {'role': 'administrator'}})
    monkeypatch.setattr(auth_module.httpx, 'get', verified)
    response = client.get('/api/v2/profile', headers=auth('untrusted-token'))
    assert response.status_code == 200 and response.json()['role'] == 'participant'
    assert seen[0][0] == 'https://staging.example.invalid/auth/v1/user'
    assert seen[0][1]['headers']['Authorization'] == 'Bearer untrusted-token'
    assert client.get('/api/v2/profile').status_code == 401
    monkeypatch.setattr(auth_module.httpx, 'get', lambda *a, **k: httpx.Response(401))
    assert client.get('/api/v2/research/overview', headers=auth('admin')).status_code == 401


def test_malformed_known_evidence_is_rejected_without_acknowledgement(client):
    sid, _, records = register(client)
    records[1]['payload']['details']['samples'] = 'not a sample list'
    assert client.post(f'/api/v2/sessions/{sid}/records', json={'records': records}, headers=auth()).status_code == 422
    with Session(engine()) as db:
        assert list(db.scalars(select(Record))) == []
