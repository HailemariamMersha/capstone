"""Queryable research evidence, independent of authentication identity."""
import os
from functools import lru_cache
from datetime import datetime, timezone
from sqlalchemy import create_engine, String, JSON, Integer, Boolean, ForeignKey, Float, BigInteger, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def now():
    return datetime.now(timezone.utc).isoformat()


class Base(DeclarativeBase):
    pass


json_type = JSON().with_variant(JSONB(), 'postgresql')


class Account(Base):
    __tablename__ = 'sky_accounts'
    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    participant_id: Mapped[str] = mapped_column(String(32), unique=True)
    role: Mapped[str] = mapped_column(String(20), default='participant')
    consent_version: Mapped[str | None] = mapped_column(String(80))
    consent_at: Mapped[str | None] = mapped_column(String(40))
    mobile_uploads: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)


class ResearchSession(Base):
    __tablename__ = 'sky_sessions'
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey('sky_accounts.user_id'), index=True)
    participant_id: Mapped[str] = mapped_column(String(32), index=True)
    collected_at: Mapped[str] = mapped_column(String(40), index=True)
    received_at: Mapped[str] = mapped_column(String(40), default=now, index=True)
    completed_at: Mapped[str | None] = mapped_column(String(40))
    collector_version: Mapped[str] = mapped_column(String(100), index=True)
    manifest: Mapped[dict] = mapped_column(json_type)
    raw: Mapped[dict] = mapped_column(json_type)


class Record(Base):
    __tablename__ = 'sky_records'
    session_id: Mapped[str] = mapped_column(ForeignKey('sky_sessions.id'), primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), primary_key=True)
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    timestamp: Mapped[str | None] = mapped_column(String(40), index=True)
    protocol: Mapped[str | None] = mapped_column(String(50), index=True)
    network_type: Mapped[str | None] = mapped_column(String(40), index=True)
    method: Mapped[str | None] = mapped_column(String(150), index=True)
    library: Mapped[str | None] = mapped_column(String(100))
    library_version: Mapped[str | None] = mapped_column(String(100))
    value: Mapped[float | None] = mapped_column(Float)
    unit: Mapped[str | None] = mapped_column(String(30))
    event_kind: Mapped[str | None] = mapped_column(String(100), index=True)
    success: Mapped[bool | None] = mapped_column(Boolean, index=True)
    raw: Mapped[dict] = mapped_column(json_type)
    received_at: Mapped[str] = mapped_column(String(40), default=now)


class Sample(Base):
    __tablename__ = 'sky_samples'
    session_id: Mapped[str] = mapped_column(ForeignKey('sky_sessions.id'), primary_key=True)
    measurement_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, primary_key=True)
    phase: Mapped[str] = mapped_column(String(30))
    sequence: Mapped[int | None] = mapped_column(Integer)
    hop: Mapped[int | None] = mapped_column(Integer)
    rtt_ms: Mapped[float | None] = mapped_column(Float)
    outcome: Mapped[str | None] = mapped_column(String(100), index=True)
    raw: Mapped[dict] = mapped_column(json_type)


@lru_cache(maxsize=4)
def engine_for(url):
    value = create_engine(url, pool_pre_ping=True)
    from .timing import metrics
    import time
    @event.listens_for(value, 'before_cursor_execute')
    def before(_conn, _cursor, _sql, _params, context, _many):
        context.research_started = time.perf_counter() if metrics.get() is not None else None
    @event.listens_for(value, 'after_cursor_execute')
    def after(_conn, _cursor, _sql, _params, context, _many):
        data = metrics.get()
        if data is not None and context.research_started is not None:
            data['dbSql'] = data.get('dbSql', 0) + (time.perf_counter() - context.research_started) * 1000
    return value


def engine():
    url = os.environ.get('DATABASE_URL')
    if not url:
        raise RuntimeError('DATABASE_URL is required for authenticated research services')
    return engine_for(url)


def database():
    with sessionmaker(bind=engine(), expire_on_commit=False)() as db:
        yield db


class ResearchTrip(Base):
    __tablename__ = 'sky_trips'
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey('sky_accounts.user_id'), index=True)
    participant_id: Mapped[str] = mapped_column(String(32), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    raw: Mapped[dict] = mapped_column(json_type)
    received_at: Mapped[str] = mapped_column(String(40), default=now, index=True)


class TripSegment(Base):
    __tablename__ = 'sky_trip_segments'
    trip_id: Mapped[str] = mapped_column(ForeignKey('sky_trips.id'), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey('sky_sessions.id'), unique=True)


class TripPayment(Base):
    """Restricted payment mapping; never joined into research evidence/exports."""
    __tablename__ = 'sky_trip_payments'
    trip_id: Mapped[str] = mapped_column(ForeignKey('sky_trips.id'), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey('sky_accounts.user_id'), index=True)
    netid: Mapped[str] = mapped_column(String(32))
    received_at: Mapped[str] = mapped_column(String(40), default=now)


class ReadRevision(Base):
    __tablename__ = 'sky_read_revisions'
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, default=1)


class ViewCache(Base):
    __tablename__ = 'sky_view_cache'
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    computed_at: Mapped[float] = mapped_column(Float)
    payload: Mapped[dict] = mapped_column(json_type)


class HistoryReset(Base):
    __tablename__ = 'sky_history_resets'
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    cutoff_ms: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    archive_sha256: Mapped[str] = mapped_column(String(64))
    maintenance: Mapped[bool] = mapped_column(Boolean, default=False)
    applied: Mapped[bool] = mapped_column(Boolean, default=False)


class RemovedObject(Base):
    __tablename__ = 'sky_removed_objects'
    kind: Mapped[str] = mapped_column(String(20), primary_key=True)
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(64), index=True)
    reset_id: Mapped[str] = mapped_column(String(32))
