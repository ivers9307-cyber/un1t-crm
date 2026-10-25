-- 757 — TRIALDONE.7: a heartbeat row of its own for the trial-done outreach
-- arm (src/lib/agent/trial-done-runner.js runTrialDoneOutreach) of the */15
-- Vercel cron /api/cron/agent-followups. No route or vercel.json entry of its
-- own.
--
-- WHY. The arm rides agent-followups' schedule, and that row is stamped
-- whatever the arm did. /api/cron/health-check reads only cron_health.is_stale
-- (mig 053), never last_outcome, so an arm failing on every tick would page
-- nobody while trial finishers went unmessaged and buyers kept Mia's sales
-- brief (CLAUDE.md: "An ARM that rides another cron's schedule gets its OWN
-- row"; the class of migs 623, 633, 639, 640 and 642).
--
-- The route stamps this row ONLY when the arm returned an outcome with no
-- fault of its own (src/lib/cron-arm-health.js trialDoneArmHealthy): never on
-- a throw, and never when a studio-level read failed (locations, settings,
-- zones, the daily count, the board, the deals, pipelineInputs, the outreach
-- rows or the sweep of opened rows) or the arm threw for a studio or a person.
-- A per-person deferral, a failed delivery, a closed row and a studio config
-- gap still stamp, and so does a tick with nothing to do (every studio
-- switched off, the default; outside 09:00-19:59; nobody due), so the row
-- does not go stale overnight. last_outcome carries the arm's counts:
-- { openers, followups, skipped, reasons }.
--
-- CADENCE. 900 s interval (the parent's */15), 1500 s grace: STALE 40 minutes
-- after the last clean run. The arm stamps part-way through the parent's run
-- (after the follow-ups and check-ins, within maxDuration 300 s), so one
-- missed tick puts up to 1800 + 300 s + Vercel jitter between two stamps:
-- one missed tick never pages; two in a row (2700 s) always do.
--
-- APPLY THIS MIGRATION RIGHT AFTER THE TRIALDONE.7 CODE DEPLOYS (CLAUDE.md
-- cron rule), or re-run it then. It is born healthy (last_ok_at = now()) and
-- goes stale 40 minutes later unless the deployed route has started stamping
-- it. Before it exists the route's stamp is a logged no-op (stampHeartbeat is
-- UPDATE-only), which costs nothing.
--
-- BORN HEALTHY, ON CONFLICT DO UPDATE (RE-ARM), like 642 and 755: a replay
-- re-arms last_ok_at and rewrites the schedule and notes (last_outcome is
-- kept). The self-check at the bottom reads the POST-state: the row must END
-- UP on exactly this schedule, or the whole file aborts.
--
-- ROLLBACK (forward-only repo; a NEW migration, never an edit here):
--   DELETE FROM public.cron_heartbeats WHERE name = 'trial-done-outreach';
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at, notes)
values (
  'trial-done-outreach',
  900,
  1500,
  now(),
  'TRIALDONE.7 arm of the */15 agent-followups cron: trial-finisher opener, one follow-up and the sweep of opened rows (src/lib/agent/trial-done-runner.js). Stamped only on an outcome with no fault of its own (src/lib/cron-arm-health.js trialDoneArmHealthy). STALE = the arm threw or failed a studio-level read on every tick for 40 minutes: read last_outcome.reasons and the trial-done log lines.'
)
on conflict (name) do update
  set last_ok_at = now(),
      expected_interval_seconds = excluded.expected_interval_seconds,
      grace_seconds = excluded.grace_seconds,
      notes = excluded.notes;

do $$
declare e record;
begin
  for e in select * from (values
    ('trial-done-outreach', 900, 1500)
  ) as v(name, interval_s, grace_s) loop
    perform 1 from public.cron_heartbeats h
     where h.name = e.name and h.expected_interval_seconds = e.interval_s and h.grace_seconds = e.grace_s;
    if not found then
      raise exception 'mig 757: cron_heartbeats row % did not end up on % + %', e.name, e.interval_s, e.grace_s;
    end if;
  end loop;
end $$;
