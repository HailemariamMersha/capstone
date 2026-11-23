"""Trip-first read models. Lists never scan individual samples or load raw evidence."""
import csv
from contextlib import contextmanager
import hashlib
import io
import json
import math
import statistics
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, Response
from sqlalchemy import select, func, case, and_, or_, BigInteger, cast, text
from sqlalchemy.orm import Session
from .auth import researcher
from .database import ResearchTrip, ResearchSession, TripSegment, Record, Sample, HistoryReset, database, now
from .exports import combined_rows, csv_text
from .presentation import readable, evidence_response
from .read_cache import cached
from .history_reset import epoch_ms
from .trip_summary import summaries
from .outcomes import failed, interrupted, outcome as measurement_outcome

router = APIRouter()
PROVIDERS = {14593: 'Starlink', 31515: 'Inmarsat', 22351: 'Intelsat', 64294: 'Panasonic', 206433: 'SITA', 40306: 'ViaSat', 5384: 'TEST Etisalat'}
KINDS = ('all', 'study', 'ground')


def trip_query(q='', provider='', kind='all', since=None, until=None):
    query = select(ResearchTrip)
    if kind == 'ground': query = query.where(or_(ResearchTrip.raw['groundTest'].as_boolean().is_(True),ResearchTrip.raw['shadow'].as_boolean().is_(True)))
    if kind == 'study': query = query.where(ResearchTrip.raw['groundTest'].as_boolean().is_not(True),ResearchTrip.raw['shadow'].as_boolean().is_not(True))
    if provider: query = query.where(ResearchTrip.raw['provider'].as_string() == provider)
    if q:
        pattern = '%' + q.replace('%', '\\%').replace('_', '\\_') + '%'
        query = query.where(or_(*[field.ilike(pattern, escape='\\') for field in (
            ResearchTrip.participant_id, ResearchTrip.raw['flight']['flightNumber'].as_string(),
            ResearchTrip.raw['flight']['departure'].as_string(), ResearchTrip.raw['flight']['arrival'].as_string())]))
    start = cast(ResearchTrip.raw['startedAt'].as_string(), BigInteger)
    if since:
        at = epoch_ms(since)
        if at is None: raise HTTPException(422, 'Invalid collection date')
        query = query.where(start >= at)
    if until:
        at = epoch_ms(until)
        if at is None: raise HTTPException(422, 'Invalid collection date')
        query = query.where(start < at)
    return query


def get_trip(db, trip_id):
    trip = db.get(ResearchTrip, trip_id)
    if not trip: raise HTTPException(404, 'Trip not found or removed from test history')
    return trip


def compact_items(db, trips):
    if not trips: return []
    ids = [t.id for t in trips]
    length = func.jsonb_array_length if db.bind.dialect.name == 'postgresql' else func.json_array_length
    counts = {r[0]: r[1:] for r in db.execute(select(TripSegment.trip_id, func.count(),
        func.sum(case((ResearchSession.completed_at.is_not(None), 1), else_=0)),
        func.sum(length(ResearchSession.manifest['expected'])))
        .join(ResearchSession, ResearchSession.id == TripSegment.session_id)
        .where(TripSegment.trip_id.in_(ids)).group_by(TripSegment.trip_id))}
    records = {r[0]: r[1:] for r in db.execute(select(TripSegment.trip_id, func.count(),
        func.sum(case((Record.kind == 'measurement', 1), else_=0)),
        func.sum(case((and_(Record.kind == 'measurement', failed()), 1), else_=0)),
        func.sum(case((and_(Record.kind == 'measurement', interrupted()), 1), else_=0)))
        .join(Record, Record.session_id == TripSegment.session_id)
        .where(TripSegment.trip_id.in_(ids)).group_by(TripSegment.trip_id))}
    result = []
    for t in trips:
        received, complete, expected = counts.get(t.id, (0, 0, 0))
        saved, measurements, failures, interruptions = records.get(t.id, (0, 0, 0, 0))
        declared = t.raw.get('segmentCount', 0)
        result.append({'id': t.id, 'participantId': t.participant_id,
            **{k: t.raw.get(k) for k in ('flight', 'startedAt', 'endedAt', 'state', 'phase', 'provider', 'reason', 'firstQualifiedAt')},
            'groundTest': bool(t.raw.get('groundTest') or t.raw.get('shadow')),
            'receivedAt': t.received_at, 'segmentCount': declared,
            'receivedSegments': received, 'completeSegments': complete,
            'missingSegments': max(0, declared - complete),
            'receivedRecords': saved, 'expectedRegisteredRecords': expected or 0,
            'measurements': measurements or 0, 'failures': failures or 0, 'interruptions': interruptions or 0,
            'uploadComplete': t.raw['state'] != 'active' and complete == declared and received == declared and saved == (expected or 0)})
    return result


def compact_listing(db, offset, limit, q='', provider='', kind='all', since=None, until=None):
    query = trip_query(q, provider, kind, since, until)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    trips = list(db.scalars(query.order_by(cast(ResearchTrip.raw['startedAt'].as_string(), BigInteger).desc(), ResearchTrip.id).offset(offset).limit(limit)))
    return {'total': total, 'items': compact_items(db, trips), 'receivedAt': now()}


def union(intervals):
    result = []
    for start, end in sorted((a, b) for a, b in intervals if b > a):
        if result and start <= result[-1][1]: result[-1][1] = max(result[-1][1], end)
        else: result.append([start, end])
    return result


def subtract(intervals, exclusions):
    remaining = union(intervals)
    for a, b in union(exclusions):
        remaining = [piece for start, end in remaining for piece in
            ([(start, end)] if end <= a or start >= b else [(start, min(end, a)), (max(start, b), end)]) if piece[1] > piece[0]]
    return remaining


def links(db, trip_id):
    return list(db.execute(select(TripSegment.ordinal, ResearchSession)
        .join(ResearchSession, ResearchSession.id == TripSegment.session_id)
        .where(TripSegment.trip_id == trip_id).order_by(TripSegment.ordinal)))


def control_view(db, trip):
    ids = select(TripSegment.session_id).where(TripSegment.trip_id == trip.id)
    events, collection, blockers, battery = [], [], [], []
    previous, signature = None, None
    latest = trip.raw['startedAt']
    retries, skipped, invalid = 0, 0, 0
    rows = db.execute(select(Record.id, Record.timestamp, Record.event_kind, Record.raw['details'])
        .where(Record.session_id.in_(ids), Record.kind == 'event', Record.event_kind.in_([
            'flight_detection', 'collector_gap', 'upload_pause', 'collector_upload_request',
            'collector_heartbeat', 'probe_skipped', 'segment_health', 'collector_segment_health', 'transfer_disabled']))
        .order_by(Record.timestamp, Record.id))
    detections = []
    for rid, timestamp, kind, detail in rows:
        d = detail if isinstance(detail, dict) else {}
        at = epoch_ms(d.get('at') if kind == 'flight_detection' else d.get('observedAt'))
        if at is None: at = epoch_ms(timestamp)
        if at is None: continue
        latest = max(latest, at)
        if kind == 'flight_detection':
            detections.append((at, d, rid))
        elif kind in ('collector_gap', 'upload_pause'):
            start, end = epoch_ms(d.get('startedAt')), epoch_ms(d.get('endedAt'))
            if start is not None and end is not None and end >= start:
                blockers.append((start, end))
                events.append({'id': rid, 'at': start, 'end': end, 'kind': kind, 'reason': d.get('reason') or d.get('outcome'), 'durationMs': d.get('durationMs', end-start)})
        elif kind == 'collector_upload_request':
            if d.get('outcome') == 'pending_retry':
                retries += 1
                events.append({'id': rid, 'at': at, 'kind': 'upload_retry', 'reason': d.get('reason'), 'stage': d.get('stage')})
        elif kind == 'probe_skipped':
            skipped += 1
            events.append({'id': rid, 'at': at, 'kind': kind, 'reason': d.get('reason'), 'protocol': d.get('type')})
        elif kind == 'collector_heartbeat':
            power = d.get('power') or {}
            if power:
                battery.append({'at': at, 'percent': power.get('batteryPercent'), 'screenInteractive': power.get('screenInteractive'), 'deviceIdle': power.get('deviceIdle'), 'batteryExempt': power.get('batteryExempt')})
        elif kind == 'transfer_disabled':
            events.append({'id': rid, 'at': at, 'kind': kind, 'reason': d.get('reason'), 'protocol': d.get('type')})
    for at, d, rid in sorted(detections, key=lambda row: (row[0], row[2])):
        if previous and previous[1].get('phase') == 'collecting' and 0 <= at-previous[0] <= 90000:
            collection.append((previous[0], at))
        current = (d.get('phase'), d.get('provider'), (d.get('asn') or {}).get('state'))
        if current != signature:
            events.append({'id': rid, 'at': at, 'kind': 'provider_state', 'phase': current[0], 'provider': current[1], 'asnState': current[2]})
            signature = current
        previous = at, d
    for timestamp,percent,charging in db.execute(select(Record.timestamp,Record.raw['batteryPercent'],Record.raw['isCharging'])
        .where(Record.session_id.in_(ids),Record.kind=='snapshot').order_by(Record.timestamp)):
        at=epoch_ms(timestamp)
        if at is not None and percent is not None:battery.append({'at':at,'percent':percent,'isCharging':charging})
    battery.sort(key=lambda p:p['at'])
    received = []
    segments = []
    for ordinal, session in links(db, trip.id):
        start = epoch_ms(session.raw.get('startedAt'))
        end = epoch_ms(session.raw.get('endedAt') or session.raw.get('lastObservedAt'))
        if start is not None and end is not None:
            received.append((start, end)); latest = max(latest, end)
            events.append({'id': session.id, 'at': start, 'end': end, 'kind': 'segment', 'index': ordinal, 'complete': bool(session.completed_at)})
        segments.append({'index': ordinal, 'sessionId': session.id, 'startedAt': start, 'endedAt': end, 'uploaded': bool(session.completed_at)})
    end = trip.raw.get('endedAt') if trip.raw.get('endedAt') is not None else latest
    for start, stop in subtract([(trip.raw['startedAt'], end)], received):
        events.append({'id': f'missing:{start}', 'at': start, 'end': stop, 'kind': 'unreceived', 'reason': 'No received segment evidence for this interval'})
    covered = subtract(collection, blockers)
    return {'events': sorted(events, key=lambda e: (e['at'], e['id'])), 'segments': segments,
        'health': {'observedCollectionMs': sum(b-a for a, b in covered), 'coverageIsEstimate': True,
            'reportedDurationMs': max(0, end-trip.raw['startedAt']),
            'lastObservedAt': latest, 'gapCount': sum(e['kind']=='collector_gap' for e in events),
            'gapMs': sum(e.get('durationMs', 0) for e in events if e['kind']=='collector_gap'),
            'uploadRetries': retries, 'skippedProbes': skipped, 'powerObservations': battery[::max(1, len(battery)//1000)]}}


def detail_model(db, trip):
    def compute():
        controls = control_view(db, trip)
        summary = summaries(db, [trip.id])[trip.id]
        ids=select(TripSegment.session_id).where(TripSegment.trip_id==trip.id)
        values={}
        for protocol,value in db.execute(select(Record.protocol,Record.value).where(Record.session_id.in_(ids),Record.kind=='measurement',
            Record.protocol.in_(['download','upload','ndt7_download','ndt7_upload']),Record.success.is_(True),Record.value>=0,
            Record.raw['scheduling']['timingValid'].as_boolean().is_not(False))):values.setdefault(protocol,[]).append(value)
        for protocol in summary['protocols']:protocol['medianMbps']=statistics.median(values[protocol['type']]) if protocol['type'] in values else None
        controls['health']['timingExcluded'] = sum(p.get('timingExcluded', 0) for p in summary['protocols'])
        return {'summary': summary, **controls}
    statistics_view = cached(db, f'trip:{trip.id}:detail:outcomes-v1', f'trip:{trip.id}', compute, lifetime=3600)
    return {**compact_items(db, [trip])[0], **statistics_view}


@router.get('/research/trips/{trip_id}/detail')
def trip_detail(trip_id: str, request: Request, a=Depends(researcher), db: Session=Depends(database)):
    return evidence_response(detail_model(db, get_trip(db, trip_id)), request.headers.get('accept-encoding', ''))


@router.get('/research/trips/{trip_id}/timeline')
def timeline(trip_id: str, request: Request, maxPoints: int=Query(2000, ge=100, le=2000), a=Depends(researcher), db: Session=Depends(database)):
    trip = get_trip(db, trip_id)
    def compute():
        ids = select(TripSegment.session_id).where(TripSegment.trip_id == trip_id)
        rows = db.execute(select(Record.id, Record.timestamp, Record.protocol, Record.value, Record.success,
            Record.raw['targetHost'], Record.raw['probeServer'], Record.raw['errorType'],
            Record.raw['scheduling']['timingValid'], Record.raw['durationMs'], Record.raw['transferredBytes'])
            .where(Record.session_id.in_(ids), Record.kind == 'measurement').order_by(Record.timestamp, Record.id))
        groups = {}
        for rid, timestamp, protocol, value, success, host, server, error, valid, duration, size in rows:
            at = epoch_ms(timestamp)
            if at is None: continue
            p = {'id': rid, 'at': at, 'type': protocol, 'value': value if valid is not False and success is True else None,
                'success': success, 'outcome': measurement_outcome({'success': success, 'errorType': error}), 'target': host or server, 'error': error, 'timingValid': valid is not False,
                'durationMs': duration, 'bytes': size}
            groups.setdefault(protocol or 'unknown', []).append(p)
        series = []
        for protocol, points in groups.items():
            width = max(1, math.ceil((points[-1]['at']-points[0]['at']+1)/maxPoints)) if len(points)>maxPoints else 1
            if len(points)>maxPoints:
                bins = {}
                for point in points: bins.setdefault((point['at']-points[0]['at'])//width, []).append(point)
                reduced=[]
                for values in bins.values():
                    usable=[p['value'] for p in values if p['value'] is not None]
                    reduced.append({**values[0], 'value': statistics.median(usable) if usable else None, 'pointCount': len(values),
                        'failures': sum(p['outcome'] == 'failure' for p in values), 'interruptions': sum(p['outcome'] == 'interrupted' for p in values), 'min': min(usable) if usable else None, 'max': max(usable) if usable else None})
                points=reduced
            series.append({'type': protocol, 'bucketMs': width, 'points': points})
        return {'series': series, 'clock': 'recorded_wall_clock_utc', 'rttMeaning': 'median within each recorded burst; no kernel timestamps'}
    result = cached(db, f'trip:{trip_id}:timeline:{maxPoints}:outcomes-v1', f'trip:{trip_id}', compute, lifetime=3600)
    return evidence_response(result, request.headers.get('accept-encoding', ''))


@router.get('/research/trips/{trip_id}/evidence')
def evidence(trip_id: str, request: Request, layer: str=Query('measurements', pattern='^(measurements|samples|events)$'),
             protocol: str='', outcome: str=Query('', pattern='^(|success|failure|timeout|interrupted)$'),
             offset: int=Query(0, ge=0), limit: int=Query(50, ge=1, le=200),
             a=Depends(researcher), db: Session=Depends(database)):
    get_trip(db, trip_id)
    ids = select(TripSegment.session_id).where(TripSegment.trip_id == trip_id)
    if layer == 'samples':
        query=select(Sample, Record.timestamp, Record.protocol, Record.raw['targetHost']).join(Record,
            and_(Record.session_id==Sample.session_id, Record.id==Sample.measurement_id, Record.kind=='measurement')).where(Sample.session_id.in_(ids))
        if protocol: query=query.where(Record.protocol==protocol)
        if outcome=='timeout': query=query.where(Sample.outcome=='timeout')
        elif outcome=='success': query=query.where(Sample.rtt_ms>=0)
        elif outcome=='failure': query=query.where(Sample.rtt_ms.is_(None), func.coalesce(Sample.outcome, '').not_in(['cancelled','interrupted']))
        elif outcome=='interrupted': query=query.where(Sample.outcome.in_(['cancelled','interrupted']))
        total=db.scalar(select(func.count()).select_from(query.subquery()))
        items=[{'sessionId': s.session_id, 'measurementId': s.measurement_id, 'phase': s.phase, 'ordinal': s.ordinal,
                'timestamp': raw.get('timestamp') or timestamp, 'protocol': kind, 'target': target,
                'sequence': s.sequence, 'hop': s.hop, 'rttMs': s.rtt_ms, 'outcome': s.outcome, **raw}
               for s,timestamp,kind,target in db.execute(query.order_by(Record.timestamp, Sample.ordinal).offset(offset).limit(limit))
               for raw in [readable(s.raw)]]
    else:
        query=select(Record).where(Record.session_id.in_(ids), Record.kind==('event' if layer=='events' else 'measurement'))
        if protocol: query=query.where(Record.protocol==protocol)
        if outcome=='success': query=query.where(Record.success.is_(True))
        if outcome=='failure': query=query.where(failed())
        if outcome=='interrupted': query=query.where(interrupted())
        if outcome=='timeout': query=query.where(Record.raw['errorType'].as_string()=='timeout')
        total=db.scalar(select(func.count()).select_from(query.subquery()))
        items=[{**dashboard_record(r.raw), 'sessionId': r.session_id} for r in db.scalars(query.order_by(Record.timestamp, Record.id).offset(offset).limit(limit))]
    return evidence_response({'total': total, 'items': items}, request.headers.get('accept-encoding', ''))


def dashboard_record(raw):
    result=readable(raw)
    if raw.get('kind')=='flight_detection' and isinstance(result.get('details'),dict):
        result['details']={k:v for k,v in result['details'].items() if k not in ('confidence','gps','gpsDetails','detectorPolicyVersion','policyVersion')}
    return result


def session_export(db, session, trip):
    rows = db.execute(select(Record.kind, Record.raw).where(Record.session_id == session.id).order_by(Record.timestamp, Record.id))
    data={'session': session.raw, 'trip': {**trip.raw, 'id': trip.id}, 'measurements': [], 'events': [], 'snapshots': [],
          'receipt': {'completedAt': session.completed_at, 'receivedAt': session.received_at}}
    for kind, raw in rows:
        key={'measurement':'measurements','event':'events','snapshot':'snapshots'}.get(kind)
        if key: data[key].append(raw)
    return data


@contextmanager
def export_snapshot(engine):
    with engine.connect() as connection:
        if engine.dialect.name=='postgresql':connection=connection.execution_options(isolation_level='REPEATABLE READ')
        with connection.begin():
            if engine.dialect.name=='postgresql':connection.execute(text('SET TRANSACTION READ ONLY'))
            elif engine.dialect.name=='sqlite':connection.exec_driver_sql('BEGIN')
            with Session(bind=connection) as db:yield db


@router.get('/research/trips/{trip_id}/export')
def export_trip(trip_id: str, format: str=Query('json', pattern='^(json|csv)$'), a=Depends(researcher), db: Session=Depends(database)):
    trip=get_trip(db, trip_id)
    # Export holds its own DB lifetime; request dependencies may close before a
    # streaming response finishes. Only one segment is materialized at a time.
    engine=db.get_bind()
    def generate():
        with export_snapshot(engine) as export_db:
            saved=get_trip(export_db, trip_id)
            receipt=compact_items(export_db,[saved])[0]
            rows=links(export_db, trip_id)
            if format=='json':
                yield json.dumps({'exportVersion':1,'trip':{**saved.raw,'id':saved.id},'receipt':receipt},allow_nan=False)[:-1]+',"segments":['
                for i,(_,session) in enumerate(rows):
                    if i:yield ','
                    yield json.dumps(session_export(export_db,session,saved),allow_nan=False,separators=(',',':'))
                yield ']}'
            else:
                # Discover headers without retaining the trip's flattened rows.
                fields={}
                def projected(session):
                    for row in combined_rows(session_export(export_db,session,saved)):
                        yield {**row,'trip.id':trip_id,'trip.uploadComplete':receipt['uploadComplete'],
                               'trip.receivedSegments':receipt['receivedSegments'],'trip.reportedSegments':receipt['segmentCount']}
                for _,session in rows:
                    for row in projected(session):fields.update(dict.fromkeys(row))
                output=io.StringIO(newline='');writer=csv.DictWriter(output,fieldnames=list(fields) or ['trip.id'])
                writer.writeheader();yield output.getvalue();output.seek(0);output.truncate(0)
                for _,session in rows:
                    for row in projected(session):
                        writer.writerow({k:"'"+v if isinstance(v,str) and v.startswith(('=','+','-','@','\t','\r','\n')) else v for k,v in row.items()})
                        if output.tell()>=65536:
                            yield output.getvalue();output.seek(0);output.truncate(0)
                if output.tell():yield output.getvalue()
    return StreamingResponse(generate(), media_type='application/json' if format=='json' else 'text/csv',
        headers={'Content-Disposition':f'attachment; filename="trip-{trip_id}.{format}"','Cache-Control':'private, no-store'})


@router.get('/research/trip-overview')
def trip_overview(a=Depends(researcher), db: Session=Depends(database), kind: str=Query('all', pattern='^(all|study|ground)$'), since: str | None=None, until: str | None=None):
    query=trip_query(kind=kind,since=since,until=until)
    trip_ids=query.with_only_columns(ResearchTrip.id)
    rows=list(db.execute(query.with_only_columns(ResearchTrip.id, or_(ResearchTrip.raw['groundTest'].as_boolean().is_(True),ResearchTrip.raw['shadow'].as_boolean().is_(True)), ResearchTrip.raw['state'].as_string(), ResearchTrip.raw['segmentCount'].as_integer())))
    completed={key: count for key,count in db.execute(select(TripSegment.trip_id,func.count()).join(ResearchSession,ResearchSession.id==TripSegment.session_id)
        .where(TripSegment.trip_id.in_(trip_ids),ResearchSession.completed_at.is_not(None)).group_by(TripSegment.trip_id))}
    return {'trips':len(rows),'groundTests':sum(bool(r[1]) for r in rows),'studyTrips':sum(not r[1] for r in rows),
            'incompleteUploads':sum(state=='active' or completed.get(tid,0)!=count for tid,_,state,count in rows),'receivedAt':now()}


@router.get('/research/provider-results')
def provider_results(request: Request, kind: str=Query('all',pattern='^(all|study|ground)$'), since: str | None=None, until: str | None=None,
                     provider: str='', a=Depends(researcher), db: Session=Depends(database)):
    query=trip_query(kind=kind,since=since,until=until)
    trip_ids=query.with_only_columns(ResearchTrip.id)
    key=hashlib.sha256(json.dumps([kind,since,until,provider]).encode()).hexdigest()
    def compute():
        asn=Record.raw['networkSnapshot']['asn'].as_string()
        target=func.coalesce(Record.raw['targetHost'].as_string(), Record.raw['probeServer'].as_string(), 'Unknown target')
        ground=or_(ResearchTrip.raw['groundTest'].as_boolean().is_(True),ResearchTrip.raw['shadow'].as_boolean().is_(True))
        valid=Record.raw['scheduling']['timingValid'].as_boolean().is_not(False)
        base=select(TripSegment.trip_id,asn.label('asn'),ground.label('ground'),Record.protocol.label('protocol'),target.label('target'),
            Record.id.label('id'),Record.session_id.label('session_id'),Record.value.label('value'),Record.success.label('success'))\
            .select_from(TripSegment).join(ResearchTrip,ResearchTrip.id==TripSegment.trip_id).join(Record,Record.session_id==TripSegment.session_id)\
            .where(TripSegment.trip_id.in_(trip_ids),Record.kind=='measurement',valid)
        if provider:
            allowed=[str(a) for a,name in PROVIDERS.items() if name==provider]
            base=base.where(asn.in_(allowed))
        source=base.subquery()
        groups={}
        def entry(asn,ground,protocol,target):
            name=PROVIDERS.get(int(asn),'Other network') if asn and str(asn).isdigit() else 'Unknown network'
            k=(str(asn),bool(ground),protocol,target)
            if k not in groups:groups[k]={'asn':asn,'provider':name,'groundTest':bool(ground),'protocol':protocol,'target':target,
                'attempts':0,'successful':0,'probes':0,'replies':0,'medianRttMs':None,'medianMbps':None}
            return groups[k]
        rates={}
        for a,g,p,t,total,success in db.execute(select(source.c.asn,source.c.ground,source.c.protocol,source.c.target,func.count(),
            func.sum(case((source.c.success.is_(True),1),else_=0))).group_by(source.c.asn,source.c.ground,source.c.protocol,source.c.target)):
            entry(a,g,p,t).update(attempts=total,successful=success)
        for a,g,p,t,value in db.execute(select(source.c.asn,source.c.ground,source.c.protocol,source.c.target,source.c.value)
            .where(source.c.protocol.in_(['download','upload','ndt7_download','ndt7_upload']),source.c.success.is_(True),source.c.value>=0)):
            rates.setdefault((a,g,p,t),[]).append(value)
        for k,values in rates.items():entry(*k)['medianMbps']=statistics.median(values)
        joined=and_(Sample.session_id==source.c.session_id,Sample.measurement_id==source.c.id)
        for a,g,p,t,count,replies in db.execute(select(source.c.asn,source.c.ground,source.c.protocol,source.c.target,func.count(),
            func.sum(case((Sample.rtt_ms>=0,1),else_=0))).select_from(source).join(Sample,joined)
            .where(Sample.phase=='probe').group_by(source.c.asn,source.c.ground,source.c.protocol,source.c.target)):
            entry(a,g,p,t).update(probes=count,replies=replies)
        partition=[source.c.asn,source.c.ground,source.c.protocol,source.c.target]
        ranked=select(*partition,Sample.rtt_ms.label('rtt'),func.row_number().over(partition_by=partition,order_by=Sample.rtt_ms).label('rank'),
            func.count().over(partition_by=partition).label('n')).select_from(source).join(Sample,joined).where(Sample.phase=='probe',Sample.rtt_ms>=0).subquery()
        for a,g,p,t,median in db.execute(select(ranked.c.asn,ranked.c.ground,ranked.c.protocol,ranked.c.target,func.avg(ranked.c.rtt))
            .where(2*ranked.c.rank>=ranked.c.n,2*ranked.c.rank<=ranked.c.n+2).group_by(ranked.c.asn,ranked.c.ground,ranked.c.protocol,ranked.c.target)):
            entry(a,g,p,t)['medianRttMs']=median
        return {'items':sorted(groups.values(),key=lambda r:(r['provider'],r['groundTest'],r['protocol'] or '',r['target'])),
                'notes':'Probe medians pool valid observations. Reply ratios describe recorded probes, not incomplete-burst loss estimates. Targets and ground data remain separate.'}
    return evidence_response(cached(db,'providers:'+key,'research',compute,lifetime=60),request.headers.get('accept-encoding',''))


@router.get('/research/trips/export-summary')
def export_summary(q: str='', provider: str='', kind: str=Query('all',pattern='^(all|study|ground)$'), since: str | None=None, until: str | None=None,
                   a=Depends(researcher), db: Session=Depends(database)):
    query=trip_query(q,provider,kind,since,until)
    total=db.scalar(select(func.count()).select_from(query.subquery()))
    if total>10000:raise HTTPException(422,'Narrow the export to at most 10,000 trips')
    rows=compact_items(db,list(db.scalars(query.order_by(cast(ResearchTrip.raw['startedAt'].as_string(),BigInteger).desc()))))
    flat=[]
    for row in rows:
        flight=row.pop('flight') or {}
        flat.append({**row,**flight})
    return Response(csv_text(flat),media_type='text/csv',headers={'Content-Disposition':'attachment; filename="trips-summary.csv"','Cache-Control':'private, no-store'})


@router.get('/research/trip-contributors')
def contributors(a=Depends(researcher), db: Session=Depends(database)):
    rows=db.execute(select(ResearchTrip.participant_id,func.count(),func.max(cast(ResearchTrip.raw['startedAt'].as_string(),BigInteger)))
                    .group_by(ResearchTrip.participant_id).order_by(ResearchTrip.participant_id))
    return {'items':[{'participantId':pid,'trips':count,'latestCollection':latest} for pid,count,latest in rows]}


@router.get('/research/history-generation')
def history_generation(a=Depends(researcher), db: Session=Depends(database)):
    return {'resetAt':db.scalar(select(func.max(HistoryReset.cutoff_ms)).where(HistoryReset.applied.is_(True))) or 0}
