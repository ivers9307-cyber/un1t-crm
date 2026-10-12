-- 722 — HATCH-MEMBERS.1: memberships recorded outside Glofox.
--
-- WHY. Hatch Street sells its memberships on un1t.online, not Glofox
-- (locations.membership_source = 'none', mig 717). The CRM's only membership
-- signal was the Glofox mirror (contacts.glofox_membership_status, classified
-- into pipeline_stage_slug), so not one of Hatch's monthly members counted as
-- a member: event member pricing charged them the non-member fee (Sean Noble
-- workshop, 12 Oct 2026). Hatch's primary board is the manual Waitlist, so a
-- hand-written stage would also be overwritten by the next deal move
-- (sync_contacts_pipeline_stage_slug).
--
-- WHAT. One row per (contact, studio, source): the plan's name as the source
-- system calls it and whether it is active. Written by an operator-run import
-- of the un1t.online client export (source 'un1t_online_export'); a re-import
-- marks rows missing from the new file 'ended'. last_seen_at is the export
-- that last listed the membership. Read by event member pricing
-- (src/lib/member-validation.js) and the contact page.
--
-- Service role only: RLS on with no policy, nothing for anon/authenticated
-- (mig 677 default, stated explicitly).

create table if not exists public.contact_memberships (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  location_id     uuid        not null references public.locations(id) on delete cascade,
  contact_id      uuid        not null references public.contacts(id) on delete cascade,
  source          text        not null check (source in ('un1t_online_export')),
  plan_name       text        not null check (length(trim(plan_name)) > 0),
  status          text        not null default 'active' check (status in ('active', 'ended')),
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  ended_at        timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (contact_id, location_id, source),
  check ((status = 'ended') = (ended_at is not null))
);

create index if not exists contact_memberships_active_contact
  on public.contact_memberships (contact_id) where status = 'active';
create index if not exists contact_memberships_location
  on public.contact_memberships (location_id, status);

comment on table public.contact_memberships is
  'HATCH-MEMBERS.1 (mig 722): memberships held outside Glofox (today: Hatch Street on un1t.online, imported from its client export). Active rows count as members for event pricing (member-validation.js) and show on the contact page.';
comment on column public.contact_memberships.plan_name is
  'The plan as the source system names it, e.g. "Founding Membership — Unlimited".';
comment on column public.contact_memberships.last_seen_at is
  'When the export that last listed this membership was taken. A re-import that no longer lists it sets status = ended.';

alter table public.contact_memberships enable row level security;
revoke all on public.contact_memberships from anon, authenticated;
grant select, insert, update, delete on public.contact_memberships to service_role;

-- Self-check (POST-state). Anything else aborts the whole file.
do $$
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'contact_memberships' and c.relrowsecurity) then
    raise exception 'mig 722: contact_memberships missing or RLS off';
  end if;
  if exists (select 1 from information_schema.table_privileges
              where table_schema = 'public' and table_name = 'contact_memberships'
                and grantee in ('anon', 'authenticated')) then
    raise exception 'mig 722: a client role holds a privilege on contact_memberships';
  end if;
end $$;
