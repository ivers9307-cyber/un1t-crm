-- 063 — SMS as a per-event single-shot reminder channel
--
-- Phase 4 of the SMS rollout. Mig 044 introduced reminder_enabled +
-- reminder_minutes_before + reminder_channel ('email' | 'whatsapp')
-- on event_types — the simple "send a single message N minutes
-- before each booking starts" path that doesn't require an operator
-- to author a sequence.
--
-- This migration:
--   1. Drops the reminder_channel_check constraint and re-creates
--      it with 'sms' added to the allowed values.
--   2. Adds event_types.reminder_sms_body — freeform text body
--      (with merge tags) for the SMS path. Mirrors the broadcast
--      and ad-hoc 1600-char cap so a misconfigured body can't fan
--      out into a huge multi-segment send.
--   3. Adds contact_preferences.sms_administrative BOOLEAN DEFAULT
--      TRUE — the admin-consent toggle for transactional SMS,
--      mirroring email_administrative + whatsapp_administrative.
--      A user can opt out of administrative SMS (booking reminders,
--      receipts) without affecting marketing SMS opt-in/out, and
--      vice versa.

-- Drop the old check + recreate. The "if exists" pattern is robust
-- across re-runs.
alter table event_types drop constraint if exists reminder_channel_check;
alter table event_types add constraint reminder_channel_check
  check (reminder_channel is null or reminder_channel in ('email', 'whatsapp', 'sms'));

alter table event_types
  add column if not exists reminder_sms_body text
    check (reminder_sms_body is null or char_length(reminder_sms_body) between 1 and 1600);

comment on column event_types.reminder_sms_body is
  'For reminder_channel=sms — freeform message body sent via Twilio. Merge tags apply: {{first_name}}, {{name}}, {{event_name}}, {{event_time}}, {{location_name}}. NULL when the channel is not sms.';

alter table contact_preferences
  add column if not exists sms_administrative boolean not null default true;

comment on column contact_preferences.sms_administrative is
  'Admin-consent toggle for transactional SMS (booking reminders, receipts, etc.). Mirrors email_administrative + whatsapp_administrative. Marketing-vs-administrative split lets a contact opt out of one without affecting the other. Defaults TRUE — same as email/whatsapp.';
