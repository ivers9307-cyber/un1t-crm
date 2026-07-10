-- HOST-EMAIL.1 — host contact lists + per-host email suppressions + sender identity.
--
-- host_contacts: a host's dedicated audience — people who took part in that
-- host's events (source='event') or joined their mailing list
-- (source='mailing_list'). Membership is broad; EMAILABILITY is enforced at
-- send time (marketing consent + suppression + bounce flags). Service-role only.
create table if not exists host_contacts (
  id              uuid primary key default gen_random_uuid(),
  host_id         uuid not null references event_hosts(id) on delete cascade,
  contact_id      uuid not null references contacts(id) on delete cascade,
  source          text not null check (source in ('event', 'mailing_list')),
  source_event_id uuid references race_events(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (host_id, contact_id)
);
alter table host_contacts enable row level security;
create index if not exists idx_host_contacts_host on host_contacts (host_id);

-- Per-host unsubscribe: suppressing one host's emails leaves UN1T marketing
-- and other hosts untouched (global opt-out + bounce flags are honored on top).
create table if not exists host_email_suppressions (
  id         uuid primary key default gen_random_uuid(),
  host_id    uuid not null references event_hosts(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (host_id, contact_id)
);
alter table host_email_suppressions enable row level security;
create index if not exists idx_host_suppressions_host on host_email_suppressions (host_id);

-- Sender identity: UN1T-allocated subdomain (<label>.mail.un1tdublin.com) via
-- the Postmark Domains API. Hosts cannot send until sender_domain_verified;
-- un-verifying is the per-host kill switch. slug backs the public /h/[slug]
-- mailing-list page (derived lazily in code when provisioning).
alter table event_hosts
  add column if not exists sender_domain text,
  add column if not exists sender_email text,
  add column if not exists sender_name text,
  add column if not exists sender_domain_verified boolean not null default false,
  add column if not exists postmark_domain_id bigint,
  add column if not exists email_daily_send_cap int not null default 2,
  add column if not exists slug text unique;

comment on table host_contacts is
  'HOST-EMAIL.1 — a host''s dedicated audience (event participants + mailing-list signups). Send-time consent applies; service-role only.';
comment on table host_email_suppressions is
  'HOST-EMAIL.1 — per-host unsubscribes. One host''s unsubscribe never affects UN1T or other hosts.';
