-- 689 — AUDIENCEVIEWCOLS.1: contact_location_audience gets the 10 contacts
-- columns it never had, so "Last email open" / "Last email click" audiences
-- count and send.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file (read-only, Supabase MCP, 1 Oct 2026). Proven ahead of apply by
-- tests/migration-689-contact-location-audience-columns.test.js (PGlite).
--
-- ===========================================================================
-- THE FINDING (follow-ups C65, found planning C50 PASSCODEREAD.2, F1)
-- ===========================================================================
-- Mig 491 created this view with c.* and said a later contacts column
-- "appears here automatically". It does not: Postgres expands c.* once, when
-- the view is created. Mig 652 rewrote the view with the explicit live list.
-- contacts has 10 columns the view lacks; two of them, last_email_open_at and
-- last_email_click_at, are audience filters (AUDIENCE_FIELDS in
-- src/lib/audience-filter.js), and the email/WhatsApp send paths build every
-- audience on this view, so a campaign using either filter fails (42703).
--
-- VERIFIED LIVE (1 Oct, BEFORE this migration):
--   view: security_invoker=on, owner postgres, 97 columns (93 contacts + 4
--   contact_location_preferences), relacl postgres + service_role only (mig
--   662), no column ACL, no dependent view, function, policy, trigger or rule,
--   not published, the LOCCOMMS.3 comment. Read by service_role only.
--   contacts: 103 columns; the 10 below are the only ones the view lacks.
--   0 saved audiences use any of the 10; 0 errors on the view in 24 h.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   CREATE OR REPLACE VIEW with the 97 columns unchanged and in order, then
--   the 10 appended (the only change OR REPLACE allows). OR REPLACE keeps the
--   view's OID, privileges, owner and comment. It REPLACES reloptions with
--   this statement's WITH clause, so WITH (security_invoker = on) is restated;
--   without it the view would read as its owner. The REVOKE after it is a
--   no-op on prod, required by tests/consent-tables-client-closed-guard.test.js.
--   tests/audience-view-columns-guard.test.js now fails a later contacts
--   column that does not reach this view (or its exclusion list).
--
-- APPLY: after this PR merges, per
-- docs/superpowers/plans/2026-09-27-followups/C65-AUDIENCEVIEWCOLS.1.md
-- (Task 5: pre/post probes and the rollback record).
-- ===========================================================================

BEGIN;

-- CREATE OR REPLACE VIEW takes ACCESS EXCLUSIVE on the view, which every
-- campaign/sequence send reads. Fail after 5 s rather than queue them.
SET LOCAL lock_timeout = '5s';

-- 0. Pre-checks.
DO $$
BEGIN
  IF to_regclass('public.contact_location_audience') IS NULL THEN
    RAISE EXCEPTION 'mig 689: public.contact_location_audience is missing; re-plan';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.contacts'::regclass
              AND attname = 'glofox_passcode' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'mig 689: apply 652_drop_glofox_passcode_columns first';
  END IF;
  IF (SELECT relacl IS NULL FROM pg_class WHERE oid = 'public.contact_location_audience'::regclass) THEN
    RAISE EXCEPTION 'mig 689: contact_location_audience has an implicit (NULL) ACL; re-plan';
  END IF;
  IF has_table_privilege('authenticated', 'public.contact_location_audience', 'SELECT')
     OR has_table_privilege('anon', 'public.contact_location_audience', 'SELECT')
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                 WHERE c.oid = 'public.contact_location_audience'::regclass
                   AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated'))) THEN
    RAISE EXCEPTION 'mig 689: a client role holds a privilege on contact_location_audience (mig 662 closed it); find out why before re-running';
  END IF;
END $$;

-- 1. Capture (dropped at COMMIT).
CREATE TEMP TABLE m689_view_cols ON COMMIT DROP AS
  SELECT a.attnum, a.attname::text AS attname, a.atttypid, a.atttypmod
    FROM pg_attribute a
   WHERE a.attrelid = 'public.contact_location_audience'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
CREATE TEMP TABLE m689_view_meta ON COMMIT DROP AS
  SELECT c.oid, c.relowner, obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c WHERE c.oid = 'public.contact_location_audience'::regclass;
CREATE TEMP TABLE m689_view_acl ON COMMIT DROP AS
  SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
    FROM pg_class c, aclexplode(c.relacl) a
   WHERE c.oid = 'public.contact_location_audience'::regclass;
CREATE TEMP TABLE m689_contacts_acl ON COMMIT DROP AS
  SELECT relacl::text AS acl FROM pg_class WHERE oid = 'public.contacts'::regclass;

-- 2. The view: mig 652's 97 columns unchanged, then the 10 contacts columns
--    it never had, in contacts order.
CREATE OR REPLACE VIEW public.contact_location_audience WITH (security_invoker = on) AS
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
  clp.whatsapp_marketing AS loc_whatsapp_marketing,
  c.last_email_open_at, c.last_email_click_at, c.email_hygiene_released_at,
  c.instagram_igsid, c.instagram_handle, c.name_normalized, c.last_lead_source,
  c.last_lead_source_at, c.glofox_user_membership_id, c.glofox_detail_due_at
FROM public.contacts c
JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;

-- 3. Mig 662's state, restated (a no-op today; the consent guard requires it
--    after any statement that creates this view).
REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;

-- 4. Self-check: the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_new text[] := ARRAY['last_email_open_at', 'last_email_click_at', 'email_hygiene_released_at',
                        'instagram_igsid', 'instagram_handle', 'name_normalized', 'last_lead_source',
                        'last_lead_source_at', 'glofox_user_membership_id', 'glofox_detail_due_at'];
  v_diff text;
  v_n int;
  v_base int;
BEGIN
  -- a. still a view, the same object, security_invoker, same owner
  IF NOT EXISTS (SELECT 1 FROM pg_class c, m689_view_meta m
                  WHERE c.oid = 'public.contact_location_audience'::regclass AND c.relkind = 'v'
                    AND c.oid = m.oid AND c.relowner = m.relowner) THEN
    RAISE EXCEPTION 'mig 689: contact_location_audience was replaced by another object or changed owner';
  END IF;
  IF NOT (SELECT coalesce('security_invoker=on' = ANY (reloptions), false) FROM pg_class
           WHERE oid = 'public.contact_location_audience'::regclass) THEN
    RAISE EXCEPTION 'mig 689: contact_location_audience lost security_invoker = on (CREATE OR REPLACE replaces reloptions)';
  END IF;

  -- b. the captured columns are unchanged, same order and types
  WITH b AS (SELECT attnum, attname, atttypid, atttypmod FROM m689_view_cols),
       a AS (SELECT attnum, attname::text AS attname, atttypid, atttypmod FROM pg_attribute
              WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > 0 AND NOT attisdropped)
  SELECT string_agg(b.attname || ' -> ' || coalesce(a.attname, '(none)'), ', ' ORDER BY b.attnum)
    INTO v_diff
    FROM b LEFT JOIN a ON a.attnum = b.attnum
   WHERE a.attname IS DISTINCT FROM b.attname OR a.atttypid IS DISTINCT FROM b.atttypid
      OR a.atttypmod IS DISTINCT FROM b.atttypmod;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'mig 689: existing contact_location_audience columns changed: %', v_diff;
  END IF;

  -- c. the 10 follow the other columns, in order, with contacts' own types
  --    (on a re-run the captured list already ends with them)
  SELECT count(*) INTO v_base FROM m689_view_cols WHERE NOT (attname = ANY (v_new));
  WITH want AS (SELECT u.name, u.ord FROM unnest(v_new) WITH ORDINALITY AS u(name, ord)),
       got AS (SELECT attnum - v_base AS ord, attname::text AS name, atttypid, atttypmod FROM pg_attribute
                WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > v_base AND NOT attisdropped),
       src AS (SELECT attname::text AS name, atttypid, atttypmod FROM pg_attribute
                WHERE attrelid = 'public.contacts'::regclass AND attnum > 0 AND NOT attisdropped)
  SELECT string_agg(coalesce(w.name, '(none)') || ' -> ' || coalesce(g.name, '(none)'), ', ' ORDER BY coalesce(w.ord, g.ord))
    INTO v_diff
    FROM want w FULL JOIN got g ON g.ord = w.ord
    LEFT JOIN src s ON s.name = w.name
   WHERE g.name IS DISTINCT FROM w.name OR g.atttypid IS DISTINCT FROM s.atttypid
      OR g.atttypmod IS DISTINCT FROM s.atttypmod;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'mig 689: the appended columns are not the 10 contacts columns in order with contacts types: %', v_diff;
  END IF;

  -- d. THE POINT: no contacts column is missing from the view
  SELECT string_agg(attname::text, ', ' ORDER BY attnum) INTO v_diff
    FROM pg_attribute a
   WHERE a.attrelid = 'public.contacts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND NOT EXISTS (SELECT 1 FROM pg_attribute v WHERE v.attrelid = 'public.contact_location_audience'::regclass
                      AND v.attname = a.attname AND NOT v.attisdropped);
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'mig 689: contacts columns missing from contact_location_audience: % (append them to this file''s list and its self-check, in contacts order)', v_diff;
  END IF;

  -- e. ACL item-for-item as captured; no client privilege; comment unchanged
  SELECT count(*) INTO v_n FROM (
    (SELECT grantor, grantee, privilege_type, is_grantable FROM m689_view_acl
     EXCEPT
     SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
       FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.contact_location_audience'::regclass)
    UNION ALL
    (SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
       FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.contact_location_audience'::regclass
     EXCEPT
     SELECT grantor, grantee, privilege_type, is_grantable FROM m689_view_acl)
  ) d;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'mig 689: contact_location_audience privileges differ from before (% items)', v_n;
  END IF;
  IF has_table_privilege('authenticated', 'public.contact_location_audience', 'SELECT')
     OR has_table_privilege('anon', 'public.contact_location_audience', 'SELECT') THEN
    RAISE EXCEPTION 'mig 689: a client role can read contact_location_audience';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.contact_location_audience', 'SELECT') THEN
    RAISE EXCEPTION 'mig 689: service_role lost SELECT on contact_location_audience (every send path reads it)';
  END IF;
  IF obj_description('public.contact_location_audience'::regclass, 'pg_class')
       IS DISTINCT FROM (SELECT comment FROM m689_view_meta) THEN
    RAISE EXCEPTION 'mig 689: contact_location_audience comment changed';
  END IF;

  -- f. contacts itself untouched
  IF (SELECT relacl::text FROM pg_class WHERE oid = 'public.contacts'::regclass)
       IS DISTINCT FROM (SELECT acl FROM m689_contacts_acl) THEN
    RAISE EXCEPTION 'mig 689: the contacts ACL changed; this file must not touch it';
  END IF;

  RAISE NOTICE 'mig 689: contact_location_audience has every contacts column (% columns), security_invoker, privileges/owner/comment unchanged.',
    (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > 0 AND NOT attisdropped);
END $$;

COMMIT;
