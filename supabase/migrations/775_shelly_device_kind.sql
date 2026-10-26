-- 775 SHELLYLIGHT.3 — shelly_devices.kind: a row controls a relay or a light.
--
-- NOT APPLIED when this file was written. Apply BEFORE the SHELLYLIGHT.3 code
-- deploys: the reconcile, the toggle route and the adopt route read and write
-- `kind`, and the device column allowlist (DEVICE_COLUMNS) selects it, so a
-- build against a database without the column 400s every Shelly read.
--
-- WHAT IT MEANS. Shelly addresses a dimmer/RGB/RGBW channel as a LIGHT
-- component (light:N / rgb:N / rgbw:N, set through /v2/devices/api/set/light
-- and the `light` key of set/groups), and a relay as a SWITCH (switch:N). The
-- same (device_id, channel) pair names a different component under each, so
-- the row has to say which one it adopted. The adopt route stores the kind the
-- LIVE reading shows for that channel, never the request body's word for it.
--
-- DEFAULT 'switch': every row adopted before this file is a relay (the code
-- could not adopt anything else), so the default is the truth for them, and a
-- writer that predates this column keeps producing a correct row.
--
-- UNIQUE (device_id, channel) (mig 562) is unchanged: one piece of hardware
-- never exposes a switch and a light on the same channel number at once, so
-- the pair still identifies one controllable thing.
--
-- GRANTS: none changed. shelly_devices has no column-level grant list (mig
-- 562: table-level SELECT through the shelly_devices_select policy, client
-- writes denied by policy), so the new column follows the table's existing
-- read rule. Nothing secret lives in it.
--
-- POST-CHECK (read-only):
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='shelly_devices' and column_name='kind';
--   -- expect: kind | text | NO | 'switch'::text
--   select count(*) from public.shelly_devices where kind <> 'switch';
--   -- expect: 0 right after apply

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.shelly_devices
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'switch';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.shelly_devices'::regclass
       AND conname = 'shelly_devices_kind_check'
  ) THEN
    ALTER TABLE public.shelly_devices
      ADD CONSTRAINT shelly_devices_kind_check CHECK (kind IN ('switch', 'light'));
  END IF;
END $$;

COMMENT ON COLUMN public.shelly_devices.kind IS
  'SHELLYLIGHT.3 (mig 775): ''switch'' (switch:N, set/switch) or ''light'' (light:N / rgb:N / rgbw:N, set/light). Stored at adopt from the live reading of the channel, never from the request body. Commands, readings and energy match on channel AND kind.';

-- Self-check: the column, its NOT NULL default and its CHECK must all exist,
-- or the transaction rolls back rather than leaving half a change behind.
DO $$
DECLARE
  col record;
BEGIN
  SELECT data_type, is_nullable, column_default INTO col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'shelly_devices' AND column_name = 'kind';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 775: shelly_devices.kind is missing';
  END IF;
  IF col.data_type <> 'text' OR col.is_nullable <> 'NO' OR col.column_default IS DISTINCT FROM '''switch''::text' THEN
    RAISE EXCEPTION 'mig 775: shelly_devices.kind has the wrong shape (%, nullable %, default %)',
      col.data_type, col.is_nullable, col.column_default;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.shelly_devices'::regclass
       AND conname = 'shelly_devices_kind_check'
       AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'mig 775: shelly_devices_kind_check is missing';
  END IF;
END $$;

COMMIT;
