# Supabase database CA

`supabase-prod-ca-2021.crt` is a **public certificate**, not a private key or an application credential. The database client uses it with `sslmode=verify-full` to verify the pooler's certificate chain and hostname. Do not disable verification to resolve a missing CA file.

Downloaded on 2026-10-23 from:

https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

The download URL was verified against the `ssl:certificate_url` entry in [Supabase Studio's official configuration](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json), with `env=prod`. The [Supabase SSL guide](https://supabase.com/docs/guides/platform/ssl-enforcement) also describes downloading this CA through Database Settings.

- Subject/issuer: Supabase Root 2021 CA.
- Certificate validity: 2021-04-28 through 2031-04-26.
- Downloaded file SHA-256: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`.

Compose mounts this directory read-only at `/etc/skymeasure/certs` for the API and account-deletion worker. The runtime database URL must set `sslrootcert=/etc/skymeasure/certs/supabase-prod-ca-2021.crt`. Local Python connections need the local absolute certificate path instead. Check Supabase's current certificate instructions when renewing or rotating this file.
