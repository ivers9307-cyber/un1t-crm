-- 445: CONTRACTS-REMIND.1 — unsigned-contract reminder nudges.
-- Contracts issued to a recipient only ever got the single issue-time
-- email + push (mig 106) — nothing nudges them afterwards, so a contract
-- can sit at 'issued'/'viewed' forever. last_reminded_at / reminder_count
-- track a capped 2-reminder cadence driven by the new
-- /api/cron/contract-reminders cron; reminderDue() in src/lib/contracts.js
-- owns the actual due-predicate (3 days for reminder 1, 7 days for
-- reminder 2, then capped).

alter table public.contracts
  add column if not exists last_reminded_at timestamptz,
  add column if not exists reminder_count integer not null default 0;

comment on column public.contracts.last_reminded_at is
  'Timestamp of the most recent unsigned-contract reminder email/push sent by /api/cron/contract-reminders. Null = never reminded. (CONTRACTS-REMIND.1 mig 445)';
comment on column public.contracts.reminder_count is
  'How many reminders have been sent for this contract, capped at 2 by reminderDue() in src/lib/contracts.js. (CONTRACTS-REMIND.1 mig 445)';

-- Heartbeat — daily cron, generous grace (mirrors mig 441's pattern).
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
values ('contract-reminders', 86400, 43200, now())
on conflict (name) do nothing;
