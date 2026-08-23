-- SHELLY-UI.8 — reseed private.permission_key_bundles (mig 550) after
-- widening `device_control` in shared/permission-bundles.js from
-- bundle_marketing-only to ['bundle_marketing', 'bundle_operations'].
--
-- WHY: `device_control` gates studio HARDWARE — Sonos speakers
-- (/automations/sonos) and Shelly smart plugs (/automations/shelly,
-- SHELLY-UI) — power and playback schedules for the building. Richard's
-- decision (2026-08-22): that is an operations concern as much as a
-- marketing one, so an Operations-only tenant must keep it. OR
-- semantics, same as `studio_management` and `email`: the key is
-- bundle-denied only when Marketing AND Operations are BOTH explicitly
-- false in locations.features.
--
-- BEHAVIOUR-NEUTRAL for every location live today: widening an OR set
-- can only ADD holders, never remove one, and the 2026-08-22 prod
-- snapshot found no location with `bundle_marketing: false`. (Re-run
-- that snapshot before merging — Obligation 17 of the SHELLY-UI plan.)
--
-- FORWARD-ONLY: mig 550 is never hand-edited. Each seeding migration is
-- a self-contained full replace (TRUNCATE + INSERT), which is also what
-- keeps scripts/check-bundle-sql.mjs simple — it reads only the LATEST
-- migration that seeds the table, i.e. this one from now on.
--
-- The generator is the source of truth; this file is its SQL mirror.
-- `npm run check:bundle-sql` (and tests/check-bundle-sql.test.js) re-run
-- the generator and diff it against the block below, failing the moment
-- the two drift.
--
-- ONE TRANSACTION — and this is where 564 differs from 550, which needed
-- no wrapper. Mig 550 CREATEd the table in the same file, so at the
-- moment it truncated, no reader existed. 564 truncates a table that
-- private.auth_mobile_can already reads on EVERY mobile RLS check (mig
-- 219 gates deals/notes/activities/bookings/whatsapp_* through it).
-- Applied statement-by-statement, the gap between TRUNCATE and INSERT is
-- a sub-second window in which the table is empty — and an empty table
-- does not read as "everything denied", it reads as "this key is not
-- bundle-gated at all" (the function's `NOT EXISTS (... pkb.key =
-- perm_key)` arm), i.e. it fails OPEN for every key at once. Wrapping
-- the pair keeps the reseed atomic: no reader ever observes the
-- intermediate empty state, and a failed INSERT rolls the TRUNCATE back
-- instead of leaving the mirror wiped.
--
-- Seed content generated verbatim by: node scripts/generate-bundle-sql.mjs

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
  ('sms', 'bundle_marketing'),
  ('sms', 'bundle_messaging'),
  ('studio_management', 'bundle_members'),
  ('studio_management', 'bundle_operations'),
  ('tasks', 'bundle_sales'),
  ('time_off', 'bundle_team'),
  ('tv_displays', 'bundle_operations'),
  ('whatsapp', 'bundle_marketing'),
  ('whatsapp', 'bundle_messaging');
-- END GENERATED

COMMIT;
