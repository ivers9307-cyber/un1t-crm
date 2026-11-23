# Invoice Preparation On Arrival (INVOICEPREP.3, design phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An invoice is read, checked and coded the moment it arrives, and lands either Ready (nothing wrong) or Needs a look (with the reason), with no click from anyone.

**Architecture:** One function, `prepareInvoiceRow`, replaces the manual sequence of "approve quality, click Analyse". Every path that creates a queue row marks it for preparation and publishes it to the existing QStash `invoice-analysis` queue; the existing two-minute sweeper cron remains the delivery guarantee. A pure function decides the reasons a row needs a look. The current screen keeps working and gains only what is needed to see the result; the two-pile screen is the next phase.

**Tech Stack:** Next.js 16 route handlers, Supabase (service role), QStash, Anthropic Messages API (existing extractor), Xero API (existing client), vitest with `createFakeDb`.

**Spec:** `docs/superpowers/specs/2026-11-22-invoice-ingest-prepare-on-arrival-design.md`, sections 2 ("Preparation"), 3 ("States"), 4 ("Sending"), 8 ("Clearing the backlog") and "Database changes". Read them before starting. Phases 1 and 1b are merged (#2535, #2536).

## Global Constraints

- Work in a fresh worktree on a branch cut from `origin/main` (`invoice-prepare-on-arrival`). Commit messages start `INVOICEPREP.3 — `.
- The migration is forward-only and applied with Supabase MCP to project `iyvtbjjxdggiadzwwvdj` **before** the code deploys; run the security advisor after it; then refresh `supabase/schema/snapshot.json`, `access.json` and `database.d.ts` (`createFakeDb` reads the snapshot). Take the next free migration number at build time (871 on 22 Nov 2026; main already holds two files numbered 870, so re-check).
- **Deploy order must be safe both ways:** old code with the new schema, and new code never assuming a row was prepared.
- Preparation never sends anything to Xero and never rejects a row. It only reads, checks, fills fields and sets reasons.
- **Never trade a rare wrong value for a lost invoice.** A preparation step that fails (Xero lookup, supplier memory, VAT rates) does not block the row: the row still becomes visible with what was read. Only a failed download or a failed read marks the row `unreadable`.
- A remembered human decision (supplier coding) wins over the extractor's guess. A VAT rate derived from the document's own figures wins over memory.
- Sending rules: `bulk-send` refuses a row whose `review_reasons` is not empty. The single-row send (`data-approve`) keeps its existing hard checks (supplier, account, VAT rate, date) and is otherwise allowed: a person opening a row and sending it is the review.
- Exact values: reasons are the eleven strings in Task 3; status added is `not_invoice`; totals tolerance `0.01`; duplicate checks are scoped by `location_id`.
- Every `/api` route runs on the service role: scope in code; detail routes answer 404, never 403; a new route uses `withAuth`.
- Destructure `error` from every write and read; a zero-row update is not an error; builders are awaited. No `console.*` in new code (`logWarn`/`logError` from `@/lib/log`). New database code starts with `// @ts-check`.
- No supplier names, sender addresses or customer names in code, tests or the PR body (public repo).
- Do not change `supabase/functions/**`. Do not change how a bill is built or pushed (`push-xero.js`).
- Before pushing: the CI mirror from `CLAUDE.md` once, then `npm run build`. Do not run the full suite beside the build.

## Review Focus

1. **A row prepared twice at once** (QStash delivery and the sweeper cron racing) must be read once and end in one consistent state. (Task 5)
2. **A row a person has already acted on** (extracted and edited, approved, rejected, sent) must never be overwritten by a late preparation. (Tasks 4, 5)
3. **A studio with no Xero connection** must still get its invoices read and shown, flagged, not stuck. (Task 4)
4. **Two different invoices from one supplier with the same number**, and one invoice forwarded twice, must each be flagged without either hiding the other. (Task 4)
5. **A backlog row written before phase 1** (no hash, no body, numbered the old way) must prepare correctly. (Task 4)

---

### Task 1: Migration and schema snapshot

**Files:**
- Create: `supabase/migrations/871_invoice_preparation.sql`
- Modify: `supabase/schema/snapshot.json`, `access.json`, `database.d.ts` (regenerated)
- Test: `tests/migration-871-invoice-preparation.test.js`

**Interfaces:**
- Produces:
  - `invoices_queue.review_reasons text[] not null default '{}'`, `prepared_at timestamptz`, `duplicate_of_id uuid references public.invoices_queue(id) on delete set null`
  - `invoices_queue_status_check` replaced to allow `'received','quality_approved','extracted','data_approved','forwarded','rejected','not_invoice'`
  - `xero_supplier_defaults.default_tax_type text`
  - `public.upsert_supplier_default(p_location_id uuid, p_xero_contact_id text, p_supplier_name text, p_account_code text, p_xero_account_id text, p_category text, p_tax_type text default null)`: the six-argument version is dropped and this one created in the same migration, so a six-named-argument call from old code still resolves. `p_tax_type` null leaves the stored value unchanged. Executable by `service_role` only.
  - `public.claim_invoice_analysis_batch(int)` replaced: claims rows with `status in ('received','quality_approved')` (was `quality_approved` only); everything else unchanged.
  - A `comment on column` for each new column.

- [ ] **Step 1: Write the failing test** (read the file text, as `tests/migration-868-invoice-arrival-safety.test.js` does): the three queue columns and the supplier column are added with `if not exists`; the status check lists all seven statuses; the claim function's predicate contains both statuses; the old `upsert_supplier_default` signature is dropped and the new one revoked from `public, anon, authenticated` and granted to `service_role`; no `drop column`, `drop table`.
- [ ] **Step 2: Run it.** Expected: FAIL, file not found.
- [ ] **Step 3: Write the migration.** Read migration 207 for the current body of `upsert_supplier_default` and keep its behaviour (increment `use_count`, stamp `last_used_at`), adding `default_tax_type = coalesce(p_tax_type, default_tax_type)`. Read migration 220 for the claim function and 667 for how its execute grant is closed. Grant decision for the new queue columns, stated in a comment: the table already has a table-level grant under its read policy; no narrower grant.
- [ ] **Step 4: Run the test and** `npm run check:rls-restrictive && npm run check:bundle-sql && npm run check:rpc-names`. Expected: PASS.
- [ ] **Step 5 (controller): apply** with Supabase MCP, verify the columns, the constraint and both functions live, run the security advisor.
- [ ] **Step 6 (controller): refresh the snapshot** and access file through this migration; `npm run check:schema-snapshot && npm run check:types`.
- [ ] **Step 7: Commit** `INVOICEPREP.3 — migration 871: preparation columns, not_invoice status, supplier VAT memory`.

### Task 2: The extractor says what kind of document it read

**Files:**
- Modify: `src/lib/invoice-extraction.js` (schema and `SYSTEM_PROMPT`)
- Test: the existing test file for the extraction schema (find with `ls src/lib | grep invoice-extraction`)

**Interfaces:**
- Produces: `invoiceFieldsSchema` gains `document_type: z.enum(['invoice','receipt','statement','other']).nullable().optional()` (via the file's `blankToNull`). Exported `INVOICE_DOCUMENT_TYPES`. The prompt asks for it.

- [ ] **Step 1: Write the failing tests:** each of the four values parses; an unknown value fails; missing and `''` give `undefined`/`null` and still parse (rows extracted before this change must stay valid).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add to the prompt's field list, after `category`:

```
- document_type (string) — one of: invoice, receipt, statement, other. "invoice" is a bill asking for payment for goods or services. "receipt" is proof of a payment already made (a till or card receipt). "statement" lists several invoices or a running balance and is not itself a bill. "other" is anything else: a logo, a signature image, a photo, a letter, a quote, a delivery note, a remittance advice.
```

  And one rule: for `statement` or `other`, still return the JSON object, with `supplier_name` as best read (or "Unknown"), `total` 0, and the other fields null.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.3 — extractor reports the document type`.

### Task 3: The reasons a row needs a look (pure)

**Files:**
- Create: `src/lib/invoices-queue/readiness.js`
- Test: `src/lib/invoices-queue/readiness.test.js`

**Interfaces:**
- Consumes: `resolveBillTaxType(fields, taxRates)` from `./vat.js` (returns `{ taxType, derivedRate, status: 'zero'|'matched'|'ambiguous'|'unmatched', candidates }`).
- Produces:
  - `REVIEW_REASONS` (frozen array, this order): `'unreadable','duplicate_file','duplicate_number','already_in_xero','new_supplier','no_account','no_vat_rate','vat_differs','totals_mismatch','missing_date','zero_total'`
  - `REVIEW_REASON_LABELS`: `unreadable` "Could not be read", `duplicate_file` "Possible duplicate", `duplicate_number` "Possible duplicate", `already_in_xero` "Already in Xero", `new_supplier` "New supplier", `no_account` "No account yet", `no_vat_rate` "No VAT rate", `vat_differs` "VAT differs from last time", `totals_mismatch` "Totals don't add up", `missing_date` "No invoice date", `zero_total` "Total is zero"
  - `fieldReasons(fields, { vat, rememberedTaxType, taxRates }) → string[]`: the reasons that depend only on the fields: `new_supplier` (no `xero_contact_ref`), `no_account` (a contact ref but no `xero_account_id`), `no_vat_rate` (`vat.status` is `unmatched` or `ambiguous` and `fields.tax_type` is empty), `vat_differs` (`vat.status === 'zero'`, `rememberedTaxType` is set, and that type's `effective_rate` in `taxRates` is greater than 0), `totals_mismatch` (`|subtotal + tax_amount − total| > 0.01`, only when all three are finite and subtotal > 0), `missing_date`, `zero_total` (`total` is exactly 0).
  - `mergeReasons(...lists) → string[]`: de-duplicated, in `REVIEW_REASONS` order.
  - `isReady(reasons) → boolean`.

- [ ] **Step 1: Write the failing tests:** one per reason with the smallest field set that raises it and one that does not; a fully coded invoice returns `[]`; a manually set `fields.tax_type` clears `no_vat_rate` even when `vat.status` is `unmatched`; `vat_differs` is not raised when the remembered type is itself a 0% rate; `mergeReasons(['zero_total'], ['unreadable','zero_total'])` equals `['unreadable','zero_total']`.
- [ ] **Step 2: Run** `npx vitest run src/lib/invoices-queue/readiness.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** No database calls in this file.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.3 — review reasons as a pure function`.

### Task 4: `prepareInvoiceRow` and `recheckInvoiceRow`

**Files:**
- Create: `src/lib/invoices-queue/prepare.js` (`// @ts-check`)
- Test: `src/lib/invoices-queue/prepare.test.js`

**Interfaces:**
- Consumes: `extractInvoiceFieldsFromBytes`, `scoreExtractionConfidence`; `resolveExtractionDefaults(db, locationId, supplierName)`, `getSupplierDefault`; `resolveBillTaxType`; Task 3's functions; `sha256Hex`; `withFreshToken(locationId)` and `findXeroBillByNumber(xfetch, number)`.
- Produces:
  - `prepareInvoiceRow(db, row, deps?) → Promise<{ outcome: 'prepared'|'not_invoice'|'duplicate'|'unreadable'|'skipped', reasons: string[] }>`. `row` is a full queue row already claimed by the caller. `deps` may override `extract` and `xero` (`{ findBill(locationId, number) }`) for tests, and carry `force: true` (set by "Read again") to skip the duplicate-by-file stop in step 4 so a person can insist on reading a flagged copy; the `duplicate_file` reason is then not raised.
  - `recheckInvoiceRow(db, row) → Promise<{ reasons: string[] }>`: steps 4 to 6 below on the row's current `extracted_fields`, no download, no extraction.

Steps of `prepareInvoiceRow`, in order. Every write is guarded by `.in('status', ['received','quality_approved'])` so a row a person has moved on is never overwritten; a guarded write that matches zero rows returns `{ outcome: 'skipped' }`. Every write also clears `analysis_queued_at` and `analysis_claimed_at` and sets `prepared_at`.

1. **No file.** No `attachment_path`: write `status: 'not_invoice'` (keep an existing `not_invoice_reason`, else set `'no_attachment'`). Outcome `not_invoice`.
2. **Download** from the row's own `attachment_bucket`. A failed download: `review_reasons: ['unreadable']`, `extraction_error`, status unchanged. Outcome `unreadable`.
3. **Hash.** If `content_hash` is null, compute it and include it in the next write (backlog rows have none).
4. **Duplicate by file.** Another row at the same `location_id` with the same `content_hash`, a different id, `status` not in (`rejected`, `not_invoice`), and an earlier `received_at` (ties broken by smaller id, so two copies never flag each other): write `review_reasons: ['duplicate_file']`, `duplicate_of_id`, status unchanged, **no extraction**. Outcome `duplicate`.
5. **Read.** A failed read: as step 2. `document_type` of `statement` or `other`: write `status: 'not_invoice'`, `not_invoice_reason` `` `document_type: ${type}` ``, and keep `extracted_fields`. Outcome `not_invoice`.
6. **Supplier and account.** `resolveExtractionDefaults`, merged over the read fields. A throw is logged and ignored.
7. **VAT.** Load the studio's `xero_tax_rates`; `resolveBillTaxType`; when it returns a `taxType`, set `fields.tax_type` and `tax_type_source: 'derived'`. Load the supplier's `default_tax_type` when a contact matched. A failed load is logged and treated as no rates.
8. **Duplicate by number.** When the fields have an `invoice_number` and a matched contact: another row at the studio, different id, status in (`extracted`,`data_approved`,`forwarded`), same `extracted_fields->>invoice_number` and same `xero_contact_ref.xero_contact_id` → `duplicate_number` and `duplicate_of_id`. Then, when the studio has a Xero connection, `findXeroBillByNumber` → `already_in_xero`. No connection, or a failed lookup: logged, no reason raised.
9. **Write** `status: 'extracted'`, `extracted_at`, `extracted_fields`, `extraction_confidence`, `extraction_error: null`, `review_reasons: mergeReasons(fieldReasons(...), duplicate reasons)`. Outcome `prepared`.

`recheckInvoiceRow` runs steps 7 to 8 on the stored fields (keeping a `tax_type` whose `tax_type_source` is `'manual'`), then writes only `extracted_fields` (if VAT changed) and `review_reasons`, guarded by `.eq('status','extracted')`.

- [ ] **Step 1: Write the failing tests** with `createFakeDb` (+ `db.storage` with `download`) and injected `extract` and `xero`:
  - no attachment → `not_invoice`, extractor not called;
  - download fails → `unreadable`, status still `received`;
  - same hash as an older row → `duplicate`, `duplicate_of_id` set, extractor NOT called; the older row prepared afterwards is not flagged;
  - a row with null `content_hash` gets one written;
  - `document_type: 'statement'` → `not_invoice` with reason `document_type: statement`;
  - known supplier with remembered account and a matched 23% rate → `extracted`, `review_reasons: []`, `tax_type` set, `tax_type_source: 'derived'`;
  - unknown supplier → `['new_supplier']`;
  - same supplier and number as a forwarded row → `duplicate_number`;
  - `xero.findBill` returns a bill → `already_in_xero`; it throws → row still `extracted`, no such reason;
  - studio with no tax rates and no contacts → `extracted` with `new_supplier` and `no_vat_rate`, nothing thrown;
  - a row whose status changed to `rejected` before the final write → `skipped`, row untouched;
  - `force: true` on a row with the same hash as an older one → read and `extracted`, no `duplicate_file`;
  - `recheckInvoiceRow`: setting `xero_contact_ref` and `xero_account_id` on a `new_supplier` row clears the reason; a manual `tax_type` is kept.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, plus** `npm run check:types && npm run check:select-columns`. Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.3 — prepareInvoiceRow: read, check and code a row in one place`.

### Task 5: The queue runs preparation

**Files:**
- Create: `src/lib/invoices-queue/queue-preparation.js` (`// @ts-check`)
- Modify: `src/lib/invoice-analysis-queue.js`, `src/app/api/webhooks/qstash/invoice-analysis/route.js`, `src/app/api/cron/process-invoice-analysis/route.js`
- Test: `src/lib/invoices-queue/queue-preparation.test.js`, the existing worker and cron route tests

**Interfaces:**
- Produces:
  - `queueInvoicePreparation(db, ids, { publish = publishQueuePush } = {}) → Promise<{ queued: string[] }>`: sets `analysis_queued_at = now` on rows whose status is `received` or `quality_approved` (rows without a file included: preparation is what moves them to `not_invoice`), then publishes each id to the `invoice-analysis` queue exactly as `bulk-queue-analysis` does today (`INVOICE_ANALYSIS_WORKER_PATH`, `INVOICE_ANALYSIS_QUEUE_NAME`, parallelism 2). Never throws: a failed publish is logged, because the sweeper cron will pick the row up.
  - `claimAndProcessInvoiceAnalysisRow` claims rows with status `received` or `quality_approved` and calls `prepareInvoiceRow`. `processInvoiceAnalysisRow` becomes a thin call to `prepareInvoiceRow` (the cron uses it after the RPC claim).

- [ ] **Step 1: Write the failing tests:** `queueInvoicePreparation` stamps and publishes `received` and `quality_approved` rows and skips an `extracted` one; a publish that rejects still returns the ids; the worker accepts a `received` queued row; two concurrent claims of one row process it once (the second claim finds `analysis_claimed_at` fresh and is `skipped`); the cron still stamps its heartbeat and reports counts.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Update the worker's row fetch to `.in('status', ['received','quality_approved'])`. Keep the cron's shape (`defineCron`, heartbeat, `maxDuration`, batch of 10).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.3 — the analysis queue prepares rows`.

### Task 6: Every arrival is queued

**Files:**
- Modify: `src/lib/invoices-queue/ingest-email.js`, `src/app/api/webhooks/invoices-inbound/[token]/route.js`, `src/app/api/invoices-inbox/route.js` (POST), `src/lib/invoices-queue/enqueue.js`, `src/app/api/invoices-inbox/bulk-queue-analysis/route.js`
- Test: the existing tests beside each

**Interfaces:**
- Consumes: `queueInvoicePreparation`.
- Produces: after rows are created, each path calls `queueInvoicePreparation(db, ids)`: the webhook (for `created` ids and the not-received and empty rows, after `ingestInboundEmail` succeeds); the upload POST; each `enqueueFrom*` function that creates a row with a file (contractor invoice, expense receipt, car document, card receipt, hunted file). Receiptless expense rows are created `extracted` as today and are not queued. `bulk-queue-analysis` uses the helper too, so there is one publisher.

- [ ] **Step 1: Write the failing tests:** for each path, the created ids are passed to the helper once; a helper failure never fails the path's own response; the webhook's response body and status are unchanged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `ingestInboundEmail` returns the ids of every row it created (stored, not-received and the empty row) so the route can queue them; do not queue from inside the ingest (it stays free of QStash).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.3 — every new queue row is sent for preparation`.

### Task 7: Routes: re-check on edit, read again, refuse, restore

**Files:**
- Modify: `src/lib/inbound-invoices.js` (`INBOUND_INVOICE_TRANSITIONS`), `src/app/api/invoices-inbox/[id]/fields/route.js`, `src/app/api/invoices-inbox/[id]/extract/route.js`, `src/app/api/invoices-inbox/bulk-send/route.js`, `src/app/api/invoices-inbox/_helpers.js` and `route.js` (selects)
- Create: `src/app/api/invoices-inbox/[id]/restore/route.js`
- Test: the tests beside each; `src/app/api/invoices-inbox/[id]/restore/route.test.js`

**Interfaces:**
- Produces:
  - Transitions: `received: ['quality_approved','extracted','not_invoice','rejected']`, `quality_approved: ['extracted','not_invoice','rejected']`, `not_invoice: ['received']`; the rest unchanged.
  - `PATCH …/fields`: after saving, calls `recheckInvoiceRow` and returns `review_reasons` with the row. A failed re-check is logged; the save still succeeds.
  - `POST …/extract` ("Read again"): legal from `received`, `quality_approved`, `extracted`; marks the row claimed and calls `prepareInvoiceRow` with `force: true`; from `extracted` it first moves the row back to `quality_approved` under a status guard. Its inline confidence rule is deleted (preparation uses `scoreExtractionConfidence`).
  - `POST …/bulk-send`: a row with a non-empty `review_reasons` is skipped with `reason: 'needs_a_look'`.
  - `POST /api/invoices-inbox/[id]/restore` (`withAuth`, the same gate as the sibling approve routes via `loadInvoiceForCaller`): `not_invoice` → `received`, clears `not_invoice_reason`, `review_reasons` and `prepared_at`, then `queueInvoicePreparation`. Any other status → 409. A row with no file → 400 "This row has no attachment to read".
  - `ROW_SELECT` and the list select gain `review_reasons, prepared_at, duplicate_of_id`.

- [ ] **Step 1: Write the failing tests** for each bullet, plus: restore answers 404 for a caller without access to the row's studio; bulk-send still sends a row with `review_reasons: []`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, plus** `npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns`. Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.3 — re-check on edit, read again, refuse flagged rows in bulk, restore`.

### Task 8: Supplier memory remembers the VAT rate

**Files:**
- Modify: `src/lib/invoices-queue/supplier-defaults.js`, `src/lib/invoices-queue/push-outcome.js`
- Test: the tests beside each

**Interfaces:**
- Produces: `recordSupplierDefault` takes `taxType` and passes `p_tax_type`; `getSupplierDefault` also selects `default_tax_type`; `rememberSupplierCoding` passes `extracted_fields.tax_type` (or `'NONE'` when `tax_amount` is 0 and no type is set).

- [ ] **Step 1: Write the failing tests:** the RPC receives `p_tax_type`; a row with no tax type and non-zero tax passes `null` (so the stored value is kept).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, plus** `npm run check:rpc-names`. Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.3 — supplier memory keeps the VAT rate`.

### Task 9: The current screen shows the result, and nothing else breaks

**Files:**
- Modify: `src/components/InvoicesInbox.jsx`; every other reader of `invoices_queue.status` that lists or counts rows (audit list below); `mobile/app/(staff)/invoices/queue.jsx` and `mobile/lib/accounting.js` only if a status list there needs `not_invoice`
- Test: pure helpers extracted from the component where a rule is worth pinning

**Interfaces:**
- Consumes: `REVIEW_REASON_LABELS`, `POST …/restore`.
- Produces, in today's layout (no two piles yet):
  - A fifth status filter, "Not an invoice" (`not_invoice`). "Awaiting action" is unchanged and does not include it.
  - On each list row and in the open row's header: one chip per review reason (amber `bg-amber-500/10 text-amber-700`; red for `duplicate_file`, `duplicate_number`, `already_in_xero`), or a green "Ready" chip when the row is `extracted` with no reasons.
  - Status pill: `received` with `analysis_queued_at` set shows "Reading…"; `not_invoice` shows "Not an invoice".
  - Open `not_invoice` row: the reason line and a "Move to Needs a look" button (`type="button"`) calling restore. `document_type: statement` reads "This looks like a statement, not a bill"; `document_type: other` reads "This does not look like an invoice".
  - A row with `duplicate_of_id`: one line "Possible duplicate of an earlier invoice" with a button that opens that row.
  - The quality-review panel still appears for a `received` row that has no `analysis_queued_at`. With reason `unreadable` it is titled "This could not be read" and "Read again" is the main button. With reason `duplicate_file` it is titled "This file is already in the queue", Reject is the main button and "Read it anyway" the second. With no reasons (a row from before this change that was never queued) it keeps today's wording. The bulk bar's "Send to Xero (n)" counts only rows with no reasons.
  - The header sentence becomes: "Forward supplier invoices to the address below. Each one is read and checked as it arrives."
- Audit (read each, change only if it lists statuses): `src/app/api/invoices-inbox/unread-count/route.js`, `src/components/Sidebar.jsx`, `src/app/dashboard/today/page.js`, `src/app/api/accounting/coverage/route.js` and `[id]/_line.js`, `src/lib/fte-expense-lifecycle.js`, `src/components/ExpensesManager.jsx`, `src/components/InvoicesManager.jsx`, `src/app/api/cars/[id]/documents/[docId]/route.js`. Rule: `not_invoice` is never counted as awaiting action; a row waiting to be read is.

- [ ] **Step 1: Write failing tests** for any helper you extract (chip list for a row; the "Send to Xero" count).
- [ ] **Step 2: Implement** with small, local additions; do not restructure the component.
- [ ] **Step 3: Run** the component tests, `npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint`, and eslint on changed files.
- [ ] **Step 4: Report the audit:** one line per file, "unchanged because …" or what changed.
- [ ] **Step 5: Commit** `INVOICEPREP.3 — show review reasons, not-an-invoice rows and restore`.

### Task 10: Loose ends carried from phases 1 and 1b

**Files:**
- Modify: `src/lib/invoices-queue/ingest-email.js`, `src/lib/invoices-queue/staged-attachments.js`, `src/app/api/webhooks/invoices-inbound/[token]/route.js`
- Test: the tests beside each

- [ ] **Step 1: Stale-row delete** in the ingest gains `.is('attachment_path', null)`, so a concurrent delivery's finished row is never deleted. Test: a row with a path is not deleted.
- [ ] **Step 2: One copy of the attachment cap.** `SHIM_MAX_ATTACHMENTS_PER_MESSAGE` is imported from `MAX_ATTACHMENTS_PER_MESSAGE` in `src/lib/email-attachment-quota.js` (already pinned to the function by the contract test) and re-exported.
- [ ] **Step 3: Recipient routing.** Collect the candidate slug from each of `ToFull`, `To` and `OriginalRecipient`, look them up with one `.in('invoices_inbound_slug', …)`, and use the first candidate (in that order) that belongs to a studio. Only when none matches is a stray recorded. Tests: an unknown slug in `ToFull` with a real one in `OriginalRecipient` is routed; all unknown → one stray with the first slug.
- [ ] **Step 4: Run** the three test files. Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.3 — ingest loose ends: narrower stale delete, one cap constant, routing by any recipient field`.

### Task 11: Docs, checks and the pull request

**Files:**
- Modify: the design spec (mark phase 2 built; record the sending rule from Global Constraints), `docs/rules/crons-webhooks.md` (the analysis queue now prepares every arrival), `docs/architecture/REFERENCE.md` if it describes the invoice statuses
- Create: `docs/changelog/entries/<PR>.md`

- [ ] **Step 1: Run the CI mirror once, then** `npm run build`.
- [ ] **Step 2: Check no PR exists for the branch, push, open the PR.** The body states: the migration is applied; what is not verified (no real email read end to end until deploy; the screen not checked in a browser); the backlog is untouched until Task 12.
- [ ] **Step 3: Add the changelog entry, commit, push.**

### Task 12: After deploy, with Richard

- [ ] **Step 1: One real email.** Forward one invoice from a known supplier and one from a new one. Expected within two minutes: the first shows "Ready" with supplier, account and VAT filled; the second shows "New supplier".
- [ ] **Step 2: The backlog, with Richard's go-ahead.** About 173 rows are waiting unread (161 emailed, 12 car documents). Queue them by setting `analysis_queued_at = now()` where `status = 'received'` (one SQL statement, shown to Richard first). The sweeper reads ten every two minutes, so it takes about 35 minutes and costs a few euro. Nothing is sent to Xero. Expected: about 71 logos and 5 empty emails move to "Not an invoice", duplicates are flagged, the rest are split between Ready and flagged.
- [ ] **Step 3: Report the counts** by status and reason, and any row left `unreadable`.

---

## Not in this plan

- The two-pile screen, the "Not an invoice" drawer and the removal of the quality routes (phase 3).
- The weekly summary email (phase 4).
- Pre-selecting the remembered VAT rate in the picker (phase 3; this phase stores and compares it).
- A sweep for staged files left under `inbound/` (none exist until the large-email cutover is done).
- Trusted-supplier automatic drafts (parked).

---

## Outcome

Where the code differs from this plan, as built:

- **Migration number.** The migration is `872_invoice_preparation.sql`, not 871: main took 871 (`871_inbody_scans_natural_key.sql`) while the branch was being built. The plan's own note to re-check the number applied.
- **A 13th review reason.** `readiness.js` has 13 reasons, not 12. `not_an_invoice` ("May not be an invoice") was added so that a row a person had already approved, which the reader calls a statement or other document, is read and coded but never comes out Ready.
- **Restore target.** `POST /api/invoices-inbox/[id]/restore` moves a `not_invoice` row to `quality_approved`, not `received`. The person restoring it has vouched for it, so preparation does not set it aside again on the reader's say-so. The same write records who restored it and when, clears the claim and stamps `analysis_queued_at`, so the sweeper is sure to find the row.
- **Bulk analyse rewired.** `bulk-analyse` (the first few selected rows) now claims each row and runs `prepareInvoiceRow` in sequence, and `bulk-queue-analysis` queues through `queueInvoicePreparation`, so there is one preparation path and one publisher.
- **Credit notes.** The extractor gained a `credit_note` document type. A credit note gets the `credit_note` reason, bulk send skips it, and `data-approve` refuses it with a 422 so it can never be sent as a bill.
- **Also added beyond the plan:** a 90 second deadline on the read (`EXTRACTION_TIMEOUT_MS`) and a 10 second limit on the Xero lookup; supplier memory keeps a VAT rate only when a person set it or it was derived from a real subtotal and tax breakdown; the quality reject route accepts rows flagged `unreadable` or `duplicate_file`; a failed preparation that cannot record itself keeps its claim and is retried by the sweeper after 10 minutes.
