-- HOST-CONSENT.1 — host marketing becomes its own consent domain.
--
-- WHY. A host's marketing send read the UN1T-wide contacts.email_marketing
-- flag and rode Postmark's shared `broadcast` stream, so a UN1T unsubscribe
-- (or a Postmark suppression from a UN1T campaign) silently blocked the host,
-- and a host-list signup re-granted UN1T consent. Measured 6 Sep 2026: 47 of
-- the only host's 179 contacts were unreachable, none of whom had left the
-- host's list. Richard's decision: two INDEPENDENT consents, stated on the
-- form; each host sends on its own Postmark stream.
--
-- host_email_suppressions stays the per-host revocation record. Consent true
-- + no suppression row = mailable by that host, subject to mailbox facts.

alter table host_contacts
  add column if not exists marketing_consent boolean not null default false,
  add column if not exists marketing_consented_at timestamptz,
  add column if not exists marketing_consent_source text;

alter table host_contacts
  drop constraint if exists host_contacts_marketing_consent_source_check;
alter table host_contacts
  add constraint host_contacts_marketing_consent_source_check
  check (marketing_consent_source is null or marketing_consent_source in
    ('mailing_list_form', 'event_form', 'backfill_2026_09', 'host_resubscribe'));

-- consent_log gains a host scope. Existing rows keep host_id NULL.
alter table consent_log add column if not exists host_id uuid references event_hosts(id) on delete cascade;
create index if not exists idx_consent_log_host on consent_log (host_id) where host_id is not null;

-- The channel vocabulary CHECK (live in prod) must admit the host channel.
alter table consent_log drop constraint if exists consent_log_channel_vocabulary;
alter table consent_log add constraint consent_log_channel_vocabulary
  check (channel in ('email_marketing', 'email_administrative', 'sms_marketing',
                     'sms_administrative', 'whatsapp_marketing', 'whatsapp_administrative',
                     'host_email_marketing'));

-- One Postmark Broadcasts stream per host (suppression lists are per stream).
-- NULL = marketing sending not set up; the send route fails closed on it.
alter table event_hosts add column if not exists postmark_stream_id text;
alter table event_hosts drop constraint if exists event_hosts_postmark_stream_id_check;
alter table event_hosts add constraint event_hosts_postmark_stream_id_check
  check (postmark_stream_id is null or postmark_stream_id ~ '^[a-z0-9][a-z0-9-]{0,63}$');

-- The register form's soft opt-in checkbox was applied to UN1T consent and
-- discarded. Persist it so the attendee sync can grant HOST consent when the
-- registration confirms. NULL = row written before this migration.
alter table race_registrations add column if not exists marketing_consent boolean;

-- Backfill: every existing membership came from a signup or a confirmed
-- booking that showed marketing copy. Members already in
-- host_email_suppressions LEFT the host's list: they stay consent=false.
update host_contacts hc
set marketing_consent = true,
    marketing_consented_at = hc.created_at,
    marketing_consent_source = 'backfill_2026_09'
where hc.marketing_consent = false
  and not exists (
    select 1 from host_email_suppressions s
    where s.host_id = hc.host_id and s.contact_id = hc.contact_id
  );

comment on column host_contacts.marketing_consent is
  'HOST-CONSENT.1 — consent to THIS host''s marketing. Independent of contacts.email_marketing (UN1T). Revocation = host_email_suppressions row.';
comment on column event_hosts.postmark_stream_id is
  'HOST-CONSENT.1 — the host''s own Postmark Broadcasts stream id (e.g. colm-events). NULL = marketing sending not set up; send route 409s.';
comment on column race_registrations.marketing_consent is
  'HOST-CONSENT.1 — the register form checkbox as submitted. NULL = pre-588 row.';
