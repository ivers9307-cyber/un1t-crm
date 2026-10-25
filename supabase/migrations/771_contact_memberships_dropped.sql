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
-- plan from every un1t_online_api row that differs from its relationship row
-- (membership_since only where the column is null), and prints how many it
-- copied: applied after a sync on the new code, that count reads 0, which is
-- the proof the migration can offer. Export-source rows are not read (the
-- HATCH-MEMBERS.1 CSV artefacts; mig 770 skipped them for the same reason).
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

-- 1. The parity pass: anything the old code wrote to the table after 770's
--    backfill reaches the columns before the table goes.
DO $$
DECLARE
  v_n int := 0;
BEGIN
  IF to_regclass('public.contact_memberships') IS NULL THEN RETURN; END IF;
  UPDATE public.contact_studios cs
     SET membership_plan = cm.plan_name,
         membership_status = cm.status,
         membership_ended_at = cm.ended_at,
         membership_since = coalesce(cs.membership_since, cm.first_seen_at),
         updated_at = now()
    FROM public.contact_memberships cm
   WHERE cm.contact_id = cs.contact_id AND cm.location_id = cs.location_id AND cm.source = 'un1t_online_api'
     AND ((cm.status = 'active' AND cm.ended_at IS NULL) OR (cm.status = 'ended' AND cm.ended_at IS NOT NULL))
     AND (cs.membership_status IS DISTINCT FROM cm.status
          OR cs.membership_ended_at IS DISTINCT FROM cm.ended_at
          OR cs.membership_plan IS DISTINCT FROM cm.plan_name
          OR cs.membership_since IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'mig 771: parity pass copied % api row(s) that were newer than the columns (0 once a sync has run on the new code)', v_n;
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
