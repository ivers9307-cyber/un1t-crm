-- 767 — ORGCONTACTS.4: person groups follow the organisation (spec 2026-10-20 §2.4).
--
-- A person is one contact per organisation (mig 712: email unique per
-- organisation) and a person group links the accounts one person holds across
-- that organisation's studios (a ClassPass placeholder and the real account, a
-- Stillorgan member who also enquired at Hatch). The group's scope is the
-- organisation, not the studio it happened to be created at; location_id was
-- the studio of the first link and nothing reads it as a fence any more
-- (/api/contacts/[id]/link refuses across ORGANISATIONS since this PR).
--
-- WHAT. person_groups.organization_id uuid REFERENCES organizations(id),
-- backfilled from the group's location, SET NOT NULL, indexed. location_id
-- stays for one release (DEPRECATED, dropped in mig 768) so code can roll back
-- without DB action. A BEFORE INSERT trigger fills organization_id from
-- location_id when a writer still omits it (createGroup before this deploy)
-- and refuses a row whose organisation disagrees with its location; dropped
-- with the column in 768. person_groups and person_group_members stay as mig
-- 681 left them: RLS on, no policy, no client privilege (self-checked).
--
-- Forward-only; proven ahead of apply by
-- tests/migration-767-person-groups-organization.test.js (PGlite).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Pre-checks.
DO $$
BEGIN
  IF to_regclass('public.person_groups') IS NULL THEN
    RAISE EXCEPTION 'mig 767: public.person_groups is missing; re-plan';
  END IF;
  IF to_regclass('public.organizations') IS NULL OR to_regclass('public.locations') IS NULL THEN
    RAISE EXCEPTION 'mig 767: organizations / locations are missing; re-plan';
  END IF;
END $$;

-- 1. The column, backfilled from the group's studio.
ALTER TABLE public.person_groups ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id);

UPDATE public.person_groups g
   SET organization_id = l.organization_id
  FROM public.locations l
 WHERE l.id = g.location_id AND g.organization_id IS NULL;

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.person_groups WHERE organization_id IS NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'mig 767: % person_groups rows have no organisation (their location has none); give the locations an organisation first', v_n;
  END IF;
END $$;

ALTER TABLE public.person_groups ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_person_groups_organization ON public.person_groups (organization_id);
COMMENT ON COLUMN public.person_groups.organization_id IS
  'ORGCONTACTS.4 (mig 767): the organisation the group''s contacts belong to; the group''s scope.';
COMMENT ON COLUMN public.person_groups.location_id IS
  'DEPRECATED (mig 767): groups follow the organisation; dropped in mig 768';

-- 2. The fill trigger (until the code that names organization_id deploys) and
--    the fence: a group never belongs to a different organisation than its studio.
CREATE OR REPLACE FUNCTION private.person_groups_set_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_loc_org uuid;
BEGIN
  SELECT organization_id INTO v_loc_org FROM public.locations WHERE id = NEW.location_id;
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := v_loc_org;
  END IF;
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'person_groups: no organisation for location %', NEW.location_id;
  END IF;
  IF v_loc_org IS NOT NULL AND v_loc_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'person_groups: organization_id % does not match the location''s organisation %', NEW.organization_id, v_loc_org;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.person_groups_set_org() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS person_groups_set_org ON public.person_groups;
CREATE TRIGGER person_groups_set_org
  BEFORE INSERT ON public.person_groups
  FOR EACH ROW EXECUTE FUNCTION private.person_groups_set_org();

-- 3. Self-check: the catalog, never this file.
DO $$
BEGIN
  IF (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = 'organization_id') <> 'NO' THEN
    RAISE EXCEPTION 'mig 767: person_groups.organization_id is nullable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_person_groups_organization') THEN
    RAISE EXCEPTION 'mig 767: idx_person_groups_organization is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.person_groups'::regclass AND tgname = 'person_groups_set_org' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'mig 767: the person_groups_set_org trigger is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.person_groups g JOIN public.locations l ON l.id = g.location_id WHERE l.organization_id IS DISTINCT FROM g.organization_id) THEN
    RAISE EXCEPTION 'mig 767: a person_groups row disagrees with its location''s organisation';
  END IF;
  -- mig 681's state, restated: closed to clients, RLS on, no policy.
  IF has_table_privilege('anon', 'public.person_groups', 'SELECT') OR has_table_privilege('authenticated', 'public.person_groups', 'SELECT')
     OR has_table_privilege('anon', 'public.person_group_members', 'SELECT') OR has_table_privilege('authenticated', 'public.person_group_members', 'SELECT') THEN
    RAISE EXCEPTION 'mig 767: a client role can read person_groups / person_group_members (mig 681 closed them)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('person_groups', 'person_group_members')) THEN
    RAISE EXCEPTION 'mig 767: a policy exists on person_groups / person_group_members (mig 681 dropped them)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.person_groups'::regclass) THEN
    RAISE EXCEPTION 'mig 767: row level security is off on person_groups';
  END IF;
  RAISE NOTICE 'mig 767: person_groups.organization_id set on % groups; fill trigger live; closed to clients.', (SELECT count(*) FROM public.person_groups);
END $$;

COMMIT;
