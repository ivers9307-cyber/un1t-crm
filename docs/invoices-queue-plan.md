# INVOICES-QUEUE.1 — restructure approval-to-Xero flow (design)

> Design doc extracted from CLAUDE.md on 2026-06-01. Designed May 20 2026. NOTE: the 3-PR series has since shipped (see docs/CHANGELOG.md entries #200, #201, #205). Retained as the design record / rationale.

**The architectural shift the operator wants** (codified before merging the three open PRs so the next chat picks up with the full plan):

Today every source-of-an-invoice (FTE expense claims, contractor invoices, supplier emails via INVOICES.1, car documents) runs its own Claude Vision OCR call at its own moment in its own flow, and forwards to Xero independently. That's three OCR call sites, four direct-to-Xero paths, and no single place to see "what's about to hit my accounts this month".

The replacement model: **owner approval = source feature's job; accountant sign-off = the Invoices feature's job**. Everything Xero-bound funnels through one queue.

```
Source feature              Owner action                       Lands in Invoices queue
────────────────────────    ──────────────────────────────     ────────────────────────────────
FTE expense claims          Owner approves the claim           "Expenses" sub-section (1 row/receipt)
Contractor invoices         Owner approves the bill            "Contractor" sub-section
Inbound supplier invoices   (no owner step — direct)           "Supplier" sub-section (existing)
Car documents               (no explicit approval — auto)      "Car documents" sub-section

           Inside the Invoices queue (= accountant sign-off):
           ──────────────────────────────────────────────────────────
           • SINGLE Claude Vision OCR pipeline (per-receipt; one
             call per document — empirically cleanest extraction)
           • Bulk review / analyse / approve / send to Xero
           • On final approval (bookkeeper permission required) →
             forward to Xero
```

**The "accountant" role** is a new `bookkeeper` permission key in `shared/permissions.js`, NOT a new role. Defaults master ON, everyone else OFF. Grantable per-user via the existing StaffForm permission picker so a senior manager can be made bookkeeper temporarily (month-end coverage) and the flag flipped off again. Cleanly separates "I approve this expense" (owner) from "I sign this off to the accountant" (bookkeeper).

**Phased ship — 3 PRs**

**PR 1 — Drop into the queue on owner-approval (next session, start here)**

Schema work (mig 185):
- Rename `inbound_invoices` → `invoices_queue` (table barely used yet; INVOICES.1 just shipped).
- Add `source_type text NOT NULL CHECK (source_type in ('supplier_email','contractor_invoice','fte_expense_item','car_document'))`. Existing rows backfill to `supplier_email`.
- Add per-source nullable FK columns (NOT a polymorphic FK — Postgres doesn't support those cleanly): `source_contractor_invoice_id`, `source_fte_expense_item_id`, `source_car_document_id`. Each FK has its own `ON DELETE CASCADE` so source-row delete cleans the queue row.
- Add new status `awaiting_accountant_review` to BOTH `fte_expense_claims.status` CHECK and `contractor_invoices.status` CHECK. State machine for both becomes `draft → submitted → approved → awaiting_accountant_review → forwarded` (with `declined` as the terminal branch from `submitted`).

Behaviour:
- Owner-approve route on FTE expense claims (`/api/expenses/[id]/approve`): after status flip to `approved`, immediately set to `awaiting_accountant_review` AND insert N rows into `invoices_queue` (one per receipt on the claim, source_type=`fte_expense_item`). **The existing direct-to-Xero forward stops happening here** — queue handles it in PR 2.
- Owner-approve route on contractor invoices (`/api/invoices/[id]/approve`): same shape. Status to `awaiting_accountant_review` + one queue row source_type=`contractor_invoice`.
- Car documents on upload: auto-create one queue row source_type=`car_document` (no explicit approval step — same as supplier emails today). Car documents UI gets a "Sent for review" indicator.
- Inbound supplier emails (`/api/webhooks/invoices-inbound/[token]`): unchanged shape — still inserts one row per attachment, source_type=`supplier_email`. The existing quality + extract + data-review flow keeps running; PR 3 collapses it into the unified pipeline.
- Submitter-facing UI copy: FTE expenses + contractor invoices show `awaiting_accountant_review` as "Approved by your manager · Awaiting accountant sign-off before forwarding to Xero." with a green-ish neutral colour (not amber — it's not waiting on the SUBMITTER for anything).

Permission key: new `bookkeeper` in `shared/permissions.js#WEB_PERMISSIONS`. Defaults master ON, owner/manager/head_coach/staff OFF. Add to `WEB_ONLY_OK` in `check-mobile-parity.mjs` with reason (it's a desktop finance workflow). Three-tier resolver picks it up automatically; StaffForm renders the toggle automatically.

Hard cutover: already-approved-not-yet-forwarded items stay on the old direct-to-Xero path until they finish naturally. New submissions take the new path. No backfill migration.

**PR 2 — Bulk operations UI in `/invoices`**

Tabbed view inside `/invoices`: **All · Supplier · Contractor · Expenses · Car documents**. Each tab filtered by `source_type`. The Expenses tab groups rows by the parent claim (since one claim = N rows = N receipts). Card per row showing: attachment thumbnail, extracted-fields summary if already analysed, source-row link, suggested category, amount.

Bulk actions (gated on `bookkeeper` permission):
- **Analyse selected** — runs Claude Vision per-row (parallelisable; per-receipt is the cheapest + most accurate path). Confirmation modal shows estimated token cost before firing.
- **Send to Xero** — forwards every selected row's attachment to the destination location's `bills_email_address` via the existing Postmark path. One email per row (Xero's OCR creates one draft bill per email). Status flip → `forwarded`.
- **Reject** with reason — row goes to `rejected` terminal state, source row's `awaiting_accountant_review` flips back to a new `accountant_rejected` status which surfaces to the submitter ("Accountant flagged this for revision — see reason below").

`/approvals` gains a new **Bookkeeper queue** tab, gated on the `bookkeeper` permission. The tab is HIDDEN entirely for anyone without the flag (not just disabled — it shouldn't be visible). Shows the count of queued items awaiting their action; click-through to `/invoices` with that tab pre-selected.

Sidebar badge logic (existing `usePolledCount` hook): the existing Invoices badge stays as "items the operator can see in the inbox" but a new `bookkeeper-aware` filter happens server-side — non-bookkeepers see the count of items in their inbox-readable state (owner can audit), bookkeepers see the count of items needing THEIR action (queued + analysed but not yet forwarded).

**PR 3 — Centralise Claude Vision**

Move all OCR invocation INTO the queue. After this PR, there is ONE place Claude Vision runs from: the bookkeeper clicking "Analyse" in `/invoices`.

Removal work:
- Drop the "Auto-fill from receipt" button from FTE expense item forms (web `ExpensesManager.jsx` + mobile `expenses/[id].jsx`). The submitter just attaches a receipt; no AI runs at their stage.
- Drop "Extract with AI" from car documents (`DocumentsCard.jsx`). Upload alone enqueues; bookkeeper runs analysis later.
- Collapse INVOICES.1's two-stage approval inside `/invoices`. The existing quality-review step (operator confirms attachment is legible) stays — that's the cost-protection gate that proved its worth. The data-review step becomes the unified "Analyse" action.

Single shared service `src/lib/extraction/` with one entry point: `extractInvoiceFieldsFromBytes(bytes, mime, hints)` (already exists — refactor to be the only call site). The `hints` arg lets callers pass source-type-specific guidance (e.g. for `fte_expense_item`, restrict categories to the FTE expense enum rather than the supplier-invoice enum).

Once PR 3 ships:
- Token spend visibility lands in one place (the queue's per-row `extraction_token_cost` column added by mig 186)
- A new admin page `/admin/extraction-cost` (master-only) shows monthly extraction spend per source-type + extraction success rate per source-type, so the operator can spot if (e.g.) car-document OCR is consistently 3× the cost of FTE-receipt OCR and decide whether to downsample uploads before sending to Claude.
- Per-source caching kicks in — system prompt is identical across every call, so `cache_control: { type: 'ephemeral' }` on the system block (the existing "enable prompt caching" backlog item, line above) saves ~50% of input tokens once monthly volume crosses ~200 invoices.

**Open questions deferred to the build**

- Bulk forward-to-Xero: do we batch N attachments into one Postmark send or one-per-row? Xero's bills-email pipe creates ONE draft per email regardless of attachment count — so one-per-row is right. Confirm at PR 2 time.
- Rejection-with-reason on FTE expenses: does the rejected receipt's parent claim get held entirely, or just that receipt? Probably hold the whole claim (the submitter shouldn't get partial reimbursement on a claim the accountant doesn't agree with). Pin at PR 2 design time.
- Mobile surface: the queue itself stays desktop-only (PDF preview alongside fields needs the screen real estate). But a "1 invoice awaiting your sign-off" mobile push to the bookkeeper would be a nice-to-have if operator demand surfaces.

**Why we're not building it today**

Three open PRs (#43 invoices-inbox, #44 approvals-dashboard, #45 docs) touch the same surface and haven't merged yet. Branching the restructure off `main` today would mean the restructure PR doesn't make sense in isolation (it'd reference tables that haven't been created on main yet). Order of operations: merge #43 → merge #44 → merge #45 → start INVOICES-QUEUE.1 PR 1 off a clean main. Hard cutover means no data migration concern — already-approved items in flight stay on the old path until they drain.
