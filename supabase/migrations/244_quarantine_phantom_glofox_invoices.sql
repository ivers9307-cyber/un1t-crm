-- 244 — quarantine phantom / transaction-only rows from glofox_invoices.
--
-- Context (verified against the Glofox API spec v2.3.0, 2026-06):
-- glofox_invoices mixes two sources with DIFFERENT status vocabularies:
--   • INVOICE_UPDATED webhook (the authoritative invoice ledger) —
--     status ∈ {PAID, PAST_DUE, PENDING, FORGIVEN}.
--   • the mig-140 one-shot backfill from POST /Analytics/report, which
--     actually returns TRANSACTIONS (payments), status ∈ {PAID, REFUNDED,
--     ERROR, PENDING, PARTIAL_REFUNDED, SUBSCRIPTION_CYCLE_PAYMENT_FAILED}
--     — plus a PENDING_INTENT value not in either documented enum.
--
-- The transaction-only statuses (ERROR / PENDING_INTENT / REFUNDED) are
-- NOT real invoices: the webhook only ever emits the 4 invoice statuses,
-- so it can never reconcile them — they froze at the 2026-05-12 backfill
-- and meant opposite things for different members (written-off vs still
-- owed), which is why an "outstanding invoices" read over-reported some
-- members and under-reported others (OVERDUE.2, reverted in PR #311).
--
-- This moves those rows out of the live ledger into an archive table so
-- glofox_invoices holds only real invoices going forward. PAID rows are
-- KEPT regardless of source — they are the lifetime-value payment history
-- summed by recomputeContactLifetimeValue (which only reads PAID, so this
-- cleanup does not change any LTV). Self-healing: if any quarantined
-- invoice id is still live in Glofox and ever changes, INVOICE_UPDATED
-- re-inserts it into glofox_invoices with a correct status.
--
-- Expected at apply time (Stillorgan): 178 rows quarantined —
-- ERROR 131, PENDING_INTENT 37, REFUNDED 10.

-- Archive table — columns + defaults + NOT NULL only (no PK/FK/indexes,
-- so a later contact delete can't break the archive). Audit/restore use.
create table if not exists public.glofox_invoices_quarantine
  (like public.glofox_invoices including defaults);

comment on table public.glofox_invoices_quarantine is
  'Rows removed from glofox_invoices by mig 244 whose status is not a valid Glofox INVOICE status (ERROR / PENDING_INTENT / REFUNDED — /Analytics/report transaction artifacts from the mig-140 backfill, not real invoices). Audit / restore only; not read by app code.';

-- Service-role only: enable RLS with no policies so the authenticated /
-- anon roles get deny-all (service role bypasses RLS). Matches the
-- pattern for internal-only tables + keeps the security advisor clean.
alter table public.glofox_invoices_quarantine enable row level security;

-- Move every non-invoice-status row out of the live ledger.
with moved as (
  delete from public.glofox_invoices
  where status not in ('PAID', 'PAST_DUE', 'PENDING', 'FORGIVEN')
  returning *
)
insert into public.glofox_invoices_quarantine
select * from moved;
