-- 742 — CBRCLIENTCLOSED.1: no client role (anon, authenticated, PUBLIC)
-- holds any privilege on public.class_booking_requests. Every read and write
-- is server code on the service role.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 18 Oct 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-742-class-booking-requests-client-closed.test.js).
--
-- ===========================================================================
-- THE FINDING (the TABLEDEFAULTACL / *CLIENTWRITE class, CLAUDE.md)
-- ===========================================================================
-- class_booking_requests (mig 335) is the /start class-booking queue: the
-- contact, the Glofox event, the payment and Revolut/Stripe order ids, the
-- processor's state. Mig 335 declared it "service-role only" and turned RLS
-- on with no policy, but never revoked Supabase's default table privileges.
-- Mig 677 took anon's and authenticated's TRUNCATE/REFERENCES/TRIGGER/
-- MAINTAIN and everything of anon's, and left authenticated with arwd. So
-- today the table is shut to a signed-in session only by RLS having no
-- policy: the first permissive policy anyone adds (or an RLS toggle) would
-- hand every staff and member login the whole queue, writes included.
--
-- VERIFIED LIVE (18 Oct, BEFORE this migration):
--   relacl {postgres=arwdDxtm/postgres,authenticated=arwd/postgres,
--   service_role=arwdDxtm/postgres}; information_schema.role_table_grants:
--   authenticated DELETE,INSERT,SELECT,UPDATE, anon nothing; no attacl on
--   any column (the column_privileges rows are the table grant echoed per
--   column); RLS on, not forced; 0 policies; owner postgres; in no
--   publication; no view depends on it; no policy elsewhere and no function
--   names it; one trigger, trg_cbr_updated_at -> update_updated_at()
--   (INVOKER; it fires as the service role, which keeps its privileges).
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE ALL from anon, authenticated and PUBLIC. RLS stays on with no
--   policy as the second fence. End state: service_role only, which is what
--   mig 335 said it was.
--
--   Every reader and writer is service_role: /api/public/class-booking (the
--   enqueue), /api/public/class-booking-payments/[id], the process-class-
--   bookings cron and the QStash class-bookings worker
--   (src/lib/class-booking-processor.js, src/lib/class-booking-queue.js), the
--   Revolut class-bookings and Stripe webhooks (src/lib/class-booking-
--   payments.js), /api/agent/membership-requests/[id] and the trial grant
--   (src/lib/agent/trial-grant.js), approvals SLA, the WhatsApp Flow
--   completion, and the ads read/attribution helpers. The one 'use client'
--   file naming the table (src/components/landing-page/ClassFunnelCheckout.jsx)
--   names it in a comment only; it talks to the public payment route.
--
-- CONSUMERS CHECKED (un1t-crm origin/main 62a6ebbc: src/, shared/, mobile/):
-- no browser, createAuthClient or phone code reads or writes it. champ-app
-- is out of scope for this check (the PR body says so).
--
-- Guard: tests/class-booking-requests-client-closed-guard.test.js.
--
-- APPLY: Supabase MCP apply_migration on iyvtbjjxdggiadzwwvdj BEFORE the PR
-- merges, then get_advisors (security). Rollback (only if something client-
-- side turns out to need it, which nothing found does):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_booking_requests TO authenticated;
-- ===========================================================================

BEGIN;

-- REVOKE takes a brief lock on a table the public booking route and the
-- every-minute drain cron write. Abort after 5 s rather than queue behind
-- them. Nothing is half-applied: re-run.
SET LOCAL lock_timeout = '5s';

REVOKE ALL ON public.class_booking_requests FROM anon, authenticated, PUBLIC;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rel constant text := 'public.class_booking_requests';
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
BEGIN
  -- 0. RLS still on: with no policy it is the second fence behind the grant.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
    RAISE EXCEPTION 'mig 742: row level security is off on %', v_rel;
  END IF;

  -- 1. anon, authenticated, PUBLIC: nothing, table and column level, any grantor.
  SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
    INTO v_extra
    FROM (
      SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'class_booking_requests'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC')
      UNION ALL
      SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'class_booking_requests'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) g;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'mig 742: client roles still hold privileges on %: %', v_rel, v_extra;
  END IF;

  -- 2. The same question asked of the real catalog (role membership,
  --    PUBLIC), one privilege per call. MAINTAIN is not in information_schema.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF has_table_privilege(v_role, v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 742: % still holds % on %', v_role, v_priv, v_rel;
      END IF;
    END LOOP;
    -- 3. No column-level privilege through any path.
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 742: % still holds column-level % on %', v_role, v_priv, v_rel;
      END IF;
    END LOOP;
  END LOOP;

  -- 4. The server still reads and writes.
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
      RAISE EXCEPTION 'mig 742: service_role lost % on %', v_priv, v_rel;
    END IF;
  END LOOP;

  -- 5. No policy at all (a permissive one would be dead today, and the first
  --    to re-grant a privilege would bring it back to life).
  SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname)
    INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'class_booking_requests';
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 742: % should have no policy: %', v_rel, v_policies;
  END IF;

  RAISE NOTICE 'mig 742: class_booking_requests is service_role only (no client privilege, RLS on, no policy).';
END $$;

COMMIT;
