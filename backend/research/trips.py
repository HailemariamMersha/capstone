"""A trip is a collection envelope, not a claim that a phone is currently online."""
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from .database import ResearchTrip, TripSegment, ResearchSession, database, now
from .auth import account, researcher

router = APIRouter()

class Flight(BaseModel):
    model_config = ConfigDict(extra='forbid')
    flightNumber: str | None = Field(None, max_length=120)
    departure: str | None = Field(None, max_length=120)
    arrival: str | None = Field(None, max_length=120)
    expectedMinutes: float | None = Field(None, ge=1, le=1440)

class Budget(BaseModel):
    model_config = ConfigDict(extra='forbid')
    transfers: int = Field(ge=0, le=260*1048576)
    diagnostics: int = Field(ge=0, le=20*1048576)
    uploads: int = Field(ge=0, le=20*1048576)

class TripUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int = Field(ge=1)
    state: Literal['active', 'completed', 'interrupted']
    phase: Literal['watching', 'collecting', 'paused', 'finished']
    startedAt: int = Field(ge=0)
    endedAt: int | None = None
    firstQualifiedAt: int | None = None
    segmentCount: int = Field(ge=0, le=10000)
    flight: Flight
    used: Budget
    confidence: Literal['unconfirmed', 'asn_matched', 'network_only', 'gps_supported']
    provider: str | None = Field(None, max_length=100)
    reason: str | None = Field(None, max_length=300)
    policyVersion: str = Field(max_length=100)
    shadow: bool = False
    detectorPolicyVersion: str | None = Field(None, max_length=80)

@router.put('/trips/{trip_id}')
def update_trip(trip_id: str, body: TripUpdate, a=Depends(account), db: Session=Depends(database)):
    from .api import CONSENT_VERSION
    if a.consent_version != CONSENT_VERSION:
        raise HTTPException(403, 'Current research consent required')
    if len(trip_id) != 32 or any(c not in '0123456789abcdef' for c in trip_id):
        raise HTTPException(422, 'Invalid trip identifier')
    if body.shadow and a.role not in ('researcher', 'administrator'):
        raise HTTPException(403, 'Researcher access required for shadow mode')
    if (body.state == 'active') != (body.phase != 'finished') or (body.state == 'active') != (body.endedAt is None):
        raise HTTPException(422, 'Inconsistent trip lifecycle')
    if body.endedAt is not None and body.endedAt < body.startedAt:
        raise HTTPException(422, 'Invalid trip interval')
    transfer_cap = (260 if body.policyVersion == 'flight-mlab-2026-11-02' else 60) * 1048576
    if body.used.transfers > transfer_cap:
        raise HTTPException(422, 'Transfer reservation exceeds versioned policy')
    raw = body.model_dump()
    # Preserve the exact legacy manifest shape for unchanged revision retries.
    if body.detectorPolicyVersion is None:
        raw.pop('detectorPolicyVersion', None)
    t = db.scalar(select(ResearchTrip).where(ResearchTrip.id == trip_id).with_for_update())
    if t:
        if t.owner_id != a.user_id: raise HTTPException(404, 'Trip not found')
        if body.revision < t.revision or (body.revision == t.revision and raw != t.raw):
            raise HTTPException(409, 'Trip revision conflict')
        if body.policyVersion != t.raw['policyVersion']:
            raise HTTPException(409, 'Trip policy cannot change')
        if body.detectorPolicyVersion != t.raw.get('detectorPolicyVersion'):
            raise HTTPException(409, 'Trip detector policy cannot change')
        if body.startedAt != t.raw['startedAt'] or body.segmentCount < t.raw['segmentCount']:
            raise HTTPException(409, 'Trip history cannot move backwards')
        if any(raw['used'][k] < t.raw['used'][k] for k in raw['used']):
            raise HTTPException(409, 'Budget counters cannot move backwards')
        if t.raw['state'] != 'active' and raw != t.raw:
            # Retried uploads can advance counters/revision, but never reopen or append segments.
            for key in ('state', 'phase', 'endedAt', 'segmentCount', 'flight'):
                if raw[key] != t.raw[key]: raise HTTPException(409, 'Closed trip cannot be changed')
        t.raw, t.revision, t.received_at = raw, body.revision, now()
    else:
        t = ResearchTrip(id=trip_id, owner_id=a.user_id, participant_id=a.participant_id, revision=body.revision, raw=raw)
        db.add(t)
    db.commit()
    return describe(db, t)

def describe(db, t, segments=None):
    if segments is None:
        segments = list(db.execute(select(TripSegment.ordinal, ResearchSession.id, ResearchSession.completed_at).join(ResearchSession, ResearchSession.id == TripSegment.session_id).where(TripSegment.trip_id == t.id).order_by(TripSegment.ordinal)))
    complete = {r.ordinal for r in segments if r.completed_at}
    missing = [i for i in range(t.raw['segmentCount']) if i not in complete]
    return {'id': t.id, 'participantId': t.participant_id, **t.raw, 'receivedAt': t.received_at,
            'uploadComplete': t.raw['state'] != 'active' and not missing,
            'missingSegments': missing,
            'segments': [{'index': r.ordinal, 'sessionId': r.id, 'uploaded': bool(r.completed_at)} for r in segments]}

def listing(db, owner, offset, limit, confidence=None, provider=None, include_summary=False):
    query = select(ResearchTrip)
    if owner: query = query.where(ResearchTrip.owner_id == owner)
    if confidence: query = query.where(ResearchTrip.raw['confidence'].as_string() == confidence)
    if provider: query = query.where(ResearchTrip.raw['provider'].as_string() == provider)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    trips = list(db.scalars(query.order_by(ResearchTrip.received_at.desc()).offset(offset).limit(limit)))
    # Fetch links for the page together, rather than one database round trip per card.
    segments = {t.id: [] for t in trips}
    if trips:
        for row in db.execute(select(TripSegment.trip_id, TripSegment.ordinal, ResearchSession.id, ResearchSession.completed_at)
            .join(ResearchSession, ResearchSession.id == TripSegment.session_id)
            .where(TripSegment.trip_id.in_(segments)).order_by(TripSegment.ordinal)):
            segments[row.trip_id].append(row)
    items = [describe(db, t, segments[t.id]) for t in trips]
    if include_summary:
        from .trip_summary import summaries
        values = summaries(db, [t.id for t in trips])
        for item in items:
            item['summary'] = values[item['id']]
    return {'total': total, 'items': items}

@router.get('/trips')
def own_trips(a=Depends(account), db: Session=Depends(database), offset: int=Query(0, ge=0), limit: int=Query(50, ge=1, le=100)):
    return listing(db, a.user_id, offset, limit)

@router.get('/research/trips')
def research_trips(a=Depends(researcher), db: Session=Depends(database), offset: int=Query(0, ge=0), limit: int=Query(50, ge=1, le=100), confidence: str | None=None, provider: str | None=None):
    return listing(db, None, offset, limit, confidence, provider, include_summary=True)
