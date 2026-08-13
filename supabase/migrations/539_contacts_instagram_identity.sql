-- 539 — Instagram identity on contacts (IG-LINK).
--
-- Instagram hands us no phone or email: only an opaque per-app user id
-- (IGSID), a handle, and a display name. So the durable link between an
-- Instagram thread and a CRM contact is the IGSID, stored here once and
-- reused forever after — one human decision per person, then automatic.
--
-- instagram_igsid  = machine key. Stable per (app, user); survives handle
--                    changes. This is what inbound matches on.
-- instagram_handle = human-readable, for display/search. Handles CAN change,
--                    so it is never the matching key.
alter table contacts
  add column if not exists instagram_igsid text,
  add column if not exists instagram_handle text;

-- Scoped to location, deliberately NOT global. Contacts are per-location, so
-- one person at two studios is two rows and a global unique index would make
-- the second studio's link fail. That is exactly the contacts_email_unique
-- (mig 008) trap, which 500s location-scoped capture for anyone already known
-- at another location.
create unique index if not exists idx_contacts_instagram_igsid_loc
  on contacts (location_id, instagram_igsid)
  where instagram_igsid is not null;

create index if not exists idx_contacts_instagram_handle
  on contacts (lower(instagram_handle))
  where instagram_handle is not null;

comment on column contacts.instagram_igsid is
  'Instagram-scoped user id (IGSID) of this contact''s IG account — the durable key inbound DMs match on to auto-link a thread to this contact (IG-LINK, mig 539). Unique per location, not globally.';
comment on column contacts.instagram_handle is
  'Instagram @handle for display/search. Handles can change — never match on this, use instagram_igsid (IG-LINK, mig 539).';
