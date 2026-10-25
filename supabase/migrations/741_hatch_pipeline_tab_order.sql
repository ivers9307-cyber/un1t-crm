-- HATCHPIPE.4 — UN1T Hatch Street opens on its Acquisition board.
-- Requested by the owner on 18 Oct 2026, after the acquisition board went
-- live (mig 740 / #2099).
--
-- DATA ONLY, Hatch only, one transaction. The pipeline page's tabs and its
-- default board come from `pipelines.display_order`: with no ?pipeline= it
-- opens the first ENABLED board (src/app/(sales)/pipeline/page.js), and the
-- phone orders the same way (mobile/lib/pipeline-api.js). So the whole change
-- is two display_order values at Hatch:
--   acquisition  1 -> 0
--   waitlist     0 -> 1
--
-- 🔴 `is_primary` DOES NOT MOVE. The waitlist stays Hatch's primary board. The
-- primary decides `contacts.pipeline_stage_slug` (mig 736) and the phone's
-- default deal lookup, and neither may change. Nothing here assigns
-- is_primary, `pipelines_one_primary_per_location` is never in play, and the
-- self-check below fails the whole transaction if the waitlist is not still
-- the one enabled primary afterwards.
--
-- No stage, deal or contact is written. No other location is touched.
--
-- IDEMPOTENT: every write sets a value, so a second run changes nothing and
-- passes the same self-check (some repo guard tests replay migrations).
--
-- SELF-CHECK is POST-STATE invariants (the mig 739/740 shape), so a replay on
-- later data still passes. Any failing raises and rolls the transaction back:
--   1. Hatch has both rows to flip (checked before writing);
--   2. acquisition is at 0 and waitlist is at 1;
--   3. exactly one enabled primary at Hatch, and it is the waitlist;
--   4. the two rows differ from their before-state in display_order ONLY;
--   5. no other pipelines row changed (no other location, no other Hatch board);
--   6. no pipeline_stages, deals or contacts row changed.
--
-- grant: none (no new relation)

BEGIN;

DO $$
DECLARE
  v_hatch          constant uuid := '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';  -- UN1T Hatch Street
  v_acq            uuid;
  v_wait           uuid;
  v_pair_hash      text;
  v_others_hash    text;
  v_stages_hash    text;
  v_deals_hash     text;
  v_contacts_hash  text;
  v_n              int;
BEGIN
  SELECT id INTO v_acq FROM public.pipelines
   WHERE location_id = v_hatch AND key = 'acquisition';
  IF v_acq IS NULL THEN
    RAISE EXCEPTION 'HATCHPIPE.4: Hatch has no acquisition pipelines row';
  END IF;
  SELECT id INTO v_wait FROM public.pipelines
   WHERE location_id = v_hatch AND key = 'waitlist';
  IF v_wait IS NULL THEN
    RAISE EXCEPTION 'HATCHPIPE.4: Hatch has no waitlist pipelines row';
  END IF;

  -- ── Before: what must not move ────────────────────────────────────────────
  -- The two boards, every column but display_order.
  SELECT md5(coalesce(string_agg((to_jsonb(p) - 'display_order')::text, ',' ORDER BY p.id), ''))
    INTO v_pair_hash FROM public.pipelines p WHERE p.id IN (v_acq, v_wait);
  -- Every other pipelines row, whole.
  SELECT md5(coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), ''))
    INTO v_others_hash FROM public.pipelines p WHERE p.id NOT IN (v_acq, v_wait);
  SELECT md5(coalesce(string_agg(row_to_json(s)::text, ',' ORDER BY s.id), ''))
    INTO v_stages_hash FROM public.pipeline_stages s;
  SELECT md5(coalesce(string_agg(concat_ws('|', id, stage_id, pipeline_id, status, updated_at), ',' ORDER BY id), ''))
    INTO v_deals_hash FROM public.deals;
  SELECT md5(coalesce(string_agg(concat_ws('|', id, pipeline_stage_slug, updated_at), ',' ORDER BY id), ''))
    INTO v_contacts_hash FROM public.contacts;

  -- ── Writes ────────────────────────────────────────────────────────────────
  -- display_order and nothing else. is_primary is deliberately absent.
  UPDATE public.pipelines
     SET display_order = 0
   WHERE id = v_acq AND location_id = v_hatch;
  UPDATE public.pipelines
     SET display_order = 1
   WHERE id = v_wait AND location_id = v_hatch;

  -- ── After: post-state invariants ──────────────────────────────────────────
  -- 2. The new order.
  IF NOT EXISTS (SELECT 1 FROM public.pipelines WHERE id = v_acq AND display_order = 0) THEN
    RAISE EXCEPTION 'HATCHPIPE.4: Hatch acquisition is not at display_order 0';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pipelines WHERE id = v_wait AND display_order = 1) THEN
    RAISE EXCEPTION 'HATCHPIPE.4: Hatch waitlist is not at display_order 1';
  END IF;

  -- 3. Waitlist is still the one enabled primary.
  SELECT count(*) INTO v_n FROM public.pipelines
   WHERE location_id = v_hatch AND enabled AND is_primary;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'HATCHPIPE.4: Hatch has % enabled primary boards, expected exactly 1', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pipelines
     WHERE id = v_wait AND enabled AND is_primary
  ) THEN
    RAISE EXCEPTION 'HATCHPIPE.4: the waitlist board is not Hatch''s enabled primary';
  END IF;

  -- 4. The two rows changed in display_order only.
  IF (SELECT md5(coalesce(string_agg((to_jsonb(p) - 'display_order')::text, ',' ORDER BY p.id), ''))
        FROM public.pipelines p WHERE p.id IN (v_acq, v_wait))
     IS DISTINCT FROM v_pair_hash THEN
    RAISE EXCEPTION 'HATCHPIPE.4: a Hatch acquisition or waitlist column other than display_order changed';
  END IF;

  -- 5. No other pipelines row changed.
  IF (SELECT md5(coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), ''))
        FROM public.pipelines p WHERE p.id NOT IN (v_acq, v_wait))
     IS DISTINCT FROM v_others_hash THEN
    RAISE EXCEPTION 'HATCHPIPE.4: a pipelines row outside Hatch''s acquisition and waitlist changed';
  END IF;

  -- 6. No stage, deal or contact written.
  IF (SELECT md5(coalesce(string_agg(row_to_json(s)::text, ',' ORDER BY s.id), ''))
        FROM public.pipeline_stages s) IS DISTINCT FROM v_stages_hash THEN
    RAISE EXCEPTION 'HATCHPIPE.4: a pipeline_stages row changed; this migration writes no stages';
  END IF;
  IF (SELECT md5(coalesce(string_agg(concat_ws('|', id, stage_id, pipeline_id, status, updated_at), ',' ORDER BY id), ''))
        FROM public.deals) IS DISTINCT FROM v_deals_hash THEN
    RAISE EXCEPTION 'HATCHPIPE.4: a deals row changed; this migration writes no deals';
  END IF;
  IF (SELECT md5(coalesce(string_agg(concat_ws('|', id, pipeline_stage_slug, updated_at), ',' ORDER BY id), ''))
        FROM public.contacts) IS DISTINCT FROM v_contacts_hash THEN
    RAISE EXCEPTION 'HATCHPIPE.4: a contacts row changed; this migration writes no contacts';
  END IF;
END
$$;

COMMIT;
