-- 606 — ROSTER-SUPERSEDE.1 follow-up. Mig 602 created btree_gist with a bare
-- CREATE EXTENSION, which lands it in `public` and raises the advisor's
-- "Extension in Public" WARN. Every other extension in this project lives in
-- the `extensions` schema (pg_stat_statements, pgcrypto, uuid-ossp), so this
-- restores the convention 602 broke.
--
-- Safe for the live exclusion constraint: rosters_no_overlapping_published
-- stores its operator-class references by OID, so moving the extension's
-- schema does not invalidate the index behind it. Verified immediately after
-- applying (2026-09-09): the constraint is still present and still rejects an
-- overlapping publish with 23P01.
--
-- APPLIED 2026-09-09 alongside 602.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'btree_gist' AND n.nspname = 'public'
  ) THEN
    ALTER EXTENSION btree_gist SET SCHEMA extensions;
  END IF;
END $$;
