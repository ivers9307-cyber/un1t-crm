-- 548 — backfill the 8 bundle keys onto pre-bundle plan_versions rows.
--
-- WHY
-- ───
-- BUNDLES.5 (mig none — locations.features is the sink, plan_versions.features
-- is the source) added 8 new boolean keys to plan_versions.features:
-- bundle_messaging, bundle_sales, bundle_members, bundle_money,
-- bundle_marketing, bundle_team, bundle_operations, module_cars
-- (shared/permission-bundles.js BUNDLE_KEYS, mirrored into shared/plans.js
-- FEATURE_KEYS). Every plan_versions row created BEFORE that ship (mig 413's
-- seed, and anything a master added through /admin/plans before BUNDLES.5)
-- has a features blob with none of the 8 keys.
--
-- applyPlanBundlesToLocation() (src/lib/plans.js), the write path a plan pin
-- triggers, treats "key absent from a pinned version's features" as
-- WITHHELD, not "not this plan's business" — mirrorBundleFeatures grants a
-- bundle only when the resolved plan features says `=== true`; anything
-- else (absent OR explicitly false) writes locations.features[bundle_x] =
-- false. So pinning an unbackfilled version denies EVERY bundle at once —
-- the whole CRM goes dark for that location — even though every one of
-- these plans was sold and priced as "everything on" before bundles
-- existed. That is the BUNDLES.5 final-review latent note this migration
-- closes: absent must mean "grant" for these historical rows, not "deny".
--
-- WHAT
-- ────
-- For every plan_versions row whose features is missing ANY of the 8
-- bundle keys, merge in `true` for each MISSING key only — a key the row
-- ALREADY carries (true or false, e.g. a master who deliberately toggled
-- one off through the admin UI after BUNDLES.5 shipped) is left exactly as
-- it is. `defaults || features` (not `features || defaults`) is what makes
-- that true: jsonb `||` concatenation lets the RIGHT operand's keys win on
-- overlap, so the existing feature blob must be the right-hand side.
--
-- The known `jsonb_set` no-op trap does NOT apply here: that trap is
-- specific to `jsonb_set()` failing to CREATE a missing *nested* parent
-- path (e.g. settings->inbody->accounts when settings has no "inbody"
-- key yet — see the supabase-migrations-via-mcp lesson). This migration
-- doesn't use jsonb_set at all; it's a flat, single-level `||` concat
-- directly on the top-level features column, so there's no nested path
-- for a create_missing flag to matter to.
--
-- WHERE clause uses the `?&` "has all keys" jsonb operator: a row is
-- touched only when it's missing at least one of the 8 keys, so a second
-- run of this migration finds nothing left to do — idempotent.

UPDATE public.plan_versions
SET features = jsonb_build_object(
  'bundle_messaging',  true,
  'bundle_sales',      true,
  'bundle_members',    true,
  'bundle_money',      true,
  'bundle_marketing',  true,
  'bundle_team',       true,
  'bundle_operations', true,
  'module_cars',       true
) || coalesce(features, '{}'::jsonb)
WHERE NOT (
  coalesce(features, '{}'::jsonb) ?& array[
    'bundle_messaging', 'bundle_sales', 'bundle_members', 'bundle_money',
    'bundle_marketing', 'bundle_team', 'bundle_operations', 'module_cars'
  ]
);

COMMENT ON COLUMN public.plan_versions.features IS
  'Boolean feature flags keyed by shared/plans.js FEATURE_KEYS (ai_agent, custom_email_domain, plus the 8 bundle_*/module_cars keys — shared/permission-bundles.js BUNDLE_KEYS). Structure lives in code; inclusion per tier lives here. Mig 548 backfilled the 8 bundle keys to true on every pre-bundle row (absent bundle key on plan_versions.features means WITHHELD, so an unbackfilled version denies everything on pin — see mig 548 for the full story). New rows should set all 8 explicitly; the admin plan-version editor (src/app/api/admin/plans/[id]/versions/route.js) already validates every FEATURE_KEYS entry.';
