# Invoice Large-Email Shim (INVOICEPREP.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A forwarded invoice email with large attachments (up to Postmark's 35 MB) reaches the CRM, instead of being rejected before the webhook runs.

**Architecture:** The existing Supabase Edge Function `postmark-inbound-shim` already moves attachment bytes into Storage and forwards a small JSON body for the support inbox. It gains a second target, chosen by which secret the URL token matches, that stages into the `inbound-invoices` bucket and forwards to the invoices webhook. On the CRM side, `ingestInboundEmail` learns to read a staged attachment from Storage where it used to decode base64. An email sent the old way (attachment inline) keeps working, so the two sides can deploy in either order.

**Tech Stack:** Supabase Edge Function (Deno, TypeScript), Next.js 16 route handlers, Supabase Storage, vitest with `createFakeDb`.

**Spec:** `docs/superpowers/specs/2026-11-22-invoice-ingest-prepare-on-arrival-design.md`, the paragraph under "Phasing" that begins "Not yet covered by any phase". The support-inbox precedent is `supabase/functions/postmark-inbound-shim/index.ts` and `src/lib/email-attachment-staging.js`; read both headers before starting.

**Depends on:** PR #2535 (INVOICEPREP.1) merged. Cut the branch from `origin/main` after it lands.

## Global Constraints

- Work in a fresh worktree on a branch cut from `origin/main` (`invoice-large-email-shim`). Commit messages start `INVOICEPREP.2 — `.
- **The support inbox must not change behaviour.** Every constant, path, bucket, log line and response the shim produces for a request whose token matches `POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN` (or its `_PREVIOUS`) stays byte-for-byte what it is today. `src/lib/email-attachment-staging.contract.test.js` must pass unchanged in its existing assertions.
- The shim is a bytes-mover. It reads and writes no table and makes no routing decision beyond "which secret matched".
- The forward is always built with the shim's own primary token for the matched target, never with the caller's token.
- The staged-attachment wire contract (marker key `_un1t_staged`, version `1`, path `inbound/<MessageID>/<index>.<ext>`, error reasons) is the existing one in `src/lib/email-attachment-staging.js`. Do not fork it.
- An attachment that could not be moved or read must leave a visible row; an email is never dropped because a file could not be moved.
- Invoices target values: bucket `inbound-invoices`; forward path `/api/webhooks/invoices-inbound`; secrets `POSTMARK_INBOUND_WEBHOOK_TOKEN` and `POSTMARK_INBOUND_WEBHOOK_TOKEN_PREVIOUS`; per-attachment ceiling 25 MiB (`26_214_400`), at most 25 attachments per message.
- No migration. No new table. No new env var on Vercel.
- Deploying the Edge Function, setting its secret, and repointing Postmark are **not** part of the automated build: they are Task 5, done with Richard.
- No supplier names, sender addresses or customer names in code, tests or the PR body. No `console.*` in `src/`; the Deno shim keeps its existing `console.*` style.
- Before pushing: the CI mirror from `CLAUDE.md` once, then `npm run build`.

## Review Focus

1. **A support-inbox email after the change** must be staged and forwarded exactly as before. (Task 1)
2. **An attachment the shim could not move** (`too_large`, `upload_failed`) must appear as a row a person can see, with the file name and reason. (Task 3)
3. **A retry of a staged email** must not store an attachment twice, and must still find the staged file. (Task 3)
4. **An email sent straight to the Vercel URL with inline attachments** (the revert path) must still be stored. (Task 3)
5. **A staged marker whose path does not match the message** (forged or mangled) must not make the CRM read an arbitrary Storage object. (Task 2)

---

### Task 1: The shim gains an invoices target

**Files:**
- Modify: `supabase/functions/postmark-inbound-shim/index.ts`
- Modify: `src/lib/email-attachment-staging.contract.test.js`

**Interfaces:**
- Produces: for a request whose URL token matches `POSTMARK_INBOUND_WEBHOOK_TOKEN` (or `_PREVIOUS`): attachments uploaded to `inbound-invoices` at `inbound/<MessageID>/<index>.<ext>`, each attachment's `Content` emptied and marked `{ v: 1, path, bytes }` or `{ v: 1, error }`; the body forwarded to `<CRM_WEBHOOK_BASE_URL>/api/webhooks/invoices-inbound/<primary invoices token>` with header `x-un1t-shim: postmark-inbound-shim`; the upstream status and body returned unchanged.

- [ ] **Step 1: Write the failing contract assertions** in the existing contract test (it reads the shim off disk):

```js
it('declares an invoices target with its own bucket, path and secrets', () => {
  expect(shim).toMatch(/bucket:\s*'inbound-invoices'/)
  expect(shim).toMatch(/forwardPath:\s*'\/api\/webhooks\/invoices-inbound'/)
  expect(shim).toMatch(/tokenEnv:\s*'POSTMARK_INBOUND_WEBHOOK_TOKEN'/)
  expect(shim).toMatch(/previousEnv:\s*'POSTMARK_INBOUND_WEBHOOK_TOKEN_PREVIOUS'/)
})
it('keeps the support target exactly as it was', () => {
  expect(shim).toMatch(/bucket:\s*'email-attachments'/)
  expect(shim).toMatch(/forwardPath:\s*'\/api\/webhooks\/postmark-inbound'/)
  expect(shim).toMatch(/tokenEnv:\s*'POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN'/)
})
it('never builds the forward from the caller-supplied token', () => {
  expect(shim).not.toMatch(/\$\{urlToken\}/)
})
```

(Use the variable name the test already uses for the shim's text.)

- [ ] **Step 2: Run** `npx vitest run src/lib/email-attachment-staging.contract.test.js`. Expected: the new cases FAIL; every existing case passes.
- [ ] **Step 3: Implement.** Replace the three single-target constants (`EMAIL_ATTACHMENT_BUCKET`, `FORWARD_PATH`, the two `Deno.env.get` token reads) with a frozen list:

```ts
const TARGETS = [
  { name: 'support', tokenEnv: 'POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN', previousEnv: 'POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN_PREVIOUS', bucket: 'email-attachments', forwardPath: '/api/webhooks/postmark-inbound' },
  { name: 'invoices', tokenEnv: 'POSTMARK_INBOUND_WEBHOOK_TOKEN', previousEnv: 'POSTMARK_INBOUND_WEBHOOK_TOKEN_PREVIOUS', bucket: 'inbound-invoices', forwardPath: '/api/webhooks/invoices-inbound' },
] as const
```

  Rules the tests do not fix:
  - The support target is required (missing → `missing_secret` 500, as today). The invoices target is optional: if its `tokenEnv` is unset it is simply not matchable, and the support inbox keeps working.
  - Compare the URL token against every configured secret with `safeEqual` without stopping at the first match, then pick the match (constant work per request).
  - If the contract test pins `EMAIL_ATTACHMENT_BUCKET` or `FORWARD_PATH` by name, keep those two `const`s and build the support target from them rather than editing the existing assertions.
  - `uploadObject` takes the bucket as a parameter. Log lines gain the target name only for the invoices target; support log lines are unchanged.
  - Update the header comment: one function, two targets, why (the invoices webhook had the same 413 ceiling).
- [ ] **Step 4: Run the contract test and** `npx vitest run src/lib/email-attachment-staging.test.js`. Expected: PASS.
- [ ] **Step 5: Type-check the function** if Deno is available (`deno check supabase/functions/postmark-inbound-shim/index.ts`); if it is not installed, say so in the report. Do not deploy.
- [ ] **Step 6: Commit** `INVOICEPREP.2 — shim: second target for the invoices webhook`.

### Task 2: Read a staged attachment's bytes

**Files:**
- Create: `src/lib/invoices-queue/staged-attachments.js` (`// @ts-check`)
- Test: `src/lib/invoices-queue/staged-attachments.test.js`

**Interfaces:**
- Consumes: `readStagedMarker(attachment, { postmarkMessageId, index })` from `@/lib/email-attachment-staging` (returns `{ kind: 'inline' } | { kind: 'staged', path, sizeBytes } | { kind: 'skip', reason }`).
- Produces:
  - `INVOICE_STAGING_BUCKET = 'inbound-invoices'`
  - `resolveInboundAttachments(db, body) → Promise<{ ok: true, attachments: Array<object>, failed: Array<{ name: string, reason: string }>, stagedPaths: string[] } | { ok: false, error: 'staged_download_failed' }>`
    - an inline attachment is returned untouched;
    - a staged one is returned as a copy with `bytes` (a Buffer downloaded from the bucket) and `Content` left empty;
    - a `skip` marker adds `{ name, reason }` to `failed` and the attachment is left out;
    - a download that errors returns `{ ok: false }` (the caller answers 5xx and the provider retries; the staged file is still there);
    - a download whose size differs from `sizeBytes` is treated as `failed` with reason `rehost_failed`.
  - `removeStagedAttachments(db, stagedPaths) → Promise<void>` — best effort, never throws, logs with `logWarn`.

- [ ] **Step 1: Write the failing tests** (fake storage: `db.storage = { from: (b) => ({ download, remove }) }`, asserting `b === 'inbound-invoices'`):

```js
it('returns inline attachments untouched and downloads nothing', async () => { /* download not called */ })
it('downloads a staged attachment and attaches its bytes', async () => {
  const r = await resolveInboundAttachments(db, email([staged(0, 'inbound/m1/0.pdf', 9)]))
  expect(r.ok).toBe(true)
  expect(Buffer.isBuffer(r.attachments[0].bytes)).toBe(true)
  expect(r.stagedPaths).toEqual(['inbound/m1/0.pdf'])
})
it('refuses a path that does not belong to this message', async () => {
  const r = await resolveInboundAttachments(db, email([staged(0, 'inbound/other/0.pdf', 9)]))
  expect(download).not.toHaveBeenCalled()
  expect(r.failed).toEqual([{ name: 'a.pdf', reason: 'rehost_failed' }])
})
it('reports an attachment the shim could not move', async () => {
  const r = await resolveInboundAttachments(db, email([{ Name: 'big.pdf', Content: '', _un1t_staged: { v: 1, error: 'too_large' } }]))
  expect(r.failed).toEqual([{ name: 'big.pdf', reason: expect.any(String) }])
  expect(r.attachments).toEqual([])
})
it('fails the whole call when a download errors', async () => {
  download.mockResolvedValueOnce({ data: null, error: { message: 'x' } })
  expect(await resolveInboundAttachments(db, email([staged(0, 'inbound/m1/0.pdf', 9)]))).toEqual({ ok: false, error: 'staged_download_failed' })
})
it('treats a size mismatch as not received', async () => { /* marker bytes 9, download 4 bytes → failed rehost_failed */ })
it('removeStagedAttachments never throws', async () => { /* remove rejects → resolves undefined */ })
```

- [ ] **Step 2: Run** `npx vitest run src/lib/invoices-queue/staged-attachments.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** Check what reason string `readStagedMarker` returns for `too_large` (`STAGED_ERROR_REASONS`) and pass it through. Type `db` as `import('@/lib/supabase').Db`.
- [ ] **Step 4: Run the tests and** `npm run check:types`. Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.2 — read staged invoice attachments from Storage`.

### Task 3: The ingest accepts staged attachments

**Files:**
- Modify: `src/lib/inbound-invoices.js` (`classifyInboundAttachments`), `src/lib/invoices-queue/ingest-email.js`
- Test: `src/lib/inbound-invoices.test.js`, `src/lib/invoices-queue/ingest-email.test.js`, `src/app/api/webhooks/invoices-inbound/[token]/route.integration.test.js`

**Interfaces:**
- Consumes: Task 2's `resolveInboundAttachments`, `removeStagedAttachments`.
- Produces:
  - `classifyInboundAttachments` uses `att.bytes` when it is a Buffer, else decodes `att.Content` as today. Nothing else about its result changes.
  - `ingestInboundEmail` return type gains `error: 'staged_download_failed'`. On success with staged files it removes them after every row is stored.
  - For each entry in `failed`, one extra `invoices_queue` row: no attachment path, `attachment_filename` the file's name, `not_invoice_reason` `` `attachment_not_received: ${reason}` ``, `email_message_id` `` `${MessageID}-missing-${n}` `` (n counts from 0), status `received`. Idempotent like the others: an existing row with that id is not created again.
  - An email whose only attachments all failed gets those rows and no separate "no_attachment" row.

- [ ] **Step 1: Write the failing tests.**
  - Helpers: a Buffer in `att.bytes` with empty `Content` is classified as usable with the right `mime` and `index`.
  - Ingest: a staged PDF is stored with its hash and path, and `remove` is called with its staged path; a second call stores nothing and does not fail when the staged file is already gone (the row exists with a path, so no download is attempted for it); a `too_large` attachment beside a good PDF gives two rows, one with `not_invoice_reason: 'attachment_not_received: …'`; a download error returns `{ ok: false, error: 'staged_download_failed' }` and writes nothing; an inline (non-staged) email still stores as before.
  - Integration (real route, real ingest): a staged payload → 200, one row with a path and hash, staged file removed.
- [ ] **Step 2: Run the three test files.** Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** In `ingestInboundEmail`: do the existing pre-read of stored rows FIRST, then resolve only the attachments that are not already stored (so a retry never needs a staged file that a successful earlier attempt removed), then classify, then the existing insert, upload and path-update sequence unchanged. Remove staged files only after the loop completes with `ok: true`. Update the two file headers.
- [ ] **Step 4: Run the three test files plus** `npm run check:types && npm run check:select-columns`. Expected: PASS.
- [ ] **Step 5: Commit** `INVOICEPREP.2 — ingest reads staged attachments, records ones not received`.

### Task 4: Show it, document it, open the PR

**Files:**
- Modify: `src/components/InvoicesInbox.jsx` (the reason line added in INVOICEPREP.1), `docs/architecture/INTEGRATIONS.md`, `docs/rules/crons-webhooks.md`, the design spec (move the "Not yet covered" paragraph into a "Phase 1b" entry)
- Create: `docs/changelog/entries/<PR>.md`

- [ ] **Step 1: Reason line.** `attachment_not_received: too_large` renders "An attachment was too large to receive (over 25 MB)"; any other `attachment_not_received:` value renders "An attachment could not be received". Follow how `no_attachment` is rendered there.
- [ ] **Step 2: Docs.** In `INTEGRATIONS.md`, next to `POSTMARK_INBOUND_WEBHOOK_TOKEN`: Postmark must point at the shim URL `https://iyvtbjjxdggiadzwwvdj.supabase.co/functions/v1/postmark-inbound-shim/<token>`, the same token value must be set as an Edge Function secret, pointing Postmark at the Vercel URL reinstates the ~3.3 MB ceiling, and the same bogus-token probe applies (404 healthy, 500 `missing_secret`). In `crons-webhooks.md`, extend the INVOICEPREP line: large mail arrives staged.
- [ ] **Step 3: Run the CI mirror once, then** `npm run build`. Expected: all pass.
- [ ] **Step 4: Check no PR exists for the branch, push, open the PR.** The body states plainly that merging changes nothing by itself: the fix is live only after Task 5.
- [ ] **Step 5: Add the changelog entry, commit, push.**

### Task 5: Cutover (with Richard, after the PR is merged and deployed)

Not automated. Each step is confirmed before the next.

- [ ] **Step 0: Preconditions.** This PR is merged and deployed on Vercel. The new CRM with the old function is safe: nothing sends markers yet.
- [ ] **Step 1: Prepare the rollback first.** Save the function as it is deployed today (`git show 3fe67a2a0:supabase/functions/postmark-inbound-shim/index.ts`) to a scratch directory laid out as `supabase/functions/postmark-inbound-shim/index.ts`, and have the deploy command ready. Rollback is one deploy, about 30 seconds. While the function answers non-2xx, Postmark retries, so a short bad window delays support mail but does not lose it.
- [ ] **Step 2: Canary.** Deploy the NEW `index.ts` under a second name, `postmark-inbound-shim-next`, with JWT verification off. POST a bogus token: expect 404. That proves it boots and loads in the real runtime. Delete the canary.
- [ ] **Step 3: Check the bucket.** Confirm the `inbound-invoices` bucket has no `allowed_mime_types` restriction (it had none on 22 Nov 2026).
- [ ] **Step 4: Richard sets the Edge Function secret** `POSTMARK_INBOUND_WEBHOOK_TOKEN` to the same value Vercel has. The value is never pasted into chat. He confirms it is NOT the same value as `POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN`. Setting it is harmless to the old function.
- [ ] **Step 5: Deploy the real function**, with Richard's go-ahead at that moment, because this function carries all support mail. JWT verification must be explicitly off: `supabase functions deploy postmark-inbound-shim --no-verify-jwt --project-ref iyvtbjjxdggiadzwwvdj`, or the MCP tool with `verify_jwt: false`.
- [ ] **Step 6: Probe at once.** A bogus token answers 404 when healthy. 401 means JWT verification is on: redeploy. 500 `missing_secret` means the support secret is lost. 503 or a boot error: roll back. Then Richard, from his own shell, POSTs the body `x` with the real invoices token and expects `400 invalid_json`; then the body `{}`, and expects a 400 relayed from Vercel about a missing MessageID. That proves the forward works and that both sides hold the same token. The function logs show no `two webhook targets share` line.
- [ ] **Step 7: Check support mail.** Send one ordinary support email with an attachment; see it filed and the file open. The log shows `[postmark-shim] 1 attachment(s) staged`.
- [ ] **Step 8: Richard repoints the invoices server's inbound webhook in Postmark** to `https://iyvtbjjxdggiadzwwvdj.supabase.co/functions/v1/postmark-inbound-shim/<token>`.
- [ ] **Step 9: Live tests.** Send one small invoice, one over 5 MB and one near 20 MB. Each row opens. The log shows `[postmark-shim:invoices] … staged`. Afterwards `inbound/` in the bucket is empty.
- [ ] **Revert, if invoices misbehave:** paste the Vercel URL back into Postmark. Small invoices work at once; the size ceiling returns.
- [ ] **Revert, if support mail misbehaves:** redeploy the saved old function (Step 1).

---

## Not in this plan

A sweep for staged files left behind when a delivery never completes (they sit under `inbound/` in `inbound-invoices`). Volume is tiny; add it with phase 2 if any accumulate.

The staged files of stray emails (no studio matched) are kept, and nothing sweeps them yet.

A test that runs the shim itself: transpile `index.ts`, stub `Deno` and `fetch`.
