-- 798 PIPE3.4b — UN1T Stillorgan: switch the €39 Trial and Programmes boards ON.
-- Spec: docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md
--
-- 🔴 APPLY ONLY AFTER the dry run (spec, Rollout step 3): mig 797 applied, the
-- PIPE3 code deployed, and Richard has read the board_histogram and
-- movement_matrix of
--   POST /api/admin/pipeline-reclassify { dry_run: true, include_disabled: ['paid_trial','programmes'] }.
-- The next nightly run (or a manual run) then moves the deals.
--
-- DATA ONLY: pipelines.enabled on the two rows, and the same pack-stamp clear
-- as mig 797 — a Glofox sync that ran between 797 and the deploy could have
-- re-stamped the €39 buyer from the trial's own credits.
--
-- is_primary DOES NOT MOVE (acquisition stays the primary, mig 736). The
-- self-check fails the transaction if the acquisition board is not still the
-- one enabled primary, or if either board is missing (797 not applied).
--
-- IDEMPOTENT: both writes set a value.
--
-- grant: none (no new relation)

BEGIN;

DO $$
DECLARE
  v_still      constant uuid := 'a0000000-0000-0000-0000-000000000001';  -- UN1T Stillorgan
  v_n          int;
  v_primary    text;
  v_others     text;
  v_others_after text;
BEGIN
  SELECT count(*) INTO v_n FROM public.pipelines
   WHERE location_id = v_still AND key IN ('paid_trial', 'programmes');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'PIPE3.4b: expected the two Stillorgan boards from mig 797, found %', v_n;
  END IF;

  SELECT md5(coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), ''))
    INTO v_others FROM public.pipelines p
   WHERE NOT (p.location_id = v_still AND p.key IN ('paid_trial', 'programmes'));

  UPDATE public.pipelines
     SET enabled = true
   WHERE location_id = v_still AND key IN ('paid_trial', 'programmes');

  UPDATE public.contacts c
     SET pack_customer_at = NULL
    FROM public.trial_purchases tp
   WHERE tp.contact_id = c.id
     AND tp.location_id = v_still
     AND tp.status = 'granted'
     AND tp.paid_at IS NOT NULL
     AND c.pack_customer_at IS NOT NULL
     AND c.pack_customer_at >= tp.paid_at;

  SELECT count(*) INTO v_n FROM public.pipelines WHERE location_id = v_still AND is_primary AND enabled;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'PIPE3.4b: Stillorgan must have exactly one enabled primary board, found %', v_n;
  END IF;
  SELECT key INTO v_primary FROM public.pipelines WHERE location_id = v_still AND is_primary AND enabled;
  IF v_primary <> 'acquisition' THEN
    RAISE EXCEPTION 'PIPE3.4b: Stillorgan primary is % (expected acquisition)', v_primary;
  END IF;
  SELECT count(*) INTO v_n FROM public.pipelines
   WHERE location_id = v_still AND enabled AND key IN ('acquisition', 'paid_trial', 'programmes');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'PIPE3.4b: expected three enabled Stillorgan boards, found %', v_n;
  END IF;

  SELECT md5(coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), ''))
    INTO v_others_after FROM public.pipelines p
   WHERE NOT (p.location_id = v_still AND p.key IN ('paid_trial', 'programmes'));
  IF v_others_after <> v_others THEN
    RAISE EXCEPTION 'PIPE3.4b: a pipelines row outside the two boards changed';
  END IF;
END $$;

COMMIT;
