"""Durable single-server ingestion prototype. Replace the SQLite adapter for a multi-server deployment."""
import hmac
import ipaddress
import json
import os
import sqlite3
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError

router = APIRouter()
MAX_BATCH_BYTES = 1024 * 1024


class Record(BaseModel):
    model_config = ConfigDict(extra='forbid')
    type: Literal['session', 'measurement', 'event', 'snapshot']
    id: str = Field(pattern=r'^[a-f0-9]{32}$')
    version: int = Field(ge=1, le=2147483647)
    payload: dict


class Batch(BaseModel):
    model_config = ConfigDict(extra='forbid')
    installationId: str = Field(pattern=r'^[a-f0-9]{32}$')
    records: list[Record] = Field(min_length=1, max_length=50)


def authorize(request: Request):
    expected = os.environ.get('CAPSTONE_SYNC_TOKEN', '')
    if expected:
        if not hmac.compare_digest(request.headers.get('authorization', ''), f'Bearer {expected}'):
            raise HTTPException(401, 'Invalid sync token')
    elif not request.client or request.client.host not in ('127.0.0.1', '::1', 'testclient'):
        raise HTTPException(503, 'Configure CAPSTONE_SYNC_TOKEN before accepting remote uploads')


@router.post('/api/v1/ingest')
async def ingest(request: Request):
    authorize(request)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BATCH_BYTES:
            raise HTTPException(413, 'Batch exceeds 1 MiB')
    try:
        batch = Batch.model_validate_json(bytes(body))
    except ValidationError:
        raise HTTPException(422, 'Invalid record batch')
    for record in batch.records:
        if record.payload.get('id') != record.id:
            raise HTTPException(422, 'Payload ID mismatch')
        if record.type == 'session' and record.payload.get('state') not in ('completed', 'interrupted'):
            raise HTTPException(422, 'Only closed sessions may be synchronized')
    path = Path(os.environ.get('CAPSTONE_INGEST_DB', 'backend/data/ingestion.sqlite'))
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=5)
    try:
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('PRAGMA synchronous=FULL')
        with connection:
            connection.execute('''CREATE TABLE IF NOT EXISTS records (
                installation_id TEXT NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL,
                version INTEGER NOT NULL, payload_json TEXT NOT NULL,
                received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(installation_id,type,id))''')
            for record in batch.records:
                try:
                    payload = json.dumps(record.payload, sort_keys=True, separators=(',', ':'), allow_nan=False)
                except ValueError:
                    raise HTTPException(422, 'Payload contains non-finite numbers')
                existing = connection.execute('SELECT version,payload_json FROM records WHERE installation_id=? AND type=? AND id=?', (batch.installationId, record.type, record.id)).fetchone()
                if existing and existing[0] == record.version and existing[1] != payload:
                    raise HTTPException(409, 'Conflicting payload for the same record version')
                connection.execute('''INSERT INTO records(installation_id,type,id,version,payload_json)
                    VALUES (?,?,?,?,?) ON CONFLICT(installation_id,type,id) DO UPDATE SET
                    version=excluded.version,payload_json=excluded.payload_json,received_at=CURRENT_TIMESTAMP
                    WHERE excluded.version > records.version''',
                    (batch.installationId, record.type, record.id, record.version, payload))
        # Acknowledgement is emitted only after the transaction commits.
        return {'acknowledged': [{'type': r.type, 'id': r.id, 'version': r.version} for r in batch.records]}
    finally:
        connection.close()


@router.get('/api/v1/context')
async def context(request: Request):
    address = request.client.host if request.client else None
    try:
        public_ip = address if ipaddress.ip_address(address).is_global else None
    except (ValueError, TypeError):
        public_ip = None
    asn = None
    database = os.environ.get('CAPSTONE_ASN_DB')
    if database and public_ip:
        try:
            import geoip2.database
            with geoip2.database.Reader(database) as reader:
                asn = reader.asn(public_ip).autonomous_system_number
        except Exception:  # ASN enrichment must never block measurements.
            asn = None
    from fastapi.responses import JSONResponse
    return JSONResponse({'publicIp': public_ip, 'asn': asn}, headers={'X-Capstone-Probe': '1', 'Cache-Control': 'no-store'})
