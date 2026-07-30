-- HOST-MASTER.1 — host leads live on the org's MASTER location (Stillorgan
-- for UN1T Group) instead of the host anchor location, and are exempt from
-- AUTOMATIC sequence/automation enrolment (manual enrolment ignores the flag).
alter table organizations
  add column if not exists master_location_id uuid references locations(id);
comment on column organizations.master_location_id is
  'HOST-MASTER.1 — where host-sourced contacts are placed/matched. NULL = fall back to the host anchor location (pre-master behaviour).';

update organizations o
   set master_location_id = 'a0000000-0000-0000-0000-000000000001'
 where o.id = (select organization_id from locations where id = 'a0000000-0000-0000-0000-000000000001')
   and o.master_location_id is null;

alter table contacts
  add column if not exists automations_exempt boolean not null default false;
comment on column contacts.automations_exempt is
  'HOST-MASTER.1 — blocks AUTOMATIC sequence/automation enrolment only (enrolContacts sourceType != manual). Manual staff enrolment includes them. Set on host-sourced contact CREATION; never set on matched existing contacts.';

create index if not exists idx_contacts_automations_exempt
  on contacts (id) where automations_exempt;
