-- 776 SHELLYGROUPS.2 — shelly_groups: a named set of Shelly channels at one
-- location that is scheduled and switched as one; shelly_devices.group_id.
--
-- NOT APPLIED when this file was written. Apply BEFORE the SHELLYGROUPS code
-- deploys: the group routes and the reconcile read and write shelly_groups,
-- and the device column allowlist selects group_id, so a build against a
-- database without them 400s every Shelly read.
--
-- WHY A TABLE. A studio's lights are several channels (a Pro 4PM's four
-- relays, two RGBW strips) that the staff think of as one thing ("Gym floor").
-- The group carries the same schedule shape a device row carries (mig 562:
-- enabled, schedule_mode, fixed_windows, class_rule, override, last_applied;
-- the column comments there are the contract and hold here unchanged), so the
-- reconcile can serve a group exactly as it serves a channel. A device in a
-- group follows the group's schedule; group_id NULL = the device's own.
--
-- ONE LOCATION, ALWAYS. A group and every member sit at one location:
--   * shelly_devices_group_same_location (BEFORE INSERT OR UPDATE OF
--     group_id, location_id ON shelly_devices) raises 23514 when the group's
--     location_id differs from the device's. NULL group_id passes.
--   * shelly_groups_location_frozen (BEFORE UPDATE OF location_id ON
--     shelly_groups) raises 23514 on any change to a group's location_id:
--     moving a group would strand its members at the old location. No route
--     ever moves a group; the trigger is the DB refusing what code forgets.
--     (Moving a device is a remove-then-adopt already: (device_id, channel)
--     is globally unique, mig 562.)
-- Both trigger functions live in `private`, SECURITY INVOKER with a pinned
-- search_path (the mig 764 pattern), and state REVOKE EXECUTE from PUBLIC,
-- anon, authenticated: a trigger fires without the firing role holding
-- EXECUTE. INVOKER is enough: the device trigger reads shelly_groups as the
-- firing role, and every writer of shelly_devices is the service role (mig
-- 562 denies client writes by policy; a client attempt with a group_id now
-- fails on the shelly_groups grant instead, which is still a refusal).
--
-- DELETE. group_id is ON DELETE SET NULL: deleting a group returns its
-- members to their own (device-level) schedule and keeps every device row and
-- its energy history. The FK's SET NULL fires the device trigger with a NULL
-- group_id, which passes. location → groups is ON DELETE CASCADE.
--
-- UNIQUE (location_id, name): the group list is keyed by name in the UI; a
-- duplicate 23505s and the route maps it to "a group with that name exists".
--
-- GRANTS (mig 677): service_role only. REVOKE ALL FROM anon, authenticated,
-- PUBLIC is stated (still right on a database whose defaults were reset), RLS
-- is on with NO policy (never a RESTRICTIVE FOR ALL, the mig 483/485 class).
-- Staff read and write groups through /api/shelly/* routes that authorise in
-- app code. shelly_devices.group_id follows that table's existing table-level
-- read rule (mig 562: no column grant list); a group id is not a secret.
--
-- AUDIT: none. shelly_devices carries no audit_mutation trigger (no trigger
-- at all, mig 659's header), so shelly_groups matches it. No column here has
-- a secret-looking name. updated_at is written by the routes, as on
-- shelly_devices (no updated_at trigger on either).
--
-- POST-CHECK (read-only):
--   select grantee, privilege_type from information_schema.table_privileges
--    where table_schema='public' and table_name='shelly_groups'
--      and grantee in ('anon','authenticated','PUBLIC');            -- expect: 0 rows
--   select relrowsecurity from pg_class where oid='public.shelly_groups'::regclass;  -- t
--   select count(*) from pg_policies where tablename='shelly_groups';                 -- 0
--   select count(*) from public.shelly_devices where group_id is not null;            -- 0 right after apply
--   then run get_advisors (type=security).

BEGIN;

-- The ALTER on shelly_devices takes a brief lock on a table the every-minute
-- reconcile writes. Abort after 5 s rather than queue behind it; re-run.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.shelly_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  icon          text NOT NULL DEFAULT 'bulb',
  sort_order    integer NOT NULL DEFAULT 0,
  enabled       boolean NOT NULL DEFAULT false,
  schedule_mode text NOT NULL DEFAULT 'none',
  fixed_windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  class_rule    jsonb NOT NULL DEFAULT '{}'::jsonb,
  override      jsonb,
  last_applied  jsonb,
  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shelly_groups_name_check
    CHECK (char_length(name) BETWEEN 1 AND 60),
  CONSTRAINT shelly_groups_icon_check
    CHECK (icon IN ('bulb', 'fan', 'tv', 'plug', 'droplet')),
  CONSTRAINT shelly_groups_schedule_mode_check
    CHECK (schedule_mode IN ('none', 'fixed', 'class')),
  CONSTRAINT shelly_groups_location_name_unique UNIQUE (location_id, name)
);

ALTER TABLE public.shelly_groups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shelly_groups FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shelly_groups TO service_role;

COMMENT ON TABLE public.shelly_groups IS
  'SHELLYGROUPS.2 (mig 776) — a named set of shelly_devices channels at ONE location, scheduled and switched as one. Schedule columns mean exactly what they mean on shelly_devices (mig 562 comments). Service-role only: no client privilege, RLS on, no policy.';
COMMENT ON COLUMN public.shelly_groups.location_id IS
  'Never changes (trigger shelly_groups_location_frozen): moving a group would strand its members. Every member device sits at this location (trigger shelly_devices_group_same_location).';
COMMENT ON COLUMN public.shelly_groups.icon IS
  'UI glyph: bulb | fan | tv | plug | droplet.';
COMMENT ON COLUMN public.shelly_groups.sort_order IS
  'Display order within the location, ascending; ties by name.';

ALTER TABLE public.shelly_devices
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.shelly_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS shelly_devices_group_idx
  ON public.shelly_devices (group_id) WHERE group_id IS NOT NULL;

COMMENT ON COLUMN public.shelly_devices.group_id IS
  'SHELLYGROUPS.2 (mig 776): the shelly_groups row this channel follows, or NULL for its own schedule. Same location as the device, always (trigger). ON DELETE SET NULL: deleting a group keeps the device.';

-- The same-location fence.
CREATE OR REPLACE FUNCTION private.shelly_devices_group_same_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_location uuid;
BEGIN
  IF NEW.group_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT location_id INTO v_group_location FROM public.shelly_groups WHERE id = NEW.group_id;
  -- A missing group is left to the FK, which reports it as 23503.
  IF FOUND AND v_group_location IS DISTINCT FROM NEW.location_id THEN
    RAISE EXCEPTION 'shelly group % belongs to another location than device %', NEW.group_id, NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.shelly_devices_group_same_location() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS shelly_devices_group_same_location ON public.shelly_devices;
CREATE TRIGGER shelly_devices_group_same_location
  BEFORE INSERT OR UPDATE OF group_id, location_id ON public.shelly_devices
  FOR EACH ROW EXECUTE FUNCTION private.shelly_devices_group_same_location();

-- A group never moves.
CREATE OR REPLACE FUNCTION private.shelly_groups_location_frozen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    RAISE EXCEPTION 'shelly group % never moves location; create a new group there', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.shelly_groups_location_frozen() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS shelly_groups_location_frozen ON public.shelly_groups;
CREATE TRIGGER shelly_groups_location_frozen
  BEFORE UPDATE OF location_id ON public.shelly_groups
  FOR EACH ROW EXECUTE FUNCTION private.shelly_groups_location_frozen();

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rel constant text := 'public.shelly_groups';
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
BEGIN
  -- 0. RLS on: with no policy it is the second fence behind the grant.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
    RAISE EXCEPTION 'mig 776: row level security is off on %', v_rel;
  END IF;

  -- 1. anon, authenticated, PUBLIC: nothing, table and column level, any grantor.
  SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
    INTO v_extra
    FROM (
      SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'shelly_groups'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC')
      UNION ALL
      SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'shelly_groups'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) g;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'mig 776: client roles still hold privileges on %: %', v_rel, v_extra;
  END IF;

  -- 2. The same question of the real catalog (role membership, PUBLIC).
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF has_table_privilege(v_role, v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 776: % still holds % on %', v_role, v_priv, v_rel;
      END IF;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 776: % still holds column-level % on %', v_role, v_priv, v_rel;
      END IF;
    END LOOP;
  END LOOP;

  -- 3. The server reads and writes.
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
      RAISE EXCEPTION 'mig 776: service_role lacks % on %', v_priv, v_rel;
    END IF;
  END LOOP;

  -- 4. No policy at all.
  SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname)
    INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shelly_groups';
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 776: % should have no policy: %', v_rel, v_policies;
  END IF;

  -- 5. group_id exists, uuid, nullable, FK to shelly_groups ON DELETE SET NULL.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'shelly_devices' AND column_name = 'group_id'
       AND data_type = 'uuid' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'mig 776: shelly_devices.group_id is missing or has the wrong shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.shelly_devices'::regclass AND contype = 'f'
       AND confrelid = 'public.shelly_groups'::regclass AND confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION 'mig 776: shelly_devices.group_id has no ON DELETE SET NULL FK to shelly_groups';
  END IF;

  -- 6. Both fences are installed.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.shelly_devices'::regclass
                  AND tgname = 'shelly_devices_group_same_location' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'mig 776: trigger shelly_devices_group_same_location is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.shelly_groups'::regclass
                  AND tgname = 'shelly_groups_location_frozen' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'mig 776: trigger shelly_groups_location_frozen is missing';
  END IF;

  RAISE NOTICE 'mig 776: shelly_groups is service_role only; shelly_devices.group_id fenced to one location.';
END $$;

COMMIT;
