-- INVOICEPREP.1 — make the invoice email ingest safe against lost emails.
--
-- Four additions:
--   1. invoices_queue keeps the email body text, so a row can be read and
--      prepared later without going back to the mail provider.
--   2. invoices_queue counts attachments the ingest skipped (unsupported
--      type, too large), so a skipped file is visible instead of silent.
--   3. invoices_queue records why a row was judged not to be an invoice.
--   4. invoice_inbound_strays records inbound emails that reach the ingest
--      address but match no studio, so they are kept rather than dropped.
--
-- Grant decision: invoices_queue already has a table-level grant to
-- authenticated under its read policy, so the three new columns are readable
-- by the same people who can already read the sender, subject and extracted
-- fields of that row; no narrower grant is made.
--
-- invoice_inbound_strays is closed to every client session: RLS on, all
-- privileges revoked, no policy. Only the service role reads or writes it.

set check_function_bodies = off;

alter table public.invoices_queue
  add column if not exists email_body_text text,
  add column if not exists skipped_attachment_count integer not null default 0,
  add column if not exists not_invoice_reason text;

-- Duplicate check is per studio (content_hash alone is not scoped).
create index if not exists invoices_queue_location_content_hash_idx
  on public.invoices_queue (location_id, content_hash) where content_hash is not null;

create table if not exists public.invoice_inbound_strays (
  id uuid primary key default gen_random_uuid(),
  -- Unique so a provider retry of the same email stores one row.
  email_message_id text not null unique,
  to_address text,
  from_address text,
  subject text,
  reason text not null check (reason in ('unparseable_recipient', 'unknown_slug')),
  slug text,
  received_at timestamptz not null default now()
);

alter table public.invoice_inbound_strays enable row level security;
revoke all on public.invoice_inbound_strays from anon, authenticated, public;

comment on table public.invoice_inbound_strays is
  'INVOICEPREP.1: inbound invoice emails that matched no studio. Service-role only.';
