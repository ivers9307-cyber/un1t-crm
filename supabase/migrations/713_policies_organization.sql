-- 713 — W0.5: policies belong to an ORGANISATION.
--
-- WHY. policies / policy_versions had no tenant column: every signed-in
-- user on the platform was shown UN1T's employee handbook, acceptable-use
-- policy and staff privacy notice (mig 178 seed), and could not replace
-- them. The SaaS review of 2026-10-09 listed this as a blocker.
--
-- WHAT. organization_id on policies, backfilled to UN1T Group (the only
-- org that ever authored policies), then NOT NULL. slug uniqueness becomes
-- per organisation so each tenant can own an 'employee-handbook'. The
-- authenticated SELECT policies are narrowed to the caller's organisations
-- (private.auth_is_in_organization, mig 079) or master. Service-role code
-- (src/lib/policies.js) filters the same way. Safe before the code deploys:
-- old code reads all rows exactly as before.

alter table public.policies
  add column if not exists organization_id uuid references public.organizations(id);

update public.policies
   set organization_id = 'f117b7b8-5f56-4f80-8299-2c698242e4d2'
 where organization_id is null;

alter table public.policies alter column organization_id set not null;

alter table public.policies drop constraint if exists policies_slug_key;
create unique index if not exists policies_org_slug_key
  on public.policies (organization_id, slug);
create index if not exists policies_org_active_idx
  on public.policies (organization_id, active, display_order, title) where active = true;

comment on column public.policies.organization_id is
  'W0.5 (mig 713) — owning organisation. Staff see only their organisations'' policies.';

-- RLS: browser reads are rare — the lib uses the service role — but the
-- deny must exist at the DB too.
drop policy if exists policies_read_all on public.policies;
create policy policies_read_in_org on public.policies
  for select to authenticated
  using (private.auth_is_master() or private.auth_is_in_organization(organization_id));

drop policy if exists policy_versions_read_all on public.policy_versions;
create policy policy_versions_read_in_org on public.policy_versions
  for select to authenticated
  using (exists (
    select 1 from public.policies p
     where p.id = policy_versions.policy_id
       and (private.auth_is_master() or private.auth_is_in_organization(p.organization_id))));
