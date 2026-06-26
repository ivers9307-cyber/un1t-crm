-- 315 — Webhook dead-letter capture + cron "ran but did nothing" outcome (P1-12 Phase 1).
-- Captures a webhook event that 200'd the provider but failed to PROCESS, so it
-- is recorded (not silently lost) and visible, instead of quietly going stale.
-- Replay is a deliberate Phase 2 (needs a per-provider idempotency pass).

create table if not exists public.webhook_dead_letter (
  id              bigserial primary key,
  provider        text not null,                 -- 'glofox' | 'inbody' | 'postmark' | ...
  event_type      text,                          -- provider's event name, for triage
  payload         jsonb not null,                -- the raw body, verbatim, for replay
  error           text,                          -- failure message
  attempts        int not null default 1,
  status          text not null default 'pending'
                    check (status in ('pending','resolved','failed','discarded')),
  received_at     timestamptz not null default now(),
  last_attempt_at timestamptz,
  resolved_at     timestamptz,
  location_id     uuid
);

create index if not exists idx_webhook_dead_letter_pending
  on public.webhook_dead_letter (received_at) where status = 'pending';
create index if not exists idx_webhook_dead_letter_provider
  on public.webhook_dead_letter (provider, status);

alter table public.webhook_dead_letter enable row level security;
-- Service-role only (webhook handlers + admin routes run as service role). No
-- operator-facing direct read; the admin API surfaces it.
create policy webhook_dead_letter_service_role on public.webhook_dead_letter
  to service_role using (true) with check (true);

-- "ran but did nothing" visibility: a summary of the last run's work, so a cron
-- that runs and correctly idles is distinguishable from one that runs but is
-- silently broken. Nullable + additive — stampHeartbeat keeps working unchanged.
alter table public.cron_heartbeats add column if not exists last_outcome jsonb;
comment on column public.cron_heartbeats.last_outcome is
  'Summary of the last run''s work (e.g. {"processed":5,"skipped":0,"deadLettered":1}) — distinguishes "ran and idle" from "ran but broken". Written by stampHeartbeat(name, outcome).';
