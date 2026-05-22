-- 200_glofox_data_quality_heartbeat.sql
--
-- PACK-FRESHNESS.1 — data-quality monitor for Glofox pack credits.
--
-- trial_credits_remaining on num_classes contacts gates the churn
-- radar's Active base AND the pack-running-low signal. If the nightly
-- Glofox sync ever stops refreshing it, both degrade silently — the
-- sync cron's own heartbeat stays green because the cron is "alive";
-- it's the DATA that's rotting.
--
-- /api/cron/glofox-data-quality runs daily and stamps THIS heartbeat
-- only when the pack-credit data is fresh. A skipped stamp = stale
-- pack-credit data; the existing cron-health endpoint then surfaces
-- it like any other stale cron, reusing the alerting we already have.

begin;

-- Seed the heartbeat row. stampHeartbeat() is UPDATE-only, so the row
-- must pre-exist (same pattern as mig 174 / 198 / 199). Daily cadence:
-- 1-day interval + 1-day grace.
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
values
  ('glofox-data-quality', 86400, 86400,
   'PACK-FRESHNESS.1 — daily (05:00 UTC) check that Glofox pack-credit data is fresh. Stamps ONLY when num_classes contacts have been synced recently; a stale heartbeat here means the pack-credit data is drifting, not that the cron is dead.')
on conflict (name) do nothing;

commit;
