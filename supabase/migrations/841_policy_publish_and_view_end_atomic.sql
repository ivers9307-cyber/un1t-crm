-- 841_policy_publish_and_view_end_atomic.sql
--
-- POLICYATOMIC.1 (15 Nov 2026 feature audit, step 2 item 7; October findings
-- A10 and A23).
--
-- NOT APPLIED YET when this file was written. Apply it BEFORE the code that
-- calls these two functions deploys: until then both calls 404 and the routes
-- answer 500 (publishing a policy version and recording a reading time stop
-- working; nothing is lost or changed). Behaviour is proven ahead of apply by
-- tests/migration-841-policy-atomic.test.js (PGlite).
--
-- WHY
-- A10. publishVersion (src/lib/policies.js) cleared is_current on the live
--      version in one call and inserted the new version in a second. If the
--      insert failed (a bad date, a dropped connection, two publishes at once
--      tripping the version-number index) the policy was left with NO current
--      version, so staff saw nothing to read or sign.
-- A23. PATCH /api/policies/[slug]/views read the stored reading time, took the
--      max in JS and wrote it back. Two requests in flight (the page sends one
--      on hide and one on unload) could write the shorter one last, and a
--      request with no section times replaced the stored ones with NULL.
--
-- WHAT
--   1. public.publish_policy_version(p_policy_id, p_body_markdown,
--      p_change_summary, p_effective_date, p_published_by) RETURNS TABLE
--      (id, version_number). One transaction: lock the policy row (so two
--      publishes of one policy queue), number the version, clear the old
--      current, insert the new current. Any failure rolls the whole thing back
--      and the old version stays current.
--   2. public.record_policy_view_end(p_view_id, p_profile_id, p_duration,
--      p_section_dwell) RETURNS TABLE (id, ended_at, total_duration_seconds).
--      One UPDATE that only ever raises: total = GREATEST(stored, new), and
--      section_dwell merged key by key keeping the larger number. NULL or an
--      empty map leaves the stored section times as they are. Matches only the
--      caller's own row (p_profile_id), so 0 rows back means "not yours / gone".
--   Both SECURITY INVOKER, search_path '', EXECUTE for service_role only
--   (mig 667's rule; the routes run as service_role).
--
-- ROLLBACK: DROP FUNCTION public.publish_policy_version(uuid, text, text, date, uuid);
--           DROP FUNCTION public.record_policy_view_end(uuid, uuid, integer, jsonb);
--           (revert the POLICYATOMIC.1 code first or both routes 500).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Publish a policy version atomically.
CREATE OR REPLACE FUNCTION public.publish_policy_version(
  p_policy_id uuid,
  p_body_markdown text,
  p_change_summary text,
  p_effective_date date,
  p_published_by uuid
)
RETURNS TABLE (id uuid, version_number integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_next integer;
BEGIN
  -- Serialise publishes of one policy, and refuse an unknown one.
  PERFORM 1 FROM public.policies p WHERE p.id = p_policy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publish_policy_version: policy % not found', p_policy_id USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(max(v.version_number), 0) + 1 INTO v_next
    FROM public.policy_versions v
   WHERE v.policy_id = p_policy_id;

  UPDATE public.policy_versions v
     SET is_current = false
   WHERE v.policy_id = p_policy_id AND v.is_current = true;

  RETURN QUERY
  INSERT INTO public.policy_versions AS nv
    (policy_id, version_number, body_markdown, change_summary, effective_date, published_by, is_current)
  VALUES
    (p_policy_id, v_next, p_body_markdown, nullif(p_change_summary, ''), p_effective_date, p_published_by, true)
  RETURNING nv.id, nv.version_number;
END
$$;

COMMENT ON FUNCTION public.publish_policy_version(uuid, text, text, date, uuid) IS
  'POLICYATOMIC.1 (mig 841): publish a new policy version in one transaction (number it, clear the old current, insert the new current). A failure leaves the old version current. Service role only.';

-- 2. Record the end of a policy reading, only ever raising the evidence.
CREATE OR REPLACE FUNCTION public.record_policy_view_end(
  p_view_id uuid,
  p_profile_id uuid,
  p_duration integer,
  p_section_dwell jsonb
)
RETURNS TABLE (id uuid, ended_at timestamptz, total_duration_seconds integer)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.policy_views pv
     SET ended_at = now(),
         total_duration_seconds = GREATEST(coalesce(pv.total_duration_seconds, 0), coalesce(p_duration, 0)),
         section_dwell = CASE
           WHEN p_section_dwell IS NULL OR jsonb_typeof(p_section_dwell) <> 'object' OR p_section_dwell = '{}'::jsonb
             THEN pv.section_dwell
           ELSE coalesce((
             SELECT jsonb_object_agg(k, to_jsonb(m))
               FROM (
                 SELECT k, max(n) AS m
                   FROM (
                     SELECT e.key AS k, (e.value #>> '{}')::numeric AS n
                       FROM jsonb_each(CASE WHEN jsonb_typeof(pv.section_dwell) = 'object' THEN pv.section_dwell ELSE '{}'::jsonb END) AS e
                      WHERE jsonb_typeof(e.value) = 'number'
                     UNION ALL
                     SELECT e.key, (e.value #>> '{}')::numeric
                       FROM jsonb_each(p_section_dwell) AS e
                      WHERE jsonb_typeof(e.value) = 'number'
                   ) AS both_maps
                  GROUP BY k
               ) AS merged
           ), pv.section_dwell)
         END
   WHERE pv.id = p_view_id AND pv.profile_id = p_profile_id
  RETURNING pv.id, pv.ended_at, pv.total_duration_seconds;
$$;

COMMENT ON FUNCTION public.record_policy_view_end(uuid, uuid, integer, jsonb) IS
  'POLICYATOMIC.1 (mig 841): end a policy reading in one UPDATE that only raises the evidence: the larger total, and section times merged keeping the larger per section (none sent keeps the stored ones). Caller-owned rows only. Service role only.';

REVOKE EXECUTE ON FUNCTION public.publish_policy_version(uuid, text, text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_policy_view_end(uuid, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_policy_version(uuid, text, text, date, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_policy_view_end(uuid, uuid, integer, jsonb) TO service_role;

DO $check$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.publish_policy_version(uuid, text, text, date, uuid)',
    'public.record_policy_view_end(uuid, uuid, integer, jsonb)'
  ] LOOP
    IF (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN
      RAISE EXCEPTION '841: % must be SECURITY INVOKER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '841: a client role can execute %', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION '841: service_role cannot execute %', f;
    END IF;
  END LOOP;
END
$check$;

COMMIT;
