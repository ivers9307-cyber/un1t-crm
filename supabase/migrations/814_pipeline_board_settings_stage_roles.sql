-- 814 — PIPEBUILD.2a: board settings, stage roles, stage follow-up links.
--
-- Makes sales pipelines self-service (PIPEBUILD PR 2). Three things:
--   1. pipelines gains the settings a board needs to be built from a recipe:
--      board_type / recipe_key (what kind of board, from which recipe),
--      config (board settings), priority (placement order), created_by,
--      updated_at. board_type is bounded to offer boards ('offer').
--   2. pipeline_stages gains stage_role (what KIND of stage this is: new,
--      first_class, class_n, checkpoint, done, converted, pile, custom) and
--      role_config (the role's parameters, e.g. {"count":2}, {"day":7}). Every
--      existing stage is backfilled by slug, all studios; the roles are bounded
--      by a check constraint because pipeline_stages has browser write
--      policies for studio admins (mig 320).
--   3. pipeline_stage_followups links each stage to its follow-up sequence /
--      WhatsApp template. Service-role only.
--
-- Verified on prod 6 Nov 2026: pipeline_stages holds ~45 distinct slugs, many
-- in no board module (active_member, active_trial, lapsed, the waitlist_* and
-- returning_* sets ...). Those not named below stay 'custom', or become 'pile'
-- when is_dormant (only rows still 'custom' are flipped).
--
-- grant: pipelines/pipeline_stages columns ride their existing table-level grants (no column grants on these tables)
-- column-grant: n/a
-- grant: public.pipeline_stage_followups closed to every client session (RLS on, no policy, REVOKE ALL from anon, authenticated)

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. pipelines: board settings
-- ---------------------------------------------------------------------------
ALTER TABLE public.pipelines
  ADD COLUMN IF NOT EXISTS board_type text,
  ADD COLUMN IF NOT EXISTS recipe_key text,
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.pipelines DROP CONSTRAINT IF EXISTS pipelines_board_type_module_chk;
ALTER TABLE public.pipelines
  ADD CONSTRAINT pipelines_board_type_module_chk
  CHECK (board_type IS NULL OR module IN ('offer', 'offer_un1t'));

ALTER TABLE public.pipelines DROP CONSTRAINT IF EXISTS pipelines_board_type_chk;
ALTER TABLE public.pipelines
  ADD CONSTRAINT pipelines_board_type_chk
  CHECK (board_type IS NULL OR board_type IN ('offer'));

-- ---------------------------------------------------------------------------
-- 2. pipeline_stages: stage roles
-- ---------------------------------------------------------------------------
ALTER TABLE public.pipeline_stages
  ADD COLUMN IF NOT EXISTS stage_role text NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS role_config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_stage_role_chk;
ALTER TABLE public.pipeline_stages
  ADD CONSTRAINT pipeline_stages_stage_role_chk
  CHECK (stage_role IN ('new', 'first_class', 'class_n', 'checkpoint', 'done', 'converted', 'pile', 'custom'));

ALTER TABLE public.pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_role_config_chk;
ALTER TABLE public.pipeline_stages
  ADD CONSTRAINT pipeline_stages_role_config_chk
  CHECK (jsonb_typeof(role_config) = 'object');

-- Backfill by slug (all studios). Only rows still 'custom' are touched, so a
-- re-run never overwrites a role someone has since set.
UPDATE public.pipeline_stages SET stage_role = 'new'
 WHERE stage_role = 'custom'
   AND slug IN ('new_lead', 'paid_trial_new_lead', 'programme_lead', 'waitlist_new_enquiry', 'returning_booked');

UPDATE public.pipeline_stages SET stage_role = 'first_class'
 WHERE stage_role = 'custom'
   AND slug IN ('first_class', 'paid_trial_first_class', 'programme_first_class', 'returning_first_class');

UPDATE public.pipeline_stages SET stage_role = 'class_n', role_config = '{"count":2}'::jsonb
 WHERE stage_role = 'custom'
   AND slug IN ('second_class', 'returning_second_class');

UPDATE public.pipeline_stages SET stage_role = 'checkpoint', role_config = '{"day":7}'::jsonb
 WHERE stage_role = 'custom'
   AND slug IN ('paid_trial_day_7');

UPDATE public.pipeline_stages SET stage_role = 'done'
 WHERE stage_role = 'custom'
   AND slug IN ('trial_done', 'paid_trial_done', 'returning_final_class');

UPDATE public.pipeline_stages SET stage_role = 'converted'
 WHERE stage_role = 'custom'
   AND slug IN ('converted', 'paid_trial_converted', 'programme_converted', 'waitlist_converted');

UPDATE public.pipeline_stages SET stage_role = 'pile'
 WHERE stage_role = 'custom'
   AND slug IN ('member', 'pack_member', 'classpass', 'gympass', 'cold_lead', 'dormant');

-- Everything else stays 'custom' (rebook included), unless it is dormant.
UPDATE public.pipeline_stages SET stage_role = 'pile'
 WHERE stage_role = 'custom' AND is_dormant = true;

-- ---------------------------------------------------------------------------
-- 3. pipeline_stage_followups (service-role only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pipeline_stage_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  stage_id uuid NOT NULL REFERENCES public.pipeline_stages(id) ON DELETE CASCADE,
  sequence_id uuid REFERENCES public.email_sequences(id) ON DELETE SET NULL,
  whatsapp_template_id uuid REFERENCES public.whatsapp_templates(id) ON DELETE SET NULL,
  pack_key text,
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'awaiting_approval', 'live', 'rejected', 'off')),
  want_live boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_stage_followups_stage_pack_key UNIQUE (stage_id, pack_key)
);

CREATE INDEX IF NOT EXISTS pipeline_stage_followups_location_idx
  ON public.pipeline_stage_followups (location_id);
CREATE INDEX IF NOT EXISTS pipeline_stage_followups_template_idx
  ON public.pipeline_stage_followups (whatsapp_template_id);
CREATE INDEX IF NOT EXISTS pipeline_stage_followups_sequence_idx
  ON public.pipeline_stage_followups (sequence_id);
CREATE INDEX IF NOT EXISTS pipeline_stage_followups_pipeline_idx
  ON public.pipeline_stage_followups (pipeline_id);
CREATE INDEX IF NOT EXISTS pipeline_stage_followups_created_by_idx
  ON public.pipeline_stage_followups (created_by);
CREATE INDEX IF NOT EXISTS pipelines_created_by_idx
  ON public.pipelines (created_by);

ALTER TABLE public.pipeline_stage_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_stage_followups FROM anon, authenticated;

COMMENT ON TABLE public.pipeline_stage_followups IS
  'PIPEBUILD.2a — links a pipeline stage to its follow-up sequence / WhatsApp template. Service-role only: RLS on, no policy.';

-- ---------------------------------------------------------------------------
-- Self-check (POST-state)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  c text;
  n integer;
BEGIN
  FOREACH c IN ARRAY ARRAY['board_type', 'recipe_key', 'config', 'priority', 'created_by', 'updated_at'] LOOP
    PERFORM 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pipelines' AND column_name = c;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 814: pipelines.% missing; nothing was applied', c;
    END IF;
  END LOOP;

  FOREACH c IN ARRAY ARRAY['stage_role', 'role_config'] LOOP
    PERFORM 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pipeline_stages' AND column_name = c;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 814: pipeline_stages.% missing; nothing was applied', c;
    END IF;
  END LOOP;

  SELECT count(*) INTO n FROM public.pipeline_stages
   WHERE stage_role NOT IN ('new', 'first_class', 'class_n', 'checkpoint', 'done', 'converted', 'pile', 'custom');
  IF n > 0 THEN
    RAISE EXCEPTION 'mig 814: % pipeline_stages rows hold a role outside the eight; nothing was applied', n;
  END IF;

  SELECT count(*) INTO n FROM public.pipeline_stages
   WHERE slug = 'paid_trial_day_7' AND role_config->>'day' IS DISTINCT FROM '7';
  IF n > 0 THEN
    RAISE EXCEPTION 'mig 814: % paid_trial_day_7 rows lack role_config day 7; nothing was applied', n;
  END IF;

  PERFORM 1 FROM pg_class cl JOIN pg_namespace ns ON ns.oid = cl.relnamespace
   WHERE ns.nspname = 'public' AND cl.relname = 'pipeline_stage_followups' AND cl.relrowsecurity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 814: pipeline_stage_followups missing or RLS off; nothing was applied';
  END IF;

  IF has_table_privilege('authenticated', 'public.pipeline_stage_followups', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon', 'public.pipeline_stage_followups', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'mig 814: a client role holds a privilege on pipeline_stage_followups; nothing was applied';
  END IF;
END $$;

COMMIT;
