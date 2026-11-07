-- 815 — PIPEBUILD.5a: the board builder's database half.
--
-- Supersedes the "deliberately no board-builder UI" line in mig 594 (pipelines
-- had no write path on purpose): operators can now build offer boards from a
-- recipe, through service-role routes only.
--
--   1. pipelines.baseline_at — null = the board has not been baselined yet.
--   2. pipeline_stage_followups.version — optimistic-concurrency counter.
--   3. public.create_configured_pipeline() — one pipelines row plus all its
--      stages in ONE transaction (a half-built board must never exist). The
--      board is created disabled, derived, non-primary. A 23505 propagates.
--   4. Browser writes on pipeline_stages closed. The mig 320 admin policies
--      let any owner/manager rewrite stages straight from their session, past
--      the builder routes' checks (stage_role / role_config rules). Nothing in
--      src/, shared/ or mobile/ writes pipeline_stages from a client, and the
--      phone only reads it, so SELECT (pipeline_stages_select) must survive:
--      revoke ONLY INSERT, UPDATE, DELETE, never a table-level SELECT.
--
-- grant: public.create_configured_pipeline executable by service_role only (REVOKE below)
-- grant: public.pipeline_stages INSERT/UPDATE/DELETE revoked from authenticated; SELECT kept
-- column-grant: n/a

BEGIN;

ALTER TABLE public.pipelines
  ADD COLUMN IF NOT EXISTS baseline_at timestamptz;

ALTER TABLE public.pipeline_stage_followups
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE public.pipeline_stage_followups DROP CONSTRAINT IF EXISTS pipeline_stage_followups_version_chk;
ALTER TABLE public.pipeline_stage_followups
  ADD CONSTRAINT pipeline_stage_followups_version_chk CHECK (version >= 1);

-- ---------------------------------------------------------------------------
-- create_configured_pipeline
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_configured_pipeline(
  p_location_id uuid,
  p_key text,
  p_name text,
  p_board_type text,
  p_module text,
  p_recipe_key text,
  p_config jsonb,
  p_priority integer,
  p_created_by uuid,
  p_stages jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_order integer;
  v_stage jsonb;
BEGIN
  SELECT COALESCE(MAX(display_order), 0) + 1 INTO v_order
    FROM public.pipelines WHERE location_id = p_location_id;

  INSERT INTO public.pipelines (
    location_id, key, name, module, mode, is_primary, display_order, enabled,
    board_type, recipe_key, config, priority, created_by, updated_at
  ) VALUES (
    p_location_id, p_key, p_name, p_module, 'derived', false, v_order, false,
    p_board_type, p_recipe_key, COALESCE(p_config, '{}'::jsonb),
    COALESCE(p_priority, 100), p_created_by, now()
  ) RETURNING id INTO v_id;

  FOR v_stage IN SELECT * FROM jsonb_array_elements(COALESCE(p_stages, '[]'::jsonb))
  LOOP
    INSERT INTO public.pipeline_stages (
      pipeline_id, location_id, slug, name, stage_role, role_config,
      display_order, color, is_dormant
    ) VALUES (
      v_id, p_location_id,
      v_stage->>'slug',
      v_stage->>'name',
      COALESCE(v_stage->>'stage_role', 'custom'),
      COALESCE(v_stage->'role_config', '{}'::jsonb),
      COALESCE((v_stage->>'display_order')::integer, 0),
      v_stage->>'color',
      COALESCE((v_stage->>'is_dormant')::boolean, false)
    );
  END LOOP;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_configured_pipeline(uuid, text, text, text, text, text, jsonb, integer, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.create_configured_pipeline(uuid, text, text, text, text, text, jsonb, integer, uuid, jsonb) IS
  'PIPEBUILD.5a — creates a disabled derived pipeline and all its stages in one transaction. service_role only.';

-- ---------------------------------------------------------------------------
-- pipeline_stages: browser writes closed (SELECT kept)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS pipeline_stages_ins ON public.pipeline_stages;
DROP POLICY IF EXISTS pipeline_stages_upd ON public.pipeline_stages;
DROP POLICY IF EXISTS pipeline_stages_del ON public.pipeline_stages;

REVOKE INSERT, UPDATE, DELETE ON public.pipeline_stages FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.pipeline_stages FROM anon;

-- ---------------------------------------------------------------------------
-- Self-check (POST-state)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF has_function_privilege('authenticated',
       'public.create_configured_pipeline(uuid, text, text, text, text, text, jsonb, integer, uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '815: authenticated can still execute create_configured_pipeline';
  END IF;
  IF has_table_privilege('authenticated', 'public.pipeline_stages', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.pipeline_stages', 'INSERT')
     OR has_table_privilege('authenticated', 'public.pipeline_stages', 'DELETE') THEN
    RAISE EXCEPTION '815: authenticated can still write pipeline_stages';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.pipeline_stages', 'SELECT') THEN
    RAISE EXCEPTION '815: authenticated lost SELECT on pipeline_stages (the phone reads it)';
  END IF;
END $$;

COMMIT;
