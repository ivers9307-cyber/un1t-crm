-- SEQSENDER.1 — let a sequence carry its own From/Reply-To, the way a campaign
-- already can.
--
-- A campaign has carried from_email / from_name / reply_to since it shipped, and
-- the estate uses them: live rows send as "Garrett Ivers" <garrett@un1tdublin.com>
-- and "Colm Mulryan" <Colm@un1tdublin.com>. A SEQUENCE has never had the option.
-- sendMarketingEmail (the only sender a sequence step uses) had no `from`
-- parameter at all, so every sequence email in the estate goes out as
-- process.env.POSTMARK_FROM_EMAIL — live, that renders as
-- "Richard" <accounts@mail.un1tdublin.com>.
--
-- That is fine for a system notice and wrong for the thing sequences are
-- actually used for. The 3-Class Trial sequence is ten emails written in the
-- first person, signed by a named coach, two of which ask the reader to hit
-- reply and answer a question. Arriving from an accounts@ address under someone
-- else's display name, that mail is incoherent — and the lead-conversion guide
-- it came from is explicit that a reply-seeking email sent from a generic
-- address collapses the reply rate it exists to produce.
--
-- The only sender override the code had before this (tenant_email_domains,
-- mig 427) is the wrong instrument twice over: it is keyed on organization_id
-- rather than location, so it would move UN1T Hatch Street, Test Studio and
-- Pride Training Club too; and it is only honoured when that org also has its
-- own Postmark server token (postmark.js resolveTenantOverride returns early
-- without one). It is empty today and stays empty.
--
-- Nullable with no default and no backfill: absent means "unchanged", so every
-- existing sequence keeps the global default it sends with today.

alter table public.email_sequences
  add column if not exists from_email text,
  add column if not exists from_name  text,
  add column if not exists reply_to   text;

comment on column public.email_sequences.from_email is
  'SEQSENDER.1 — envelope From for this sequence''s email steps. NULL = the global '
  'POSTMARK_FROM_EMAIL default (unchanged behaviour). Must be an address Postmark can '
  'send as on the CRM server: un1tdublin.com is DKIM-verified at the domain level, so '
  'any local-part on it works. An address Postmark rejects is NOT a soft failure — '
  'postmark.js throws on a non-2xx, which feeds sequence_enrollments.error_count and '
  'auto-pauses the enrolment at MAX_ERRORS (5). Verify before activating a sequence.';

comment on column public.email_sequences.from_name is
  'SEQSENDER.1 — display name paired with from_email ("Dean Nolan" <dean@...>). Ignored '
  'when from_email is NULL. The application builds this string itself (mirroring '
  'campaign-sender.js); Postmark does not stamp a signature name onto a bare address.';

comment on column public.email_sequences.reply_to is
  'SEQSENDER.1 — Reply-To for this sequence''s email steps. NULL keeps the existing '
  'EMAIL-INBOX.1 behaviour: the location''s default mailbox, so replies land in the '
  'unified inbox. Set it ONLY to route replies somewhere else deliberately — note that '
  'an address on a domain whose MX is not delegated to Postmark inbound (un1t.com and '
  'un1tdublin.com both point at Google Workspace) is delivered to that mailbox and the '
  'CRM never sees it, so no ticket is raised.';
