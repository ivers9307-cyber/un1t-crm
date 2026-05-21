-- 196_contact_glofox_profile.sql
--
-- GLOFOX-PROFILE — capture the rest of the useful member profile
-- data Glofox already returns in the single-member payload we fetch
-- nightly. Until now the attendance-refresh cron only pulled the
-- membership plan + state; this widens it to renewal/billing detail
-- and the remaining profile attributes, for the churn radar, the
-- contact profile and campaign filtering.
--
-- Consent and waiver are deliberately NOT here — those are tracked
-- separately. Credit-pack balance is also absent: the member API
-- doesn't expose a remaining-credits count (it lives on a separate
-- Glofox surface) — a follow-up if needed.
--
-- All columns are nullable + populated by glofox-attendance-refresh.

alter table public.contacts
  add column if not exists glofox_membership_expiry      timestamptz,
  add column if not exists glofox_membership_price_cents integer,
  add column if not exists glofox_billing_interval       text,
  add column if not exists glofox_payment_method         text,
  add column if not exists glofox_membership_type        text,
  add column if not exists glofox_image_url              text,
  add column if not exists gender                        text,
  add column if not exists emergency_contact             text,
  add column if not exists glofox_signup_answers         jsonb,
  add column if not exists glofox_roaming_enabled        boolean,
  add column if not exists glofox_account_active         boolean,
  add column if not exists glofox_source                 text;

comment on column public.contacts.glofox_membership_expiry is
  'Membership renewal / expiry date (member.membership.expiry_date). The renewal cliff — drives the churn radar Renewal-cliff signal.';
comment on column public.contacts.glofox_membership_price_cents is
  'Effective membership price in cents — subscription.price, else catalog plan_price. Enables revenue-weighted churn.';
comment on column public.contacts.glofox_billing_interval is
  'Human-readable billing cadence, e.g. "6 months" / "1 month".';
comment on column public.contacts.glofox_membership_type is
  'Glofox membership type — time (subscription) / num_classes (class pack) / payg.';
comment on column public.contacts.glofox_signup_answers is
  'Sign-up form answers array from the Glofox member payload (goals, referral source, etc.).';
