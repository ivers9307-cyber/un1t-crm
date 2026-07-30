-- HOST-GROWTH.B — host-customisable /h/[slug] signup-page copy + a
-- 'mailing_list' audience for host campaigns.
--
-- Copy columns are nullable; NULL renders the built-in default wording
-- (operator-editable-copy rule: settings field + default fallback — the
-- host is the operator of their own page).
alter table event_hosts
  add column if not exists list_headline text,
  add column if not exists list_blurb text,
  add column if not exists list_button_label text,
  add column if not exists list_success_message text;

comment on column event_hosts.list_headline is 'HOST-GROWTH.B — /h/[slug] headline override; NULL = host name.';
comment on column event_hosts.list_blurb is 'HOST-GROWTH.B — /h/[slug] blurb override; NULL = default copy.';
comment on column event_hosts.list_button_label is 'HOST-GROWTH.B — /h/[slug] submit button label; NULL = "Join the list".';
comment on column event_hosts.list_success_message is 'HOST-GROWTH.B — /h/[slug] post-signup message; NULL = default copy.';

-- audience_event_id is a uuid FK, so the mailing-list audience needs its own
-- discriminator. Backfill BEFORE the check constraint so legacy per-event
-- drafts satisfy it.
alter table host_campaigns
  add column if not exists audience_kind text not null default 'all';

update host_campaigns set audience_kind = 'event' where audience_event_id is not null;

alter table host_campaigns
  add constraint host_campaigns_audience_kind_check
  check (audience_kind in ('all', 'event', 'mailing_list'));

comment on column host_campaigns.audience_kind is
  'HOST-GROWTH.B — all | event (uses audience_event_id) | mailing_list (host_contacts.source=mailing_list only).';
