import gzip
import json
from pathlib import Path
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.tests.test_research import client,auth
from backend.tests.test_trip_workspace import setup_trip,TRIP,START
from backend.research.database import engine,HistoryReset,Account,ResearchTrip
from backend.research.cleanup import backup,verify,apply,restore,inventory,identity_digest


def reset(db):
    value=HistoryReset(id='f'*32,cutoff_ms=START+10000000,archive_sha256='0'*64,maintenance=True,applied=False)
    db.add(value);db.commit();return value


def test_archive_restore_purge_and_replay_preserve_identities(client,tmp_path):
    sid,records,body=setup_trip(client)
    with Session(engine()) as db:
        r=reset(db);before=inventory(db);path=tmp_path/'private'/'history.jsonl.gz'
        manifest=backup(db,r,path)
        assert verify(path)['tables']==before['tables']
        result=apply(db,r,path)
        assert result['applied'] and not any(result['tables'].values())
        assert identity_digest(db)==before['identityDigest']
        assert apply(db,r,path)['alreadyApplied']
    # Existing credentials still work; none of these recordings can reappear.
    assert client.get('/api/v2/profile',headers=auth()).status_code==200
    denied=client.put('/api/v2/trips/'+TRIP,headers=auth(),json=body)
    assert denied.status_code==410 and denied.json()['detail']['code']=='DATA_REMOVED'
    assert client.post(f'/api/v2/sessions/{sid}/records',headers=auth(),json={'records':records}).status_code==410
    assert client.get('/api/v2/research/trips?view=compact',headers=auth('researcher')).json()['total']==0
    with Session(engine()) as db:
        r=db.get(HistoryReset,'f'*32)
        result=restore(db,r,path)
        assert result['tables']==before['tables'] and identity_digest(db)==before['identityDigest']
    assert client.get('/api/v2/research/trips?view=compact',headers=auth('researcher')).json()['total']==1


def test_failed_verification_never_deletes_and_resume_does_not_apply_cutoff(client,tmp_path):
    setup_trip(client)
    with Session(engine()) as db:
        r=reset(db);path=tmp_path/'history.jsonl.gz';backup(db,r,path)
        original=path.read_bytes();path.write_bytes(original[:-20])
        with pytest.raises(ValueError,match='checksum'):apply(db,r,path)
        assert db.get(ResearchTrip,TRIP) is not None
        r.maintenance=False;db.commit()
    assert client.put('/api/v2/trips/'+TRIP,headers=auth(),json={**__import__('backend.tests.test_research',fromlist=['trip_body']).trip_body(),'startedAt':START,'groundTest':True,'provider':'TEST Etisalat'}).status_code==200


def test_maintenance_blocks_only_evidence_writes_and_unknown_old_ids_are_retired(client,tmp_path):
    sid,records,body=setup_trip(client)
    with Session(engine()) as db:
        r=reset(db)
    assert client.get('/api/v2/profile',headers=auth()).status_code==200
    response=client.put('/api/v2/trips/'+TRIP,headers=auth(),json=body)
    assert response.status_code==503 and response.headers['retry-after']=='60'
    with Session(engine()) as db:
        r=db.get(HistoryReset,'f'*32);path=tmp_path/'history.jsonl.gz';backup(db,r,path);apply(db,r,path)
    assert client.put('/api/v2/trips/'+'e'*32,headers=auth(),json=body).status_code==410
    new={**body,'startedAt':START+10000001}
    assert client.put('/api/v2/trips/'+'e'*32,headers=auth(),json=new).status_code==200
    assert client.get('/api/v2/research/trips?view=compact',headers=auth('researcher')).json()['total']==1


def test_payment_mapping_is_separate_from_measurement_archive(client,tmp_path):
    from backend.research.database import TripPayment
    from backend.research.cleanup import payment_path
    setup_trip(client)
    with Session(engine()) as db:
        db.add(TripPayment(trip_id=TRIP,owner_id='a',netid='abc123'));db.commit()
        r=reset(db);path=tmp_path/'history.jsonl.gz';backup(db,r,path);verify(path)
        with gzip.open(path,'rt') as f:assert 'abc123' not in f.read()
        with gzip.open(payment_path(path),'rt') as f:assert 'abc123' in f.read()


def test_existing_payment_archive_cannot_be_overwritten_or_removed(client,tmp_path):
    from backend.research.cleanup import payment_path
    setup_trip(client)
    path=tmp_path/'history.jsonl.gz'
    existing=payment_path(path)
    existing.write_bytes(b'previous protected archive')
    with Session(engine()) as db:
        r=reset(db)
        with pytest.raises(ValueError,match='already exists'):backup(db,r,path)
    assert existing.read_bytes()==b'previous protected archive'
    assert not path.exists()
