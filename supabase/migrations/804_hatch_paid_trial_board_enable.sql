-- 804 HATCH39.5b — UN1T Hatch Street: switch the €39 Trial board ON.
-- Spec: docs/superpowers/specs/2026-11-01-hatch-paid-trial-board-design.md
--
-- 🔴 APPLY ONLY AFTER the dry run (spec, Rollout step 3): mig 803 applied, the
-- HATCH39 code deployed, and Richard has read the board_histogram and
-- movement_matrix of
--   POST /api/admin/pipeline-reclassify { location_id: <Hatch>, dry_run: true, include_disabled: ['paid_trial'] }.
-- The next hourly un1t pass then moves the cards.
--
-- DATA ONLY: pipelines.enabled on the one row. is_primary does not move
-- (Acquisition stays the primary since mig 803). The self-check fails the
-- transaction if the board is missing (803 not applied) or if Acquisition is
-- not still the one enabled primary.
--
-- IDEMPOTENT: the write sets a value.
--
-- grant: none (no new relation)

BEGIN;

DO $$
DECLARE
  v_hatch   constant uuid := '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';  -- UN1T Hatch Street
  v_n       int;
  v_others  text;
  v_others_after text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pipelines WHERE location_id = v_hatch AND key = 'paid_trial' AND module = 'paid_trial_un1t') THEN
    RAISE EXCEPTION 'HATCH39.5b: Hatch has no €39 Trial board (mig 803 not applied)';
  END IF;

  SELECT md5(coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), ''))
    INTO v_others FROM public.pipelines p
   WHERE NOT (p.location_id = v_hatch AND p.key = 'paid_trial');

  UPDATE public.pipelines
     SET enabled = true
   WHERE location_id = v_hatch AND key = 'paid_trial';

  SELECT count(*) INTO v_n FROM public.pipelines WHERE location_id = v_hatch AND is_primary AND enabled;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'HATCH39.5b: Hatch must have exactly one enabled primary board, found %', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pipelines WHERE location_id = v_hatch AND key = 'acquisition' AND is_primary AND enabled) THEN
    RAISE EXCEPTION 'HATCH39.5b: Hatch acquisition is not the enabled primary';
  END IF;
  SELECT count(*) INTO v_n FROM public.pipelines WHERE location_id = v_hatch AND enabled;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'HATCH39.5b: expected two enabled Hatch boards (acquisition, paid_trial), found %', v_n;
  END IF;

  SELECT md5(coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), ''))
    INTO v_others_after FROM public.pipelines p
   WHERE NOT (p.location_id = v_hatch AND p.key = 'paid_trial');
  IF v_others_after <> v_others THEN
    RAISE EXCEPTION 'HATCH39.5b: a pipelines row outside the €39 board changed';
  END IF;
END $$;

COMMIT;
