import csv
import io
import json
from types import SimpleNamespace
from fastapi import Request
from sqlalchemy import event, select
from sqlalchemy.orm import Session
from backend.tests.test_research import client, auth, trip_body, experiment
from backend.research.database import engine, Record, ViewCache
from backend.research.auth import account

TRIP='c'*32
START=1793534400000

def setup_trip(client, extra=None, omit_measurement=False):
    body={**trip_body(),'startedAt':START,'groundTest':True,'provider':'TEST Etisalat'}
    assert client.put('/api/v2/trips/'+TRIP,headers=auth(),json=body).status_code==200
    sid,manifest,records=experiment()
    manifest['session'].update(startedAt='2026-11-01T12:00:00Z',endedAt='2026-11-01T12:05:00Z')
    manifest['session']['config'].update(tripId=TRIP,segmentIndex=0)
    records[1]['payload'].update(timestamp='2026-11-01T12:00:01Z',networkSnapshot={'asn':5384},targetHost='probe.invalid')
    if extra:
        for i,raw in enumerate(extra):
            rid=f'{9000+i:032x}'
            records.append({'type':'event','id':rid,'version':1,'payload':{'id':rid,'sessionId':sid,**raw}})
    manifest['expected']=[{k:r[k] for k in ('id','type','version')} for r in records]
    assert client.put(f'/api/v2/sessions/{sid}/manifest',headers=auth(),json=manifest).status_code==200
    sent=[r for r in records if not(omit_measurement and r['type']=='measurement')]
    assert client.post(f'/api/v2/sessions/{sid}/records',headers=auth(),json={'records':sent}).status_code==200
    return sid,records,body


def test_compact_list_never_queries_samples_and_has_no_confidence(client):
    setup_trip(client)
    statements=[]
    def capture(conn,cursor,statement,params,context,many):statements.append(statement.lower())
    event.listen(engine(),'before_cursor_execute',capture)
    try:
        response=client.get('/api/v2/research/trips?view=compact&limit=20',headers=auth('researcher'))
    finally:event.remove(engine(),'before_cursor_execute',capture)
    assert response.status_code==200
    row=response.json()['items'][0]
    assert row['groundTest'] and row['receivedRecords']==2 and row['measurements']==1
    assert 'summary' not in row and 'confidence' not in row and 'segments' not in row
    assert not any('sky_samples' in q for q in statements)
    assert client.get('/api/v2/research/trips?view=compact',headers=auth()).status_code==403


def test_cache_invalidation_preserves_zero_and_ignores_baselines(client):
    sid,records,body=setup_trip(client,omit_measurement=True)
    path=f'/api/v2/research/trips/{TRIP}/detail'
    first=client.get(path,headers=auth('researcher')).json()
    assert first['summary']['measurements']==0
    assert client.post(f'/api/v2/sessions/{sid}/records',headers=auth(),json={'records':[records[1]]}).status_code==200
    second=client.get(path,headers=auth('researcher')).json()
    assert second['dataRevision']>first['dataRevision']
    p=second['summary']['protocols'][0]
    assert p['medianMs']==0 and p['sampleCount']==2 and p['replies']==1
    client.post(f'/api/v2/sessions/{sid}/complete',headers=auth())
    client.put('/api/v2/trips/'+TRIP,headers=auth(),json={**body,'revision':2,'state':'completed','phase':'finished','endedAt':START+300000})
    final=client.get(path,headers=auth('researcher')).json()
    assert final['uploadComplete'] and final['completeSegments']==1
    assert 'confidence' not in final


def test_whole_trip_events_do_not_invent_collection_during_gaps(client):
    def detect(t):return {'kind':'flight_detection','timestamp':f'2026-11-01T12:00:{t:02d}Z','details':{'at':START+t*1000,'phase':'collecting','provider':'TEST Etisalat','asn':{'state':'positive'}}}
    setup_trip(client,[detect(0),detect(30),{'kind':'collector_gap','timestamp':'2026-11-01T12:03:00Z','details':{'startedAt':'2026-11-01T12:00:30Z','endedAt':'2026-11-01T12:03:00Z','durationMs':150000}}])
    row=client.get(f'/api/v2/research/trips/{TRIP}/detail',headers=auth('researcher')).json()
    assert row['health']['observedCollectionMs']==30000 and row['health']['gapCount']==1
    assert any(e['kind']=='segment' for e in row['events'])
    timeline=client.get(f'/api/v2/research/trips/{TRIP}/timeline',headers=auth('researcher')).json()
    assert timeline['series'][0]['points'][0]['success'] is True
    assert timeline['clock']=='recorded_wall_clock_utc'


def test_evidence_and_exports_keep_failures_baselines_and_large_timestamps(client):
    setup_trip(client)
    url=f'/api/v2/research/trips/{TRIP}'
    samples=client.get(url+'/evidence?layer=samples&limit=1',headers=auth('researcher')).json()
    assert samples['total']==3 and len(samples['items'])==1
    assert client.get(url+'/evidence?layer=samples&outcome=timeout',headers=auth('researcher')).json()['total']==1
    original=client.get(url+'/export?format=json',headers=auth('researcher')).json()
    assert original['segments'][0]['measurements'][0]['details']['samples'][0]['timestampNs']=='9999999999999999999'
    rows=list(csv.DictReader(io.StringIO(client.get(url+'/export?format=csv',headers=auth('researcher')).text)))
    assert len(rows)==3 and rows[0]['sample.rttMs']=='0' and rows[1]['sample.rttMs']==''
    assert rows[2]['sample.phase']=='baseline' and all(r['trip.id']==TRIP for r in rows)
    assert 'netId' not in json.dumps(original)
    assert client.get(url+'/export',headers=auth()).status_code==403


def test_provider_comparisons_pool_probes_without_mixing_test_classifications(client):
    setup_trip(client)
    response=client.get('/api/v2/research/provider-results',headers=auth('researcher'))
    assert response.status_code==200,response.text
    row=response.json()['items'][0]
    assert row['provider']=='TEST Etisalat' and row['groundTest']
    assert row['probes']==2 and row['replies']==1 and row['medianRttMs']==0
    assert client.get('/api/v2/research/provider-results?kind=study',headers=auth('researcher')).json()['items']==[]
    overview=client.get('/api/v2/research/trip-overview',headers=auth('researcher')).json()
    assert overview['trips']==1 and overview['groundTests']==1 and overview['studyTrips']==0


def test_auth_reads_do_not_lock_accounts_but_mutations_do():
    captured=[]
    class DB:
        def scalar(self,statement):
            captured.append(statement)
            return SimpleNamespace(deleted=False)
    for method in ('GET','POST'):
        account(Request({'type':'http','method':method}), 'a', DB())
    assert captured[0]._for_update_arg is None
    assert captured[1]._for_update_arg is not None
