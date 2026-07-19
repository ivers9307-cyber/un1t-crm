-- ============================================================
-- 415: tenant_domains — DB-driven domain→tenant mapping (SAAS-8)
--
-- Applied to prod via Supabase MCP (apply_migration); this file
-- mirrors it for history and fresh-env replay.
--
-- The brand registry in src/lib/brands.js maps hostnames to brand
-- behaviour (allowlist + root/fallback handling) but is in-code:
-- onboarding a new tenant's domain historically meant a deploy.
-- This table is the DB tier behind that registry — the proxy
-- (src/proxy.js) consults it ONLY when the in-code registry
-- misses, via a ~5-minute in-memory cache in
-- src/lib/tenant-domains-edge.js. A new tenant's marketing or
-- payment domain is now one row here: point DNS at the
-- deployment, insert the row, done — no code change, no deploy.
--
-- DO NOT SEED the existing hostnames (crm.un1tdublin.com,
-- un1tdublin.com / www.un1tdublin.com, pay.ccfautos.com,
-- host.un1tdublin.com). The in-code BRANDS registry remains the
-- authoritative FIRST tier for them (and the CRM hostname is the
-- registry's implicit default): the proxy never reaches this
-- table for a hostname the registry resolves, so a row for one of
-- those would be dead data at best and dual-source drift at
-- worst. The admin API refuses to create such rows for the same
-- reason.
--
-- organization_id is the tenant linkage the in-code registry
-- never had: the SAAS-6/7 handoff sites (welcome-front-page.js
-- chooser, default-favicon.js) resolve "whose front page / whose
-- favicon" from the request host through this mapping (via
-- resolveTenantOrgId in tenant-domains-edge.js).
--
-- RLS: service role does all real reads/writes (the proxy + the
-- master-only admin routes). One permissive SELECT (master OR org
-- membership — an org admin can see their own domains through
-- RLS-bound clients); explicit master-only INSERT/UPDATE/DELETE —
-- never a FOR ALL alongside the SELECT
-- (multiple_permissive_policies, see mig 320).
-- ============================================================

CREATE TABLE public.tenant_domains (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored lowercase (CHECK-enforced); the resolver lowercases the
  -- incoming Host header before matching. No scheme, port, or path.
  hostname        TEXT NOT NULL UNIQUE CHECK (hostname = lower(hostname)),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  brand           JSONB NOT NULL DEFAULT '{}',
  -- Soft kill switch: inactive rows are invisible to the resolver,
  -- so the hostname falls through to the CRM auth gate (exactly
  -- like a hostname with no row) without losing the config.
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.tenant_domains IS
  'SAAS-8 (mig 415): DB tier of the multi-brand hostname registry. Consulted by src/proxy.js via tenant-domains-edge.js ONLY when the in-code BRANDS registry (src/lib/brands.js) misses — the three live hostnames stay in-code and must NOT be seeded here. One active row = the hostname routes as a tenant brand (allowlist + root/fallback handling) linked to an organization; no row = the hostname falls through to the CRM auth gate.';

COMMENT ON COLUMN public.tenant_domains.brand IS
  'Brand config consumed by src/lib/tenant-domains-edge.js, mirroring the BRANDS entry shape. Keys (all optional): description (text), allowedPaths (array of "/"-prefixed path prefixes), rootHandler ("reject"|"rewrite"), rootRewriteTo ("/path"), fallbackHandler ("reject"|"rewrite"), fallbackRewriteTo ("/path"). Missing keys default to the marketing shape: root "/" and disallowed paths rewrite to /welcome IN THE PROXY (DB brands cannot rely on the build-baked next.config host rewrites), allowedPaths ["/welcome","/book/","/event/","/api/public/","/api/webhooks/"]. Validated at write time by tenantDomainBrandConfigSchema (src/lib/schemas.js); the read side re-normalises defensively.';

COMMENT ON COLUMN public.tenant_domains.hostname IS
  'Bare lowercase hostname (CHECK-enforced), e.g. pay.example.com. UNIQUE — one brand per hostname.';

-- FK index (the hostname UNIQUE constraint provides its own).
CREATE INDEX ix_tenant_domains_organization_id
  ON public.tenant_domains (organization_id);

-- ─── RLS ─────────────────────────────────────────────────────────

ALTER TABLE public.tenant_domains ENABLE ROW LEVEL SECURITY;

-- Single permissive SELECT: master or org membership. Note
-- private.auth_is_in_organization already includes the master
-- branch; the explicit OR documents the two populations.
CREATE POLICY tenant_domains_select ON public.tenant_domains
  FOR SELECT
  TO authenticated
  USING (
    private.auth_is_master()
    OR private.auth_is_in_organization(organization_id)
  );

CREATE POLICY tenant_domains_ins ON public.tenant_domains
  FOR INSERT
  TO authenticated
  WITH CHECK (private.auth_is_master());

CREATE POLICY tenant_domains_upd ON public.tenant_domains
  FOR UPDATE
  TO authenticated
  USING (private.auth_is_master())
  WITH CHECK (private.auth_is_master());

CREATE POLICY tenant_domains_del ON public.tenant_domains
  FOR DELETE
  TO authenticated
  USING (private.auth_is_master());
