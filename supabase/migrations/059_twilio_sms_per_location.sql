-- 059 — per-location Twilio alpha sender ID + contacts.sms_status
--
-- Twilio SMS was already plumbed in for the car-deposit transactional
-- flow (src/lib/twilio.js), using a single TWILIO_FROM env var
-- (defaulting to 'CCFautos') as the sender on every message. With
-- multi-location SMS marketing now in scope, each studio needs its
-- own branded alpha sender ID — recipients see "UN1T" or "UN1T HATCH"
-- in the From slot, not the same global value.
--
-- This migration:
--   1. adds locations.twilio_alpha_sender_id (nullable text, max 11
--      alphanumeric chars per Twilio carrier rules — enforced in the
--      app validate path).
--   2. adds contacts.sms_status mirroring wa_status — drives the
--      "can we send to this contact" gate at every send site (ad-hoc,
--      broadcast, sequence, automation). Default 'active'; flipped
--      to 'opted_out' when the contact opts out.
--   3. backfills CCF Autos's sender ID to 'CCFautos' so the existing
--      deposit flow keeps working AFTER src/lib/twilio.js switches
--      to per-location resolution. UN1T locations stay null until
--      an admin sets one in Location Settings.
--
-- Rollback: drop the columns. The deposit flow continues to work
-- because src/lib/twilio.js falls back to TWILIO_FROM env when the
-- per-location field is null.

alter table locations
  add column if not exists twilio_alpha_sender_id text;

comment on column locations.twilio_alpha_sender_id is
  'Per-location alphanumeric SMS sender ID shown on recipients phones. Max 11 alphanumeric chars (Twilio carrier limit). NULL means "fall back to TWILIO_FROM env" — used as the safety net for the existing transactional flows.';

alter table contacts
  add column if not exists sms_status text not null default 'active';

comment on column contacts.sms_status is
  'SMS deliverability + consent status. Mirrors wa_status. Values: active (default, send freely), opted_out (recipient replied STOP or admin manually opted out), invalid (Twilio reported the number unreachable). Send-side helpers must reject opted_out / invalid.';

-- Backfill CCF Autos with the existing global default so the deposit
-- flow keeps issuing links from the same sender after the lib switch.
update locations
   set twilio_alpha_sender_id = 'CCFautos'
 where name = 'CCF Autos'
   and twilio_alpha_sender_id is null;

-- Index sms_status when we add audience filters that read it (cheap
-- to add now while the table is still small).
create index if not exists contacts_sms_status_idx
  on contacts (sms_status)
  where sms_status <> 'active';
