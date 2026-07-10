-- 397_wa_bsuid_capture.sql
-- WA-BSUID.1 — capture-only columns for Meta's Business-Scoped User IDs.
--
-- Meta is rolling out WhatsApp usernames + BSUIDs: users will be able to
-- hide their phone number, and webhooks will then carry a business-scoped
-- id (surfaced as `user_id` on the webhook contacts[] entry) instead. All
-- CRM identity is phone-keyed today (contacts.wa_phone, conversations
-- unique on (location_id, wa_phone)) — these columns bank the anchor NOW so
-- threading and consent history survive the rollout reaching Ireland.
--
-- CAPTURE ONLY: no matching/dedupe/auth/consent logic reads these yet.
--
-- Uniqueness is scoped per location, not global: a BSUID identifies one
-- user per business, but multi-gym members legitimately have one contact
-- row (and one conversation) PER location for the same person — a global
-- unique index would reject the second location's capture. Within a
-- location, one BSUID = one contact = one conversation.

alter table contacts add column if not exists wa_bsuid text;
comment on column contacts.wa_bsuid is
  'Meta Business-Scoped User ID (BSUID) captured from inbound WhatsApp webhooks (contacts[].user_id). Capture-only (mig 397) — identity resolution still keys on phone. Never overwritten once set; a differing inbound value is logged as a collision signal.';

create unique index if not exists contacts_location_wa_bsuid_key
  on contacts (location_id, wa_bsuid)
  where wa_bsuid is not null;

alter table whatsapp_conversations add column if not exists wa_bsuid text;
comment on column whatsapp_conversations.wa_bsuid is
  'Meta Business-Scoped User ID (BSUID) captured from inbound WhatsApp webhooks (contacts[].user_id). Capture-only (mig 397) — threading still keys on (location_id, wa_phone). Never overwritten once set.';

create unique index if not exists whatsapp_conversations_location_wa_bsuid_key
  on whatsapp_conversations (location_id, wa_bsuid)
  where wa_bsuid is not null;
