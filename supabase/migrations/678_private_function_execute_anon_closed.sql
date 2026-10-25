-- 678 — PRIVATEFNEXEC.1: anon and PUBLIC execute no function in schema
-- private; authenticated and service_role keep exactly the EXECUTE they had;
-- and a NEW function postgres creates in private is executable by postgres,
-- authenticated and service_role (no longer PUBLIC).
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file (read-only, Supabase MCP, 30 Sep 2026, re-read after mig 677 was
-- applied: the private census is unchanged by 677). Proven ahead of apply by
-- tests/migration-678-private-function-execute-anon-closed.test.js (PGlite).
--
-- ===========================================================================
-- THE FINDING (follow-ups C77, found planning C67: F2)
-- ===========================================================================
-- VERIFIED LIVE: 46 functions in private, all owned by postgres. anon could
-- execute 26 of them:
--   * 20 with a NULL ACL (Postgres's built-in default: PUBLIC EXECUTE), e.g.
--     the RLS helpers auth_is_master(), auth_mobile_can(uuid,text),
--     mobile_can_for(uuid,uuid,text), auth_can_view_all_profiles(), 15
--     trigger functions and wa_phone_from_phone(text);
--   * 5 with an explicit PUBLIC item (auth_is_admin_at, auth_is_in_organization,
--     auth_is_manager_at, auth_is_owner_at, get_user_role_at);
--   * auth_is_active_staff(), granted to anon by name.
-- anon has no USAGE on schema private, so it cannot CALL one by name, but a
-- stored expression references a function by OID and skips the schema
-- check: a policy "TO public" that calls auth_is_master() runs it for anon.
-- 31 public-schema policies open to anon/PUBLIC call one of the 26; after
-- mig 677 anon holds no privilege on any of their tables, so none is
-- evaluated for anon. No view, column default, generated column, CHECK or
-- index expression references any of the 26. The storage.objects policies
-- that call two of them are TO authenticated.
-- authenticated executes all 26 (and 13 more by explicit grant): the RLS
-- helpers need it. service_role executes 25 of them (through PUBLIC; not
-- auth_is_active_staff), although it has no USAGE on private and bypasses
-- RLS; kept anyway, so nothing but anon/PUBLIC moves.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   A. REVOKE EXECUTE … FROM PUBLIC, anon on the 26.
--   B. GRANT EXECUTE … TO authenticated, service_role on the 25 that reached
--      them through PUBLIC (a no-op for authenticated on the 5 that already
--      name it); auth_is_active_staff() keeps its authenticated-only shape.
--   C. The private default: PUBLIC out, authenticated + service_role in (the
--      global default is postgres-only since mig 667).
-- Other roles that reached the 25 only through PUBLIC (authenticator,
-- dashboard_user, supabase_*_admin) lose EXECUTE: none evaluates them as
-- itself (PostgREST, Storage and Realtime switch to the request's role).
-- A snapshot of authenticated's, service_role's and postgres's EXECUTE on
-- every private and public function, the schema ACLs and every other
-- default row is read BEFORE and compared AFTER.
--
-- Guard: tests/private-function-execute-guard.test.js.
-- APPLY: after merge AND after mig 677 (checked below); see
-- docs/superpowers/plans/2026-09-27-followups/C76-TABLEDEFAULTACL.1.md, Task 10.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. 677 must be live: anon reaches no public table, so no policy that
--       calls a private helper is evaluated for anon once A lands. ─────────
DO $$
DECLARE
  v_list text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_list
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND (has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('anon', c.oid, 'INSERT')
          OR has_table_privilege('anon', c.oid, 'UPDATE') OR has_table_privilege('anon', c.oid, 'DELETE'));
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 678: apply 677 first (anon still reaches: %)', v_list;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_list
    FROM pg_proc p WHERE p.pronamespace = 'private'::regnamespace AND p.proowner <> 'postgres'::regrole::oid;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 678: private functions not owned by postgres (audit them first): %', v_list;
  END IF;
END $$;

-- ── What must NOT move (a view stores no regrole/regnamespace constant) ──
CREATE TEMP VIEW mig678_state AS
  SELECT 'execute' AS kind, p.oid::regprocedure::text || ' ' || r AS item,
         has_function_privilege(r, p.oid, 'EXECUTE')::text AS val
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname IN ('public', 'private', 'extensions'),
         unnest(ARRAY['authenticated', 'service_role', 'postgres']) AS r
   WHERE p.proname NOT LIKE '\_mig678\_%'
  UNION ALL
  SELECT 'public/extensions acl', p.oid::regprocedure::text, coalesce(p.proacl::text, 'NULL')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname IN ('public', 'extensions')
  UNION ALL
  SELECT 'default acl', pg_get_userbyid(d.defaclrole) || ' ' || coalesce(n.nspname, '<global>') || ' ' || d.defaclobjtype::text,
         d.defaclacl::text
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
   WHERE NOT (pg_get_userbyid(d.defaclrole) = 'postgres' AND n.nspname = 'private' AND d.defaclobjtype = 'f')
  UNION ALL
  SELECT 'schema acl', nspname::text, coalesce(nspacl::text, 'NULL')
    FROM pg_namespace WHERE nspname IN ('public', 'private', 'extensions')
  UNION ALL
  SELECT 'policy', schemaname || '.' || tablename || ' ' || policyname,
         format('%s|%s|%s|%L|%L', permissive, cmd, roles::text, qual, with_check)
    FROM pg_policies;

CREATE TEMP TABLE mig678_before ON COMMIT DROP AS SELECT * FROM mig678_state;

-- ── A. anon and PUBLIC ───────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION
  private.auth_can_view_all_profiles(),
  private.auth_is_active_staff(),
  private.auth_is_admin_at(uuid),
  private.auth_is_in_organization(uuid),
  private.auth_is_manager_at(uuid),
  private.auth_is_master(),
  private.auth_is_owner_at(uuid),
  private.auth_mobile_can(uuid, text),
  private.bump_xero_refresh_ts(),
  private.get_user_role_at(uuid, uuid),
  private.guard_at_least_one_master(),
  private.guard_unifi_config_master_only(),
  private.log_mutation(),
  private.mobile_can_for(uuid, uuid, text),
  private.sync_contact_person_group(),
  private.sync_group_primary_flags(),
  private.touch_landing_page_settings_updated_at(),
  private.touch_orders_updated_at(),
  private.touch_org_settings_updated_at(),
  private.touch_organizations_updated_at(),
  private.touch_race_events_updated_at(),
  private.touch_race_payments_updated_at(),
  private.touch_race_registrations_updated_at(),
  private.touch_race_waves_updated_at(),
  private.touch_teams_updated_at(),
  private.wa_phone_from_phone(text)
FROM PUBLIC, anon;

-- ── B. keep what authenticated and service_role had through PUBLIC ───────
GRANT EXECUTE ON FUNCTION
  private.auth_can_view_all_profiles(),
  private.auth_is_admin_at(uuid),
  private.auth_is_in_organization(uuid),
  private.auth_is_manager_at(uuid),
  private.auth_is_master(),
  private.auth_is_owner_at(uuid),
  private.auth_mobile_can(uuid, text),
  private.bump_xero_refresh_ts(),
  private.get_user_role_at(uuid, uuid),
  private.guard_at_least_one_master(),
  private.guard_unifi_config_master_only(),
  private.log_mutation(),
  private.mobile_can_for(uuid, uuid, text),
  private.sync_contact_person_group(),
  private.sync_group_primary_flags(),
  private.touch_landing_page_settings_updated_at(),
  private.touch_orders_updated_at(),
  private.touch_org_settings_updated_at(),
  private.touch_organizations_updated_at(),
  private.touch_race_events_updated_at(),
  private.touch_race_payments_updated_at(),
  private.touch_race_registrations_updated_at(),
  private.touch_race_waves_updated_at(),
  private.touch_teams_updated_at(),
  private.wa_phone_from_phone(text)
TO authenticated, service_role;

-- ── C. the private default ───────────────────────────────────────────────
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text. Any failure raises and the
-- whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_list text;
  v_role text;
BEGIN
  -- 1. anon and PUBLIC execute nothing in private (follows membership and
  --    PUBLIC, and sees another grantor's grant).
  FOREACH v_role IN ARRAY ARRAY['anon', 'public'] LOOP
    SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_list
      FROM pg_proc p
     WHERE p.pronamespace = 'private'::regnamespace AND has_function_privilege(v_role, p.oid, 'EXECUTE');
    IF v_list IS NOT NULL THEN
      RAISE EXCEPTION 'mig 678: % can still execute: %', v_role, v_list;
    END IF;
  END LOOP;

  -- 2. No ACL item for PUBLIC (a NULL ACL is the built-in PUBLIC default).
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'private'::regnamespace
     AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0);
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 678: PUBLIC still holds EXECUTE on: %', v_list;
  END IF;

  -- 3. Nothing else moved: authenticated, service_role and postgres on every
  --    public/private/extensions function, public/extensions ACLs, schema
  --    ACLs, every other default row, every policy.
  SELECT string_agg(kind || ' ' || item || ': ' || coalesce(b.val, '(absent)') || ' -> ' || coalesce(a.val, '(absent)'), '; '
                    ORDER BY kind, item)
    INTO v_list
    FROM mig678_before b
    FULL JOIN mig678_state a USING (kind, item)
   WHERE b.val IS DISTINCT FROM a.val;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 678: something besides anon/PUBLIC changed: %', v_list;
  END IF;

  -- 4. The private default, by behaviour; public and extensions (mig 667)
  --    unchanged.
  EXECUTE format('DROP FUNCTION IF EXISTS private.%I()', '_mig678_probe');
  EXECUTE format('CREATE FUNCTION private.%I() RETURNS integer LANGUAGE sql IMMUTABLE AS %L', '_mig678_probe', 'SELECT 1');
  FOREACH v_role IN ARRAY ARRAY['anon', 'public'] LOOP
    IF has_function_privilege(v_role, 'private._mig678_probe()', 'EXECUTE') THEN
      RAISE EXCEPTION 'mig 678: a new function in private is still executable by %', v_role;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(v_role, 'private._mig678_probe()', 'EXECUTE') THEN
      RAISE EXCEPTION 'mig 678: a new function in private is not executable by % (a new RLS helper would 42501 every signed-in read)', v_role;
    END IF;
  END LOOP;
  EXECUTE format('DROP FUNCTION private.%I()', '_mig678_probe');

  RAISE NOTICE 'mig 678: anon and PUBLIC execute nothing in private; authenticated and service_role unchanged; new private functions are authenticated + service_role.';
END $$;

DROP VIEW mig678_state;

COMMIT;
