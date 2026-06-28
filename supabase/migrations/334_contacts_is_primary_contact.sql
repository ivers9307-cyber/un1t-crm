-- 334 — contacts.is_primary_contact: the "one row per person" lookup flag
--
-- CONTACT-DEDUP (lookup-only). Person-groups (mig 270) link a real person's
-- several contacts non-destructively, but the contacts LIST + SEARCH still
-- show every linked row → duplicate clutter when looking someone up. This
-- denormalised flag lets the human lookup surfaces filter to one row per
-- person (the group primary) with a single, paginatable predicate — same
-- trigger-denorm pattern as contacts.person_group_id / email_marketing.
--
-- Semantics: is_primary_contact = TRUE unless the contact is a NON-primary
-- member of a person_group. So: ungrouped → true, group primary → true,
-- group non-primary → false. Lookup surfaces filter `is_primary_contact`;
-- REACH surfaces (audience/broadcast/sequence) deliberately do NOT — a
-- linked person is still reached on all their channels.
--
-- Nothing is deleted; this is purely a display/query flag and is fully
-- reversible (drop the column).

alter table public.contacts
  add column if not exists is_primary_contact boolean not null default true;

-- Backfill: every non-primary group member → false.
update public.contacts c
set is_primary_contact = false
from public.person_groups g
where c.person_group_id = g.id
  and g.primary_contact_id is distinct from c.id
  and c.is_primary_contact is distinct from false;

-- Partial index for the lookup query (primaries at a location), the common
-- read path for the deduped contacts list/search.
create index if not exists idx_contacts_primary_lookup
  on public.contacts(location_id)
  where is_primary_contact;

comment on column public.contacts.is_primary_contact is
  'CONTACT-DEDUP (mig 334) — denormalised: false ONLY when this contact is a non-primary member of a person_group; true for ungrouped contacts and group primaries. Human lookup surfaces (contacts list/search) filter on it to show one row per person; reach surfaces (audience/broadcast/sequence) ignore it (reach every channel). Maintained by private.sync_contact_person_group + private.sync_group_primary_flags.';

-- ── Trigger maintenance ──────────────────────────────────────────
-- 1. Extend the existing person_group_members denorm trigger to set BOTH
--    person_group_id and is_primary_contact in one pass.
create or replace function private.sync_contact_person_group() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'DELETE') then
    -- Left the group entirely → ungrouped → primary again.
    update public.contacts
      set person_group_id = null, is_primary_contact = true
      where id = old.contact_id;
    return old;
  end if;
  update public.contacts c
    set person_group_id = new.group_id,
        is_primary_contact = exists (
          select 1 from public.person_groups g
          where g.id = new.group_id and g.primary_contact_id = c.id
        )
    where c.id = new.contact_id;
  return new;
end $$;

-- 2. New trigger on person_groups: when the primary changes (set-primary,
--    re-derive on link/unlink, or group creation), flip the flags. The old
--    primary drops to false ONLY if it is still a member of THIS group; the
--    new primary becomes true.
create or replace function private.sync_group_primary_flags() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'INSERT') then
    update public.contacts set is_primary_contact = true
      where id = new.primary_contact_id;
  elsif (tg_op = 'UPDATE' and new.primary_contact_id is distinct from old.primary_contact_id) then
    update public.contacts set is_primary_contact = false
      where id = old.primary_contact_id and person_group_id = new.id;
    update public.contacts set is_primary_contact = true
      where id = new.primary_contact_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_sync_group_primary_flags on public.person_groups;
create trigger trg_sync_group_primary_flags
  after insert or update on public.person_groups
  for each row execute function private.sync_group_primary_flags();
