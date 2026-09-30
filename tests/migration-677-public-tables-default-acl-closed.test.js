// TABLEDEFAULTACL.1 — behavioural test for migration 677.
//
// Boots PGlite (PostgreSQL 17) with prod's DEFAULT PRIVILEGES for postgres in
// public (tables arwdDxtm and sequences rwU for postgres, anon, authenticated
// and service_role; functions post-667) and EVERY relation prod has in public
// (30 Sep 2026: 263 tables, 3 views, 7 sequences, by name) put into its live
// ACL shape by the same kind of REVOKE/GRANT the migrations ran. Tables are
// stubs except the few whose behaviour is asserted (google_reviews,
// landing_page_settings, ble_bridges, rosters, contact_external_integrations,
// profiles/profile_locations, postmark_webhook_queue). The supabase_realtime
// publication carries prod's 10 tables. It proves:
//
//   * BEFORE: the census equals prod's (anon on 221 relations / 1,754 items,
//     authenticated TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on 224 / 884, anon
//     and authenticated on 6 sequences); anon reads google_reviews and
//     landing_page_settings; a signed-in session can TRUNCATE and LOCK a table
//     (neither is fenced by RLS); a new table/view/sequence opens to anon;
//   * AFTER: anon and PUBLIC hold nothing in public (tables, views, columns,
//     sequences); authenticated keeps exactly its SELECT/INSERT/UPDATE/DELETE
//     (899 items) and every column grant; service_role and postgres are
//     unchanged (roster_publish_snapshots keeps its SELECT/INSERT-only shape);
//     policies, RLS, ownership and the publication are unchanged; staff,
//     member and service-role flows still work; new relations start
//     postgres + service_role only;
//   * the self-check aborts the WHOLE file on another grantor's anon grant, an
//     anon grant inherited through a role, a relation owned by another role,
//     and a database where 667 is not applied; a second run passes; the plan's
//     rollback record restores every ACL and default row exactly;
//   * the before/after catalog compare BITES: one extra statement slipped in
//     after the REVOKEs (authenticated's table or column privileges, a grant
//     option, service_role, a policy, the publication, RLS, an owner, a
//     function or default ACL) aborts the whole file and names what moved;
//   * every column ACL is byte-identical (raw attacl text) before and after,
//     and C82's 676 end state (shift tables: column SELECT only) holds too.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_677 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/677_public_tables_default_acl_closed.sql'), 'utf8')

const words = (s) => s.trim().split(/\s+/)

// prod, 30 Sep 2026: relacl {postgres, anon, authenticated, service_role = arwdDxtm}.
const FULL_DEFAULT = words(`
  ac_devices ac_external_starts ac_sessions achievement_rules activities ad_accounts ad_entities
  ad_insights_breakdown_daily ad_insights_daily agent_conversation_reviews agent_decisions agent_knowledge
  agent_membership_requests agent_message_feedback api_keys app_claim_tokens assignment_change_log
  automation_fire_log ble_bridges blocked_times booking_reminder_sends bookings campaign_link_clicks
  campaign_recipients campaigns cancellation_form_links car_enquiries card_receipts champ_push_tokens
  checklist_instances checklist_templates chooser_settings churn_radar_actions churn_radar_snapshots
  claim_link_requests class_booking_requests class_bookings class_categories class_occurrences class_timer_runs
  class_timer_templates coach_kudos coaching_goals consultation_photos consultations contact_achievements
  contact_devices contact_events contact_goals contact_import_rows contact_imports contact_segment_memberships
  contact_tags contract_template_versions contract_templates contractor_invoices contracts cron_heartbeats
  customer_engagement_nudges deals device_tokens email_bounce_escalations email_hygiene_releases
  email_inbox_messages email_mailbox_access email_mailbox_credentials email_mailbox_ingress email_mailboxes
  email_sends email_storage_usage email_templates email_ticket_attachments email_tickets equipment
  equipment_inspections equipment_settings equipment_types error_events event_hosts event_reminder_sends
  event_type_reminders external_export_jobs feed_reactions fleet_commands fleet_device_health fleet_devices
  fte_expense_claims fte_expense_items funnel_events generated_reports glofox_invoices
  glofox_invoices_quarantine glofox_memberships glofox_note_pushes glofox_services glofox_sync_runs
  glofox_webhook_events google_reviews heart_rate_sessions host_campaign_clicks host_campaign_sends
  host_campaigns host_contacts host_email_suppressions host_impersonation_log host_users hr_detection_visits
  hr_detections hr_provider_connections hr_samples hyrox_blocks hyrox_class_reminders hyrox_sessions
  impersonation_log inbody_backfill_requests inbody_scans inbody_webhook_events instagram_conversations
  instagram_feed_posts instagram_messages invoices_queue issue_attachments issues landing_page_settings
  lead_radar_actions lead_radar_snapshots location_automations location_holidays location_plans
  location_role_permissions location_trusted_ips member_friendships member_health_metrics
  member_monthly_targets member_social_settings membership_snapshots membership_transitions mobile_bar_prefs
  notes offer_purchases orders org_settings organizations password_overrides_audit person_group_members
  person_groups person_link_suggestions pin_login_attempts pipeline_classification_runs pipeline_stages
  pipelines plan_versions plans policies policy_versions policy_views postmark_webhook_queue
  presentation_slides presentations profile_compensation profile_locations profile_organizations promo_codes
  push_event_sends push_reminder_sends race_checkins race_events race_payments race_penalties
  race_registrations race_waves rate_limit_buckets recon_bank_lines recon_hunts recon_mailboxes recon_runs
  review_login_attempts roster_change_log sale_offers schedule_notifications scheduled_reports
  service_integrations shelly_connections shelly_devices shelly_energy_daily shift_templates
  sms_broadcast_recipients sms_broadcasts sonos_connections sonos_schedules staff_allowances strap_assignments
  strava_activities studio_devices support_sessions team_members teams tenant_domains tenant_email_domains
  tenant_heartbeats tv_content tv_displays tv_templates unsubscribe_refusals usage_events usage_rollups_daily
  wallet_topup_invoices wallet_transactions wallets webhook_dead_letter webhook_events xero_accounts
  xero_contacts xero_supplier_defaults xero_tax_rates zoom_sync_runs
`)
// relacl {postgres, service_role = arwdDxtm} (some with column grants below).
const SERVICE_ONLY = words(`
  audit_events car_bca_submission_events car_bca_submissions car_documents car_notes cars channel_connections
  company_settings consent_log contact_external_integrations contact_location_preferences contact_preferences
  email_sequences glofox_push_events glofox_webhook_attempts locations shift_offers
  shift_template_qualification_requirements staff_attendance_events staff_availability_changes staff_calendar_feeds
  staff_qualification_types staff_qualifications staff_unavailability whatsapp_numbers widget_tokens xero_connections
`)
// authenticated=r only.
const AUTH_READ = words(`
  challenges contact_segments shift_swap_requests time_off_requests whatsapp_broadcast_recipients whatsapp_broadcasts
  whatsapp_conversations whatsapp_template_events whatsapp_templates sequence_enrollments sequence_steps
`)
const AUTH_RM = ['contacts', 'whatsapp_messages']
const SHIFT = ['shift_assignments', 'shift_blocks']
const OPEN_SEQS = words(`
  glofox_invoices_quarantine_quarantine_id_seq glofox_webhook_attempts_id_seq pin_login_attempts_id_seq
  postmark_webhook_queue_id_seq review_login_attempts_id_seq webhook_dead_letter_id_seq
`)
const SPECIAL = ['rosters', 'roster_publish_snapshots', 'event_types', 'shift_block_removals', 'profiles']
const CUSTOM = ['google_reviews', 'landing_page_settings', 'ble_bridges', 'rosters', 'contact_external_integrations',
  'profiles', 'profile_locations', 'postmark_webhook_queue', 'contacts', 'locations', 'email_sequences',
  'cron_heartbeats', 'tenant_heartbeats', ...SHIFT]
const ALL_TABLES = [...FULL_DEFAULT, ...SERVICE_ONLY, ...AUTH_READ, ...AUTH_RM, ...SHIFT, ...SPECIAL]
const PUBLISHED = ['agent_membership_requests', 'email_inbox_messages', 'email_mailboxes', 'email_tickets',
  'instagram_conversations', 'instagram_messages', 'whatsapp_conversations', 'whatsapp_messages',
  'whatsapp_template_events', 'whatsapp_templates']
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']

const pub = (names) => names.map((t) => `public.${t}`).join(', ')

// The rollback record from the C76 plan (Task 5 Step 7), verbatim.
const ROLLBACK_677 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
GRANT ALL ON SEQUENCE
  public.glofox_invoices_quarantine_quarantine_id_seq, public.glofox_webhook_attempts_id_seq,
  public.pin_login_attempts_id_seq, public.postmark_webhook_queue_id_seq,
  public.review_login_attempts_id_seq, public.webhook_dead_letter_id_seq
TO anon, authenticated;
-- the 216 tables and 2 views that held the full default (anon and authenticated arwdDxtm)
GRANT ALL ON TABLE
  public.ac_devices, public.ac_external_starts, public.ac_sessions, public.achievement_rules,
  public.activities, public.ad_accounts, public.ad_entities, public.ad_insights_breakdown_daily,
  public.ad_insights_daily, public.agent_conversation_reviews, public.agent_decisions,
  public.agent_knowledge, public.agent_membership_requests, public.agent_message_feedback, public.api_keys,
  public.app_claim_tokens, public.assignment_change_log, public.automation_fire_log, public.ble_bridges,
  public.blocked_times, public.booking_reminder_sends, public.bookings, public.campaign_link_clicks,
  public.campaign_recipients, public.campaigns, public.cancellation_form_links, public.car_enquiries,
  public.card_receipts, public.champ_push_tokens, public.checklist_instances, public.checklist_templates,
  public.chooser_settings, public.churn_radar_actions, public.churn_radar_snapshots,
  public.claim_link_requests, public.class_booking_requests, public.class_bookings, public.class_categories,
  public.class_occurrences, public.class_timer_runs, public.class_timer_templates, public.coach_kudos,
  public.coaching_goals, public.consultation_photos, public.consultations, public.contact_achievements,
  public.contact_devices, public.contact_events, public.contact_goals, public.contact_import_rows,
  public.contact_imports, public.contact_segment_memberships, public.contact_tags,
  public.contract_template_versions, public.contract_templates, public.contractor_invoices, public.contracts,
  public.cron_heartbeats, public.customer_engagement_nudges, public.deals, public.device_tokens,
  public.email_bounce_escalations, public.email_hygiene_releases, public.email_inbox_messages,
  public.email_mailbox_access, public.email_mailbox_credentials, public.email_mailbox_ingress,
  public.email_mailboxes, public.email_sends, public.email_storage_usage, public.email_templates,
  public.email_ticket_attachments, public.email_tickets, public.equipment, public.equipment_inspections,
  public.equipment_settings, public.equipment_types, public.error_events, public.event_hosts,
  public.event_reminder_sends, public.event_type_reminders, public.external_export_jobs,
  public.feed_reactions, public.fleet_commands, public.fleet_device_health, public.fleet_devices,
  public.fte_expense_claims, public.fte_expense_items, public.funnel_events, public.generated_reports,
  public.glofox_invoices, public.glofox_invoices_quarantine, public.glofox_memberships,
  public.glofox_note_pushes, public.glofox_services, public.glofox_sync_runs, public.glofox_webhook_events,
  public.google_reviews, public.heart_rate_sessions, public.host_campaign_clicks, public.host_campaign_sends,
  public.host_campaigns, public.host_contacts, public.host_email_suppressions, public.host_impersonation_log,
  public.host_users, public.hr_detection_visits, public.hr_detections, public.hr_provider_connections,
  public.hr_samples, public.hyrox_blocks, public.hyrox_class_reminders, public.hyrox_sessions,
  public.impersonation_log, public.inbody_backfill_requests, public.inbody_scans,
  public.inbody_webhook_events, public.instagram_conversations, public.instagram_feed_posts,
  public.instagram_messages, public.invoices_queue, public.issue_attachments, public.issues,
  public.landing_page_settings, public.lead_radar_actions, public.lead_radar_snapshots,
  public.location_automations, public.location_holidays, public.location_plans,
  public.location_role_permissions, public.location_trusted_ips, public.member_friendships,
  public.member_health_metrics, public.member_monthly_targets, public.member_social_settings,
  public.membership_snapshots, public.membership_transitions, public.mobile_bar_prefs, public.notes,
  public.offer_purchases, public.orders, public.org_settings, public.organizations,
  public.password_overrides_audit, public.person_group_members, public.person_groups,
  public.person_link_suggestions, public.pin_login_attempts, public.pipeline_classification_runs,
  public.pipeline_stages, public.pipelines, public.plan_versions, public.plans, public.policies,
  public.policy_versions, public.policy_views, public.postmark_webhook_queue, public.presentation_slides,
  public.presentations, public.profile_compensation, public.profile_locations, public.profile_organizations,
  public.promo_codes, public.push_event_sends, public.push_reminder_sends, public.race_checkins,
  public.race_events, public.race_payments, public.race_penalties, public.race_registrations,
  public.race_waves, public.rate_limit_buckets, public.recon_bank_lines, public.recon_hunts,
  public.recon_mailboxes, public.recon_runs, public.review_login_attempts, public.roster_change_log,
  public.sale_offers, public.schedule_notifications, public.scheduled_reports, public.service_integrations,
  public.shelly_connections, public.shelly_devices, public.shelly_energy_daily, public.shift_templates,
  public.sms_broadcast_recipients, public.sms_broadcasts, public.sonos_connections, public.sonos_schedules,
  public.staff_allowances, public.strap_assignments, public.strava_activities, public.studio_devices,
  public.support_sessions, public.team_members, public.teams, public.tenant_domains,
  public.tenant_email_domains, public.tenant_heartbeats, public.tv_content, public.tv_displays,
  public.tv_templates, public.unsubscribe_refusals, public.usage_events, public.usage_rollups_daily,
  public.wallet_topup_invoices, public.wallet_transactions, public.wallets, public.webhook_dead_letter,
  public.webhook_events, public.xero_accounts, public.xero_contacts, public.xero_supplier_defaults,
  public.xero_tax_rates, public.zoom_sync_runs, public.cron_health, public.tenant_cron_health
TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.rosters TO anon;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.rosters, public.shift_block_removals TO authenticated;
GRANT SELECT, MAINTAIN ON TABLE public.event_types TO anon;
GRANT MAINTAIN ON TABLE public.profiles TO anon;
GRANT MAINTAIN ON TABLE public.event_types, public.profiles, public.contacts, public.whatsapp_messages TO authenticated;
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const MASTER = '10000000-0000-0000-0000-000000000001'
const STAFF_A = '10000000-0000-0000-0000-000000000002'
const MEMBER = '10000000-0000-0000-0000-000000000003'
const CONTACT = '40000000-0000-0000-0000-000000000001'
const CEI = '50000000-0000-0000-0000-000000000001'
const ROSTER = '60000000-0000-0000-0000-000000000001'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE ROLE sneaky NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  CREATE SCHEMA extensions;
  GRANT USAGE ON SCHEMA auth, public, extensions TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated;   -- live: anon and service_role have none

  -- prod pg_default_acl for postgres (30 Sep 2026)
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO postgres, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA extensions GRANT EXECUTE ON FUNCTIONS TO PUBLIC;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  -- Tables whose behaviour is asserted (column subsets).
  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, settings jsonb);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, location_id uuid, user_id uuid);
  CREATE TABLE public.google_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, comment text, hidden boolean DEFAULT false);
  CREATE TABLE public.landing_page_settings (location_id uuid PRIMARY KEY, hero_headline text, publish_state text);
  CREATE TABLE public.ble_bridges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid);
  CREATE TABLE public.rosters (id uuid PRIMARY KEY, location_id uuid, status text, notes text);
  CREATE TABLE public.contact_external_integrations (id uuid PRIMARY KEY, contact_id uuid, enabled boolean, secret text);
  CREATE TABLE public.email_sequences (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, webhook_secret text);
  CREATE TABLE public.shift_blocks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, notes text);
  CREATE TABLE public.shift_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, notes text);
  CREATE TABLE public.cron_heartbeats (name text PRIMARY KEY, last_ok_at timestamptz);
  CREATE TABLE public.tenant_heartbeats (name text, location_id uuid, last_ok_at timestamptz);
  CREATE SEQUENCE public.postmark_webhook_queue_id_seq;
  CREATE TABLE public.postmark_webhook_queue (id bigint PRIMARY KEY DEFAULT nextval('public.postmark_webhook_queue_id_seq'), payload jsonb);
  ALTER SEQUENCE public.postmark_webhook_queue_id_seq OWNED BY public.postmark_webhook_queue.id;
`

// Stubs for every other prod table, the views and sequences.
const STUBS = () => [
  ...ALL_TABLES.filter((t) => !CUSTOM.includes(t))
    .map((t) => `CREATE TABLE public.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid);`),
  `CREATE VIEW public.cron_health WITH (security_invoker = on) AS SELECT name, last_ok_at FROM public.cron_heartbeats;`,
  `CREATE VIEW public.tenant_cron_health WITH (security_invoker = on) AS SELECT name, location_id FROM public.tenant_heartbeats;`,
  `CREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS SELECT id, location_id FROM public.contacts;`,
  ...OPEN_SEQS.filter((s) => s !== 'postmark_webhook_queue_id_seq').map((s) => `CREATE SEQUENCE public.${s};`),
  `CREATE SEQUENCE public.wallet_topup_invoice_seq;`,
  // RLS on every table (prod: all 263).
  `DO $$ DECLARE r record; BEGIN
     FOR r IN SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' LOOP
       EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
     END LOOP; END $$;`,
].join('\n')

// Put each relation into its live ACL shape (the REVOKE/GRANT forms migs
// 153b/607-675 used).
const LIVE_SHAPES = `
  REVOKE ALL ON ${pub(SERVICE_ONLY)}, public.contact_location_audience FROM anon, authenticated;
  GRANT SELECT (id, contact_id, enabled), UPDATE (enabled) ON public.contact_external_integrations TO authenticated;  -- 648 shape
  GRANT SELECT (id, name), UPDATE (name) ON public.locations TO authenticated;                                      -- 648 shape
  GRANT SELECT (id, location_id) ON public.email_sequences TO authenticated;                                       -- 654 shape
  REVOKE ALL ON ${pub(AUTH_READ)} FROM anon, authenticated;
  GRANT SELECT ON ${pub(AUTH_READ)} TO authenticated;
  REVOKE ALL ON ${pub(AUTH_RM)} FROM anon, authenticated;
  GRANT SELECT, MAINTAIN ON ${pub(AUTH_RM)} TO authenticated;
  REVOKE ALL ON ${pub(SHIFT)} FROM anon, authenticated;
  GRANT INSERT, UPDATE, DELETE ON ${pub(SHIFT)} TO authenticated;
  GRANT SELECT (id, location_id) ON ${pub(SHIFT)} TO authenticated;                                               -- 646 shape
  REVOKE SELECT ON public.rosters FROM anon, authenticated;                                                         -- 618
  GRANT SELECT (id, location_id, status) ON public.rosters TO authenticated;
  REVOKE ALL ON public.roster_publish_snapshots FROM anon, authenticated, service_role;                             -- 634
  GRANT SELECT, INSERT ON public.roster_publish_snapshots TO service_role;
  REVOKE ALL ON public.event_types FROM anon, authenticated;                                                         -- 650
  GRANT SELECT, MAINTAIN ON public.event_types TO anon, authenticated;
  REVOKE ALL ON public.shift_block_removals FROM anon;                                                               -- 613
  REVOKE ALL ON public.profiles FROM anon, authenticated;                                                            -- 153b, 622
  GRANT MAINTAIN ON public.profiles TO anon, authenticated;
  REVOKE ALL ON SEQUENCE public.wallet_topup_invoice_seq FROM anon, authenticated;
`

const HELPERS_AND_POLICIES = `
  -- post-667 member RPC (677's precondition reads it)
  CREATE FUNCTION public.list_enabled_integrations() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER AS 'SELECT 1';
  REVOKE ALL ON FUNCTION public.list_enabled_integrations() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.list_enabled_integrations() TO authenticated;

  -- helpers (shapes as live: auth_is_master NULL-ACL-like, the other two not anon)
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role = 'master' AND p.active)
  $$;
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations
               WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;
  REVOKE ALL ON FUNCTION private.auth_is_in_location(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.auth_is_in_location(uuid) TO authenticated, service_role;
  CREATE FUNCTION private.auth_contact_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT id FROM public.contacts WHERE user_id = (SELECT auth.uid()) LIMIT 1
  $$;
  REVOKE ALL ON FUNCTION private.auth_contact_id() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.auth_contact_id() TO authenticated, service_role;

  -- policies, verbatim where behaviour is asserted
  CREATE POLICY google_reviews_member_select ON public.google_reviews FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id));
  CREATE POLICY google_reviews_public_read ON public.google_reviews FOR SELECT TO anon USING ((hidden = false) AND (comment IS NOT NULL));
  CREATE POLICY landing_page_settings_public_read ON public.landing_page_settings FOR SELECT TO anon, authenticated USING (true);
  CREATE POLICY ble_bridges_read ON public.ble_bridges FOR SELECT USING (((SELECT private.auth_is_master() AS auth_is_master) OR private.auth_is_in_location(location_id)));
  CREATE POLICY rosters_select ON public.rosters FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id) AND status = ANY (ARRAY['published', 'superseded']));
  CREATE POLICY "Customers update own integration toggle" ON public.contact_external_integrations FOR UPDATE USING (contact_id = private.auth_contact_id()) WITH CHECK (contact_id = private.auth_contact_id());
  CREATE POLICY contact_external_integrations_read ON public.contact_external_integrations FOR SELECT USING (contact_id = private.auth_contact_id());
  CREATE POLICY postmark_webhook_queue_service_role ON public.postmark_webhook_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
  CREATE POLICY no_anon_or_authenticated_access ON public.cron_heartbeats AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

  CREATE PUBLICATION supabase_realtime FOR TABLE ${pub(PUBLISHED)};
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}', 'Synthetic Studio', '{}');
  INSERT INTO public.profiles VALUES ('${MASTER}', 'master', true, NULL), ('${STAFF_A}', 'staff', true, NULL);
  INSERT INTO public.profile_locations VALUES ('${STAFF_A}', '${LOC_A}', 'staff');
  INSERT INTO public.contacts VALUES ('${CONTACT}', '${LOC_A}', '${MEMBER}');
  INSERT INTO public.google_reviews (location_id, comment, hidden) VALUES ('${LOC_A}', 'synthetic review', false), ('${LOC_A}', NULL, false);
  INSERT INTO public.landing_page_settings VALUES ('${LOC_A}', 'Synthetic headline', 'draft');
  INSERT INTO public.ble_bridges (location_id) VALUES ('${LOC_A}');
  INSERT INTO public.rosters VALUES ('${ROSTER}', '${LOC_A}', 'published', 'manager-only note');
  INSERT INTO public.contact_external_integrations VALUES ('${CEI}', '${CONTACT}', true, 'fake-secret');
  INSERT INTO public.notes (location_id) VALUES ('${LOC_A}');
`

let db
const runSql = (text) => db['exec'](text)

async function as(claims, role, ...statements) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    await runSql(`SET LOCAL ROLE ${role}`)
    let rows = []
    for (const s of statements) rows = (await db.query(s)).rows
    return rows
  } finally {
    await runSql('ROLLBACK')
  }
}
const asUser = (uid, ...s) => as({ sub: uid, role: 'authenticated' }, 'authenticated', ...s)
const asRole = (role, ...s) => as({ role }, role, ...s)

async function one(sql, params) { return (await db.query(sql, params)).rows[0] }

/** The prod census query (Task 0 Step 2 (b)), verbatim in substance. */
async function census() {
  return one(`
    WITH rel AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','f')),
         x AS (SELECT r.oid, p FROM rel r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p),
         s AS (SELECT c.oid, p FROM pg_class c CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S')
    SELECT (SELECT count(DISTINCT oid)::int FROM x WHERE has_table_privilege('anon', oid, p)) AS anon_rels,
           (SELECT count(*)::int FROM x WHERE has_table_privilege('anon', oid, p)) AS anon_items,
           (SELECT count(DISTINCT oid)::int FROM x WHERE has_table_privilege('authenticated', oid, p) AND p IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')) AS auth_tmx_rels,
           (SELECT count(*)::int FROM x WHERE has_table_privilege('authenticated', oid, p) AND p IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')) AS auth_tmx_items,
           (SELECT count(*)::int FROM x WHERE has_table_privilege('authenticated', oid, p) AND p IN ('SELECT','INSERT','UPDATE','DELETE')) AS auth_siud_items,
           (SELECT count(*)::int FROM x WHERE NOT has_table_privilege('service_role', oid, p)) AS svc_missing,
           (SELECT count(DISTINCT oid)::int FROM s WHERE has_sequence_privilege('anon', oid, p)) AS anon_seqs,
           (SELECT count(DISTINCT oid)::int FROM s WHERE has_sequence_privilege('authenticated', oid, p)) AS auth_seqs,
           (SELECT count(*)::int FROM rel) AS rels,
           (SELECT count(DISTINCT oid)::int FROM s) AS seqs`)
}

/** Every public relation's and column's ACL, NULL expanded, as sorted item sets. */
async function aclSets() {
  const { rows } = await db.query(`
    SELECT c.relname AS k, coalesce(string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY 1), '') AS items
      FROM pg_class c
      LEFT JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) a ON true
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','v','S')
     GROUP BY 1
    UNION ALL
    SELECT c.relname || '.' || att.attname, string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY 1)
      FROM pg_class c JOIN pg_attribute att ON att.attrelid = c.oid
      CROSS JOIN LATERAL aclexplode(att.attacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE c.relnamespace = 'public'::regnamespace AND att.attacl IS NOT NULL
     GROUP BY 1`)
  return Object.fromEntries(rows.map((r) => [r.k, r.items.split(',').sort().join(',')]))
}

/** postgres's default ACL rows, as 'schema type grantee:priv' items, sorted. */
async function defaultAcls() {
  const { rows } = await db.query(`
    SELECT coalesce(n.nspname, '<global>') || ' ' || d.defaclobjtype::text || ' ' || coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type AS item
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE d.defaclrole = 'postgres'::regrole`)
  return rows.map((r) => r.item).sort()
}

/** Who can do what on a brand-new table, view and sequence in public. */
async function newRelationsCan() {
  await runSql(`CREATE TABLE public._t_probe (id int); CREATE VIEW public._t_probe_v AS SELECT id FROM public._t_probe; CREATE SEQUENCE public._t_probe_s;`)
  const out = {}
  for (const role of ['anon', 'authenticated', 'service_role', 'public']) {
    const r = await one(`SELECT
        (SELECT count(*)::int FROM unnest($2::text[]) p WHERE has_table_privilege($1, 'public._t_probe', p)) AS t,
        (SELECT count(*)::int FROM unnest($2::text[]) p WHERE has_table_privilege($1, 'public._t_probe_v', p)) AS v,
        (SELECT count(*)::int FROM unnest(ARRAY['USAGE','SELECT','UPDATE']) p WHERE has_sequence_privilege($1, 'public._t_probe_s', p)) AS s`,
    [role, PRIVS])
    out[role] = r
  }
  await runSql(`DROP VIEW public._t_probe_v; DROP TABLE public._t_probe; DROP SEQUENCE public._t_probe_s;`)
  return out
}
const ALL_OPEN = { t: 8, v: 8, s: 3 }
const NONE = { t: 0, v: 0, s: 0 }

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(STUBS())
  await runSql(LIVE_SHAPES)
  await runSql(HELPERS_AND_POLICIES)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_677)
}

const BEFORE_CENSUS = {
  anon_rels: 221, anon_items: 1754, auth_tmx_rels: 224, auth_tmx_items: 884, auth_siud_items: 899,
  svc_missing: 6, anon_seqs: 6, auth_seqs: 6, rels: 266, seqs: 7,
}

describe('before 677 — prod, 30 Sep 2026', () => {
  beforeAll(() => boot(), 120_000)
  afterAll(() => db?.close())

  it('the census equals prod\'s', async () => {
    expect(await census()).toEqual(BEFORE_CENSUS)
  })

  it('anon reads the two TO-anon tables (nothing in any repo does)', async () => {
    expect(await asRole('anon', 'SELECT comment FROM public.google_reviews')).toEqual([{ comment: 'synthetic review' }])
    expect(await asRole('anon', 'SELECT publish_state FROM public.landing_page_settings')).toEqual([{ publish_state: 'draft' }])
    expect(await asRole('anon', 'SELECT count(*)::int AS n FROM public.notes')).toEqual([{ n: 0 }])   // RLS, not the grant
  })

  it('a signed-in session can TRUNCATE and LOCK a table: RLS fences neither', async () => {
    expect(await asUser(STAFF_A, 'LOCK TABLE public.notes IN ACCESS EXCLUSIVE MODE', 'SELECT 1 AS ok')).toEqual([{ ok: 1 }])
    expect(await asUser(STAFF_A, 'TRUNCATE public.notes', "SELECT 'truncated' AS ok")).toEqual([{ ok: 'truncated' }])
  })

  it('a new table, view and sequence open to anon and authenticated', async () => {
    const can = await newRelationsCan()
    expect(can.anon).toEqual(ALL_OPEN)
    expect(can.authenticated).toEqual(ALL_OPEN)
    expect(can.public).toEqual(NONE)
  })
})

describe('after 677 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 120_000)
  afterAll(() => db?.close())

  it('anon nothing; authenticated keeps its 899 read/write items and loses the 884 maintenance items; sequences closed', async () => {
    expect(await census()).toEqual({ ...BEFORE_CENSUS, anon_rels: 0, anon_items: 0, auth_tmx_rels: 0, auth_tmx_items: 0, anon_seqs: 0, auth_seqs: 0 })
  })

  it('every column grant survives (618/646/648/654 shapes)', async () => {
    const acl = await aclSets()
    expect(acl['rosters.status']).toBe('authenticated:SELECT')
    expect(acl['shift_blocks.location_id']).toBe('authenticated:SELECT')
    expect(acl['contact_external_integrations.enabled']).toBe('authenticated:SELECT,authenticated:UPDATE')
    expect(acl['locations.name']).toBe('authenticated:SELECT,authenticated:UPDATE')
    expect(acl['email_sequences.location_id']).toBe('authenticated:SELECT')
    expect(acl.roster_publish_snapshots).toBe('postgres:DELETE,postgres:INSERT,postgres:MAINTAIN,postgres:REFERENCES,postgres:SELECT,postgres:TRIGGER,postgres:TRUNCATE,postgres:UPDATE,service_role:INSERT,service_role:SELECT')
  })

  it('the defaults: new tables, views and sequences are postgres + service_role only', async () => {
    const can = await newRelationsCan()
    expect(can.anon).toEqual(NONE)
    expect(can.authenticated).toEqual(NONE)
    expect(can.public).toEqual(NONE)
    expect(can.service_role).toEqual(ALL_OPEN)
    expect((await defaultAcls()).filter((i) => i.startsWith('public r ') || i.startsWith('public S '))).toEqual([
      'public S postgres:SELECT', 'public S postgres:UPDATE', 'public S postgres:USAGE',
      'public S service_role:SELECT', 'public S service_role:UPDATE', 'public S service_role:USAGE',
      ...PRIVS.map((p) => `public r postgres:${p}`).sort(), ...PRIVS.map((p) => `public r service_role:${p}`).sort(),
    ].sort())
  })

  it('the realtime publication and the policies are untouched', async () => {
    const { rows } = await db.query(`SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' ORDER BY 1`)
    expect(rows.map((r) => r.tablename)).toEqual([...PUBLISHED].sort())
    expect((await one(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`)).n).toBe(9)
  })
})

describe('after 677 — people', () => {
  beforeAll(() => boot({ migrate: true }), 120_000)
  afterAll(() => db?.close())

  it('anon: every read is 42501, the two TO-anon tables included', async () => {
    for (const t of ['google_reviews', 'landing_page_settings', 'notes', 'event_types', 'cron_health']) {
      await expect(asRole('anon', `SELECT 1 FROM public.${t}`), t).rejects.toThrow(new RegExp(`permission denied for (table|view) ${t}`))
    }
    await expect(asRole('anon', `SELECT nextval('public.webhook_dead_letter_id_seq')`)).rejects.toThrow(/permission denied for sequence/)
  })

  it('staff: reads rosters (granted columns), google reviews and a bridge at their studio', async () => {
    expect(await asUser(STAFF_A, 'SELECT id, status FROM public.rosters')).toEqual([{ id: ROSTER, status: 'published' }])
    expect(await asUser(STAFF_A, 'SELECT count(*)::int AS n FROM public.google_reviews')).toEqual([{ n: 2 }])
    expect(await asUser(STAFF_A, 'SELECT count(*)::int AS n FROM public.ble_bridges')).toEqual([{ n: 1 }])
    await expect(asUser(STAFF_A, 'SELECT notes FROM public.rosters')).rejects.toThrow(/permission denied for table rosters/)
  })

  it('member: still flips their own integration toggle (column UPDATE, 648)', async () => {
    expect(await asUser(MEMBER, `UPDATE public.contact_external_integrations SET enabled = false WHERE id = '${CEI}' RETURNING id`))
      .toEqual([{ id: CEI }])
  })

  it('signed-in: TRUNCATE is refused; LOCK is refused only where no UPDATE/DELETE grant remains (F-list)', async () => {
    await expect(asUser(STAFF_A, 'TRUNCATE public.notes')).rejects.toThrow(/permission denied for table notes/)
    await expect(asUser(STAFF_A, 'LOCK TABLE public.challenges IN ACCESS EXCLUSIVE MODE')).rejects.toThrow(/permission denied for table challenges/)
    // notes keeps the default UPDATE/DELETE (per-table work, C101), which LOCK also accepts.
    expect(await asUser(STAFF_A, 'LOCK TABLE public.notes IN ACCESS EXCLUSIVE MODE', 'SELECT 1 AS ok')).toEqual([{ ok: 1 }])
  })

  it('service_role: a serial insert into the Postmark queue still works', async () => {
    expect(await asRole('service_role', `INSERT INTO public.postmark_webhook_queue (payload) VALUES ('{}') RETURNING id > 0 AS ok`))
      .toEqual([{ ok: true }])
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message) {
    await boot({ before })
    const pre = await census()
    await expect(runSql(MIG_677)).rejects.toThrow(message)
    await runSql('ROLLBACK')
    expect(await census()).toEqual(pre)   // nothing applied
  }

  it("when another grantor's anon grant survives the REVOKE", () => expectAbort(
    `GRANT SELECT ON public.notes TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT SELECT ON public.notes TO anon; RESET ROLE;`,
    /mig 677: anon still holds: notes:SELECT/,
  ), 120_000)

  it('when anon inherits a privilege through a role', () => expectAbort(
    `GRANT SELECT ON public.issues TO sneaky; GRANT sneaky TO anon;`,
    /mig 677: anon still holds: issues:SELECT/,
  ), 120_000)

  it('when a relation in public is owned by another role', () => expectAbort(
    `ALTER TABLE public.issues OWNER TO other_grantor;`,
    /mig 677: relations in public not owned by postgres .*issues \(other_grantor\)/,
  ), 120_000)

  it('when 667 is not applied', () => expectAbort(
    `GRANT EXECUTE ON FUNCTION public.list_enabled_integrations() TO anon;`,
    /mig 677: apply 667 first/,
  ), 120_000)

  it('a second run passes (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_677)).resolves.toBeDefined()
    expect((await census()).anon_items).toBe(0)
  }, 120_000)
})

// The last statement before the self-check; a mutation is slipped in after it,
// so the REVOKEs have run and only the before/after compare can catch it.
const LAST_STATEMENT = 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;'
function mutated(statement) {
  expect(MIG_677.split(LAST_STATEMENT)).toHaveLength(2)
  return MIG_677.replace(LAST_STATEMENT, `${LAST_STATEMENT}\n${statement}`)
}
const MOVED = "mig 677: something besides anon, PUBLIC and authenticated's maintenance/sequence privileges changed: "
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('the before/after compare aborts the whole file when anything else moves', () => {
  afterEach(async () => { await db?.close() })

  async function expectMoved(statement, what) {
    await boot()
    const before = { acl: await aclSets(), census: await census() }
    await expect(runSql(mutated(statement))).rejects.toThrow(new RegExp(esc(MOVED) + '.*' + esc(what)))
    await runSql('ROLLBACK')
    expect(await aclSets()).toEqual(before.acl)   // nothing applied
    expect(await census()).toEqual(before.census)
  }

  it.each([
    // authenticated, table level: SELECT/INSERT/UPDATE/DELETE never move
    ['REVOKE SELECT ON public.challenges FROM authenticated;', 'privilege challenges authenticated SELECT: true -> false'],
    ['REVOKE INSERT ON public.notes FROM authenticated;', 'privilege notes authenticated INSERT: true -> false'],
    ['REVOKE DELETE ON public.shift_blocks FROM authenticated;', 'privilege shift_blocks authenticated DELETE: true -> false'],
    ['GRANT UPDATE ON public.challenges TO authenticated;', 'privilege challenges authenticated UPDATE: false -> true'],
    ['GRANT SELECT ON public.challenges TO authenticated WITH GRANT OPTION;', 'table acl challenges authenticated SELECT: postgres/false -> postgres/true'],
    // authenticated, column level (the D2 mistake: a table-level REVOKE ALL wipes the column grants)
    ['REVOKE ALL ON public.contact_external_integrations FROM authenticated;', 'column acl contact_external_integrations.contact_id authenticated SELECT: postgres/false -> (absent)'],
    ['REVOKE UPDATE (enabled) ON public.contact_external_integrations FROM authenticated;', 'column acl contact_external_integrations.enabled authenticated UPDATE: postgres/false -> (absent)'],
    ['GRANT SELECT (notes) ON public.rosters TO authenticated;', 'column acl rosters.notes authenticated SELECT: (absent) -> postgres/false'],
    ['REVOKE SELECT (location_id) ON public.shift_assignments FROM authenticated;', 'column acl shift_assignments.location_id authenticated SELECT: postgres/false -> (absent)'],
    // service_role (and postgres)
    ['REVOKE DELETE ON public.notes FROM service_role;', 'privilege notes service_role DELETE: true -> false'],
    ['GRANT UPDATE ON public.roster_publish_snapshots TO service_role;', 'privilege roster_publish_snapshots service_role UPDATE: false -> true'],
    ['REVOKE SELECT ON public.contact_location_audience FROM service_role;', 'privilege contact_location_audience service_role SELECT: true -> false'],
    ['REVOKE USAGE ON SEQUENCE public.postmark_webhook_queue_id_seq FROM service_role;', 'sequence privilege postmark_webhook_queue_id_seq service_role USAGE: true -> false'],
    ['GRANT SELECT (id) ON public.notes TO service_role;', 'column acl notes.id service_role SELECT: (absent) -> postgres/false'],
    // policies
    ['ALTER POLICY rosters_select ON public.rosters USING (true);', 'policy public.rosters rosters_select: '],
    ['DROP POLICY google_reviews_public_read ON public.google_reviews;', 'policy public.google_reviews google_reviews_public_read: '],
    ['CREATE POLICY slipped_in ON public.notes FOR SELECT TO authenticated USING (true);', 'policy public.notes slipped_in: (absent) -> '],
    ['ALTER POLICY landing_page_settings_public_read ON public.landing_page_settings TO anon;', 'policy public.landing_page_settings landing_page_settings_public_read: '],
    // the realtime publication
    ['ALTER PUBLICATION supabase_realtime DROP TABLE public.email_tickets;', 'publication supabase_realtime public.email_tickets: '],
    ['ALTER PUBLICATION supabase_realtime ADD TABLE public.notes;', 'publication supabase_realtime public.notes: (absent) -> '],
    ["ALTER PUBLICATION supabase_realtime SET (publish = 'insert');", 'publication options supabase_realtime: '],
    // RLS, owners, function/schema/default ACLs
    ['ALTER TABLE public.notes DISABLE ROW LEVEL SECURITY;', 'rls notes: true/false -> false/false'],
    ['ALTER TABLE public.notes FORCE ROW LEVEL SECURITY;', 'rls notes: true/false -> true/true'],
    ['ALTER TABLE public.ble_bridges OWNER TO other_grantor;', 'owner ble_bridges: postgres -> other_grantor'],
    ['GRANT EXECUTE ON FUNCTION private.auth_contact_id() TO anon;', 'function acl private.auth_contact_id(): '],
    ['REVOKE USAGE ON SCHEMA private FROM authenticated;', 'schema acl private: '],
    ['ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;', 'default acl postgres private f: '],
  ])('%s', (statement, what) => expectMoved(statement, what), 120_000)
})

describe('column ACLs are byte-identical; service_role and postgres keep every item', () => {
  afterAll(() => db?.close())

  it('raw attacl text of every column, and every non-anon relation ACL item, before = after', async () => {
    await boot()
    const columns = `SELECT c.relname || '.' || a.attname AS k, a.attacl::text AS acl FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                      WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL ORDER BY 1`
    const kept = `SELECT c.relname || ' ' || coalesce(r.rolname, 'PUBLIC') || ' ' || g.privilege_type || ' ' || pg_get_userbyid(g.grantor) || '/' || g.is_grantable AS k
                    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) g LEFT JOIN pg_roles r ON r.oid = g.grantee
                   WHERE c.relnamespace = 'public'::regnamespace AND r.rolname IN ('service_role', 'postgres') ORDER BY 1`
    const before = { columns: (await db.query(columns)).rows, kept: (await db.query(kept)).rows }
    expect(before.columns.length).toBeGreaterThan(10)
    await runSql(MIG_677)
    expect((await db.query(columns)).rows).toEqual(before.columns)
    expect((await db.query(kept)).rows).toEqual(before.kept)
  }, 120_000)
})

describe("with C82's 676 end state (shift tables: authenticated column SELECT only)", () => {
  // 676 (#1882) revokes authenticated's INSERT/UPDATE/DELETE on the two shift
  // tables and keeps mig 646's column SELECT; 677 must pass on either order.
  const MIG_676_END_STATE = `REVOKE INSERT, UPDATE, DELETE ON public.shift_blocks, public.shift_assignments FROM authenticated;`
  afterAll(() => db?.close())

  it('677 applies on top; the census moves by the 6 shift write items only; the column grants stay', async () => {
    await boot({ before: MIG_676_END_STATE })
    expect(await census()).toEqual({ ...BEFORE_CENSUS, auth_siud_items: 893 })
    await runSql(MIG_677)
    expect(await census()).toEqual({ ...BEFORE_CENSUS, auth_siud_items: 893, anon_rels: 0, anon_items: 0, auth_tmx_rels: 0, auth_tmx_items: 0, anon_seqs: 0, auth_seqs: 0 })
    const acl = await aclSets()
    expect(acl.shift_blocks).not.toMatch(/authenticated/)
    expect(acl['shift_blocks.location_id']).toBe('authenticated:SELECT')
    expect(acl['shift_assignments.id']).toBe('authenticated:SELECT')
  }, 120_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores every relation, column and default ACL exactly (as sets)', async () => {
    await boot()
    const before = { acl: await aclSets(), defaults: await defaultAcls(), census: await census() }
    await runSql(MIG_677)
    await runSql(ROLLBACK_677)
    expect(await aclSets()).toEqual(before.acl)
    expect(await defaultAcls()).toEqual(before.defaults)
    expect(await census()).toEqual(before.census)
  }, 120_000)
})
