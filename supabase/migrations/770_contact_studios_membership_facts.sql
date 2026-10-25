-- 770 — ORGCONTACTS.7 (spec 2026-10-25-membership-on-relationship-row-design.md):
-- the un1t.online membership facts move onto the relationship row.
--
-- WHY. contact_memberships (mig 722) was the last side channel beside
-- contact_studios: the un1t.online membership record (plan, active or ended,
-- ended date) that the churn and growth numbers, the win-back list, trial
-- eligibility and the pipeline snapshot read, and the un1t sync's step 7
-- wrote. It holds ONE row per (contact, studio, source) and no history, so the
-- facts fit on the one-row-per-(contact, studio) relationship row.
--
-- WHAT. Four columns, written ONLY by the un1t sync (setMembershipFacts in
-- src/lib/contact-studios.js; tests/membership-facts-writer-guard.test.js):
--   membership_plan      the plan as un1t.online names it
--   membership_status    'active' | 'ended' | NULL (never recorded here)
--   membership_since     when the sync first saw the membership
--   membership_ended_at  when the sync stopped seeing it
-- Backfilled from contact_memberships' un1t_online_api rows. Export-source
-- rows (the HATCH-MEMBERS.1 CSV import, all ended on 16 Oct 2026 when the API
-- sync took over) are artefacts, not churn, and are not carried.
-- derive_contact_studio reads membership_status = 'active' as the membership
-- (these are sync-owned SOURCE columns, like contacts.glofox_member_id, never
-- derived: a derived row must never be its own proof, LESSONS 25 Oct 2026) and
-- membership_since into first_seen_at; reconcile_contact_studios no longer
-- unions the table. contact_studios_upsert is untouched and never names a
-- membership column, so the nightly reconcile can never clear a fact.
--
-- APPLY BEFORE the code of this PR deploys (the sync starts writing the
-- columns; the readers start reading them). Mig 771 drops the table AFTER
-- the deploy and one sync run, copying across anything newer first.
--
-- Fails closed: an api row with status 'active' and an ended_at, or 'ended'
-- without one, aborts the file naming it (0 such rows in prod, 25 Oct 2026).
-- Replay-safe: a contact_memberships without the source columns (a test stub)
-- gets the columns and no backfill.
--
-- Proven by tests/migration-770-contact-studios-membership-facts.test.js (PGlite).
--
-- ROLLBACK RECORD (forward migration): ALTER TABLE public.contact_studios
--   DROP COLUMN membership_plan, DROP COLUMN membership_status,
--   DROP COLUMN membership_since, DROP COLUMN membership_ended_at;
--   then re-run mig 768 §1 (derive_contact_studio and reconcile_contact_studios).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Pre-checks.
DO $$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('public.contact_studios') IS NULL OR to_regclass('public.glofox_crossover_members') IS NOT NULL THEN
    RAISE EXCEPTION 'mig 770: apply 764 and 768 first';
  END IF;
  IF to_regclass('public.contact_memberships') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_memberships' AND column_name = 'ended_at') THEN
    SELECT string_agg(cm.contact_id::text || '@' || cm.location_id::text, ', ') INTO v_bad
      FROM public.contact_memberships cm
     WHERE cm.source = 'un1t_online_api'
       AND ((cm.status = 'active' AND cm.ended_at IS NOT NULL) OR (cm.status = 'ended' AND cm.ended_at IS NULL));
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'mig 770: api rows violate the membership CHECK (active with an ended_at, or ended without one): %', v_bad;
    END IF;
  END IF;
END $$;

-- 1. The four columns and their CHECKs. Service role only, as the table is
--    (no client privilege exists on contact_studios to extend).
ALTER TABLE public.contact_studios
  ADD COLUMN IF NOT EXISTS membership_plan text,
  ADD COLUMN IF NOT EXISTS membership_status text,
  ADD COLUMN IF NOT EXISTS membership_since timestamptz,
  ADD COLUMN IF NOT EXISTS membership_ended_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.contact_studios'::regclass AND conname = 'contact_studios_membership_status_check') THEN
    ALTER TABLE public.contact_studios ADD CONSTRAINT contact_studios_membership_status_check
      CHECK (membership_status IS NULL OR (membership_status IN ('active', 'ended') AND ((membership_status = 'ended') = (membership_ended_at IS NOT NULL))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.contact_studios'::regclass AND conname = 'contact_studios_membership_shape_check') THEN
    ALTER TABLE public.contact_studios ADD CONSTRAINT contact_studios_membership_shape_check
      CHECK (membership_status IS NOT NULL OR (membership_plan IS NULL AND membership_since IS NULL AND membership_ended_at IS NULL));
  END IF;
END $$;
COMMENT ON COLUMN public.contact_studios.membership_plan IS 'ORGCONTACTS.7 (mig 770): the un1t.online plan as the source names it. Written only by the un1t sync (setMembershipFacts); never derived.';
COMMENT ON COLUMN public.contact_studios.membership_status IS 'ORGCONTACTS.7 (mig 770): active | ended | NULL (no un1t.online membership ever recorded here). Written only by the un1t sync; derive_contact_studio reads active as the membership.';
COMMENT ON COLUMN public.contact_studios.membership_since IS 'ORGCONTACTS.7 (mig 770): when the un1t sync first saw the membership (stamped once, only where null). Written only by the un1t sync.';
COMMENT ON COLUMN public.contact_studios.membership_ended_at IS 'ORGCONTACTS.7 (mig 770): when the un1t sync stopped seeing the membership; NULL while active. Written only by the un1t sync.';

-- 2. Backfill from the api rows (guarded on the source columns existing).
DO $$
DECLARE
  v_api int := 0;
  v_export int := 0;
BEGIN
  IF to_regclass('public.contact_memberships') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_memberships' AND column_name = 'plan_name') THEN
    RAISE NOTICE 'mig 770: contact_memberships carries no source columns here; nothing to backfill';
    RETURN;
  END IF;
  UPDATE public.contact_studios cs
     SET membership_plan = cm.plan_name,
         membership_status = cm.status,
         membership_since = coalesce(cs.membership_since, cm.first_seen_at),
         membership_ended_at = cm.ended_at
    FROM public.contact_memberships cm
   WHERE cm.contact_id = cs.contact_id AND cm.location_id = cs.location_id AND cm.source = 'un1t_online_api';
  GET DIAGNOSTICS v_api = ROW_COUNT;
  SELECT count(*) INTO v_export FROM public.contact_memberships WHERE source <> 'un1t_online_api';
  RAISE NOTICE 'mig 770: % api membership rows copied onto contact_studios; % non-api rows skipped (export artefacts, not churn)', v_api, v_export;
END $$;

-- 3. derive_contact_studio reads the columns (mig 768's text otherwise).
CREATE OR REPLACE FUNCTION public.derive_contact_studio(p_contact_id uuid, p_location_id uuid)
RETURNS TABLE (kind text, status text, source text, stage_slug text, first_seen_at timestamptz, last_seen_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH c AS (
    SELECT id, location_id, glofox_member_id, glofox_membership_status, glofox_membership_state,
           created_at, last_attended_at, created_via_import_id,
           -- the Glofox columns describe an account at a GLOFOX studio of the
           -- contact's organisation (one per organisation today: Stillorgan),
           -- whether that studio is the contact's own or a sibling's. The proof
           -- is the Glofox id the contact carries, never the contact_studios
           -- row's own source: a public form at this studio rewrote that source
           -- once (lead_form) and the reconcile then forgot the account for
           -- good (final review C1). A second Glofox studio in one organisation
           -- needs a per-studio id column before this rule can tell them apart.
           (glofox_member_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.locations l
                          WHERE l.id = p_location_id AND l.membership_source = 'glofox'
                            AND l.organization_id = (SELECT h.organization_id FROM public.locations h WHERE h.id = contacts.location_id))) AS glofox_account_here
      FROM public.contacts WHERE id = p_contact_id
  ),
  f AS (
    SELECT
      -- the primary studio
      (SELECT location_id = p_location_id FROM c) AS primary_here,
      -- a Glofox account here (mig 768): the Glofox id the contact carries, at
      -- a Glofox studio of its organisation (see c.glofox_account_here)
      (SELECT glofox_account_here FROM c) AS glofox_account,
      -- a LIVE Glofox membership here (hasBookableMembership: member / credit_member, state active or unset)
      ((SELECT glofox_account_here FROM c)
        AND (SELECT glofox_membership_status IN ('member', 'credit_member') AND coalesce(glofox_membership_state, 'active') = 'active' FROM c)) AS glofox_member,
      -- the un1t.online membership facts the sync writes on the row itself
      -- (mig 770): sync-owned source columns, never derived here, so the row
      -- is not its own proof (contact_studios_upsert never names them)
      EXISTS (SELECT 1 FROM public.contact_studios x
               WHERE x.contact_id = p_contact_id AND x.location_id = p_location_id AND x.membership_status = 'active') AS membership_row,
      EXISTS (SELECT 1 FROM public.un1t_clients uc
               WHERE uc.contact_id = p_contact_id AND uc.location_id = p_location_id) AS un1t_client,
      -- a live un1t.online subscription (MEMBERSHIP_ACTIVE_STATUSES, src/lib/un1t-online-map.js) or credits
      EXISTS (SELECT 1 FROM public.un1t_clients uc
                LEFT JOIN public.un1t_subscriptions us
                       ON us.location_id = uc.location_id AND us.un1t_user_id = uc.un1t_user_id
               WHERE uc.contact_id = p_contact_id AND uc.location_id = p_location_id
                 AND (us.status IN ('active', 'trialing', 'past_due') OR uc.credit_unlimited IS TRUE OR coalesce(uc.credit_balance, 0) > 0)) AS un1t_live,
      EXISTS (SELECT 1 FROM public.deals d WHERE d.contact_id = p_contact_id AND d.location_id = p_location_id AND d.status = 'open') AS open_deal,
      EXISTS (SELECT 1 FROM public.deals d WHERE d.contact_id = p_contact_id AND d.location_id = p_location_id) AS any_deal,
      (SELECT p.source FROM public.contact_location_preferences p
        WHERE p.contact_id = p_contact_id AND p.location_id = p_location_id) AS prefs_source,
      EXISTS (SELECT 1 FROM public.contact_location_preferences p
               WHERE p.contact_id = p_contact_id AND p.location_id = p_location_id) AS prefs_row
  ),
  k AS (
    SELECT
      CASE
        WHEN f.glofox_member OR f.membership_row OR f.un1t_live THEN 'member'
        WHEN f.un1t_client OR f.glofox_account THEN 'client'
        WHEN f.open_deal OR f.any_deal OR f.prefs_row OR f.primary_here THEN 'lead'
        ELSE NULL
      END AS kind,
      CASE
        WHEN f.glofox_member OR f.membership_row OR f.un1t_live OR f.un1t_client OR f.glofox_account OR f.open_deal OR f.prefs_row OR f.primary_here THEN 'active'
        ELSE 'ended'
      END AS status,
      CASE
        WHEN f.glofox_account OR f.glofox_member THEN 'glofox'
        WHEN f.un1t_client THEN 'un1t_online'
        WHEN f.any_deal THEN 'deal'
        WHEN f.prefs_row AND coalesce(f.prefs_source, '') NOT IN ('import', 'manual', 'system') THEN 'lead_form'
        WHEN f.primary_here AND (SELECT created_via_import_id IS NOT NULL FROM c) THEN 'import'
        ELSE 'manual'
      END AS source,
      f.primary_here
    FROM f
  ),
  -- mig 736's rule, at THIS studio: the newest open deal on the enabled
  -- primary board here, else on any enabled board here, else NULL.
  stage AS (
    SELECT ps.slug
      FROM public.deals d
      JOIN public.pipeline_stages ps ON ps.id = d.stage_id
      JOIN public.pipelines p ON p.id = ps.pipeline_id
     WHERE d.contact_id = p_contact_id AND d.status = 'open' AND p.location_id = p_location_id AND p.enabled
     ORDER BY p.is_primary DESC, d.created_at DESC, d.id DESC
     LIMIT 1
  ),
  seen AS (
    SELECT
      LEAST(
        (SELECT min(d.created_at) FROM public.deals d WHERE d.contact_id = p_contact_id AND d.location_id = p_location_id),
        (SELECT x.membership_since FROM public.contact_studios x WHERE x.contact_id = p_contact_id AND x.location_id = p_location_id),
        (SELECT min(coalesce(uc.remote_created_at, uc.synced_at)) FROM public.un1t_clients uc WHERE uc.contact_id = p_contact_id AND uc.location_id = p_location_id),
        (SELECT min(p.subscribed_at) FROM public.contact_location_preferences p WHERE p.contact_id = p_contact_id AND p.location_id = p_location_id),
        (SELECT CASE WHEN location_id = p_location_id THEN created_at END FROM c)
      ) AS first_seen_at,
      GREATEST(
        (SELECT max(d.updated_at) FROM public.deals d WHERE d.contact_id = p_contact_id AND d.location_id = p_location_id),
        -- a class that HAPPENED (final review I2): a booking for next week is
        -- not activity (it outranked every message in the WhatsApp router and
        -- blocked the forward-only stamp until the class date), and a
        -- cancelled one never was (NOT_TRAINING_STATUSES, pipeline-other-studio-members.js)
        (SELECT max(b.starts_at) FROM public.class_bookings b
          WHERE b.contact_id = p_contact_id AND b.location_id = p_location_id
            AND b.starts_at <= now()
            AND upper(coalesce(b.status, '')) NOT IN ('CANCELLED', 'LATE_CANCELLED')),
        (SELECT max(m.created_at) FROM public.whatsapp_messages m
           JOIN public.whatsapp_conversations w ON w.id = m.conversation_id
          WHERE w.contact_id = p_contact_id AND w.location_id = p_location_id),
        (SELECT CASE WHEN location_id = p_location_id THEN last_attended_at END FROM c)
      ) AS last_seen_at
  )
  SELECT k.kind, k.status, k.source, (SELECT slug FROM stage) AS stage_slug,
         coalesce(seen.first_seen_at, now()) AS first_seen_at, seen.last_seen_at
    FROM k, seen
   WHERE EXISTS (SELECT 1 FROM c)
$function$;

-- EXECUTE as mig 764 left it (OR REPLACE keeps the ACL; stated for the guard).
REVOKE EXECUTE ON FUNCTION public.derive_contact_studio(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- 3b. reconcile_contact_studios without the table in its pair union (768's text otherwise).
CREATE OR REPLACE FUNCTION public.reconcile_contact_studios(p_location_id uuid DEFAULT NULL)
RETURNS TABLE (inserted int, updated int, ended int, unchanged int, skipped_no_primary int)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  pair record;
  outcome text;
BEGIN
  inserted := 0; updated := 0; ended := 0; unchanged := 0; skipped_no_primary := 0;
  FOR pair IN
    SELECT DISTINCT x.contact_id, x.location_id
      FROM (
        SELECT c.id AS contact_id, c.location_id FROM public.contacts c WHERE c.location_id IS NOT NULL
        UNION SELECT d.contact_id, d.location_id FROM public.deals d WHERE d.contact_id IS NOT NULL AND d.location_id IS NOT NULL
        UNION SELECT uc.contact_id, uc.location_id FROM public.un1t_clients uc WHERE uc.contact_id IS NOT NULL
        UNION SELECT p.contact_id, p.location_id FROM public.contact_location_preferences p
        UNION SELECT cs.contact_id, cs.location_id FROM public.contact_studios cs
      ) x
      JOIN public.contacts c ON c.id = x.contact_id
     WHERE p_location_id IS NULL OR x.location_id = p_location_id
     ORDER BY x.contact_id, x.location_id
  LOOP
    outcome := private.contact_studios_upsert(pair.contact_id, pair.location_id);
    IF outcome = 'inserted' THEN inserted := inserted + 1;
    ELSIF outcome = 'updated' THEN updated := updated + 1;
    ELSIF outcome = 'ended' THEN ended := ended + 1;
    ELSIF outcome = 'unchanged' THEN unchanged := unchanged + 1;
    END IF;
  END LOOP;
  IF p_location_id IS NULL THEN
    SELECT count(*) INTO skipped_no_primary FROM public.contacts c WHERE c.location_id IS NULL;
  END IF;
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.reconcile_contact_studios(uuid) IS
  'ORGCONTACTS.1 (mig 764; mig 770 reads the membership facts off the row): re-derive every contact_studios row (one studio, or all when NULL) from the source rows through derive_contact_studio(). The backfill and the nightly contact-studios-reconcile cron. Service role only.';
REVOKE EXECUTE ON FUNCTION public.reconcile_contact_studios(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_contact_studios(uuid) TO service_role;

-- 4. Self-check: the catalog, never this file.
DO $$
DECLARE
  v_missing text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_studios'
       AND column_name IN ('membership_plan', 'membership_status', 'membership_since', 'membership_ended_at')) <> 4 THEN
    RAISE EXCEPTION 'mig 770: the four membership columns are not all there';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.contact_studios'::regclass
       AND conname IN ('contact_studios_membership_status_check', 'contact_studios_membership_shape_check')) <> 2 THEN
    RAISE EXCEPTION 'mig 770: a membership CHECK is missing';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.derive_contact_studio(uuid, uuid)')) ILIKE '%contact_memberships%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.reconcile_contact_studios(uuid)')) ILIKE '%contact_memberships%' THEN
    RAISE EXCEPTION 'mig 770: derive_contact_studio / reconcile_contact_studios still read contact_memberships';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('private.contact_studios_upsert(uuid, uuid)')) ILIKE '%membership_%' THEN
    RAISE EXCEPTION 'mig 770: contact_studios_upsert must never name a membership column';
  END IF;
  IF to_regclass('public.contact_memberships') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_memberships' AND column_name = 'plan_name') THEN
    SELECT string_agg(cm.contact_id::text || '@' || cm.location_id::text, ', ') INTO v_missing
      FROM public.contact_memberships cm
     WHERE cm.source = 'un1t_online_api'
       AND NOT EXISTS (SELECT 1 FROM public.contact_studios cs
                        WHERE cs.contact_id = cm.contact_id AND cs.location_id = cm.location_id AND cs.membership_status = cm.status);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'mig 770: api membership rows with no relationship row carrying their status: %', v_missing;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'contact_studios' AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 770: contact_studios must stay closed to client sessions';
  END IF;
  RAISE NOTICE 'mig 770: membership facts live on contact_studios; derive reads them; the sync is their one writer.';
END $$;

COMMIT;
