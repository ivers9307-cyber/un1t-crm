-- 677 — TABLEDEFAULTACL.1: anon holds nothing on any table, view or sequence
-- in public; authenticated holds no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN
-- anywhere in public and no sequence privilege; and a NEW table, view or
-- sequence postgres creates in public is open to postgres + service_role only.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file (read-only, Supabase MCP, 30 Sep 2026; migs up to 675 applied).
-- Re-read later on 30 Sep with 676 (C82) applied: every number below holds;
-- authenticated's table-level SELECT/INSERT/UPDATE/DELETE count went 899 ->
-- 893 (676 took the shift tables' writes; this file moves none of them).
-- Proven ahead of apply by
-- tests/migration-677-public-tables-default-acl-closed.test.js (PGlite).
--
-- ===========================================================================
-- THE FINDING (follow-ups C76, found planning C67: F1; C15, C82 F2, C91)
-- ===========================================================================
-- pg_default_acl for postgres in public gives anon, authenticated and
-- service_role ALL (arwdDxtm) on every new table and view, and rwU on every
-- new sequence. So every table was open to the anon key until a migration
-- closed it by hand (the 648-675 series). VERIFIED LIVE, 266 relations
-- (263 tables, 3 views, all owned by postgres, every grant by postgres, RLS
-- on every table) and 7 sequences:
--   * anon held something on 221 relations (1,754 privilege items): the full
--     default on 216 tables and 2 views (cron_health, tenant_cron_health);
--     rosters awdDxtm (618 took only SELECT); event_types SELECT + MAINTAIN;
--     profiles MAINTAIN. 147 of the 216 have no policy naming anon/PUBLIC.
--   * authenticated held TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on 224
--     relations (884 items), incl. MAINTAIN on whatsapp_messages (656 missed
--     it), contacts, event_types and profiles.
--   * anon and authenticated held USAGE/SELECT/UPDATE on 6 of 7 sequences.
--     No client-writable table uses one (the 3 serial defaults are on
--     service-role-only tables; the others are identity columns or unused).
--   * No PUBLIC item on any relation, no anon column grant.
-- What anon ACTUALLY reads: nothing. Edge logs 24 Sep 12:00 -> 30 Sep 12:00
-- UTC (six 24 h windows): 0 anon requests to /rest/v1/<table> or
-- /graphql/v1 but one anon GET /rest/v1/ (the OpenAPI root) and one GET
-- /rest/v1/time_off_requests with NO JWT role that returned 200 (24 Sep
-- 23:31: a new-format sb_publishable_ key over curl, limit=0, so no rows).
-- New-format keys carry no JWT role in the edge logs, so a watch for the
-- public key must count role = '' as well as 'anon', never 'anon' alone.
-- Every signed-out page (/welcome, /start, public bookings, events,
-- the class widget, the deposit page) reads through createServerClient()
-- (service_role). A rolled-back anon probe on prod: 190 relations return 0
-- rows, 27 raise 42501 inside a policy helper, and exactly two return rows
-- (google_reviews, landing_page_settings: their policies are TO anon) with
-- no reader of either. realtime.subscription held no row.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   A. REVOKE ALL ON ALL TABLES (tables, views) IN SCHEMA public FROM anon,
--      PUBLIC. google_reviews_public_read and landing_page_settings_public_read
--      stay (untouched, now inert): see the plan's DECISIONS.
--   B. REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA
--      public FROM authenticated. authenticated's SELECT/INSERT/UPDATE/DELETE
--      (table AND column level) are NOT touched: that is per-table work
--      (C83/C94/C101/C110). A table-level REVOKE REFERENCES also revokes
--      column REFERENCES; there is none. Column SELECT/UPDATE grants (618,
--      646, 648, 654) are untouched and the self-check proves it.
--   C. REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated,
--      PUBLIC.
--   D. The default for postgres in public, tables and sequences: revoke anon
--      and authenticated. There is no global row for tables/sequences and the
--      built-in default is owner-only (no PUBLIC), so the per-schema REVOKE is
--      the whole fix (unlike functions, mig 667). supabase_admin's own row for
--      public cannot be changed by postgres; 0 relations have another owner.
-- Nothing else moves: authenticated's other privileges, service_role's and
-- postgres's (effective, and every raw ACL item with its grantor and grant
-- option), every column ACL outside anon/REFERENCES (item by item, and the
-- raw attacl text byte for byte), every policy, RLS flags, ownership,
-- publications (members, column lists, row filters and options), function
-- ACLs, schema ACLs and every other default ACL row are read BEFORE and
-- compared AFTER.
--
-- CONSEQUENCE (CLAUDE.md invariant; tests/table-default-acl-guard.test.js):
-- a new public table/view/sequence is invisible to every client session until
-- its migration grants it. A table the phone, a browser file or champ-app
-- reads directly needs GRANT SELECT (and whatever else) … TO authenticated in
-- the migration that creates it; every other new table states REVOKE ALL …
-- FROM anon, authenticated (the 607/630/635/641/649 house style). DROP +
-- CREATE (a view too) resets the ACL to this closed default.
--
-- APPLY: after merge; see
-- docs/superpowers/plans/2026-09-27-followups/C76-TABLEDEFAULTACL.1.md, Task 5.
-- ===========================================================================

BEGIN;

-- ACL changes rewrite pg_class rows of tables the webhooks and crons write
-- every minute. Abort after 5 s rather than wait behind a long lock; nothing
-- is half-applied, re-run later.
SET LOCAL lock_timeout = '5s';

-- ── 0. The state this file was written against ───────────────────────────
DO $$
DECLARE
  v_list text;
BEGIN
  -- Every relation in public is owned by postgres, so postgres's REVOKE and
  -- its default ACL row cover all of them (a non-owner's REVOKE is a silent
  -- no-op on prod, where postgres is not superuser).
  SELECT string_agg(relname || ' (' || pg_get_userbyid(relowner) || ')', ', ' ORDER BY relname) INTO v_list
    FROM pg_class
   WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND relowner <> 'postgres'::regrole;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 677: relations in public not owned by postgres (audit them first): %', v_list;
  END IF;
  -- 667 must be live (it closed the function half of the same default).
  IF has_function_privilege('anon', 'public.list_enabled_integrations()', 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 677: apply 667 first';
  END IF;
END $$;

-- ── What must NOT move, read from the catalog before the REVOKEs ─────────
-- (A view may not store a regrole/regnamespace constant, so it matches by
-- name: nspname, rolname, pg_get_userbyid.)
CREATE TEMP VIEW mig677_state AS
  -- table-level, every relation in public, one privilege per row. anon is
  -- the subject of this file; authenticated's four maintenance privileges
  -- are expected to go.
  SELECT 'privilege' AS kind, c.relname || ' ' || r || ' ' || p AS item,
         has_table_privilege(r, c.oid, p)::text AS val
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public',
         unnest(ARRAY['authenticated', 'service_role', 'postgres']) AS r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS p
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND c.relname NOT LIKE '\_mig677\_%'
     AND NOT (r = 'authenticated' AND p IN ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'))
  UNION ALL
  SELECT 'sequence privilege', c.relname || ' ' || r || ' ' || p,
         has_sequence_privilege(r, c.oid, p)::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public',
         unnest(ARRAY['service_role', 'postgres']) AS r,
         unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p
   WHERE c.relkind = 'S'
     AND c.relname NOT LIKE '\_mig677\_%'
  UNION ALL
  -- every raw relation/sequence ACL item except anon's, PUBLIC's,
  -- authenticated's four maintenance privileges and authenticated's sequence
  -- items: grantor and grant option included (has_table_privilege sees
  -- neither).
  SELECT 'table acl', c.relname || ' ' || pg_get_userbyid(g.grantee) || ' ' || g.privilege_type,
         pg_get_userbyid(g.grantor) || '/' || g.is_grantable::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) g
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND c.relname NOT LIKE '\_mig677\_%'
     AND g.grantee <> 0 AND pg_get_userbyid(g.grantee) <> 'anon'
     AND NOT (pg_get_userbyid(g.grantee) = 'authenticated'
              AND (c.relkind = 'S' OR g.privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')))
  UNION ALL
  -- every column ACL item except anon's, PUBLIC's and authenticated's
  -- REFERENCES (none exist today; B would remove them).
  SELECT 'column acl', c.relname || '.' || a.attname || ' ' || pg_get_userbyid(g.grantee) || ' ' || g.privilege_type,
         pg_get_userbyid(g.grantor) || '/' || g.is_grantable::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = c.oid
    CROSS JOIN LATERAL aclexplode(a.attacl) g
   WHERE a.attacl IS NOT NULL
     AND g.grantee <> 0 AND pg_get_userbyid(g.grantee) <> 'anon'
     AND NOT (pg_get_userbyid(g.grantee) = 'authenticated' AND g.privilege_type = 'REFERENCES')
  UNION ALL
  -- and byte for byte: the raw attacl text of every column that holds no item
  -- this file may remove (on prod that is every column ACL there is).
  SELECT 'column acl text', c.relname || '.' || a.attname, a.attacl::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE a.attacl IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM aclexplode(a.attacl) g
                      WHERE g.grantee = 0 OR pg_get_userbyid(g.grantee) = 'anon'
                         OR (pg_get_userbyid(g.grantee) = 'authenticated' AND g.privilege_type = 'REFERENCES'))
  UNION ALL
  SELECT 'policy', schemaname || '.' || tablename || ' ' || policyname,
         format('%s|%s|%s|%L|%L', permissive, cmd, roles::text, qual, with_check)
    FROM pg_policies
  UNION ALL
  SELECT 'publication', pubname || ' ' || schemaname || '.' || tablename,
         format('member|%s|%L', attnames::text, rowfilter)
    FROM pg_publication_tables
  UNION ALL
  SELECT 'publication options', pubname::text,
         format('%s|%s|%s|%s|%s|%s|%s', pg_get_userbyid(pubowner), puballtables, pubinsert, pubupdate, pubdelete, pubtruncate, pubviaroot)
    FROM pg_publication
  UNION ALL
  SELECT 'rls', c.relname::text, c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE c.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'owner', c.relname::text, pg_get_userbyid(c.relowner)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND c.relname NOT LIKE '\_mig677\_%'
  UNION ALL
  -- every default ACL row but the two this file changes
  SELECT 'default acl', pg_get_userbyid(d.defaclrole) || ' ' || coalesce(n.nspname, '<global>') || ' ' || d.defaclobjtype::text,
         d.defaclacl::text
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
   WHERE NOT (pg_get_userbyid(d.defaclrole) = 'postgres' AND n.nspname = 'public' AND d.defaclobjtype IN ('r', 'S'))
  UNION ALL
  SELECT 'function acl', p.oid::regprocedure::text, coalesce(p.proacl::text, 'NULL')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname IN ('public', 'private')
  UNION ALL
  SELECT 'schema acl', nspname::text, coalesce(nspacl::text, 'NULL')
    FROM pg_namespace WHERE nspname IN ('public', 'private', 'extensions', 'storage');

CREATE TEMP TABLE mig677_before ON COMMIT DROP AS SELECT * FROM mig677_state;

-- ── A. anon (and PUBLIC, a no-op today): nothing on any table or view ────
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, PUBLIC;

-- ── B. authenticated: no maintenance privileges (PostgREST never uses them)
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA public FROM authenticated;

-- ── C. sequences: no client session uses one ─────────────────────────────
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, PUBLIC;

-- ── D. the default for what postgres creates in public from now on ───────
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_list text;
  v_role text;
  v_priv text;
  v_kind text;
BEGIN
  -- 1. anon and PUBLIC: nothing on any relation in public, one privilege per
  --    call (follows role membership and sees another grantor's grant).
  FOREACH v_role IN ARRAY ARRAY['anon', 'public'] LOOP
    SELECT string_agg(c.relname || ':' || p, ', ' ORDER BY c.relname, p) INTO v_list
      FROM pg_class c,
           unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS p
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND has_table_privilege(v_role, c.oid, p);
    IF v_list IS NOT NULL THEN
      RAISE EXCEPTION 'mig 677: % still holds: %', v_role, v_list;
    END IF;
    SELECT string_agg(c.relname || ':' || p, ', ' ORDER BY c.relname, p) INTO v_list
      FROM pg_class c, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND has_any_column_privilege(v_role, c.oid, p);
    IF v_list IS NOT NULL THEN
      RAISE EXCEPTION 'mig 677: % still holds column privileges: %', v_role, v_list;
    END IF;
  END LOOP;

  -- 2. The raw ACLs (MAINTAIN is not in information_schema): no anon or
  --    PUBLIC item on a relation, a column or a sequence in public.
  SELECT string_agg(DISTINCT c.relname, ', ') INTO v_list
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND (EXISTS (SELECT 1 FROM aclexplode(c.relacl) g WHERE g.grantee = 0 OR g.grantee = 'anon'::regrole::oid)
          OR EXISTS (SELECT 1 FROM pg_attribute a, aclexplode(a.attacl) g
                      WHERE a.attrelid = c.oid AND (g.grantee = 0 OR g.grantee = 'anon'::regrole::oid)));
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 677: ACLs still name anon or PUBLIC: %', v_list;
  END IF;

  -- 3. authenticated: none of the four anywhere, no column REFERENCES.
  SELECT string_agg(c.relname || ':' || p, ', ' ORDER BY c.relname, p) INTO v_list
    FROM pg_class c, unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS p
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND has_table_privilege('authenticated', c.oid, p);
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 677: authenticated still holds: %', v_list;
  END IF;
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_list
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND has_any_column_privilege('authenticated', c.oid, 'REFERENCES');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 677: authenticated still holds column REFERENCES on: %', v_list;
  END IF;

  -- 4. Sequences: no client role holds anything.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    SELECT string_agg(c.relname || ':' || p, ', ' ORDER BY c.relname, p) INTO v_list
      FROM pg_class c, unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
       AND has_sequence_privilege(v_role, c.oid, p);
    IF v_list IS NOT NULL THEN
      RAISE EXCEPTION 'mig 677: % still holds on sequences: %', v_role, v_list;
    END IF;
  END LOOP;

  -- 5. Nothing else moved.
  SELECT string_agg(kind || ' ' || item || ': ' || coalesce(b.val, '(absent)') || ' -> ' || coalesce(a.val, '(absent)'), '; '
                    ORDER BY kind, item)
    INTO v_list
    FROM mig677_before b
    FULL JOIN mig677_state a USING (kind, item)
   WHERE b.val IS DISTINCT FROM a.val;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 677: something besides anon, PUBLIC and authenticated''s maintenance/sequence privileges changed: %', v_list;
  END IF;

  -- 6. The default, by behaviour: create a table, a view and a sequence in
  --    public, ask who can use them, drop them. (format(): no literal CREATE
  --    for the migration scanners to read.)
  EXECUTE format('DROP VIEW IF EXISTS public.%I', '_mig677_probe_v');
  EXECUTE format('DROP TABLE IF EXISTS public.%I', '_mig677_probe_t');
  EXECUTE format('DROP SEQUENCE IF EXISTS public.%I', '_mig677_probe_s');
  EXECUTE format('CREATE TABLE public.%I (id integer)', '_mig677_probe_t');
  EXECUTE format('CREATE VIEW public.%I WITH (security_invoker = on) AS SELECT id FROM public.%I', '_mig677_probe_v', '_mig677_probe_t');
  EXECUTE format('CREATE SEQUENCE public.%I', '_mig677_probe_s');
  FOREACH v_kind IN ARRAY ARRAY['_mig677_probe_t', '_mig677_probe_v'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
        IF has_table_privilege(v_role, 'public.' || v_kind, v_priv) THEN
          RAISE EXCEPTION 'mig 677: a new % in public still gives % to %', CASE WHEN v_kind LIKE '%_t' THEN 'table' ELSE 'view' END, v_priv, v_role;
        END IF;
      END LOOP;
      IF NOT has_table_privilege('service_role', 'public.' || v_kind, v_priv) THEN
        RAISE EXCEPTION 'mig 677: a new % in public does not give % to service_role (every new server table would 42501)', CASE WHEN v_kind LIKE '%_t' THEN 'table' ELSE 'view' END, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_priv IN ARRAY ARRAY['USAGE', 'SELECT', 'UPDATE'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      IF has_sequence_privilege(v_role, 'public._mig677_probe_s', v_priv) THEN
        RAISE EXCEPTION 'mig 677: a new sequence in public still gives % to %', v_priv, v_role;
      END IF;
    END LOOP;
    IF NOT has_sequence_privilege('service_role', 'public._mig677_probe_s', v_priv) THEN
      RAISE EXCEPTION 'mig 677: a new sequence in public does not give % to service_role', v_priv;
    END IF;
  END LOOP;
  EXECUTE format('DROP VIEW public.%I', '_mig677_probe_v');
  EXECUTE format('DROP TABLE public.%I', '_mig677_probe_t');
  EXECUTE format('DROP SEQUENCE public.%I', '_mig677_probe_s');

  RAISE NOTICE 'mig 677: anon and PUBLIC hold nothing in public; authenticated holds no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN and no sequence privilege; new public tables, views and sequences start postgres + service_role only.';
END $$;

DROP VIEW mig677_state;

COMMIT;
