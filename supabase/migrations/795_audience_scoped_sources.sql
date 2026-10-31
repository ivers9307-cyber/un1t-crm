-- 795 — AUDIENCEIDS.1: server-side id scoping for the audience virtual fields.
--
-- WHY
-- The `tag`, `event_registration` and `location_list` audience fields are
-- resolved in JS into a contacts.id list that src/lib/audience-filter.js then
-- placed on the PostgREST GET URL as `id=in.(…)` / `id=not.in.(…)`. A uuid
-- costs 39 URL characters, so a tag with 1,754 members is a ~70 KB URL, and
-- the request fails before PostgREST answers: supabase-js resolves `{ error }`
-- with an EMPTY message, campaign-sender records "audience load failed: " and
-- the run-campaigns cron marks the campaign failed after its grace. Live on
-- 31 Oct 2026: campaign eb5dc3bf-a3bb-4223-b2ef-f7cdb026be82 at Stillorgan,
-- two `tag neq` filters resolving to 148 + 1,754 ids, every tick. The
-- MAX_EXCLUSION_IDS = 2000 count bound protected nothing: the limit is URL
-- bytes (supabase-js's own default urlLengthLimit is 8,000 characters).
--
-- WHAT
-- Two SQL functions, one per audience base relation, that return the SAME
-- rows as the relation already scoped to one studio and to an include and/or
-- exclude id set carried in the POST BODY (an rpc), where size is no concern.
-- PostgREST applies the caller's remaining filters, select, order and range
-- to a SETOF-returning function exactly as it does to the relation, so
-- applyAudienceFilterAsync keeps its `{ query }` contract: when the resolved
-- id list no longer fits the URL budget it swaps the base for the function
-- (the caller's `rebase`), and a small list keeps the GET path unchanged.
--
--   contact_location_audience_scoped(p_location_id, p_include, p_exclude)
--     → SETOF public.contact_location_audience (the send-path view, mig 491/689)
--   studio_contacts_scoped(p_location_id, p_include, p_exclude)
--     → SETOF public.studio_contacts (the match set, mig 765)
--
-- p_include NULL = no inclusion constraint; p_exclude NULL = nothing excluded.
-- The inclusion is `id = ANY(array)` (index-friendly on contacts.id); the
-- exclusion is a NOT EXISTS over unnest() so the planner hash anti-joins it
-- instead of comparing every row against every element.
--
-- Both are SECURITY INVOKER, STABLE, LANGUAGE sql, service_role only (mig
-- 667 default; the REVOKE below is the stated decision). Both views are
-- security_invoker and service-role only, so a client could read nothing
-- through them even with EXECUTE.
--
-- DEPENDENCY: `RETURNS SETOF <view>` makes each function depend on its view's
-- row type. A later `CREATE OR REPLACE VIEW` that APPENDS columns (the mig 689
-- shape) is fine and the function returns the new columns. A `DROP VIEW`
-- (the mig 652 shape) stops on the dependency, by design: re-create the view,
-- then re-run this file's CREATE for its function (CREATE OR REPLACE keeps the
-- ACL, so the REVOKE need not be repeated but is harmless).
--
-- Rollback: DROP FUNCTION public.contact_location_audience_scoped(uuid, uuid[], uuid[]);
--           DROP FUNCTION public.studio_contacts_scoped(uuid, uuid[], uuid[]);
--           (the JS falls back to the GET path and its loud InvalidAudienceFilterError
--           above the URL budget — never a silent failure).

CREATE OR REPLACE FUNCTION public.contact_location_audience_scoped(
  p_location_id uuid,
  p_include uuid[] DEFAULT NULL,
  p_exclude uuid[] DEFAULT NULL
)
RETURNS SETOF public.contact_location_audience
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT a.*
    FROM public.contact_location_audience a
   WHERE a.audience_location_id = p_location_id
     AND (p_include IS NULL OR a.id = ANY (p_include))
     AND (p_exclude IS NULL OR NOT EXISTS (
           SELECT 1 FROM unnest(p_exclude) AS x(id) WHERE x.id = a.id))
$$;

COMMENT ON FUNCTION public.contact_location_audience_scoped(uuid, uuid[], uuid[]) IS
  'AUDIENCEIDS.1 (mig 795): contact_location_audience at one studio, scoped to an include/exclude contact-id set carried in the rpc body. Base for audience-filter.js when a resolved id list does not fit the GET URL. service_role only.';

REVOKE EXECUTE ON FUNCTION public.contact_location_audience_scoped(uuid, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.studio_contacts_scoped(
  p_location_id uuid,
  p_include uuid[] DEFAULT NULL,
  p_exclude uuid[] DEFAULT NULL
)
RETURNS SETOF public.studio_contacts
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT s.*
    FROM public.studio_contacts s
   WHERE s.studio_location_id = p_location_id
     AND (p_include IS NULL OR s.id = ANY (p_include))
     AND (p_exclude IS NULL OR NOT EXISTS (
           SELECT 1 FROM unnest(p_exclude) AS x(id) WHERE x.id = s.id))
$$;

COMMENT ON FUNCTION public.studio_contacts_scoped(uuid, uuid[], uuid[]) IS
  'AUDIENCEIDS.1 (mig 795): studio_contacts at one studio, scoped to an include/exclude contact-id set carried in the rpc body. Base for audience-filter.js (match-set counts, sequence audiences) when a resolved id list does not fit the GET URL. service_role only.';

REVOKE EXECUTE ON FUNCTION public.studio_contacts_scoped(uuid, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;

-- Self-check: both functions exist, are service-role only, and return their view's row type.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['contact_location_audience_scoped', 'studio_contacts_scoped'] LOOP
    IF to_regprocedure(format('public.%s(uuid, uuid[], uuid[])', fn)) IS NULL THEN
      RAISE EXCEPTION 'mig 795: public.%(uuid, uuid[], uuid[]) is missing', fn;
    END IF;
    IF has_function_privilege('anon', format('public.%s(uuid, uuid[], uuid[])', fn), 'EXECUTE')
       OR has_function_privilege('authenticated', format('public.%s(uuid, uuid[], uuid[])', fn), 'EXECUTE') THEN
      RAISE EXCEPTION 'mig 795: a client role can execute public.%', fn;
    END IF;
  END LOOP;
  IF (SELECT prorettype::regtype::text FROM pg_proc WHERE oid = 'public.contact_location_audience_scoped(uuid, uuid[], uuid[])'::regprocedure)
     <> 'contact_location_audience' THEN
    RAISE EXCEPTION 'mig 795: contact_location_audience_scoped does not return the view row type';
  END IF;
  IF (SELECT prorettype::regtype::text FROM pg_proc WHERE oid = 'public.studio_contacts_scoped(uuid, uuid[], uuid[])'::regprocedure)
     <> 'studio_contacts' THEN
    RAISE EXCEPTION 'mig 795: studio_contacts_scoped does not return the view row type';
  END IF;
END $$;
