-- 065 — SMS delivery tracking from Twilio status callbacks
--
-- Phase 5D. Mig 060 + Phase 2/2.5 only tracked send-time outcomes —
-- 'sent' (Twilio accepted) or 'failed' (Twilio rejected at submit).
-- Carrier-side delivery (the recipient's phone actually receiving
-- the message, OR the carrier reporting it undeliverable) is
-- communicated via a separate Twilio status callback POSTed to a
-- webhook URL we provide at send time.
--
-- This migration adds the columns the webhook updates plus the
-- per-broadcast aggregate counters the analytics UI shows. The
-- webhook itself lives at /api/webhooks/twilio/status.
--
-- Caveat: alpha sender IDs in IE/UK have unreliable carrier-side
-- DLRs. Many messages will stay in 'sent' state forever because
-- the carrier never sends a delivery receipt. The new counters
-- reflect what we hear back from carriers that DO report — they
-- under-count actual deliveries. This is a network limitation,
-- not a code one.

-- Extend the recipient status check to allow the post-send states.
alter table sms_broadcast_recipients
  drop constraint if exists sms_broadcast_recipients_status_check;
alter table sms_broadcast_recipients
  add constraint sms_broadcast_recipients_status_check
  check (status in ('pending', 'sent', 'delivered', 'undelivered', 'failed'));

alter table sms_broadcast_recipients
  add column if not exists delivered_at timestamptz,
  add column if not exists undelivered_at timestamptz;

comment on column sms_broadcast_recipients.delivered_at is
  'Stamped by /api/webhooks/twilio/status when Twilio reports MessageStatus=delivered. NULL when the carrier hasn''t reported (some IE/UK alpha-sender routes never report).';
comment on column sms_broadcast_recipients.undelivered_at is
  'Stamped by /api/webhooks/twilio/status when Twilio reports MessageStatus=undelivered (e.g. number unreachable, carrier rejection). error_message captures the cause.';

-- Per-broadcast aggregate counters. Mirror total_sent / total_failed.
alter table sms_broadcasts
  add column if not exists total_delivered int not null default 0,
  add column if not exists total_undelivered int not null default 0;

comment on column sms_broadcasts.total_delivered is
  'Cumulative count of recipients in the delivered state. Incremented atomically by the Twilio status webhook. Will under-count real deliveries on alpha-sender routes that don''t support DLRs.';
comment on column sms_broadcasts.total_undelivered is
  'Cumulative count of recipients in the undelivered state — Twilio reported the carrier could not deliver.';

-- Idempotent counter increment helper. The Twilio webhook may fire
-- multiple times for the same MessageSid (Twilio's docs explicitly
-- allow at-least-once delivery), so the webhook checks the previous
-- status before calling these. The functions themselves are minimal
-- atomic increments; the dedup logic lives in the webhook.
create or replace function increment_sms_broadcast_delivered(p_broadcast_id uuid)
returns void language sql as $$
  update sms_broadcasts set total_delivered = total_delivered + 1
   where id = p_broadcast_id;
$$;

create or replace function increment_sms_broadcast_undelivered(p_broadcast_id uuid)
returns void language sql as $$
  update sms_broadcasts set total_undelivered = total_undelivered + 1
   where id = p_broadcast_id;
$$;

-- Lock down the helpers — only service role / authenticated should
-- be able to call them, and even then only via the webhook path.
revoke all on function increment_sms_broadcast_delivered(uuid) from public;
revoke all on function increment_sms_broadcast_undelivered(uuid) from public;
grant execute on function increment_sms_broadcast_delivered(uuid) to service_role;
grant execute on function increment_sms_broadcast_undelivered(uuid) to service_role;
