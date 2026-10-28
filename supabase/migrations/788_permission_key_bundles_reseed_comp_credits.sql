-- UN1TCOMP.1 — reseed private.permission_key_bundles (last seeded by mig 782)
-- after adding the web-only `un1t_comp_credits` key to
-- shared/permission-bundles.js: un1t_comp_credits → bundle_members, with
-- class_roster (the Hatch card's class booking lives there).
--
-- BEHAVIOUR-NEUTRAL for RLS: no policy names `un1t_comp_credits` (the grant
-- is a service-role route, and un1t_write_events is service role only) and
-- it has no MOBILE entry or phone-defaults row, so the extra row can deny
-- nothing. Every other row is unchanged from mig 782.
--
-- ONE TRANSACTION for the same reason as mig 564: an empty table reads as
-- "no key is bundle-gated" (fails OPEN), so TRUNCATE + INSERT must be
-- atomic. Seed content generated verbatim by: node scripts/generate-bundle-sql.mjs
--
-- ORDER. Independent of mig 787; apply with it, before the code deploys.

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
  ('un1t_comp_credits', 'bundle_members'),
  ('whatsapp', 'bundle_marketing'),
  ('whatsapp', 'bundle_messaging');
-- END GENERATED

COMMIT;
