-- 271_person_link_suggestions.sql — duplicate-contact detection queue (PERSON-LINK.2)
create table public.person_link_suggestions (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  -- canonical ordering: contact_id_a < contact_id_b (enforced by the writer) so the
  -- unique constraint dedupes A↔B and B↔A to one row.
  contact_id_a uuid not null references public.contacts(id) on delete cascade,
  contact_id_b uuid not null references public.contacts(id) on delete cascade,
  match_method text not null check (match_method in ('phone','name','email','manual')),
  confidence text not null check (confidence in ('high','medium','low')),
  reason text,
  status text not null default 'pending' check (status in ('pending','linked','dismissed')),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id_a, contact_id_b)
);
create index idx_pls_location_status on public.person_link_suggestions(location_id, status);

alter table public.person_link_suggestions enable row level security;
create policy pls_loc on public.person_link_suggestions for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));
