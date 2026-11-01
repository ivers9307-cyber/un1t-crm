-- 797 PIPE3.4 — UN1T Stillorgan: the €39 Trial and Programmes boards (seeded
-- DISABLED), the pipeline_board_claims table, the programme-rules setting, the
-- claim backfill and the pack-stamp clear.
-- Spec: docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md
--
-- Apply BEFORE the PIPE3 code deploys. A disabled board renders nowhere and the
-- orchestrator ignores it, so this file is inert until mig 798 enables the two
-- rows — which happens only after Richard has read a dry run (spec, Rollout).
--
-- WHY. Stillorgan sells three journeys and the pipeline showed one: the €39
-- 14-day trial buyers and the 50+ / pre-post-natal programme leads were
-- squeezed through the free 3-class funnel's columns. Each gets its own board
-- (Richard, 31 Oct 2026). One router (shared/pipelines/router.js) decides a
-- person's board; a person is on one board at a time.
--
-- pipeline_board_claims: the Programmes board's entry match is made ONCE and
-- recorded here, because Glofox overwrites contacts.glofox_membership_plan on
-- every sync — a 50+ lead who joins stops matching "Elites Trial" at the exact
-- moment they should enter Converted. The paid trial needs no row: its
-- trial_purchases row is the claim. Service role only: written by the router
-- (src/lib/pipeline-claims.js), read by the nightly pass and the webhook path.
--
-- pack_customer_at clear: the 14 Day Reset lands as 10 Glofox credits and
-- shouldStampPackCustomer files 4+ credits on a non-member as a Class Pack
-- (write-once, sticky). The one synced buyer (2026-10-30) was stamped four
-- minutes after the grant and sat in the Class Pack pile. The stamp is cleared
-- for every granted buyer whose stamp landed after they paid; the PIPE3 sync
-- change stops it being re-made while a claim is live (mig 798 clears again,
-- for any sync that runs between this file and that deploy).
--
-- is_primary DOES NOT MOVE. Acquisition stays Stillorgan's primary (it owns
-- contacts.pipeline_stage_slug's first tier, mig 736). Nothing here assigns
-- is_primary; the self-check fails the whole transaction if the acquisition
-- board is not still the one enabled primary afterwards.
--
-- IDEMPOTENT: every insert conflict-targets its natural key and the re-run
-- never touches `enabled` or `is_primary` on an existing row (so a board an
-- operator switched off stays off); the settings seed writes only when the
-- programmes key is absent; the backfill is ON CONFLICT DO NOTHING.
--
-- grant: pipeline_board_claims is service role only (REVOKE below); no client
-- session reads or writes it.

BEGIN;

-- ── 1. The claims table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pipeline_board_claims (
  contact_id   uuid        NOT NULL REFERENCES public.contacts(id)  ON DELETE CASCADE,
  location_id  uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  board_key    text        NOT NULL,
  claimed_at   timestamptz NOT NULL,
  source       text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, location_id, board_key)
);
CREATE INDEX IF NOT EXISTS pipeline_board_claims_location_board_idx
  ON public.pipeline_board_claims (location_id, board_key);
COMMENT ON TABLE public.pipeline_board_claims IS
  'PIPE3.4 (mig 797): a recorded board claim per (contact, studio, board). The Programmes board''s entry match (a landing-page lead source or a Glofox trial plan name, locations.settings.pipelines.programmes) is made once and kept here, because Glofox overwrites the plan name on every sync. Read and written by the router (src/lib/pipeline-claims.js). Service role only.';
ALTER TABLE public.pipeline_board_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_board_claims FROM anon, authenticated;

-- ── 2. Boards, stages, setting, backfills, self-check ─────────────────────
DO $$
DECLARE
  v_still        constant uuid := 'a0000000-0000-0000-0000-000000000001';  -- UN1T Stillorgan
  v_paid         uuid;
  v_prog         uuid;
  v_n            int;
  v_others_hash  text;
  v_others_after text;
  v_deals_hash   text;
  v_deals_after  text;
  v_primary_key  text;
BEGIN
  -- Precondition: the acquisition board is Stillorgan's enabled primary.
  IF NOT EXISTS (
    SELECT 1 FROM public.pipelines
     WHERE location_id = v_still AND key = 'acquisition' AND is_primary AND enabled
  ) THEN
    RAISE EXCEPTION 'PIPE3.4: Stillorgan has no enabled primary acquisition board';
  END IF;

  -- Before: every pipelines row that is not one of the two Stillorgan boards,
  -- and every deals row. Neither may change.
  SELECT md5(coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), ''))
    INTO v_others_hash
    FROM public.pipelines p
   WHERE NOT (p.location_id = v_still AND p.key IN ('paid_trial', 'programmes'));
  SELECT md5(coalesce(string_agg(concat_ws('|', id, contact_id, stage_id, pipeline_id, status, updated_at), ',' ORDER BY id), ''))
    INTO v_deals_hash FROM public.deals;

  -- The two boards, DISABLED. A re-run touches module and mode only.
  INSERT INTO public.pipelines (location_id, key, name, module, mode, is_primary, display_order, enabled)
  VALUES (v_still, 'paid_trial', '€39 Trial', 'paid_trial', 'derived', false, 1, false)
  ON CONFLICT (location_id, key) DO UPDATE SET module = EXCLUDED.module, mode = 'derived'
  RETURNING id INTO v_paid;

  INSERT INTO public.pipelines (location_id, key, name, module, mode, is_primary, display_order, enabled)
  VALUES (v_still, 'programmes', 'Programmes', 'programmes', 'derived', false, 2, false)
  ON CONFLICT (location_id, key) DO UPDATE SET module = EXCLUDED.module, mode = 'derived'
  RETURNING id INTO v_prog;

  IF v_paid IS NULL OR v_prog IS NULL THEN
    RAISE EXCEPTION 'PIPE3.4: could not resolve the new pipeline ids';
  END IF;

  -- Stage rows (shared/pipelines/paid-trial.js and programmes.js mirror these).
  -- Conflict-target the slug explicitly (mig 559's lesson), then COUNT.
  INSERT INTO public.pipeline_stages
    (location_id, pipeline_id, name, slug, display_order, color, is_dormant, archived)
  VALUES
    (v_still, v_paid, 'New Leads',  'paid_trial_new_lead',    601, '#3B82F6', false, false),
    (v_still, v_paid, '1st Class',  'paid_trial_first_class', 602, '#10B981', false, false),
    (v_still, v_paid, 'Day 7',      'paid_trial_day_7',       603, '#8B5CF6', false, false),
    (v_still, v_paid, 'Trial Done', 'paid_trial_done',        604, '#F59E0B', false, false),
    (v_still, v_paid, 'Converted',  'paid_trial_converted',   605, '#059669', false, false)
  ON CONFLICT (location_id, slug) DO NOTHING;

  INSERT INTO public.pipeline_stages
    (location_id, pipeline_id, name, slug, display_order, color, is_dormant, archived)
  VALUES
    (v_still, v_prog, 'Lead',           'programme_lead',        701, '#3B82F6', false, false),
    (v_still, v_prog, '1st Class Done', 'programme_first_class', 702, '#10B981', false, false),
    (v_still, v_prog, 'Converted',      'programme_converted',   703, '#059669', false, false)
  ON CONFLICT (location_id, slug) DO NOTHING;

  SELECT count(*) INTO v_n FROM public.pipeline_stages WHERE pipeline_id = v_paid AND NOT archived;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'PIPE3.4: expected 5 €39 Trial stages, found %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.pipeline_stages WHERE pipeline_id = v_prog AND NOT archived;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'PIPE3.4: expected 3 Programmes stages, found %', v_n;
  END IF;

  -- The programme rules, seeded only when absent (an operator's list survives).
  UPDATE public.locations
     SET settings = jsonb_set(
           coalesce(settings, '{}'::jsonb),
           '{pipelines}',
           coalesce(settings->'pipelines', '{}'::jsonb)
             || jsonb_build_object('programmes', jsonb_build_object(
                  'lead_sources',          jsonb_build_array('meta_50plus'),
                  'glofox_plan_patterns',  jsonb_build_array('elites trial'))))
   WHERE id = v_still
     AND (settings->'pipelines'->'programmes') IS NULL;

  -- Backfill: today's programme signals, dated at their own time. A 2025 Elites
  -- Trial holder's claim is already past the 60 quiet days and stays on the
  -- acquisition board, which is right.
  INSERT INTO public.pipeline_board_claims (contact_id, location_id, board_key, claimed_at, source)
  SELECT c.id, v_still, 'programmes', c.last_lead_source_at, 'lead_source'
    FROM public.contacts c
   WHERE c.location_id = v_still
     AND lower(c.last_lead_source) = 'meta_50plus'
     AND c.last_lead_source_at IS NOT NULL
  ON CONFLICT (contact_id, location_id, board_key) DO NOTHING;

  INSERT INTO public.pipeline_board_claims (contact_id, location_id, board_key, claimed_at, source)
  SELECT c.id, v_still, 'programmes', coalesce(c.joined_at, c.created_at), 'glofox_plan'
    FROM public.contacts c
   WHERE c.location_id = v_still
     AND c.glofox_membership_plan ILIKE '%elites trial%'
     AND coalesce(c.joined_at, c.created_at) IS NOT NULL
  ON CONFLICT (contact_id, location_id, board_key) DO NOTHING;

  -- The trial's own credits are never a Class Pack.
  UPDATE public.contacts c
     SET pack_customer_at = NULL
    FROM public.trial_purchases tp
   WHERE tp.contact_id = c.id
     AND tp.location_id = v_still
     AND tp.status = 'granted'
     AND tp.paid_at IS NOT NULL
     AND c.pack_customer_at IS NOT NULL
     AND c.pack_customer_at >= tp.paid_at
     -- inside the trial window only: a pack genuinely bought after the trial
     -- ended is a conversion (shared/pipelines/paid-trial.js) and stays stamped
     AND c.pack_customer_at < coalesce(tp.granted_at, tp.paid_at)
                              + make_interval(days => coalesce(tp.duration_days, 14));

  -- ── Self-check: post-state invariants ───────────────────────────────────
  SELECT count(*) INTO v_n FROM public.pipelines WHERE location_id = v_still AND is_primary AND enabled;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'PIPE3.4: Stillorgan must have exactly one enabled primary board, found %', v_n;
  END IF;
  SELECT key INTO v_primary_key FROM public.pipelines WHERE location_id = v_still AND is_primary AND enabled;
  IF v_primary_key <> 'acquisition' THEN
    RAISE EXCEPTION 'PIPE3.4: Stillorgan primary is % (expected acquisition)', v_primary_key;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pipelines
     WHERE id IN (v_paid, v_prog) AND (is_primary OR mode <> 'derived')
  ) THEN
    RAISE EXCEPTION 'PIPE3.4: a new board is primary or not derived';
  END IF;

  SELECT md5(coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), ''))
    INTO v_others_after
    FROM public.pipelines p
   WHERE NOT (p.location_id = v_still AND p.key IN ('paid_trial', 'programmes'));
  IF v_others_after <> v_others_hash THEN
    RAISE EXCEPTION 'PIPE3.4: a pipelines row outside the two new boards changed';
  END IF;
  SELECT md5(coalesce(string_agg(concat_ws('|', id, contact_id, stage_id, pipeline_id, status, updated_at), ',' ORDER BY id), ''))
    INTO v_deals_after FROM public.deals;
  IF v_deals_after <> v_deals_hash THEN
    RAISE EXCEPTION 'PIPE3.4: a deals row changed';
  END IF;
END $$;

COMMIT;
