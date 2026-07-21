-- ============================================================
-- 432: tenant_domains.location_id — OPTIONAL per-location scoping
--
-- File-only mirror (apply via Supabase MCP apply_migration); replayed
-- for fresh envs.
--
-- A tenant_domains row (mig 415) links a custom hostname to an
-- ORGANIZATION. This adds an OPTIONAL location_id so a hostname can be
-- scoped to a SINGLE studio inside that org: when set, strays on that
-- hostname land on that specific studio's public welcome page
-- (/welcome/<public_path>) instead of the org's studio chooser
-- (resolveTenantLocationId + publicWelcomePathForLocation drive this;
-- see src/lib/tenant-domains-edge.js and src/lib/welcome-front-page.js).
--
-- NULLABLE, and NULL is the whole-organisation default — i.e. TODAY'S
-- EXACT BEHAVIOUR. Every existing row is (and stays) whole-org, so
-- there is NOTHING to backfill and no routing changes for any current
-- hostname. The per-location branch is inert until a row carries a
-- location_id.
--
-- ON DELETE CASCADE: if the scoped location is deleted the domain row
-- goes with it (a location-scoped domain has no meaning without its
-- studio; the operator re-adds it against another location if needed).
--
-- The app validates that the chosen location belongs to the row's
-- organization at write time (POST/PATCH in
-- src/app/api/admin/tenant-domains); no DB-level cross-column CHECK is
-- added (Postgres can't express a two-table CHECK without a trigger,
-- and the master-only admin API is the single writer).
-- ============================================================

ALTER TABLE public.tenant_domains
  ADD COLUMN location_id UUID REFERENCES public.locations(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.tenant_domains.location_id IS
  'OPTIONAL per-location scoping (mig 432). NULL = whole organisation = the original mig-415 behaviour (strays land on the org studio chooser at /welcome). When set, the hostname is scoped to this ONE studio and strays land on that studio''s public welcome page (/welcome/<public_path>). The location must belong to organization_id — enforced in the master-only admin API, not by a DB constraint. ON DELETE CASCADE with the location.';

-- FK index (nullable — indexes only the location-scoped rows).
CREATE INDEX ix_tenant_domains_location_id
  ON public.tenant_domains (location_id)
  WHERE location_id IS NOT NULL;
