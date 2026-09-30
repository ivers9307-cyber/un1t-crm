-- 652 — PASSCODEREAD.2: drop contacts.glofox_passcode and
-- glofox_push_events.passcode_sent (retired by 651, PASSCODEREAD.1).
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file (read-only, Supabase MCP, 29 Sep 2026). Proven ahead of apply by
-- tests/migration-652-drop-glofox-passcode-columns.test.js (PGlite; it runs
-- the real 651, 653, 657, 660 and 662 files first, in prod's order and in
-- number order).
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- 651 stopped every writer, cleared the stored Glofox passwords and put
-- CHECK (… IS NULL) on both columns (the "deprecated, stays on disk for one
-- deploy" half of the CLAUDE.md rule). This is the drop.
--
-- VERIFIED LIVE (29 Sep): the ONLY dependent of either column is the view
-- contact_location_audience (a pg_rewrite rule on contacts.glofox_passcode);
-- no function, policy, trigger, index, statistic, publication column list or
-- other view names either column (after 651 also its two CHECKs, which DROP
-- COLUMN removes). The view: 98 columns (mig 491's c.* expanded at creation;
-- contacts gained 10 more columns since that the view never got), owner
-- postgres, security_invoker=on, no dependents, read by service_role only.
-- Its ACL was the Supabase default on 29 Sep; mig 662 (CONSENTREAD.1,
-- applied 30 Sep) then revoked every client privilege, leaving the owner and
-- service_role. This file does not assume either: it restores whatever the
-- catalog holds at apply time.
--
-- ===========================================================================
-- WHAT THIS FILE DOES
-- ===========================================================================
--   0. refuses to run unless 651 is applied and both columns are all NULL;
--   1. captures the view's columns (name, type, order), owner, options,
--      comment, FULL ACL and each client role's effective privileges, and
--      the ACLs of contacts and glofox_push_events;
--   2. DROP VIEW (no CASCADE: a new dependent stops the file);
--   3. DROP COLUMN on both tables (drops 651's CHECKs with them);
--   4. CREATE VIEW with the explicit live column list minus glofox_passcode
--      (NOT c.*: that would add the 10 later columns; see the C50 plan, F1);
--   5. REVOKEs the fresh view's default privileges from anon, authenticated,
--      PUBLIC and service_role, then re-issues the captured ACL item by item
--      and the comment. After 662 the captured ACL has no client item, so the
--      view stays closed to clients (tests/consent-tables-client-closed-
--      guard.test.js requires that REVOKE after any CREATE VIEW of it);
--   6. self-checks the catalog; any difference aborts the whole file.
--
-- APPLY: after 651 is applied AND its 24 h watch is clean; see
-- docs/superpowers/plans/2026-09-27-followups/C50-PASSCODEREAD.2.md, Task 5.
-- Free against 653/657/660/662 in either order (all replayed).
-- ROLLBACK: a new forward migration (Task 5 Step 7 of that plan) re-adds
-- both columns NULL + CHECKed and appends the view column at the end.
-- ===========================================================================

BEGIN;

-- DROP COLUMN takes ACCESS EXCLUSIVE on contacts (the hottest table) for a
-- metadata-only change. Fail after 5 s rather than queue every contacts query.
SET LOCAL lock_timeout = '5s';

-- 0. Pre-checks.
DO $$
BEGIN
  IF to_regclass('public.contact_location_audience') IS NULL THEN
    RAISE EXCEPTION 'mig 652: public.contact_location_audience is missing; re-plan';
  END IF;
  IF (SELECT relacl IS NULL FROM pg_class WHERE oid = 'public.contact_location_audience'::regclass) THEN
    RAISE EXCEPTION 'mig 652: contact_location_audience has an implicit (NULL) ACL; re-plan';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.contacts'::regclass
              AND attname = 'glofox_passcode' AND NOT attisdropped) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.contacts'::regclass
                    AND conname = 'contacts_glofox_passcode_retired' AND contype = 'c' AND convalidated) THEN
      RAISE EXCEPTION 'mig 652: apply 651_retire_glofox_passcodes first (CHECK contacts_glofox_passcode_retired missing or not validated)';
    END IF;
    IF EXISTS (SELECT 1 FROM public.contacts WHERE glofox_passcode IS NOT NULL) THEN
      RAISE EXCEPTION 'mig 652: a contacts.glofox_passcode value exists; 651 must have cleared them';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.glofox_push_events'::regclass
              AND attname = 'passcode_sent' AND NOT attisdropped) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.glofox_push_events'::regclass
                    AND conname = 'glofox_push_events_passcode_retired' AND contype = 'c' AND convalidated) THEN
      RAISE EXCEPTION 'mig 652: apply 651_retire_glofox_passcodes first (CHECK glofox_push_events_passcode_retired missing or not validated)';
    END IF;
    IF EXISTS (SELECT 1 FROM public.glofox_push_events WHERE passcode_sent IS NOT NULL) THEN
      RAISE EXCEPTION 'mig 652: a glofox_push_events.passcode_sent value exists; 651 must have cleared them';
    END IF;
  END IF;
END $$;

-- 1. Capture (dropped at COMMIT).
CREATE TEMP TABLE m652_view_cols ON COMMIT DROP AS
  SELECT a.attnum, a.attname::text AS attname, a.atttypid, a.atttypmod
    FROM pg_attribute a
   WHERE a.attrelid = 'public.contact_location_audience'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
CREATE TEMP TABLE m652_view_meta ON COMMIT DROP AS
  SELECT c.relowner, c.reloptions, obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c WHERE c.oid = 'public.contact_location_audience'::regclass;
CREATE TEMP TABLE m652_view_acl ON COMMIT DROP AS
  SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
    FROM pg_class c, aclexplode(c.relacl) a
   WHERE c.oid = 'public.contact_location_audience'::regclass;
-- What each client role can actually do (role membership and PUBLIC included).
CREATE TEMP TABLE m652_view_client_privs ON COMMIT DROP AS
  SELECT r.role, p.priv
    FROM unnest(ARRAY['anon', 'authenticated', 'public']) r(role),
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p(priv)
   WHERE has_table_privilege(r.role, 'public.contact_location_audience', p.priv);
CREATE TEMP TABLE m652_table_acl ON COMMIT DROP AS
  SELECT c.oid, c.relacl::text AS acl
    FROM pg_class c WHERE c.oid IN ('public.contacts'::regclass, 'public.glofox_push_events'::regclass);

-- 2. The only dependent goes first (Postgres refuses DROP COLUMN under it).
DROP VIEW public.contact_location_audience;

-- 3. The columns (651's single-column CHECKs go with them).
ALTER TABLE public.contacts DROP COLUMN IF EXISTS glofox_passcode;
ALTER TABLE public.glofox_push_events DROP COLUMN IF EXISTS passcode_sent;

-- 4. The view again: the live list (pg_get_viewdef, 29 Sep 2026) minus glofox_passcode.
CREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS
SELECT
  c.id, c.name, c.first_name, c.last_name, c.email, c.phone, c.label, c.glofox_member_id,
  c.trial_credits_remaining, c.lead_source, c.lead_created_at, c.created_at, c.updated_at,
  c.source, c.location_id, c.last_emailed_at, c.total_emails_sent, c.total_emails_opened,
  c.total_emails_clicked, c.email_status, c.tags, c.wa_phone, c.wa_status, c.last_wa_message_at,
  c.total_wa_sent, c.total_wa_received, c.sms_status, c.created_via_import_id, c.user_id,
  c.max_hr_override, c.hr_post_class_emails_enabled, c.glofox_membership_status,
  c.glofox_synced_at, c.dob, c.joined_at, c.last_booked_at, c.last_attended_at,
  c.total_bookings_30d, c.total_attended_30d, c.total_noshow_30d, c.recent_bookings,
  c.lifetime_value_cents, c.lifetime_transaction_count, c.lifetime_currency, c.last_payment_at,
  c.last_invoice_at, c.total_attended_7d, c.pipeline_stage_slug, c.email_marketing,
  c.glofox_membership_plan, c.glofox_membership_state, c.glofox_membership_expiry,
  c.glofox_membership_price_cents, c.glofox_billing_interval, c.glofox_payment_method,
  c.glofox_membership_type, c.glofox_image_url, c.gender, c.emergency_contact,
  c.glofox_signup_answers, c.glofox_roaming_enabled, c.glofox_account_active, c.glofox_source,
  c.glofox_membership_plan_full, c.first_class_checkin_at, c.person_group_id,
  c.email_administrative, c.weight_kg, c.weight_kg_source, c.weight_kg_at,
  c.profile_setup_completed_at, c.whatsapp_marketing, c.is_primary_contact, c.ctwa_clid,
  c.ctwa_clid_at, c.converted_at, c.hr_leaderboard_opt_out, c.push_prefs, c.pack_customer_at,
  c.utm_campaign, c.utm_content, c.utm_term, c.ad_provider, c.ad_external_id, c.attributed_at,
  c.pipeline_dismissed_at, c.email_suppressed_at, c.wa_bsuid, c.last_marketing_touch_at,
  c.glofox_membership_paused_at, c.glofox_membership_resume_at, c.gympass_member_id,
  c.automations_exempt,
  clp.location_id AS audience_location_id,
  clp.email_marketing AS loc_email_marketing,
  clp.sms_marketing AS loc_sms_marketing,
  clp.whatsapp_marketing AS loc_whatsapp_marketing
FROM public.contacts c
JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;

-- 5. Restore exactly the captured privileges and comment. The fresh view got
--    the schema's default privileges (anon and authenticated included); clear
--    those, then re-issue each captured item (as the current user, i.e. the
--    owner: an item from another grantor therefore cannot match and the
--    self-check stops the file). After mig 662 no captured item names a
--    client role, so the view stays closed to clients.
REVOKE ALL ON public.contact_location_audience FROM PUBLIC, anon, authenticated, service_role;
DO $$
DECLARE
  r record;
  v_comment text;
BEGIN
  FOR r IN SELECT a.* FROM m652_view_acl a, m652_view_meta m WHERE a.grantee <> m.relowner LOOP
    EXECUTE format('GRANT %s ON public.contact_location_audience TO %s%s',
      r.privilege_type,
      CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END,
      CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  SELECT comment INTO v_comment FROM m652_view_meta;
  EXECUTE format('COMMENT ON VIEW public.contact_location_audience IS %L', v_comment);
END $$;

-- 6. Self-check: the catalog, never this file.
DO $$
DECLARE
  v_diff text;
  v_n int;
BEGIN
  -- a. the columns and their CHECKs are gone
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.contacts'::regclass AND attname = 'glofox_passcode' AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.glofox_push_events'::regclass AND attname = 'passcode_sent' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'mig 652: a retired passcode column still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname IN ('contacts_glofox_passcode_retired', 'glofox_push_events_passcode_retired')) THEN
    RAISE EXCEPTION 'mig 652: a *_passcode_retired CHECK survived its column';
  END IF;

  -- b. the view is back, security_invoker, same owner
  IF NOT EXISTS (SELECT 1 FROM pg_class c, m652_view_meta m
                  WHERE c.oid = 'public.contact_location_audience'::regclass AND c.relkind = 'v'
                    AND 'security_invoker=on' = ANY (c.reloptions) AND c.relowner = m.relowner) THEN
    RAISE EXCEPTION 'mig 652: contact_location_audience is missing, lost security_invoker = on, or changed owner';
  END IF;

  -- c. columns = captured minus glofox_passcode, same order, names and types
  WITH b AS (SELECT row_number() OVER (ORDER BY attnum) n, attname, atttypid, atttypmod
               FROM m652_view_cols WHERE attname <> 'glofox_passcode'),
       a AS (SELECT row_number() OVER (ORDER BY attnum) n, attname::text AS attname, atttypid, atttypmod
               FROM pg_attribute WHERE attrelid = 'public.contact_location_audience'::regclass
                AND attnum > 0 AND NOT attisdropped)
  SELECT string_agg(coalesce(b.attname, '(none)') || ' -> ' || coalesce(a.attname, '(none)'), ', ' ORDER BY coalesce(a.n, b.n))
    INTO v_diff
    FROM b FULL JOIN a ON a.n = b.n
   WHERE a.attname IS DISTINCT FROM b.attname OR a.atttypid IS DISTINCT FROM b.atttypid
      OR a.atttypmod IS DISTINCT FROM b.atttypmod;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'mig 652: contact_location_audience columns changed beyond glofox_passcode: %', v_diff;
  END IF;

  -- d. the ACL is item-for-item the captured one (grantor, grantee, privilege, grant option)
  SELECT count(*) INTO v_n FROM (
    (SELECT grantor, grantee, privilege_type, is_grantable FROM m652_view_acl
     EXCEPT
     SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
       FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.contact_location_audience'::regclass)
    UNION ALL
    (SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
       FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.contact_location_audience'::regclass
     EXCEPT
     SELECT grantor, grantee, privilege_type, is_grantable FROM m652_view_acl)
  ) d;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'mig 652: contact_location_audience privileges differ from before (% items)', v_n;
  END IF;

  -- d2. what anon, authenticated and PUBLIC can do on the view is what they
  --     could before (after 662: nothing), asked of the real catalog
  SELECT string_agg(x.role || ':' || x.priv, ', ' ORDER BY x.role, x.priv) INTO v_diff FROM (
    (SELECT r.role, p.priv
       FROM unnest(ARRAY['anon', 'authenticated', 'public']) r(role),
            unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p(priv)
      WHERE has_table_privilege(r.role, 'public.contact_location_audience', p.priv)
     EXCEPT
     SELECT role, priv FROM m652_view_client_privs)
    UNION ALL
    (SELECT role, priv FROM m652_view_client_privs
     EXCEPT
     SELECT r.role, p.priv
       FROM unnest(ARRAY['anon', 'authenticated', 'public']) r(role),
            unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p(priv)
      WHERE has_table_privilege(r.role, 'public.contact_location_audience', p.priv))
  ) x;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'mig 652: client access to contact_location_audience changed: %', v_diff;
  END IF;

  -- e. the comment is the captured one
  IF obj_description('public.contact_location_audience'::regclass, 'pg_class')
       IS DISTINCT FROM (SELECT comment FROM m652_view_meta) THEN
    RAISE EXCEPTION 'mig 652: contact_location_audience lost its comment';
  END IF;

  -- f. the two tables' ACLs are untouched; 651's invariant still holds
  IF EXISTS (SELECT 1 FROM m652_table_acl t JOIN pg_class c ON c.oid = t.oid WHERE c.relacl::text IS DISTINCT FROM t.acl) THEN
    RAISE EXCEPTION 'mig 652: the contacts or glofox_push_events ACL changed; this file must not touch them';
  END IF;
  IF has_table_privilege('authenticated', 'public.glofox_push_events', 'SELECT')
     OR has_table_privilege('anon', 'public.glofox_push_events', 'SELECT') THEN
    RAISE EXCEPTION 'mig 652: glofox_push_events is readable by a client role (651 must have closed it)';
  END IF;

  RAISE NOTICE 'mig 652: glofox_passcode and passcode_sent dropped; contact_location_audience recreated (97 columns, same order, privileges, owner, comment).';
END $$;

COMMIT;
