"""Queryable research evidence, independent of authentication identity."""
import os
from functools import lru_cache
from datetime import datetime, timezone
from sqlalchemy import create_engine, String, JSON, Integer, Boolean, ForeignKey, Float
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
    return create_engine(url, pool_pre_ping=True)


def engine():
    url = os.environ.get('DATABASE_URL')
    if not url:
        raise RuntimeError('DATABASE_URL is required for authenticated research services')
    return engine_for(url)


def database():
    with sessionmaker(bind=engine(), expire_on_commit=False)() as db:
        yield db
