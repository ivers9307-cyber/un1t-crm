-- INTEG-C3 — wallet overage-draw cron heartbeat seed.
--
-- The enforcement item is code-side (src/lib/wallet-enforcement.js +
-- /api/cron/wallet-overage-draws): allowances come from mig 413
-- (plans), the wallet + wallet_apply RPC from mig 414, usage from
-- mig 411/415. The ONLY DB object this migration adds is the
-- cron_heartbeats row for the new daily draw poster (03:10 UTC,
-- after the 02:40 usage-rollup): daily window + 6h grace, mirroring
-- the other daily crons' posture.
--
-- DML-only; ON CONFLICT DO NOTHING makes it rerun-safe.

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'wallet-overage-draws',
  86400,   -- daily
  21600,   -- 6h grace
  'INTEG-C3 daily overage draw poster (03:10 UTC, after the 02:40 usage-rollup): prices month-to-date overage per meter for tier-pinned locations and posts one wallet_apply draw per meter per day (cumulative-minus-drawn, grace-floor clamped).'
)
ON CONFLICT (name) DO NOTHING;
