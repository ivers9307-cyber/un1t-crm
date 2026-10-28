-- FEES.1 — reseed private.permission_key_bundles (last seeded by mig 738)
-- after adding the web-only `class_fees` key to shared/permission-bundles.js:
-- class_fees → bundle_money, the Money hub where the /class-fees page lives.
--
-- BEHAVIOUR-NEUTRAL for RLS: no policy names `class_fees` (class_fees is
-- service role only, mig 781) and it has no MOBILE entry or phone-defaults
-- row, so the extra row can deny nothing. Every other row is unchanged from
-- mig 738.
--
-- ONE TRANSACTION for the same reason as mig 564: an empty table reads as
-- "no key is bundle-gated" (fails OPEN), so TRUNCATE + INSERT must be
-- atomic. Seed content generated verbatim by: node scripts/generate-bundle-sql.mjs

BEGIN;

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
  ('lead_radar', 'bundle_sales'),
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
  ('whatsapp', 'bundle_marketing'),
  ('whatsapp', 'bundle_messaging');
-- END GENERATED

COMMIT;
