-- GYMPASS.1 — capture the Gympass (Wellhub) linkage on the contact.
--
-- Gympass check-ins reach Glofox via the same aggregator integration
-- account that books ClassPass, and carry NO per-booking source. The
-- reliable marker is on the MEMBER profile: member.metadata.gympass = { id }
-- (live-probed 2026-07-20). The Glofox member sync (extractMemberProfile)
-- now lifts that id onto contacts.gympass_member_id — presence = an active
-- Gympass user, and the id is retained for future Wellhub-side reconciliation.
--
-- Populated on the SHARED detail write-path (glofox-attendance-refresh cron
-- + MEMBER_* webhook re-fetch); the bulk LIST sync omits member.metadata so
-- it never clears a captured id (GLOFOX_DETAIL_KEYS presence-guard).
alter table public.contacts
  add column if not exists gympass_member_id text;

comment on column public.contacts.gympass_member_id is
  'Gympass (Wellhub) member id from Glofox member.metadata.gympass.id. Non-null = Gympass user. Populated by the Glofox member sync (GYMPASS.1, mig 429).';

-- Partial index backing the "Gympass Member exists" audience segment
-- (contacts are location-scoped + filtered to gympass_member_id not null).
create index if not exists idx_contacts_gympass_member
  on public.contacts (location_id)
  where gympass_member_id is not null;
