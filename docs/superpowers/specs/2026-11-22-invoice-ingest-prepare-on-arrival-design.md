# INVOICEPREP.1 — invoices prepared on arrival, one click to send

Date: 2026-11-22. Status: approved by Richard 22 Nov 2026 (the
recommendations, the screen mockup and the four calls under "Decisions
settled"). Trusted suppliers (section 7) stays parked.

Progress: phase 1 (arrival safety) and phase 1b (large emails) are live. Phase 2
(preparation, INVOICEPREP.3) is built on branch `invoice-prepare-on-arrival`, pending
merge; migration 872 is the one it needs. Phases 3 and 4 are not started.

## Intent

Richard forwards a supplier invoice to a studio's invoices address. Today it
then waits for four separate human steps: approve that it is legible, click
Analyse, check and code the fields, send to Xero. The review of 22 Nov 2026
found that the steps are not being done.

After this change an invoice is read, checked and coded the moment it arrives.
The person's job shrinks to one decision: send it, or fix the one thing the
system could not settle.

## What the review found (live data, 22 Nov 2026)

- Nothing has gone from the queue to Xero since 7 July 2026. 161 emailed rows
  are waiting at one studio.
- 71 of those 161 are small PNG images (average 22 KB): email signature logos,
  each stored as its own row.
- 41 of 133 decided emailed rows were rejected: 11 as duplicates, 6 as already
  in Xero, 25 marked "error" in the launch month.
- 17 of the 92 bills pushed to Xero were later voided or deleted there.
- The reading itself is good: 90 of 92 sent rows scored high confidence.
- The median wait between extraction and approval was about three hours.

Faults in the current code:

1. **An invoice can be lost on a retry.** The inbound webhook
   (`src/app/api/webhooks/invoices-inbound/[token]/route.js`) records the
   message as seen before it stores anything. If a row insert or a storage
   upload then fails it answers 5xx, Postmark retries, and the retry is
   answered "deduped". `releaseWebhookEvent` exists in
   `src/lib/webhook-events.js` but this route never calls it. With two
   attachments, a failure on the second loses the second.
2. **Some emails vanish without a trace.** An unknown address, or an email
   whose only attachment is an unsupported type (HEIC, Word, zip), is answered
   200 and written to the log only.
3. **The email body is discarded.** An invoice in the body or behind a link
   becomes an empty row.
4. **Every image attachment becomes a row.** No filter for inline images.
5. **Duplicates are caught last.** The only check is by invoice number at the
   moment of the Xero push (`findXeroBillByNumber`). `content_hash` is filled
   only by the email hunt; all 294 emailed rows have none.
6. **Two gates stand in front of the reading.** The legibility gate exists to
   save the cost of one extraction, which is a few cents.
7. **No feedback.** The sender hears nothing.
8. Small: `/api/invoices-inbox/[id]/extract` scores confidence with its own
   inline rule (`Number.isFinite(total)`) instead of
   `scoreExtractionConfidence` (`total > 0`), so a zero total can score high
   there.

## Design

### 1. Arrival: nothing is lost, nothing useless is stored

Changes to the inbound webhook:

- **Safe retry.** On any 5xx exit after the dedup insert, call
  `releaseWebhookEvent` so Postmark's retry is processed. Rows already written
  for earlier attachments of the same message are kept, and the retry skips an
  attachment whose `email_message_id` (`<id>` or `<id>-<n>`) already exists
  instead of failing on the unique constraint. This follows the rule in
  `docs/rules/crons-webhooks.md`: an event is never marked processed when it
  recorded nothing.
- **A repeat delivery is processed again.** (Added at the whole-branch review.)
  Storing is idempotent, so a delivery whose dedup key is already claimed is
  not dropped: it runs the same steps and adds nothing if everything is
  stored. This covers a release that itself failed and a request the platform
  killed partway. A failed write of the file's path fails the call, so the
  provider retries it.
- **Keep the body.** Store the plain-text body (trimmed to 20,000 characters)
  on the row in a new `email_body_text` column, and show it on the open
  invoice.
- **Skip logos.** An attachment is not stored as an invoice when it is an
  image carrying a `ContentID` that the HTML body references (an inline
  image). There is no size rule, so a small photographed receipt is never
  skipped. Skipped images are counted on the message's first row
  (`skipped_attachment_count`), not stored. A logo sent as an ordinary
  attachment is stored, read once, and set aside by preparation as
  `document_type: other`. When an email has no other usable attachment its
  inline images are kept, because a phone sends a photographed receipt as an
  inline image. An inline image of 100 KB or more is always kept, for the
  same reason when the photo arrives beside a PDF (added at the whole-branch
  review; to confirm with Richard).
- **Judge a file by its bytes.** An attachment declared as a generic type
  (`application/octet-stream`) is accepted when its bytes are a PDF or a
  supported image.
- **Show what could not be used.** An email with no usable attachment still
  gets one row, now carrying the body and a `not_invoice_reason`
  (`no_attachment`, `unsupported_type: <types>`). In phase 1 the row stays
  `received` so the current screen keeps showing it; phase 2 moves it to the
  new `not_invoice` status (preparation does this when it finds no file).
- **Catch misaddressed mail.** An email to an address that resolves to no
  studio is written to a new small table, `invoice_inbound_strays` (message id,
  to, from, subject, reason, received time). Masters see a count and the list
  on the invoices page. The table is closed to client sessions; it is read
  through a service-role route.
- **Hash every file.** `content_hash` (SHA-256 of the bytes) is set for emailed
  rows and for uploads through `POST /api/invoices-inbox`, as the email hunt
  already does.

### 2. Preparation: one function, run on arrival (built in phase 2)

`prepareInvoiceRow(db, row, deps)` in `src/lib/invoices-queue/prepare.js` replaces the
manual sequence. It is the only place a row is read and checked. It runs through the
`invoice-analysis` QStash queue (parallelism 2) with the sweeper cron
(`process-invoice-analysis`) as the delivery guarantee. Every arrival path hands its new
row ids to `queueInvoicePreparation` (`src/lib/invoices-queue/queue-preparation.js`),
which stamps `analysis_queued_at` (the sweeper claims only stamped rows) and publishes
each id; it never throws and never waits for the result. The paths are the inbound
email webhook (a retried email also queues the rows an earlier attempt stored), the
upload route, the contractor, expense, car-document and card-receipt/hunt enqueue
helpers in `enqueue.js`, and the coverage upload route. A receiptless expense row is
born `extracted` with the reasons its typed fields give and is not queued.

The caller claims the row first (`analysis_claimed_at`); the queue worker, the sweeper,
"Extract" / "Read again" and the bulk extract all do. Every write that
`prepareInvoiceRow` makes is guarded on the status still being `received` or
`quality_approved`, clears both queue columns and stamps `prepared_at`; if the row moved
on in the meantime the outcome is `skipped` and nothing is written.

Steps, in order:

1. **No file.** A row with no attachment becomes `not_invoice` (reason
   `no_attachment` unless the row already carried one).
2. **Download and hash.** From the row's own bucket. A failed or empty download is
   `unreadable`. `content_hash` is filled if the row has none.
3. **Duplicate by file.** An earlier row at the same studio with the same hash that is
   not `rejected` or `not_invoice` (earlier by `received_at`, ties by smaller id, so two
   copies never flag each other): flag `duplicate_file`, set `duplicate_of_id`, leave the
   status as it is, and make no read. A person's "Read again" runs with `force` and skips
   this check.
4. **Read.** `extractInvoiceFieldsFromBytes`, with a 90 second deadline
   (`EXTRACTION_TIMEOUT_MS`). The reader reports `document_type`: `invoice`, `receipt`,
   `credit_note`, `statement` or `other`, and never chooses the tax type. Just before
   the paid read the status is checked again. A failed read is `unreadable` with the
   error text.
5. **Set aside.** Only a row still `received` whose type is `statement` or `other` moves
   to `not_invoice`, with `not_invoice_reason: document_type: <type>`.
6. **Match the supplier.** `resolveExtractionDefaults`: exact case-insensitive match to a
   Xero contact, then the remembered account and category. The remembered VAT rate is not
   patched in.
7. **Resolve VAT.** `resolveBillTaxType` against the studio's cached Xero tax rates, on the
   server. A rate derived from the document's own figures is stored with
   `tax_type_source: 'derived'`.
8. **Duplicate by number, then Xero.** Another row at the studio with the same Xero
   contact and invoice number (trimmed, case-insensitive) in `extracted`,
   `data_approved` or `forwarded`: `duplicate_number` and `duplicate_of_id`. Then
   `findXeroBillByNumber`, tried once with a 10 second limit: a match flags
   `already_in_xero`. A failed or slow lookup raises nothing.
9. **Write.** `status: 'extracted'`, the fields, `extraction_confidence`
   (`scoreExtractionConfidence`) and `review_reasons`.

A row is **Ready** when it is `extracted` and `review_reasons` is empty. There are 13
reasons (`src/lib/invoices-queue/readiness.js`), listed in display order with the label
the screen shows:

| Reason | Label | Raised when |
|---|---|---|
| `unreadable` | Could not be read | the download, the read or the preparation itself failed |
| `duplicate_file` | Possible duplicate | same file already in the queue |
| `duplicate_number` | Possible duplicate | same supplier and number in the queue |
| `already_in_xero` | Already in Xero | Xero holds a bill with this number |
| `credit_note` | Credit note | the reader calls it a credit note |
| `not_an_invoice` | May not be an invoice | the reader calls it a statement or other document, on a row a person had already approved |
| `new_supplier` | New supplier | no matched Xero contact |
| `no_account` | No account yet | supplier matched but no account remembered |
| `no_vat_rate` | No VAT rate | no tax type and the VAT status is unmatched or ambiguous, or the tax figures are missing or cannot back a derived rate |
| `vat_differs` | VAT differs from last time | the document shows zero VAT, the rate was not set by a person, and the supplier's remembered rate is above zero |
| `totals_mismatch` | Totals don't add up | net plus VAT is more than 1c from the total |
| `missing_date` | No invoice date | date not read |
| `zero_total` | Total is zero | total is zero or not read |

Two reasons go beyond the original design: `credit_note` and `not_an_invoice`.

**Credit notes.** A credit note sent as a bill would be booked the wrong way round, so
it is never Ready: preparation flags it, bulk send skips it like any flagged row, and
`data-approve` refuses it outright (422, "This is a credit note. It cannot be sent as a
bill."). There is no route that sends a credit note in this phase.

**A row a person vouched for is never set aside.** Contractor invoices, expense receipts,
restored rows and rows sent for analysis arrive at `quality_approved`. If the reader calls
one a statement or other document it is still read and coded, and comes out `extracted`
with `not_an_invoice` (so it is never Ready), not `not_invoice`.

**Editing.** Saving a field edit on an `extracted` row calls `recheckInvoiceRow`: it
re-derives the VAT unless a person chose it, recomputes the reasons and the
number-duplicate link, and carries `already_in_xero` and `duplicate_file` over as they
were. It downloads nothing, reads nothing and calls no Xero API, so fixing the flagged
field moves the row to Ready. The fields route returns the new `review_reasons`. A recheck
that fails changes nothing.

**Supplier memory.** `xero_supplier_defaults.default_tax_type` is written by
`rememberSupplierCoding` when a bill is sent. It keeps a rate only when a person set it,
the type has no source (an older row), or it was derived and the row has a real subtotal
and tax breakdown; a stated zero tax with a breakdown is remembered as `NONE`. A guessed
rate (for example a till receipt with no VAT breakdown) never overwrites the real one.
It is used only for the `vat_differs` comparison.

**Failure.** An error while preparing is written to the row as `unreadable` with the error
text, which also clears the claim. If that write itself fails, or the queue's call throws,
the claim is kept and the sweeper retries the row once the claim is 10 minutes old,
rather than paying for a read every two minutes.

### 3. States

The status column and the Xero push are kept; the two human gates are gone from the
path, though the old routes remain until phase 3.

- Emailed, uploaded, card-receipt, car-document and hunted rows: `received` →
  (preparation) → `extracted`. Nobody has to approve the file first.
- Contractor invoices and expense receipts still enter at `quality_approved` after the
  owner's approval, and are prepared at once in the same way.
- New status `not_invoice` (migration 872 widens the status check), with one way out:
  `POST /api/invoices-inbox/[id]/restore`. It works only from `not_invoice` (otherwise
  409), needs a file (otherwise 400), and moves the row to `quality_approved`, not back to
  `received`: the person restoring it has vouched for it, so preparation will not set it
  aside again on the reader's say-so. It records who and when, clears
  `not_invoice_reason`, `review_reasons`, `prepared_at`, `duplicate_of_id`, the extraction
  error and the claim, stamps `analysis_queued_at` and queues the row. The read runs with
  the duplicate-by-file check on.
- `extracted` → `data_approved` → `forwarded` and `rejected` are unchanged.
- `unreadable` and `duplicate_file` leave the status where it was (`received` or
  `quality_approved`), so those rows can still be rejected from the quality stage; the
  quality reject route accepts them.
- The sweeper's claim function (`claim_invoice_analysis_batch`) now takes `received` as
  well as `quality_approved` rows, only those stamped with `analysis_queued_at`.

The pile is derived, not stored as a status: Ready is `extracted` with empty
`review_reasons`; Needs a look is everything else still waiting.

Routes still in place (removed in phase 3 once the screen no longer calls them):
`quality-approve`, `bulk-queue-analysis`, the separate `quality-reject` and `data-reject`.
`bulk-queue-analysis` now queues through `queueInvoicePreparation`. `bulk-analyse`
(the first few selected rows) now runs `prepareInvoiceRow` in sequence with the same
claim as "Read again". `extract` stays as "Read again", claims the row, runs
`prepareInvoiceRow` with `force`, and no longer scores confidence with its own rule
(fault 8 fixed).

### 4. Sending

No change to how a bill is built or pushed (`pushQueueRowToXero`,
`recordPushOutcome`): one summary line, tax-inclusive, draft status, source
file attached, bill id saved before attaching.

- "Send to Xero" on an open row is today's `data-approve`. It still sends a row with
  reasons if a person clicks it, except a credit note (above); the screen disables the
  button until the row is Ready.
- "Send all ready" is today's `bulk-send`. It skips any row whose `review_reasons` is not
  empty, checked on the server, and leaves it untouched.
- Nothing is ever sent to Xero without a person's click: preparation only reads, checks
  and codes, and its one Xero call is the read-only bill lookup.
- Who may send is unchanged: master or owner at the studio for a single row,
  the `bookkeeper` permission for bulk.

### 5. The screen

Mockup: `docs/mockups/invoices-two-piles.html` (clickable; the folder is
excluded from git on Richard's machine, so the description here is the
record). Changes to `src/components/InvoicesInbox.jsx`:

- **Header.** The forwarding address stays, with the number that arrived this
  week. The "two-step review" sentence goes. A studio with an address but no
  Xero connection shows "Connect Xero to send" in place of the address.
- **Source tabs** unchanged. The status filter becomes three views: To do,
  Sent, Rejected.
- **To do** is two piles on the left. Needs a look comes first; each row shows
  supplier, number, date, amount, account and one reason chip. Ready shows the
  same without a chip, and has the page's one primary button, "Send all ready
  (n)".
- **Not an invoice** is a collapsed drawer under the piles: a count of logos
  skipped, and the rows set aside, each with "Move to Needs a look".
- **Open invoice** sits beside the list as today: document on the left, fields
  on the right. A Needs a look row shows a one-sentence explanation at the top
  and highlights the field to fix, with the likely choices as buttons under
  it. A possible duplicate shows the earlier invoice under the new one.
  Account and VAT carry a "remembered" tag only when they came from supplier
  memory. The email body is shown under the document when present.
- **Buttons** on an open row: Send to Xero (disabled until Ready), Edit
  fields, Reject. The quality-review and "Run Claude Vision" panels go.
- The Xero supplier, account and VAT pickers and the reject-with-reason form
  are reused as they are.

The mobile queue screen (`mobile/app/(staff)/invoices/queue.jsx`) reads the
same list; it must keep working with the new status and reasons but gets no
new design in this work.

### 6. Feedback

A weekly email, Monday 08:00 studio time, to each person who can send at a
studio, sent only when something is waiting: how many are Ready, how many need a look
and why, how many were set aside, with one link to the page. Richard is the reviewer
at every studio today, so in practice it goes to him. Nothing is sent
back to the address the invoice came from, because that address can be the
supplier's.

This is a new cron: `defineCron` with a heartbeat, its own `maxDuration`, a
`vercel.json` entry and a `cron_heartbeats` row, with studio time taken from
`@/lib/location-time`.

### 7. Trusted suppliers (optional, off by default)

A per-studio switch: a Ready invoice from a supplier with at least three
previously approved bills is sent to Xero as a draft without a click, and
listed in the weekly email. Bills arrive in Xero as drafts, so approval there
remains the second check. Not built until Richard asks for it.

### 8. Clearing the backlog

After phase 2 is live, run preparation once over every `received` row. The
sweeper claims only rows stamped with `analysis_queued_at`, so the clean-up is one
statement that stamps them (shown to Richard first); the sweeper then reads ten every
two minutes.
Existing rows did not record whether an image was inline, so the old logos are
read like any other file and set aside as `document_type: other` (about 71
reads, roughly one euro in total). Expected result at the studio with 161
waiting: about 71 set aside, the 25 same-file groups flagged, the rest sorted
into the two piles. Nothing is sent to Xero by the clean-up.

## Database changes (one forward-only migration per phase)

Phase 1 is migration 868 (`email_body_text`, `skipped_attachment_count`,
`not_invoice_reason`, the strays table, the hash index). Phase 2 is migration 872
(`review_reasons`, `prepared_at`, `duplicate_of_id`, the `not_invoice` status,
`default_tax_type` and the seven-argument `upsert_supplier_default`, and the claim
function taking `received` rows). The list below is the whole design.

- `invoices_queue`: `email_body_text text`, `skipped_attachment_count int`,
  `prepared_at timestamptz`, `review_reasons text[] not null default '{}'`,
  `duplicate_of_id uuid references invoices_queue(id) on delete set null`,
  `not_invoice_reason text`; status CHECK gains `not_invoice`; index on
  `(location_id, content_hash)`.
- `xero_supplier_defaults`: `default_tax_type text`; `upsert_supplier_default`
  gains the matching parameter.
- New table `invoice_inbound_strays`, closed to client sessions.
- Grant decision: `invoices_queue` already has a table-level grant to
  signed-in sessions under its read policy, so the new columns are readable by
  the same people who can already read that row's sender, subject and
  extracted fields. No narrower grant is made.
- After the migration: refresh the schema snapshot and `access.json`, run the
  security advisor, `check:select-columns`, `check:rpc-names`.

## Phasing

1. **Arrival safety** (no screen change): safe retry, body kept, logos
   skipped, strays table, hash on arrival. Fixes faults 1 to 5 on its own.
2. **Preparation (built, pending merge)**: `prepareInvoiceRow`, the 13 reasons,
   `not_invoice`, restore, supplier VAT memory, every arrival queued, credit notes
   refused, bulk send skipping flagged rows. The current screen keeps working and now
   shows the reasons, the not-an-invoice rows and a restore button: rows simply arrive
   already extracted.
3. **Screen** (not started): the two piles, the drawer, the new open-invoice panel; the
   `quality-approve` and `bulk-queue-analysis` routes removed, the two reject routes
   merged, "Move to Needs a look" wording. Then the backlog clean-up.
4. **Weekly email** (not started).
5. **Trusted suppliers**, only on request.

**Phase 1b: large emails (INVOICEPREP.2).** An email whose attachments total
more than about 3.3 MB exceeds the platform's request limit and never reached
the webhook. The existing `postmark-inbound-shim` Edge Function now has a
second target for invoices. It uploads each attachment to the `inbound-invoices`
bucket under `inbound/<MessageID>/<index>.<ext>` and forwards a small JSON body
to the webhook, which reads the files from Storage. An attachment the function
could not move (over 25 MB, or an upload failure) becomes a visible row with
`attachment_not_received: too_large` or `attachment_not_received: rehost_failed`.
The plan is `docs/superpowers/plans/2026-11-22-invoice-large-email-shim.md`.
It is live only after the cutover steps in that plan's Task 5.

Each phase is its own PR with its own changelog entry.

## Testing

- Webhook: a storage failure on the second of two attachments, then a retry,
  ends with both rows and no duplicate of the first. An inline logo is
  skipped. An unknown address writes a stray.
- `prepareInvoiceRow` with `createFakeDb`: one test per reason in the table,
  one for Ready, one for same-file duplicate (no extraction call made), one
  for a failed Xero lookup (preparation still completes).
- `bulk-send` refuses a row with reasons; `data-approve` refuses a credit note.
- A row a person approved is never set aside; restore returns a set-aside row to
  `quality_approved` and queues it.
- A `role-access` case for `invoice_inbound_strays` and the new columns.
- Screen: a row moves from Needs a look to Ready when its flagged field is
  set.

## Out of scope

- Returning to Xero's own bills email address (replaced earlier because its
  reading was worse).
- Extracting line items (the bill stays one summary line).
- A new mobile design for the queue.
- Changing who may approve or send.

## Decisions settled (Richard, 22 Nov 2026)

1. **Reviewer:** Richard reviews and sends, including at the studio with the
   backlog.
2. **Logo rule:** inline images only; no size threshold.
3. **Summary email:** yes, weekly, Monday 08:00 studio time.
4. **Statements:** set aside in the Not an invoice drawer.

Still parked: trusted suppliers (section 7), built only if Richard asks.
