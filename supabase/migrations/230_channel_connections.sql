-- 230: RADAR-AGENT Phase 0b — per-location channel connections.
--
-- The customer agent answers on multiple channels. WhatsApp creds
-- already live per-location in whatsapp_numbers (mig 176). This table
-- is the same idea for the OTHER Meta channels — Instagram now,
-- Messenger / others later — so each location connects its own
-- Instagram business account and the agent resolves the right one
-- per location, exactly like inbound WhatsApp routes by number.
--
-- Secrets (access_token, app_secret) are stored here, mirroring the
-- whatsapp_numbers model. RLS: readable by staff assigned to the
-- location (+ master); writes are service-role only — the API routes
-- use the service client and enforce getCurrentUser() + manager role
-- themselves (same pattern as whatsapp_numbers). The API masks secrets
-- before returning them to the browser.

CREATE TABLE IF NOT EXISTS public.channel_connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id          uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  platform             text NOT NULL CHECK (platform IN ('instagram','messenger')),
  label                text,
  external_account_id  text,             -- IG business account id (IGSID owner)
  page_id              text,             -- linked Facebook Page id
  app_id               text,
  access_token         text,             -- page access token
  app_secret           text,             -- for inbound webhook signature checks
  display_name         text,             -- @handle / page name (display only)
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid
);

CREATE INDEX IF NOT EXISTS idx_channel_connections_location
  ON public.channel_connections (location_id, platform);

-- One active connection per (location, platform). Partial unique so an
-- inactive/old row can coexist with the active one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connections_one_active
  ON public.channel_connections (location_id, platform) WHERE is_active;

-- Reverse-lookup index: inbound webhook resolves a connection by the
-- Meta account id it posted to.
CREATE INDEX IF NOT EXISTS idx_channel_connections_external
  ON public.channel_connections (platform, external_account_id) WHERE external_account_id IS NOT NULL;

ALTER TABLE public.channel_connections ENABLE ROW LEVEL SECURITY;

-- Read: authenticated staff assigned to the location, or master.
DROP POLICY IF EXISTS channel_connections_select ON public.channel_connections;
CREATE POLICY channel_connections_select
  ON public.channel_connections
  FOR SELECT
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.location_id = channel_connections.location_id
        AND pl.profile_id = auth.uid()
    )
  );

-- Write: service-role only. API routes use the service client and
-- enforce getCurrentUser() + manager-role checks.
DROP POLICY IF EXISTS channel_connections_deny_writes ON public.channel_connections;
CREATE POLICY channel_connections_deny_writes
  ON public.channel_connections
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);
