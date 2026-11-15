-- 837 — UTMSOURCE.1: contacts.utm_source and contacts.utm_medium, so a lead or
-- a paid trial can be read as ads / organic / email off the contact.
--
--   APPLY BEFORE THE CODE DEPLOYS (the four public funnel routes stamp these
--   columns; an UPDATE that names a column the table lacks fails whole).
--
-- NOT APPLIED when this file was written. "VERIFIED LIVE" below is prod BEFORE
-- this file (read-only, Supabase MCP, 15 Nov 2026).
--
-- WHY
-- ───
-- contacts carries utm_campaign / utm_content / utm_term / ad_external_id
-- (mig 361, first touch). utm_source and utm_medium were captured by the
-- funnels only into trial_purchases.attribution and funnel_events.meta
-- (TRIALLEAK.1 #2369, HATCHTRACK.1 #2373), so the contact could not say which
-- placement or medium a person came through, and a visitor with no ad id
-- (an Instagram bio link, an email link) carried nothing at all.
--
-- WHAT
-- ────
--   1. ALTER TABLE contacts ADD COLUMN utm_source text, utm_medium text
--      (nullable, no default: metadata only, no rewrite).
--   2. contact_location_audience (the send-path read surface, explicit column
--      list since mig 689) gets both, APPENDED at the end: the mig 766
--      statement with its 114 columns unchanged and in order, then the two.
--      OR REPLACE keeps the view's OID, owner, privileges and comment; it
--      REPLACES reloptions, so WITH (security_invoker = on) is restated. The
--      REVOKE after it is a no-op on prod, required by
--      tests/consent-tables-client-closed-guard.test.js.
--
-- DECISIONS
-- ─────────
--   contacts grant: none needed, none withheld. contacts is not a
--     column-granted table: `authenticated` holds table-level SELECT only
--     (mig 653; writes are service-role), so the new columns are readable to a
--     signed-in session exactly as utm_campaign is, fenced by contacts_select
--     (Contacts at the studio, or the member's own row). anon holds nothing
--     (mig 657). They are marketing tags, not credentials, and sit beside
--     three sibling columns already readable the same way, so withholding
--     them would mean turning contacts into a column-granted table for no
--     gain. No phone or browser select names them.
--   public.studio_contacts (mig 765, the lists' join): NOT changed. It was
--     created with c.*, which Postgres expanded once, so it does not pick the
--     columns up; nothing reads utm_* through it, and
--     studio_contacts_scoped() (mig 795) returns its row type. Mig 793 made
--     the same call.
--   backfill: NOT in this file. See the PR: the only trial_purchases row that
--     carries a source or medium today is a test value.
--
-- VERIFIED LIVE (15 Nov 2026, BEFORE this migration):
--   contacts: 110 columns, neither column present; authenticated holds
--   table-level SELECT and nothing else; anon holds no column privilege.
--   contact_location_audience: 114 columns ending organization_id,
--   studio_stage_slug, studio_kind, studio_status (mig 766's list);
--   security_invoker=on; relacl postgres + service_role only. The three
--   contacts columns it lacks are the three excluded on purpose in
--   tests/audience-view-columns-guard.test.js.
--
-- ROLLBACK: roll the code back and leave the columns. They are harmless
-- unused, and OR REPLACE cannot take a column off the view (that needs a
-- DROP + CREATE, which resets the view's privileges: the mig 652 pattern).

BEGIN;

-- ADD COLUMN takes ACCESS EXCLUSIVE on contacts and CREATE OR REPLACE VIEW
-- takes it on the view every campaign/sequence send reads. Both are instant
-- once held; fail after 5 s rather than queue the app behind a long reader.
SET LOCAL lock_timeout = '5s';

-- 0. Pre-checks.
DO $$
BEGIN
  IF to_regclass('public.contact_location_audience') IS NULL THEN
    RAISE EXCEPTION 'mig 837: public.contact_location_audience is missing; re-plan';
  END IF;
  IF to_regclass('public.contact_studios') IS NULL THEN
    RAISE EXCEPTION 'mig 837: public.contact_studios is missing (the view joins it since mig 766); re-plan';
  END IF;
  IF (SELECT relacl IS NULL FROM pg_class WHERE oid = 'public.contact_location_audience'::regclass) THEN
    RAISE EXCEPTION 'mig 837: contact_location_audience has an implicit (NULL) ACL; re-plan';
  END IF;
  IF has_table_privilege('authenticated', 'public.contact_location_audience', 'SELECT')
     OR has_table_privilege('anon', 'public.contact_location_audience', 'SELECT')
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                 WHERE c.oid = 'public.contact_location_audience'::regclass
                   AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated'))) THEN
    RAISE EXCEPTION 'mig 837: a client role holds a privilege on contact_location_audience (mig 662 closed it); find out why before re-running';
  END IF;
END $$;

-- 1. Capture (dropped at COMMIT).
CREATE TEMP TABLE m837_view_cols ON COMMIT DROP AS
  SELECT a.attnum, a.attname::text AS attname, a.atttypid, a.atttypmod
    FROM pg_attribute a
   WHERE a.attrelid = 'public.contact_location_audience'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
CREATE TEMP TABLE m837_view_meta ON COMMIT DROP AS
  SELECT c.oid, c.relowner, obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c WHERE c.oid = 'public.contact_location_audience'::regclass;
CREATE TEMP TABLE m837_view_acl ON COMMIT DROP AS
  SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
    FROM pg_class c, aclexplode(c.relacl) a
   WHERE c.oid = 'public.contact_location_audience'::regclass;
CREATE TEMP TABLE m837_contacts_acl ON COMMIT DROP AS
  SELECT relacl::text AS acl FROM pg_class WHERE oid = 'public.contacts'::regclass;

-- 2. The columns. Nullable text, no default: a metadata-only change.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS utm_source text,
  ADD COLUMN IF NOT EXISTS utm_medium text;

COMMENT ON COLUMN public.contacts.utm_source IS
  'UTMSOURCE.1 (mig 837): first-touch utm_source of the landing URL this person first came through (facebook, instagram, crm, ...). Written once, only while utm_source, utm_medium and attributed_at are all NULL, by the public funnel routes through stampFirstTouchSource (src/lib/contact-first-touch-source.js); cleaned (200 characters, an unfilled {{macro}} is dropped). Measurement only: never an ad signal, never sets ad_provider or attributed_at.';
COMMENT ON COLUMN public.contacts.utm_medium IS
  'UTMSOURCE.1 (mig 837): first-touch utm_medium of the same landing URL as utm_source (paid, bio, email, whatsapp, ...). Written with it, in the same statement, under the same rule.';

-- 3. The view: mig 766's 114 columns unchanged, then the two new ones.
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
  cs.status     AS studio_status,
  c.utm_source, c.utm_medium
FROM public.contacts c
JOIN public.contact_location_preferences clp ON clp.contact_id = c.id
LEFT JOIN public.contact_studios cs ON cs.contact_id = c.id AND cs.location_id = clp.location_id;

-- 4. Mig 662's state, restated (a no-op today; the consent guard requires it
--    after any statement that creates this view).
REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;

-- 5. Self-check: the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_new text[] := ARRAY['utm_source', 'utm_medium'];
  v_diff text;
  v_n int;
  v_base int;
BEGIN
  -- a. still a view, the same object, security_invoker, same owner
  IF NOT EXISTS (SELECT 1 FROM pg_class c, m837_view_meta m
                  WHERE c.oid = 'public.contact_location_audience'::regclass AND c.relkind = 'v'
                    AND c.oid = m.oid AND c.relowner = m.relowner) THEN
    RAISE EXCEPTION 'mig 837: contact_location_audience was replaced by another object or changed owner';
  END IF;
  IF NOT (SELECT coalesce('security_invoker=on' = ANY (reloptions), false) FROM pg_class
           WHERE oid = 'public.contact_location_audience'::regclass) THEN
    RAISE EXCEPTION 'mig 837: contact_location_audience lost security_invoker = on (CREATE OR REPLACE replaces reloptions)';
  END IF;

  -- b. the captured columns are unchanged, same order and types
  WITH b AS (SELECT attnum, attname, atttypid, atttypmod FROM m837_view_cols),
       a AS (SELECT attnum, attname::text AS attname, atttypid, atttypmod FROM pg_attribute
              WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > 0 AND NOT attisdropped)
  SELECT string_agg(b.attname || ' -> ' || coalesce(a.attname, '(none)'), ', ' ORDER BY b.attnum)
    INTO v_diff
    FROM b LEFT JOIN a ON a.attnum = b.attnum
   WHERE a.attname IS DISTINCT FROM b.attname OR a.atttypid IS DISTINCT FROM b.atttypid
      OR a.atttypmod IS DISTINCT FROM b.atttypmod;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'mig 837: existing contact_location_audience columns changed: %', v_diff;
  END IF;

  -- c. the two follow the other columns, in order, as text (contacts' types)
  --    (on a re-run the captured list already ends with them)
  SELECT count(*) INTO v_base FROM m837_view_cols WHERE NOT (attname = ANY (v_new));
  WITH want AS (SELECT u.name, u.ord FROM unnest(v_new) WITH ORDINALITY AS u(name, ord)),
       got AS (SELECT attnum - v_base AS ord, attname::text AS name, format_type(atttypid, atttypmod) AS typ FROM pg_attribute
                WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > v_base AND NOT attisdropped)
  SELECT string_agg(coalesce(w.name, '(none)') || ' -> ' || coalesce(g.name, '(none)') || ' ' || coalesce(g.typ, ''), ', ' ORDER BY coalesce(w.ord, g.ord))
    INTO v_diff
    FROM want w FULL JOIN got g ON g.ord = w.ord
   WHERE g.name IS DISTINCT FROM w.name OR g.typ IS DISTINCT FROM 'text';
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'mig 837: the appended columns are not utm_source, utm_medium (text) in order: %', v_diff;
  END IF;

  -- d. ACL item-for-item as captured; no client privilege; comment unchanged
  SELECT count(*) INTO v_n FROM (
    (SELECT grantor, grantee, privilege_type, is_grantable FROM m837_view_acl
     EXCEPT
     SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
       FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.contact_location_audience'::regclass)
    UNION ALL
    (SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
       FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.contact_location_audience'::regclass
     EXCEPT
     SELECT grantor, grantee, privilege_type, is_grantable FROM m837_view_acl)
  ) d;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'mig 837: contact_location_audience privileges differ from before (% items)', v_n;
  END IF;
  IF has_table_privilege('authenticated', 'public.contact_location_audience', 'SELECT')
     OR has_table_privilege('anon', 'public.contact_location_audience', 'SELECT') THEN
    RAISE EXCEPTION 'mig 837: a client role can read contact_location_audience';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.contact_location_audience', 'SELECT') THEN
    RAISE EXCEPTION 'mig 837: service_role lost SELECT on contact_location_audience (every send path reads it)';
  END IF;
  IF obj_description('public.contact_location_audience'::regclass, 'pg_class')
       IS DISTINCT FROM (SELECT comment FROM m837_view_meta) THEN
    RAISE EXCEPTION 'mig 837: contact_location_audience comment changed';
  END IF;

  -- e. the columns are on contacts, as nullable text with no default
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'contacts'
     AND column_name IN ('utm_source', 'utm_medium')
     AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'mig 837: contacts.utm_source / utm_medium are not both nullable text without a default (% of 2)', v_n;
  END IF;

  -- f. contacts privileges untouched: ADD COLUMN grants nothing of its own
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
              WHERE table_schema = 'public' AND table_name = 'contacts'
                AND column_name IN ('utm_source', 'utm_medium') AND grantee IN ('anon', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 837: anon or PUBLIC can read contacts.utm_source / utm_medium (mig 657 closed contacts to anon)';
  END IF;
  IF (SELECT relacl::text FROM pg_class WHERE oid = 'public.contacts'::regclass)
       IS DISTINCT FROM (SELECT acl FROM m837_contacts_acl) THEN
    RAISE EXCEPTION 'mig 837: the contacts ACL changed; this file must not touch it';
  END IF;

  RAISE NOTICE 'mig 837: contacts.utm_source / utm_medium added and on contact_location_audience (% columns), security_invoker, privileges/owner/comment unchanged.',
    (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > 0 AND NOT attisdropped);
END $$;

COMMIT;
