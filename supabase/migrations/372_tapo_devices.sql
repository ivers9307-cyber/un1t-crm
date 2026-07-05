-- 372: TAPO-T1 — Tapo device registry for scheduled/class-linked power
-- control at a location. The champ-bridge Pi executes; this table is
-- the CRM-side source of truth for config + last reported state.
-- Unknown devices reported by the bridge auto-register as
-- enabled=false rows (that IS the adopt flow — staff name + enable).
-- On/off only by design (no energy columns — spec decision).

CREATE TABLE IF NOT EXISTS public.tapo_devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  -- stable id from the sidecar: plug MAC or hub child device id
  sidecar_device_id  text NOT NULL,
  name               text,
  kind               text NOT NULL DEFAULT 'plug' CHECK (kind IN ('plug','switch')),
  -- v1: label only (class-climate is location-wide; no per-zone
  -- occurrence mapping exists — see spec §Desired-state model)
  zone               text,
  enabled            boolean NOT NULL DEFAULT false,
  schedule_mode      text NOT NULL DEFAULT 'none' CHECK (schedule_mode IN ('none','fixed','class')),
  -- fixed:  [{"days":[1..7],"on":"HH:MM","off":"HH:MM"}]  (ISO dow, Dublin wall-clock; off<on spans midnight)
  fixed_windows      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- class:  {"lead_min":15,"lag_min":10}
  class_rule         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {"state":"on"|"off","until":iso,"set_by":uuid}
  override           jsonb,
  last_state         text CHECK (last_state IN ('on','off')),
  last_seen_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, sidecar_device_id)
);

CREATE INDEX IF NOT EXISTS idx_tapo_devices_location_enabled
  ON public.tapo_devices (location_id, enabled);

ALTER TABLE public.tapo_devices ENABLE ROW LEVEL SECURITY;

-- House pattern (mig 355): single SELECT, per-command writes,
-- initplan-safe auth helpers.
CREATE POLICY tapo_devices_read ON public.tapo_devices
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));
CREATE POLICY tapo_devices_ins ON public.tapo_devices
  FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY tapo_devices_upd ON public.tapo_devices
  FOR UPDATE TO authenticated
  USING (private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY tapo_devices_del ON public.tapo_devices
  FOR DELETE TO authenticated
  USING (private.auth_is_in_location(location_id));
