-- TENANT.8 (item 3a) — teach private.auth_mobile_can (mig 218/219) the
-- feature-bundle layer, mirroring shared/permission-bundles.js's
-- KEY_BUNDLES / bundlesDenyKey() exactly: a key is bundle-denied iff
-- it has >=1 owning bundle AND every owning bundle is explicitly
-- `false` in locations.features (OR semantics across owning bundles;
-- back-compat missing/`{}` features = nothing denied). A key with NO
-- rows here (core/exempt in the JS layer) is never denied.
--
-- Closes TENANT.6's accepted gap #1: mobile's direct-Supabase RLS
-- (deals/notes/activities/bookings/whatsapp_* — every table mig 219
-- gates through auth_mobile_can) previously checked only the
-- fine-grained per-key toggle, with zero bundle awareness — a location
-- with e.g. bundle_sales:false but no explicit pipeline:false override
-- still passed RLS for direct mobile reads.
--
-- private.permission_key_bundles is a plain SEED table, not derived at
-- runtime — Postgres can't import shared/permission-bundles.js. Kept
-- in sync by scripts/generate-bundle-sql.mjs (regenerate + paste into a
-- NEW migration whenever KEY_BUNDLES changes — migrations are
-- forward-only, never hand-edit this seed in place: TRUNCATE + INSERT
-- fresh in the new migration instead) and guarded by
-- `npm run check:bundle-sql`, which fails CI the moment the two drift.
--
-- Seed content generated verbatim by: node scripts/generate-bundle-sql.mjs

CREATE TABLE IF NOT EXISTS private.permission_key_bundles (
  key text NOT NULL,
  bundle text NOT NULL,
  PRIMARY KEY (key, bundle)
);

-- Reseed from scratch on every migration that touches this table —
-- TRUNCATE + INSERT keeps each seed migration a self-contained full
-- replace (no merge-with-history logic needed) and keeps
-- check-bundle-sql.mjs's job simple: it only ever has to read the
-- LATEST seeding migration.
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

-- private.mobile_can_for (mig 218) is UNCHANGED — it still does the
-- fine-grained per-key `features -> perm_key` check plus the
-- role/per-user-toggle resolution. The bundle check is layered on top,
-- here, as an independent AND clause — same "both gates must pass"
-- shape as isFeatureEnabledAtLocation's `features[key] !== false &&
-- !bundlesDenyKey(...)` in shared/permissions.js.
CREATE OR REPLACE FUNCTION private.auth_mobile_can(loc_id uuid, perm_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.mobile_can_for((SELECT auth.uid()), loc_id, perm_key)
    AND (
      -- Not bundle-gated at all (no owning-bundle rows) = never denied.
      NOT EXISTS (
        SELECT 1 FROM private.permission_key_bundles pkb WHERE pkb.key = perm_key
      )
      OR
      -- OR semantics: allowed the moment AT LEAST ONE owning bundle is
      -- not explicitly false (missing/true = enabled, coalesce default
      -- true mirrors bundlesDenyKey's back-compat `{}` = everything on).
      EXISTS (
        SELECT 1 FROM private.permission_key_bundles pkb
        WHERE pkb.key = perm_key
          AND coalesce(
            (SELECT (features -> pkb.bundle) <> 'false'::jsonb FROM public.locations WHERE id = loc_id),
            true
          )
      )
    )
$$;
