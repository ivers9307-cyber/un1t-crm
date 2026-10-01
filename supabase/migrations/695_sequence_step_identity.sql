-- 695 — STEPATTRIB.1 (follow-ups C99): sequence steps keep their identity
-- across a graph publish. FORWARD ONLY (Richard, 1 Oct 2026): this file
-- writes no row and re-attributes no send.
--
-- APPLY BEFORE THE STEPATTRIB.1 CODE DEPLOYS. The new publish route calls
-- publish_sequence_steps; before 695 that call 404s and the route answers 500
-- without writing anything (the live steps stay as they are), so publishing
-- is down until this lands. Applying it early changes nothing: the old route
-- never names the column or the function.
--
-- NOT APPLIED YET when this file was written. Behaviour is proven ahead of
-- apply by tests/migration-695-sequence-step-identity.test.js (PGlite).
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- POST /api/sequences/[id]/graph/publish deleted every sequence_steps row of
-- the sequence and inserted the compiled rows. email_sends.sequence_step_id
-- is REFERENCES sequence_steps(id) ON DELETE SET NULL (mig 005), so every
-- publish orphaned the step of every earlier send: 22,771 of 22,793 sequence
-- email sends had no step id on 30 Sep, and the Performance panel's per-step
-- table (keyed on the step row id) showed only sends since the last publish.
-- The two calls were also no transaction: a runner tick between the delete
-- and the insert found no step and COMPLETED the enrolment
-- (scheduler.js: a null next step marks it completed).
--
-- Now the route matches each compiled row to the row its graph node already
-- owns and calls publish_sequence_steps, which in ONE transaction deletes the
-- rows not kept (removed nodes: their sends SET NULL, as before), updates the
-- kept rows IN PLACE (same id, so their sends keep their step) and inserts
-- the new ones. A runner tick sees the old steps or the new ones, never none.
--
-- VERIFIED LIVE (2 Oct 2026, read-only, Supabase MCP; catalog and counts):
--   * the only FK into sequence_steps is email_sends.sequence_step_id
--     (ON DELETE SET NULL); no other column anywhere names a step row
--     (sequence_enrollments holds current_step_order, an int cursor);
--   * sequence_steps: pk (id) only, no unique on (sequence_id, step_order),
--     trigger sequence_steps_updated_at, authenticated holds table-level
--     SELECT (mig 654), so the new column is readable like the rest;
--   * 3 builder-published sequences (19 / 9 / 5 steps), 3 never-published
--     drafts. Compiling each stored graph reproduces 33 of 33 live rows at
--     their step_order, so the route adopts every one at its next publish.
--
-- ===========================================================================
-- THE FILE
-- ===========================================================================
--   1. sequence_steps.graph_node_id (text, nullable) — the graph node a row
--      was compiled from. NULL on every existing row: the compile is JS, so
--      the route fills the key at each sequence's next publish (a legacy row
--      is adopted only when the stored graph reproduces it), not this file.
--   2. sequence_steps_graph_node_uniq — unique (sequence_id, graph_node_id)
--      where set: one row per node, or the in-place match is ambiguous.
--   3. public.publish_sequence_steps(p_sequence_id uuid, p_steps jsonb)
--      RETURNS jsonb {updated, inserted, deleted}. SECURITY INVOKER (the route
--      is service_role), search_path ''. Each element is a compiled row; an
--      `id` that is one of THIS sequence's rows is updated in place, anything
--      else is inserted fresh (an id from another sequence is never touched).
--      Every content column is SET from the element, or its column default
--      when absent, so an updated row equals a fresh insert in all but id,
--      created_at and the retired total_* counters (C71). Removed rows are
--      deleted FIRST so a new row may take a freed node id. Locks the
--      email_sequences row: two publishes of one sequence serialise.
--   4. EXECUTE for service_role only (mig 667's rule, stated explicitly).
--   5. Self-check.
--
-- ROLLBACK (revert the STEPATTRIB.1 code FIRST, or publishing 500s):
-- ROLLBACK BEGIN
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.publish_sequence_steps(uuid, jsonb);
-- DROP INDEX IF EXISTS public.sequence_steps_graph_node_uniq;
-- ALTER TABLE public.sequence_steps DROP COLUMN IF EXISTS graph_node_id;
-- COMMIT;
-- ROLLBACK END

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. The identity.
ALTER TABLE public.sequence_steps ADD COLUMN IF NOT EXISTS graph_node_id text;
COMMENT ON COLUMN public.sequence_steps.graph_node_id IS
  'STEPATTRIB.1 (mig 695): the flow-graph node this row was compiled from. A graph publish updates the row in place by this key, so its id (and email_sends.sequence_step_id) survives. NULL on rows not yet republished since 695.';

-- 2. One row per node per sequence.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_steps_graph_node_uniq
  ON public.sequence_steps (sequence_id, graph_node_id)
  WHERE graph_node_id IS NOT NULL;

-- 3. The publish, in one transaction.
CREATE OR REPLACE FUNCTION public.publish_sequence_steps(p_sequence_id uuid, p_steps jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_step jsonb;
  v_id uuid;
  v_keep uuid[];
  v_done uuid[] := ARRAY[]::uuid[];
  v_updated integer := 0;
  v_inserted integer := 0;
  v_deleted integer := 0;
BEGIN
  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' THEN
    RAISE EXCEPTION 'publish_sequence_steps: p_steps must be a JSON array' USING ERRCODE = '22023';
  END IF;

  -- Serialise publishes of one sequence, and refuse an unknown one.
  PERFORM 1 FROM public.email_sequences WHERE id = p_sequence_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publish_sequence_steps: sequence % not found', p_sequence_id USING ERRCODE = 'P0002';
  END IF;

  -- The rows kept: ids named in the payload that are THIS sequence's rows.
  SELECT coalesce(array_agg(s.id), ARRAY[]::uuid[]) INTO v_keep
    FROM public.sequence_steps s
   WHERE s.sequence_id = p_sequence_id
     AND s.id IN (SELECT nullif(e->>'id', '')::uuid FROM jsonb_array_elements(p_steps) AS e);

  -- Removed nodes first (their sends SET NULL), freeing their node ids.
  DELETE FROM public.sequence_steps
   WHERE sequence_id = p_sequence_id AND NOT (id = ANY (v_keep));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  FOR v_step IN SELECT e FROM jsonb_array_elements(p_steps) AS e LOOP
    v_id := nullif(v_step->>'id', '')::uuid;
    IF v_id = ANY (v_keep) AND NOT (v_id = ANY (v_done)) THEN
      UPDATE public.sequence_steps SET
        step_order                = (v_step->>'step_order')::integer,
        step_type                 = coalesce(v_step->>'step_type', 'email'),
        delay_days                = coalesce((v_step->>'delay_days')::integer, 0),
        delay_hours               = coalesce((v_step->>'delay_hours')::integer, 0),
        delay_minutes             = coalesce((v_step->>'delay_minutes')::integer, 0),
        delay_type                = coalesce(v_step->>'delay_type', 'after_previous'),
        subject                   = v_step->>'subject',
        html_content              = v_step->>'html_content',
        design_json               = nullif(v_step->'design_json', 'null'::jsonb),
        template_id               = nullif(v_step->>'template_id', '')::uuid,
        whatsapp_template_id      = nullif(v_step->>'whatsapp_template_id', '')::uuid,
        whatsapp_variables        = coalesce(nullif(v_step->'whatsapp_variables', 'null'::jsonb), '{}'::jsonb),
        whatsapp_header_media_url = v_step->>'whatsapp_header_media_url',
        sms_body                  = v_step->>'sms_body',
        config                    = coalesce(nullif(v_step->'config', 'null'::jsonb), '{}'::jsonb),
        graph_node_id             = v_step->>'graph_node_id'
      WHERE id = v_id;
      v_done := v_done || v_id;
      v_updated := v_updated + 1;
    ELSE
      INSERT INTO public.sequence_steps (
        sequence_id, step_order, step_type, delay_days, delay_hours, delay_minutes, delay_type,
        subject, html_content, design_json, template_id, whatsapp_template_id, whatsapp_variables,
        whatsapp_header_media_url, sms_body, config, graph_node_id
      ) VALUES (
        p_sequence_id,
        (v_step->>'step_order')::integer,
        coalesce(v_step->>'step_type', 'email'),
        coalesce((v_step->>'delay_days')::integer, 0),
        coalesce((v_step->>'delay_hours')::integer, 0),
        coalesce((v_step->>'delay_minutes')::integer, 0),
        coalesce(v_step->>'delay_type', 'after_previous'),
        v_step->>'subject',
        v_step->>'html_content',
        nullif(v_step->'design_json', 'null'::jsonb),
        nullif(v_step->>'template_id', '')::uuid,
        nullif(v_step->>'whatsapp_template_id', '')::uuid,
        coalesce(nullif(v_step->'whatsapp_variables', 'null'::jsonb), '{}'::jsonb),
        v_step->>'whatsapp_header_media_url',
        v_step->>'sms_body',
        coalesce(nullif(v_step->'config', 'null'::jsonb), '{}'::jsonb),
        v_step->>'graph_node_id'
      );
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('updated', v_updated, 'inserted', v_inserted, 'deleted', v_deleted);
END
$$;

COMMENT ON FUNCTION public.publish_sequence_steps(uuid, jsonb) IS
  'STEPATTRIB.1 (mig 695): apply a compiled flow-graph publish to sequence_steps in one transaction. Rows named by id are updated in place (ids survive, so email_sends keep their step), others inserted, the rest deleted. Service role only.';

-- 4. Server-only (the publish route runs as service_role).
REVOKE EXECUTE ON FUNCTION public.publish_sequence_steps(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_sequence_steps(uuid, jsonb) TO service_role;

-- 5. Self-check.
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'sequence_steps' AND column_name = 'graph_node_id') THEN
    RAISE EXCEPTION '695: sequence_steps.graph_node_id missing';
  END IF;
  IF to_regclass('public.sequence_steps_graph_node_uniq') IS NULL THEN
    RAISE EXCEPTION '695: sequence_steps_graph_node_uniq missing';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.publish_sequence_steps(uuid, jsonb)'::regprocedure) THEN
    RAISE EXCEPTION '695: publish_sequence_steps must be SECURITY INVOKER';
  END IF;
  IF has_function_privilege('anon', 'public.publish_sequence_steps(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.publish_sequence_steps(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '695: a client role can execute publish_sequence_steps';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.publish_sequence_steps(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '695: service_role cannot execute publish_sequence_steps';
  END IF;
END
$check$;

COMMIT;
