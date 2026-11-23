-- Apply with the database administrator connection, never the browser key.
-- Existing staging deployments use the private skymeasure schema.
BEGIN;
SET LOCAL search_path = skymeasure, pg_catalog;
CREATE TABLE IF NOT EXISTS sky_read_revisions (
    key varchar(100) PRIMARY KEY, version integer NOT NULL
);
CREATE TABLE IF NOT EXISTS sky_view_cache (
    key varchar(200) PRIMARY KEY, version integer NOT NULL,
    computed_at double precision NOT NULL, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS sky_history_resets (
    id varchar(32) PRIMARY KEY, cutoff_ms bigint NOT NULL,
    created_at varchar(40) NOT NULL, archive_sha256 varchar(64) NOT NULL,
    maintenance boolean NOT NULL, applied boolean NOT NULL
);
CREATE TABLE IF NOT EXISTS sky_removed_objects (
    kind varchar(20) NOT NULL, id varchar(32) NOT NULL,
    owner_id varchar(64) NOT NULL, reset_id varchar(32) NOT NULL,
    PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS ix_sky_removed_objects_owner_id ON sky_removed_objects(owner_id);
DO $$
DECLARE target text;
BEGIN
    FOREACH target IN ARRAY ARRAY['sky_read_revisions','sky_view_cache','sky_history_resets','sky_removed_objects'] LOOP
        EXECUTE format('ALTER TABLE skymeasure.%I ENABLE ROW LEVEL SECURITY', target);
        EXECUTE format('REVOKE ALL ON skymeasure.%I FROM PUBLIC, anon, authenticated', target);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON skymeasure.%I TO skymeasure_api', target);
        EXECUTE format('DROP POLICY IF EXISTS skymeasure_runtime ON skymeasure.%I', target);
        EXECUTE format('CREATE POLICY skymeasure_runtime ON skymeasure.%I TO skymeasure_api USING (true) WITH CHECK (true)', target);
    END LOOP;
END $$;
COMMIT;
