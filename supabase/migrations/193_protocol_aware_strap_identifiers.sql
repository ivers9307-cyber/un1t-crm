-- 193_protocol_aware_strap_identifiers.sql
--
-- The studio HR bridge (champ-bridge) now reads straps over ANT+ as
-- well as BLE. ANT+ is the primary protocol — connectionless, so one
-- USB stick picks up a whole class with no per-strap connection.
--
-- A strap is now identified by a single self-describing `device_key`:
--   ble:AA:BB:CC:DD:EE:FF   Bluetooth — canonical MAC
--   ant:12345               ANT+ — decimal device number
--
-- The protocol is encoded *in* the key, so it can't drift from a
-- parallel column and ANT+/BLE ids can't collide. One text column
-- carries it everywhere: contact_devices.identifier,
-- strap_assignments.strap_identifier, heart_rate_sessions.device_identifier.
--
-- The HR feature has not been deployed to production, so the strap
-- tables are empty or near-empty — the column rename + backfill below
-- are cheap and safe.

BEGIN;

-- ── 1. strap_assignments.strap_mac → strap_identifier ───────────
-- The old name was BLE-specific. Rename to the protocol-neutral form.

ALTER TABLE public.strap_assignments
  RENAME COLUMN strap_mac TO strap_identifier;

COMMENT ON COLUMN public.strap_assignments.strap_identifier IS
  'Protocol-aware device_key of the paired strap — ble:<MAC> or ant:<deviceNumber>.';

-- ── 2. Backfill bare-MAC identifiers to qualified ble: keys ──────
-- The regex matches ONLY an un-prefixed canonical MAC, so this skips
-- anything already qualified — safe to re-run.

UPDATE public.contact_devices
  SET identifier = 'ble:' || identifier
  WHERE device_type = 'chest_strap'
    AND identifier ~ '^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$';

UPDATE public.strap_assignments
  SET strap_identifier = 'ble:' || strap_identifier
  WHERE strap_identifier ~ '^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$';

UPDATE public.heart_rate_sessions
  SET device_identifier = 'ble:' || device_identifier
  WHERE source = 'ble_bridge'
    AND device_identifier ~ '^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$';

-- ── 3. scan_straps_for_contact() — device_key aware ─────────────
-- ble_bridges.last_seen_straps entries now carry a `device_key`
-- field instead of `mac`. The function returns the device_key plus a
-- derived `protocol` so the champ-app device-registration UI can
-- badge ANT+ vs BLE without parsing. The return signature changed,
-- so the function must be dropped and recreated.

DROP FUNCTION IF EXISTS public.scan_straps_for_contact();

CREATE FUNCTION public.scan_straps_for_contact()
RETURNS TABLE (
  device_key   text,
  protocol     text,
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
  -- Resolve caller → contact (same helper contact_devices RLS uses).
  v_contact_id := private.auth_contact_id();
  IF v_contact_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN QUERY
  WITH live_straps AS (
    SELECT
      (s->>'device_key')::text                          AS device_key,
      (s->>'name')::text                                AS name,
      NULLIF(s->>'rssi','')::int                        AS rssi,
      NULLIF(s->>'last_bpm','')::int                    AS last_bpm,
      (s->>'seen_at')::timestamptz                      AS seen_at,
      b.name                                            AS bridge_name
    FROM public.ble_bridges b
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.last_seen_straps, '[]'::jsonb)) AS s
    WHERE (s->>'seen_at')::timestamptz > now() - interval '30 seconds'
      AND (s->>'device_key') IS NOT NULL
  )
  SELECT
    ls.device_key,
    CASE WHEN ls.device_key LIKE 'ant:%' THEN 'ant' ELSE 'ble' END AS protocol,
    ls.name, ls.rssi, ls.last_bpm, ls.seen_at, ls.bridge_name
  FROM live_straps ls
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.contact_devices cd
    WHERE cd.identifier = ls.device_key
      AND cd.device_type = 'chest_strap'
  )
  -- Freshest first; rssi is a BLE-only tiebreaker (ANT+ rssi is null).
  ORDER BY ls.seen_at DESC, ls.rssi DESC NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.scan_straps_for_contact() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.scan_straps_for_contact() FROM anon;
GRANT EXECUTE ON FUNCTION public.scan_straps_for_contact() TO authenticated;

COMMENT ON FUNCTION public.scan_straps_for_contact() IS
  'Live scan: nearby (last 30s) strap device_keys the bridges can see, excluding any already linked in contact_devices. Used by champ-app /account/devices.';

COMMIT;
