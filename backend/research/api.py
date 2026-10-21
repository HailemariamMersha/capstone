import math
import json
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, ConfigDict, field_validator
from sqlalchemy import select, delete, func, or_, case
from sqlalchemy.orm import Session
from .database import Account, ResearchSession, Record, Sample, database, now
from .auth import account, researcher, administrator, identity
from .exports import samples, combined_rows, csv_text

def number(value):
    try:
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None
    except OverflowError:
        return None


def integer(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and -(2**31) <= value < 2**31 else None


def string(value, limit=100):
    return value[:limit] if isinstance(value, str) else None


router = APIRouter(prefix='/api/v2')
CONSENT_VERSION = 'skymeasure-staging-2026-10-22'


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class ProfileUpdate(Strict):
    consentVersion: str | None = None
    mobileUploads: bool = False


def profile(a):
    return {'participantId': a.participant_id, 'role': a.role,
            'consentVersion': a.consent_version, 'consentAt': a.consent_at,
            'mobileUploads': a.mobile_uploads, 'requiredConsentVersion': CONSENT_VERSION}


@router.get('/profile')
def get_profile(a=Depends(account)):
    return profile(a)


@router.patch('/profile')
def update_profile(body: ProfileUpdate, a=Depends(account), db: Session = Depends(database)):
    if body.consentVersion is not None:
        if body.consentVersion != CONSENT_VERSION:
            raise HTTPException(409, 'Please read the current research information')
        a.consent_version, a.consent_at = body.consentVersion, now()
    a.mobile_uploads = body.mobileUploads
    db.commit()
    return profile(a)


@router.delete('/account')
def delete_account(user_id=Depends(identity), db: Session = Depends(database)):
    a = db.scalar(select(Account).where(Account.user_id == user_id).with_for_update())
    if not a:
        raise HTTPException(404, 'Account not found')
    ids = select(ResearchSession.id).where(ResearchSession.owner_id == a.user_id)
    db.execute(delete(Sample).where(Sample.session_id.in_(ids)))
    db.execute(delete(Record).where(Record.session_id.in_(ids)))
    db.execute(delete(ResearchSession).where(ResearchSession.owner_id == a.user_id))
    # A tombstone blocks replays and re-upload from other devices. Identity deletion
    # is handled by the server management command, never a service key on a phone.
    a.deleted = True
    a.consent_version = a.consent_at = None
    db.commit()
    return {'deleted': True, 'identityDeletionPending': True}


class Expected(Strict):
    type: Literal['session', 'measurement', 'snapshot', 'event']
    id: str = Field(pattern=r'^[a-f0-9]{32}$')
    version: int = Field(ge=1)


class Manifest(Strict):
    collectorVersion: str = Field(min_length=1, max_length=100)
    schemaVersion: int = Field(ge=1)
    session: dict
    expected: list[Expected] = Field(min_length=1, max_length=100000)


class Incoming(Expected):
    payload: dict

    @field_validator('payload')
    @classmethod
    def valid_known_shapes(cls, raw):
        try:
            json.dumps(raw, allow_nan=False)
        except (ValueError, OverflowError):
            raise ValueError('Evidence must use finite JSON numbers; use null for unavailable values')
        for key in ('raw', 'packet', 'details', 'route', 'networkSnapshot'):
            if raw.get(key) is not None and not isinstance(raw[key], dict):
                raise ValueError(f'{key} must be an object or null')
        for container in (raw.get('details') or {}, raw.get('route') or {}):
            for key in ('samples', 'baselineSamples'):
                if key in container and (not isinstance(container[key], list) or any(not isinstance(x, dict) for x in container[key])):
                    raise ValueError(f'{key} must contain observation objects')
        return raw


class Batch(Strict):
    records: list[Incoming] = Field(min_length=1, max_length=50)


def owned(db, session_id, a, lock=False):
    statement = select(ResearchSession).where(ResearchSession.id == session_id)
    if lock:
        statement = statement.with_for_update()
    value = db.scalar(statement)
    if not value or value.owner_id != a.user_id:
        raise HTTPException(404, 'Session not found')
    return value


@router.put('/sessions/{session_id}/manifest')
def manifest(session_id: str, body: Manifest, a=Depends(account), db: Session = Depends(database)):
    if a.consent_version != CONSENT_VERSION:
        raise HTTPException(403, 'Current research consent required')
    if body.session.get('id') != session_id or body.session.get('state') not in ('completed', 'interrupted'):
        raise HTTPException(422, 'Only a closed session can be uploaded')
    expected = [r.model_dump() for r in body.expected]
    keys = {(r.type, r.id) for r in body.expected}
    if len(keys) != len(expected) or ('session', session_id) not in keys:
        raise HTTPException(422, 'Manifest must contain unique record identifiers and its session')
    if sum(r.type == 'session' for r in body.expected) != 1:
        raise HTTPException(422, 'Exactly one session record required')
    raw = body.model_dump()
    existing = db.get(ResearchSession, session_id)
    if existing:
        owned(db, session_id, a)
        if existing.manifest != raw:
            raise HTTPException(409, 'Closed session manifest is immutable')
    else:
        db.add(ResearchSession(id=session_id, owner_id=a.user_id, participant_id=a.participant_id,
                              collected_at=str(body.session.get('startedAt', '')),
                              collector_version=body.collectorVersion, manifest=raw, raw=body.session))
        db.commit()
    return {'registered': True}


@router.post('/sessions/{session_id}/records')
def ingest(session_id: str, body: Batch, a=Depends(account), db: Session = Depends(database)):
    s = owned(db, session_id, a, lock=True)
    expected = {(r['type'], r['id']): r['version'] for r in s.manifest['expected']}
    seen = set()
    for item in body.records:
        key = (item.type, item.id)
        if key in seen or expected.get(key) != item.version:
            raise HTTPException(409, 'Record does not match registered manifest')
        seen.add(key)
        if item.payload.get('id') != item.id:
            raise HTTPException(422, 'Payload identifier mismatch')
        if item.type != 'session' and item.payload.get('sessionId') != session_id:
            raise HTTPException(422, 'Payload belongs to another session')
        if item.type == 'session' and item.payload != s.raw:
            raise HTTPException(409, 'Session differs from manifest')
        old = db.get(Record, (session_id, item.type, item.id))
        if old:
            if old.version != item.version or old.raw != item.payload:
                raise HTTPException(409, 'Conflicting record version')
            continue
        if s.completed_at:
            raise HTTPException(409, 'Completed session is immutable')
        raw = item.payload
        context = raw.get('networkSnapshot') if isinstance(raw.get('networkSnapshot'), dict) else raw if item.type == 'snapshot' else {}
        provenance = raw.get('raw') if isinstance(raw.get('raw'), dict) else {}
        db.add(Record(session_id=session_id, kind=item.type, id=item.id, version=item.version,
                      timestamp=string(raw.get('timestamp'), 40), protocol=string(raw.get('type'), 50) if item.type == 'measurement' else None,
                      network_type=string(context.get('type'), 40), method=string(raw.get('method'), 150),
                      library=string(provenance.get('library')), library_version=string(provenance.get('version')),
                      value=number(raw.get('value')), unit=string(raw.get('unit'), 30), event_kind=string(raw.get('kind')) if item.type == 'event' else None,
                      success=raw.get('success') if isinstance(raw.get('success'), bool) else None, raw=raw))
        if item.type == 'measurement':
            for ordinal, (phase, sample) in enumerate(samples(raw)):
                db.add(Sample(session_id=session_id, measurement_id=item.id, ordinal=ordinal, phase=phase, raw=sample, sequence=integer(sample.get('sequence')), hop=integer(sample.get('hop')), rtt_ms=number(sample.get('rttMs')), outcome=string(sample.get('kind') or sample.get('errorType') or ('reply' if sample.get('rttMs') is not None else None))))
    db.commit()
    return {'acknowledged': [r.model_dump(exclude={'payload'}) for r in body.records]}


@router.post('/sessions/{session_id}/complete')
def complete(session_id: str, a=Depends(account), db: Session = Depends(database)):
    s = owned(db, session_id, a, lock=True)
    saved = {(r.kind, r.id, r.version) for r in db.scalars(select(Record).where(Record.session_id == session_id))}
    missing = [r for r in s.manifest['expected'] if (r['type'], r['id'], r['version']) not in saved]
    if not missing:
        s.completed_at = s.completed_at or now()
        db.commit()
    return {'complete': not missing, 'missing': missing}


def summary(db, s):
    received, measurements, failures = db.execute(select(
        func.count(), func.sum(case((Record.kind == 'measurement', 1), else_=0)),
        func.sum(case(((Record.kind == 'measurement') & Record.success.is_(False), 1), else_=0))
    ).where(Record.session_id == s.id)).one()
    return {'id': s.id, 'participantId': s.participant_id, 'collectedAt': s.collected_at,
            'receivedAt': s.received_at, 'completedAt': s.completed_at,
            'collectorVersion': s.collector_version, 'configuration': s.raw.get('config', {}),
            'measurements': measurements or 0, 'failures': failures or 0,
            'receivedRecords': received, 'expectedRecords': len(s.manifest['expected']),
            'uploadStatus': 'Uploaded' if s.completed_at else 'Uploading'}


@router.get('/sessions')
def own_sessions(a=Depends(account), db: Session = Depends(database), offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100)):
    values = db.scalars(select(ResearchSession).where(ResearchSession.owner_id == a.user_id).order_by(ResearchSession.collected_at.desc()).offset(offset).limit(limit))
    return {'items': [summary(db, s) for s in values]}


def query_sessions(participant=None, protocol=None, outcome=None, q=None, since=None, until=None, collector=None, context=None):
    query = select(ResearchSession)
    if participant:
        query = query.where(ResearchSession.participant_id == participant)
    if q:
        query = query.where(or_(ResearchSession.id.contains(q), ResearchSession.participant_id.contains(q), ResearchSession.collector_version.contains(q)))
    if since:
        query = query.where(ResearchSession.collected_at >= since)
    if until:
        query = query.where(ResearchSession.collected_at <= (until + 'T23:59:59.999999Z' if len(until) == 10 else until))
    if collector:
        query = query.where(ResearchSession.collector_version == collector)
    if protocol or outcome or context:
        records = select(Record.session_id).where(Record.kind == 'measurement')
        if context:
            records = records.where(Record.network_type == context)
        if protocol:
            records = records.where(Record.protocol == protocol)
        if outcome:
            records = records.where(Record.success == (outcome == 'success'))
        query = query.where(ResearchSession.id.in_(records))
    return query.order_by(ResearchSession.received_at.desc())


@router.get('/research/sessions')
def research_sessions(a=Depends(researcher), db: Session = Depends(database), offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100), participant: str | None = None, protocol: str | None = None, outcome: Literal['success', 'failure'] | None = None, q: str | None = None, since: str | None = None, until: str | None = None, collector: str | None = None, context: str | None = None, format: Literal['json', 'csv'] = 'json'):
    query = query_sessions(participant, protocol, outcome, q, since, until, collector, context)
    count = db.scalar(select(func.count()).select_from(query.subquery()))
    if format == 'csv':
        if count > 10000:
            raise HTTPException(422, 'Narrow filters to at most 10000 sessions')
        rows = [summary(db, s) for s in db.scalars(query)]
        return Response(csv_text({k: v for k, v in row.items() if k != 'configuration'} for row in rows), media_type='text/csv', headers={'Content-Disposition': 'attachment; filename="sessions.csv"'})
    return {'total': count, 'items': [summary(db, s) for s in db.scalars(query.offset(offset).limit(limit))]}


@router.get('/research/overview')
def overview(a=Depends(researcher), db: Session = Depends(database)):
    return {'participants': db.scalar(select(func.count(func.distinct(ResearchSession.participant_id)))),
            'sessions': db.scalar(select(func.count()).select_from(ResearchSession)),
            'partialSessions': db.scalar(select(func.count()).select_from(ResearchSession).where(ResearchSession.completed_at.is_(None))),
            'measurements': db.scalar(select(func.count()).select_from(Record).where(Record.kind == 'measurement')),
            'failures': db.scalar(select(func.count()).select_from(Record).where(Record.kind == 'measurement', Record.success.is_(False)))}


@router.get('/research/sessions/{session_id}')
def detail(session_id: str, format: Literal['json', 'csv'] = 'json', a=Depends(researcher), db: Session = Depends(database)):
    s = db.get(ResearchSession, session_id)
    if not s:
        raise HTTPException(404, 'Session not found')
    records = list(db.scalars(select(Record).where(Record.session_id == session_id).order_by(Record.timestamp, Record.id)))
    data = {'schemaVersion': s.manifest['schemaVersion'], 'session': s.raw,
            'measurements': [r.raw for r in records if r.kind == 'measurement'],
            'events': [r.raw for r in records if r.kind == 'event'],
            'snapshots': [r.raw for r in records if r.kind == 'snapshot'], 'receipt': summary(db, s)}
    if format == 'csv':
        return Response(csv_text(combined_rows(data)), media_type='text/csv', headers={'Content-Disposition': f'attachment; filename="{session_id}-combined.csv"'})
    return data


@router.get('/research/participants')
def participants(a=Depends(researcher), db: Session = Depends(database)):
    return {'items': [{'participantId': pid, 'sessions': count, 'latestCollection': latest} for pid, count, latest in db.execute(select(ResearchSession.participant_id, func.count(), func.max(ResearchSession.collected_at)).group_by(ResearchSession.participant_id))]}


class Membership(Strict):
    role: Literal['participant', 'researcher', 'administrator']


@router.get('/admin/members')
def members(a=Depends(administrator), db: Session = Depends(database)):
    return {'items': [{'participantId': x.participant_id, 'role': x.role} for x in db.scalars(select(Account).where(Account.deleted.is_(False)))]}


@router.put('/admin/members/{participant_id}')
def membership(participant_id: str, body: Membership, a=Depends(administrator), db: Session = Depends(database)):
    member = db.scalar(select(Account).where(Account.participant_id == participant_id, Account.deleted.is_(False)))
    if not member:
        raise HTTPException(404, 'Participant not found')
    if member.user_id == a.user_id:
        raise HTTPException(409, 'Administrators cannot change their own access')
    member.role = body.role
    db.commit()
    return {'participantId': participant_id, 'role': member.role}
