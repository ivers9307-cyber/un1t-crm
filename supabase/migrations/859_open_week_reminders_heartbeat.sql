-- OPENWEEK.7 (mig 859): heartbeat row for the open-week-reminders cron
-- (every 15 min). Apply right AFTER the code that stamps it deploys.
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'open-week-reminders',
  now(),
  900,
  1800,
  'OPENWEEK.7 — every 15 min: WhatsApp class reminders for open week signups (18:00 the evening before a morning class, 09:00 the day of a lunch or afternoon class). Stamps unless a whole studio read failed.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;
