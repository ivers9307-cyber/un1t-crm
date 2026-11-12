-- 827 — MCPEMAIL.1: release approvals and the agent-draft markers for MCP email campaigns.
-- (docs/superpowers/specs/2026-11-12-mcp-email-campaigns-design.md; plan task 1.)
--
-- NOT APPLIED when this file was written. Applying is a rollout step for
-- Richard's go-ahead; apply it BEFORE the code that depends on it deploys.
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- Staff prepare marketing email campaigns from Claude through MCP tools, but a
-- tool never sends or schedules: a campaign is released only by a signed-in
-- press on a CRM confirm page. That press spends a one-time approval, which
-- binds the exact content, audience size and send time the person was shown.
--
-- ===========================================================================
-- WHAT
-- ===========================================================================
--   * public.campaign_release_approvals: one row per approval link. Only the
--     sha256 of the link token is stored (token_hash, UNIQUE); the token itself
--     exists once, in the URL handed to the person. content_key, audience_eligible
--     and send_at record what was approved. used_at and voided_at keep "spent"
--     and "withdrawn" distinguishable. Cascades with its campaign and profile.
--   * campaigns.agent_blocks jsonb: { v: 1, blocks: [...], html_sha256 } so a
--     later edit in the CRM is detectable. Withheld from every client (below).
--   * campaigns.created_via text NOT NULL DEFAULT 'web' CHECK ('web','mcp').
--
-- Closed to every client session: RLS on, no policy, REVOKE ALL from anon and
-- authenticated (mig 677 already makes that the default; stated anyway).
-- Written and read only by service-role code.
--
-- column-grant: campaigns is closed to every client session since mig 684
-- (no browser or phone privilege, no policy), so there is no column-granted
-- table to extend.
-- column-grant: withheld campaigns.agent_blocks
-- column-grant: withheld campaigns.created_via

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS agent_blocks jsonb;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS created_via text NOT NULL DEFAULT 'web'
    CHECK (created_via IN ('web', 'mcp'));

COMMENT ON COLUMN public.campaigns.agent_blocks IS
  'MCPEMAIL.1: { v: 1, blocks: [...], html_sha256 } as written by the MCP email tools. html_sha256 is the sha256 of the html_content written with them; a different hash of the current html_content means the body was edited in the CRM.';
COMMENT ON COLUMN public.campaigns.created_via IS
  'MCPEMAIL.1: where the campaign was created: web (the CRM) or mcp (an MCP tool).';

CREATE TABLE IF NOT EXISTS public.campaign_release_approvals (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       uuid        NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  profile_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token_hash        text        NOT NULL UNIQUE,
  content_key       text        NOT NULL,
  audience_eligible integer     NOT NULL,
  send_at           timestamptz,
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  voided_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_release_approvals_campaign_created_idx
  ON public.campaign_release_approvals (campaign_id, created_at DESC);

-- One live approval per campaign, enforced by the database: two concurrent
-- issues can both pass the rate-limit count and both void, but only one insert
-- can win; the loser gets 23505 and the app fails closed. An expired but
-- unvoided, unused row still counts as live, so issuing voids ALL unused rows.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_release_approvals_one_live
  ON public.campaign_release_approvals (campaign_id)
  WHERE used_at IS NULL AND voided_at IS NULL;

ALTER TABLE public.campaign_release_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campaign_release_approvals FROM anon, authenticated;

COMMENT ON TABLE public.campaign_release_approvals IS
  'MCPEMAIL.1: one-time approvals for releasing an MCP-prepared campaign. Stores only the sha256 of the link token. Service role only (RLS on, no policy).';
