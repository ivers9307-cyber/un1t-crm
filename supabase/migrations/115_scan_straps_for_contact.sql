-- 115_scan_straps_for_contact.sql
--
-- Customer self-registration: live scan of nearby straps the bridge
-- can see right now. Lets a member at the studio open
-- /account/devices, click "Scan", and pick from the list of MACs
-- the bridge is currently broadcasting — instead of hand-typing a
-- MAC from the back of the unit.
--
-- Web Bluetooth in the browser intentionally hides MAC addresses
-- (privacy spec) and isn't available on iOS Safari. The bridge IS
-- the source of truth for the MAC the gym's ingest pathway sees,
-- so we let the bridge tell the customer "here's what I'm seeing".
--
-- This is a SECURITY DEFINER fn so it can read ble_bridges +
-- contact_devices on behalf of the calling customer without
-- granting them blanket SELECT on those tables. The data returned
-- is also non-sensitive — BLE MACs are broadcast publicly to any
-- device in range — but we still gate on auth.uid() so we can
-- log/throttle in future.
--
-- Filtering rules
-- ---------------
-- - Only straps last seen within ~30s (the bridge updates
--   last_seen_straps every scan tick, so anything older means the
--   strap walked away).
-- - Exclude MACs already linked to ANY contact_device (active or
--   inactive). A member shouldn't be able to "claim" a strap that
--   another member registered.
-- - All bridges, all locations: members can register from any
--   gym they walk into. We don't gate by location because the
--   member might be at a partner studio or new location not yet
--   in their booking history.

BEGIN;

CREATE OR REPLACE FUNCTION public.scan_straps_for_contact()
RETURNS TABLE (
  mac          text,
  name         text,
  rssi         int,
  last_bpm     int,
  seen_at      timestamptz,
  bridge_name  text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contact_id uuid;
BEGIN
  -- Resolve caller → contact. Reuses the same helper that
  -- contact_devices RLS uses, so behaviour is consistent.
  v_contact_id := private.auth_contact_id();
  IF v_contact_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN QUERY
  WITH live_straps AS (
    SELECT
      (s->>'mac')::text                                 AS mac,
      (s->>'name')::text                                AS name,
      NULLIF(s->>'rssi','')::int                        AS rssi,
      NULLIF(s->>'last_bpm','')::int                    AS last_bpm,
      (s->>'seen_at')::timestamptz                      AS seen_at,
      b.name                                            AS bridge_name
    FROM public.ble_bridges b
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.last_seen_straps, '[]'::jsonb)) AS s
    WHERE (s->>'seen_at')::timestamptz > now() - interval '30 seconds'
  )
  SELECT ls.mac, ls.name, ls.rssi, ls.last_bpm, ls.seen_at, ls.bridge_name
  FROM live_straps ls
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.contact_devices cd
    WHERE cd.identifier = ls.mac
      AND cd.device_type = 'chest_strap'
  )
  ORDER BY ls.rssi DESC NULLS LAST, ls.seen_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.scan_straps_for_contact() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.scan_straps_for_contact() FROM anon;
GRANT EXECUTE ON FUNCTION public.scan_straps_for_contact() TO authenticated;

COMMENT ON FUNCTION public.scan_straps_for_contact() IS
  'Live scan: returns nearby (last 30s) BLE strap MACs the bridges can see, excluding any already linked in contact_devices. Used by champ-app /account/devices.';

COMMIT;
