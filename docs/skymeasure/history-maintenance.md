# Protected staging history maintenance

This is an operator procedure for an explicitly authorized staging reset, not a
retention policy or public API. It removes measurement history while preserving
accounts, consent, roles, upload preferences and installation credentials. It
must not be used on real participant evidence without a separately agreed scope.

## Database migration

Apply [004_trip_workspace.sql](../../backend/migrations/004_trip_workspace.sql)
with the table-owning database administrator connection. The existing staging
schema is **skymeasure**, not public. The four new private tables have RLS enabled,
no browser grants and an explicit server-role policy. Verify SELECT/INSERT/UPDATE/
DELETE as `skymeasure_api` inside a transaction that is rolled back. Checking only
SELECT privileges is insufficient to establish that RLS allows writes. Do not
transfer database administrator credentials to the shared lab server.

## Cloud archive and reset

Use the configured SkyMeasure service environment without printing or copying its
credentials. The maintenance CLI is `python -m backend.research.cleanup`:

1. Record `inventory`. Run `start`, save its reset ID and cutoff, and stop/drain
   pre-existing evidence writes by restarting only the isolated SkyMeasure API.
   New evidence writes receive 503 with Retry-After; account/research reads remain
   available. Do not restart UDP or unrelated applications.
2. Run `backup --reset ID --archive /protected/directory/history.jsonl.gz`.
   Never overwrite an archive. The evidence archive, separate
   `history.payments.jsonl.gz` and `history.jsonl.manifest.json` use protected
   directories/files. No tokens, passwords or service-role keys are archived.
3. Run `verify --archive ...`. Verification checks SHA-256, gzip integrity,
   counts, canonical full-row hashes, IDs and versions. It fully restores both
   archives to a disposable SQLite database with foreign keys enabled, then
   re-reads and compares every row. Keep a verified protected second copy off the
   server, including the separate payment mapping and manifest.
4. Only then run `apply --reset ID --archive ...`. It requires the frozen
   inventory and identity digest to match the archive. It records removed trip/
   session tombstones, deletes research evidence/payment mappings/read caches
   transactionally and verifies zero history plus unchanged identity metadata.
   Repeating an applied reset is a no-op and cannot erase later trips.
5. Verify normal service health and authentication. Old owned manifests/record
   writes return 410 DATA_REMOVED instead of recreating history. Older unregistered
   manifests are rejected by the cutoff too. New trips remain accepted.

`resume --reset ID` releases maintenance without deleting anything. After apply,
`restore --reset ID --archive ...` can restore original history only into an empty
research database; it refuses to overwrite any new evidence. For investigation,
prefer restoring to an isolated database. Preserve existing independent archives.
Never commit a private archive or payment mapping.

## Connected phone

The explicitly opted-in Android `HistoryMaintenanceTest` works on a stopped
SkyMeasure installation. Update in place, never uninstall or clear app data.

Backup uses VACUUM INTO, integrity checks and complete logical inventory comparison.
It removes NetIDs from the backup copy into a separate payment JSON file. A
loopback socket forwarded over USB can transfer the three private files directly
to protected host storage; no world-readable phone backup is needed. Independently
verify both hashes, restore the payment rows into a disposable copy, and compare
all table counts and logical hashes. A failed or changing backup never authorizes
cleanup; create and verify a fresh archive instead.

The clear operation requires explicit `archiveVerified=true`, the expected backup
SHA-256 and an unchanged source inventory. It deletes only trips, local sessions,
measurements/context/events/debug logs/payment mappings and their sync queue. It
preserves device/settings data, Keychain identity, consent and the native M-Lab
quota ledger. A reset marker clears obsolete upload cursor/backoff metadata at
startup. Delete only the newly created phone backup files after the protected
host copy is verified; do not delete older independent archives.

Other installations may still contain historical local evidence. On receiving
410 DATA_REMOVED, the updated app retires it from ordinary history and automatic
upload without changing ownership or deleting its local exportable copy. Install
the updated APK on those phones; a server reset cannot directly erase their disks.

Finally run a short Start/Stop check before M-Lab's deadline, verify its new trip
and reconciliation, and leave collection stopped. This is a storage/upload check,
not a network accuracy, flight detection or endurance validation.
