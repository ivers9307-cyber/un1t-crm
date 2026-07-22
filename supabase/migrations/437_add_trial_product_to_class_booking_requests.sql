-- Per-funnel trial product override, captured at booking time from the
-- class_funnel landing-page block. NULL ⇒ use the location default
-- (locations.settings.glofox.trial_membership_id / trial_plan_code).
-- Both columns must be set for the override to apply.
alter table public.class_booking_requests
  add column if not exists trial_membership_id text,
  add column if not exists trial_plan_code text;

comment on column public.class_booking_requests.trial_membership_id is
  'Optional per-funnel trial product override captured at booking time from the class_funnel block; NULL means use the location default (locations.settings.glofox).';
comment on column public.class_booking_requests.trial_plan_code is
  'Plan code paired with trial_membership_id. Both must be set to override.';
