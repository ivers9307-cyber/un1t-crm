-- 771 — ORGCONTACTS.7 (spec 2026-10-25-membership-on-relationship-row-design.md):
-- contact_memberships is dropped, after a parity pass.
--
-- WHY. Since mig 770 the un1t.online membership facts live on the relationship
-- row (contact_studios.membership_plan / _status / _since / _ended_at), the
-- un1t sync writes them there, and every reader reads them there. The table
-- was the last side channel beside contact_studios (HATCH-MEMBERS.1, mig 722).
--
-- APPLY AFTER the code of the PR deploys AND after one un1t-online-sync run
-- on it (un1t_sync_runs newer than the deploy). In the window between 770's
-- apply and the deploy the old code kept writing the table every 15 minutes
-- and never the columns, so a membership that ended, started or changed plan
-- in that window is newer on the table. Section 1 copies status, ended_at and
-- plan from every un1t_online_api row that is NEWER than its relationship row
-- (the table's updated_at / last_seen_at against contact_studios.updated_at),
-- keeps the earlier of two end dates and the earliest since, and prints how
-- many rows it repaired. The columns are the newer side for anything the new
-- code wrote after the deploy, and those changes stand (final review of
-- #2198: a non-directional copy would have reverted them and dropped the
-- evidence). Export-source rows are not read (the HATCH-MEMBERS.1 CSV
-- artefacts; mig 770 skipped them for the same reason).
--
-- Refuses while any view, policy or function other than derive_contact_studio
-- / reconcile_contact_studios (mig 770 re-created both without the table)
-- still names the table. Replay-safe: an absent table is a no-op.
--
-- Proven by tests/migration-771-contact-memberships-dropped.test.js (PGlite).
--
-- ROLLBACK RECORD (forward migration; the rows are restorable from the columns):
-- re-run mig 722's CREATE TABLE, indexes, RLS and grants, then
-- INSERT INTO public.contact_memberships (organization_id, location_id, contact_id, source, plan_name, status, first_seen_at, last_seen_at, ended_at)
--   SELECT organization_id, location_id, contact_id, 'un1t_online_api', coalesce(membership_plan, 'Membership'), membership_status,
--          coalesce(membership_since, now()), now(), membership_ended_at
--     FROM public.contact_studios WHERE membership_status IS NOT NULL;

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Pre-checks (skipped when the table is already gone: replay-safe).
DO $$
DECLARE
  v_ref text;
BEGIN
  IF to_regclass('public.contact_memberships') IS NULL THEN
    RAISE NOTICE 'mig 771: contact_memberships is already gone; nothing to do';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_studios'
       AND column_name IN ('membership_plan', 'membership_status', 'membership_since', 'membership_ended_at')) <> 4 THEN
    RAISE EXCEPTION 'mig 771: apply 770 first (the membership columns are not on contact_studios)';
  END IF;
  SELECT string_agg(what, ', ') INTO v_ref FROM (
    SELECT 'view ' || schemaname || '.' || viewname AS what FROM pg_views
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND definition ILIKE '%contact_memberships%'
    UNION ALL
    SELECT 'policy ' || tablename || '.' || policyname FROM pg_policies
     WHERE tablename <> 'contact_memberships'
       AND (coalesce(qual, '') ILIKE '%contact_memberships%' OR coalesce(with_check, '') ILIKE '%contact_memberships%')
    UNION ALL
    SELECT 'function ' || n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'private')
       AND p.proname NOT IN ('derive_contact_studio', 'reconcile_contact_studios')
       AND p.prosrc ILIKE '%contact_memberships%'
    UNION ALL
    SELECT 'function ' || p.proname || ' (mig 770 not applied: still reads the table)' FROM pg_proc p
     WHERE p.oid IN (to_regprocedure('public.derive_contact_studio(uuid, uuid)'), to_regprocedure('public.reconcile_contact_studios(uuid)'))
       AND p.prosrc ILIKE '%contact_memberships%'
  ) d;
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION 'mig 771: these still depend on contact_memberships: %', v_ref;
  END IF;
END $$;

-- 1. The parity pass, DIRECTIONAL (final review of #2198). The table and the
--    columns each carry a clock: the old code stamped updated_at / last_seen_at
--    on every table write, and every write to the relationship row bumps
--    contact_studios.updated_at (mig 764's trigger). Status and plan are copied
--    from the table only where the TABLE is the newer side (a window change the
--    new code has not seen: 771 applied before any sync); where the columns are
--    newer (the new code's own endings, plan changes and rejoins after the
--    deploy) they stand. An ending both sides know keeps the EARLIER date (the
--    new code's first run stamps a window ending late), and since keeps the
--    earliest of the two. Rows with a status/ended_at shape the CHECK refuses
--    are left to the columns (mig 770 refused them already).
DO $$
DECLARE
  v_n int := 0;
BEGIN
  IF to_regclass('public.contact_memberships') IS NULL THEN RETURN; END IF;
  WITH cand AS (
    SELECT cs.contact_id, cs.location_id,
           CASE WHEN t.table_newer THEN cm.status ELSE cs.membership_status END AS n_status,
           CASE WHEN t.table_newer THEN cm.plan_name ELSE cs.membership_plan END AS n_plan,
           CASE
             WHEN t.table_newer THEN cm.ended_at
             WHEN cs.membership_status = 'ended' AND cm.status = 'ended' THEN LEAST(cs.membership_ended_at, cm.ended_at)
             ELSE cs.membership_ended_at
           END AS n_ended_at,
           LEAST(cs.membership_since, cm.first_seen_at) AS n_since
      FROM public.contact_studios cs
      JOIN public.contact_memberships cm
        ON cm.contact_id = cs.contact_id AND cm.location_id = cs.location_id AND cm.source = 'un1t_online_api'
       AND ((cm.status = 'active' AND cm.ended_at IS NULL) OR (cm.status = 'ended' AND cm.ended_at IS NOT NULL))
      CROSS JOIN LATERAL (SELECT greatest(cm.updated_at, cm.last_seen_at) > cs.updated_at AS table_newer) t
  )
  UPDATE public.contact_studios cs
     SET membership_status = c.n_status,
         membership_plan = c.n_plan,
         membership_ended_at = c.n_ended_at,
         membership_since = c.n_since,
         updated_at = now()
    FROM cand c
   WHERE cs.contact_id = c.contact_id AND cs.location_id = c.location_id
     AND (cs.membership_status IS DISTINCT FROM c.n_status
          OR cs.membership_plan IS DISTINCT FROM c.n_plan
          OR cs.membership_ended_at IS DISTINCT FROM c.n_ended_at
          OR cs.membership_since IS DISTINCT FROM c.n_since);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'mig 771: parity pass repaired % relationship row(s) from the table (window changes the new code had not seen, earlier end dates, earliest since)', v_n;
END $$;

-- 2. The drop.
DROP TABLE IF EXISTS public.contact_memberships;

-- 3. Self-check: the catalog, never this file.
DO $$
BEGIN
  IF to_regclass('public.contact_memberships') IS NOT NULL THEN
    RAISE EXCEPTION 'mig 771: contact_memberships still exists';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_studios'
       AND column_name IN ('membership_plan', 'membership_status', 'membership_since', 'membership_ended_at')) <> 4 THEN
    RAISE EXCEPTION 'mig 771: the membership columns are missing from contact_studios';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ('public', 'private') AND p.prosrc ILIKE '%contact_memberships%') THEN
    RAISE EXCEPTION 'mig 771: a function still names contact_memberships';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contact_studios WHERE membership_status = 'ended' AND membership_ended_at IS NULL) THEN
    RAISE EXCEPTION 'mig 771: an ended membership carries no ended_at';
  END IF;
  RAISE NOTICE 'mig 771: contact_memberships dropped; the membership facts live on contact_studios.';
END $$;

COMMIT;
