-- 653 — CONTACTSELFWRITE.1: no browser or phone session writes public.contacts.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 28 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-653-contacts-client-writes-off.test.js).
--
-- ===========================================================================
-- THE FINDING
-- ===========================================================================
-- contacts kept Supabase's default table privileges (anon and authenticated:
-- arwdDxtm, granted by postgres), and three permissive write policies:
--   contacts_update  UPDATE TO public   USING/CHECK auth_is_in_location(location_id)
--                                                   OR user_id = auth.uid()
--   contacts_insert  INSERT TO authenticated  CHECK auth_is_in_location(location_id)
--   contacts_delete  DELETE TO authenticated  USING auth_is_in_location(location_id)
-- So, from their own login with the public anon key:
--   * a member (app login, no staff profile) could UPDATE EVERY column of their
--     own contact row: glofox_member_id (which CRM, agent and payment flows use
--     to act in Glofox for that person), location_id (which member routes
--     trust), tags, lifetime value, stage, consent flags, counters;
--   * any active staff member could INSERT, UPDATE (incl. user_id: relink a
--     login to any contact) or DELETE (cascades into 52 tables) any contact at
--     their studio, skipping every route check.
--
-- VERIFIED LIVE (28 Sep, BEFORE this migration):
--   relacl {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--   authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}; no column
--   ACLs; RLS on, not forced; not in supabase_realtime.
--   EXPLAIN of the member UPDATE and the staff DELETE plan (privilege check
--   passes; the only filter is the policy). A plain staff session reads 8,687
--   contacts; 14 contacts carry a user_id (12 of them staff logins).
--   Edge logs (two 24 h windows): every PATCH/POST/DELETE on /rest/v1/contacts
--   was service_role; authenticated only ever GETs.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER from anon,
--   authenticated, PUBLIC; drop the three write policies. SELECT (table grant
--   and contacts_select) is NOT changed.
--   Every contacts write in the estate is a service-role route (un1t-crm: 82
--   sites in 58 server files; champ-app: auth callback, link-contact,
--   notification-prefs) or a SECURITY DEFINER trigger owned by postgres (deals
--   stage slug, contact_preferences consent mirrors, person groups, bookings,
--   email sends). None is affected.
--   The one INVOKER path: log_wa_message_to_timeline (AFTER INSERT ON
--   whatsapp_messages) updates contacts as the inserting role, so a CLIENT
--   insert of a message with a contact_id now fails 42501. No client inserts
--   whatsapp_messages (code + edge logs); service_role inserts are unchanged.
--
-- CONSUMERS CHECKED (origin/main dd7583d5; champ-app 828ce00): no browser,
-- phone (any bundle since April, incl. the deleted champ-app Expo tree) or
-- champ-app user-session code writes contacts. Reads are unchanged.
--
-- Guard: tests/contacts-client-writes-guard.test.js fails a client writer and
-- any later migration that grants a client role a write privilege on contacts
-- or adds a permissive write policy to it.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C49-CONTACTSELFWRITE.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on contacts (the hottest table). If a
-- long reader holds it, abort the apply after 5 s rather than queue every
-- contacts query behind this file. Nothing is half-applied: re-run later.
SET LOCAL lock_timeout = '5s';

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.contacts FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS contacts_insert ON public.contacts;
DROP POLICY IF EXISTS contacts_update ON public.contacts;
DROP POLICY IF EXISTS contacts_delete ON public.contacts;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
BEGIN
  -- 1. Anything but SELECT, at table or column level, for the client roles.
  SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (grantor ' || grantor || ')', ', ')
    INTO v_extra
    FROM (
      SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'contacts'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
      UNION ALL
      SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'contacts'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
    ) g;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'mig 653: anon/authenticated/PUBLIC still hold write privileges on public.contacts: %', v_extra;
  END IF;

  -- 2. The same question asked of the real catalog, which follows role
  --    membership and PUBLIC (information_schema lists role NAMES only).
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.contacts', v_priv) THEN
        RAISE EXCEPTION 'mig 653: % still holds % on public.contacts', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  -- 3. No column-level write privilege through any path. One privilege per
  --    call (a comma list would answer "any of them", hiding which one).
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege(v_role, 'public.contacts', v_priv) THEN
        RAISE EXCEPTION 'mig 653: % still holds column-level % on public.contacts', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  -- 4. Reads unchanged; the server path still writes.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT has_table_privilege(v_role, 'public.contacts', 'SELECT') THEN
      RAISE EXCEPTION 'mig 653: % lost SELECT on public.contacts', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.contacts', 'UPDATE') THEN
    RAISE EXCEPTION 'mig 653: service_role lost UPDATE on public.contacts';
  END IF;

  -- 5. No policy may be left that would arm a write if a grant came back, and
  --    the read policy is the one it was.
  SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname)
    INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'contacts'
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 653: write policies remain on public.contacts: %', v_policies;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts'
                     AND policyname = 'contacts_select' AND cmd = 'SELECT' AND permissive = 'PERMISSIVE') THEN
    RAISE EXCEPTION 'mig 653: public.contacts should keep exactly one policy, contacts_select FOR SELECT';
  END IF;

  RAISE NOTICE 'mig 653: public.contacts is read-only for anon/authenticated (SELECT + contacts_select unchanged); every write is service_role or a SECURITY DEFINER trigger.';
END $$;

COMMIT;
