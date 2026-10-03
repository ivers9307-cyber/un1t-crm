-- 663 — SEQCOUNTERS.1: email_sequences.total_enrolled / total_completed /
-- total_exited are DEPRECATED. Comments only; no data, grant or policy change.
--
-- Why: nothing ever maintained them. The runner called
-- rpc('increment_sequence_enrolled') and rpc('increment_sequence_completed'),
-- which have never existed (no migration; 0 rows in pg_proc on 29 Sep 2026;
-- 3 × 404 in the edge logs that day). supabase-js resolves with { error }
-- rather than throwing, and the error was dropped, so the counters sat at
-- whatever a one-off hand edit left. total_exited had no writer at all.
-- SEQCOUNTERS.1 removes the calls and counts sequence_enrollments rows where
-- the number is shown (/automations embeds sequence_enrollments(count); the
-- Performance panel's /stats already counted rows). Nothing reads these
-- columns now (tests/sequence-counters-retired.test.js). The house rule for a
-- retired column: comment it DEPRECATED, stop reading/writing it, drop it in
-- a later migration (that one must also update mig 654's column-grant list,
-- tests/helpers/sequence-column-grants.js).
--
-- Stored values are left as they are (plan C61 DECISION 3): backfilling a
-- column nobody maintains only creates a second snapshot that starts to
-- drift on the next enrolment.
--
-- PRE-CHECK (read-only; expected fns = 0, commented = 0):
--   select (select count(*) from pg_proc where proname like 'increment_sequence_%') as fns,
--          (select count(*) from pg_attribute a
--             where a.attrelid = 'public.email_sequences'::regclass
--               and a.attname in ('total_enrolled','total_completed','total_exited')
--               and col_description(a.attrelid, a.attnum) is not null) as commented;
-- POST-CHECK: the same query → fns = 0, commented = 3; and
--   select a.attname, col_description(a.attrelid, a.attnum) from pg_attribute a
--   where a.attrelid = 'public.email_sequences'::regclass and a.attname like 'total_%';
-- ROLLBACK (restores the pre-663 state exactly; none of the three had a comment):
--   COMMENT ON COLUMN public.email_sequences.total_enrolled IS NULL;
--   COMMENT ON COLUMN public.email_sequences.total_completed IS NULL;
--   COMMENT ON COLUMN public.email_sequences.total_exited IS NULL;

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname LIKE 'increment\_sequence\_%' ESCAPE '\'
  ) THEN
    RAISE EXCEPTION '663: an increment_sequence_* function exists, so something may maintain these counters; stop and re-plan (C61)';
  END IF;
END $$;

COMMENT ON COLUMN public.email_sequences.total_enrolled IS
  'DEPRECATED (mig 663, SEQCOUNTERS.1): never maintained. Count sequence_enrollments rows (embed sequence_enrollments(count)). To be dropped.';
COMMENT ON COLUMN public.email_sequences.total_completed IS
  'DEPRECATED (mig 663, SEQCOUNTERS.1): never maintained. Count sequence_enrollments where status = ''completed''. To be dropped.';
COMMENT ON COLUMN public.email_sequences.total_exited IS
  'DEPRECATED (mig 663, SEQCOUNTERS.1): never maintained. Count sequence_enrollments where status = ''exited''. To be dropped.';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_attribute a
  WHERE a.attrelid = 'public.email_sequences'::regclass
    AND a.attname IN ('total_enrolled', 'total_completed', 'total_exited')
    AND col_description(a.attrelid, a.attnum) LIKE 'DEPRECATED (mig 663, SEQCOUNTERS.1)%';
  IF n <> 3 THEN
    RAISE EXCEPTION '663 self-check: expected 3 deprecated comments, found %', n;
  END IF;
END $$;

COMMIT;
