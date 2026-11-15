-- RECONCILEDEF.1 — the nightly contact_studios reconcile can run at all.
--
-- public.reconcile_contact_studios() (mig 764, rewritten by 768 and 770) is
-- SECURITY INVOKER and calls private.contact_studios_upsert() once per pair.
-- Its only callers are the contact-studios-reconcile cron and
-- markDormantAtStudio, both on the service-role client. service_role holds no
-- USAGE on schema private (on purpose: migs 721 and 753 say so), so every call
-- since mig 764 has failed with "permission denied for schema private" and
-- PostgREST has answered 403. The cron has never stamped its heartbeat
-- (stale since 20 Oct 2026, confirmed in the database logs on 15 Nov 2026).
-- The rows have only ever been written by the three DEFINER triggers and
-- src/lib/contact-studios.js, never corrected by the nightly pass.
--
-- Fix: run the reconcile as its owner, as those triggers already do. ALTER, not
-- CREATE OR REPLACE, so the body, the comment and the ACL stay exactly as 770
-- left them. The search_path is already pinned to public, pg_temp (pg_temp
-- last, so a temporary object can never shadow a public one). EXECUTE stays
-- service_role only: no client role may run a definer function that rewrites
-- every studio's rows. Granting service_role USAGE on private instead would
-- widen every private helper to every route, which is the opposite of the
-- intent recorded in 721 and 753.
--
-- Idempotent: a second run changes nothing and passes its self-check.
-- Fictional ids only: the repo is public.

ALTER FUNCTION public.reconcile_contact_studios(uuid) SECURITY DEFINER;
ALTER FUNCTION public.reconcile_contact_studios(uuid) SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.reconcile_contact_studios(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_contact_studios(uuid) TO service_role;

COMMENT ON FUNCTION public.reconcile_contact_studios(uuid) IS
  'ORGCONTACTS.1 (mig 764; mig 770 reads the membership facts off the row): re-derive every contact_studios row (one studio, or all when NULL) from the source rows through derive_contact_studio(). The backfill and the nightly contact-studios-reconcile cron. SECURITY DEFINER since mig 838 (it calls private.contact_studios_upsert, and service_role has no USAGE on schema private). Service role only.';

-- Self-check: the catalog, never this file.
DO $$
DECLARE
  f oid := to_regprocedure('public.reconcile_contact_studios(uuid)');
BEGIN
  IF f IS NULL THEN
    RAISE EXCEPTION 'mig 838: public.reconcile_contact_studios(uuid) does not exist';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f) THEN
    RAISE EXCEPTION 'mig 838: reconcile_contact_studios is not SECURITY DEFINER';
  END IF;
  IF NOT coalesce((SELECT 'search_path=public, pg_temp' = ANY (proconfig) FROM pg_proc WHERE oid = f), false) THEN
    RAISE EXCEPTION 'mig 838: reconcile_contact_studios search_path is not pinned to public, pg_temp';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 838: a client role can execute reconcile_contact_studios';
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 838: service_role cannot execute reconcile_contact_studios';
  END IF;
END;
$$;
