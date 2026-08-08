-- 489 — keep contact_location_preferences in step with contact_preferences
-- (LOCCOMMS.2). Closes the PR1 -> PR3 drift window.
--
-- Without this, every opt-out between mig 488 and the PR 3 cutover lands ONLY
-- in contact_preferences, and the cutover would silently re-subscribe those
-- people. Contacts created in the window would get no location row at all and
-- become permanently unreachable (row absent = never send).
--
-- Triggers, not app-level dual-write: contact_preferences has EIGHT writers
-- (preference centre, unsubscribe link, staff edit, bulk import, the shared
-- helper, WA keyword, Mia follow-ups) and one of them —
-- auto_unsubscribe_classpass — is itself a database trigger that no amount of
-- JavaScript can intercept. One trigger catches all eight, permanently.
--
-- THE ONE-DIRECTIONAL RULE, and it is deliberate:
--   channel -> FALSE  propagates to ALL of that contact's location rows
--   channel -> TRUE   propagates ONLY to the row at contacts.location_id
-- Until PR 4 makes unsubscribe per-location, the unsubscribe link is global and
-- means "stop emailing me" — that must reach every location. A global opt-in
-- says nothing about a gym the person has never dealt with, so it must not
-- manufacture consent there. Off is safe to broadcast; on is not.

-- 1. New contacts get a location row, mirroring create_contact_preferences.
--    Without this a contact created after mig 488 has no row, and row-absent
--    means no location may ever send to them.
create or replace function create_contact_location_preferences()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.location_id is not null then
    insert into contact_location_preferences
      (contact_id, location_id, source)
    values (new.id, new.location_id, 'contact_created')
    on conflict (contact_id, location_id) do nothing;
  end if;
  return new;
end;
$$;

-- Named to sort BEFORE contact_preferences_trigger, so the location row exists
-- by the time the preferences row is created and the sync trigger below fires.
-- Postgres runs same-event triggers in name order.
create trigger contact_location_preferences_create_trigger
  after insert on contacts
  for each row execute function create_contact_location_preferences();

-- 2. Propagate preference changes.
create or replace function sync_contact_location_preferences()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  own_location uuid;
begin
  select location_id into own_location from contacts where id = new.contact_id;

  -- OFF propagates everywhere.
  if coalesce(new.email_marketing, true) = false then
    update contact_location_preferences
       set email_marketing = false, updated_at = now()
     where contact_id = new.contact_id and email_marketing is distinct from false;
  end if;

  if coalesce(new.sms_marketing, true) = false then
    update contact_location_preferences
       set sms_marketing = false, updated_at = now()
     where contact_id = new.contact_id and sms_marketing is distinct from false;
  end if;

  if coalesce(new.whatsapp_marketing, true) = false then
    update contact_location_preferences
       set whatsapp_marketing = false, updated_at = now()
     where contact_id = new.contact_id and whatsapp_marketing is distinct from false;
  end if;

  -- ON propagates only to their own location, and only if that row exists.
  -- Deliberately does NOT create a row: an opt-in recorded globally is not
  -- evidence that they joined that location's list.
  if own_location is not null then
    update contact_location_preferences
       set email_marketing    = coalesce(new.email_marketing, true),
           sms_marketing      = coalesce(new.sms_marketing, true),
           whatsapp_marketing = coalesce(new.whatsapp_marketing, true),
           updated_at         = now()
     where contact_id = new.contact_id
       and location_id = own_location
       and (email_marketing    is distinct from coalesce(new.email_marketing, true)
         or sms_marketing      is distinct from coalesce(new.sms_marketing, true)
         or whatsapp_marketing is distinct from coalesce(new.whatsapp_marketing, true));
  end if;

  return new;
end;
$$;

create trigger sync_contact_location_preferences_trigger
  after insert or update on contact_preferences
  for each row execute function sync_contact_location_preferences();

-- 3. Catch-up for anything that happened between mig 488 and this migration.
--    Same shape as 488 step 1, so it is safe to run repeatedly.
insert into contact_location_preferences
  (contact_id, location_id, email_marketing, sms_marketing, whatsapp_marketing,
   subscribed_at, source)
select
  c.id, c.location_id,
  coalesce(p.email_marketing, true) and c.email_status is distinct from 'unsubscribed',
  coalesce(p.sms_marketing, true),
  coalesce(p.whatsapp_marketing, true),
  coalesce(p.created_at, c.created_at, now()),
  'migration'
from contacts c
left join contact_preferences p on p.contact_id = c.id
where c.location_id is not null
on conflict (contact_id, location_id) do nothing;

-- 4. And correct any row that drifted OFF while we had no trigger. One
--    directional: this may only turn channels off, never on.
update contact_location_preferences clp
   set email_marketing = false, updated_at = now()
  from contacts c
 where c.id = clp.contact_id
   and c.email_marketing = false
   and clp.email_marketing = true
   and clp.source = 'migration';

do $$
declare missing int; drifted int;
begin
  select count(*) into missing from contacts c
   where c.location_id is not null
     and not exists (select 1 from contact_location_preferences clp
                      where clp.contact_id = c.id and clp.location_id = c.location_id);

  select count(*) into drifted from contacts c
    join contact_location_preferences clp
      on clp.contact_id = c.id and clp.location_id = c.location_id and clp.source='migration'
   where c.email_marketing = false and clp.email_marketing = true;

  if missing > 0 then
    raise exception 'LOCCOMMS.2 FAILED: % contacts still have no row at their own location', missing;
  end if;
  if drifted > 0 then
    raise exception 'LOCCOMMS.2 FAILED: % contacts opted out globally still show opted in at their own location', drifted;
  end if;
  raise notice 'LOCCOMMS.2 sync triggers installed; drift cleared';
end $$;
