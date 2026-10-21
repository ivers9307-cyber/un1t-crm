-- 766 — ORGCONTACTS.4: contact_location_audience (the send-path read surface)
-- gains the stage AT the audience studio from contact_studios.
--
-- WHY. contacts.pipeline_stage_slug is one value per person: it follows the
-- primary studio's board (mig 736). A Stillorgan member who is a lead at Hatch
-- reads 'member' in every Hatch audience, so Hatch's "not a member" campaign
-- never reaches them and its "members" campaign does. Decision 3 (spec
-- 2026-10-20 §5): audiences filter on the stage at the audience's own studio,
-- which contact_studios.stage_slug holds per (contact, studio) since mig 764.
-- This file only ADDS the column; the flip of AUDIENCE_FIELDS.pipeline_stage_slug
-- onto it is the app change that follows, after the change report
-- (docs/superpowers/reports/2026-10-20-segment-stage-change-report.md) is read.
-- pipeline_stage_slug stays on the view as the contact-wide column.
--
-- WHAT. CREATE OR REPLACE VIEW with the view's 111 columns unchanged and in
-- order (mig 689's list as migs 705 and 712 extended it, copied verbatim from
-- 712: OR REPLACE allows only appending), then
--   studio_stage_slug  = cs.stage_slug   the stage at the audience studio
--   studio_kind        = cs.kind         member / client / lead there
--   studio_status      = cs.status       active / ended there
-- from LEFT JOIN public.contact_studios cs ON (cs.contact_id, cs.location_id)
-- = (c.id, clp.location_id). LEFT, so a person on a studio's list with no
-- relationship row there keeps their reach with a NULL stage (Review Focus 4:
-- a segment's `eq` then excludes them and its `neq` includes them; the
-- builder offers is_null). OR REPLACE keeps the view's OID, owner, privileges
-- and comment; it REPLACES reloptions, so WITH (security_invoker = on) is
-- restated (without it the view would read as its owner). The REVOKE after it
-- is a no-op on prod, required by tests/consent-tables-client-closed-guard.
--
-- Unlike 689 this file does not require every contacts column to be on the
-- view: contacts.un1t_user_id and un1t_synced_at (mig 726) are excluded on
-- purpose in tests/audience-view-columns-guard.test.js.
--
-- Proven ahead of apply by tests/migration-766-audience-view-studio-stage.test.js
-- (PGlite). ROLLBACK: re-run mig 712's CREATE OR REPLACE VIEW statement
-- (the same 111 columns, no join) — the OID, ACL and comment survive either way.

BEGIN;

-- CREATE OR REPLACE VIEW takes ACCESS EXCLUSIVE on the view, which every
-- campaign/sequence send reads. Fail after 5 s rather than queue them.
SET LOCAL lock_timeout = '5s';

-- 0. Pre-checks.
DO $$
BEGIN
  IF to_regclass('public.contact_location_audience') IS NULL THEN
    RAISE EXCEPTION 'mig 766: public.contact_location_audience is missing; re-plan';
  END IF;
  IF to_regclass('public.contact_studios') IS NULL THEN
    RAISE EXCEPTION 'mig 766: apply 764_contact_studios first';
  END IF;
  IF (SELECT relacl IS NULL FROM pg_class WHERE oid = 'public.contact_location_audience'::regclass) THEN
    RAISE EXCEPTION 'mig 766: contact_location_audience has an implicit (NULL) ACL; re-plan';
  END IF;
  IF has_table_privilege('authenticated', 'public.contact_location_audience', 'SELECT')
     OR has_table_privilege('anon', 'public.contact_location_audience', 'SELECT')
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                 WHERE c.oid = 'public.contact_location_audience'::regclass
                   AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated'))) THEN
    RAISE EXCEPTION 'mig 766: a client role holds a privilege on contact_location_audience (mig 662 closed it); find out why before re-running';
  END IF;
END $$;

-- 1. Capture (dropped at COMMIT).
CREATE TEMP TABLE m766_view_cols ON COMMIT DROP AS
  SELECT a.attnum, a.attname::text AS attname, a.atttypid, a.atttypmod
    FROM pg_attribute a
   WHERE a.attrelid = 'public.contact_location_audience'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
CREATE TEMP TABLE m766_view_meta ON COMMIT DROP AS
  SELECT c.oid, c.relowner, obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c WHERE c.oid = 'public.contact_location_audience'::regclass;
CREATE TEMP TABLE m766_view_acl ON COMMIT DROP AS
  SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
    FROM pg_class c, aclexplode(c.relacl) a
   WHERE c.oid = 'public.contact_location_audience'::regclass;
CREATE TEMP TABLE m766_contacts_acl ON COMMIT DROP AS
  SELECT relacl::text AS acl FROM pg_class WHERE oid = 'public.contacts'::regclass;

-- 2. The view: mig 712's 111 columns unchanged, then the three studio columns.
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
  c.last_lead_source_at, c.glofox_user_membership_id, c.glofox_detail_due_at,
  c.visit_referrer, c.visit_landing_path, c.visit_captured_at, c.organization_id,
  cs.stage_slug AS studio_stage_slug,
  cs.kind       AS studio_kind,
  cs.status     AS studio_status
FROM public.contacts c
JOIN public.contact_location_preferences clp ON clp.contact_id = c.id
LEFT JOIN public.contact_studios cs ON cs.contact_id = c.id AND cs.location_id = clp.location_id;

-- 3. Mig 662's state, restated (a no-op today; the consent guard requires it
--    after any statement that creates this view).
REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;

-- 4. Self-check: the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_new text[] := ARRAY['studio_stage_slug', 'studio_kind', 'studio_status'];
  v_diff text;
  v_n int;
  v_base int;
BEGIN
  -- a. still a view, the same object, security_invoker, same owner
  IF NOT EXISTS (SELECT 1 FROM pg_class c, m766_view_meta m
                  WHERE c.oid = 'public.contact_location_audience'::regclass AND c.relkind = 'v'
                    AND c.oid = m.oid AND c.relowner = m.relowner) THEN
    RAISE EXCEPTION 'mig 766: contact_location_audience was replaced by another object or changed owner';
  END IF;
  IF NOT (SELECT coalesce('security_invoker=on' = ANY (reloptions), false) FROM pg_class
           WHERE oid = 'public.contact_location_audience'::regclass) THEN
    RAISE EXCEPTION 'mig 766: contact_location_audience lost security_invoker = on (CREATE OR REPLACE replaces reloptions)';
  END IF;

  -- b. the captured columns are unchanged, same order and types
  WITH b AS (SELECT attnum, attname, atttypid, atttypmod FROM m766_view_cols),
       a AS (SELECT attnum, attname::text AS attname, atttypid, atttypmod FROM pg_attribute
              WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > 0 AND NOT attisdropped)
  SELECT string_agg(b.attname || ' -> ' || coalesce(a.attname, '(none)'), ', ' ORDER BY b.attnum)
    INTO v_diff
    FROM b LEFT JOIN a ON a.attnum = b.attnum
   WHERE a.attname IS DISTINCT FROM b.attname OR a.atttypid IS DISTINCT FROM b.atttypid
      OR a.atttypmod IS DISTINCT FROM b.atttypmod;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'mig 766: existing contact_location_audience columns changed: %', v_diff;
  END IF;

  -- c. the three follow the other columns, in order, as text (contact_studios' types)
  --    (on a re-run the captured list already ends with them)
  SELECT count(*) INTO v_base FROM m766_view_cols WHERE NOT (attname = ANY (v_new));
  WITH want AS (SELECT u.name, u.ord FROM unnest(v_new) WITH ORDINALITY AS u(name, ord)),
       got AS (SELECT attnum - v_base AS ord, attname::text AS name, format_type(atttypid, atttypmod) AS typ FROM pg_attribute
                WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > v_base AND NOT attisdropped)
  SELECT string_agg(coalesce(w.name, '(none)') || ' -> ' || coalesce(g.name, '(none)') || ' ' || coalesce(g.typ, ''), ', ' ORDER BY coalesce(w.ord, g.ord))
    INTO v_diff
    FROM want w FULL JOIN got g ON g.ord = w.ord
   WHERE g.name IS DISTINCT FROM w.name OR g.typ IS DISTINCT FROM 'text';
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'mig 766: the appended columns are not studio_stage_slug, studio_kind, studio_status (text) in order: %', v_diff;
  END IF;

  -- d. ACL item-for-item as captured; no client privilege; comment unchanged
  SELECT count(*) INTO v_n FROM (
    (SELECT grantor, grantee, privilege_type, is_grantable FROM m766_view_acl
     EXCEPT
     SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
       FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.contact_location_audience'::regclass)
    UNION ALL
    (SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
       FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.contact_location_audience'::regclass
     EXCEPT
     SELECT grantor, grantee, privilege_type, is_grantable FROM m766_view_acl)
  ) d;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'mig 766: contact_location_audience privileges differ from before (% items)', v_n;
  END IF;
  IF has_table_privilege('authenticated', 'public.contact_location_audience', 'SELECT')
     OR has_table_privilege('anon', 'public.contact_location_audience', 'SELECT') THEN
    RAISE EXCEPTION 'mig 766: a client role can read contact_location_audience';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.contact_location_audience', 'SELECT') THEN
    RAISE EXCEPTION 'mig 766: service_role lost SELECT on contact_location_audience (every send path reads it)';
  END IF;
  IF obj_description('public.contact_location_audience'::regclass, 'pg_class')
       IS DISTINCT FROM (SELECT comment FROM m766_view_meta) THEN
    RAISE EXCEPTION 'mig 766: contact_location_audience comment changed';
  END IF;

  -- e. contacts itself untouched
  IF (SELECT relacl::text FROM pg_class WHERE oid = 'public.contacts'::regclass)
       IS DISTINCT FROM (SELECT acl FROM m766_contacts_acl) THEN
    RAISE EXCEPTION 'mig 766: the contacts ACL changed; this file must not touch it';
  END IF;

  RAISE NOTICE 'mig 766: contact_location_audience carries the studio stage (% columns), security_invoker, privileges/owner/comment unchanged.',
    (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > 0 AND NOT attisdropped);
END $$;

COMMIT;
