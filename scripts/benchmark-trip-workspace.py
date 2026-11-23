"""Synthetic offline read-model benchmark. Never connects to a configured database."""
from pathlib import Path
import sys,json,tempfile,time,statistics,math
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from backend.research.database import Base,Account,ResearchTrip,ResearchSession,TripSegment,Record,Sample
from backend.research.trip_views import compact_listing,detail_model

def bench():
 root=Path(__file__).resolve().parents[1];(root/'build').mkdir(exist_ok=True)
 with tempfile.TemporaryDirectory(prefix='synthetic-trip-benchmark-',dir=root/'build') as directory:
  engine=create_engine('sqlite:///'+str(Path(directory)/'synthetic.sqlite'));Base.metadata.create_all(engine)
  start=1793534400000;ntrips=24;nsessions=522;nrecords=117681;nsamples=169599
  def tid(i):return f'{i+1:032x}'
  def sid(i):return f'{i+1000:032x}'
  def rid(i):return f'{i+1000000:032x}'
  with engine.begin() as c:
   c.execute(Account.__table__.insert(),{'user_id':'synthetic-owner','participant_id':'f'*32,'role':'participant','mobile_uploads':False,'deleted':False})
   c.execute(ResearchTrip.__table__.insert(),[{'id':tid(i),'owner_id':'synthetic-owner','participant_id':'f'*32,'revision':1,'received_at':'2026-11-01T12:00:00Z','raw':{'startedAt':start+i*86400000,'endedAt':start+i*86400000+3600000,'state':'completed','phase':'finished','flight':{'flightNumber':'SYNTHETIC'},'groundTest':True,'segmentCount':math.ceil((nsessions-i)/ntrips)}}for i in range(ntrips)])
   c.execute(ResearchSession.__table__.insert(),[{'id':sid(i),'owner_id':'synthetic-owner','participant_id':'f'*32,'collected_at':'2026-11-01T12:00:00Z','received_at':'2026-11-01T12:00:00Z','collector_version':'synthetic-benchmark','manifest':{'expected':[{'type':'measurement','id':rid(j),'version':1}for j in range(i,nrecords,nsessions)]},'raw':{'id':sid(i),'startedAt':'2026-11-01T12:00:00Z','endedAt':'2026-11-01T12:15:00Z','config':{'tripId':tid(i%ntrips)}}}for i in range(nsessions)])
   c.execute(TripSegment.__table__.insert(),[{'trip_id':tid(i%ntrips),'ordinal':i//ntrips,'session_id':sid(i)}for i in range(nsessions)])
   for offset in range(0,nrecords,5000):
    c.execute(Record.__table__.insert(),[{'session_id':sid(i%nsessions),'kind':'measurement','id':rid(i),'version':1,'timestamp':'2026-11-01T12:00:01Z','protocol':'icmp_burst','success':True,'value':float(i%100),'unit':'ms','received_at':'2026-11-01T12:00:02Z','raw':{'id':rid(i),'type':'icmp_burst','scheduling':{'timingValid':True},'networkSnapshot':{'asn':5384},'details':{'complete':True}}}for i in range(offset,min(nrecords,offset+5000))])
   for offset in range(0,nsamples,5000):
    c.execute(Sample.__table__.insert(),[{'session_id':sid((i%nrecords)%nsessions),'measurement_id':rid(i%nrecords),'ordinal':i//nrecords,'phase':'probe','rtt_ms':float(i%100),'raw':{'rttMs':float(i%100)},'outcome':'reply'}for i in range(offset,min(nsamples,offset+5000))])
  times=[]
  for _ in range(10):
   with Session(engine) as db:
    at=time.perf_counter();result=compact_listing(db,0,20);times.append((time.perf_counter()-at)*1000)
    assert result['total']==24 and len(result['items'])==20 and 'summary' not in result['items'][0]
  with Session(engine) as db:
   t=db.get(ResearchTrip,tid(0));at=time.perf_counter();detail_model(db,t);cold=(time.perf_counter()-at)*1000
  with Session(engine) as db:
   t=db.get(ResearchTrip,tid(0));at=time.perf_counter();detail_model(db,t);warm=(time.perf_counter()-at)*1000
  report={'synthetic':True,'database':'disposable local SQLite; excludes network/authentication latency','trips':ntrips,'segments':nsessions,'records':nrecords,'samples':nsamples,'compactListMs':{'cold':round(times[0],2),'p95':round(sorted(times)[math.ceil(.95*len(times))-1],2)},'selectedTripDetailMs':{'cold':round(cold,2),'cached':round(warm,2)}}
  engine.dispose();assert report['compactListMs']['p95']<2000
  return report
if __name__=='__main__':
 result=bench();Path('build/trip-workspace-benchmark.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
