-- ZOOMSYNC.1 — heartbeat row for the nightly zoom-contact-sync cron.
-- Created for the Zoom Phone external-contacts sync, spec 2026-08-06
-- (docs/superpowers/specs/2026-08-06-zoom-contact-sync-design.md).
--
-- APPLY THIS IN THE SAME DEPLOY AS THE vercel.json CRON ENTRY (same rule as
-- migs 470/471) — otherwise stampHeartbeat('zoom-contact-sync') UPDATEs zero
-- rows every night, logs a warning, and cron_health monitoring stays blind to
-- it. The route already calls stampHeartbeat() unconditionally, including on
-- the unconfigured "ships dark" skip path (matching the Homey/fleet-health
-- pattern — mig 472's fleet-health does the same), so the row must exist
-- from the very first run, not just once the ZOOM_* secrets are set.
--
-- expected_interval_seconds/grace_seconds sizing: this is a nightly cron
-- (Vercel `30 4 * * *`), the same cadence and shape as glofox-arrears-
-- reconcile (mig 324/406: 86400 + 7200, "0 4 * * *") and connection-health
-- (mig 419: 86400 + 21600) — both nightly reconciles against a rate-limited
-- third-party API, the closest precedent to this one (Zoom's list-and-diff,
-- ~64 GETs against /phone/external_contacts). The route itself is bounded by
-- maxDuration=300s regardless — it only builds the diff and enqueues QStash
-- jobs, it never waits for the drain — so grace here is covering Vercel
-- scheduling jitter and deploy-skip collisions, not a long-running job. We
-- match glofox-arrears-reconcile's tighter 2h grace rather than connection-
-- health's 6h: this cron pages an external API on every single run, and a
-- silently dead Zoom token would otherwise only surface when a member
-- complains their call showed no name.
--
-- last_ok_at defaults to NOW() so cron_health reports healthy until the
-- first real tick stamps it (same rationale as migs 053/470/471/472).

insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) values
  ('zoom-contact-sync', 86400, 7200,
   'ZOOMSYNC.1 — nightly Zoom Phone external-contacts reconcile: pages Zoom''s external-contacts list, diffs against distinct CRM phone numbers, enqueues QStash create/update/delete jobs (worker applies the writes). Ships dark — no-ops but still heartbeats until ZOOM_ACCOUNT_ID/ZOOM_CLIENT_ID/ZOOM_CLIENT_SECRET are set. Vercel cron 30 4 * * * UTC.')
on conflict (name) do nothing;
