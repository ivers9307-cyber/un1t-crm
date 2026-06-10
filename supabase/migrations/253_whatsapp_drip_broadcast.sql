-- 253_whatsapp_drip_broadcast.sql
-- WhatsApp drip broadcast (WA-DRIP). Adds paced delivery to whatsapp_broadcasts,
-- the dedup/resume key on recipients, and the cron heartbeat row.

-- 1. Pacing columns. delivery_mode defaults to 'blast' so every existing row and
--    the all-at-once sendBroadcast path are completely unchanged.
alter table public.whatsapp_broadcasts
  add column if not exists delivery_mode     text        not null default 'blast',
  add column if not exists daily_cap         integer     not null default 500,
  add column if not exists send_window_start time        not null default '09:00',
  add column if not exists send_window_end   time        not null default '20:00',
  add column if not exists send_window_tz    text        not null default 'Europe/Dublin',
  add column if not exists paused_at         timestamptz;

alter table public.whatsapp_broadcasts
  drop constraint if exists whatsapp_broadcasts_delivery_mode_chk;
alter table public.whatsapp_broadcasts
  add  constraint whatsapp_broadcasts_delivery_mode_chk
  check (delivery_mode in ('blast', 'drip'));

alter table public.whatsapp_broadcasts
  drop constraint if exists whatsapp_broadcasts_daily_cap_chk;
alter table public.whatsapp_broadcasts
  add  constraint whatsapp_broadcasts_daily_cap_chk
  check (daily_cap > 0);

-- 2. Dedup any pre-existing duplicate (broadcast_id, contact_id) rows (keep the
--    earliest by ctid), THEN add the unique constraint the drip resume +
--    idempotency relies on. The blast sender never resumed, so it never needed
--    this; the drip does (cron retries must never double-send).
delete from public.whatsapp_broadcast_recipients a
using public.whatsapp_broadcast_recipients b
where a.broadcast_id = b.broadcast_id
  and a.contact_id   = b.contact_id
  and a.contact_id is not null
  and a.ctid > b.ctid;

alter table public.whatsapp_broadcast_recipients
  drop constraint if exists whatsapp_broadcast_recipients_broadcast_contact_uniq;
alter table public.whatsapp_broadcast_recipients
  add  constraint whatsapp_broadcast_recipients_broadcast_contact_uniq
  unique (broadcast_id, contact_id);

-- 3. Cron heartbeat row so /api/cron/health-check tracks the new runner. Runs
--    every 15 min (900s). Generous grace: a tick fired outside the send window is
--    a no-op but STILL stamps the heartbeat, so freshness is bounded by 900+grace.
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
values ('run-whatsapp-broadcasts', 900, 300, 'WhatsApp drip broadcast paced sender (WA-DRIP)')
on conflict (name) do nothing;
