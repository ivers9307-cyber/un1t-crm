-- ============================================================
-- 240: auto-close stale impersonation sessions
-- ============================================================
--
-- WHY
-- ───
-- impersonation_log rows are closed (ended_at stamped) ONLY by an
-- explicit /api/impersonate/stop call or an implicit re-target
-- (starting a new session closes the prior open row). Every other
-- way a session ends leaves the row open forever:
--   - master closes the tab / navigates away
--   - master logs out (Supabase signOut never told our server)
--   - the un1t_impersonate cookie hits its max-age
--   - browser cookies cleared manually
--
-- A permanently-open row misrepresents a short debug session as
-- "still ongoing" in the staff-visible access history ("see every
-- time a master signed in as you") — an accuracy/privacy problem,
-- not a security one (auth.js requires BOTH the cookie AND an open
-- row to actually impersonate, so a dangling row alone is inert).
--
-- WHAT
-- ────
--   1. auto_closed flag so the access-history UI can distinguish an
--      explicit "Stop" (precise end) from a session reaped at its
--      max-age (end is an upper bound, exact time unknown).
--   2. cron_heartbeats row for the hourly /api/cron/
--      close-stale-impersonations reaper (see src/lib/impersonation.js
--      closeStaleImpersonations()), which stamps ended_at =
--      started_at + session max-age on any row open past that window.

BEGIN;

ALTER TABLE impersonation_log
  ADD COLUMN IF NOT EXISTS auto_closed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN impersonation_log.auto_closed IS
  'true when ended_at was stamped by the close-stale-impersonations cron at the session max-age (exact end unknown, upper bound) rather than by an explicit Stop / re-target.';

INSERT INTO cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('close-stale-impersonations', 3600, 1800,
        'Hourly reaper closing impersonation_log rows open past the session max-age (src/lib/impersonation.js). 1h interval + 30m grace.')
ON CONFLICT (name) DO NOTHING;

COMMIT;
