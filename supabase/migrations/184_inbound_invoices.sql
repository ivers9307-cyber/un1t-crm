-- INVOICES.1 — Dext-style email-in invoice ingest.
--
-- Each location has a unique invoice forwarding address. Vendors /
-- the operator forward bills to it; Postmark inbound webhook
-- relays them into this table. Two-stage manual approval:
--
--   received          inbound webhook landed it; awaiting QUALITY review
--   quality_approved  operator confirmed the attachment is legible
--                     (intermediate state — OCR runs from here)
--   extracted         Claude Vision parsed the attachment; awaiting
--                     DATA review (operator reviews fields)
--   data_approved     operator confirmed extracted fields are correct
--                     (intermediate — Xero forward runs from here)
--   forwarded         sent to the location's Xero bills_email_address
--   rejected          terminal — either stage 1 (bad quality) or
--                     stage 2 (extraction was unrecoverable / not a
--                     real invoice)
--
-- The two intermediate states (quality_approved, data_approved)
-- exist so the route can transition through them while the async
-- OCR / Xero-forward work is happening. If the work fails the row
-- is left in the intermediate state and the UI offers retry. If it
-- succeeds the row moves to the next terminal-ish state.
--
-- Mirrors the patterns of contractor_invoices (mig 101) and
-- fte_expense_claims (mig 183) for consistency.

set check_function_bodies = off;

-- ====================================================================
-- locations — invoice forwarding slug
-- ====================================================================
--
-- Slug is the local part of the forwarding address:
--   <slug>-invoices@un1tdublin.com
-- Operator-set per location. Allow letters / numbers / hyphens to
-- keep the address readable. Index unique because two locations
-- with the same slug would create routing ambiguity in the webhook.

alter table public.locations
  add column if not exists invoices_inbound_slug text
    check (invoices_inbound_slug is null
           or invoices_inbound_slug ~ '^[a-z0-9][a-z0-9-]{1,40}$');

create unique index if not exists locations_invoices_inbound_slug_uidx
  on public.locations (invoices_inbound_slug)
  where invoices_inbound_slug is not null;

comment on column public.locations.invoices_inbound_slug is
  'INVOICES.1 — local part of the per-location invoice forwarding address. NULL means inbound ingest is off for this location.';

-- ====================================================================
-- inbound_invoices — one row per inbound email
-- ====================================================================

create table public.inbound_invoices (
  id                  uuid primary key default gen_random_uuid(),
  location_id         uuid not null references public.locations (id) on delete restrict,

  -- Email envelope. sender_email is the From address; subject is the
  -- email subject. Both are useful for the inbox UI and for the
  -- approver to identify the source at a glance.
  sender_email        text,
  subject             text,

  -- Postmark inbound MessageID — used as a dedup key so a retried
  -- webhook delivery doesn't create duplicate rows. NULL is allowed
  -- for the future "operator uploaded directly via the inbox UI"
  -- alternate ingest path.
  email_message_id    text unique,

  -- Attachment storage. Path is into the inbound-invoices bucket
  -- declared below. We store only the FIRST attachment per email
  -- (the common case is a single PDF or image); multi-attachment
  -- emails get N rows, one per attachment, treated as independent
  -- invoices.
  attachment_path        text,
  attachment_filename    text check (attachment_filename is null or length(attachment_filename) <= 255),
  attachment_size_bytes  int  check (attachment_size_bytes is null or attachment_size_bytes > 0),
  attachment_mime_type   text check (attachment_mime_type is null or length(attachment_mime_type) <= 100),

  status              text not null default 'received'
                      check (status in (
                        'received',
                        'quality_approved',
                        'extracted',
                        'data_approved',
                        'forwarded',
                        'rejected'
                      )),

  -- Audit timestamps. Set as the row moves through states.
  received_at         timestamptz not null default now(),
  quality_reviewed_at timestamptz,
  quality_reviewed_by uuid references public.profiles (id) on delete set null,
  extracted_at        timestamptz,
  data_reviewed_at    timestamptz,
  data_reviewed_by    uuid references public.profiles (id) on delete set null,
  forwarded_at        timestamptz,
  rejected_at         timestamptz,

  -- Reject reason — required when rejecting (enforced API-side).
  reject_reason       text check (reject_reason is null or length(reject_reason) <= 1000),

  -- Stage of rejection ('quality' | 'data') for downstream filtering.
  rejected_stage      text check (rejected_stage is null
                                  or rejected_stage in ('quality', 'data')),

  -- Claude Vision output. Shape mirrors invoiceFieldsSchema in
  -- src/lib/invoice-extraction.js — supplier_name, invoice_number,
  -- invoice_date, due_date, currency, subtotal, tax_amount, total,
  -- line_items[]. We store it raw as JSONB so the schema can evolve
  -- without a migration.
  extracted_fields    jsonb,
  extraction_confidence text check (extraction_confidence is null
                                    or extraction_confidence in ('high','medium','low')),
  extraction_error    text,

  -- Xero forward state (only set after data_approved → forwarded).
  xero_email_message_id text,
  xero_synced_at        timestamptz,
  xero_error            text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Filter-shaped indexes — the inbox UI is dominated by:
--   WHERE location_id = ? AND status = ?  ORDER BY received_at DESC
create index inbound_invoices_inbox_idx
  on public.inbound_invoices (location_id, status, received_at desc);
create index inbound_invoices_received_idx
  on public.inbound_invoices (received_at desc);
-- Cross-location master inbox view.
create index inbound_invoices_status_idx
  on public.inbound_invoices (status, received_at desc);

comment on table  public.inbound_invoices is
  'INVOICES.1 — Dext-style email-in invoice ingest. Postmark inbound webhook → quality review → Claude Vision OCR → data review → Xero bills-email forward.';
comment on column public.inbound_invoices.status is
  'received | quality_approved | extracted | data_approved | forwarded | rejected. Transitions API-enforced.';
comment on column public.inbound_invoices.extracted_fields is
  'Claude Vision output as JSONB. Shape matches src/lib/invoice-extraction.js invoiceFieldsSchema.';

-- ====================================================================
-- updated_at trigger
-- ====================================================================

create or replace function public.inbound_invoices_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger inbound_invoices_updated_at
  before update on public.inbound_invoices
  for each row execute function public.inbound_invoices_touch_updated_at();

-- ====================================================================
-- RLS
-- ====================================================================

alter table public.inbound_invoices enable row level security;

-- Read access: master sees everything; owner sees their locations.
-- No 'self' visibility — inbound invoices belong to the business,
-- not a specific staff member.
create policy inbound_invoices_read on public.inbound_invoices
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.role = 'master'
    )
    or exists (
      select 1 from public.profile_locations pl
       where pl.profile_id = auth.uid()
         and pl.location_id = inbound_invoices.location_id
         and pl.role = 'owner'
    )
  );

-- Writes are service-role only — the inbound webhook + the
-- approval routes all use the service-role client. No INSERT /
-- UPDATE / DELETE policy means no authenticated writes possible.

-- ====================================================================
-- Storage bucket
-- ====================================================================

insert into storage.buckets (id, name, public)
  values ('inbound-invoices', 'inbound-invoices', false)
  on conflict (id) do nothing;
