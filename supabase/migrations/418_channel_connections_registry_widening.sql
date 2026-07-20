-- 418: INTEG-A1 — connections-registry widening (Integrations & Monetisation
-- deployment plan, phase A1). channel_connections (mig 230) becomes the
-- consolidated per-location connections registry: more providers, a uniform
-- status model, error surfacing, and a config slot for provider-specific
-- fields (Glofox branch_id, UniFi host, etc). token_expires_at /
-- token_refreshed_at already exist (mig 408). Additive only — the sole
-- current occupant (instagram) is unaffected.
--
-- Applied to live via Supabase MCP on 2026-07-19; advisors clean (the two
-- SECURITY DEFINER warnings are the known intentional pair from the
-- 2026-06-10 audit).

ALTER TABLE public.channel_connections
  DROP CONSTRAINT channel_connections_platform_check;

ALTER TABLE public.channel_connections
  ADD CONSTRAINT channel_connections_platform_check
  CHECK (platform = ANY (ARRAY[
    'instagram'::text,
    'messenger'::text,
    'glofox'::text,
    'unifi'::text,
    'sensibo'::text,
    'thinq'::text,
    'twilio_sender'::text,
    'bca'::text,
    'postmark_domain'::text
  ]));

ALTER TABLE public.channel_connections
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'connected',
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS last_ok_at timestamptz,
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.channel_connections
  ADD CONSTRAINT channel_connections_status_check
  CHECK (status = ANY (ARRAY[
    'connected'::text,
    'action_needed'::text,
    'error'::text,
    'not_connected'::text
  ]));

COMMENT ON COLUMN public.channel_connections.status IS
  'Uniform hub status model (INTEG-A1). action_needed = e.g. token expiring; error = last operation failed, see last_error.';
COMMENT ON COLUMN public.channel_connections.config IS
  'Provider-specific non-secret fields (e.g. glofox branch namespace, unifi host). Secrets stay in access_token/app_secret.';
