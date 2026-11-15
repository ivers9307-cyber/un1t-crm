-- 840_publish_sequence_steps_cursor_remap.sql
--
-- SEQCURSOR.1 (15 Nov 2026 feature audit, step 2 item 5): a republish keeps
-- each in-flight enrolment on the step it was due to run next.
--
-- NOT APPLIED YET when this file was written. Apply it BEFORE the code that
-- reads the `remapped` count deploys (the code does not depend on it: it only
-- logs the count, so applying it early or late changes nothing but the fix).
-- Behaviour is proven ahead of apply by
-- tests/migration-840-sequence-cursor-remap.test.js (PGlite).
--
-- WHY
-- sequence_enrollments.current_step_order is a POSITION: the runner runs the
-- step at current_step_order + 1. A publish that inserts a step above one an
-- enrolment already passed renumbers the rows, so the cursor then names an
-- earlier step and the runner sends it again (the audit's "insert a step above
-- one already sent, republish, and people mid-flow get that email twice").
--
-- WHAT
-- public.publish_sequence_steps is re-created (CREATE OR REPLACE keeps its ACL:
-- service_role only, mig 698/667) with one addition: before the rows change it
-- records, per old position, where that position's row lands (or the first kept
-- row after it, for a deleted step), and after applying the steps it moves every
-- active or paused enrolment of the sequence in ONE UPDATE. The result gains a
-- `remapped` count. Everything else is byte-for-byte mig 698.
--
-- ROLLBACK: re-run section 3 of 698 (the function as it was). No data to undo:
-- a remapped cursor points at the same step it pointed at before the publish.

BEGIN;
SET LOCAL lock_timeout = '5s';

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
  v_map jsonb;
  v_remapped integer := 0;
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

  -- SEQCURSOR.1 — where each enrolment's NEXT step goes. An enrolment's cursor
  -- is a position (the next step is current_step_order + 1), so a publish that
  -- moves rows would otherwise point it at another step, an email it already
  -- had among them. Computed BEFORE the rows change: for each old position,
  -- the new position of that row if kept, else of the first kept row after it
  -- (a deleted step's successor). Positions held by more than one row are
  -- ambiguous and left alone, as is a position with no kept row after it.
  WITH old AS (
    SELECT s.id, s.step_order AS old_order
      FROM public.sequence_steps s
     WHERE s.sequence_id = p_sequence_id
  ), kept AS (
    SELECT o.old_order, (e->>'step_order')::integer AS new_order
      FROM old o
      JOIN jsonb_array_elements(p_steps) AS e ON nullif(e->>'id', '')::uuid = o.id
  ), uniq AS (
    SELECT old_order FROM old GROUP BY old_order HAVING count(*) = 1
  )
  SELECT jsonb_object_agg(u.old_order::text, m.new_order) INTO v_map
    FROM uniq u
    CROSS JOIN LATERAL (
      SELECT k.new_order FROM kept k WHERE k.old_order >= u.old_order ORDER BY k.old_order LIMIT 1
    ) m
   WHERE m.new_order <> u.old_order;
  v_map := coalesce(v_map, '{}'::jsonb);

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

  -- SEQCURSOR.1 — move live and paused enrolments with their next step, in
  -- the same transaction, so no runner tick sees new rows under an old cursor.
  -- One statement: a remap chain (1->2, 2->3) cannot cascade.
  IF v_map <> '{}'::jsonb THEN
    UPDATE public.sequence_enrollments e
       SET current_step_order = (v_map->>((e.current_step_order + 1)::text))::integer - 1
     WHERE e.sequence_id = p_sequence_id
       AND e.status IN ('active', 'paused')
       AND v_map ? ((e.current_step_order + 1)::text);
    GET DIAGNOSTICS v_remapped = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('updated', v_updated, 'inserted', v_inserted, 'deleted', v_deleted, 'remapped', v_remapped);
END
$$;

COMMENT ON FUNCTION public.publish_sequence_steps(uuid, jsonb) IS
  'STEPATTRIB.1 (mig 698) + SEQCURSOR.1 (mig 840): apply a compiled flow-graph publish to sequence_steps in one transaction. Rows named by id are updated in place, others inserted, the rest deleted; active and paused enrolments move with their next step. Service role only.';

REVOKE EXECUTE ON FUNCTION public.publish_sequence_steps(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_sequence_steps(uuid, jsonb) TO service_role;

DO $check$
BEGIN
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.publish_sequence_steps(uuid, jsonb)'::regprocedure) THEN
    RAISE EXCEPTION '840: publish_sequence_steps must be SECURITY INVOKER';
  END IF;
  IF has_function_privilege('anon', 'public.publish_sequence_steps(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.publish_sequence_steps(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '840: a client role can execute publish_sequence_steps';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.publish_sequence_steps(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '840: service_role cannot execute publish_sequence_steps';
  END IF;
END
$check$;

COMMIT;
