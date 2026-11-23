"""Explicit operator-only history maintenance. Never deletes identities or credentials.

python -m backend.research.cleanup start|inventory|backup|verify|apply|restore|resume
Archives are private JSONL/gzip, streamed in bounded pages. Apply requires a
verified archive and an ingestion maintenance gate. No HTTP deletion endpoint.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from uuid import uuid4
from sqlalchemy import select, func, delete, create_engine, event
from sqlalchemy.orm import Session
from .database import (Base, Account, ResearchTrip, ResearchSession, TripSegment,
                       TripPayment, Record, Sample, ViewCache, ReadRevision,
                       HistoryReset, RemovedObject, engine)

TABLES=[ResearchTrip,ResearchSession,TripSegment,TripPayment,Record,Sample]
MODELS={m.__tablename__:m for m in TABLES}
DELETE_ORDER=[Sample,Record,TripPayment,TripSegment,ResearchSession,ResearchTrip]


def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)


def payment_path(path):
    return path.with_name(path.name.removesuffix('.jsonl.gz')+'.payments.jsonl.gz')


def digest_file(path):
    digest=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()


def identity_digest(db):
    rows=db.execute(select(Account.user_id,Account.participant_id,Account.role,Account.consent_version,Account.consent_at,Account.mobile_uploads,Account.deleted).order_by(Account.user_id)).all()
    return hashlib.sha256(canonical([list(r) for r in rows]).encode()).hexdigest()


def inventory(db):
    return {'tables':{m.__tablename__:db.scalar(select(func.count()).select_from(m)) for m in TABLES},'identityDigest':identity_digest(db)}


def private_parent(path):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(path.parent,0o700)


def backup(db,reset,path):
    if not reset.maintenance or reset.applied:raise ValueError('Backup requires an unapplied maintenance gate')
    if path.exists() or payment_path(path).exists() or path.with_suffix('.manifest.json').exists():raise ValueError('Archive already exists; do not overwrite')
    private_parent(path)
    manifest={'version':2,'resetId':reset.id,'cutoffMs':reset.cutoff_ms,**inventory(db),'digests':{}}
    try:
        with gzip.open(path,'xt',encoding='utf-8') as archive, gzip.open(payment_path(path),'xt',encoding='utf-8') as payments:
            header=canonical({'header':{k:v for k,v in manifest.items() if k!='digests'}})+'\n'
            archive.write(header);payments.write(header)
            for model in TABLES:
                count=0;digest=hashlib.sha256()
                statement=select(model).order_by(*model.__table__.primary_key.columns)
                for obj in db.scalars(statement.execution_options(yield_per=500)):
                    row={c.name:getattr(obj,c.name) for c in model.__table__.columns}
                    line=canonical({'table':model.__tablename__,'row':row})+'\n'
                    (payments if model is TripPayment else archive).write(line);digest.update(line.encode());count+=1
                if count!=manifest['tables'][model.__tablename__]:raise ValueError('Evidence changed during archive')
                manifest['digests'][model.__tablename__]=digest.hexdigest()
        os.chmod(path,0o600);os.chmod(payment_path(path),0o600)
        manifest['archiveSha256']=digest_file(path)
        manifest['paymentArchiveSha256']=digest_file(payment_path(path))
        marker=path.with_suffix('.manifest.json')
        marker.write_text(json.dumps(manifest,indent=2)+'\n');os.chmod(marker,0o600)
        return manifest
    except Exception:
        path.unlink(missing_ok=True);payment_path(path).unlink(missing_ok=True)
        raise


def load_manifest(path):
    manifest=json.loads(path.with_suffix('.manifest.json').read_text())
    if manifest.get('version')!=2 or manifest.get('archiveSha256')!=digest_file(path) or manifest.get('paymentArchiveSha256')!=digest_file(payment_path(path)):raise ValueError('Archive checksum mismatch')
    return manifest


def import_rows(db,path,stub_accounts=False):
    owners=set()
    for source_path in (path,payment_path(path)):
        with gzip.open(source_path,'rt',encoding='utf-8') as source:
            header=json.loads(next(source))
            if 'header' not in header:raise ValueError('Missing archive header')
            batches={}
            def flush(name):
                rows=batches.get(name,[])
                if rows:db.execute(MODELS[name].__table__.insert(),rows);batches[name]=[]
            previous=None
            for line in source:
                item=json.loads(line);name=item['table'];row=item['row']
                if name not in MODELS or set(row)!={c.name for c in MODELS[name].__table__.columns}:raise ValueError('Invalid archive row')
                if previous is not None and name!=previous:flush(previous)
                if stub_accounts and 'owner_id' in row and row['owner_id'] not in owners:
                    owner=row['owner_id'];owners.add(owner)
                    db.execute(Account.__table__.insert(),{'user_id':owner,'participant_id':hashlib.sha256(owner.encode()).hexdigest()[:32],
                        'role':'participant','mobile_uploads':False,'deleted':False})
                batches.setdefault(name,[]).append(row)
                if len(batches[name])>=500:flush(name)
                previous=name
            for name in batches:flush(name)


def verify(path):
    manifest=load_manifest(path)
    # Hash every decoded record and fully restore with foreign-key enforcement.
    counts={name:0 for name in MODELS};digests={name:hashlib.sha256() for name in MODELS}
    for source_path in (path,payment_path(path)):
        with gzip.open(source_path,'rt',encoding='utf-8') as source:
            header=json.loads(next(source))['header']
            if header['resetId']!=manifest['resetId'] or header['tables']!=manifest['tables']:raise ValueError('Archive header mismatch')
            for line in source:
                item=json.loads(line);name=item['table']
                if name not in MODELS:raise ValueError('Unexpected table')
                if (name=='sky_trip_payments')!=(source_path==payment_path(path)):raise ValueError('Payment data must stay separate')
                counts[name]+=1;digests[name].update(line.encode())
    if counts!=manifest['tables'] or {k:v.hexdigest() for k,v in digests.items()}!=manifest['digests']:raise ValueError('Archive record hash/count mismatch')
    with tempfile.TemporaryDirectory(prefix='restore-check-',dir=path.parent) as temp:
        restored=create_engine('sqlite:///'+str(Path(temp)/'check.sqlite'))
        @event.listens_for(restored,'connect')
        def foreign_keys(conn,_):conn.execute('PRAGMA foreign_keys=ON')
        Base.metadata.create_all(restored)
        with Session(restored) as db:
            import_rows(db,path,stub_accounts=True);db.commit()
            if inventory(db)['tables']!=manifest['tables']:raise ValueError('Restored row counts differ')
            # Re-read canonical rows, preserving IDs, versions and complete JSON.
            for model in TABLES:
                digest=hashlib.sha256()
                for obj in db.scalars(select(model).order_by(*model.__table__.primary_key.columns).execution_options(yield_per=500)):
                    digest.update((canonical({'table':model.__tablename__,'row':{c.name:getattr(obj,c.name) for c in model.__table__.columns}})+'\n').encode())
                if digest.hexdigest()!=manifest['digests'][model.__tablename__]:raise ValueError('Restored evidence differs')
        restored.dispose()
    return manifest


def apply(db,reset,path):
    manifest=verify(path)
    if reset.id!=manifest['resetId']:raise ValueError('Archive/reset mismatch')
    if reset.applied:
        return {'alreadyApplied':True,**inventory(db)}
    if not reset.maintenance:raise ValueError('Maintenance must be enabled')
    current=inventory(db)
    if current['tables']!=manifest['tables'] or current['identityDigest']!=manifest['identityDigest']:raise ValueError('Inventory changed; make a fresh backup')
    # A verified immutable manifest is the deletion scope. No accounts are removed.
    for kind,model in [('trip',ResearchTrip),('session',ResearchSession)]:
        for identifier,owner in db.execute(select(model.id,model.owner_id)):
            db.merge(RemovedObject(kind=kind,id=identifier,owner_id=owner,reset_id=reset.id))
    db.flush()
    db.execute(delete(ViewCache));db.execute(delete(ReadRevision))
    for model in DELETE_ORDER:db.execute(delete(model))
    reset.applied=True;reset.maintenance=False;reset.archive_sha256=manifest['archiveSha256']
    db.flush()
    after=inventory(db)
    if any(after['tables'].values()) or after['identityDigest']!=manifest['identityDigest']:raise ValueError('Cleanup verification failed')
    db.commit()
    return {'resetId':reset.id,'applied':True,**after}


def restore(db,reset,path):
    manifest=verify(path)
    if reset.id!=manifest['resetId'] or not reset.applied:raise ValueError('Restore requires its applied reset')
    # Restore is deliberately explicit and refuses to overwrite any new evidence.
    if any(inventory(db)['tables'].values()):raise ValueError('Restore into a separate database or clear new history first')
    before=identity_digest(db)
    import_rows(db,path)
    db.execute(delete(RemovedObject).where(RemovedObject.reset_id==reset.id))
    reset.applied=False;reset.maintenance=False
    db.flush()
    if inventory(db)['tables']!=manifest['tables'] or identity_digest(db)!=before:raise ValueError('Restore verification failed')
    db.commit()
    return {'restored':True,**inventory(db)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=['start','inventory','backup','verify','apply','restore','resume'])
    parser.add_argument('--reset');parser.add_argument('--archive',type=Path)
    args=parser.parse_args();os.umask(0o077)
    if args.operation=='verify':
        result=verify(args.archive);print(json.dumps({'verified':True,'tables':result['tables'],'archiveSha256':result['archiveSha256']}));return
    with Session(engine()) as db:
        if args.operation=='inventory':print(json.dumps(inventory(db)));return
        if args.operation=='start':
            if db.scalar(select(HistoryReset.id).where(HistoryReset.maintenance.is_(True))):raise ValueError('Maintenance already enabled')
            reset=HistoryReset(id=uuid4().hex,cutoff_ms=int(time.time()*1000),archive_sha256='0'*64,maintenance=True,applied=False)
            db.add(reset);db.commit();print(json.dumps({'resetId':reset.id,'cutoffMs':reset.cutoff_ms,'maintenance':True}));return
        reset=db.get(HistoryReset,args.reset)
        if not reset:raise ValueError('Unknown reset')
        if args.operation=='resume':
            reset.maintenance=False;db.commit();print(json.dumps({'maintenance':False}));return
        if not args.archive:raise ValueError('--archive required')
        result={'backup':backup,'apply':apply,'restore':restore}[args.operation](db,reset,args.archive)
        print(json.dumps({k:v for k,v in result.items() if k not in ('digests','identityDigest')}))

if __name__=='__main__':main()
