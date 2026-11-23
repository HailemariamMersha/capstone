"""Derived outcomes v1; immutable original evidence is never rewritten."""
from sqlalchemy import and_, func
from .database import Record


def outcome(value):
    if value.get('success') is True:
        return 'success'
    if value.get('success') is not False:
        return 'unavailable'
    return 'interrupted' if value.get('errorType') in ('cancelled', 'interrupted') else 'failure'


def interrupted():
    return and_(Record.success.is_(False), func.coalesce(Record.raw['errorType'].as_string(), '').in_(['cancelled', 'interrupted']))


def failed():
    return and_(Record.success.is_(False), func.coalesce(Record.raw['errorType'].as_string(), '').not_in(['cancelled', 'interrupted']))
