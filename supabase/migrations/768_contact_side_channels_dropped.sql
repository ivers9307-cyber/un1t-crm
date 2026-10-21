-- 768 — ORGCONTACTS.5: the contact side channels contact_studios replaced are gone
-- (spec 2026-10-20 §2.3, plan Task 24).
--
-- WHAT GOES.
--   * public.glofox_crossover_members (mig 758): the Glofox link rows. Every
--     one became a contact_studios row with source glofox in mig 764's
--     backfill, and since ORGCONTACTS.2 (#2169) every reader and
--     recordGlofoxCrossover (ORGCONTACTS.5, this PR) use that row.
--   * private.auth_contact_membership_contact_ids(): a one-line delegate since
--     mig 765; contacts_select calls the studio helper directly.
--   * public.crossover_contact_ids(uuid): mig 765 re-pointed it at
--     contact_studios and marked it DEPRECATED; the phone directory route and
--     the lists read the studio_contacts view since #2169.
--   * derive_contact_studio() and reconcile_contact_studios() are re-created
--     WITHOUT the link-table branches / union source: "a
--     Glofox account here" is the contact's own at a Glofox home studio, or the
--     contact_studios row this studio holds with source glofox. The reconcile
--     keeps every such row: its derivation reads the row it maintains, as the
--     link row used to stand for it. contact_memberships STAYS (the un1t
--     adapter's churn, growth and win-back reads and the sync's step 7 still
--     use its ended_at / plan_name; contact_studios carries neither — a dated
--     backlog item, docs/BACKLOG.md).
--   * person_groups.location_id becomes NULLABLE (DEPRECATED since mig 767;
--     createGroup writes it for one release more, so the drop and the 767 fill
--     trigger go in the release after the code stops writing it).
--
-- APPLY AFTER the code of this PR deploys: prod's previous code wrote the link
-- table in recordGlofoxCrossover. Pre-checks refuse while 767 is not applied,
-- while contacts_select names a dropped function, or while any view, policy or
-- other function still references one of the dropped objects.
--
-- Proven ahead of apply by tests/migration-768-contact-side-channels-dropped.test.js
-- (PGlite).
--
-- ROLLBACK RECORD (DDL only: the link rows are NOT restorable; the
-- contact_studios rows with source glofox hold the same relationships):
-- CREATE TABLE IF NOT EXISTS public.glofox_crossover_members (
--   id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
--   location_id      uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
--   glofox_member_id text        NOT NULL CHECK (length(btrim(glofox_member_id)) > 0),
--   contact_id       uuid        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
--   created_at       timestamptz NOT NULL DEFAULT now(),
--   updated_at       timestamptz NOT NULL DEFAULT now(),
--   UNIQUE (location_id, glofox_member_id)
-- );
-- CREATE INDEX IF NOT EXISTS glofox_crossover_members_location_contact
--   ON public.glofox_crossover_members (location_id, contact_id);
-- CREATE INDEX IF NOT EXISTS glofox_crossover_members_contact
--   ON public.glofox_crossover_members (contact_id);
--
-- ALTER TABLE public.glofox_crossover_members ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON public.glofox_crossover_members FROM PUBLIC, anon, authenticated;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON public.glofox_crossover_members TO service_role;
-- CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids()
-- RETURNS uuid[]
-- LANGUAGE sql
-- STABLE
-- SECURITY DEFINER
-- SET search_path = ''
-- AS $function$
--   SELECT private.auth_contact_studio_contact_ids()
-- $function$;
--
-- COMMENT ON FUNCTION private.auth_contact_membership_contact_ids() IS
--   'DEPRECATED (mig 765): a delegate to private.auth_contact_studio_contact_ids(), kept so a cached plan or a hand query keeps working; dropped in mig 768. Nothing new may read it.';
--
-- REVOKE ALL ON FUNCTION private.auth_contact_membership_contact_ids() FROM PUBLIC, anon;
-- GRANT EXECUTE ON FUNCTION private.auth_contact_membership_contact_ids() TO authenticated, service_role;
-- CREATE OR REPLACE FUNCTION public.crossover_contact_ids(loc uuid)
-- RETURNS TABLE (contact_id uuid)
-- LANGUAGE sql
-- STABLE
-- SET search_path = ''
-- AS $function$
--   SELECT DISTINCT cs.contact_id
--     FROM public.contact_studios cs
--     JOIN public.contacts c ON c.id = cs.contact_id
--    WHERE cs.location_id = loc
--      AND c.location_id IS DISTINCT FROM loc
-- $function$;
--
-- COMMENT ON FUNCTION public.crossover_contact_ids(uuid) IS
--   'DEPRECATED (mig 765): contacts with a contact_studios row at loc whose primary studio is elsewhere. The web list reads public.studio_contacts instead; the phone directory route reads it until mig 768 drops this. Service role only.';
--
-- REVOKE ALL ON FUNCTION public.crossover_contact_ids(uuid) FROM PUBLIC, anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.crossover_contact_ids(uuid) TO service_role;
-- ALTER TABLE public.person_groups ALTER COLUMN location_id SET NOT NULL;
-- then re-run mig 764's derive_contact_studio and reconcile_contact_studios (their text is in that file).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Pre-checks.
DO $$
DECLARE
  v_ref text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = 'organization_id') THEN
    RAISE EXCEPTION 'mig 768: apply 767_person_groups_organization first';
  END IF;
  IF to_regclass('public.contact_studios') IS NULL OR to_regprocedure('private.auth_contact_studio_contact_ids()') IS NULL THEN
    RAISE EXCEPTION 'mig 768: apply 764 and 765 first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'
              AND (qual ILIKE '%auth_contact_membership_contact_ids%' OR qual ILIKE '%crossover_contact_ids%')) THEN
    RAISE EXCEPTION 'mig 768: contacts_select still names a deprecated function; apply 765 first';
  END IF;
  -- anything that still depends on a dropped object: a view, a policy, a
  -- function other than the ones this file drops or re-creates
  SELECT string_agg(what, ', ') INTO v_ref FROM (
    SELECT 'view ' || schemaname || '.' || viewname AS what FROM pg_views
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
       AND (definition ILIKE '%glofox_crossover_members%' OR definition ILIKE '%crossover_contact_ids%' OR definition ILIKE '%auth_contact_membership_contact_ids%')
    UNION ALL
    SELECT 'policy ' || tablename || '.' || policyname FROM pg_policies
     WHERE coalesce(qual, '') ILIKE '%crossover_contact_ids%' OR coalesce(with_check, '') ILIKE '%crossover_contact_ids%'
        OR coalesce(qual, '') ILIKE '%auth_contact_membership_contact_ids%' OR coalesce(with_check, '') ILIKE '%auth_contact_membership_contact_ids%'
        OR coalesce(qual, '') ILIKE '%glofox_crossover_members%' OR coalesce(with_check, '') ILIKE '%glofox_crossover_members%'
    UNION ALL
    SELECT 'function ' || n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'private')
       AND p.proname NOT IN ('derive_contact_studio', 'reconcile_contact_studios', 'auth_contact_membership_contact_ids', 'crossover_contact_ids')
       AND (p.prosrc ILIKE '%glofox_crossover_members%' OR p.prosrc ILIKE '%crossover_contact_ids(%' OR p.prosrc ILIKE '%auth_contact_membership_contact_ids(%')
  ) d;
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION 'mig 768: these still depend on a dropped object: %', v_ref;
  END IF;
END $$;

-- 1. derive_contact_studio without the link-table branches (mig 764's text otherwise).
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
           -- the Glofox columns describe an account at a GLOFOX studio: the
           -- contact's own studio when that studio runs on Glofox, else only
           -- where a crossover row links the account
           (location_id = p_location_id AND glofox_member_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_location_id AND l.membership_source = 'glofox')) AS glofox_home_here
      FROM public.contacts WHERE id = p_contact_id
  ),
  f AS (
    SELECT
      -- the primary studio
      (SELECT location_id = p_location_id FROM c) AS primary_here,
      -- a Glofox account here: the contact's own at a Glofox home studio, or
      -- (mig 768) the contact_studios row this studio holds with source glofox
      -- (recordGlofoxCrossover writes it; mig 764's backfill made one from
      -- every link-table row before the table went)
      ((SELECT glofox_home_here FROM c)
        OR EXISTS (SELECT 1 FROM public.contact_studios cs WHERE cs.contact_id = p_contact_id AND cs.location_id = p_location_id AND cs.source = 'glofox')) AS glofox_account,
      -- a LIVE Glofox membership here (hasBookableMembership: member / credit_member, state active or unset)
      (((SELECT glofox_home_here FROM c)
         OR EXISTS (SELECT 1 FROM public.contact_studios cs WHERE cs.contact_id = p_contact_id AND cs.location_id = p_location_id AND cs.source = 'glofox'))
        AND (SELECT glofox_membership_status IN ('member', 'credit_member') AND coalesce(glofox_membership_state, 'active') = 'active' FROM c)) AS glofox_member,
      EXISTS (SELECT 1 FROM public.contact_memberships cm
               WHERE cm.contact_id = p_contact_id AND cm.location_id = p_location_id AND cm.status = 'active') AS membership_row,
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
        (SELECT min(cm.first_seen_at) FROM public.contact_memberships cm WHERE cm.contact_id = p_contact_id AND cm.location_id = p_location_id),
        (SELECT min(coalesce(uc.remote_created_at, uc.synced_at)) FROM public.un1t_clients uc WHERE uc.contact_id = p_contact_id AND uc.location_id = p_location_id),
        (SELECT min(p.subscribed_at) FROM public.contact_location_preferences p WHERE p.contact_id = p_contact_id AND p.location_id = p_location_id),
        (SELECT CASE WHEN location_id = p_location_id THEN created_at END FROM c)
      ) AS first_seen_at,
      GREATEST(
        (SELECT max(d.updated_at) FROM public.deals d WHERE d.contact_id = p_contact_id AND d.location_id = p_location_id),
        (SELECT max(b.starts_at) FROM public.class_bookings b WHERE b.contact_id = p_contact_id AND b.location_id = p_location_id),
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

-- 1b. reconcile_contact_studios without the link-table source in its pair union
--     (every link row already has its contact_studios row; mig 764's text otherwise).
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
        UNION SELECT cm.contact_id, cm.location_id FROM public.contact_memberships cm
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
  'ORGCONTACTS.1 (mig 764; mig 768 without the link table): re-derive every contact_studios row (one studio, or all when NULL) from the source rows through derive_contact_studio(). The backfill and the nightly contact-studios-reconcile cron. Service role only.';
REVOKE EXECUTE ON FUNCTION public.reconcile_contact_studios(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_contact_studios(uuid) TO service_role;

-- 2. The deprecated functions and the link table.
DROP FUNCTION IF EXISTS private.auth_contact_membership_contact_ids();
DROP FUNCTION IF EXISTS public.crossover_contact_ids(uuid);
DROP TABLE IF EXISTS public.glofox_crossover_members;

-- 3. person_groups.location_id: nullable ahead of its drop.
ALTER TABLE public.person_groups ALTER COLUMN location_id DROP NOT NULL;
COMMENT ON COLUMN public.person_groups.location_id IS
  'DEPRECATED (mig 767): groups follow the organisation; nullable since mig 768; dropped, with the 767 fill trigger, once createGroup stops writing it';

-- 4. Self-check: the catalog, never this file.
DO $$
DECLARE
  v_qual text;
BEGIN
  IF to_regclass('public.glofox_crossover_members') IS NOT NULL THEN
    RAISE EXCEPTION 'mig 768: glofox_crossover_members still exists';
  END IF;
  IF to_regprocedure('private.auth_contact_membership_contact_ids()') IS NOT NULL
     OR to_regprocedure('public.crossover_contact_ids(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'mig 768: a deprecated function still exists';
  END IF;
  SELECT qual INTO v_qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select';
  IF v_qual IS NULL OR v_qual NOT ILIKE '%auth_contact_studio_contact_ids%' THEN
    RAISE EXCEPTION 'mig 768: contacts_select no longer reads the studio helper';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.derive_contact_studio(uuid, uuid)')) ILIKE '%glofox_crossover_members%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.reconcile_contact_studios(uuid)')) ILIKE '%glofox_crossover_members%' THEN
    RAISE EXCEPTION 'mig 768: derive_contact_studio / reconcile_contact_studios still read the link table';
  END IF;
  IF (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = 'location_id') <> 'YES' THEN
    RAISE EXCEPTION 'mig 768: person_groups.location_id is still NOT NULL';
  END IF;
  IF (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = 'organization_id') <> 'NO' THEN
    RAISE EXCEPTION 'mig 768: person_groups.organization_id must stay NOT NULL';
  END IF;
  RAISE NOTICE 'mig 768: link table and two deprecated functions dropped; derive_contact_studio reads contact_studios; person_groups.location_id nullable.';
END $$;

COMMIT;
