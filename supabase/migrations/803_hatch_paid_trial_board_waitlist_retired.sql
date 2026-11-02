-- 803 HATCH39.5 — UN1T Hatch Street: the €39 Trial board (seeded DISABLED), the
-- Waitlist board retired, Acquisition made the primary, the paid-trial product
-- setting, and the pack-stamp clear.
-- Spec: docs/superpowers/specs/2026-11-01-hatch-paid-trial-board-design.md
--
-- Apply BEFORE the HATCH39 code deploys. Everything here is safe on the old
-- code: a disabled board renders nowhere, the Waitlist's cards are closed or
-- moved onto the acquisition board, and the acquisition board was already the
-- one the hourly un1t pass placed. Mig 804 enables the €39 board after the dry
-- run (spec, Rollout).
--
-- WHY. Hatch sells two trials through un1t.online: the free 3-class trial
-- (today's Acquisition board) and the €39 14-day trial, which the CRM showed
-- nowhere — worse, un1t.online records the €39 purchase as a `pack`, so the
-- CRM read all 69 buyers as Class Pack customers. The €39 board is Stillorgan's
-- (shared/pipelines/paid-trial.js), fed from the un1t mirror.
--
-- THE WAITLIST (Richard, 1 Nov 2026: "delete the waitlist board"). 180 open
-- cards, every one still in New Enquiry, none ever moved. Of them: 108 people
-- are already on the Acquisition board (their Waitlist card closes); the rest
-- MOVE to Acquisition at New Leads when the person has a un1t.online account
-- (the next hourly pass re-places them) or a public-form touch
-- (last_lead_source_at: a form-only enquiry the pass now keeps, HATCH39), and
-- CLOSE when they have neither — 45 of them are race signups, and a race entry
-- alone is not a lead (CROSSOVERDEAL.1). A board is retired, never deleted:
-- enabled = false, stages and closed deals kept.
--
-- is_primary MOVES, deliberately and once: the Waitlist was Hatch's primary
-- (mig 598); Acquisition takes it (contacts.pipeline_stage_slug re-derives off
-- the acquisition deal through mig 736's trigger). The partial unique index
-- pipelines_one_primary_per_location holds because the Waitlist is cleared
-- first, in the same transaction.
--
-- IDEMPOTENT: every insert conflict-targets its natural key and never touches
-- `enabled`/`is_primary` on a re-run; the settings seed writes only when the
-- key is absent; a second run finds no open Waitlist card and moves nothing.
--
-- grant: none (no new relation)

BEGIN;

DO $$
DECLARE
  v_hatch        constant uuid := '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';  -- UN1T Hatch Street
  v_paid_product constant text := '674d62bf-4d4b-4231-b1ba-d53543657bea';  -- un1t_products.un1t_id, "The UN1T Trial" €39
  v_acq          uuid;
  v_wait         uuid;
  v_paid         uuid;
  v_new_stage    uuid;
  v_n            int;
  v_closed_dup   int := 0;
  v_moved        int := 0;
  v_closed_none  int := 0;
  v_others_hash  text;
  v_others_after text;
  v_deals_hash   text;
  v_deals_after  text;
BEGIN
  -- Preconditions.
  SELECT id INTO v_acq FROM public.pipelines WHERE location_id = v_hatch AND key = 'acquisition' AND enabled AND mode = 'derived';
  IF v_acq IS NULL THEN
    RAISE EXCEPTION 'HATCH39.5: Hatch has no enabled derived acquisition board';
  END IF;
  SELECT id INTO v_wait FROM public.pipelines WHERE location_id = v_hatch AND key = 'waitlist';
  -- The live New Leads column the cards move to.
  SELECT id INTO v_new_stage FROM public.pipeline_stages
   WHERE pipeline_id = v_acq AND slug = 'new_lead' AND NOT archived;
  IF v_new_stage IS NULL THEN
    RAISE EXCEPTION 'HATCH39.5: Hatch acquisition has no live new_lead column';
  END IF;

  -- Before: every pipelines row outside Hatch, and every deals row outside Hatch.
  SELECT md5(coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), ''))
    INTO v_others_hash FROM public.pipelines p WHERE p.location_id <> v_hatch;
  SELECT md5(coalesce(string_agg(concat_ws('|', id, contact_id, stage_id, pipeline_id, status, updated_at), ',' ORDER BY id), ''))
    INTO v_deals_hash FROM public.deals WHERE location_id <> v_hatch;

  -- ── 1. The €39 Trial board, DISABLED, and its stages ────────────────────
  INSERT INTO public.pipelines (location_id, key, name, module, mode, is_primary, display_order, enabled)
  VALUES (v_hatch, 'paid_trial', '€39 Trial', 'paid_trial_un1t', 'derived', false, 1, false)
  ON CONFLICT (location_id, key) DO UPDATE SET module = EXCLUDED.module, mode = 'derived'
  RETURNING id INTO v_paid;
  IF v_paid IS NULL THEN
    RAISE EXCEPTION 'HATCH39.5: could not resolve the €39 Trial pipeline id';
  END IF;

  INSERT INTO public.pipeline_stages
    (location_id, pipeline_id, name, slug, display_order, color, is_dormant, archived)
  VALUES
    (v_hatch, v_paid, 'New Leads',  'paid_trial_new_lead',    601, '#3B82F6', false, false),
    (v_hatch, v_paid, '1st Class',  'paid_trial_first_class', 602, '#10B981', false, false),
    (v_hatch, v_paid, 'Day 7',      'paid_trial_day_7',       603, '#8B5CF6', false, false),
    (v_hatch, v_paid, 'Trial Done', 'paid_trial_done',        604, '#F59E0B', false, false),
    (v_hatch, v_paid, 'Converted',  'paid_trial_converted',   605, '#059669', false, false)
  ON CONFLICT (location_id, slug) DO NOTHING;
  SELECT count(*) INTO v_n FROM public.pipeline_stages WHERE pipeline_id = v_paid AND NOT archived;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'HATCH39.5: expected 5 €39 Trial stages, found %', v_n;
  END IF;

  -- The Waitlist falls behind the two live boards.
  IF v_wait IS NOT NULL THEN
    UPDATE public.pipelines SET display_order = 2 WHERE id = v_wait;
  END IF;

  -- ── 2. The paid-trial product setting, seeded only when absent ──────────
  UPDATE public.locations
     SET settings = jsonb_set(
           coalesce(settings, '{}'::jsonb),
           '{pipelines}',
           coalesce(settings->'pipelines', '{}'::jsonb)
             || jsonb_build_object('paid_trial', jsonb_build_object(
                  'un1t_product_ids', jsonb_build_array(v_paid_product))))
   WHERE id = v_hatch
     AND (settings->'pipelines'->'paid_trial') IS NULL;

  -- ── 3. The Waitlist's open cards ────────────────────────────────────────
  IF v_wait IS NOT NULL THEN
    -- (a) already on Acquisition: the Waitlist card is a duplicate → lost.
    WITH closed AS (
      UPDATE public.deals d
         SET status = 'lost'
       WHERE d.pipeline_id = v_wait AND d.status = 'open'
         AND EXISTS (SELECT 1 FROM public.deals a
                      WHERE a.contact_id = d.contact_id AND a.pipeline_id = v_acq AND a.status = 'open')
      RETURNING d.id)
    SELECT count(*) INTO v_closed_dup FROM closed;

    -- (b) an account, or a public-form touch: the card MOVES to New Leads.
    WITH moved AS (
      UPDATE public.deals d
         SET pipeline_id = v_acq, stage_id = v_new_stage
       WHERE d.pipeline_id = v_wait AND d.status = 'open'
         AND EXISTS (SELECT 1 FROM public.contacts c
                      WHERE c.id = d.contact_id
                        AND (c.last_lead_source_at IS NOT NULL
                             OR EXISTS (SELECT 1 FROM public.un1t_clients u
                                         WHERE u.contact_id = c.id AND u.location_id = v_hatch)))
      RETURNING d.id)
    SELECT count(*) INTO v_moved FROM moved;

    -- (c) neither (a race signup): no card → lost.
    WITH closed AS (
      UPDATE public.deals d
         SET status = 'lost'
       WHERE d.pipeline_id = v_wait AND d.status = 'open'
      RETURNING d.id)
    SELECT count(*) INTO v_closed_none FROM closed;

    SELECT count(*) INTO v_n FROM public.deals WHERE pipeline_id = v_wait AND status = 'open';
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'HATCH39.5: % Waitlist cards still open', v_n;
    END IF;
    RAISE NOTICE 'HATCH39.5: waitlist cards — % closed (already on Acquisition), % moved to New Leads, % closed (no account, no enquiry)', v_closed_dup, v_moved, v_closed_none;

    -- ── 4. Retire the Waitlist; Acquisition becomes the primary ───────────
    UPDATE public.pipelines SET is_primary = false, enabled = false WHERE id = v_wait;
  END IF;
  UPDATE public.pipelines SET is_primary = true WHERE id = v_acq;

  -- ── 5. The €39 trial's `pack` transactions never stamped a Class Pack ───
  -- Hatch-home contacts whose every paid pack transaction is the paid trial.
  UPDATE public.contacts c
     SET pack_customer_at = NULL
   WHERE c.location_id = v_hatch
     AND c.pack_customer_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.un1t_transactions t
                  WHERE t.location_id = v_hatch AND t.contact_id = c.id
                    AND t.product_type = 'pack' AND t.product_id = v_paid_product AND NOT t.refunded)
     AND NOT EXISTS (SELECT 1 FROM public.un1t_transactions t
                      WHERE t.location_id = v_hatch AND t.contact_id = c.id
                        AND t.product_type = 'pack' AND t.product_id <> v_paid_product
                        AND t.amount_cents > 0 AND NOT t.refunded);

  -- ── Self-check: post-state invariants ───────────────────────────────────
  SELECT count(*) INTO v_n FROM public.pipelines WHERE location_id = v_hatch AND is_primary AND enabled;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'HATCH39.5: Hatch must have exactly one enabled primary board, found %', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pipelines WHERE id = v_acq AND is_primary AND enabled) THEN
    RAISE EXCEPTION 'HATCH39.5: Hatch acquisition is not the enabled primary';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pipelines WHERE id = v_paid AND (is_primary OR enabled OR mode <> 'derived')) THEN
    RAISE EXCEPTION 'HATCH39.5: the €39 board must be disabled, derived and not primary here';
  END IF;
  IF v_wait IS NOT NULL AND EXISTS (SELECT 1 FROM public.pipelines WHERE id = v_wait AND (enabled OR is_primary)) THEN
    RAISE EXCEPTION 'HATCH39.5: the Waitlist is still enabled or primary';
  END IF;
  -- Every moved card sits on Acquisition at New Leads; one open deal per person at Hatch.
  IF EXISTS (
    SELECT 1 FROM public.deals WHERE location_id = v_hatch AND status = 'open'
     GROUP BY contact_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'HATCH39.5: a Hatch contact holds two open deals after the cutover';
  END IF;
  SELECT md5(coalesce(string_agg(row_to_json(p)::text, ',' ORDER BY p.id), ''))
    INTO v_others_after FROM public.pipelines p WHERE p.location_id <> v_hatch;
  IF v_others_after <> v_others_hash THEN
    RAISE EXCEPTION 'HATCH39.5: a pipelines row outside Hatch changed';
  END IF;
  SELECT md5(coalesce(string_agg(concat_ws('|', id, contact_id, stage_id, pipeline_id, status, updated_at), ',' ORDER BY id), ''))
    INTO v_deals_after FROM public.deals WHERE location_id <> v_hatch;
  IF v_deals_after <> v_deals_hash THEN
    RAISE EXCEPTION 'HATCH39.5: a deals row outside Hatch changed';
  END IF;
END $$;

COMMIT;
