insert into cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) values
  ('ad-insights-sync', 86400, 21600, 'Daily Meta ads insight sync'),
  ('ad-report-email', 86400, 21600, 'Daily ads performance email')
on conflict (name) do nothing;
