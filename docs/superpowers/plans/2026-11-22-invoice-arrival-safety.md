# Invoice Arrival Safety (INVOICEPREP.1, phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No forwarded invoice email is lost or silently dropped, logos stop becoming invoice rows, and every stored file carries a hash, with no change to how invoices are reviewed.

**Architecture:** The inbound webhook keeps auth, dedup and studio lookup, and hands the email to a new `ingestInboundEmail` function that stores attachments idempotently. Any failure after the dedup claim releases the claim so Postmark's retry is processed. Mail that matches no studio is written to a new closed table that masters can list.

**Tech Stack:** Next.js 16 route handlers, Supabase (service role), Postmark inbound webhook, vitest with `createFakeDb` (`tests/helpers/fake-db.js`).

**Spec:** `docs/superpowers/specs/2026-11-22-invoice-ingest-prepare-on-arrival-design.md` (sections 1 and "Database changes"). Phases 2 to 4 get their own plans after this ships.

## Global Constraints

- Work in a fresh worktree on a branch cut from `origin/main` (`invoice-arrival-safety`); never commit in `~/code/un1t-crm` itself.
- Commit messages start `INVOICEPREP.1 — `.
- The migration is forward-only, applied with Supabase MCP to project `iyvtbjjxdggiadzwwvdj` **before** the code deploys; run the security advisor after it. Take the next free number at build time (868 on 22 Nov 2026; re-check after syncing main).
- Every `/api` route runs on the service role: scope in code. The strays route is masters only and uses `withAuth`.
- Destructure `error` from every write and every `.single()`.
- A webhook event is never left marked processed when it recorded nothing (`docs/rules/crons-webhooks.md`).
- No new `console.log`; use `logWarn` / `logError` from `@/lib/log` in new code.
- Responses are `{ success, data?, error? }`.
- No supplier names, sender addresses or customer names in code comments, tests or the PR body (public repo). Test fixtures use `example.com`.
- The review flow, statuses and the Xero push do not change in this phase.
- Before pushing: the CI mirror from `CLAUDE.md`, then `npm run build` (a route is added). Run the full suite once, not beside the build.

## Review Focus

1. **A receipt photographed on a phone and sent as an inline image** must not be skipped as a logo: when an email has no other usable attachment, inline images are kept. (Task 2)
2. **A retry after a partial failure** (first attachment stored, second failed) must end with both rows and no second copy of the first. (Task 3)
3. **A PDF declared as `application/octet-stream`** must be stored, judged by its bytes, not dropped as unsupported. (Task 2)
4. **An email with only an HTML body** must still have readable body text stored. (Task 2)
5. **The same misaddressed email retried by Postmark** must produce one stray, not several. (Task 4)

---

### Task 1: Migration and schema snapshot

**Files:**
- Create: `supabase/migrations/868_invoice_arrival_safety.sql`
- Modify: `supabase/schema/snapshot.json`, `supabase/schema/access.json`, `supabase/schema/database.d.ts` (regenerated)
- Test: `tests/migration-868-invoice-arrival-safety.test.js`

**Interfaces:**
- Produces: columns `invoices_queue.email_body_text text`, `invoices_queue.skipped_attachment_count integer not null default 0`, `invoices_queue.not_invoice_reason text`; index `invoices_queue_location_content_hash_idx` on `(location_id, content_hash) where content_hash is not null`; table `invoice_inbound_strays (id uuid pk default gen_random_uuid(), email_message_id text not null unique, to_address text, from_address text, subject text, reason text not null check (reason in ('unparseable_recipient','unknown_slug')), slug text, received_at timestamptz not null default now())`.

- [ ] **Step 1: Write the failing test**, following an existing `tests/migration-*.test.js` (read the file text, assert on it):

```js
it('closes the strays table to every client session', () => {
  expect(sql).toMatch(/alter table public\.invoice_inbound_strays enable row level security/)
  expect(sql).toMatch(/revoke all on public\.invoice_inbound_strays from anon, authenticated, public/)
  expect(sql).not.toMatch(/create policy/i)
})
it('adds the three queue columns without dropping anything', () => {
  for (const c of ['email_body_text', 'skipped_attachment_count', 'not_invoice_reason']) expect(sql).toContain(c)
  expect(sql).not.toMatch(/drop (column|table)/i)
})
```

- [ ] **Step 2: Run** `npx vitest run tests/migration-868-invoice-arrival-safety.test.js`. Expected: FAIL, file not found.
- [ ] **Step 3: Write the migration.** `set check_function_bodies = off;` header as in `207_xero_supplier_defaults.sql`; the closed-table pattern as in `864_charity_raffle.sql` lines 97 to 104. Grant decision, stated in a comment: `invoices_queue` already has a table-level grant to `authenticated` under its read policy, so the three new columns are readable by the same people who can already read the sender, subject and extracted fields of that row; no narrower grant is made.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Apply** with Supabase MCP `apply_migration`, then `get_advisors` (security). Expected: no new finding naming `invoice_inbound_strays` or `invoices_queue`.
- [ ] **Step 6: Refresh the snapshot** per `docs/rules/build-and-ship.md` (`snapshot-queries.sql` + `scripts/schema-snapshot-build.mjs`, which regenerates `database.d.ts`; refresh `access.json` with it). Run `npm run check:schema-snapshot && npm run check:types`. Expected: both pass.
- [ ] **Step 7: Commit** `INVOICEPREP.1 — migration 868: arrival columns and strays table`.

### Task 2: Pure helpers for an inbound email

**Files:**
- Modify: `src/lib/inbound-invoices.js`
- Test: `src/lib/inbound-invoices.test.js`

**Interfaces:**
- Consumes: `sniffMimeFromBytes` from `@/lib/invoice-extraction`, `htmlToPlainText` from `@/lib/email-content`, `sanitizeDbText` from `@/lib/db-safe-text`.
- Produces:
  - `classifyInboundAttachments(attachments, htmlBody) → { usable: Array<{ name, mime, bytes }>, skippedInline: number, unsupportedTypes: string[] }`
  - `inboundBodyText(body) → string | null` (max `INBOUND_BODY_MAX_CHARS = 20000`)
  - `attachmentMessageId(messageId, index) → string` (`index 0 → messageId`, else `` `${messageId}-${index}` ``; index is the position in the **original** `Attachments` array)
  - `sha256Hex(bytes) → string`
  - Each `usable` item also carries `index` (its original position).

- [ ] **Step 1: Write the failing tests** (PDF bytes: `Buffer.from('%PDF-1.4 x')`; PNG bytes: the 8-byte PNG signature plus padding; base64-encode for `Content`):

```js
const pdf = (over = {}) => ({ Name: 'a.pdf', ContentType: 'application/pdf', Content: PDF_B64, ...over })
const logo = (over = {}) => ({ Name: 'logo.png', ContentType: 'image/png', Content: PNG_B64, ContentID: 'cid1', ...over })
const html = '<p>See attached</p><img src="cid:cid1">'

it('skips an inline image when the email also has a real attachment', () => {
  const r = classifyInboundAttachments([pdf(), logo()], html)
  expect(r.usable.map((a) => a.name)).toEqual(['a.pdf'])
  expect(r.skippedInline).toBe(1)
})
it('keeps inline images when nothing else is usable (a phone photo of a receipt)', () => {
  const r = classifyInboundAttachments([logo({ Name: 'IMG_1.png' })], html)
  expect(r.usable).toHaveLength(1)
  expect(r.skippedInline).toBe(0)
})
it('does not treat an image as inline when the body never references its ContentID', () => {
  expect(classifyInboundAttachments([pdf(), logo()], '<p>hi</p>').usable).toHaveLength(2)
})
it('judges a mislabelled PDF by its bytes', () => {
  const r = classifyInboundAttachments([pdf({ ContentType: 'application/octet-stream' })], '')
  expect(r.usable[0].mime).toBe('application/pdf')
})
it('reports unsupported types and empty content', () => {
  const r = classifyInboundAttachments([{ Name: 'a.docx', ContentType: 'application/msword', Content: 'AAAA' }, pdf({ Content: '' })], '')
  expect(r.usable).toHaveLength(0)
  expect(r.unsupportedTypes).toEqual(['application/msword'])
})
it('keeps the original position as index', () => {
  expect(classifyInboundAttachments([logo(), pdf()], html).usable[0].index).toBe(1)
})
it('prefers TextBody, falls back to HtmlBody, trims to 20000', () => {
  expect(inboundBodyText({ TextBody: ' hello ' })).toBe('hello')
  expect(inboundBodyText({ HtmlBody: '<p>hello</p>' })).toBe('hello')
  expect(inboundBodyText({ TextBody: 'x'.repeat(30000) })).toHaveLength(20000)
  expect(inboundBodyText({})).toBeNull()
})
it('numbers attachments the way existing rows are numbered', () => {
  expect(attachmentMessageId('m', 0)).toBe('m')
  expect(attachmentMessageId('m', 2)).toBe('m-2')
})
it('hashes bytes as lowercase hex sha256', () => {
  expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/inbound-invoices.test.js`. Expected: FAIL, functions not exported.
- [ ] **Step 3: Implement the four functions.** Rules the tests do not fully fix: an image is inline when it has a `ContentID` and `htmlBody` contains `cid:<that id>` (compare with any surrounding `<>` stripped, case-insensitive); mime is `sniffMimeFromBytes(bytes) || ContentType`; usable means the resolved mime is in `INBOUND_INVOICE_SUPPORTED_MIME` and the bytes are non-empty; `unsupportedTypes` is de-duplicated and excludes skipped inline images. Keep the file free of database calls.
- [ ] **Step 4: Run the tests.** Expected: PASS, and the existing cases in the file still pass.
- [ ] **Step 5: Commit** `INVOICEPREP.1 — inbound email helpers: inline images, body text, hash`.

### Task 3: `ingestInboundEmail`, idempotent per attachment

**Files:**
- Create: `src/lib/invoices-queue/ingest-email.js` (starts with `// @ts-check`)
- Test: `src/lib/invoices-queue/ingest-email.test.js`

**Interfaces:**
- Consumes: Task 2's four functions; `inboundInvoiceStoragePath`, `safeInboundFilename`.
- Produces: `ingestInboundEmail(db, { location: { id }, body }) → Promise<{ ok: true, created: string[], alreadyStored: number, skippedInline: number } | { ok: false, error: 'insert_failed' | 'storage_upload_failed' | 'lookup_failed' }>`.

Behaviour the tests pin:
- One `invoices_queue` row per usable attachment, `status: 'received'`, `source_type: 'supplier_email'`, `attachment_bucket: 'inbound-invoices'`, with `content_hash`, `email_body_text` and `email_message_id = attachmentMessageId(MessageID, index)`. `skipped_attachment_count` is set on the first row created for the message.
- Before the loop, read existing rows whose `email_message_id` is `MessageID` or starts with `MessageID-`; an attachment whose id already exists **with an `attachment_path`** is skipped and counted in `alreadyStored`. A row that exists without a path (upload never finished) is deleted and redone.
- No usable attachment: one row with the body, `not_invoice_reason` of `'no_attachment'` or `` `unsupported_type: ${types.join(', ')}` ``, status still `received` (the current screen must keep showing it). If that row already exists, create nothing.
- A failed insert or upload returns `{ ok: false }` at once; a failed upload deletes its own row first. A failed `attachment_path` update is logged and the row kept, as today.

- [ ] **Step 1: Write the failing tests.** Fake storage is a plain object on the fake db: `db.storage = { from: () => ({ upload }) }` with `upload = vi.fn(async () => ({ error: null }))`.

```js
it('stores each attachment once with hash and body', async () => {
  const r = await ingestInboundEmail(db, { location: LOC, body: email([pdf(), pdf({ Name: 'b.pdf' })]) })
  expect(r).toMatchObject({ ok: true, alreadyStored: 0 })
  const rows = await all(db)
  expect(rows.map((x) => x.email_message_id).sort()).toEqual(['m1', 'm1-1'])
  expect(rows.every((x) => x.content_hash && x.attachment_path && x.email_body_text === 'hello')).toBe(true)
})
it('a retry after the second upload failed leaves two rows, not three', async () => {
  upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'boom' } })
  expect(await ingestInboundEmail(db, args)).toEqual({ ok: false, error: 'storage_upload_failed' })
  expect(await all(db)).toHaveLength(1)
  const again = await ingestInboundEmail(db, args)
  expect(again).toMatchObject({ ok: true, alreadyStored: 1 })
  expect(again.created).toHaveLength(1)
  expect(await all(db)).toHaveLength(2)
})
it('records why an email had nothing usable', async () => {
  await ingestInboundEmail(db, { location: LOC, body: email([{ Name: 'a.docx', ContentType: 'application/msword', Content: 'AAAA' }]) })
  const [row] = await all(db)
  expect(row).toMatchObject({ status: 'received', not_invoice_reason: 'unsupported_type: application/msword', attachment_path: null })
})
it('does not add a second empty row on retry', async () => {
  await ingestInboundEmail(db, { location: LOC, body: email([]) })
  await ingestInboundEmail(db, { location: LOC, body: email([]) })
  expect(await all(db)).toHaveLength(1)
})
it('counts skipped logos on the first row', async () => {
  await ingestInboundEmail(db, { location: LOC, body: email([pdf(), logo()], { HtmlBody: html }) })
  expect((await all(db))[0].skipped_attachment_count).toBe(1)
})
it('reports an insert failure', async () => {
  const bad = createFakeDb({ tables: seed, errors: { invoices_queue: { insert: { message: 'x' } } } })
  expect((await ingestInboundEmail(bad, args)).ok).toBe(false)
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/invoices-queue/ingest-email.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `ingestInboundEmail`.** Move the insert, upload and path-update sequence out of the webhook route unchanged in order (insert, upload, update); add the pre-read and the new columns. Type `db` as `import('@/lib/supabase').Db`.
- [ ] **Step 4: Run the tests and** `npm run check:types && npm run check:select-columns`. Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.1 — ingestInboundEmail: idempotent per attachment`.

### Task 4: Webhook route releases its claim and records strays

**Files:**
- Create: `src/lib/invoices-queue/strays.js` (`// @ts-check`)
- Modify: `src/app/api/webhooks/invoices-inbound/[token]/route.js`
- Test: `src/app/api/webhooks/invoices-inbound/[token]/route.test.js`, `src/lib/invoices-queue/strays.test.js`

**Interfaces:**
- Consumes: `ingestInboundEmail` (Task 3); `releaseWebhookEvent({ db, provider, eventId })` from `@/lib/webhook-events`.
- Produces: `recordInboundStray(db, { messageId, to, from, subject, reason, slug }) → Promise<{ ok: boolean }>`; a unique violation on `email_message_id` is success. `to` is `body.OriginalRecipient || body.To`.

- [ ] **Step 1: Write the failing tests.** Mock `@/lib/supabase` (`createServerClient` returns the fake db), `@/lib/invoices-queue/ingest-email` and `@/lib/webhook-events` (`recordWebhookEvent` resolves `{ seen: false }`; keep the real `WEBHOOK_PROVIDERS`). Set `POSTMARK_INBOUND_WEBHOOK_TOKEN` in the test.

```js
it('releases the dedup claim and answers 500 when storing fails', async () => {
  ingestInboundEmail.mockResolvedValue({ ok: false, error: 'storage_upload_failed' })
  const res = await POST(req(email()), ctx)
  expect(res.status).toBe(500)
  expect(releaseWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'inbound-invoice:m1' }))
})
it('releases the claim when the studio lookup fails', async () => { /* errors on locations select → 500 + release */ })
it('does not release on success', async () => {
  ingestInboundEmail.mockResolvedValue({ ok: true, created: ['r1'], alreadyStored: 0, skippedInline: 0 })
  expect((await POST(req(email()), ctx)).status).toBe(200)
  expect(releaseWebhookEvent).not.toHaveBeenCalled()
})
it('records a stray for an unknown address and answers 200', async () => {
  const res = await POST(req(email({ To: 'nowhere-invoices@mail.un1tdublin.com', ToFull: undefined })), ctx)
  expect(res.status).toBe(200)
  expect(strays(db)).toEqual([expect.objectContaining({ reason: 'unknown_slug', slug: 'nowhere', email_message_id: 'm1' })])
})
it('records a stray for an address it cannot parse', async () => { /* reason 'unparseable_recipient' */ })
it('releases the claim and answers 500 when the stray cannot be written', async () => { /* errors on strays insert */ })
it('still answers 404 on a wrong token and 400 without a MessageID', async () => { /* unchanged behaviour */ })
```

In `strays.test.js`: inserting the same `messageId` twice returns `{ ok: true }` both times and leaves one row.

- [ ] **Step 2: Run both test files.** Expected: FAIL.
- [ ] **Step 3: Implement.** In the route, wrap everything after the dedup claim so that every 5xx exit calls `releaseWebhookEvent` first; replace the attachment loop and the empty-row branch with one `ingestInboundEmail` call; replace the two "ignored" branches with `recordInboundStray` (200 on success). Replace the route's `console.*` calls in touched branches with `logWarn` / `logError`. Update the header comment: the "Failure modes" list now says unknown addresses are recorded, not only logged.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.1 — inbound webhook: release on failure, record strays`.

### Task 5: Hash on manual upload

**Files:**
- Modify: `src/app/api/invoices-inbox/route.js` (POST, the insert near line 197)
- Test: `src/app/api/invoices-inbox/route.upload.test.js`

**Interfaces:**
- Consumes: `sha256Hex` (Task 2).

- [ ] **Step 1: Write the failing test:** POST a small PDF as multipart for a studio the mocked master can use; assert the stored row's `content_hash` equals `sha256Hex` of the same bytes. Mock `@/lib/auth` and `@/lib/supabase` as `src/app/api/invoices-inbox/bulk-send/route.test.js` does.
- [ ] **Step 2: Run it.** Expected: FAIL, `content_hash` is null.
- [ ] **Step 3: Add `content_hash: sha256Hex(bytes)` to the insert.** Nothing else in the route changes; duplicate handling belongs to phase 2.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.1 — hash uploaded invoices`.

### Task 6: Show the body, the reason and the strays

**Files:**
- Create: `src/app/api/invoices-inbox/strays/route.js`, `src/components/invoices/InboundStraysNotice.jsx`
- Modify: `src/app/api/invoices-inbox/_helpers.js` (`ROW_SELECT`), `src/components/InvoicesInbox.jsx` (`DetailHeader` area and the top of the page), `src/lib/openapi.js`
- Test: `src/app/api/invoices-inbox/strays/route.test.js`, `src/components/invoices/InboundStraysNotice.test.jsx`

**Interfaces:**
- Produces: `GET /api/invoices-inbox/strays` → `{ success: true, data: Array<{ id, to_address, from_address, subject, reason, slug, received_at }> }`, newest first, last 90 days, at most 50. `export const GET = withAuth({ master: true, location: false }, …)` (check `src/lib/with-auth.js` for the exact option names).
- `ROW_SELECT` gains `email_body_text, not_invoice_reason, skipped_attachment_count`. The list query in `route.js` GET does **not** gain `email_body_text` (it is read only when a row is opened).

- [ ] **Step 1: Write the failing tests.**
  - Route: a non-master gets the refusal `withAuth` gives for `master: true`; a master gets rows newest first; a row older than 90 days is left out.
  - Component: with two strays it renders "2 emails could not be matched to a studio" and, when opened, each row's to-address, from-address, subject and date; with none it renders nothing.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The route, named columns only.
  - `InboundStraysNotice`: fetches the route on mount, renders nothing on an empty list or an error; an amber chip (`bg-amber-500/10 text-amber-700`) that expands to the list; the toggle is a `type="button"`. Rendered at the top of `InvoicesInbox` only when `isMaster`.
  - Open row: under the header, when `row.not_invoice_reason` is set show one line, "Nothing usable was attached" for `no_attachment` or "The attachment type is not supported (…types…)" for the other; when `row.skipped_attachment_count > 0` show "n email images skipped"; when `row.email_body_text` is set show it in a collapsed "Email text" block (`whitespace-pre-wrap`, plain text, never as HTML).
  - Register the route in `src/lib/openapi.js`.
- [ ] **Step 4: Run** the two tests plus `npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns && npm run check:mobile-parity`. Expected: PASS. (`mobile/app/(staff)/invoices/queue.jsx` reads the list route, which is unchanged.)
- [ ] **Step 5: Check it in the browser.** `preview_start` the dev server, open `/invoices` as a master: the page loads with no console error, and opening a row with no attachment shows the new reason line. If the local database cannot be reached (`.env.local` holds placeholders), say so in the PR and rely on the Vercel preview.
- [ ] **Step 6: Commit** `INVOICEPREP.1 — show email text, skip reasons and unmatched emails`.

### Task 7: Rules, checks and the pull request

**Files:**
- Modify: `docs/rules/crons-webhooks.md` (one line: the invoices inbound webhook releases its claim on failure and records unmatched mail in `invoice_inbound_strays`), `docs/architecture/REFERENCE.md` if it lists the queue's columns
- Create: `docs/changelog/entries/<PR>.md` (after the PR number exists)

- [ ] **Step 1: Run the CI mirror** from `CLAUDE.md`, once. Expected: all pass.
- [ ] **Step 2: Run** `npm run build`. Expected: success.
- [ ] **Step 3: Check the PR is not already merged or superseded, then push and open it** (`git push -u origin HEAD`, `gh pr create --base main`). The body states: migration 868 is already applied; what is not verified (no real Postmark delivery was replayed).
- [ ] **Step 4: Add the changelog entry** `| #<n> | INVOICEPREP.1 — invoice emails are never lost on a retry | 2026-11-22. … |`, commit, push.
- [ ] **Step 5: After merge and deploy,** forward one test email with a PDF and a signature logo to a studio address and one to a misspelled address. Expected: one row with a hash, body text and "1 email image skipped"; one entry in the unmatched list. Report the result to Richard.

---

## Not in this plan

Preparation on arrival, the two piles, the weekly email and the backlog clean-up (design phases 2 to 4). Rows still wait in "Awaiting review" exactly as today until phase 2 ships.
