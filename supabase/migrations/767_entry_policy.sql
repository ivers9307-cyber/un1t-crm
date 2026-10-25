-- ENTRYPOLICY.1 — the per-event entry policy for race events.
--
-- race_events.entry_policy holds the customer self-service switches, the
-- hours-before cutoff and the hold an unpaid entry has on its place:
--   { self_cancel_enabled, self_reschedule_enabled, cutoff_hours,
--     unpaid_hold_hours, cutoff_message, disabled_message, lapsed_message }
-- validated by Zod on write (src/lib/entry-policy.js); null means the
-- defaults (both switches on, a 48 h cutoff before the entrant's start, a
-- 48 h hold for an unpaid entry). Nothing here deletes a row: a lapsed unpaid
-- entry simply stops counting toward capacity (holdsPlace, judged in JS).
--
-- race_events has no client privilege (mig 682); this migration grants
-- nothing to anon or authenticated. Every read and write is a service-role
-- route (POST /api/events, PUT /api/events/[id], the public entry and
-- register routes, Mia's event tools).
--
-- Applied via Supabase MCP against iyvtbjjxdggiadzwwvdj BEFORE the code deploys.

-- column-grant: withheld race_events.entry_policy
alter table public.race_events
  add column if not exists entry_policy jsonb;

comment on column public.race_events.entry_policy is 'ENTRYPOLICY.1: per-event entry policy { self_cancel_enabled, self_reschedule_enabled, cutoff_hours (0..720, 0 = none), unpaid_hold_hours (1..720), cutoff_message, disabled_message, lapsed_message } (validated by Zod on write); null means the defaults (both switches on, 48 h cutoff, 48 h unpaid hold).';
