-- 514 — GAPS-P4: per-location send-time quiet hours (advisory).
--
-- WHAT HAPPENED
-- ─────────────
-- Measured live across every campaign send at Stillorgan, bucketed by the
-- Dublin hour the first message went out:
--
--     22:00  →   994 sends   (one campaign, first send Sat 08 Aug 22:44)
--     21:00  →   179 sends   (Mon 08 Jun 21:36)
--     20:00  → 6,092 sends
--     09:00-10:00 → 9,611 sends
--     the rest spread over 12:00-16:00
--
-- Both late-night campaigns had scheduled_at IS NULL. Nobody mis-set a
-- schedule: an operator pressed "Send now" late at night and nothing on the
-- composer said what wall-clock time that would land on. 994 people got a
-- sale email at 22:44 on a Saturday as a result.
--
-- WHY THESE DEFAULTS
-- ──────────────────
-- start = 21, end = 08 (a window that WRAPS past midnight):
--
--   • 22:00 and 21:00 are exactly the two hours the incident lives in, and
--     they carry 1,173 sends between them.
--   • 20:00 is deliberately OUTSIDE the window. It carries 6,092 legitimate
--     sends — the single busiest evening hour. A window starting at 20:00
--     would fire on the most ordinary send the studio makes, and a warning
--     that cries wolf on the common case gets clicked through and stops
--     being read.
--   • 08:00 is the earliest hour nobody would call antisocial, and it sits
--     just ahead of the 09:00-10:00 block that already carries 9,611 sends,
--     so the "schedule it for the morning instead" suggestion lands in the
--     slot operators already use.
--
-- enabled = TRUE by default is safe here because this phase is ADVISORY
-- ONLY. Nothing in the send path reads these columns: they drive an inline
-- notice in the composer that names the local time and offers the next
-- acceptable slot. The send button is never blocked and no send is ever
-- clamped or deferred — a manual send that silently does not go out reads as
-- a broken button and is worse than a late email.
--
-- WHERE THE DEFAULT LIVES
-- ───────────────────────
-- Twice, on purpose. The column DEFAULTs below cover a row that exists, and
-- DEFAULT_SEND_QUIET_HOURS in src/lib/send-quiet-hours.js covers a location
-- with NO company_settings row at all (most locations have never saved
-- branding, so the row genuinely may not exist). A missing row must never
-- mean "no quiet hours". normalizeQuietHours() falls back per FIELD, so a
-- half-written row cannot do it either.
--
-- Operator UI: Settings -> Locations -> <name> -> Details.
-- Read/write API: GET/PUT /api/locations/[id]/send-quiet-hours.
--
-- Forward-only. Additive columns on an existing table; no backfill needed
-- (the DEFAULTs apply to existing rows on read, since NOT NULL DEFAULT on
-- ADD COLUMN is a metadata-only operation in PG11+).

BEGIN;

ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS send_quiet_hours_enabled BOOLEAN  NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS send_quiet_hours_start   SMALLINT NOT NULL DEFAULT 21,
  ADD COLUMN IF NOT EXISTS send_quiet_hours_end     SMALLINT NOT NULL DEFAULT 8;

-- Hour-of-day boundaries, 0-23, Europe/Dublin wall clock. The window is
-- half-open [start, end): the start hour is quiet, the end hour is the first
-- hour that is not. start > end wraps past midnight (the default does).
-- start = end is rejected rather than read as a 24-hour window, which would
-- flag every send ever made; use send_quiet_hours_enabled = FALSE to turn the
-- feature off.
ALTER TABLE company_settings
  DROP CONSTRAINT IF EXISTS company_settings_send_quiet_hours_range;
ALTER TABLE company_settings
  ADD CONSTRAINT company_settings_send_quiet_hours_range CHECK (
    send_quiet_hours_start BETWEEN 0 AND 23
    AND send_quiet_hours_end BETWEEN 0 AND 23
    AND send_quiet_hours_start <> send_quiet_hours_end
  );

COMMENT ON COLUMN company_settings.send_quiet_hours_enabled IS
  'GAPS-P4 (mig 514): whether the composer warns when a send would land inside this location''s quiet window. ADVISORY ONLY - no send path reads this; nothing is clamped, deferred or blocked.';
COMMENT ON COLUMN company_settings.send_quiet_hours_start IS
  'GAPS-P4 (mig 514): first quiet hour, 0-23, Europe/Dublin wall clock. Default 21 - 21:00 and 22:00 carry the 1,173 late-night sends the feature exists for, while 20:00 (6,092 legitimate sends) stays outside the window on purpose.';
COMMENT ON COLUMN company_settings.send_quiet_hours_end IS
  'GAPS-P4 (mig 514): first NON-quiet hour, 0-23, Europe/Dublin wall clock. Default 8, just ahead of the 09:00-10:00 block that already carries 9,611 sends. start > end wraps past midnight.';

COMMIT;
