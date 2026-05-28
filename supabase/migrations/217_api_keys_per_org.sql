-- APIKEYS.1 — per-organization API keys (foundation), replacing the
-- single shared CRM_API_KEY for n8n / external callers. Each key belongs
-- to one org; handlers scope queries by organization_id so a leaked key
-- can't reach other orgs. Raw key shown once; we store a SHA-256 hash +
-- display prefix only.
--
-- Applied to production via Supabase MCP on 2026-05-28; this file records
-- it for repeatability.
CREATE TABLE IF NOT EXISTS public.api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  key_prefix      text NOT NULL,
  key_hash        text NOT NULL UNIQUE,
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_organization_id_idx ON public.api_keys(organization_id);
CREATE INDEX IF NOT EXISTS api_keys_active_hash_idx ON public.api_keys(key_hash) WHERE revoked_at IS NULL;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
