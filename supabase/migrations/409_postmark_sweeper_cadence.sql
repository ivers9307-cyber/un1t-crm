-- 409 — process-postmark-webhooks: sweeper cadence heartbeat window (QSTASH.5)
--
-- QStash push (QSTASH.1–.2, PRs #926/#927) has been the primary consumer of
-- postmark_webhook_queue since 2026-07-17: 90+ organic events, worst latency
-- 2.9s, zero pending. The */2 drain cron is now a pure sweeper (publish
-- failures, QStash outages, exhausted retries), so vercel.json moves it to
-- */10 in the same PR. Widen the heartbeat window FIRST so sentinel never
-- false-alarms in the deploy gap. 600/600 mirrors glofox-detail-backfill
-- (mig 406) — one missed tick allowed.
--
-- (408 is taken by the in-flight Instagram Login API branch — numbering
-- skips are safe; ordering is by applied version, not filename.)
--
-- Applied via Supabase MCP 2026-07-19 as `postmark_sweeper_cadence_heartbeat`.

UPDATE cron_heartbeats
SET expected_interval_seconds = 600,
    grace_seconds = 600,
    notes = 'QSTASH.1 sweeper — QStash push (/api/webhooks/qstash/postmark) is the primary consumer; this cron sweeps publish failures / QStash outages / exhausted retries at */10'
WHERE name = 'process-postmark-webhooks';
