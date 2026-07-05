-- RCOV — scope hunt inboxes per location. recon_mailboxes was built
-- GLOBAL (the hunt searched every inbox for every location's lines),
-- which breaks the estate's per-location independence standard AND
-- leaks across entities: a SourceIt bank line could be matched against
-- a Stillorgan inbox. Each location now owns its own inboxes.
--
-- The 3 existing rows were all created under UN1T Stillorgan's
-- accounting view, so they backfill to Stillorgan; move/re-add per
-- location as needed.
alter table recon_mailboxes add column location_id uuid references locations(id);
update recon_mailboxes set location_id = 'a0000000-0000-0000-0000-000000000001' where location_id is null;
alter table recon_mailboxes alter column location_id set not null;

-- Uniqueness was global on email; make it per-location so the same
-- inbox can be added independently to more than one location.
alter table recon_mailboxes drop constraint recon_mailboxes_email_key;
alter table recon_mailboxes add constraint recon_mailboxes_location_email_key unique (location_id, email);
create index if not exists recon_mailboxes_location_idx on recon_mailboxes(location_id);
