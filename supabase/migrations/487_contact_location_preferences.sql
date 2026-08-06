-- 487 — contact_location_preferences (LOCCOMMS.1, spec 2026-08-06).
--
-- Hatch Street is a standalone business sharing an org with Stillorgan, and
-- `contact_preferences` cannot express that: it carries UNIQUE (contact_id), so
-- there is exactly one set of marketing preferences per person for the whole
-- estate. Restoring the consent someone gave on the Hatch waitlist form also
-- re-subscribed them to Stillorgan, which they had opted out of.
--
-- This table makes the *communication relationship* per-location while the
-- contact stays shared. Nobody's contacts.location_id moves.
--
-- SEMANTICS — read this before writing any query against it:
--   Row ABSENT      = that location may NEVER send to this contact.
--   Row present     = they opted into that location; the booleans are the
--                     per-channel state within it.
--   All three false = joined, then unsubscribed (distinct from never joined).
-- Channels default true INSIDE a row because creating the row IS the opt-in act.
--
-- Nothing reads this table yet — the send paths cut over in LOCCOMMS PR 3.

create table contact_location_preferences (
  contact_id         uuid not null references contacts(id)  on delete cascade,
  location_id        uuid not null references locations(id) on delete cascade,
  email_marketing    boolean not null default true,
  sms_marketing      boolean not null default true,
  whatsapp_marketing boolean not null default true,
  subscribed_at      timestamptz not null default now(),
  source             text not null,
  unsubscribed_at    timestamptz,
  updated_at         timestamptz not null default now(),
  primary key (contact_id, location_id)
);

-- The send path filters by (location_id, channel); contact_id is already the
-- PK prefix so contact-keyed lookups are served by the primary key.
create index idx_clp_location on contact_location_preferences (location_id);

alter table contact_location_preferences enable row level security;

-- ONE permissive FOR ALL policy, mirroring contact_preferences_location_scoped.
-- Staff see only rows for locations they belong to. Service-role routes bypass
-- RLS entirely and enforce access in app code (see CLAUDE.md invariants).
-- Deliberately NOT a restrictive FOR ALL — that pattern denies SELECT too and
-- fails silently (mig 485).
create policy contact_location_preferences_location_scoped
  on contact_location_preferences
  as permissive for all to authenticated
  using (private.auth_is_in_location(location_id))
  with check (private.auth_is_in_location(location_id));

create trigger contact_location_preferences_updated_at
  before update on contact_location_preferences
  for each row execute function update_updated_at();

-- consent_log becomes location-aware. Nullable: existing rows predate the
-- per-location model and stay null.
alter table consent_log add column location_id uuid references locations(id);
create index idx_consent_log_location on consent_log (location_id);

comment on table contact_location_preferences is
  'LOCCOMMS.1 — per-location marketing consent. Row absent = that location may never send. Supersedes the marketing columns on contact_preferences.';

comment on column contact_preferences.location_id is
  'DECORATIVE. contact_preferences has UNIQUE(contact_id), so this column can never express per-location state — it is a denormalised copy of contacts.location_id and nothing reads it. Superseded by contact_location_preferences (mig 487). DO NOT DRIVE.';
