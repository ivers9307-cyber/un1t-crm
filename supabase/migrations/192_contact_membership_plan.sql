-- CHURN-PREP.2 — store each member's current Glofox membership plan.
--
-- The Glofox sync already knows a contact's membership *status*
-- (member / credit_member / trial / lead / ...) but not *which*
-- product they actually hold. This column captures the human-readable
-- plan name — "Month to Month Membership", "3 Month Membership",
-- "10 Class Pack" — so operators can see it on the contact profile
-- and segments / churn analysis can split on the real membership.
--
-- Sourced from the Glofox single-member payload's
-- membership.membership_plan_name (the /2.0/members LIST and
-- /2.0/bookings payloads don't carry it). Populated + kept fresh by
-- the glofox-attendance-refresh cron, which already walks the whole
-- paying-member base nightly. Null for contacts with no membership
-- applied (leads / PAYG).

alter table public.contacts
  add column if not exists glofox_membership_plan text;

comment on column public.contacts.glofox_membership_plan is
  'Current Glofox membership plan name (e.g. "3 Month Membership", "10 Class Pack"). Null when no membership is applied. Synced by the glofox-attendance-refresh cron.';
