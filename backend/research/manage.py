"""python -m backend.research.manage migrate | admin SUPABASE_USER_ID | delete-identities"""
import os
import sys
from uuid import uuid4
import httpx
from sqlalchemy import text, select
from sqlalchemy.orm import Session
from .database import Base, Account, engine


def main():
    command = sys.argv[1]
    db_engine = engine()
    if command == 'migrate':
        Base.metadata.create_all(db_engine)
        if db_engine.dialect.name == 'postgresql':
            # Browser Supabase roles have no direct data access. FastAPI uses a
            # dedicated server database identity, and applies ownership itself.
            with db_engine.begin() as connection:
                for table in Base.metadata.sorted_tables:
                    connection.execute(text(f'ALTER TABLE {table.name} ENABLE ROW LEVEL SECURITY'))
                    connection.execute(text(f'REVOKE ALL ON {table.name} FROM anon, authenticated'))
        print('Research schema created without modifying legacy experiments.')
    elif command == 'admin':
        with Session(db_engine) as db:
            user_id = str(__import__('uuid').UUID(sys.argv[2]))
            a = db.get(Account, user_id)
            if not a:
                a = Account(user_id=user_id, participant_id=uuid4().hex)
                db.add(a)
            if a.deleted:
                raise ValueError('Deleted accounts cannot be administrators')
            a.role = 'administrator'
            db.commit()
        print('Administrator assigned.')
    elif command == 'delete-identities':
        with Session(db_engine) as db:
            for a in db.scalars(select(Account).where(Account.deleted.is_(True))):
                response = httpx.delete(os.environ['SUPABASE_URL'].rstrip('/') + '/auth/v1/admin/users/' + a.user_id,
                                        headers={'Authorization': 'Bearer ' + os.environ['SUPABASE_SERVICE_ROLE_KEY'],
                                                 'apikey': os.environ['SUPABASE_SERVICE_ROLE_KEY']}, timeout=20)
                if response.status_code not in (200, 404):
                    raise RuntimeError('Identity deletion failed; retry the management command')
        print('Deleted identities processed; minimal upload-blocking tombstones retained.')
    else:
        raise ValueError('Unknown management command')


if __name__ == '__main__':
    main()
