-- UniFi controller configuration is master-only (mig 033 follow-up).
--
-- Studio owners can manage everything ELSE about their location —
-- branding, name, address, integrations like Glofox, the per-staff
-- door-access toggles on profile_locations rows — but the underlying
-- UniFi controller credentials (host, API token, policy IDs) are
-- platform infrastructure and can only be set by a master.
--
-- Defense in depth: the LocationForm UI hides the section for
-- non-masters and strips the field from its payload, but a tech-savvy
-- owner could still hand-craft a Supabase update. This trigger blocks
-- that path.

CREATE OR REPLACE FUNCTION private.guard_unifi_config_master_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public' AS $$
DECLARE
  old_unifi jsonb;
  new_unifi jsonb;
BEGIN
  old_unifi := COALESCE(OLD.settings -> 'unifi', '{}'::jsonb);
  new_unifi := COALESCE(NEW.settings -> 'unifi', '{}'::jsonb);

  IF old_unifi = new_unifi THEN
    RETURN NEW;
  END IF;

  IF private.auth_is_master() THEN
    RETURN NEW;
  END IF;

  -- Service-role calls (no auth.uid) bypass too — used by API routes
  -- that have already enforced their own auth above this layer.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'UniFi controller configuration can only be modified by a master account.'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS guard_unifi_config_master_only ON locations;
CREATE TRIGGER guard_unifi_config_master_only
  BEFORE UPDATE OF settings ON locations
  FOR EACH ROW
  EXECUTE FUNCTION private.guard_unifi_config_master_only();

COMMENT ON FUNCTION private.guard_unifi_config_master_only() IS
  'Rejects UPDATEs that change settings->unifi unless the caller is a master or the service role.';
