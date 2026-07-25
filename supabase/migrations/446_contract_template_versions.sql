-- 446: CONTRACTS-TPLVER.1 — contract template version history.
--
-- PATCH /api/contract-templates/[id] has always bumped `version` when
-- `body_markdown` changes (mig 106), but the OLD body was simply
-- overwritten — history was write-only. This adds a snapshot table so
-- the old body/variables are archived BEFORE each overwrite, making
-- the history viewable (not just inferable from the version counter).
--
-- Writes are service-role only (the PATCH route archives the current
-- row via .upsert() before updating contract_templates), so there are
-- no insert/update/delete RLS policies here — mirrors the read-only
-- audit-trail pattern used elsewhere (e.g. mig 035 impersonation_log).

create table public.contract_template_versions (
  id                uuid primary key default gen_random_uuid(),
  template_id       uuid not null references public.contract_templates(id) on delete cascade,
  version           integer not null,
  body_markdown     text not null,
  variables_schema  jsonb not null default '[]'::jsonb,
  changed_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  unique (template_id, version)
);

-- The unique index on (template_id, version) already services lookups
-- ordered by version; no separate index needed for `version desc`
-- since Postgres can scan a btree in either direction.

comment on table public.contract_template_versions is
  'Snapshot of a contract_templates row taken immediately before each body_markdown overwrite (CONTRACTS-TPLVER.1 mig 446). Archived by the PATCH /api/contract-templates/[id] route, service-role only — no insert/update/delete RLS policies.';
comment on column public.contract_template_versions.template_id is
  'Parent template. on delete cascade — history has no independent value once the template itself is gone.';
comment on column public.contract_template_versions.version is
  'The version number the archived row HAD at the time it was overwritten (i.e. the OLD contract_templates.version, not the new one). Paired unique with template_id so a re-run of the archive upsert is idempotent (ignoreDuplicates).';
comment on column public.contract_template_versions.body_markdown is
  'The body_markdown value as it stood immediately before the overwrite.';
comment on column public.contract_template_versions.variables_schema is
  'The variables_schema value as it stood immediately before the overwrite.';
comment on column public.contract_template_versions.changed_by is
  'Who triggered the PATCH that caused this row to be archived (the actor at overwrite time, not necessarily who originally authored the body).';

-- =============================================================
-- RLS — contract_template_versions
-- =============================================================
-- Read-only for the same populations that can read the parent
-- template (mig 106 / consolidated in mig 167): master, or an owner
-- of the template's organization. No insert/update/delete policies —
-- only the service-role PATCH route writes here, and service role
-- bypasses RLS entirely, so there is nothing for a mutation policy
-- to authorise.

alter table public.contract_template_versions enable row level security;

create policy "contract_template_versions_read"
  on public.contract_template_versions
  for select
  to authenticated
  using (
    private.auth_is_master()
    or exists (
      select 1
      from public.contract_templates ct
      where ct.id = contract_template_versions.template_id
        and ct.organization_id in (
          select l.organization_id
          from public.profile_locations pl
          join public.locations l on l.id = pl.location_id
          where pl.profile_id = (select auth.uid())
            and pl.role = 'owner'
        )
    )
  );
