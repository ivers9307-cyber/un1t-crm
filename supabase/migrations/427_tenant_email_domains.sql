-- INTEG-B3 — self-serve per-tenant email sending domains (SERVER-PER-TENANT).
--
-- Applied to prod via Supabase MCP (apply_migration); this file mirrors
-- it for history and fresh-env replay. NOT YET APPLIED at PR time — the
-- orchestrator applies it (see the PR body). Apply BEFORE the code that
-- reads this table deploys (CLAUDE.md forward-only rule).
--
-- Model (Richard, final 2026-07-19): one Postmark SERVER per ORGANIZATION
-- (own streams / reputation / analytics), created via the Account API
-- token, plus that org's own verified sending DOMAIN (DKIM + Return-Path).
-- Every location in the org sends through that server + domain. Gated as a
-- PAID ADD-ON (the plan feature `custom_email_domain`, shared/plans.js
-- FEATURE_KEYS) — no org has it today, so the whole feature is unreachable
-- and this table stays empty = ZERO BEHAVIOUR CHANGE (UN1T keeps sending
-- byte-identically through the shared POSTMARK_API_KEY server).
--
-- One row per org (organization_id PRIMARY KEY). ON DELETE RESTRICT, not
-- CASCADE: the row points at PROVISIONED, PAID Postmark resources (a real
-- server + a verified domain) — deleting the org out from under them
-- would silently orphan billable infrastructure, so the delete is blocked
-- until the resources are torn down deliberately.
--
-- SECRET HANDLING: postmark_server_token is the org's Postmark SERVER
-- token — a live sending credential. It lives ONLY here, on this
-- service-role table. It is NEVER selected into any client-facing payload,
-- NEVER returned by any route (routes return a REDACTED status shape), and
-- NEVER logged. RLS below denies all authenticated/anon reads except
-- master; service-role routes (createServerClient, RLS-bypassing) are the
-- only reader, and the send path (src/lib/tenant-email.js) is the only
-- place it is put on the wire (X-Postmark-Server-Token header).
--
-- RLS mirrors migs 413/420 EXACTLY: one permissive master-only SELECT
-- (private.auth_is_master()) + a restrictive deny-writes for
-- authenticated/anon. Deliberately NOT the tenant_domains (mig 415) shape
-- that also permits org-membership SELECT — because THIS table stores a
-- secret, only master may read it through an RLS-bound client; org owners
-- see their status exclusively through the redacting service-role route.

CREATE TABLE public.tenant_email_domains (
  organization_id          uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE RESTRICT,

  -- Postmark SERVER (one per org, Account-API created). Stored the moment
  -- it is minted so a failure mid-provision never spawns a duplicate.
  postmark_server_id       integer,
  postmark_server_token    text,

  -- Postmark DOMAIN (account-level resource; DKIM + Return-Path). The id
  -- is needed to re-read verification state and to trigger re-checks
  -- (getTenantDomain / verifyTenantDomainDkim / verifyTenantReturnPath).
  postmark_domain_id       integer,
  sending_domain           text,

  -- The verified From this org's mail goes out as (e.g. hello@mail.gymx.com).
  from_email               text,
  from_name                text,

  -- DNS records the operator pastes at their registrar + verification state.
  dkim_pending_host        text,
  dkim_pending_value       text,
  dkim_verified            boolean NOT NULL DEFAULT false,
  return_path_domain       text,
  return_path_cname_value  text,
  return_path_verified     boolean NOT NULL DEFAULT false,

  -- Lifecycle: pending (server minted, domain not yet) → verifying (domain
  -- created, DNS not yet confirmed) → live (both DKIM + Return-Path
  -- verified — the ONLY status the send path routes through) → failed /
  -- disabled (operator kill switch; send path falls back to the global
  -- default). ONLY 'live' is honoured by resolveEmailSender.
  status                   text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','verifying','live','failed','disabled')),
  last_error               text,

  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tenant_email_domains IS
  'INTEG-B3 per-ORGANIZATION Postmark sending config (server-per-tenant). One row per org: its own Postmark server + verified sending domain (DKIM + Return-Path). Gated by the custom_email_domain plan add-on; empty today = zero behaviour change (UN1T sends via the shared POSTMARK_API_KEY server). status=''live'' is the only state the send path (src/lib/tenant-email.js resolveEmailSender) routes through; anything else falls back to the global default. ON DELETE RESTRICT because the row tracks provisioned paid Postmark resources.';

COMMENT ON COLUMN public.tenant_email_domains.postmark_server_token IS
  'SECRET — the org''s Postmark SERVER token (a live sending credential). Service-role only: NEVER selected into a client-facing payload, NEVER returned by any route (routes return a redacted status shape), NEVER logged. RLS denies all non-master reads; the send path is the only consumer, setting it as the X-Postmark-Server-Token header.';

COMMENT ON COLUMN public.tenant_email_domains.status IS
  'pending (server minted) → verifying (domain created, DNS unconfirmed) → live (DKIM + Return-Path verified) → failed / disabled (kill switch). Only ''live'' is honoured by resolveEmailSender; every other value resolves to the global default sender.';

-- ── RLS — mirror migs 413 / 420 exactly ────────────────────────────────
-- Master-only SELECT (one permissive policy per (table, command) — mig 320
-- rule); restrictive deny for authenticated/anon writes. Service-role
-- routes bypass RLS and enforce owner-of-org / master in app code.
-- auth_is_master() resolves the caller itself, so no (SELECT auth.uid())
-- wrap is needed here.

ALTER TABLE public.tenant_email_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_email_domains_select ON public.tenant_email_domains
  FOR SELECT TO authenticated
  USING (private.auth_is_master());

CREATE POLICY tenant_email_domains_deny_writes ON public.tenant_email_domains
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);
