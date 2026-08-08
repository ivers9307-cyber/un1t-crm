-- FLEET-CMD.3 — look at what a studio screen is actually showing.
-- Spec: docs/superpowers/specs/2026-08-02-fleet-remote-actions-design.md
--
-- WHY
-- FLEET-CMD.2 can tell you a board has stopped drawing. It cannot tell you
-- what it IS drawing — a stale class, a Chromium error page, the wrong
-- location, a leaderboard nobody updated. The only way to answer that was to
-- stand in the gym.
--
-- `grim` is already installed on the kiosks (Raspberry Pi OS ships it with the
-- wlroots desktop), so this needs no new package: the agent captures the
-- framebuffer of the live labwc session and posts it back.
--
-- ── PRIVACY: THIS IS HEALTH DATA ─────────────────────────────────────────
-- A screenshot of the live board contains member first names, last initials
-- and their CURRENT HEART RATE. That is special-category data under GDPR, and
-- it is the reason this bucket is shaped the way it is:
--
--   * PRIVATE. Never public-read, unlike branding/tv-content. Access is a
--     short-lived signed URL minted per view.
--   * fleet_admin ONLY. `fleet_restart` is the tier a coach on shift holds;
--     it deliberately does NOT include this. Being able to restart a frozen
--     TV should not come with the ability to photograph the room's vitals.
--   * NOT AN ARCHIVE. Pruned after 24 hours by the fleet-health cron. This
--     exists to answer "what is on that screen right now", and a screenshot
--     older than a day answers nothing while remaining a liability.
--   * JPEG only, 5MB cap.
--
-- If this ever needs to become a longer record, that is a decision to take
-- deliberately with a retention policy, not by letting the prune lapse.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('fleet-screenshots', 'fleet-screenshots', FALSE, 5242880, ARRAY['image/jpeg'])
ON CONFLICT (id) DO NOTHING;

-- No storage RLS policies on purpose: every read and write goes through a
-- service-role route that checks the permission in app code first, and the
-- bucket being private means anon/authenticated get nothing by default. Same
-- posture as car-documents (mig 025).

-- Widen the action allowlist. The CHECK is the backstop; src/lib/fleet-commands.js
-- is the gate, and the agent's own table decides what a name actually runs.
ALTER TABLE public.fleet_commands
  DROP CONSTRAINT IF EXISTS fleet_commands_action_check;

ALTER TABLE public.fleet_commands
  ADD CONSTRAINT fleet_commands_action_check CHECK (action IN
    ('restart_kiosk', 'reboot', 'shutdown', 'redeploy_bridge', 'pull_logs', 'screenshot'));

ALTER TABLE public.fleet_commands
  ADD COLUMN IF NOT EXISTS screenshot_path TEXT;

COMMENT ON COLUMN public.fleet_commands.screenshot_path IS
  'FLEET-CMD.3 — object path in the PRIVATE fleet-screenshots bucket. Served only as a short-lived signed URL to a fleet_admin. A board screenshot shows member first names and live BPM, so these are pruned after 24h by the fleet-health cron and never archived.';
