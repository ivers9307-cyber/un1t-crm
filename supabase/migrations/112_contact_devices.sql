-- 112_contact_devices.sql
--
-- Persistent member→device registry. Replaces the per-class manual
-- pairing flow with auto-association at sample time: when the bridge
-- sees a BPM sample for a MAC, the server finds which contact owns
-- that MAC, finds their in-progress booking, and routes the sample
-- without coach intervention.
--
-- Why a table not contacts.preferred_strap_mac
-- --------------------------------------------
-- A column would work for v1 but rule out future device types
-- (Apple Watch IDs, Garmin sensor IDs, multiple straps for couples
-- sharing membership). The table costs ~5 minutes of schema, makes
-- the UI naturally extensible, and matches the existing
-- hr_provider_connections shape.
--
-- Identifier format
-- -----------------
-- For chest straps: canonical UPPER colon-separated MAC
-- (AA:BB:CC:DD:EE:FF). The library helper canonicaliseMac
-- normalises before insert so a member typing 'aabbccddeeff' and
-- a coach typing 'AA-BB-CC-DD-EE-FF' both land the same row.
--
-- For watches (Phase 3+): provider-specific ID. Not enforced at
-- the column level — device_type discriminates.
--
-- Override behaviour
-- ------------------
-- strap_assignments (mig 110) stays as the per-class override
-- table for walk-ins / lent straps. The bridge ingestion pathway
-- checks strap_assignments FIRST (override wins), then falls back
-- to contact_devices auto-association.

BEGIN;

CREATE TABLE IF NOT EXISTS public.contact_devices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id            uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  device_type           text NOT NULL CHECK (device_type IN ('chest_strap', 'watch')),
  identifier            text NOT NULL,         -- MAC for strap, vendor-id for watches
  label                 text,                  -- "Polar H10", member-typed
  manufacturer          text,                  -- 'polar', 'wahoo', 'coospo', 'garmin', 'apple', 'unknown'
  is_active             boolean NOT NULL DEFAULT true,
  added_by_contact      boolean NOT NULL DEFAULT false,    -- did the customer add it themselves?
  added_by_user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, device_type, identifier)
);

-- Bridge auto-association needs fast lookup by identifier across
-- ALL contacts at this bridge's location. Lookup is by identifier
-- (the strap MAC the bridge is broadcasting), filtered to active.
CREATE INDEX IF NOT EXISTS idx_contact_devices_identifier_active
  ON public.contact_devices (identifier)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_contact_devices_contact
  ON public.contact_devices (contact_id, is_active);

CREATE INDEX IF NOT EXISTS idx_contact_devices_added_by_user_id
  ON public.contact_devices (added_by_user_id);

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_contact_devices_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_contact_devices_touch_updated_at ON public.contact_devices;
CREATE TRIGGER trg_contact_devices_touch_updated_at
  BEFORE UPDATE ON public.contact_devices
  FOR EACH ROW EXECUTE FUNCTION public.touch_contact_devices_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────

ALTER TABLE public.contact_devices ENABLE ROW LEVEL SECURITY;

-- Customer self: read + write own devices.
CREATE POLICY "Customers can view own devices"
  ON public.contact_devices FOR SELECT TO public
  USING (contact_id = private.auth_contact_id());

CREATE POLICY "Customers can add own devices"
  ON public.contact_devices FOR INSERT TO public
  WITH CHECK (contact_id = private.auth_contact_id());

CREATE POLICY "Customers can update own devices"
  ON public.contact_devices FOR UPDATE TO public
  USING (contact_id = private.auth_contact_id())
  WITH CHECK (contact_id = private.auth_contact_id());

CREATE POLICY "Customers can delete own devices"
  ON public.contact_devices FOR DELETE TO public
  USING (contact_id = private.auth_contact_id());

-- Staff at the contact's location: full CRUD via the existing
-- auth_is_in_location helper (delegates to private fn so this
-- can't recurse into contacts RLS).
CREATE POLICY "Staff can view devices at their locations"
  ON public.contact_devices FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_devices.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

CREATE POLICY "Staff can add devices for contacts at their locations"
  ON public.contact_devices FOR INSERT TO public
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_devices.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

CREATE POLICY "Staff can update devices for contacts at their locations"
  ON public.contact_devices FOR UPDATE TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_devices.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

CREATE POLICY "Staff can delete devices for contacts at their locations"
  ON public.contact_devices FOR DELETE TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_devices.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

COMMIT;
