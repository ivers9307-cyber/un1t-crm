-- REPORT-ISSUE.1 — staff-submitted issue reports for the studio.
--
-- Any staff member can submit a problem they spot in the studio
-- (broken kit, cleaning issue, IT, safety, etc.) with photos. The
-- report is routed to every owner + master at that location plus
-- anyone the master has ticked with the new `issue_handler`
-- permission. Once an owner marks it resolved, the original
-- submitter is notified.
--
-- Lifecycle: open → in_progress → resolved.
-- - open: just submitted, no handler has touched it
-- - in_progress: a handler has claimed it (claim button on the inbox)
-- - resolved: handler has filed resolution notes; submitter is notified
-- - closed: terminal, set when the submitter acknowledges OR after N
--   days (decision deferred to PR 2; column reserved here so we don't
--   need another mig later)
--
-- Permission gating (enforced API-side, RLS is service-role only):
-- - submit: anyone with a profile at the location
-- - view own: submitter sees their own row + drill-in
-- - view + handle: handler permission OR role in (owner, master) at
--   the location
--
-- Photos live in a dedicated storage bucket (issue-photos). The
-- attachment rows just record path + mime + size; the bytes are
-- behind the bucket. Same pattern as fte-expense-receipts (mig 183).

set check_function_bodies = off;

-- ====================================================================
-- issues — one row per submission
-- ====================================================================

create table public.issues (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations (id) on delete restrict,

  -- Submitter — the staff member who reported it. Set on insert,
  -- never updated. ON DELETE SET NULL so removing a profile doesn't
  -- erase the issue history (it just orphans the row's authorship).
  submitter_id    uuid references public.profiles (id) on delete set null,

  -- Free-text description. Capped at 4000 chars so the inbox list
  -- can preview comfortably without DOSing the page on a one-off
  -- novella. UI nudges to ~500 in practice.
  description     text not null check (length(description) > 0 and length(description) <= 4000),

  -- Status. Transitions enforced API-side (PR 2 wires the handler
  -- actions; PR 1 only supports 'open' on insert).
  status          text not null default 'open'
                  check (status in ('open', 'in_progress', 'resolved', 'closed')),

  -- Claim — set when a handler hits the "I'll take this" button on
  -- the inbox in PR 2. Lets the inbox show "Mary is on it" instead
  -- of having two owners race on the same issue. NULL while open.
  claimed_by      uuid references public.profiles (id) on delete set null,
  claimed_at      timestamptz,

  -- Resolution — set when a handler marks resolved. Notes are
  -- mandatory at the API layer when transitioning to resolved so
  -- the submitter notification has something useful in it.
  resolved_by     uuid references public.profiles (id) on delete set null,
  resolved_at     timestamptz,
  resolution_notes text check (resolution_notes is null or length(resolution_notes) <= 2000),

  -- Closed — terminal. PR 2 may auto-close after the submitter has
  -- acknowledged or N days after resolution.
  closed_at       timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index issues_location_status_idx
  on public.issues (location_id, status, created_at desc);

create index issues_submitter_idx
  on public.issues (submitter_id, created_at desc);

create index issues_claimed_by_idx
  on public.issues (claimed_by)
  where claimed_by is not null;

comment on table public.issues is
  'REPORT-ISSUE.1 — staff-submitted issue reports per location. '
  'Open → in_progress → resolved → closed. Routed to issue_handler / '
  'owner / master at the location. Submitter notified on resolution.';

-- ====================================================================
-- issue_attachments — 0..N photos per issue
-- ====================================================================

create table public.issue_attachments (
  id              uuid primary key default gen_random_uuid(),
  issue_id        uuid not null references public.issues (id) on delete cascade,

  -- Storage path inside the issue-photos bucket. Format:
  --   {location_id}/{issue_id}/{attachment_id}-{original_filename}
  -- Filename kept human-readable for support / audit pulls; the
  -- attachment_id prefix guarantees uniqueness even with duplicate
  -- filenames per issue.
  storage_path    text not null,
  bucket          text not null default 'issue-photos',
  size_bytes      int  not null check (size_bytes > 0),
  mime_type       text not null check (length(mime_type) > 0 and length(mime_type) <= 100),

  -- Display order on the issue. UI sorts by this when rendering the
  -- photo carousel. Starts at 0; API-assigned on insert.
  position        int  not null default 0,

  uploaded_by     uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index issue_attachments_issue_idx
  on public.issue_attachments (issue_id, position);

comment on table public.issue_attachments is
  'REPORT-ISSUE.1 — photo attachments for issues. Bytes live in the '
  'issue-photos bucket; this table records path + metadata. Cascade-'
  'delete with the parent issue.';

-- ====================================================================
-- updated_at trigger on issues
-- ====================================================================

create or replace function public.issues_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger issues_updated_at_trg
  before update on public.issues
  for each row execute function public.issues_touch_updated_at();

-- ====================================================================
-- Storage bucket: issue-photos (deny-all; service-role writes only)
-- ====================================================================

insert into storage.buckets (id, name, public)
  values ('issue-photos', 'issue-photos', false)
  on conflict (id) do nothing;

-- Belt-and-braces deny-all on the bucket — same pattern as
-- fte-expense-receipts (mig 183) and contractor-invoices (mig 101).
-- Server-side code uses the service-role client to upload + sign
-- read URLs.
drop policy if exists "issue-photos deny-all" on storage.objects;
create policy "issue-photos deny-all"
  on storage.objects
  for all
  to authenticated, anon
  using (bucket_id <> 'issue-photos')
  with check (bucket_id <> 'issue-photos');

-- ====================================================================
-- RLS — service-role only on both new tables
-- ====================================================================

alter table public.issues enable row level security;
alter table public.issue_attachments enable row level security;
