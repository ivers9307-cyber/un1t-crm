-- INV-BULK.4 — seed the missing cron_heartbeats row for
-- process-invoice-analysis. The drain cron (mig 220, INV-BULK.1) was
-- registered in vercel.json and calls stampHeartbeat, but no heartbeat
-- row was ever seeded, so stampHeartbeat (update-only) matched 0 rows:
-- the cron ran blind — no monitoring, and the stale-cron watcher could
-- never alert if it died. */2 schedule = 120s; generous grace for Vercel
-- cron jitter / deploy-skips.
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
values ('process-invoice-analysis', 120, 240, 'INV-BULK — background invoice OCR drainer. Stamps every ~2-min tick regardless of queue depth.')
on conflict (name) do nothing;
