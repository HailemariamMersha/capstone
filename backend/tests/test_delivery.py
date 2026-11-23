"""Transport/receipt/outcome regressions use isolated SQLite, never study data."""
import gzip
import json
import logging
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from backend.tests.test_research import client, auth, experiment, trip_body
from backend.research.limits import RequestLimits, MAX_BODY
from backend.research.timing import RequestTiming
from backend.research.policies import PILOT_POLICY, PREVIOUS_PILOT_POLICY


def test_gzip_batch_capability_and_200_record_reconciliation(client):
    sid, manifest, records = experiment()
    for index in range(199):
        mid = f'{index + 2048:032x}'
        records.append({'id': mid, 'type': 'measurement', 'version': 1,
            'payload': {'id': mid, 'sessionId': sid, 'type': 'tcp_connect', 'success': True,
                        'value': 0, 'future': {'nanoseconds': '9999999999999999999', 'missing': None}}})
    manifest['expected'] = [{key: r[key] for key in ('id','type','version')} for r in records]
    encoded = gzip.compress(json.dumps(manifest).encode())
    response = client.put(f'/api/v2/sessions/{sid}/manifest', content=encoded,
        headers={**auth(), 'Content-Type':'application/json','Content-Encoding':'gzip'})
    assert response.status_code == 200 and response.headers['x-skymeasure-sync'] == '2'
    path = f'/api/v2/sessions/{sid}'
    assert client.post(path+'/records', json={'records': records}, headers=auth()).status_code == 422
    for batch in (records[:200], records[200:]):
        response = client.post(path+'/records', content=gzip.compress(json.dumps({'records':batch}).encode()),
            headers={**auth(),'Content-Type':'application/json','Content-Encoding':'gzip'})
        assert response.status_code == 200 and len(response.json()['acknowledged']) == len(batch)
    assert client.post(path+'/complete',headers=auth()).json()['complete']
    exported = client.get('/api/v2/research/sessions/'+sid,headers=auth('researcher')).json()
    sample = next(m for m in exported['measurements'] if 'future' in m)
    assert sample['value'] == 0 and sample['future'] == {'nanoseconds':'9999999999999999999','missing':None}


def test_encoded_decoded_limits_and_invalid_gzip(client):
    path='/api/v2/profile'
    for body in [b'not gzip', gzip.compress(b'{}')[:-2], gzip.compress(b'{}')+b'trailing', gzip.compress(b'{}')+gzip.compress(b'{}')]:
        assert client.patch(path,content=body,headers={**auth(),'Content-Encoding':'gzip'}).status_code == 400
    assert client.patch(path,content=gzip.compress(b'a'*(MAX_BODY+1)),headers={**auth(),'Content-Encoding':'gzip'}).status_code == 413
    assert client.patch(path,content=b'a'*(MAX_BODY+1),headers=auth()).status_code == 413
    assert client.patch(path,content=b'{}',headers={**auth(),'Content-Encoding':'br'}).status_code == 415
    # Raw measurement payloads retain their original no-compression contract.
    assert client.post('/api/v1/probe/upload',content=gzip.compress(b'hello'),headers={'Content-Encoding':'gzip','Content-Type':'application/octet-stream'}).status_code == 415


def test_android_binary_gzip_alias_uses_the_same_strict_decoder(client):
    sid,manifest,records=experiment()
    path=f'/api/v2/sessions/{sid}'
    # NetworkingModule removes the standard header from ArrayBuffer uploads.
    headers={**auth(),'Content-Type':'application/json','X-SkyMeasure-Content-Encoding':'gzip'}
    assert client.put(path+'/manifest',content=gzip.compress(json.dumps(manifest).encode()),headers=headers).status_code==200
    assert client.post(path+'/records',content=gzip.compress(json.dumps({'records':records}).encode()),headers=headers).status_code==200
    assert client.post(path+'/complete',headers=auth()).json()['complete']
    assert client.patch('/api/v2/profile',content=b'not gzip',headers=headers).status_code==400
    assert client.patch('/api/v2/profile',content=gzip.compress(b'a'*(MAX_BODY+1)),headers=headers).status_code==413
    assert client.patch('/api/v2/profile',content=b'{}',headers={**headers,'Content-Encoding':'identity'}).status_code==400
    assert client.patch('/api/v2/profile',content=b'{}',headers={**auth(),'X-SkyMeasure-Content-Encoding':'br'}).status_code==415


def test_compact_trip_receipt_ownership_and_final_revision(client):
    tid='d'*32
    body={**trip_body(),'revision':2,'state':'completed','phase':'finished','endedAt':2000}
    result=client.put('/api/v2/trips/'+tid+'?view=receipt',json=body,headers=auth())
    assert result.status_code == 200
    assert result.json()['acceptedRevision'] == 2 and not result.json()['uploadComplete']
    assert 'flight' not in result.json() and 'segments' not in result.json()
    assert client.get('/api/v2/trips/'+tid+'/receipt',headers=auth('b')).status_code == 404
    sid,manifest,records=experiment()
    manifest['session']['config'].update(tripId=tid,segmentIndex=0)
    assert client.put(f'/api/v2/sessions/{sid}/manifest',json=manifest,headers=auth()).status_code==200
    assert client.post(f'/api/v2/sessions/{sid}/records',json={'records':records},headers=auth()).status_code==200
    assert client.post(f'/api/v2/sessions/{sid}/complete',headers=auth()).json()['complete']
    assert client.get('/api/v2/trips/'+tid+'/receipt',headers=auth()).json()=={
        'id':tid,'acceptedRevision':2,'expectedSegments':1,'receivedSegments':1,'completeSegments':1,'uploadComplete':True}


def test_new_and_previous_hourly_policies_require_current_pilot_rules(client):
    for index,policy in enumerate((PILOT_POLICY,PREVIOUS_PILOT_POLICY)):
        path='/api/v2/trips/'+f'{4096+index:032x}'
        body={**trip_body(),'policyVersion':policy,'groundTest':True,'transferSchedule':'hourly-v1'}
        assert client.put(path,json=body,headers=auth()).status_code==422  # no flight details
        body['flight']={'flightNumber':'SYNTHETIC','departure':'Synthetic origin','arrival':'Synthetic destination'}
        assert client.put(path,json=body,headers=auth()).status_code==200
        body.update(revision=2,flight={**body['flight'],'expectedMinutes':30})
        assert client.put(path,json=body,headers=auth()).status_code==422


def test_interrupted_counts_filters_csv_and_raw_evidence_agree(client):
    tid='e'*32
    assert client.put('/api/v2/trips/'+tid,json=trip_body(),headers=auth()).status_code==200
    sid,manifest,records=experiment()
    manifest['session']['config'].update(tripId=tid,segmentIndex=0)
    records=records[:1]
    # Sanitized latest-run regression: 178 successes, four app interruptions,
    # one true timeout. All 183 parent attempts remain visible.
    for i in range(183):
        mid=f'{8192+i:032x}'
        payload={'id':mid,'sessionId':sid,'timestamp':'2026-11-23T12:00:01Z','type':'icmp_burst','success':i<178}
        if 178<=i<182:payload.update(errorType='cancelled',interruptionReason='segment_boundary')
        if i==182:payload.update(errorType='timeout')
        records.append({'id':mid,'type':'measurement','version':1,'payload':payload})
    manifest['expected']=[{k:r[k] for k in ('id','type','version')} for r in records]
    assert client.put(f'/api/v2/sessions/{sid}/manifest',json=manifest,headers=auth()).status_code==200
    assert client.post(f'/api/v2/sessions/{sid}/records',json={'records':records},headers=auth()).status_code==200
    detail=client.get(f'/api/v2/research/trips/{tid}/detail',headers=auth('researcher')).json()
    assert detail['summary']['measurements']==183
    assert detail['summary']['failures']==1 and detail['summary']['interruptions']==4
    timeline=client.get(f'/api/v2/research/trips/{tid}/timeline',headers=auth('researcher')).json()
    points=timeline['series'][0]['points']
    assert sum(p['outcome']=='interrupted' for p in points)==4
    for which,count in [('failure',1),('interrupted',4)]:
        page=client.get(f'/api/v2/research/trips/{tid}/evidence?outcome={which}',headers=auth('researcher'))
        assert page.status_code==200 and page.json()['total']==count
    exported=client.get(f'/api/v2/research/sessions/{sid}',headers=auth('researcher')).json()
    assert exported['receipt']['failures']==1 and exported['receipt']['interruptions']==4
    assert sum(m.get('errorType')=='cancelled' for m in exported['measurements'])==4  # immutable
    csv=client.get(f'/api/v2/research/sessions/{sid}?format=csv',headers=auth('researcher')).text
    assert 'measurement.outcome' in csv and 'measurement.interruptionReason' in csv


def test_timing_preserves_streaming_and_cors_without_logging_ids_or_payloads(caplog):
    app=FastAPI()
    @app.post('/api/v2/streams/{object_id}')
    async def stream(object_id:str):
        async def chunks():
            yield b'one'
            yield b'two'
        return StreamingResponse(chunks())
    app.add_middleware(RequestLimits)
    app.add_middleware(RequestTiming)
    app.add_middleware(CORSMiddleware,allow_origins=['https://dashboard.invalid'],allow_methods=['POST'],allow_headers=['Content-Encoding'],expose_headers=['X-Request-ID','X-SkyMeasure-Sync','Server-Timing'])
    with TestClient(app) as c, caplog.at_level(logging.INFO,logger='uvicorn.error'):
        result=c.post('/api/v2/streams/private-id?secret=hidden',content=gzip.compress(b'private-body'),headers={'Origin':'https://dashboard.invalid','Content-Encoding':'gzip'})
        assert result.content==b'onetwo' and result.headers['access-control-allow-origin']=='https://dashboard.invalid'
        assert result.headers['x-skymeasure-sync']=='2' and len(result.headers['x-request-id'])==32
        rejected=c.post('/api/v2/streams/private-id',content=b'bad',headers={'Origin':'https://dashboard.invalid','Content-Encoding':'gzip'})
        assert rejected.status_code==400 and rejected.headers['access-control-allow-origin']=='https://dashboard.invalid'
    logs=[r.getMessage() for r in caplog.records if r.getMessage().startswith('research_timing')]
    assert len(logs)==2
    assert not any(secret in '\n'.join(logs) for secret in ('private-id','private-body','hidden'))
