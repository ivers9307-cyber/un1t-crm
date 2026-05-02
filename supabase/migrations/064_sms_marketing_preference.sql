-- 064 — contact_preferences: sms_marketing
--
-- Phase 5 of the SMS rollout. Mig 005 introduced contact_preferences
-- with email_marketing + whatsapp_marketing + their _administrative
-- counterparts; mig 063 added sms_administrative. This migration
-- finishes the table by adding the marketing-side flag for SMS so
-- broadcast audiences can honour an opt-out.
--
-- Defaults TRUE — same as email_marketing + whatsapp_marketing —
-- so existing contacts are opted in until they explicitly
-- unsubscribe. New contacts created via the trigger in mig 005 also
-- get TRUE because the column DEFAULT applies on INSERT.
--
-- Audience builders consume this via the contact_preferences inner
-- join in src/lib/sms.js#buildSmsAudience (added in the same
-- changeset as this migration).

alter table contact_preferences
  add column if not exists sms_marketing boolean not null default true;

comment on column contact_preferences.sms_marketing is
  'Marketing opt-in for SMS — broadcasts and any other promotional SMS surface should honour this. Mirrors email_marketing + whatsapp_marketing. Administrative SMS (booking reminders, deposit links) is gated by sms_administrative instead, so a contact can opt out of marketing without losing booking confirmations.';
