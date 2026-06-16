-- 277_glofox_push_events_automation_source.sql
-- Allow source='automation' on glofox_push_events so the new
-- lead-provisioning automation's audit rows (created/needs_review/
-- failed) actually insert and show in the Review queue. Without this,
-- the CHECK silently rejected them (audit() swallows the error) and
-- the operator would never see automation-driven Glofox failures.
-- Additive widening of the allowed set — no data rewrite.
alter table public.glofox_push_events
  drop constraint glofox_push_events_source_check;

alter table public.glofox_push_events
  add constraint glofox_push_events_source_check
  check (source = any (array[
    'booking_form', 'event_registration', 'manual_button',
    'dup_check', 'cron', 'automation'
  ]));
