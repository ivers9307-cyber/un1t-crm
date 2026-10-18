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
-- SELF-CHECK: the ruling was made against live data where exactly 2 locations
-- match. The DO block raises unless the UPDATE touched exactly 2 rows, so the
-- whole transaction rolls back if live data has moved since. That also makes a
-- second run raise (0 rows), which is the safe direction for a one-shot.
--
-- grant: none (data only)

BEGIN;

DO $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.locations
     SET features = jsonb_set(coalesce(features, '{}'::jsonb), '{class_roster}', 'false'::jsonb)
   WHERE (features->>'studio_management') = 'false'
     AND (features ? 'class_roster') IS NOT TRUE;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'mig 739: expected to switch class_roster off at exactly 2 locations (CCF Autos, SourceIt), touched %', v_rows;
  END IF;
END
$$;

COMMIT;
