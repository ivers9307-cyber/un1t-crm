-- 801 — MCP.1: the staff MCP server's organisation switch and its call log.
-- (docs/superpowers/specs: staff MCP server design; plan task 2.)
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs; the apply step is the controller's.
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- /api/mcp lets a staff member connect Claude (or any MCP client) to the CRM
-- with their own login (Supabase OAuth). Two things need a home in the schema:
--   1. An organisation-level switch, OFF by default, so no organisation is
--      exposed to the endpoint until an owner/master turns it on.
--   2. A call log so an admin can see which person used which tool, from
--      which client, when, and whether it worked. It records NO arguments and
--      NO results: a tool call can carry a contact's name, phone or message
--      text, and the log must stay free of personal data.
--
-- ===========================================================================
-- WHAT
-- ===========================================================================
--   * org_settings.mcp_enabled boolean NOT NULL DEFAULT false. org_settings is
--     already closed to every client role (mig 730) and carries mig 733's
--     audit_mutation trigger, so a flip of the switch is audited with its
--     actor and needs no grant decision here.
--   * public.mcp_tool_calls: id, profile_id (cascade with the profile),
--     organization_id and location_id (SET NULL, so the log outlives a
--     deleted studio or organisation), client_id (the OAuth client, text),
--     tool, ok, error_code (a code, never a message), duration_ms,
--     created_at. Indexes: (profile_id, created_at DESC) for "what did this
--     person do" and (created_at) for the 90-day purge.
--   * Closed to every client session: RLS on, no policy, REVOKE ALL from
--     anon and authenticated (mig 677 already makes that the default for a new
--     public table; it is stated anyway). Written and read only by
--     service-role code (the /api/mcp route and the purge cron).
--   * NO cron_heartbeats row here: the purge cron and its heartbeat row come
--     in a later migration, applied right after that code deploys.
--
-- VERIFIED LIVE (BEFORE this migration): org_settings has no mcp_enabled
-- column and no client privilege or policy (mig 730); mcp_tool_calls does not
-- exist.

ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS mcp_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.org_settings.mcp_enabled IS
  'MCP.1: the organisation switch for the staff MCP server (/api/mcp). Off by default; while false every MCP call from this organisation''s staff is refused.';

CREATE TABLE IF NOT EXISTS public.mcp_tool_calls (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE SET NULL,
  location_id     uuid        REFERENCES public.locations(id) ON DELETE SET NULL,
  client_id       text        NOT NULL,
  tool            text        NOT NULL,
  ok              boolean     NOT NULL,
  error_code      text,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_tool_calls_profile_created_idx
  ON public.mcp_tool_calls (profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mcp_tool_calls_created_idx
  ON public.mcp_tool_calls (created_at);

ALTER TABLE public.mcp_tool_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mcp_tool_calls FROM anon, authenticated;

COMMENT ON TABLE public.mcp_tool_calls IS
  'MCP.1: one row per staff MCP tool call (who, which tool, which OAuth client, ok or error code, duration). Never arguments or results. Service role only (RLS on, no policy); purged after 90 days.';
