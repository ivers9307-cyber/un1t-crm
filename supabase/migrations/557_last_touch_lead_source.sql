-- FUNNEL.5 — record the channel that brought someone back, not only the one
-- that first found them.
--
-- contacts.lead_source is stamped FIRST-TOUCH and only first-touch:
--   .update({ lead_source }).eq('id', contactId).is('lead_source', null)
-- (api/public/class-booking, api/public/leads). Once set it never changes
-- again, which is correct for attribution of the original acquisition and
-- useless for anything after it.
--
-- Measured 2026-08-20, the evening the 3-Class Trial sequence went out: 12
-- people came back through /start and booked a class. All 12 kept their
-- original lead_source ('other' / 'website'). Nowhere in the database does it
-- say the email brought them back. Ask "which channel drove last night's
-- bookings" and the honest answer was that we could not tell.
--
-- Deliberately a SEPARATE PAIR rather than making lead_source last-touch:
-- first-touch attribution is load-bearing for the ads reporting
-- (ADS-REPORT.2 stamps ad_external_id the same stamp-if-null way, and the
-- funnel spend numbers rest on it). Overwriting it would silently rewrite
-- history every time someone re-engaged. Two fields, two questions: where did
-- they come from, and what brought them back this time.
--
-- Nullable, no backfill. NULL means "we only ever saw them once", which is
-- true of every contact until they re-engage.

alter table public.contacts
  add column if not exists last_lead_source    text,
  add column if not exists last_lead_source_at timestamptz;

comment on column public.contacts.last_lead_source is
  'FUNNEL.5 — LAST-touch acquisition channel, stamped on every public funnel entry '
  '(unlike lead_source, which is stamp-if-null and therefore first-touch forever). NULL '
  'means this contact has only ever entered once, so lead_source already answers it. '
  'Never read this for original-acquisition attribution — that is lead_source, and the '
  'ads spend reporting depends on it staying first-touch.';

comment on column public.contacts.last_lead_source_at is
  'FUNNEL.5 — when last_lead_source was last stamped, i.e. the most recent time this '
  'contact entered a public funnel. Pairs with last_lead_source so "came back in the '
  'last 30 days via X" is answerable without joining anything.';

create index if not exists idx_contacts_last_lead_source_at
  on public.contacts (location_id, last_lead_source_at desc)
  where last_lead_source_at is not null;
