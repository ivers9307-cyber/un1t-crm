-- 846_reconcile_contact_studios_batch.sql
--
-- RECONCILEBATCH.1 (16 Nov 2026): the nightly contact_studios reconcile runs in
-- batches, so each call fits inside the API's statement timeout.
--
-- NOT APPLIED YET when this file was written. Apply it BEFORE the RECONCILEBATCH.1
-- code deploys: the cron then calls this function, and until it exists the
-- call 404s (the night reads as stale, as it already does). Applying it early
-- changes nothing: the old function is left exactly as it is.
--
-- WHY
-- Mig 838 fixed the permission error, and the 03:30 run on 16 Nov then failed
-- on "canceling statement due to statement timeout" after 8 s. PostgREST runs
-- every RPC under the authenticator role's statement_timeout (8 s), and one
-- call re-deriving all ~9,470 (contact, studio) pairs (9,104 at Stillorgan, so
-- a per-studio split does not help) takes longer than that.
--
-- WHAT
--   public.reconcile_contact_studios_batch(p_after uuid, p_limit integer)
--   RETURNS TABLE (inserted, updated, ended, unchanged, last_contact_id, done).
--   Takes the next p_limit contacts by id after p_after (1..5000, default
--   500), re-derives every (contact, studio) pair they have from the same five
--   sources as reconcile_contact_studios, through the same
--   private.contact_studios_upsert, and says where it stopped. The cron loops
--   from NULL until `done`. Same security as 838: SECURITY DEFINER, search_path
--   pinned to public, pg_temp, EXECUTE for service_role only.
--   reconcile_contact_studios(uuid) is untouched (the backfill still uses it).
--
-- ROLLBACK: DROP FUNCTION public.reconcile_contact_studios_batch(uuid, integer);
--   (revert the RECONCILEBATCH.1 code first).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.reconcile_contact_studios_batch(
  p_after uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (inserted integer, updated integer, ended integer, unchanged integer, last_contact_id uuid, done boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  pair record;
  outcome text;
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 5000));
  v_ids uuid[];
BEGIN
  inserted := 0; updated := 0; ended := 0; unchanged := 0;

  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids
    FROM (
      SELECT c.id FROM public.contacts c
       WHERE p_after IS NULL OR c.id > p_after
       ORDER BY c.id
       LIMIT v_limit
    ) s;

  IF v_ids IS NULL THEN
    last_contact_id := p_after;
    done := true;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR pair IN
    SELECT DISTINCT x.contact_id, x.location_id
      FROM (
        SELECT c.id AS contact_id, c.location_id FROM public.contacts c WHERE c.id = ANY (v_ids) AND c.location_id IS NOT NULL
        UNION SELECT d.contact_id, d.location_id FROM public.deals d WHERE d.contact_id = ANY (v_ids) AND d.location_id IS NOT NULL
        UNION SELECT uc.contact_id, uc.location_id FROM public.un1t_clients uc WHERE uc.contact_id = ANY (v_ids)
        UNION SELECT p.contact_id, p.location_id FROM public.contact_location_preferences p WHERE p.contact_id = ANY (v_ids)
        UNION SELECT cs.contact_id, cs.location_id FROM public.contact_studios cs WHERE cs.contact_id = ANY (v_ids)
      ) x
     ORDER BY x.contact_id, x.location_id
  LOOP
    outcome := private.contact_studios_upsert(pair.contact_id, pair.location_id);
    IF outcome = 'inserted' THEN inserted := inserted + 1;
    ELSIF outcome = 'updated' THEN updated := updated + 1;
    ELSIF outcome = 'ended' THEN ended := ended + 1;
    ELSIF outcome = 'unchanged' THEN unchanged := unchanged + 1;
    END IF;
  END LOOP;

  last_contact_id := v_ids[array_length(v_ids, 1)];
  done := array_length(v_ids, 1) < v_limit;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.reconcile_contact_studios_batch(uuid, integer) IS
  'RECONCILEBATCH.1 (mig 846): reconcile_contact_studios for the next p_limit contacts by id after p_after, so each call fits the API statement timeout. Same sources and the same private.contact_studios_upsert; the nightly cron loops it until done. SECURITY DEFINER (like 838), service role only.';

REVOKE EXECUTE ON FUNCTION public.reconcile_contact_studios_batch(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_contact_studios_batch(uuid, integer) TO service_role;

DO $check$
DECLARE
  f oid := to_regprocedure('public.reconcile_contact_studios_batch(uuid, integer)');
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f) THEN
    RAISE EXCEPTION 'mig 846: reconcile_contact_studios_batch is not SECURITY DEFINER';
  END IF;
  IF NOT coalesce((SELECT 'search_path=public, pg_temp' = ANY (proconfig) FROM pg_proc WHERE oid = f), false) THEN
    RAISE EXCEPTION 'mig 846: reconcile_contact_studios_batch search_path is not pinned to public, pg_temp';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 846: a client role can execute reconcile_contact_studios_batch';
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 846: service_role cannot execute reconcile_contact_studios_batch';
  END IF;
END
$check$;

COMMIT;
