-- 307: sparse daily-ish recovery/fitness metrics ingested from Open Wearables
-- (Apple Health). Resting HR / HRV (SDNN) / VO2 max, pulled by the
-- sync-wearable-trends cron and displayed on the champ-app Progress screen.
CREATE TABLE IF NOT EXISTS member_health_metrics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  location_id  uuid REFERENCES locations(id),
  metric       text NOT NULL,           -- 'resting_heart_rate' | 'heart_rate_variability_sdnn' | 'vo2_max'
  recorded_at  timestamptz NOT NULL,
  value        numeric NOT NULL,
  unit         text,
  source       text NOT NULL DEFAULT 'apple_health',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, metric, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_member_health_metrics_contact_metric
  ON member_health_metrics (contact_id, metric, recorded_at DESC);

ALTER TABLE member_health_metrics ENABLE ROW LEVEL SECURITY;

-- Customers read their own metrics (mirrors heart_rate_sessions customer policy).
CREATE POLICY "Customers view own health metrics" ON member_health_metrics
  FOR SELECT TO public
  USING (contact_id = (SELECT private.auth_contact_id()));

-- Staff read metrics at locations they belong to.
CREATE POLICY "Staff view location health metrics" ON member_health_metrics
  FOR SELECT TO public
  USING (private.auth_is_in_location(location_id));

-- Writes are service-role only (the cron) — no anon/authenticated write policy.

-- Heartbeat row for the daily ingestion cron (mirrors the cron-monitoring pattern).
INSERT INTO cron_heartbeats (name, expected_interval_seconds, grace_seconds)
VALUES ('sync-wearable-trends', 86400, 21600)
ON CONFLICT (name) DO NOTHING;
