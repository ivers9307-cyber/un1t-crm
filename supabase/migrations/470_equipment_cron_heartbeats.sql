-- EQUIP-MAINT.3 — heartbeat rows for the two inspection crons.
--
-- A cron with no cron_heartbeats row makes stampHeartbeat()'s UPDATE
-- match zero rows: it logs a warning, never appears in cron_health, and
-- un1t-sentinel's stale-cron monitoring is blind to it. That is the
-- silent-death failure mode mig 053 exists to prevent, and mig 406 had
-- to retrofit four crons that shipped without it.
--
-- APPLY THIS BEFORE THE CRONS DEPLOY.
--
-- Both are daily: 86400 expected interval. Grace of 7200 (2h) mirrors
-- the daily Glofox crons (migs 172, 324) — generous enough that a
-- delayed Vercel tick doesn't page anyone.
--
-- last_ok_at defaults to NOW() so cron_health reports healthy until the
-- first real tick stamps it (same rationale as the mig 053 seeds).

insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) values
  ('equipment-inspection-reminder', 86400, 7200,
   'EQUIP-MAINT.3 — pushes "N due for inspection today" to equipment_inspect holders, on each location''s inspection weekday. Vercel cron 0 6 * * * UTC'),
  ('equipment-inspection-sweep',    86400, 7200,
   'EQUIP-MAINT.3 — evening chase: tells owner+master what was due and not submitted. Vercel cron 0 19 * * * UTC')
on conflict (name) do nothing;
