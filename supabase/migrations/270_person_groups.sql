-- 270_person_groups.sql — non-destructive identity linking (PERSON-LINK.1)
create table public.person_groups (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  primary_contact_id uuid not null references public.contacts(id) on delete restrict,
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_person_groups_location on public.person_groups(location_id);

create table public.person_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.person_groups(id) on delete cascade,
  contact_id uuid not null unique references public.contacts(id) on delete cascade,
  match_method text not null check (match_method in ('manual','phone','name','email')),
  confidence text not null check (confidence in ('manual','high','medium','low')),
  added_by uuid references public.profiles(id),
  added_at timestamptz not null default now()
);
create index idx_pgm_group on public.person_group_members(group_id);

-- Denormalised pointer (mirrors the contacts.email_marketing / pipeline_stage_slug
-- pattern) so the unified view + outreach dedup are single-table queries.
alter table public.contacts add column person_group_id uuid references public.person_groups(id) on delete set null;
create index idx_contacts_person_group on public.contacts(person_group_id) where person_group_id is not null;

create or replace function private.sync_contact_person_group() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'DELETE') then
    update public.contacts set person_group_id = null where id = old.contact_id;
    return old;
  end if;
  update public.contacts set person_group_id = new.group_id where id = new.contact_id;
  return new;
end $$;
create trigger trg_sync_contact_person_group
  after insert or update or delete on public.person_group_members
  for each row execute function private.sync_contact_person_group();

alter table public.person_groups enable row level security;
alter table public.person_group_members enable row level security;
create policy person_groups_loc on public.person_groups for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));
create policy pgm_loc on public.person_group_members for all to authenticated
  using (exists (select 1 from public.person_groups g where g.id = group_id and private.auth_is_in_location(g.location_id)))
  with check (exists (select 1 from public.person_groups g where g.id = group_id and private.auth_is_in_location(g.location_id)));
