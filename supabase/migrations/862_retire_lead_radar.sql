-- 862 — CONTACTLOG.2: the Lead Radar is retired, and with it the weekly
-- lead-radar-snapshot job (Mon 06:30 UTC), its heartbeat row and the
-- lead_radar permission key.
--
-- Richard's decision (19 Nov 2026): the board's "Not contacted" filter and the
-- Log a contact button (CONTACTLOG.1, #2479) replace the Radar. The job's
-- route and its vercel.json schedule are deleted in the same PR, so a row left
-- behind would go stale and page every week.
--
-- Apply AFTER the code deploys: until then the old job still runs on Monday
-- and stamps this row.
--
-- The lead_radar key leaves shared/permission-bundles.js in the same PR, so
-- private.permission_key_bundles is reseeded without it (last seeded by mig
-- 843; every other row unchanged). ONE TRANSACTION as mig 564 explains: an
-- empty table reads as "no key is bundle-gated" (fails OPEN), so TRUNCATE +
-- INSERT must be atomic. Seed content generated verbatim by:
-- node scripts/generate-bundle-sql.mjs
--
-- The two tables stay on disk (lead_radar_actions: 0 rows ever;
-- lead_radar_snapshots: 98 weekly rows); nothing reads them now, and a later
-- migration drops them.

BEGIN;

DELETE FROM public.cron_heartbeats WHERE name = 'lead-radar-snapshot';

TRUNCATE private.permission_key_bundles;

-- BEGIN GENERATED — node scripts/generate-bundle-sql.mjs
INSERT INTO private.permission_key_bundles (key, bundle) VALUES
  ('accounting_hub', 'bundle_money'),
  ('activities', 'bundle_sales'),
  ('assistant', 'bundle_sales'),
  ('attendance_reports', 'bundle_team'),
  ('automations', 'bundle_marketing'),
  ('bookings', 'bundle_members'),
  ('bookkeeper', 'bundle_money'),
  ('car_processing', 'module_cars'),
  ('card_receipts', 'bundle_money'),
  ('challenges', 'bundle_members'),
  ('churn_radar', 'bundle_members'),
  ('class_fees', 'bundle_money'),
  ('class_roster', 'bundle_members'),
  ('class_timer', 'bundle_members'),
  ('consultations', 'bundle_sales'),
  ('contact_linking', 'bundle_sales'),
  ('contacts', 'bundle_sales'),
  ('contracts', 'bundle_team'),
  ('device_control', 'bundle_marketing'),
  ('device_control', 'bundle_operations'),
  ('email', 'bundle_marketing'),
  ('email', 'bundle_messaging'),
  ('email_inbox', 'bundle_messaging'),
  ('engagement_analytics', 'bundle_members'),
  ('equipment_admin', 'bundle_operations'),
  ('equipment_inspect', 'bundle_operations'),
  ('events', 'bundle_members'),
  ('expenses', 'bundle_team'),
  ('fleet_admin', 'bundle_operations'),
  ('fleet_restart', 'bundle_operations'),
  ('glofox_import', 'bundle_sales'),
  ('hyrox', 'bundle_members'),
  ('integrations_zoom_manage', 'bundle_sales'),
  ('invoices', 'bundle_team'),
  ('invoices_inbox', 'bundle_money'),
  ('landing_page', 'bundle_marketing'),
  ('mcp_access', 'bundle_sales'),
  ('orders', 'bundle_money'),
  ('pipeline', 'bundle_sales'),
  ('preferences_import', 'bundle_sales'),
  ('presentations', 'bundle_operations'),
  ('pulse_admin', 'bundle_members'),
  ('races', 'bundle_members'),
  ('schedule', 'bundle_team'),
  ('studio_management', 'bundle_members'),
  ('studio_management', 'bundle_operations'),
  ('tasks', 'bundle_sales'),
  ('time_off', 'bundle_team'),
  ('tv_displays', 'bundle_operations'),
  ('un1t_comp_credits', 'bundle_members'),
  ('un1t_payment_links', 'bundle_members'),
  ('whatsapp', 'bundle_marketing'),
  ('whatsapp', 'bundle_messaging');
-- END GENERATED

COMMIT;
