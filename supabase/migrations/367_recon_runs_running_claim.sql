-- 367_recon_runs_running_claim.sql
-- RCOV.P0 — atomic per-location run claim: at most one 'running'
-- recon_runs row per location. Orchestrator claims by insert-first
-- (23505 → "already running") after sweeping stale rows (>15 min;
-- legit runs can't be swept — the cron's maxDuration is 300s).
create unique index recon_runs_one_running_per_location_idx
  on public.recon_runs (location_id)
  where status = 'running';
