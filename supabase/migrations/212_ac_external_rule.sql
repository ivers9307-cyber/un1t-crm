-- STUDIO-AC-EXTERNAL-RULE.1 — auto-off rule for AC units started
-- outside the CRM (LG remote, Sensibo app, wall panel, vendor
-- schedule). Without this, an externally-started unit runs forever
-- because the existing auto-off cron only sweeps ac_sessions.
--
-- Two pieces:
--   1. ac_devices.external_auto_off_minutes — per-device cap.
--      NULL = no rule for this unit. Backfilled to each row's
--      existing session_minutes so the rule is on by default for
--      every device (per the "All units" answer in the design
--      conversation); master can NULL it from the settings tab to
--      opt out per device.
--   2. ac_external_starts — separate from ac_sessions so the panel
--      and audit trail don't pretend a staff member started it.
--      Row is upserted by the cron when it detects vendor_on +
--      no-session, and deleted when the unit goes off, when a
--      real session takes over, or after the cron fires.
--
-- Applied via Supabase MCP before merging the code that depends
-- on the new schema.

alter table public.ac_devices
  add column if not exists external_auto_off_minutes int;

comment on column public.ac_devices.external_auto_off_minutes is
  'STUDIO-AC-EXTERNAL-RULE.1 — minutes the unit may run before the '
  'cron auto-offs it when started externally (LG remote, Sensibo '
  'app, wall panel). NULL = no rule. Default backfill: same as '
  'session_minutes. Master-editable per device from the AC Devices '
  'settings tab.';

-- Backfill: copy session_minutes onto the new column for every
-- existing row, so the rule kicks in by default. session_minutes
-- has a NOT NULL constraint with a 30-min default (mig 210), so
-- the coalesce is belt-and-braces.
update public.ac_devices
   set external_auto_off_minutes = coalesce(session_minutes, 30)
 where external_auto_off_minutes is null;

create table if not exists public.ac_external_starts (
  device_id       uuid primary key references public.ac_devices(id) on delete cascade,
  first_seen_at   timestamptz not null default now(),
  expected_off_at timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.ac_external_starts is
  'STUDIO-AC-EXTERNAL-RULE.1 — tracks AC devices observed running '
  'without a CRM session row. The ac-external-rule cron upserts on '
  'detection and deletes when (a) vendor reports off, (b) a real '
  'session takes over, or (c) the cron has fired the auto-off. '
  'Separate from ac_sessions so the audit trail and panel UI do '
  'not pretend a staff member started the unit.';

-- Index for the cron sweep — small table (one row per externally-
-- running device, across the whole org) but the sweep is the hot
-- path so an index on expected_off_at is the obvious play.
create index if not exists ac_external_starts_expected_off_idx
  on public.ac_external_starts (expected_off_at);

-- RLS: service-role only. Staff never read or write this table
-- directly; the cron + the GET route (which uses the server
-- client) are the only callers. Mirror the locked-down posture
-- used by ac_sessions (no policies → service-role only).
alter table public.ac_external_starts enable row level security;
