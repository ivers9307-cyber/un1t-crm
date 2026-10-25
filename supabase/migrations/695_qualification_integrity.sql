-- 695 — REVIEWNITS.1 (D5): staff-qualification integrity the API alone could
-- not give (QUALS.1, mig 635), and one comment mig 634 got wrong.
--
-- NOT APPLIED YET when this file was written. Proven ahead of apply by
-- tests/migration-695-qualification-integrity.test.js (PGlite).
--
-- ===========================================================================
-- THE FINDINGS (QUALS.1 / SNAPSHOT.1 review nits, deferred at merge)
-- ===========================================================================
-- 1. A template may ask for at most 5 qualification types, but the cap lived
--    only in the API (src/lib/qualifications-server.js
--    replaceTemplateRequirements reads the current set, then deletes, then
--    upserts, as separate statements with no transaction). Two concurrent
--    saves that both read the same set each add their own 5: 10 rows.
-- 2. Mig 635 seeded First aid / Insurance / Garda vetting only for the
--    organisations that existed when it ran. An organisation created since
--    (POST /api/admin/organizations, or a master's browser through the
--    organizations_ins policy, mig 320) starts with an empty catalogue.
-- 3. Mig 634's header, function comment and RAISE text say the snapshot
--    delete trigger lets through only the location cascade. The code tests
--    pg_trigger_depth() >= 2, which lets through ANY delete fired from inside
--    another trigger. Mig 634 is applied and is not edited (its md5 is the
--    apply record); the correction lives on the function as a COMMENT.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
-- 1. AFTER INSERT OR UPDATE OF template_id trigger on
--    shift_template_qualification_requirements: lock the template row
--    (FOR NO KEY UPDATE, so concurrent writers of one template's set queue
--    behind each other; NOT FOR UPDATE, which conflicts with the KEY SHARE
--    each writer's FK check already holds and would deadlock two saves),
--    then count the template's rows on a fresh snapshot and refuse more than
--    5 with 'qualification_requirements_cap: …' (the API answers it 400 "At
--    most 5 qualifications"). AFTER ROW triggers fire at the end of the
--    statement, so one 6-row insert is refused too. The API deletes before
--    it adds, so a replace within the cap never trips it.
-- 2. AFTER INSERT trigger on organizations seeds the three types (ON
--    CONFLICT DO NOTHING), whoever inserts; SECURITY DEFINER in private
--    (the catalogue is service-role only), search_path pinned, EXECUTE
--    revoked from PUBLIC/anon/authenticated (a trigger fires without it).
--    Plus 635's backfill again: an organisation with no types at all gets
--    the three (a no-op on prod if every organisation predates 635).
-- 3. COMMENT ON FUNCTION public.roster_publish_snapshots_refuse_delete().
--
-- LOCKS: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on organizations and on
-- shift_template_qualification_requirements (brief; lock_timeout 5s).
-- REPLAYING THIS FILE IS A NO-OP (CREATE OR REPLACE FUNCTION, DROP TRIGGER IF
-- EXISTS + CREATE, the backfill only for an organisation with no types).
-- One explicit transaction: a failed self-check leaves NOTHING applied.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; keep the output in the scratchpad)
-- ─────────────────────────────────────────────────────────────────────────
-- (a) No template over the cap (the self-check refuses the apply otherwise):
--       SELECT template_id, count(*) FROM public.shift_template_qualification_requirements
--        GROUP BY 1 HAVING count(*) > 5;                       -- expect 0 rows
-- (b) Organisations with no types (the backfill seeds these):
--       SELECT o.id FROM public.organizations o WHERE NOT EXISTS (
--         SELECT 1 FROM public.staff_qualification_types t WHERE t.organization_id = o.id);
-- (c) Nothing by these names yet:
--       SELECT tgname FROM pg_trigger WHERE tgname IN
--         ('shift_template_qualification_cap', 'organizations_seed_qualification_types');
--
-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK (nothing stored depends on it; the API keeps its own cap)
-- ─────────────────────────────────────────────────────────────────────────
--   BEGIN;
--   DROP TRIGGER IF EXISTS shift_template_qualification_cap ON public.shift_template_qualification_requirements;
--   DROP TRIGGER IF EXISTS organizations_seed_qualification_types ON public.organizations;
--   DROP FUNCTION IF EXISTS private.shift_template_qualification_cap();
--   DROP FUNCTION IF EXISTS private.seed_staff_qualification_types();
--   COMMIT;
--   (Seeded types stay: an owner may already have used them. The function
--   comment is documentation only.)
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. The 5-requirements cap, in the table ──────────────────────────────
CREATE OR REPLACE FUNCTION private.shift_template_qualification_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n integer;
BEGIN
  -- Serialise the writers of one template's set (see the header: NO KEY
  -- UPDATE, never FOR UPDATE).
  PERFORM 1 FROM public.shift_templates WHERE id = NEW.template_id FOR NO KEY UPDATE;
  SELECT count(*) INTO n
    FROM public.shift_template_qualification_requirements
   WHERE template_id = NEW.template_id;
  IF n > 5 THEN
    RAISE EXCEPTION 'qualification_requirements_cap: template % would ask for % qualifications (max 5)', NEW.template_id, n;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.shift_template_qualification_cap() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS shift_template_qualification_cap ON public.shift_template_qualification_requirements;
CREATE TRIGGER shift_template_qualification_cap
  AFTER INSERT OR UPDATE OF template_id ON public.shift_template_qualification_requirements
  FOR EACH ROW EXECUTE FUNCTION private.shift_template_qualification_cap();

-- ── 2. A new organisation gets the three types ───────────────────────────
CREATE OR REPLACE FUNCTION private.seed_staff_qualification_types()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.staff_qualification_types (organization_id, name, sort_order)
  VALUES (NEW.id, 'First aid', 10), (NEW.id, 'Insurance', 20), (NEW.id, 'Garda vetting', 30)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.seed_staff_qualification_types() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organizations_seed_qualification_types ON public.organizations;
CREATE TRIGGER organizations_seed_qualification_types
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION private.seed_staff_qualification_types();

-- Mig 635's seed again, for an organisation created since it ran.
INSERT INTO public.staff_qualification_types (organization_id, name, sort_order)
SELECT o.id, s.name, s.sort_order
  FROM public.organizations o
 CROSS JOIN (VALUES ('First aid', 10), ('Insurance', 20), ('Garda vetting', 30)) AS s(name, sort_order)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.staff_qualification_types t WHERE t.organization_id = o.id
 );

-- ── 3. What mig 634's delete trigger really lets through ─────────────────
COMMENT ON FUNCTION public.roster_publish_snapshots_refuse_delete() IS
  'SNAPSHOT.1 (mig 634; corrected by mig 695) — refuses a direct DELETE and every TRUNCATE of roster_publish_snapshots. It lets through ANY delete fired from inside another trigger (pg_trigger_depth() >= 2), not only the cascade from a deleted location: that cascade is the only such path today, but a future trigger that deletes these rows would pass too.';

-- ── Self-check (POST-state, from the catalog, never from this text) ──────
DO $$
BEGIN
  PERFORM 1
     FROM pg_trigger tg
     JOIN pg_proc pr ON pr.oid = tg.tgfoid
    WHERE tg.tgrelid = 'public.shift_template_qualification_requirements'::regclass
      AND tg.tgname = 'shift_template_qualification_cap'
      AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'
      AND pr.proname = 'shift_template_qualification_cap'
      AND pr.pronamespace = 'private'::regnamespace AND pr.prosecdef;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 695: the cap trigger is missing, disabled or not SECURITY DEFINER; nothing was applied';
  END IF;

  PERFORM 1
     FROM pg_trigger tg
     JOIN pg_proc pr ON pr.oid = tg.tgfoid
    WHERE tg.tgrelid = 'public.organizations'::regclass
      AND tg.tgname = 'organizations_seed_qualification_types'
      AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'
      AND pr.proname = 'seed_staff_qualification_types'
      AND pr.pronamespace = 'private'::regnamespace AND pr.prosecdef;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 695: the organisation seed trigger is missing, disabled or not SECURITY DEFINER; nothing was applied';
  END IF;

  IF has_function_privilege('anon', 'private.shift_template_qualification_cap()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.shift_template_qualification_cap()', 'EXECUTE')
     OR has_function_privilege('anon', 'private.seed_staff_qualification_types()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.seed_staff_qualification_types()', 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 695: a client role can execute a new trigger function; nothing was applied';
  END IF;

  PERFORM 1 FROM public.shift_template_qualification_requirements
   GROUP BY template_id HAVING count(*) > 5;
  IF FOUND THEN
    RAISE EXCEPTION 'mig 695: a template already asks for more than 5 qualifications (pre-apply check a); nothing was applied';
  END IF;

  PERFORM 1 FROM public.organizations o
   WHERE NOT EXISTS (SELECT 1 FROM public.staff_qualification_types q WHERE q.organization_id = o.id);
  IF FOUND THEN
    RAISE EXCEPTION 'mig 695: an organisation has no qualification types after the backfill; nothing was applied';
  END IF;
END $$;

COMMIT;
