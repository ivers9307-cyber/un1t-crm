-- 764 — ORGCONTACTS.1: contact_studios, the one table that answers "which
-- studios is this person at" (docs/superpowers/specs/2026-10-20-org-shared-
-- contacts-whatsapp-design.md §2.1; plan docs/superpowers/plans/2026-10-20-
-- org-shared-contacts-whatsapp.md Task 6).
--
-- Proven by tests/migration-764-contact-studios.test.js (PGlite; the live
-- shapes of every table this file reads, then this file).
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- A person is one contacts row per organisation (mig 712) with ONE home studio
-- (contacts.location_id). "This person is also at the other studio" was five
-- side channels added one at a time as Hatch came online (deals, active
-- contact_memberships, un1t_clients, glofox_crossover_members,
-- contact_location_preferences), and every reader (RLS, the lists, the
-- contact page, the phone, Mia, the pipeline exclusion, the Glofox readers)
-- re-derived the answer from its own subset of them, and the subsets
-- disagreed. Richard's standing rule (decision 1, 20 Oct 2026): people belong
-- to the organisation, studios hold relationships; every source writes a
-- contact_studios row and nothing else.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   1. public.contact_studios: one row per (contact, studio) that has ever
--      had a relationship. Service role only (RLS on, no policy, no client
--      privilege: the mig 677 default, stated). Rows are never deleted.
--   2. public.derive_contact_studio(contact, studio): THE implementation of
--      the lifecycle rules, from the source rows at that studio:
--        kind    member (a live membership) > client (a provider account,
--                lapsed or not) > lead (a deal or a preferences row, or the
--                primary studio); NULL = no relationship at all.
--        status  'active' while any of: a live membership, a provider
--                account, an open deal, a preferences row, or the primary
--                studio (a contact record IS a relationship with the studio
--                that holds it; the spec's list omits it, this file does not:
--                a fresh contact must never be 'ended' at its own studio);
--                else 'ended'.
--        source  the first of: glofox, un1t_online, deal, lead_form, import,
--                manual.
--        stage_slug  mig 736's rule applied AT this studio.
--        first_seen_at  the earliest source stamp.
--        last_seen_at   last ACTIVITY (a deal touch, a booking, a message in
--                this studio's thread, attendance), never a sync tick.
--   3. public.reconcile_contact_studios(studio|NULL): re-derives every row
--      from the union of the sources (first_seen_at never later, last_seen_at
--      never earlier, ended_at set and cleared with status). The backfill
--      below is one call; a nightly cron (/api/cron/contact-studios-reconcile,
--      heartbeat row 'contact-studios-reconcile') is the same call.
--   4. Three DEFINER triggers keep the table live between reconciles: a
--      contact insert (its primary studio), a deal insert/update/delete (both
--      the old and the new board's studio), a marketing-preferences insert.
--      The two syncs (un1t.online, Glofox) write through
--      src/lib/contact-studios.js as well.
--   5. The organisation fence: organization_id is set from the studio and a
--      row whose contact is in another organisation raises; contact_id and
--      location_id never change on a row.
--
-- WHO CHANGES: nobody yet. Nothing reads the table until ORGCONTACTS.2.
--
-- APPLY: before the ORGCONTACTS.1 code merges, then get_advisors (security).
-- The NOTICE at the end carries the backfill counts; skipped_no_primary is the
-- number of contacts with a NULL location_id (reported, not fatal).
-- ROLLBACK (forward migration): DROP TRIGGER contact_studios_from_contact ON
--   public.contacts; DROP TRIGGER contact_studios_from_deal ON public.deals;
--   DROP TRIGGER contact_studios_from_preferences ON
--   public.contact_location_preferences; DROP FUNCTION
--   private.contact_studios_from_contact(), private.contact_studios_from_deal(),
--   private.contact_studios_from_preferences(), private.contact_studios_upsert(uuid, uuid),
--   public.reconcile_contact_studios(uuid), public.derive_contact_studio(uuid, uuid),
--   private.contact_studios_set_org(), private.contact_studios_freeze_keys();
--   DROP TABLE public.contact_studios; DELETE FROM public.cron_heartbeats
--   WHERE name = 'contact-studios-reconcile'.
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Pre-checks: every source this file reads.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts', 'locations', 'deals', 'pipelines', 'pipeline_stages', 'contact_memberships', 'un1t_clients',
                           'un1t_subscriptions', 'glofox_crossover_members', 'contact_location_preferences', 'class_bookings',
                           'whatsapp_conversations', 'whatsapp_messages', 'cron_heartbeats'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'mig 764: public.% is missing; apply its migration first', t;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'organization_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'deals' AND column_name = 'location_id') THEN
    RAISE EXCEPTION 'mig 764: contacts.organization_id (mig 712) or deals.location_id (mig 004) is missing';
  END IF;
END $$;

-- 1. The table.
CREATE TABLE IF NOT EXISTS public.contact_studios (
  contact_id      uuid        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  location_id     uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  organization_id uuid        NOT NULL REFERENCES public.organizations(id),
  kind            text        NOT NULL CHECK (kind IN ('member', 'client', 'lead')),
  status          text        NOT NULL CHECK (status IN ('active', 'ended')),
  source          text        NOT NULL CHECK (source IN ('glofox', 'un1t_online', 'lead_form', 'deal', 'manual', 'import')),
  stage_slug      text,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, location_id),
  CONSTRAINT contact_studios_ended_at_matches_status CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS contact_studios_location_status ON public.contact_studios (location_id, status);
CREATE INDEX IF NOT EXISTS contact_studios_location_contact ON public.contact_studios (location_id, contact_id);
CREATE INDEX IF NOT EXISTS contact_studios_org ON public.contact_studios (organization_id);

ALTER TABLE public.contact_studios ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_studios FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_studios TO service_role;

COMMENT ON TABLE public.contact_studios IS
  'ORGCONTACTS.1 (mig 764): one row per (contact, studio) that has ever had a relationship; the authority for "which studios is this person at" (spec 2026-10-20 §2.1). kind member > client > lead; status active/ended; source; stage_slug = the pipeline stage AT this studio (mig 736''s rule); first_seen_at = earliest source stamp; last_seen_at = last ACTIVITY (never a sync tick). Rows are never deleted. Written by three DEFINER triggers (contacts insert, deals, contact_location_preferences insert), the two syncs through src/lib/contact-studios.js, and re-derived nightly by reconcile_contact_studios(). Service role only: RLS on, no policy, no client privilege. The lifecycle rules live in derive_contact_studio() and src/lib/contact-studios.js: change both.';

-- 2. The organisation fence and the frozen keys.
CREATE OR REPLACE FUNCTION private.contact_studios_set_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contact_org uuid;
BEGIN
  SELECT organization_id INTO NEW.organization_id FROM public.locations WHERE id = NEW.location_id;
  SELECT organization_id INTO v_contact_org FROM public.contacts WHERE id = NEW.contact_id;
  IF NEW.organization_id IS NULL OR v_contact_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'contact_studios: contact % and studio % are in different organisations', NEW.contact_id, NEW.location_id
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.contact_studios_set_org() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_contact_studios_set_org ON public.contact_studios;
CREATE TRIGGER trg_contact_studios_set_org
  BEFORE INSERT OR UPDATE ON public.contact_studios
  FOR EACH ROW EXECUTE FUNCTION private.contact_studios_set_org();

CREATE OR REPLACE FUNCTION private.contact_studios_freeze_keys()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    RAISE EXCEPTION 'contact_studios: a relationship never moves; insert a new row' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.contact_studios_freeze_keys() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_contact_studios_freeze_keys ON public.contact_studios;
CREATE TRIGGER trg_contact_studios_freeze_keys
  BEFORE UPDATE ON public.contact_studios
  FOR EACH ROW EXECUTE FUNCTION private.contact_studios_freeze_keys();

-- 3. The lifecycle rules, once.
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
      -- a Glofox account here: the contact's own at a Glofox home studio, or a crossover link here
      ((SELECT glofox_home_here FROM c)
        OR EXISTS (SELECT 1 FROM public.glofox_crossover_members gx WHERE gx.contact_id = p_contact_id AND gx.location_id = p_location_id)) AS glofox_account,
      -- a LIVE Glofox membership here (hasBookableMembership: member / credit_member, state active or unset)
      (((SELECT glofox_home_here FROM c)
         OR EXISTS (SELECT 1 FROM public.glofox_crossover_members gx WHERE gx.contact_id = p_contact_id AND gx.location_id = p_location_id))
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
        (SELECT min(gx.created_at) FROM public.glofox_crossover_members gx WHERE gx.contact_id = p_contact_id AND gx.location_id = p_location_id),
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
COMMENT ON FUNCTION public.derive_contact_studio(uuid, uuid) IS
  'ORGCONTACTS.1 (mig 764): the lifecycle rules of contact_studios, from the source rows at one studio (see the table comment). kind NULL = no relationship. Service role only.';
REVOKE EXECUTE ON FUNCTION public.derive_contact_studio(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.derive_contact_studio(uuid, uuid) TO service_role;

-- 4. One upsert, shared by the reconcile and the triggers: first_seen_at never
--    later, last_seen_at never earlier, ended_at set and cleared with status.
--    kind NULL ends an existing active row and writes nothing otherwise.
--    Returns 'inserted' | 'updated' | 'ended' | 'unchanged' | 'none'.
CREATE OR REPLACE FUNCTION private.contact_studios_upsert(p_contact_id uuid, p_location_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  d record;
  e record;
BEGIN
  SELECT * INTO d FROM public.derive_contact_studio(p_contact_id, p_location_id);
  SELECT * INTO e FROM public.contact_studios WHERE contact_id = p_contact_id AND location_id = p_location_id;
  IF d.kind IS NULL THEN
    IF FOUND AND e.status = 'active' THEN
      UPDATE public.contact_studios SET status = 'ended', ended_at = now()
       WHERE contact_id = p_contact_id AND location_id = p_location_id;
      RETURN 'ended';
    END IF;
    RETURN CASE WHEN FOUND THEN 'unchanged' ELSE 'none' END;
  END IF;
  IF NOT FOUND THEN
    INSERT INTO public.contact_studios (contact_id, location_id, organization_id, kind, status, source, stage_slug, first_seen_at, last_seen_at, ended_at)
    VALUES (p_contact_id, p_location_id, (SELECT organization_id FROM public.locations WHERE id = p_location_id),
            d.kind, d.status, d.source, d.stage_slug, d.first_seen_at, d.last_seen_at,
            CASE WHEN d.status = 'ended' THEN now() END);
    RETURN 'inserted';
  END IF;
  IF (e.kind, e.status, e.source, e.stage_slug) IS NOT DISTINCT FROM (d.kind, d.status, d.source, d.stage_slug)
     AND e.first_seen_at <= d.first_seen_at
     AND (d.last_seen_at IS NULL OR e.last_seen_at >= d.last_seen_at) THEN
    RETURN 'unchanged';
  END IF;
  UPDATE public.contact_studios
     SET kind = d.kind,
         status = d.status,
         source = d.source,
         stage_slug = d.stage_slug,
         first_seen_at = LEAST(first_seen_at, d.first_seen_at),
         last_seen_at = GREATEST(last_seen_at, d.last_seen_at),
         ended_at = CASE WHEN d.status = 'ended' THEN coalesce(ended_at, now()) ELSE NULL END
   WHERE contact_id = p_contact_id AND location_id = p_location_id;
  RETURN CASE WHEN e.status = 'active' AND d.status = 'ended' THEN 'ended' ELSE 'updated' END;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.contact_studios_upsert(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- 5. The reconcile: every (contact, studio) pair in the union of the sources,
--    one studio or all. Rows are never deleted.
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
        UNION SELECT gx.contact_id, gx.location_id FROM public.glofox_crossover_members gx
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
  'ORGCONTACTS.1 (mig 764): re-derive every contact_studios row (one studio, or all when NULL) from the source rows through derive_contact_studio(). The backfill and the nightly contact-studios-reconcile cron. Service role only.';
REVOKE EXECUTE ON FUNCTION public.reconcile_contact_studios(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_contact_studios(uuid) TO service_role;

-- 6. The three triggers. DEFINER: contact_studios is closed to every client,
--    and contacts / deals / contact_location_preferences are written by
--    service-role code, so the owner runs the upsert whoever fired the trigger.
CREATE OR REPLACE FUNCTION private.contact_studios_from_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.location_id IS NOT NULL THEN
    PERFORM private.contact_studios_upsert(NEW.id, NEW.location_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.contact_studios_from_contact() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS contact_studios_from_contact ON public.contacts;
CREATE TRIGGER contact_studios_from_contact
  AFTER INSERT ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION private.contact_studios_from_contact();

CREATE OR REPLACE FUNCTION private.contact_studios_from_deal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.contact_id IS NOT NULL AND OLD.location_id IS NOT NULL THEN
    PERFORM private.contact_studios_upsert(OLD.contact_id, OLD.location_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.contact_id IS NOT NULL AND NEW.location_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
    PERFORM private.contact_studios_upsert(NEW.contact_id, NEW.location_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE EXECUTE ON FUNCTION private.contact_studios_from_deal() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS contact_studios_from_deal ON public.deals;
CREATE TRIGGER contact_studios_from_deal
  AFTER INSERT OR UPDATE OR DELETE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION private.contact_studios_from_deal();

CREATE OR REPLACE FUNCTION private.contact_studios_from_preferences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM private.contact_studios_upsert(NEW.contact_id, NEW.location_id);
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.contact_studios_from_preferences() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS contact_studios_from_preferences ON public.contact_location_preferences;
CREATE TRIGGER contact_studios_from_preferences
  AFTER INSERT ON public.contact_location_preferences
  FOR EACH ROW EXECUTE FUNCTION private.contact_studios_from_preferences();

-- 7. The nightly reconcile's heartbeat row (03:30 PLATFORM_TZ; one missed
--    tick never pages: a day plus two hours of grace).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at, notes)
VALUES ('contact-studios-reconcile', 86400, 7200, now(),
        'ORGCONTACTS.1: nightly re-derive of contact_studios from the source rows (public.reconcile_contact_studios). STALE = the cron threw or the RPC failed every night for a day: read the cron log.')
ON CONFLICT (name) DO UPDATE
  SET expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- 8. The backfill: one reconcile of everything, then the self-check.
DO $$
DECLARE
  r record;
  v_rows int;
  v_pairs int;
  v_cross int;
BEGIN
  SELECT * INTO r FROM public.reconcile_contact_studios(NULL);

  -- a. every pair the sources name has a row (independently counted; the
  --    table may hold MORE: a relationship that vanished keeps its ended row)
  SELECT count(*) INTO v_rows FROM public.contact_studios;
  SELECT count(*) INTO v_pairs FROM (
    SELECT DISTINCT x.contact_id, x.location_id
      FROM (
        SELECT c.id AS contact_id, c.location_id FROM public.contacts c WHERE c.location_id IS NOT NULL
        UNION SELECT d.contact_id, d.location_id FROM public.deals d WHERE d.contact_id IS NOT NULL AND d.location_id IS NOT NULL
        UNION SELECT cm.contact_id, cm.location_id FROM public.contact_memberships cm
        UNION SELECT uc.contact_id, uc.location_id FROM public.un1t_clients uc WHERE uc.contact_id IS NOT NULL
        UNION SELECT gx.contact_id, gx.location_id FROM public.glofox_crossover_members gx
        UNION SELECT p.contact_id, p.location_id FROM public.contact_location_preferences p
      ) x JOIN public.contacts c ON c.id = x.contact_id
     WHERE NOT EXISTS (SELECT 1 FROM public.contact_studios cs WHERE cs.contact_id = x.contact_id AND cs.location_id = x.location_id)
  ) u;
  IF v_pairs <> 0 THEN
    RAISE EXCEPTION 'mig 764: % (contact, studio) pairs named by the sources have no contact_studios row', v_pairs;
  END IF;
  -- b. every row's organisation is its studio's and its contact's
  SELECT count(*) INTO v_cross
    FROM public.contact_studios cs
    JOIN public.locations l ON l.id = cs.location_id
    JOIN public.contacts c ON c.id = cs.contact_id
   WHERE cs.organization_id IS DISTINCT FROM l.organization_id OR cs.organization_id IS DISTINCT FROM c.organization_id;
  IF v_cross > 0 THEN
    RAISE EXCEPTION 'mig 764: % contact_studios rows cross an organisation', v_cross;
  END IF;
  -- c. the table: RLS on, no policy, no client privilege (column-level too)
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contact_studios'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contact_studios')
     OR has_any_column_privilege('anon', 'public.contact_studios', 'SELECT')
     OR has_any_column_privilege('authenticated', 'public.contact_studios', 'SELECT')
     OR has_any_column_privilege('authenticated', 'public.contact_studios', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.contact_studios', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.contact_studios', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.contact_studios', 'INSERT') THEN
    RAISE EXCEPTION 'mig 764: contact_studios must have RLS on, no policy, and no client privilege';
  END IF;
  -- d. the two public functions: service_role only; the trigger functions closed
  IF has_function_privilege('anon', 'public.derive_contact_studio(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.derive_contact_studio(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'public.derive_contact_studio(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.derive_contact_studio(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reconcile_contact_studios(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reconcile_contact_studios(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'public.reconcile_contact_studios(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.reconcile_contact_studios(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 764: EXECUTE on derive_contact_studio / reconcile_contact_studios must be service_role only';
  END IF;
  -- e. the triggers are in place
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('contact_studios_from_contact', 'contact_studios_from_deal', 'contact_studios_from_preferences',
                                                                             'trg_contact_studios_set_org', 'trg_contact_studios_freeze_keys')) <> 5 THEN
    RAISE EXCEPTION 'mig 764: not every contact_studios trigger is in place';
  END IF;
  -- f. the heartbeat row
  IF NOT EXISTS (SELECT 1 FROM public.cron_heartbeats WHERE name = 'contact-studios-reconcile' AND expected_interval_seconds = 86400 AND grace_seconds = 7200) THEN
    RAISE EXCEPTION 'mig 764: the contact-studios-reconcile heartbeat row did not land';
  END IF;

  RAISE NOTICE 'mig 764: contact_studios backfilled: % inserted, % updated, % ended, % unchanged; % contacts with no primary studio skipped; % rows; every source pair has a row.',
    r.inserted, r.updated, r.ended, r.unchanged, r.skipped_no_primary, v_rows;
END $$;

COMMIT;
