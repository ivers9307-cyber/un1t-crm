-- NOTIF.1 followup — seed the cron_heartbeats row I forgot to add in mig 169.
--
-- stampHeartbeat() in src/lib/cron-heartbeat.js does an UPDATE-only
-- against cron_heartbeats; it does NOT insert. If the row doesn't
-- exist when the cron first runs, the update matches 0 rows and the
-- heartbeat silently never lands. The cron itself keeps running fine
-- (push_reminder_sends got 20 rows of successful sends before this
-- was noticed), but /api/cron/health-check has no row to evaluate,
-- so external monitoring can't detect a stuck cron.
--
-- Symptom that flagged it: select last_ok_at from cron_heartbeats
-- where name = 'send-push-reminders' returned NULL despite the cron
-- having executed dozens of times. Vercel logs would have shown
-- "stamp matched 0 rows — cron not seeded in cron_heartbeats" every
-- 5 min if anyone had been filtering for it.
--
-- 300s expected interval (matches the cron schedule), 600s grace
-- (allows 2 missed ticks before the health check considers it stale).

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES
  ('send-push-reminders', 300, 600,
   'NOTIF.1 — task + booking lead-time reminders (24h / 1h). Fires every 5 min; 600s grace = 2 missed ticks before health check 503s.')
ON CONFLICT (name) DO NOTHING;
