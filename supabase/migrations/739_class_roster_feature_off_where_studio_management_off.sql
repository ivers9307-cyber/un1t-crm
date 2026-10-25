-- UN1TBOOK.13 — switch the `class_roster` location feature OFF wherever
-- `studio_management` is already switched off.
--
-- WHY (controller ruling, Task 8 review): each permission key has its own
-- tier-1 switch (`locations.features[key] !== false`, shared/permissions.js).
-- CCF Autos and SourceIt carry `features.studio_management = false` (they have
-- no studio, so no live class) and have never heard of `class_roster`, which
-- UN1TBOOK.11 added. With the key unset, class_roster resolves ON there, so
-- the Members hub would show a "Live class" tab and /live/<id> would open for
-- a business that has no class. Setting the feature false mirrors the
-- studio_management decision those two locations already carry.
--
-- DATA ONLY: one UPDATE on locations.features, no schema, no grants.
-- A location that already states `class_roster` (either way) is untouched, and
-- so is one where `studio_management` is not explicitly false.
--
-- AFFECTED ROWS: exactly 2 on 17-18 Oct 2026 (CCF Autos, SourceIt).
--
-- IDEMPOTENT: the UPDATE only touches rows that still lack a `class_roster`
-- key, so a second run changes nothing (some repo guard tests replay later
-- migrations). The self-check is a POST-STATE check, not a count: after the
-- UPDATE the DO block raises if any location still has
-- `features.studio_management = false` and no `class_roster` key, which rolls
-- the transaction back.
--
-- grant: none (data only)

BEGIN;

DO $$
DECLARE
  v_left integer;
BEGIN
  UPDATE public.locations
     SET features = jsonb_set(coalesce(features, '{}'::jsonb), '{class_roster}', 'false'::jsonb)
   WHERE (features->>'studio_management') = 'false'
     AND (features ? 'class_roster') IS NOT TRUE;

  SELECT count(*) INTO v_left
    FROM public.locations
   WHERE (features->>'studio_management') = 'false'
     AND (features ? 'class_roster') IS NOT TRUE;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'mig 739: % location(s) still have studio_management off and no class_roster key', v_left;
  END IF;
END
$$;

COMMIT;
