-- Contractor self-revoke + resubmit.
--
-- Adds a 'revoked' terminal status that the contractor can flip to
-- from 'submitted' (only). Distinct from 'declined' (which is the
-- approver's call) so the audit trail makes clear who pulled what.
-- Like 'declined', a revoked row stays in place for audit and lets
-- the contractor insert a fresh submission for the same period.
--
-- Applied via Supabase MCP on 2026-05-06.

alter table public.contractor_invoices
  add column if not exists revoked_at timestamptz;

alter table public.contractor_invoices
  drop constraint if exists contractor_invoices_status_check;
alter table public.contractor_invoices
  add constraint contractor_invoices_status_check
  check (status in ('submitted', 'approved', 'declined', 'revoked'));

drop index if exists public.contractor_invoices_one_active_per_period;
create unique index contractor_invoices_one_active_per_period
  on public.contractor_invoices (contractor_id, period_start)
  where status not in ('declined', 'revoked');

comment on column public.contractor_invoices.revoked_at is
  'When the contractor self-revoked this submission. Only set when status=revoked. Distinct from declined (approver-driven).';
