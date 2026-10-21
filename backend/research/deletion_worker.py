"""Retry Supabase identity deletion after the API has removed research evidence."""
import sys
import time
from .manage import main

if __name__ == '__main__':
    sys.argv = ['manage', 'delete-identities']
    while True:
        try:
            main()
        except Exception:
            # Never log database URLs, auth headers, account identity, or payloads.
            print('Identity deletion deferred; will retry in five minutes.', flush=True)
        time.sleep(300)
