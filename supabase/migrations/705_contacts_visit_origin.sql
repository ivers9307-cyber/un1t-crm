-- 705 — VISIT-ORIGIN.1: where a public-site visitor came from, without a
-- tracking cookie. Ad clicks were already attributed from URL params
-- (utm_* / fbclid); everyone else (the website's own pages, Google, the
-- Instagram bio link, a shared link) arrived indistinguishable. The public
-- forms now send the FIRST page of the visit and its referrer (held in
-- sessionStorage for the tab), and the routes stamp them here once
-- (stamp-if-null = first touch), sanitised server-side: referrer reduced to
-- origin + path, landing path reduced to the path.
--
-- Nullable, no default, no backfill (nothing to backfill from). Table-level
-- SELECT for authenticated already covers new columns (verified live 4 Oct
-- 2026: role_table_grants carries authenticated SELECT on contacts), so the
-- contact drawer reads them with no further GRANT.
--
-- The send-path view contact_location_audience lists its columns explicitly
-- (mig 689), so the three new columns are appended at the END (CREATE OR
-- REPLACE VIEW may only append), WITH (security_invoker = on) restated and
-- the client REVOKE restated after it (mig 662's state; the consent guard
-- requires both after any statement that creates this view).

-- 1. Columns.
alter table public.contacts
  add column if not exists visit_referrer text,
  add column if not exists visit_landing_path text,
  add column if not exists visit_captured_at timestamptz;

comment on column public.contacts.visit_referrer is 'VISIT-ORIGIN.1: referrer (origin + path) of the first page of the visit that produced this contact. Stamped once by the public forms.';
comment on column public.contacts.visit_landing_path is 'VISIT-ORIGIN.1: first page of that visit on our site, path only.';
comment on column public.contacts.visit_captured_at is 'VISIT-ORIGIN.1: when the two visit_* columns were stamped (first touch; never overwritten).';

-- 2. The view: mig 689's 107 columns unchanged and in order, then the three.
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
  c.visit_referrer, c.visit_landing_path, c.visit_captured_at
FROM public.contacts c
JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;

-- 3. Mig 662's state, restated (a no-op today; required after any statement
--    that creates this view).
REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;

-- 4. Self-check against the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = 'public.contact_location_audience'::regclass AND c.relkind = 'v'
                    AND c.reloptions @> ARRAY['security_invoker=on']) THEN
    RAISE EXCEPTION 'mig 705: contact_location_audience is not a security_invoker view';
  END IF;
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'contact_location_audience'
     AND column_name IN ('visit_referrer', 'visit_landing_path', 'visit_captured_at');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'mig 705: expected the 3 visit columns on the view, found %', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
              WHERE table_schema = 'public' AND table_name = 'contact_location_audience'
                AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 705: a client role holds a privilege on contact_location_audience';
  END IF;
END $$;
