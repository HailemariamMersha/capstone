"""Small trip summaries from parent records and indexed samples, never CSV rows."""
import statistics
from sqlalchemy import select, func, case, and_
from .database import TripSegment, ResearchSession, Record, Sample
from .outcomes import failed, interrupted


def summaries(db, trip_ids):
    if not trip_ids:
        return {}
    result = {key: {'receivedSegments': 0, 'receivedRecords': 0,
                    'expectedRecords': 0, 'measurements': 0, 'failures': 0, 'interruptions': 0,
                    'protocols': []} for key in trip_ids}
    for key, expected in db.execute(select(
        TripSegment.trip_id, ResearchSession.manifest['expected']
    ).join(ResearchSession, ResearchSession.id == TripSegment.session_id)
        .where(TripSegment.trip_id.in_(trip_ids))):
        result[key]['receivedSegments'] += 1
        result[key]['expectedRecords'] += len(expected or [])

    for key, count in db.execute(select(TripSegment.trip_id, func.count())
        .join(Record, Record.session_id == TripSegment.session_id)
        .where(TripSegment.trip_id.in_(trip_ids)).group_by(TripSegment.trip_id)):
        result[key]['receivedRecords'] = count

    capped = Record.raw['reference']['stopReason'].as_string() == 'data_threshold'
    timeout = and_(Record.success.is_(False), Record.raw['errorType'].as_string() == 'timeout')
    metrics = {}
    valid_timing = Record.raw['scheduling']['timingValid'].as_boolean().is_not(False)
    for key, protocol, attempts, successful, failures, interruptions, timeouts, caps, incomplete, reached, excluded in db.execute(
        select(TripSegment.trip_id, Record.protocol, func.count(),
            func.sum(case((Record.success.is_(True), 1), else_=0)),
            func.sum(case((failed(), 1), else_=0)),
            func.sum(case((interrupted(), 1), else_=0)),
            func.sum(case((timeout, 1), else_=0)),
            func.sum(case((capped, 1), else_=0)),
            func.sum(case((Record.raw['details']['complete'].as_boolean().is_(False), 1), else_=0)),
            func.sum(case((Record.raw['route']['reached'].as_boolean().is_(True), 1), else_=0)),
            func.sum(case((~valid_timing, 1), else_=0)))
        .join(Record, Record.session_id == TripSegment.session_id)
        .where(TripSegment.trip_id.in_(trip_ids), Record.kind == 'measurement')
        .group_by(TripSegment.trip_id, Record.protocol)
    ):
        metric = {'type': protocol or 'unknown', 'attempts': attempts,
                  'successful': successful, 'failed': failures, 'interrupted': interruptions, 'timeouts': timeouts,
                  'capped': caps, 'incompleteBursts': incomplete, 'reached': reached,
                  'sampleCount': 0, 'replies': 0, 'medianMs': None, 'timingExcluded': excluded}
        metrics[(key, protocol)] = metric
        result[key]['protocols'].append(metric)
        result[key]['measurements'] += attempts
        result[key]['failures'] += failures
        result[key]['interruptions'] += interruptions

    # Count probe/hop observations separately from parents. Baselines and M-Lab
    # callback records must not inflate echo reply counts or connection attempts.
    sample_join = and_(Record.session_id == Sample.session_id,
                       Record.id == Sample.measurement_id, Record.kind == 'measurement')
    valid_rtt = Sample.rtt_ms >= 0  # SQL also excludes NULL; zero remains valid.
    for key, protocol, count, replies in db.execute(select(
        TripSegment.trip_id, Record.protocol, func.count(),
        func.sum(case((valid_rtt, 1), else_=0)))
        .select_from(TripSegment)
        .join(Sample, Sample.session_id == TripSegment.session_id)
        .join(Record, sample_join)
        .where(TripSegment.trip_id.in_(trip_ids), Sample.phase.in_(['probe', 'hop']))
        .group_by(TripSegment.trip_id, Record.protocol)):
        metric = metrics[(key, protocol)]
        metric.update(sampleCount=count, replies=replies)

    # Exact pooled median in PostgreSQL and SQLite, without transferring sample
    # payloads or averaging per-burst medians. For even N select both middle rows.
    partition = [TripSegment.trip_id, Record.protocol]
    ranked = select(TripSegment.trip_id.label('trip_id'), Record.protocol.label('protocol'),
        Sample.rtt_ms.label('rtt'),
        func.row_number().over(partition_by=partition, order_by=Sample.rtt_ms).label('rank'),
        func.count().over(partition_by=partition).label('count'))\
        .select_from(TripSegment).join(Sample, Sample.session_id == TripSegment.session_id)\
        .join(Record, sample_join)\
        .where(TripSegment.trip_id.in_(trip_ids), Sample.phase == 'probe', valid_rtt, valid_timing).subquery()
    for key, protocol, median in db.execute(select(
        ranked.c.trip_id, ranked.c.protocol, func.avg(ranked.c.rtt))
        .where(2 * ranked.c.rank >= ranked.c.count, 2 * ranked.c.rank <= ranked.c.count + 2)
        .group_by(ranked.c.trip_id, ranked.c.protocol)):
        metrics[(key, protocol)]['medianMs'] = median
    # Parent-only paper comparisons, separated by target; never pool different CDN objects.
    paper_groups = {}
    for tid, protocol, raw in db.execute(select(TripSegment.trip_id, Record.protocol, Record.raw)
        .join(Record, Record.session_id == TripSegment.session_id)
        .where(TripSegment.trip_id.in_(trip_ids), Record.kind == 'measurement',
               Record.protocol.in_(['cdn_fetch','dns_resolver','traceroute']))):
        target = raw.get('targetId') or raw.get('targetHost') or 'historical_unknown'
        group = paper_groups.setdefault((tid,protocol,target), {'type':protocol,'targetId':target,
            'target':raw.get('targetHost'), 'provider':(raw.get('paper') or {}).get('provider'),
            'attempts':0,'successful':0,'reached':0,'phaseValues':{}})
        group['attempts'] += 1
        group['successful'] += raw.get('success') is True
        group['reached'] += (raw.get('route') or {}).get('reached') is True
        paper = raw.get('paper') or {}
        if protocol == 'dns_resolver':
            history = result[tid].setdefault('resolvers', [])
            if len(history) < 2000:
                history.append({k:v for k,v in {**paper,'timestamp':raw.get('timestamp'),'measurementId':raw.get('id'),
                    'success':raw.get('success'),'errorType':raw.get('errorType')}.items()
                    if k in ('timestamp','measurementId','success','errorType','configuredDnsServers','observedResolverIp',
                             'resolverStatus','resolverUnavailableReason','privateDnsActive')})
        if raw.get('success') is True and (raw.get('scheduling') or {}).get('timingValid') is not False:
            for field in ('dnsLookupMs','tcpConnectMs','tlsHandshakeMs','responseHeadersAfterMs','bodyReadMs','totalMs'):
                value = paper.get(field)
                if isinstance(value,(int,float)) and not isinstance(value,bool) and value >= 0:
                    group['phaseValues'].setdefault(field, []).append(value)
    for (tid,_,_), group in paper_groups.items():
        group['medianPhasesMs'] = {key:statistics.median(values) for key,values in group.pop('phaseValues').items()}
        result[tid].setdefault('paperTargets', []).append(group)
    for value in result.values():
        value['protocols'].sort(key=lambda item: item['type'])
    return result
