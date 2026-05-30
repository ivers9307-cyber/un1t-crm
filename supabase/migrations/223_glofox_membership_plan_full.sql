-- 223_glofox_membership_plan_full.sql
-- GLOFOX-PLANNAME.1 — store the full Glofox catalog plan name alongside
-- the clean canonical one.
--
-- Glofox exposes a membership under two names on /2.0/members/:id:
--   membership.membership_plan_name / .plan_name  — canonical, clean
--       e.g. "Month to Month Membership"  (groups plans together)
--   membership.membership_name                    — operator catalog name,
--       carries the promo/discount + a "N) " sort prefix
--       e.g. "3) The Monthly Membership (€99 FIRST MONTH)"
--
-- contacts.glofox_membership_plan already holds the clean name. This
-- adds the catalog name (sort-prefix stripped) so the profile can show
-- BOTH — clean as the headline, catalog as the promo subtitle — letting
-- the operator see what deal a member is actually on.
--
-- Additive + nullable; backfilled by the existing detail sync write-path
-- (applyMemberSync) on each member's next pull. No data migration.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS glofox_membership_plan_full text;

COMMENT ON COLUMN contacts.glofox_membership_plan_full IS
  'Full Glofox catalog plan name (membership.membership_name), "N) " sort '
  'prefix stripped, carries promo/discount context. Companion to the clean '
  'glofox_membership_plan. Written by applyMemberSync. GLOFOX-PLANNAME.1.';
