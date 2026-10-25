-- 674 — CARSCLIENTWRITE.1: no browser or phone session reads or writes
-- public.cars, public.car_documents, public.car_bca_submissions,
-- public.car_bca_submission_events or public.company_settings; anon holds
-- nothing on any of the five.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-674-cars-company-settings-client-closed.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C94, seen planning C83: its F2 and F4)
-- ===========================================================================
-- All five kept Supabase's default table privileges (anon and authenticated:
-- arwdDxtm, from postgres). Their policies were looser than every route:
--   cars:             cars_location_scoped, FOR ALL TO authenticated,
--                     auth_is_in_location(location_id) (mig 025);
--   car_documents:    car_documents_via_car, FOR ALL TO authenticated, the
--                     same test through the parent car (mig 025);
--   car_bca_submissions / car_bca_submission_events: explicit false write
--                     policies, but a SELECT for any active staff member of
--                     the studio (mig 163), which serves download_token;
--   company_settings: company_settings_read/_ins/_upd/_del TO public, writes
--                     testing only auth_is_owner() (mig 320). auth_is_owner()
--                     is the caller's HIGHEST role at ANY studio, with no
--                     location in the test.
-- The routes are tighter: every /api/cars* route needs the per-user
-- 'car_processing' permission AT the car's studio (off by default for every
-- role but master); every company_settings writer (/api/settings/branding,
-- /api/locations/[id]/email-copy, /email-spam-filter, /send-quiet-hours)
-- needs owner or master AT THE TARGET studio (MAILFIX-BRANDGATE.1).
-- So, from their own login:
--   any staff member of a studio holding a car could read the buyer's name,
--   email, phone and address and every price; mark a deposit paid; point the
--   stored deposit checkout URL (which the public deposit page hands the
--   buyer) anywhere; delete a car document, which cascades away its
--   bookkeeper invoices-queue row; or repoint a document's storage_path at
--   another car's file, which the download route then signs;
--   any staff member could read a BCA submission's download token;
--   an owner at ONE studio could rewrite ANY studio's company_settings (the
--   logo and name on its emails, the signature phone and links on every
--   email it sends, its spam filter and quiet hours) or create the row for a
--   studio that has none.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration):
--   relacl on all five {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--   authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}; no
--   column ACLs; RLS on, not forced; in no publication; no view depends on
--   them; the only functions naming one are increment_car_xero_issue_count
--   and record_bca_event (both INVOKER, service_role-only EXECUTE; the BCA
--   counters in src/lib/bca-events.js call the second with the service
--   role). Triggers: cars has
--   cars_set_updated_at (INVOKER) and audit_mutation (DEFINER, writes
--   audit_events); the others none. EXPLAIN UPDATE cars / DELETE
--   car_documents as a plain staff member plans (the policy is the only
--   filter). Edge logs (two 24 h windows): every request on the five was
--   service_role. anon reads 0 rows of cars/car_documents/BCA (no anon
--   policy) and errors on auth_is_owner() for company_settings.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE ALL from anon, authenticated and PUBLIC on the five (MAINTAIN, PG
--   17's m, included). Drop every policy on them (2 + 8 + 4). RLS stays on
--   with no policy. End state: service_role only, as car_notes since 672.
--
--   Every reader and writer is service_role: /api/cars*, /cars pages,
--   /deposit/[token], /api/public/deposit/*, the Revolut and Xero webhooks,
--   /api/orders/* (car link), invoice extraction and the invoices queue,
--   the BCA submit/promote routes, /bca/[token], /api/public/bca/*, the
--   Postmark webhook (BCA events and spam settings), /api/settings/branding,
--   /api/public/branding, the three /api/locations/[id] settings routes,
--   the mail composer's signature, the sequence scheduler's quiet hours.
--   FK actions (locations -> company_settings/cars, cars ->
--   car_documents/car_notes/BCA, car_documents -> invoices_queue,
--   submissions -> events) run as the table owner.
--
-- CONSUMERS CHECKED (un1t-crm origin/main 1da1c0e1 incl. mobile/, shared/,
-- desktop/, supabase/functions and history; champ-app, champ-bridge,
-- un1t-platform, un1t-sentinel (service key, whitelist read of cars),
-- un1t-pi, un1t-finance-agent): no browser, createAuthClient, phone or
-- other-repo code reads or writes any of the five with a client session.
-- The phone's Cars screens use /api/cars (mobile/lib/cars-api.js).
--
-- NOT TOUCHED: the car-documents and bca-documents storage buckets (already
-- closed to clients: mig 403's restrictive "private buckets deny client";
-- mig 163's bca_documents_no_*); the public 'branding' bucket (C94 plan F1).
--
-- Guard: tests/cars-company-settings-client-closed-guard.test.js.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C94-CARSCLIENTWRITE.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on tables the car routes, the Revolut
-- and Xero webhooks, the Postmark webhook and every email send read. Abort
-- after 5 s rather than queue behind them. Nothing is half-applied: re-run.
SET LOCAL lock_timeout = '5s';

REVOKE ALL
  ON public.cars, public.car_documents, public.car_bca_submissions,
     public.car_bca_submission_events, public.company_settings
  FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS cars_location_scoped ON public.cars;
DROP POLICY IF EXISTS car_documents_via_car ON public.car_documents;

DROP POLICY IF EXISTS car_bca_submissions_read_at_location ON public.car_bca_submissions;
DROP POLICY IF EXISTS car_bca_submissions_no_anon ON public.car_bca_submissions;
DROP POLICY IF EXISTS car_bca_submissions_no_authenticated_write ON public.car_bca_submissions;
DROP POLICY IF EXISTS car_bca_submissions_no_authenticated_update ON public.car_bca_submissions;
DROP POLICY IF EXISTS car_bca_submissions_no_authenticated_delete ON public.car_bca_submissions;
DROP POLICY IF EXISTS car_bca_submission_events_read_at_location ON public.car_bca_submission_events;
DROP POLICY IF EXISTS car_bca_submission_events_no_anon ON public.car_bca_submission_events;
DROP POLICY IF EXISTS car_bca_submission_events_no_authenticated_write ON public.car_bca_submission_events;

DROP POLICY IF EXISTS company_settings_read ON public.company_settings;
DROP POLICY IF EXISTS company_settings_ins ON public.company_settings;
DROP POLICY IF EXISTS company_settings_upd ON public.company_settings;
DROP POLICY IF EXISTS company_settings_del ON public.company_settings;

COMMENT ON TABLE public.cars IS
  'CCF Autos car tracker (mig 025). Service role only (CARSCLIENTWRITE.1, mig 674): no client privilege, RLS on with no policy. Holds buyer contact details, prices and the deposit token/checkout URL. Read and write through /api/cars*, which need car_processing at the car''s studio.';
COMMENT ON TABLE public.car_documents IS
  'Car invoices and supporting files (mig 025). Service role only (CARSCLIENTWRITE.1, mig 674): no client privilege, RLS on with no policy. storage_path is signed by /api/cars/[id]/documents/[docId]; a delete cascades to invoices_queue.';
COMMENT ON TABLE public.car_bca_submissions IS
  'BCA submission emails (mig 163). Service role only (CARSCLIENTWRITE.1, mig 674): no client privilege, RLS on with no policy. download_token opens the public /bca/[token] pack.';
COMMENT ON TABLE public.car_bca_submission_events IS
  'BCA delivery/open/download events (mig 165). Service role only (CARSCLIENTWRITE.1, mig 674): no client privilege, RLS on with no policy.';
COMMENT ON TABLE public.company_settings IS
  'Per-studio branding, email copy, signature card, quiet hours and spam filter (mig 013+). Service role only (CARSCLIENTWRITE.1, mig 674): no client privilege, RLS on with no policy. Written through /api/settings/branding and /api/locations/[id]/{email-copy,email-spam-filter,send-quiet-hours}, which need owner or master AT the studio.';

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['cars', 'car_documents', 'car_bca_submissions',
                           'car_bca_submission_events', 'company_settings'];
  v_tbl text;
  v_rel text;
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
BEGIN
  FOREACH v_tbl IN ARRAY v_tables LOOP
    v_rel := 'public.' || v_tbl;

    -- 0. RLS still on: with no policy it is the second fence behind the grant.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
      RAISE EXCEPTION 'mig 674: row level security is off on %', v_rel;
    END IF;

    -- 1. anon, authenticated, PUBLIC: nothing, table and column level, any grantor.
    SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
      INTO v_extra
      FROM (
        SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl
           AND grantee IN ('anon', 'authenticated', 'PUBLIC')
        UNION ALL
        SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl
           AND grantee IN ('anon', 'authenticated', 'PUBLIC')
      ) g;
    IF v_extra IS NOT NULL THEN
      RAISE EXCEPTION 'mig 674: client roles still hold privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The same question asked of the real catalog (role membership,
    --    PUBLIC), one privilege per call. MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 674: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
      -- 3. No column-level privilege through any path.
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 674: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 4. The server still reads and writes.
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 674: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 5. No policy at all (a permissive one would be dead today, and the
    --    first to re-grant a privilege would bring it back to life).
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname)
      INTO v_policies
      FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl;
    IF v_policies IS NOT NULL THEN
      RAISE EXCEPTION 'mig 674: % should have no policy left: %', v_rel, v_policies;
    END IF;
  END LOOP;

  RAISE NOTICE 'mig 674: cars, car_documents, car_bca_submissions, car_bca_submission_events and company_settings are service_role only (no client privilege, RLS on, no policy).';
END $$;

COMMIT;
