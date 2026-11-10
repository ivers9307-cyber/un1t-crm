-- MCPACCESS.1 — reseed private.permission_key_bundles (last seeded by mig 789)
-- after adding the web-only `mcp_access` key to
-- shared/permission-bundles.js: mcp_access → bundle_sales, matching
-- `assistant` (the staff MCP server reads contacts, pipeline and classes).
--
-- WHY BUNDLED AT ALL: an unbundled key is never bundle-denied
-- (deniedByEveryBundle returns false on a missing KEY_BUNDLES entry), so
-- leaving it out would let a tenant on a tier without bundle_sales read
-- contacts and pipeline through MCP while the app blocks them.
--
-- BEHAVIOUR-NEUTRAL for RLS: no policy or helper names `mcp_access` (migs
-- 550/690/691/699 ask about `contacts` and the mobile keys), and it has no
-- MOBILE entry or phone-defaults row (it is in WEB_ONLY_OK — MCP is a
-- desktop/CLI connector), so the extra row can deny nothing. Every other
-- row is unchanged from mig 789.
--
-- ONE TRANSACTION for the same reason as mig 564: an empty table reads as
-- "no key is bundle-gated" (fails OPEN), so TRUNCATE + INSERT must be
-- atomic. Seed content generated verbatim by: node scripts/generate-bundle-sql.mjs
--
-- ORDER. Apply before the code deploys. The JS half (KEY_BUNDLES) binds in
-- app code on its own; this row is what keeps the SQL resolvers in step.

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
  ('whatsapp', 'bundle_marketing'),
  ('whatsapp', 'bundle_messaging');
-- END GENERATED

COMMIT;
