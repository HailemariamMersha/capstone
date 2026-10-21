"""Supabase validates bearer tokens; user metadata never determines authorization."""
import os
from uuid import uuid4
import httpx
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from .database import Account, database

bearer = HTTPBearer(auto_error=False)


def identity(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
    if not credentials or credentials.scheme.lower() != 'bearer':
        raise HTTPException(401, 'Sign in required')
    url = os.environ.get('SUPABASE_URL', '').rstrip('/')
    key = os.environ.get('SUPABASE_PUBLISHABLE_KEY', '')
    if not url or not key:
        raise HTTPException(503, 'Authentication is not configured')
    try:
        result = httpx.get(f'{url}/auth/v1/user', headers={
            'Authorization': f'Bearer {credentials.credentials}', 'apikey': key,
        }, timeout=10)
        if result.status_code != 200:
            raise HTTPException(401 if result.status_code < 500 else 503, 'Sign in again before uploading')
        user = result.json()
        if not user.get('id'):
            raise HTTPException(401, 'Invalid account')
        return user['id']
    except httpx.RequestError:
        raise HTTPException(503, 'Authentication temporarily unavailable')


def account(user_id: str = Depends(identity), db: Session = Depends(database)):
    value = db.scalar(select(Account).where(Account.user_id == user_id).with_for_update())
    if not value:
        value = Account(user_id=user_id, participant_id=uuid4().hex, role='participant')
        db.add(value)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
        value = db.scalar(select(Account).where(Account.user_id == user_id).with_for_update())
    if value.deleted:
        raise HTTPException(403, 'Account deletion requested; uploads are disabled')
    return value


def researcher(value: Account = Depends(account)):
    if value.role not in ('researcher', 'administrator'):
        raise HTTPException(403, 'Researcher access required')
    return value


def administrator(value: Account = Depends(researcher)):
    if value.role != 'administrator':
        raise HTTPException(403, 'Administrator access required')
    return value
