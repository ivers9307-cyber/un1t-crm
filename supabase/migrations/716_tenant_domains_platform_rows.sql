-- 716 — W1.L1: every organisation owns a platform host <org.slug>.repset.ie.
--
-- WHY. Customer-facing links were minted on NEXT_PUBLIC_APP_URL (crm.repset.ie)
-- because no tenant had a hostname that resolved. Vercel now carries the
-- wildcard *.repset.ie (verified 2026-10-10) and DNS answers it, so a
-- tenant_domains row is all a hostname needs. One automatic row per org,
-- source='platform'; a tenant's own domain is a second row, source='custom',
-- and src/lib/tenant-host.js prefers custom over platform.
--
-- Safe before the code deploys: the proxy's DB tier already serves any
-- active row with the default public allowlist (tenant-domains-edge.js), so
-- un1t-group.repset.ie simply starts answering /welcome, /book/, /event/…
-- exactly as a hand-inserted row would have.
--
-- Pre-check (must return 0 rows — a slug that is not a DNS label cannot
-- become a host):
--   select slug from organizations where slug !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$';
-- Post-check:
--   select hostname, source from tenant_domains order by 1;
--   → ccf-autos.repset.ie, givers-consultancy.repset.ie, un1t-group.repset.ie, all 'platform'.

alter table public.tenant_domains
  add column if not exists source text not null default 'custom'
    check (source in ('platform', 'custom'));

comment on column public.tenant_domains.source is
  'W1.L1 (mig 716) — platform = the automatic <org.slug>.repset.ie row (one per org, never edited by hand); custom = a domain the tenant brought.';

-- One platform row per org. idempotent.
insert into public.tenant_domains (hostname, organization_id, brand, active, source)
select o.slug || '.repset.ie', o.id, '{}'::jsonb, o.active, 'platform'
  from public.organizations o
 where not exists (
   select 1 from public.tenant_domains t
    where t.organization_id = o.id and t.source = 'platform');

create unique index if not exists tenant_domains_one_platform_per_org
  on public.tenant_domains (organization_id) where source = 'platform';

-- No client privilege changes: mig 415's RLS (master + org membership SELECT)
-- already covers the new column; the proxy reads via the service role.
