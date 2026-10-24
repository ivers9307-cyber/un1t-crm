-- SCREENMODE.1 — a third fleet role: the Android TV boxes behind the Hatch
-- Street floor screens.
-- Spec: docs/superpowers/specs/2026-10-24-hatch-screen-mode-design.md
--
-- WHY THIS EXISTS
-- fleet_devices knows two roles, `kiosk` and `bridge`, and both are Raspberry
-- Pis on the tailnet: the fleet-health cron discovers them from Tailscale and
-- the agent on each one takes commands over it. The Hatch floor screens are
-- Android TV boxes. They are not on the tailnet, run no fleet agent, and
-- cannot be reached from the CRM, so they have to report in themselves, and
-- the CRM decides what each one shows (the franchise class app during a
-- class, marketing otherwise).
--
-- So `screen` is a third role, and the columns below say what a box last
-- reported and what an operator has forced. They are set ONLY for
-- role = 'screen'; a kiosk or bridge row leaves them NULL.
--
--   tv_display_id      the tv_displays row whose content the box shows when it
--                      is in marketing mode. ON DELETE SET NULL: deleting a
--                      display unlinks the box, it does not delete the device.
--   last_heartbeat_at  last time the box called home.
--   reported_mode      what the box says it is showing now.
--   reported_version   the box's app version, as it reports it.
--   override_mode      a manual force from the CRM, until override_until.
--   override_until     when the force lapses. NULL override_mode = no force.
--
-- No grants and no policies: fleet_devices already carries mig 474's deny-all
-- policies for anon and authenticated, and the closed default ACL (mig 677)
-- applies. Every read and write of these columns is a service-role route.
-- No rows are seeded.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- role: kiosk | bridge | screen (NULL stays legal: discovered, not yet claimed)
-- ---------------------------------------------------------------------------
ALTER TABLE public.fleet_devices DROP CONSTRAINT IF EXISTS fleet_devices_role_check;
ALTER TABLE public.fleet_devices
  ADD CONSTRAINT fleet_devices_role_check CHECK (role IN ('kiosk', 'bridge', 'screen'));

COMMENT ON COLUMN public.fleet_devices.role IS
  'Governs which remote actions apply: restart_kiosk is kiosk-only, redeploy_bridge is bridge-only; screen (SCREENMODE.1) is an Android TV box that is not on the tailnet and reports in itself, so it takes no tailnet action. NULL until claimed.';

-- ---------------------------------------------------------------------------
-- Screen columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.fleet_devices
  ADD COLUMN IF NOT EXISTS tv_display_id     UUID REFERENCES public.tv_displays(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reported_mode     TEXT,
  ADD COLUMN IF NOT EXISTS reported_version  TEXT,
  ADD COLUMN IF NOT EXISTS override_mode     TEXT,
  ADD COLUMN IF NOT EXISTS override_until    TIMESTAMPTZ;

-- ADD COLUMN IF NOT EXISTS skips the whole column definition on a re-run, so a
-- CHECK written inline would never be re-applied. Named constraints, dropped
-- and re-added, keep the file re-runnable and the post-state certain.
ALTER TABLE public.fleet_devices DROP CONSTRAINT IF EXISTS fleet_devices_reported_mode_check;
ALTER TABLE public.fleet_devices
  ADD CONSTRAINT fleet_devices_reported_mode_check CHECK (reported_mode IN ('class_app', 'marketing', 'unknown'));

ALTER TABLE public.fleet_devices DROP CONSTRAINT IF EXISTS fleet_devices_override_mode_check;
ALTER TABLE public.fleet_devices
  ADD CONSTRAINT fleet_devices_override_mode_check CHECK (override_mode IN ('class_app', 'marketing'));

COMMENT ON COLUMN public.fleet_devices.tv_display_id IS
  'SCREENMODE.1 — set only for role = ''screen''. The tv_displays row whose content this box shows in marketing mode. ON DELETE SET NULL: deleting the display unlinks the box and keeps the device.';
COMMENT ON COLUMN public.fleet_devices.last_heartbeat_at IS
  'SCREENMODE.1 — set only for role = ''screen''. Last time the box called home. NULL until its first heartbeat.';
COMMENT ON COLUMN public.fleet_devices.reported_mode IS
  'SCREENMODE.1 — set only for role = ''screen''. What the box says it is showing: class_app, marketing, or unknown.';
COMMENT ON COLUMN public.fleet_devices.reported_version IS
  'SCREENMODE.1 — set only for role = ''screen''. The box''s app version, as it reports it.';
COMMENT ON COLUMN public.fleet_devices.override_mode IS
  'SCREENMODE.1 — set only for role = ''screen''. A manual force from the CRM (class_app or marketing) that wins over the schedule until override_until. NULL = no force.';
COMMENT ON COLUMN public.fleet_devices.override_until IS
  'SCREENMODE.1 — set only for role = ''screen''. When override_mode lapses. Read only while override_mode is set.';

-- Partial: only screens are looked up by studio on every heartbeat.
CREATE INDEX IF NOT EXISTS fleet_devices_screen_idx
  ON public.fleet_devices (location_id)
  WHERE role = 'screen';

-- ---------------------------------------------------------------------------
-- Self-check: the post-state in the catalog, never this file's text.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  d text;
  k text;
BEGIN
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.fleet_devices'::regclass AND conname = 'fleet_devices_role_check'));
  IF d IS NULL THEN
    RAISE EXCEPTION 'mig 768: fleet_devices_role_check missing';
  END IF;
  FOREACH k IN ARRAY ARRAY['kiosk', 'bridge', 'screen'] LOOP
    IF d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 768: fleet_devices_role_check does not admit %: %', k, d;
    END IF;
  END LOOP;

  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.fleet_devices'::regclass AND conname = 'fleet_devices_reported_mode_check'));
  IF d IS NULL THEN
    RAISE EXCEPTION 'mig 768: fleet_devices_reported_mode_check missing';
  END IF;
  FOREACH k IN ARRAY ARRAY['class_app', 'marketing', 'unknown'] LOOP
    IF d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 768: fleet_devices_reported_mode_check does not admit %: %', k, d;
    END IF;
  END LOOP;

  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.fleet_devices'::regclass AND conname = 'fleet_devices_override_mode_check'));
  IF d IS NULL THEN
    RAISE EXCEPTION 'mig 768: fleet_devices_override_mode_check missing';
  END IF;
  FOREACH k IN ARRAY ARRAY['class_app', 'marketing'] LOOP
    IF d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 768: fleet_devices_override_mode_check does not admit %: %', k, d;
    END IF;
  END LOOP;
  IF d LIKE '%''unknown''%' THEN
    RAISE EXCEPTION 'mig 768: fleet_devices_override_mode_check admits unknown, which is a report, never a force: %', d;
  END IF;

  -- The display link clears, never cascades or blocks.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.fleet_devices'::regclass AND contype = 'f'
                    AND confrelid = 'public.tv_displays'::regclass AND confdeltype = 'n') THEN
    RAISE EXCEPTION 'mig 768: fleet_devices.tv_display_id is not a foreign key to tv_displays ON DELETE SET NULL';
  END IF;

  d := (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'fleet_devices_screen_idx');
  IF d IS NULL OR d NOT LIKE '%(location_id) WHERE%' OR d NOT LIKE '%''screen''%' THEN
    RAISE EXCEPTION 'mig 768: fleet_devices_screen_idx wrong or missing: %', d;
  END IF;
END $$;

COMMIT;
