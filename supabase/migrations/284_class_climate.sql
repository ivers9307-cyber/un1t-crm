-- 284: CLASS-CLIMATE.1 — Glofox class-schedule "spine" + a schedule-driven
-- automation lane whose first rider is class climate control (turn the
-- studio AC on before a class, off after).
--
-- Two tables:
--   class_occurrences   — local mirror of the Glofox timetable (one row per
--     scheduled class instance), refreshed by /api/cron/sync-class-occurrences.
--     The shared "schedule spine" — HR allocation + future schedule automations
--     read it too. `raw` keeps the full event so any field we didn't break out
--     (room, etc.) is recoverable later without a backfill.
--   automation_fire_log — per-(automation, occurrence, device, step) idempotency
--     + run history for schedule-driven automations, so a class can't be actioned
--     twice across cron ticks.
--
-- The climate automation reuses the EXISTING automations plumbing: a
-- location_automations (mig 276) row with automation_key='class_climate' and
-- config = { device_ids[], offset_on_min, offset_off_min, class_filter[] }. It
-- turns AC on by writing an ac_sessions row (started_by NULL = system actor)
-- with auto_off_at = class_end + offset_off_min, so the EXISTING ac-auto-off
-- cron performs the off and the external-rule cron sees an active session and
-- leaves the unit alone. No new "off" path is needed.

BEGIN;

-- ── 1. class_occurrences — the schedule spine ───────────────────
CREATE TABLE IF NOT EXISTS public.class_occurrences (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id      uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  glofox_event_id  text NOT NULL,            -- Glofox event _id (per occurrence)
  name             text,
  program          text,
  starts_at        timestamptz,
  ends_at          timestamptz,
  capacity         integer,
  instructor       text,
  raw              jsonb,                     -- full Glofox event (forward-compat)
  synced_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT class_occurrences_unique UNIQUE (location_id, glofox_event_id)
);

CREATE INDEX IF NOT EXISTS idx_class_occurrences_loc_start
  ON public.class_occurrences (location_id, starts_at);

ALTER TABLE public.class_occurrences ENABLE ROW LEVEL SECURITY;

-- Authenticated (browser) may READ occurrences for their own locations.
-- All writes go through the service-role client (RLS-bypassing); this policy
-- is defence-in-depth, mirroring the _location_scoped pattern.
DROP POLICY IF EXISTS "class_occurrences_location_scoped_select" ON public.class_occurrences;
CREATE POLICY "class_occurrences_location_scoped_select" ON public.class_occurrences
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

COMMENT ON TABLE public.class_occurrences IS
  'Local mirror of the Glofox class timetable (CLASS-CLIMATE.1, mig 284). One row per scheduled class instance, refreshed by /api/cron/sync-class-occurrences. Shared schedule spine; raw keeps the full event for forward-compat. Writes are service-role only.';

-- ── 2. automation_fire_log — idempotency + run history ──────────
CREATE TABLE IF NOT EXISTS public.automation_fire_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id      uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  automation_key   text NOT NULL,
  glofox_event_id  text NOT NULL,
  device_id        uuid REFERENCES public.ac_devices(id) ON DELETE SET NULL,
  action_step      text NOT NULL,            -- 'on' | 'off' | future steps
  status           text NOT NULL DEFAULT 'fired'
    CHECK (status IN ('fired', 'skipped', 'failed')),
  detail           jsonb,
  fired_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_fire_log_unique UNIQUE (automation_key, glofox_event_id, device_id, action_step)
);

CREATE INDEX IF NOT EXISTS idx_automation_fire_log_loc
  ON public.automation_fire_log (location_id, fired_at DESC);

ALTER TABLE public.automation_fire_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "automation_fire_log_location_scoped_select" ON public.automation_fire_log;
CREATE POLICY "automation_fire_log_location_scoped_select" ON public.automation_fire_log
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

COMMENT ON TABLE public.automation_fire_log IS
  'Idempotency + run history for schedule-driven automations (CLASS-CLIMATE.1, mig 284). One row per (automation, class occurrence, device, step) so a class can''t be actioned twice across cron ticks. Writes are service-role only.';

-- ── 3. cron heartbeats for the two new crons ────────────────────
-- sync-class-occurrences: every 15 min (900s) + a generous 15 min grace.
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
VALUES ('sync-class-occurrences', 900, 900, NOW())
ON CONFLICT (name) DO NOTHING;

-- class-climate: every 5 min (300s) + 10 min grace.
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
VALUES ('class-climate', 300, 600, NOW())
ON CONFLICT (name) DO NOTHING;

COMMIT;
