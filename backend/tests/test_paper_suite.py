"""Sanitized paper-suite payloads exercise real ingestion, grouping and authorization."""
import csv
import io
from sqlalchemy.orm import Session
from backend.tests.test_research import client, auth, trip_body, experiment
from backend.research.database import Account, engine
from backend.research.policies import PAPER_POLICY, PAPER_SUITE, CONSENT_VERSION, PREVIOUS_CONSENT_VERSION

TRIP='e'*32

def paper_trip():
    return {**trip_body(),'policyVersion':PAPER_POLICY,'measurementSuiteVersion':PAPER_SUITE,
            'flight':{'flightNumber':'TEST001','departure':'Test origin','arrival':'Test destination'},'groundTest':True}


def test_versioned_consent_and_ownership(client):
    path='/api/v2/trips/'+TRIP
    with Session(engine()) as db:
        db.get(Account,'a').consent_version=PREVIOUS_CONSENT_VERSION
        db.commit()
    assert client.put(path,headers=auth(),json=paper_trip()).status_code==403
    assert client.patch('/api/v2/profile',headers=auth(),json={'consentVersion':CONSENT_VERSION}).status_code==200
    assert client.put(path,headers=auth(),json=paper_trip()).status_code==200
    assert client.put(path,headers=auth('b'),json=paper_trip()).status_code==404
    assert client.put(path,headers=auth(),json={**paper_trip(),'measurementSuiteVersion':None}).status_code==422
    assert client.put(path,headers=auth(),json={**paper_trip(),'transferSchedule':'hourly-v1'}).status_code==422
    assert client.put(path,headers=auth(),json={**paper_trip(),'revision':2,'used':{'transfers':1,'diagnostics':0,'uploads':0}}).status_code==200
    assert client.put(path,headers=auth(),json={**paper_trip(),'revision':3}).status_code==409


def test_new_fields_survive_ingestion_filters_and_csv_without_pooling_targets(client):
    assert client.put('/api/v2/trips/'+TRIP,headers=auth(),json=paper_trip()).status_code==200
    sid, manifest, records=experiment()
    manifest['session']['config'].update(tripId=TRIP,segmentIndex=0,measurementSuiteVersion=PAPER_SUITE,httpEnabled=False)
    records=records[:1]
    for i,(kind,target,value) in enumerate([('cdn_fetch','google',0),('cdn_fetch','jquery',90),('dns_resolver','nextdns',None),('traceroute','fixed_ip_control',5)]):
        rid=f'{5000+i:032x}'
        paper={'suiteVersion':PAPER_SUITE,'bodyBytes':89501,'bodyComplete':True,'contentMatches':True,'totalMs':value,'dnsLookupMs':0,
               'headers':{'x-cache':'HIT'},'provider':target} if kind=='cdn_fetch' else {'configuredDnsServers':['192.0.2.53'],
               'observedResolverIp':None,'resolverStatus':'ok','resolverUnavailableReason':'endpoint_did_not_report_resolver_ip'}
        payload={'id':rid,'sessionId':sid,'type':kind,'timestamp':f'2026-11-25T12:00:0{i}Z','success':True,'value':value,'unit':'ms' if kind!='traceroute' else 'hops',
                 'targetId':target,'targetHost':'https://example.invalid/object' if kind=='cdn_fetch' else '192.0.2.8','roundId':'1:0',
                 'paper':paper,'raw':{'library':'okhttp','version':'4.12.0','callbacks':[{'value':{'elapsedNs':'9007199254740993'}}]}}
        records.append({'id':rid,'type':'measurement','version':1,'payload':payload})
    manifest['expected']=[{k:r[k] for k in ('id','type','version')} for r in records]
    assert client.put(f'/api/v2/sessions/{sid}/manifest',headers=auth(),json=manifest).status_code==200
    for _ in range(2):
        response=client.post(f'/api/v2/sessions/{sid}/records',headers=auth(),json={'records':records})
        assert response.status_code==200, response.text
    assert client.post(f'/api/v2/sessions/{sid}/complete',headers=auth()).json()['complete']
    base='/api/v2/research/trips/'+TRIP
    assert client.get(base+'/evidence',headers=auth()).status_code==403
    filtered=client.get(base+'/evidence?protocol=cdn_fetch&cdnProvider=google',headers=auth('researcher')).json()
    assert filtered['total']==1 and filtered['items'][0]['paper']['totalMs']==0
    assert client.get(base+'/evidence?targetId=fixed_ip_control',headers=auth('researcher')).json()['total']==1
    detail=client.get(base+'/detail',headers=auth('researcher')).json()
    groups=detail['summary']['paperTargets']
    assert {r['targetId'] for r in groups}=={'google','jquery','nextdns','fixed_ip_control'}
    assert next(r for r in groups if r['targetId']=='google')['medianPhasesMs']['totalMs']==0
    assert detail['summary']['resolvers'][0]['observedResolverIp'] is None
    timeline=client.get(base+'/timeline',headers=auth('researcher')).json()
    assert len([r for r in timeline['series'] if r['type']=='cdn_fetch'])==2
    assert next(r for r in timeline['series'] if r['type']=='dns_resolver')['points'][0]['value'] is None
    rows=list(csv.DictReader(io.StringIO(client.get(base+'/export?format=csv',headers=auth('researcher')).text)))
    assert len(rows)==4 and rows[0]['session.measurementSuiteVersion']==PAPER_SUITE
    assert rows[0]['measurement.paper.totalMs']=='0'
    assert rows[2]['measurement.paper.configuredDnsServers']=='["192.0.2.53"]'
    raw=client.get(base+'/export',headers=auth('researcher')).json()
    assert raw['segments'][0]['measurements'][0]['raw']['callbacks'][0]['value']['elapsedNs']=='9007199254740993'
