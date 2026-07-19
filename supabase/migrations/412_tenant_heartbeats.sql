-- SAAS4-O1 — per-tenant cron heartbeats (SaaS machinery plan §4).
--
-- cron_heartbeats (mig 053) is name-keyed, so one healthy tenant masks
-- another's rotting sync (the glofox-data-quality single-aggregate
-- bug). This table adds the (name, location_id) dimension ADDITIVELY:
-- the global table, cron_health view, health-check 200/503 contract,
-- and the external un1t-sentinel consumer are all untouched.
--
-- Rows are created lazily by stampTenantHeartbeat() on first stamp
-- (cadence inherited from the parent cron_heartbeats row at stamp
-- time) — provisioning seeds nothing here. `muted` is operator state
-- for (cron, location) pairs where the integration is deliberately
-- not connected (e.g. a location without Glofox), so absence-of-stamps
-- there never reads as an outage.
--
-- RLS: same defence-in-depth pattern as mig 053 — service role does
-- all real reads/writes; anon/authenticated are denied outright.

CREATE TABLE public.tenant_heartbeats (
  name                       TEXT        NOT NULL,
  location_id                UUID        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  last_ok_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expected_interval_seconds  INTEGER     CHECK (expected_interval_seconds IS NULL OR expected_interval_seconds > 0),
  grace_seconds              INTEGER     CHECK (grace_seconds IS NULL OR grace_seconds >= 0),
  muted                      BOOLEAN     NOT NULL DEFAULT FALSE,
  PRIMARY KEY (name, location_id)
);

COMMENT ON TABLE public.tenant_heartbeats IS
  'SAAS4-O1: per-(cron, location) heartbeats for loop-over-locations crons. Lazily created on first stamp; cadence inherited from cron_heartbeats. muted = integration deliberately absent at this location.';

ALTER TABLE public.tenant_heartbeats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_heartbeats_no_anon" ON public.tenant_heartbeats
  FOR ALL TO anon
  USING (FALSE) WITH CHECK (FALSE);

CREATE POLICY "tenant_heartbeats_no_authenticated" ON public.tenant_heartbeats
  FOR ALL TO authenticated
  USING (FALSE) WITH CHECK (FALSE);

-- Live per-tenant health, mirroring cron_health's staleness math.
-- muted rows and rows with no registered cadence are never stale.
CREATE VIEW public.tenant_cron_health
WITH (security_invoker = on) AS
SELECT
  name,
  location_id,
  last_ok_at,
  expected_interval_seconds,
  grace_seconds,
  muted,
  EXTRACT(EPOCH FROM (NOW() - last_ok_at))::INTEGER AS stale_seconds,
  (expected_interval_seconds + COALESCE(grace_seconds, 0)) AS max_allowed_seconds,
  (
    NOT muted
    AND expected_interval_seconds IS NOT NULL
    AND (NOW() - last_ok_at) > make_interval(secs => (expected_interval_seconds + COALESCE(grace_seconds, 0)))
  ) AS is_stale
FROM public.tenant_heartbeats;

COMMENT ON VIEW public.tenant_cron_health IS
  'SAAS4-O1: live per-(cron, location) health. is_stale mirrors cron_health; muted or cadence-less rows never flag.';
