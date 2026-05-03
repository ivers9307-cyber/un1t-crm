-- 076 — Calendly multi-reminder support.
--
-- Three product asks bundled:
--   1. Multiple reminders per event type (24h + 2h + day-of)
--   2. Per-reminder channel = email + sms (or both, in one go)
--   3. Hours instead of minutes in the operator UI (UI-only —
--      we still store minutes for partial-index compatibility
--      and the runner's tolerance maths)
--
-- Schema implications:
--   - event_types' single `reminder_*` columns can't model
--     "send a 24h email AND a 2h SMS" without major contortion.
--     New table: event_type_reminders, 1..N rows per event_type.
--   - bookings.reminder_sent_at can't tell which reminder fired
--     when there are multiple per event. New table:
--     booking_reminder_sends, n:m booking × reminder with the
--     send timestamp and per-channel outcome.
--
-- Backward compatibility:
--   - event_types.reminder_* columns are kept on disk but no
--     longer read by the runner. Backfill copies their values
--     into event_type_reminders rows. Phase 5 cleanup migration
--     can drop them once we're confident.
--   - bookings.reminder_sent_at also kept for now — denormalised
--     "any reminder fired for this booking" flag, useful for the
--     legacy partial index until we re-tune the runner's query
--     against the join table.
--
-- RLS: in-location read, manager-write — same pattern as the
-- shift_blocks tables (mig 067).

-- ============================================================
-- 1. event_type_reminders
-- ============================================================
create table if not exists public.event_type_reminders (
  id uuid primary key default gen_random_uuid(),
  event_type_id uuid not null references public.event_types(id) on delete cascade,

  -- When to fire, expressed in minutes (the runner's existing
  -- tolerance window is in milliseconds, partial index is on
  -- minutes-derived dates — keeping the unit avoids retuning
  -- both). UI converts hours → minutes on save.
  minutes_before int not null check (minutes_before >= 0 and minutes_before <= 60 * 24 * 30),

  -- Which channels to fire. Email-only, SMS-only, or both.
  -- WhatsApp deliberately excluded (mig 074 policy).
  channels text[] not null
    check (channels <@ array['email','sms']::text[] and array_length(channels, 1) >= 1),

  -- Email reminder config (used when 'email' is in channels).
  email_template_id uuid references public.email_templates(id),
  email_subject text,

  -- SMS reminder config (used when 'sms' is in channels).
  sms_body text,

  -- Operator-facing ordering (display only — runner doesn't care).
  display_order int not null default 0,

  -- Soft-delete flag. Disabling preserves the row for audit but
  -- the runner skips it.
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_type_reminders_event_type_idx
  on public.event_type_reminders (event_type_id) where active = true;

drop trigger if exists set_event_type_reminders_updated_at on public.event_type_reminders;
create trigger set_event_type_reminders_updated_at
  before update on public.event_type_reminders
  for each row execute function update_updated_at();

comment on table public.event_type_reminders is
  'Multi-reminder support (mig 076). Multiple reminders per event_type, each with its own channels[], offset, and template/body. Replaces the single-reminder columns on event_types (kept for backward-compat, no longer read).';

-- ============================================================
-- 2. booking_reminder_sends
-- ============================================================
create table if not exists public.booking_reminder_sends (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  reminder_id uuid not null references public.event_type_reminders(id) on delete cascade,

  -- Outcome of this (booking, reminder) attempt.
  status text not null check (status in ('sent', 'skipped', 'failed')),
  -- Which channels actually went out — subset of the reminder's
  -- channels[]. Useful for partial-success cases (email sent,
  -- SMS bounced).
  channels_sent text[] not null default '{}',
  -- Free-text reason. For 'skipped': 'opted_out_administrative_email',
  -- 'no_phone_number', 'sms_status=opted_out', etc. For 'failed':
  -- the underlying error message.
  reason text,

  sent_at timestamptz not null default now(),

  unique (booking_id, reminder_id)
);

create index if not exists booking_reminder_sends_booking_idx
  on public.booking_reminder_sends (booking_id);
create index if not exists booking_reminder_sends_reminder_idx
  on public.booking_reminder_sends (reminder_id);

comment on table public.booking_reminder_sends is
  'Per-(booking, reminder) send dedup + audit. Replaces the single bookings.reminder_sent_at column for per-reminder tracking. UNIQUE(booking_id, reminder_id) prevents the runner from double-firing the same reminder if a tick takes longer than 5 minutes.';

-- ============================================================
-- 3. RLS — mirror event_types policies via the per-location helpers.
-- ============================================================
alter table public.event_type_reminders enable row level security;
alter table public.booking_reminder_sends enable row level security;

drop policy if exists "event_type_reminders readable in-location" on public.event_type_reminders;
create policy "event_type_reminders readable in-location"
  on public.event_type_reminders for select to authenticated
  using (
    private.auth_is_master()
    or exists (
      select 1 from public.event_types et
       where et.id = event_type_reminders.event_type_id
         and private.auth_is_in_location(et.location_id)
    )
  );

drop policy if exists "event_type_reminders managers can write" on public.event_type_reminders;
create policy "event_type_reminders managers can write"
  on public.event_type_reminders for all to authenticated
  using (
    private.auth_is_master()
    or exists (
      select 1 from public.event_types et
       where et.id = event_type_reminders.event_type_id
         and private.auth_is_manager_at(et.location_id)
    )
  )
  with check (
    private.auth_is_master()
    or exists (
      select 1 from public.event_types et
       where et.id = event_type_reminders.event_type_id
         and private.auth_is_manager_at(et.location_id)
    )
  );

drop policy if exists "Service role full access" on public.event_type_reminders;
create policy "Service role full access" on public.event_type_reminders
  for all using (true) with check (true);

drop policy if exists "booking_reminder_sends readable" on public.booking_reminder_sends;
create policy "booking_reminder_sends readable"
  on public.booking_reminder_sends for select to authenticated
  using (
    private.auth_is_master()
    or exists (
      select 1 from public.bookings b
       where b.id = booking_reminder_sends.booking_id
         and private.auth_is_in_location(b.location_id)
    )
  );

drop policy if exists "Service role full access" on public.booking_reminder_sends;
create policy "Service role full access" on public.booking_reminder_sends
  for all using (true) with check (true);

-- ============================================================
-- 4. Backfill — copy each active event_type's reminder_* fields
-- into a row in event_type_reminders.
-- ============================================================
insert into public.event_type_reminders (
  event_type_id, minutes_before, channels,
  email_template_id, email_subject, sms_body,
  display_order, active
)
select
  et.id,
  coalesce(et.reminder_minutes_before, 1440),
  array[et.reminder_channel]::text[],
  et.reminder_email_template_id,
  et.reminder_email_subject,
  et.reminder_sms_body,
  0,
  true
from public.event_types et
where et.reminder_enabled = true
  and et.reminder_channel in ('email', 'sms')
  -- Don't double-backfill if this migration is re-run (idempotent).
  and not exists (
    select 1 from public.event_type_reminders r
     where r.event_type_id = et.id
  );

-- For existing bookings that already had a reminder fired, log
-- a corresponding booking_reminder_sends row pointing at the
-- (single) backfilled reminder so the runner doesn't re-send.
insert into public.booking_reminder_sends (
  booking_id, reminder_id, status, channels_sent, sent_at
)
select
  b.id,
  r.id,
  'sent',
  r.channels,
  b.reminder_sent_at
from public.bookings b
join public.event_type_reminders r on r.event_type_id = b.event_type_id
where b.reminder_sent_at is not null
  and not exists (
    select 1 from public.booking_reminder_sends s
     where s.booking_id = b.id and s.reminder_id = r.id
  );

-- ============================================================
-- 5. Mark legacy columns deprecated.
-- ============================================================
comment on column public.event_types.reminder_enabled is
  'DEPRECATED (mig 076). Use event_type_reminders.active instead. Kept for backward-compat; runner no longer reads.';
comment on column public.event_types.reminder_minutes_before is
  'DEPRECATED (mig 076). Use event_type_reminders.minutes_before.';
comment on column public.event_types.reminder_channel is
  'DEPRECATED (mig 076). Use event_type_reminders.channels[].';
comment on column public.event_types.reminder_email_template_id is
  'DEPRECATED (mig 076). Use event_type_reminders.email_template_id.';
comment on column public.event_types.reminder_email_subject is
  'DEPRECATED (mig 076). Use event_type_reminders.email_subject.';
comment on column public.event_types.reminder_sms_body is
  'DEPRECATED (mig 076). Use event_type_reminders.sms_body.';
