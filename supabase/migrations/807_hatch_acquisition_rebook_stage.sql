-- 807 REBOOK.1 — UN1T Hatch Street's acquisition board gets a Rebook column,
-- between New Leads and 1st Class.
--
-- WHY (Richard, 3 Nov 2026, about Conall: "that needs to be represented better
-- on the pipeline"). The Hatch board places people by ATTENDANCE only, so a
-- lead who booked a trial class and then cancelled or missed it looked exactly
-- like one who never booked: both sat in New Leads. Measured live on 3 Nov:
-- 9 of the 74 open New Leads had booked a class here and never come. They are
-- the warmest leads on the board and need a call to rebook, not a first touch.
-- The rule is shared/pipelines/acquisition-un1t.js needsRebook (Hatch only:
-- Stillorgan's Glofox board has no Rebook column and its classify never
-- returns the slug).
--
-- APPLY BEFORE the REBOOK.1 code deploys. Without the column the new code's
-- 'rebook' answer misses stageIdBySlug and the hourly pass counts those
-- contacts as errors and leaves them where they are. Before the code ships the
-- column is simply empty.
--
-- display_order is an integer and New Leads (301) / 1st Class (302) are
-- adjacent, so Hatch's live 302..311 columns move up one and Rebook takes 302.
-- Hatch only: Stillorgan's rows are untouched (checked below by hash).
-- shared/pipelines/acquisition-un1t.js carries the same orders.
--
-- IDEMPOTENT: the insert conflict-targets (location_id, slug); the shift runs
-- only while Rebook is missing.
--
-- grant: none (no new relation)

BEGIN;

DO $$
DECLARE
  v_hatch       constant uuid := '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';  -- UN1T Hatch Street
  v_acq         uuid;
  v_n           int;
  v_others_hash text;
  v_others_after text;
BEGIN
  SELECT id INTO v_acq FROM public.pipelines
   WHERE location_id = v_hatch AND key = 'acquisition' AND module = 'acquisition_un1t' AND enabled AND mode = 'derived';
  IF v_acq IS NULL THEN
    RAISE EXCEPTION 'REBOOK.1: Hatch has no enabled derived acquisition_un1t board';
  END IF;

  SELECT md5(coalesce(string_agg(concat_ws('|', id, slug, display_order, archived), ',' ORDER BY id), ''))
    INTO v_others_hash FROM public.pipeline_stages WHERE location_id <> v_hatch;

  IF NOT EXISTS (SELECT 1 FROM public.pipeline_stages WHERE location_id = v_hatch AND slug = 'rebook') THEN
    UPDATE public.pipeline_stages
       SET display_order = display_order + 1
     WHERE pipeline_id = v_acq AND NOT archived AND display_order BETWEEN 302 AND 399;

    INSERT INTO public.pipeline_stages
      (location_id, pipeline_id, name, slug, display_order, color, is_dormant, archived)
    VALUES
      (v_hatch, v_acq, 'Rebook', 'rebook', 302, '#6366F1', false, false)
    ON CONFLICT (location_id, slug) DO NOTHING;
  END IF;

  -- The live columns, in order, are exactly the code's.
  SELECT count(*) INTO v_n FROM public.pipeline_stages s
   JOIN (VALUES ('new_lead', 301), ('rebook', 302), ('first_class', 303), ('second_class', 304),
                ('trial_done', 305), ('converted', 306), ('member', 307), ('pack_member', 308),
                ('classpass', 309), ('dormant', 310), ('cold_lead', 311), ('gympass', 312)) AS want(slug, ord)
     ON want.slug = s.slug AND want.ord = s.display_order
   WHERE s.pipeline_id = v_acq AND NOT s.archived;
  IF v_n <> 12 THEN
    RAISE EXCEPTION 'REBOOK.1: expected Hatch acquisition columns 301..312 in code order, matched %', v_n;
  END IF;

  SELECT md5(coalesce(string_agg(concat_ws('|', id, slug, display_order, archived), ',' ORDER BY id), ''))
    INTO v_others_after FROM public.pipeline_stages WHERE location_id <> v_hatch;
  IF v_others_after IS DISTINCT FROM v_others_hash THEN
    RAISE EXCEPTION 'REBOOK.1: a stage outside Hatch changed';
  END IF;
END $$;

COMMIT;
