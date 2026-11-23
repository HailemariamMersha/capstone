"""Reset guards are independent of identity deletion and never revoke study access."""
from datetime import datetime
from fastapi import HTTPException
from sqlalchemy import select, func
from .database import HistoryReset, RemovedObject


def epoch_ms(value):
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, str):
        try:
            parsed=datetime.fromisoformat(value.replace('Z', '+00:00'))
            return int(parsed.timestamp()*1000) if parsed.tzinfo is not None else None
        except (ValueError, OverflowError):
            return None
    return None


_UNSET=object()

def guard(db, kind, identifier, owner, started_at=_UNSET):
    if db.scalar(select(HistoryReset.id).where(HistoryReset.maintenance.is_(True)).limit(1)):
        raise HTTPException(503, 'History maintenance; saved records will retry', headers={'Retry-After': '60'})
    removed = db.get(RemovedObject, (kind, identifier))
    if removed:
        if removed.owner_id != owner:
            raise HTTPException(404, 'Recording not found')
        raise HTTPException(410, {'code': 'DATA_REMOVED', 'message': 'This test was archived and removed from study history.'})
    cutoff = db.scalar(select(func.max(HistoryReset.cutoff_ms)).where(HistoryReset.applied.is_(True)))
    at = epoch_ms(started_at)
    if cutoff is not None and started_at is not _UNSET and at is None:
        raise HTTPException(422,'A valid timestamp with a timezone is required after the study reset')
    if cutoff is not None and at is not None and at <= cutoff:
        raise HTTPException(410, {'code': 'DATA_REMOVED', 'message': 'This recording predates the study history reset.'})
