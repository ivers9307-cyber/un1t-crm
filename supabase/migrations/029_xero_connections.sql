-- Phase 1 of Xero integration: per-location OAuth 2.0 token storage.
--
-- Each location can be linked to a single Xero tenant (org). The
-- access_token is short-lived (~30 minutes); refresh_token rotates on
-- every refresh and is what lets us mint new access tokens for up to
-- 60 days of inactivity. Both are sensitive credentials — keep RLS
-- locked to owners of the location and rely on Supabase at-rest
-- encryption. (TODO: layer pgcrypto-based encryption later.)
--
-- One row per location for v1. The same Xero login can grant access
-- to multiple tenants (UN1T Dublin gym + CCF Autos), and we store the
-- chosen tenant_id explicitly so we know which org to push into.

CREATE TABLE IF NOT EXISTS xero_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  tenant_id       text NOT NULL,        -- Xero org identifier (UUID-shaped)
  tenant_name     text,                 -- Display name (e.g. "CCF Autos")
  tenant_type     text,                 -- ORGANISATION usually
  access_token    text NOT NULL,
  refresh_token   text NOT NULL,
  expires_at      timestamptz NOT NULL, -- access_token expiry
  scopes          text NOT NULL,        -- space-separated scopes granted
  connected_at    timestamptz NOT NULL DEFAULT now(),
  connected_by    uuid REFERENCES profiles(id),
  last_refreshed_at timestamptz,
  CONSTRAINT xero_connections_one_per_location UNIQUE (location_id)
);

CREATE INDEX IF NOT EXISTS xero_connections_tenant_idx ON xero_connections(tenant_id);

ALTER TABLE xero_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS xero_connections_member_select ON xero_connections;
CREATE POLICY xero_connections_member_select ON xero_connections
  FOR SELECT USING (private.auth_is_in_location(location_id));

DROP POLICY IF EXISTS xero_connections_owner_write ON xero_connections;
CREATE POLICY xero_connections_owner_write ON xero_connections
  FOR ALL
  USING (private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_in_location(location_id));

CREATE OR REPLACE FUNCTION private.bump_xero_refresh_ts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.access_token IS DISTINCT FROM OLD.access_token THEN
    NEW.last_refreshed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS xero_connections_refresh_ts ON xero_connections;
CREATE TRIGGER xero_connections_refresh_ts
  BEFORE UPDATE ON xero_connections
  FOR EACH ROW EXECUTE FUNCTION private.bump_xero_refresh_ts();

COMMENT ON TABLE xero_connections IS
  'Per-location Xero OAuth 2.0 tokens. One Xero tenant per location; tokens auto-refresh via src/lib/xero/client.js.';
