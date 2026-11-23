"""Private, revisioned read models. Ingestion invalidates only affected trip views."""
import time
from functools import lru_cache
from threading import RLock
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select, update
from .database import ReadRevision, ViewCache


def invalidate(db, trip_id=None):
    keys = ['research'] + ([f'trip:{trip_id}'] if trip_id else [])
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert
    insert = pg_insert if db.bind.dialect.name == 'postgresql' else sqlite_insert
    statement = insert(ReadRevision).values([{'key':key,'version':1} for key in keys])
    db.execute(statement.on_conflict_do_update(index_elements=['key'],set_={'version':ReadRevision.version+1}))


@lru_cache(maxsize=512)
def _lock(key):
    return RLock()


def cached(db, key, revision_key, calculate, lifetime=60):
    with _lock(key):
        return _cached(db, key, revision_key, calculate, lifetime)


def _cached(db, key, revision_key, calculate, lifetime):
    version = db.scalar(select(ReadRevision.version).where(ReadRevision.key == revision_key)) or 0
    entry = db.get(ViewCache, key)
    if entry and entry.version == version and time.time() - entry.computed_at < lifetime:
        return {**entry.payload, 'computedAt': entry.computed_at, 'dataRevision': version}
    payload = calculate()
    at = time.time()
    # A concurrent ingest may advance the revision: this old stamp will then miss
    # on the next read instead of falsely declaring the new evidence cached.
    if entry:
        entry.version, entry.computed_at, entry.payload = version, at, payload
    else:
        db.add(ViewCache(key=key, version=version, computed_at=at, payload=payload))
    try:
        db.commit()
    except IntegrityError:
        # Another API worker may have filled the same cache first.
        db.rollback()
    return {**payload, 'computedAt': at, 'dataRevision': version}
