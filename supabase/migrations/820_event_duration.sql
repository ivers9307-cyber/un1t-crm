-- 820 — CALENDAR.1: how long an event runs, for the calendar entry.
--
-- WHY. The "Add to calendar" links (the .ics route and the Google template
-- link in the confirmation and moved emails, on the confirmed page and the
-- public event page) need an end time; nothing stored one, and the old
-- client-side file guessed two hours for everything. See
-- docs/superpowers/specs/2026-11-08-host-event-features-design.md § 4.
--
-- WHAT. race_events.duration_minutes (5 min to a day), NULL = the default
-- (120 for a race, 60 for any other kind; src/lib/event-calendar-links.js
-- eventDurationMinutes). Set on the host and staff forms. Safe to apply
-- before the code deploys: nothing reads it until then.
--
-- grant: none needed — race_events has no client privilege (mig 682); the
-- server reads this column on the service role.

alter table public.race_events
  add column if not exists duration_minutes integer
  check (duration_minutes is null or (duration_minutes between 5 and 1440));

comment on column public.race_events.duration_minutes is
  'CALENDAR.1 (mig 820): how long a session runs, in minutes; NULL = 120 for a race, 60 otherwise (eventDurationMinutes).';
