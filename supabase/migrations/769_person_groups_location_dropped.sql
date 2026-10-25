-- 769 — ORGCONTACTS.6: person_groups.location_id and the 767 fill trigger go.
--
-- WHY. A person group follows the ORGANISATION since mig 767 (organization_id
-- NOT NULL, the fence createGroup and the link route use). location_id was
-- DEPRECATED there, nullable since mig 768, written by createGroup "for one
-- release more". That release shipped (#2172); createGroup no longer names
-- the column (src/lib/person-links.js), so the column, its index (mig 270)
-- and the BEFORE INSERT fill trigger of 767 (which read NEW.location_id to
-- fill and fence organization_id) have nothing left to do. The organisation
-- column's NOT NULL is the fence now.
--
-- APPLY AFTER the code of this PR deploys: prod's previous code wrote
-- location_id on every group insert and would fail on a dropped column. The
-- pre-check refuses the file while 768 has not made the column nullable.
--
-- Proven by tests/migration-769-person-groups-location-dropped.test.js (PGlite).
--
-- ROLLBACK RECORD (forward migration; the column's values are not restorable
-- beyond the primary contact's studio):
-- ALTER TABLE public.person_groups ADD COLUMN location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE;
-- UPDATE public.person_groups g SET location_id = c.location_id FROM public.contacts c WHERE c.id = g.primary_contact_id;
-- CREATE INDEX idx_person_groups_location ON public.person_groups(location_id);
-- then re-run mig 767's section 2 (the fill trigger and its function).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Pre-checks.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = 'organization_id')
     OR (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = 'organization_id') <> 'NO' THEN
    RAISE EXCEPTION 'mig 769: apply 767 first (person_groups.organization_id NOT NULL)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = 'location_id' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'mig 769: apply 768 first (location_id is still NOT NULL, so the code may still write it)';
  END IF;
END $$;

-- 1. The fill trigger and its function (767 §2). Nothing else is dropped
--    here: the organisation fence is the NOT NULL column.
DROP TRIGGER IF EXISTS person_groups_set_org ON public.person_groups;
DROP FUNCTION IF EXISTS private.person_groups_set_org();

-- 2. The column and mig 270's index. A view or policy still naming the column
--    makes Postgres refuse the drop (no CASCADE on purpose).
DROP INDEX IF EXISTS public.idx_person_groups_location;
ALTER TABLE public.person_groups DROP COLUMN IF EXISTS location_id;

-- 3. Self-check: the catalog, never this file.
DO $$
DECLARE
  v_triggers text[];
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = 'location_id') THEN
    RAISE EXCEPTION 'mig 769: person_groups.location_id is still there';
  END IF;
  IF to_regprocedure('private.person_groups_set_org()') IS NOT NULL THEN
    RAISE EXCEPTION 'mig 769: private.person_groups_set_org() is still there';
  END IF;
  -- Only the 767 trigger goes; mig 334's trg_sync_group_primary_flags stays (prod, 25 Oct 2026).
  SELECT array_agg(tgname::text ORDER BY tgname) INTO v_triggers FROM pg_trigger WHERE tgrelid = 'public.person_groups'::regclass AND NOT tgisinternal;
  IF 'person_groups_set_org' = ANY (coalesce(v_triggers, ARRAY[]::text[])) THEN
    RAISE EXCEPTION 'mig 769: the 767 fill trigger is still on person_groups (%)', v_triggers;
  END IF;
  IF (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = 'organization_id') <> 'NO' THEN
    RAISE EXCEPTION 'mig 769: person_groups.organization_id must stay NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_schema = 'public' AND table_name = 'person_groups' AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 769: person_groups must stay closed to client sessions';
  END IF;
  RAISE NOTICE 'mig 769: person_groups.location_id, its index and the 767 fill trigger are gone; the organisation is the fence.';
END $$;

COMMIT;
