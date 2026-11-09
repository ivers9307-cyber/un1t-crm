-- 825 — WAVEWIN.2: how many start times a race offers at once, per event.
--
-- WHY. The public wave picker (WAVEWIN.1, src/lib/wave-window.js) offers only
-- the waves inside a release window that starts at the earliest wave with
-- space, so a long race day fills from the front instead of scattering. The
-- window was one constant, 90 minutes, for every event: with 45-minute waves
-- that is three start times on offer, and an operator who wants more of the
-- day open from the first signup had no way to say so.
--
-- WHAT. race_events.wave_window_minutes (15 min to a whole day), NULL = the
-- default (90; resolveWaveWindowMinutes). 1440 covers any same-day schedule,
-- so it is "every start time at once". Set on the staff event form (race kind
-- only; host events and non-race kinds never used the window). Safe to apply
-- before the code deploys: nothing reads it until then.
--
-- Display-only, as before: the register route accepts any wave of the event.
--
-- grant: none needed — race_events has no client privilege (mig 682); the
-- server reads this column on the service role.

alter table public.race_events
  add column if not exists wave_window_minutes integer
  check (wave_window_minutes is null or (wave_window_minutes between 15 and 1440));

comment on column public.race_events.wave_window_minutes is
  'WAVEWIN.2 (mig 825): the public wave picker''s release window in minutes, from the earliest wave with space; NULL = 90 (resolveWaveWindowMinutes), 1440 = every start time at once.';
