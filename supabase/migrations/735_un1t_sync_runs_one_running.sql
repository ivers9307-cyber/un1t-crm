-- 735 — UN1THARD.1: at most one un1t.online sync runs per studio at a time.
--
-- WHY. The */15 cron and the "Sync now" button both call runUn1tSync, and
-- nothing stopped the two overlapping (un1t.online follow-ups roadmap,
-- hardening backlog). The engine upserts and never deletes, and a stale
-- run's write-back to the connection is already guarded on the token's
-- fingerprint, so an overlap costs no data. It does spend the token's rate
-- budget twice (60 requests a minute), and two runs racing the same
-- membership reconcile is harder to reason about than one.
--
-- THE FIX. A partial unique index: one 'running' row per location. The
-- engine inserts its run row first, so a second run's insert fails 23505 and
-- that run returns reason 'in_progress' having read and written nothing.
-- Before inserting, the engine closes this location's 'running' rows older
-- than 15 minutes as abandoned (a killed process never closes its row; the
-- cron's maxDuration is 300 s and the route's 120 s), so a dead run cannot
-- block the studio's syncs for good.
--
-- VERIFIED LIVE (17 Oct 2026, before this file): 0 rows with status
-- 'running' (83 runs, all closed; longest 14.5 s), so the index builds.
-- un1t_sync_runs is service_role only (no client privilege), so no grant
-- changes.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS un1t_sync_runs_one_running
  ON public.un1t_sync_runs (location_id)
  WHERE status = 'running';

COMMENT ON INDEX public.un1t_sync_runs_one_running IS
  'UN1THARD.1 (mig 735): at most one running un1t.online sync per location. A second run''s insert fails 23505 and runUn1tSync returns reason in_progress; runs left running over 15 minutes are closed as abandoned first.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'un1t_sync_runs'
       AND indexname = 'un1t_sync_runs_one_running'
       AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(location_id)%' AND indexdef ILIKE '%status = ''running''%'
  ) THEN
    RAISE EXCEPTION 'mig 735: un1t_sync_runs_one_running is missing or not the partial unique index on (location_id) WHERE status = ''running''';
  END IF;
END $$;

COMMIT;
