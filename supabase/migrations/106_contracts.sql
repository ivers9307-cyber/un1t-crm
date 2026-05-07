-- Digital staff/contractor contracts.
--
-- A master or owner issues a contract from a reusable template by
-- filling in any custom variables. The system pre-signs on the
-- employer side (issuer's typed name) and the recipient signs in
-- their portal with a typed name. Final state: a signed PDF stored
-- in Supabase Storage, viewable by the recipient and any
-- master/owner in the same organisation.
--
-- Tables
--   contract_templates  — reusable boilerplate with {{variable}} slots.
--                         Master/owner CRUDs these. Versioned via the
--                         simple `version` int (no separate history
--                         table — old templates stay active until
--                         deactivated, so issued contracts keep the
--                         exact body they were rendered against via
--                         contracts.body_rendered).
--   contracts           — one row per issued contract. Frozen body +
--                         variables_data + signature metadata. The
--                         signed PDF lives in Storage at
--                         contracts/<id>/signed.pdf.
--
-- Storage
--   bucket 'contracts' (private). Path: <contract_id>/signed.pdf
--   for the final dual-signed copy. Pre-signature drafts live only
--   in the database (body_rendered) — no PDF until the recipient
--   signs.
--
-- Legal note (eIDAS / Irish employment law)
--   Typed-name signature + IP/UA/timestamp audit trail = a 'simple
--   electronic signature' under eIDAS Article 25, legally valid
--   for employment contracts. The audit row + the timestamped PDF
--   together satisfy the written-record requirement under Irish
--   labour law (Terms of Employment (Information) Acts 1994-2014).

-- =============================================================
-- Tables
-- =============================================================

create table public.contract_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  name            text not null,
  description     text,
  -- Markdown source with {{variable}} placeholders. Stored as-is;
  -- the renderer handles substitution at issue time and freezes the
  -- result onto the contract row.
  body_markdown   text not null,
  -- Custom variables this template needs at issue time (beyond the
  -- profile-derived auto-fills). Shape:
  --   [
  --     { "key": "notice_period_weeks", "label": "Notice period (weeks)", "type": "number", "required": true },
  --     { "key": "commission_rate",     "label": "Commission rate %",     "type": "number", "required": false },
  --     { "key": "start_date",          "label": "Start date",            "type": "date",   "required": true }
  --   ]
  variables_schema jsonb not null default '[]'::jsonb,
  -- Filter by employment type so the issue wizard only shows
  -- relevant templates: 'fte' (full-time employee), 'contractor',
  -- or 'both' (works for either).
  employment_type text not null default 'both'
    check (employment_type in ('fte', 'contractor', 'both')),
  version         integer not null default 1,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.profiles(id)
);

create index contract_templates_org_active_idx
  on public.contract_templates (organization_id)
  where active = true;

create table public.contracts (
  id                 uuid primary key default gen_random_uuid(),
  template_id        uuid references public.contract_templates(id) on delete restrict,
  -- Recipient (the employee / contractor receiving the contract).
  profile_id         uuid not null references public.profiles(id) on delete restrict,
  -- Optional location anchor — useful for multi-location orgs where
  -- the contract is tied to one specific studio. Falls back to the
  -- profile's primary location at issue time.
  location_id        uuid references public.locations(id) on delete set null,
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  -- Frozen at issue time. variables_data holds the merged variable
  -- map (profile-derived + custom from issuer); body_rendered is
  -- the markdown after substitution. Both are immutable once the
  -- contract is issued — guarantees the recipient signs exactly
  -- what was shown to them.
  variables_data     jsonb not null default '{}'::jsonb,
  body_rendered      text not null,
  -- Status state machine:
  --   draft     → not used in MVP (we go straight to issued)
  --   issued    → sent to recipient, employer-side pre-signed
  --   viewed    → recipient opened it (audit only; sign is still pending)
  --   signed    → recipient signed; PDF generated; case closed
  --   declined  → recipient explicitly rejected (with reason)
  --   revoked   → issuer pulled it before signing (e.g. typo)
  status             text not null default 'issued'
    check (status in ('draft', 'issued', 'viewed', 'signed', 'declined', 'revoked')),
  -- Issuer side (master/owner who created the contract). Stored as
  -- a typed-name pre-signature so the recipient sees a fully-
  -- countersigned document rather than a one-sided form.
  issued_at          timestamptz not null default now(),
  issued_by          uuid not null references public.profiles(id) on delete restrict,
  issuer_signature   text not null,        -- typed name at issue time
  -- Recipient side
  viewed_at          timestamptz,
  signed_at          timestamptz,
  signed_ip          text,
  signed_user_agent  text,
  signature_method   text check (signature_method in ('typed', 'drawn')),
  signature_value    text,                  -- typed name (MVP) or canvas data url (future)
  signed_pdf_path    text,                  -- relative path inside the 'contracts' bucket
  -- Negative paths
  declined_at        timestamptz,
  declined_reason    text,
  revoked_at         timestamptz,
  revoked_by         uuid references public.profiles(id),
  revoked_reason     text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index contracts_profile_idx     on public.contracts (profile_id);
create index contracts_org_idx         on public.contracts (organization_id);
create index contracts_status_idx      on public.contracts (status);
-- Common dashboard query: "show me unsigned contracts for an org".
create index contracts_org_unsigned_idx
  on public.contracts (organization_id, issued_at desc)
  where status in ('issued', 'viewed');

-- =============================================================
-- updated_at triggers (re-using the existing convention)
-- =============================================================

create trigger contract_templates_set_updated_at
  before update on public.contract_templates
  for each row execute function public.update_updated_at();

create trigger contracts_set_updated_at
  before update on public.contracts
  for each row execute function public.update_updated_at();

-- =============================================================
-- Storage bucket for signed PDFs
-- =============================================================

insert into storage.buckets (id, name, public)
values ('contracts', 'contracts', false)
on conflict (id) do nothing;

-- =============================================================
-- RLS — contract_templates
-- =============================================================
-- Visibility: master sees all; owner sees their org's templates.
-- Mutation: master writes anywhere; owner writes their org only.
-- Other roles never see this table directly (the issue wizard
-- proxies template content via an authorised API route).

alter table public.contract_templates enable row level security;

create policy "Master manages all templates"
  on public.contract_templates
  for all
  to authenticated
  using (private.auth_is_master())
  with check (private.auth_is_master());

create policy "Owner manages org templates"
  on public.contract_templates
  for all
  to authenticated
  using (
    organization_id in (
      select l.organization_id
      from public.profile_locations pl
      join public.locations l on l.id = pl.location_id
      where pl.profile_id = (select auth.uid())
        and pl.role = 'owner'
    )
  )
  with check (
    organization_id in (
      select l.organization_id
      from public.profile_locations pl
      join public.locations l on l.id = pl.location_id
      where pl.profile_id = (select auth.uid())
        and pl.role = 'owner'
    )
  );

-- =============================================================
-- RLS — contracts
-- =============================================================
-- Recipient sees their own contracts (always, regardless of org).
-- Master sees all contracts.
-- Owner sees contracts in their org.
-- Mutations (insert/update/delete) are gated more tightly:
-- master/owner only — and route-level checks enforce the
-- specific transitions (only the recipient can move issued →
-- signed, only the issuer can revoke, etc.).

alter table public.contracts enable row level security;

create policy "Recipient reads own contracts"
  on public.contracts
  for select
  to authenticated
  using (profile_id = (select auth.uid()));

create policy "Master reads all contracts"
  on public.contracts
  for select
  to authenticated
  using (private.auth_is_master());

create policy "Owner reads org contracts"
  on public.contracts
  for select
  to authenticated
  using (
    organization_id in (
      select l.organization_id
      from public.profile_locations pl
      join public.locations l on l.id = pl.location_id
      where pl.profile_id = (select auth.uid())
        and pl.role = 'owner'
    )
  );

create policy "Master writes contracts"
  on public.contracts
  for all
  to authenticated
  using (private.auth_is_master())
  with check (private.auth_is_master());

create policy "Owner writes org contracts"
  on public.contracts
  for all
  to authenticated
  using (
    organization_id in (
      select l.organization_id
      from public.profile_locations pl
      join public.locations l on l.id = pl.location_id
      where pl.profile_id = (select auth.uid())
        and pl.role = 'owner'
    )
  )
  with check (
    organization_id in (
      select l.organization_id
      from public.profile_locations pl
      join public.locations l on l.id = pl.location_id
      where pl.profile_id = (select auth.uid())
        and pl.role = 'owner'
    )
  );

-- Recipient can update their OWN contract row to record a
-- signature or decline. The route enforces the specific status
-- transitions; this policy just enables the underlying UPDATE.
create policy "Recipient signs own contract"
  on public.contracts
  for update
  to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

-- =============================================================
-- Storage RLS for the contracts bucket
-- =============================================================
-- Authenticated read for the recipient and any master/owner in
-- the same org. Writes are server-side via service-role only
-- (the API route generates the PDF and uploads it; users never
-- upload to this bucket directly), so we don't add an INSERT
-- policy — service role bypasses RLS and that's intentional.

create policy "Recipient reads own signed PDF"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'contracts'
    and exists (
      select 1 from public.contracts c
      where c.profile_id = (select auth.uid())
        and (storage.foldername(name))[1] = c.id::text
    )
  );

create policy "Master reads all signed PDFs"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'contracts'
    and private.auth_is_master()
  );

create policy "Owner reads org signed PDFs"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'contracts'
    and exists (
      select 1 from public.contracts c
      where (storage.foldername(name))[1] = c.id::text
        and c.organization_id in (
          select l.organization_id
          from public.profile_locations pl
          join public.locations l on l.id = pl.location_id
          where pl.profile_id = (select auth.uid())
            and pl.role = 'owner'
        )
    )
  );

comment on table public.contract_templates is 'Reusable contract boilerplate with {{variable}} placeholders. Master/owner CRUD only. Mig 106.';
comment on table public.contracts is 'Issued contracts. Frozen body + variables. Status flow issued → signed/declined/revoked. Mig 106.';
