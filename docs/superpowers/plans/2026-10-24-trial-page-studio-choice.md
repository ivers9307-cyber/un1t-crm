# /trial Studio Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/trial` lets the buyer choose Hatch Street or Stillorgan Village; Stillorgan refuses anyone with a trial history before taking money and files an "I need help" card; Hatch Street sends the buyer to un1t.online's own checkout and settles the purchase off the mirror; `/start` redirects to `/trial`.

**Architecture:** The existing `trial_purchases` row stays the one record per attempt and gains three statuses (`help_requested`, `handled`, `expired`) and a second provider (`un1t_online`). The public POST branches on the chosen studio: Stillorgan keeps the Revolut + Glofox path behind a new pure eligibility check; Hatch runs the un1t.online account + hosted-checkout primitives synchronously and is settled later by the existing 2-minute cron reading `un1t_transactions`. The Approvals "Paid trials" tab learns a second card kind.

**Tech Stack:** Next.js 16 App Router, Supabase (service role in routes), vitest (mocked supabase builders; PGlite for migrations), existing un1t.online writer (`src/lib/un1t-online-write-ops.js`, `src/lib/un1t-online-account.js`), Revolut payments helper, Postmark, Meta CAPI.

**Spec:** `docs/superpowers/specs/2026-10-24-trial-page-studio-choice-design.md`

## Global Constraints

- Every `/api` route runs on the service role: scope every `trial_purchases` read by `location_id`; the public routes never trust a contact id from the browser.
- No new `console.log`; log through `logWarn`/`logError` from `@/lib/log` with ids only (never a name, email, phone, URL or token).
- Every supabase write destructures `error` and judges it (`check:guardrails` `no-unchecked-supabase-write` is armed per path; the new files go on its list in `eslint.guardrails.config.mjs`).
- Customer-facing copy is read from the studio's `paid_trial` block with a default in `PAID_TRIAL_DEFAULT`; no literal reaches the page except as a default.
- Never `POST /purchases/charge` or `POST /credits/grant` for this product; the only un1t.online writes are `ensureUn1tAccount` and `createCheckoutLink` (`tests/un1t-online-write-guard.test.js` and `tests/mia-no-charge-no-refund-guard.test.js` must stay green).
- Studio keys on the wire are exactly `stillorgan` and `hatch`; they map to landing `public_path` `stillorgan` and `hatch-street`, and to the two locations by those rows' `location_id`.
- The ledger origin for every un1t.online write made by this page is `web_trial`.
- Expiry of an unpaid Hatch row: 24 h + 45 min after `created_at` (`EXPIRY_GRACE_MS` reasoning from `purchase-settle.js`).
- HTML interpolations of buyer-typed values in staff or buyer emails go through `escapeHtml`.
- Migrations are forward-only, applied with the Supabase MCP `apply_migration` against `iyvtbjjxdggiadzwwvdj` BEFORE the code deploys; run `get_advisors` (security) after.
- Run the CI mirror (CLAUDE.md "Build, test & ship") before pushing; `npm run build` too, since routes and a page change.

## Review Focus

1. A Stillorgan buyer whose email matches a contact at HATCH only (a sibling-studio contact) must be eligible at Stillorgan: the history query filters on the Stillorgan `location_id` (Task 3 test "sibling-studio history does not count").
2. A `glofox_trial_claims` read that fails must answer 503, never "you've had a trial" and never a checkout (Task 3 test "a failed read is ok:false", Task 6 test "503 on an unreadable history").
3. A Hatch buyer who abandons un1t.online's checkout and comes back to `/trial?purchase=<id>&studio=hatch&cancelled=1` must see the form again with no error about money (Task 10 test "cancelled return shows the form").
4. The un1t sweeper must not settle a Hatch row off a transaction older than the row (a purchase of a class pack last week): `remote_created_at >= created_at` (Task 7 test "an older transaction does not settle").
5. Pressing "I need help" twice must not file two cards: the help route reuses an open `help_requested` row for the same contact and studio (Task 5 test "a second press reuses the open row").

---

### Task 1: Migration 764

**Files:**
- Create: `supabase/migrations/764_trial_purchases_studio_choice.sql`
- Test: `tests/migration-764-trial-purchases-studio-choice.test.js`

**Interfaces:**
- Produces: `trial_purchases` columns `un1t_product_id text`, `un1t_user_id text`, `un1t_ledger_id uuid`, `terms_accepted_at timestamptz`, `terms_source text`, `terms_version text`; `membership_id` and `plan_code` nullable; status CHECK `awaiting_payment | queued | processing | granted | needs_review | failed | payment_failed | help_requested | handled | expired`; partial index `idx_trial_purchases_un1t_open on (created_at) where payment_provider = 'un1t_online' and status = 'awaiting_payment'`; `un1t_write_events_origin_check` widened to include `'web_trial'`.

- [ ] **Step 1: Write the failing test** (PGlite, template `tests/migration-760-un1t-trial-regrant.test.js`: replay mig 744 and 762 on reduced tables, then the real 764 file)

```js
it('a trial_purchases row with no Glofox plan but a un1t product is accepted', async () => {
  await db.query(`INSERT INTO public.trial_purchases (location_id, customer_email, product_name, amount_cents, payment_provider, un1t_product_id, status)
    VALUES ('${LOC}', 'a@example.com', 'The UN1T Trial', 3900, 'un1t_online', 'p-1', 'awaiting_payment')`)
})
it('help_requested, handled and expired are statuses; a made-up one is refused', async () => {
  for (const s of ['help_requested', 'handled', 'expired']) await expect(insertStatus(s)).resolves.toBeTruthy()
  await expect(insertStatus('bogus')).rejects.toMatchObject({ code: '23514' })
})
it("un1t_write_events accepts origin 'web_trial' and still refuses 'cron'", async () => {
  await expect(ledgerRow({ origin: 'web_trial' })).resolves.toBeTruthy()
  await expect(ledgerRow({ origin: 'cron' })).rejects.toMatchObject({ code: '23514' })
})
it('anon and authenticated hold nothing on trial_purchases after 764', async () => { /* same privilege probe as the 762 test */ })
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/migration-764-trial-purchases-studio-choice.test.js`
Expected: FAIL (file 764 not found)

- [ ] **Step 3: Write the migration**

`ALTER TABLE public.trial_purchases ALTER COLUMN membership_id DROP NOT NULL, ALTER COLUMN plan_code DROP NOT NULL, ADD COLUMN un1t_product_id text, ADD COLUMN un1t_user_id text, ADD COLUMN un1t_ledger_id uuid, ADD COLUMN terms_accepted_at timestamptz, ADD COLUMN terms_source text, ADD COLUMN terms_version text;` a CHECK `trial_purchases_status_check` on the status list above (mig 762 has none; add it), the partial index, `ALTER TABLE public.un1t_write_events DROP CONSTRAINT un1t_write_events_origin_check, ADD CONSTRAINT un1t_write_events_origin_check CHECK (origin IN ('staff','funnel','approval','mia','test_account','web_trial'))`, and `COMMENT ON` each new column. Repeat `revoke all on public.trial_purchases from anon, authenticated, public;` at the end (the 762 pattern).

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/migration-764-trial-purchases-studio-choice.test.js tests/migration-744-un1t-write-back.test.js tests/migration-760-un1t-trial-regrant.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/764_trial_purchases_studio_choice.sql tests/migration-764-trial-purchases-studio-choice.test.js
git commit -m "TRIALSTUDIO.1 — mig 764: trial_purchases un1t.online columns, help/handled/expired statuses, web_trial origin"
```

### Task 2: Block config and studio resolution

**Files:**
- Modify: `src/lib/landing-page-blocks.js:226-246` (`PAID_TRIAL_DEFAULT`)
- Modify: `src/lib/paid-trial.js`
- Create: `src/lib/trial-studios.js`
- Test: `src/lib/paid-trial.test.js` (exists; extend), `src/lib/trial-studios.test.js`

**Interfaces:**
- Produces: `PAID_TRIAL_DEFAULT` gains `studio_label: ''`, `un1t_product_id: ''`, `trial_used_text`, `active_member_text`, `help_cta_label: 'I need help'`, `help_sent_text`, each with the spec's default copy (section 2, 3, 4).
- Produces: `paidTrialConfigFromBlocks(blocks, landingPath, { product = null } = {})` → the existing shape plus `provider: 'glofox' | 'un1t_online'`, `un1tProductId: string|null`, `studioLabel`, `trialUsedText`, `activeMemberText`, `helpCtaLabel`, `helpSentText`. Glofox shape unchanged. un1t shape: sellable when `block.un1t_product_id` is set and `product` is `{ un1t_id, status: 'active', price_cents > 0, currency }` for that id; `priceCents`/`currency` come from `product`; `membershipId`/`planCode` are null.
- Produces: `trialPurchasePublicState(row)` additionally returns `'expired'` for status `expired` and `'help'` for `help_requested`/`handled`; a `un1t_online` row that is `awaiting_payment` is `'pending'`.
- Produces: `TRIAL_STUDIOS = Object.freeze([{ key: 'stillorgan', publicPath: 'stillorgan' }, { key: 'hatch', publicPath: 'hatch-street' }])`, `studioByKey(key)` → entry or null, and `async loadTrialStudios(db)` → `Array<{ key, publicPath, locationId: string|null, membershipSource: string|null, block: object|null, product: object|null, sellable: boolean, config: object|null }>` (one `landing_page_settings` read with `locations:location_id ( membership_source )`, and for a un1t block one `un1t_products` read by `location_id` + `un1t_id`; a read error marks that studio `sellable: false` with `config: null` and logs a warning).

- [ ] **Step 1: Write the failing tests**

```js
// paid-trial.test.js
it('a un1t block is sellable only with a mirrored active product above €0', () => {
  const blocks = [{ type: 'paid_trial', un1t_product_id: 'p-1', product_name: 'The UN1T Trial', duration_days: 14 }]
  expect(paidTrialConfigFromBlocks(blocks, 'hatch-street')).toBeNull()
  const cfg = paidTrialConfigFromBlocks(blocks, 'hatch-street', { product: { un1t_id: 'p-1', status: 'active', price_cents: 3900, currency: 'eur' } })
  expect(cfg).toMatchObject({ provider: 'un1t_online', un1tProductId: 'p-1', priceCents: 3900, currency: 'EUR', membershipId: null, planCode: null })
  expect(paidTrialConfigFromBlocks(blocks, 'hatch-street', { product: { un1t_id: 'p-1', status: 'active', price_cents: 0 } })).toBeNull()
})
it('a Glofox block ignores the product argument and keeps its typed price', () => { /* SELLABLE fixture from route.test.js → provider glofox, priceCents 3900 */ })
it('public state: expired and help rows', () => {
  expect(trialPurchasePublicState({ status: 'expired' })).toBe('expired')
  expect(trialPurchasePublicState({ status: 'help_requested' })).toBe('help')
  expect(trialPurchasePublicState({ status: 'awaiting_payment', payment_provider: 'un1t_online' })).toBe('pending')
})
// trial-studios.test.js
it('loads both studios; a missing Hatch block is not sellable; a product read error is not sellable', async () => { /* mocked db */ })
it('studioByKey maps hatch to hatch-street and refuses anything else', () => {
  expect(studioByKey('hatch').publicPath).toBe('hatch-street')
  expect(studioByKey('HATCH')).toBeNull()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/paid-trial.test.js src/lib/trial-studios.test.js`
Expected: FAIL (`provider` undefined; module not found)

- [ ] **Step 3: Implement** the defaults, the two-shape config, the public states and `src/lib/trial-studios.js` as in Interfaces.

- [ ] **Step 4: Run to see them pass**, then `npx vitest run src/lib/landing-page-blocks.test.js src/app/api/public/trial-purchases/route.test.js` (the existing route test must stay green: the Glofox shape is unchanged).

- [ ] **Step 5: Commit** `TRIALSTUDIO.2 — paid_trial block: studio label, un1t.online product shape, help copy; trial-studios loader`

### Task 3: Eligibility reads

**Files:**
- Create: `src/lib/trial-eligibility.js`
- Test: `src/lib/trial-eligibility.test.js`

**Interfaces:**
- Produces: `async stillorganTrialHistory(db, { locationId, contact })` → `{ ok: true, hadTrial: boolean, reasons: string[] } | { ok: false, reason: string }`. `contact` is `{ id, glofox_member_id, glofox_membership_status, glofox_membership_plan }`. Reasons (exact strings): `glofox_trial_claim`, `membership_status=<value>`, `membership_plan_trial`, `glofox_push_created`, `paid_trial_granted`. Reads, each scoped by `locationId`: `glofox_trial_claims` (`glofox_member_id`, `released_at is null`), `glofox_push_events` (`contact_id`, `status = 'created'`), `trial_purchases` (`contact_id`, `status = 'granted'`). Status match set: `trial`, `no_sale_trial`. Plan match: `/trial/i`. The two contact-column signals need no read. Any read error → `{ ok: false }`.
- Produces: `async hatchActiveMembership(db, { locationId, contactId })` → `{ ok: true, active: boolean, reasons: string[] } | { ok: false, reason }`. Reads `un1t_subscriptions` (`contact_id`, `status in MEMBERSHIP_ACTIVE_STATUSES` from `@/lib/un1t-online-map`) and `contact_memberships` (`contact_id`, `status = 'active'`, `ended_at is null`), both by `location_id`. Reasons: `un1t_subscription=<status>`, `contact_membership_active`.
- Produces: `reasonsText(reasons)` → `'trial_used: a, b'` / `'active_member: a'` for `last_error`.

- [ ] **Step 1: Write the failing tests** (a `makeDb` whose `from(table)` returns a chainable builder answering per table, as `trial-purchase-processor.test.js` does)

```js
it('a contact with no signals and empty reads is eligible', ...)              // hadTrial false, reasons []
it.each([['trial'], ['no_sale_trial']])('membership status %s is a trial', ...)
it('a plan named "The UN1T Trial" counts; "Monthly Unlimited" does not', ...)
it('a live glofox_trial_claims row counts', ...)
it('a released claim does not count', ...)
it('a glofox_push_events created row counts; needs_review does not', ...)
it('a granted paid trial counts', ...)
it('sibling-studio history does not count (every read filters on the Stillorgan location id)', ...) // assert .eq('location_id', LOC) was called on each table
it('a failed read is ok:false, never hadTrial', ...)
it('hatch: an active subscription or an active contact_membership refuses; a cancelled one does not; a failed read is ok:false', ...)
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run src/lib/trial-eligibility.test.js` → module not found.
- [ ] **Step 3: Implement** the two reads and `reasonsText`.
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: Commit** `TRIALSTUDIO.3 — trial eligibility reads: Stillorgan trial history, Hatch active membership`

### Task 4: Escaped staff alert, exported; escaped buyer email

**Files:**
- Modify: `src/lib/trial-purchase-processor.js` (`alertStaff`, `REVIEW_REASONS`)
- Modify: `src/lib/trial-purchase-emails.js` (`defaultTrialCopy`, token insertion)
- Test: `src/lib/trial-purchase-processor.test.js`, `src/lib/trial-purchase-emails.test.js` (create if absent)

**Interfaces:**
- Produces: `export function escapeHtml(s): string` in `src/lib/html-escape.js` (new, the `notify.js:214` body; the two files import it; `notify.js` is left alone).
- Produces: `export async function alertTrialPurchaseStaff(db, row, reason, extra = '')` (the former `alertStaff`, now exported; every interpolated field escaped; subject for `help_requested` rows: `Trial help request: <name> (<studio>)`, for everything else unchanged).
- Produces: `REVIEW_REASONS` gains `trial_used: 'The buyer already had a trial here and asked for help.'`, `active_member: 'The buyer already holds an active membership and asked for help.'`, `un1t_account_refused: 'un1t.online would not give this buyer an account.'`, `un1t_checkout_refused: 'un1t.online refused the checkout.'`, `un1t_outcome_unknown: 'un1t.online gave no clear answer.'`.

- [ ] **Step 1: Write the failing tests**

```js
it('the staff alert escapes the buyer name', async () => {
  const db = makeDb(); mocks.purchase.mockResolvedValue({ ok: false, error: 'NO' })
  await processTrialPurchase(db, { ...ROW, customer_name: '<img src=x onerror=alert(1)>' })
  const html = mocks.ops.mock.calls[0][0].htmlBody
  expect(html).not.toContain('<img'); expect(html).toContain('&lt;img')
})
it('defaultTrialCopy escapes tokens', () => {
  expect(defaultTrialCopy('granted', { first_name: '<b>Ava</b>', product_name: 'T', amount: '€39', duration_days: 14, studio: 'S', short_name: '' }).htmlBody).toContain('&lt;b&gt;Ava')
})
```

- [ ] **Step 2: Run to see them fail.** — `npx vitest run src/lib/trial-purchase-processor.test.js src/lib/trial-purchase-emails.test.js`
- [ ] **Step 3: Implement** `html-escape.js`, rename/export the alert, escape in both files (the `applyTokens` path: escape each token value before `applyTokens`, since the operator template is trusted HTML and the tokens are not).
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: Commit** `TRIALSTUDIO.4 — escape buyer-typed values in the paid-trial staff alert and buyer email; export the alert`

### Task 5: The help route

**Files:**
- Create: `src/app/api/public/trial-purchases/help/route.js`, `src/app/api/public/trial-purchases/help/route.test.js`
- Modify: `src/lib/openapi.js` (register beside `/api/public/trial-purchases`)
- (`scripts/check-route-guards.mjs` exempts every `/api/public/` path by design; nothing to add there, the rate limit is the gate.)

**Interfaces:**
- Consumes: Task 2 `studioByKey`, `loadTrialStudios`; Task 3 reads and `reasonsText`; Task 4 `alertTrialPurchaseStaff`.
- Produces: `POST /api/public/trial-purchases/help` body `{ studio: 'stillorgan'|'hatch', first_name, last_name, email, phone }` (same field rules as the purchase POST) → `200 { success: true, data: { message: <help_sent_text>, purchaseId } }`; `400 { code: 'unknown_studio' }`; `429` rate-limited (`trialhelp:<studio>:<ip>`, max 5 per 15 min); `503 { code: 'unavailable' }` on an unreadable landing row.
- Behaviour: match the contact with `findOrCreateRaceContact` (same `insertFields` as the purchase POST but `source: 'paid_trial_help'`); re-run the studio's eligibility read (`stillorganTrialHistory` for Stillorgan, `hatchActiveMembership` for Hatch); if an open `help_requested` row exists for `(location_id, contact_id)`, return it (no second card); else insert `{ location_id, contact_id, landing_path, customer_name, first_name, last_name, customer_email, customer_phone, product_name, amount_cents, currency, duration_days, status: 'help_requested', payment_provider: config.provider, last_error: reasonsText(reasons) }` (`un1t_product_id` or `membership_id`/`plan_code` from the config) and call `alertTrialPurchaseStaff(db, row, <'trial_used'|'active_member'>, reasons.join(', '))` best-effort.

- [ ] **Step 1: Write the failing tests** (mock pattern of `route.test.js` beside it)

```js
it('400s an unknown studio before any read', ...)
it('files one help_requested row with the reasons and alerts staff', ...)   // expect inserted.status 'help_requested', last_error startsWith 'trial_used:'
it('a second press reuses the open row (no insert, no second alert)', ...)
it('503s when the landing row is unreadable', ...)
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run src/app/api/public/trial-purchases/help/route.test.js`
- [ ] **Step 3: Implement** the route and register it in `openapi.js`.
- [ ] **Step 4: Run to see them pass**, then `npm run check:route-guards && npm run check:location-scoping`.
- [ ] **Step 5: Commit** `TRIALSTUDIO.5 — POST /api/public/trial-purchases/help files a Needs-a-call card`

### Task 6: The purchase POST learns the studio

**Files:**
- Modify: `src/app/api/public/trial-purchases/route.js`
- Test: `src/app/api/public/trial-purchases/route.test.js`
- Modify: `src/lib/openapi.js` (schema: `studio`, `terms_accepted`; responses `trial_used`, `active_member`, `terms_required`, `redirect`)

**Interfaces:**
- Consumes: Task 2 `studioByKey`/`loadTrialStudios` (the `path` body field is replaced by a required `studio`: the page and the route deploy together, so no compatibility shim), Task 3 reads, Task 4 alert, `ensureUn1tAccount` and `createCheckoutLink` as the spec's Constraints list them, `un1tTermsPayload`/`readUn1tLegalDocs` as `src/app/api/public/class-booking/route.js:114-121,254-258` use them, `resolveCustomerBaseUrl(db, locationId)` from `@/lib/tenant-host`.
- Produces, Stillorgan: unchanged success shape; new `200 { success: false, code: 'trial_used', error: config.trialUsedText, help: { cta_label: config.helpCtaLabel } }` BEFORE any `trial_purchases` insert (the status is 200 so the browser reads the body as a state, not a failure); `503 { code: 'unavailable' }` when the history read is `ok:false`.
- Produces, Hatch: `400 { code: 'terms_required', error, terms }` when `terms_accepted !== true` (terms payload from `un1tTermsPayload({ blocks: hatchRow.blocks, studioName, publicPath: 'hatch-street' })`); `200 { success: false, code: 'active_member', error: config.activeMemberText, help: {...} }`; on success `200 { success: true, data: { purchaseId, redirect_url, amount_cents, currency, product_name } }` where `redirect_url` is the checkout URL; on `ensureUn1tAccount` `kind 'card'` or a `Un1tWriteRefused`/`Un1tWriteUnknown` from the checkout: row → `help_requested` with `last_error` `un1t_account_refused: <reason>` / `un1t_checkout_refused: <code>` / `un1t_outcome_unknown: <code>`, alert staff, answer `200 { success: false, code: 'help_filed', error: config.helpSentText }`; on `kind 'retry'` or a retryable result: row → `failed` with the code, answer `503 { code: 'unavailable' }`.
- Row insert for Hatch: the Task 1 columns (`payment_provider: 'un1t_online'`, `un1t_product_id`, `terms_*`, `membership_id: null`, `plan_code: null`); after the account step `un1t_user_id` is stamped; after the checkout `un1t_ledger_id`. Idempotency key `trial_purchase:<row id>`; success URL `${base}/trial?purchase=${row.id}&studio=hatch`, cancel URL `...&cancelled=1`; `origin: 'web_trial'`, `originRef: row.id`, `actor: null`.
- The lead-capture block (contact, names, lead source, UTMs, visit, tag, consent, deal) runs for both studios exactly as today, against the chosen studio's `locationId`.

- [ ] **Step 1: Write the failing tests** (extend the mock `from()` for `glofox_trial_claims`, `glofox_push_events`, `un1t_subscriptions`, `contact_memberships`, `un1t_products`; mock `@/lib/un1t-online-account`, `@/lib/un1t-online-write-ops`, `@/lib/un1t-online-legal`, `@/lib/tenant-host`)

```js
it('400s an unknown studio', ...)
it('Stillorgan: a buyer with a trial claim gets trial_used and no row, no checkout', ...)   // mocks.inserted, mocks.payment not called
it('Stillorgan: 503 on an unreadable history', ...)
it('Stillorgan: a clean buyer still gets the Revolut checkout (today's shape)', ...)
it('Hatch: terms_required without the tick, and the payload names the Hatch legal paths', ...)
it('Hatch: an active member gets active_member and no un1t.online call', ...)
it('Hatch: account + checkout → redirect_url, row stamped un1t_user_id and un1t_ledger_id, origin web_trial, success URL on /trial with the row id', ...)
it('Hatch: a refused checkout files help_requested and alerts staff', ...)
it('Hatch: a retry answer marks the row failed and answers 503', ...)
it('Hatch: never calls the Revolut payment helper', ...)
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run src/app/api/public/trial-purchases/route.test.js`
- [ ] **Step 3: Implement** the branch. Keep the Stillorgan path's statements in their current order; insert the history check right after the lead capture and before the `trial_purchases` insert.
- [ ] **Step 4: Run to see them pass**, then `npm run check:select-columns && npm run check:location-scoping && npm run check:guardrails`.
- [ ] **Step 5: Commit** `TRIALSTUDIO.6 — the purchase POST takes a studio: Stillorgan history gate, Hatch un1t.online account + hosted checkout`

### Task 7: Settling and expiring Hatch rows; the status route

**Files:**
- Create: `src/lib/trial-purchase-un1t-settle.js`, `src/lib/trial-purchase-un1t-settle.test.js`
- Modify: `src/app/api/cron/process-trial-purchases/route.js` (call the sweeper after the queue loop; add `un1t_settled`, `un1t_expired` to `stats`)
- Modify: `src/app/api/public/trial-purchases/[id]/route.js` (no provider recheck for `un1t_online`; `state` from Task 2)
- Test: `src/app/api/public/trial-purchases/[id]/route.test.js` (new; mock `@/lib/trial-purchase-payments` and `@/lib/rate-limit` the way the POST route's test does)

**Interfaces:**
- Produces: `async settleUn1tTrialPurchases(db, { now = () => Date.now(), pageSize = 200 } = {})` → `{ settled: number, expired: number, errors: number }`. Reads `trial_purchases` where `payment_provider = 'un1t_online'` and `status = 'awaiting_payment'`, ordered by `created_at`, `range(0, pageSize-1)`. For each row with a `un1t_user_id`: `un1t_transactions` by `location_id`, `un1t_user_id`, `remote_created_at >= created_at`, filtered `amount_cents > 0 && type !== 'sub_renewal'` (the `purchasesSince` rule, copied; prefer a match whose `product_id === row.un1t_product_id`, else any). A match → `update({ status: 'granted', granted_at: tx.remote_created_at, payment_status: 'paid', paid_at: tx.remote_created_at, payment_provider_ref: tx.un1t_id, "grant": { ok: true, method: 'un1t_checkout', transaction: tx.un1t_id, at } }).eq('id').eq('status', 'awaiting_payment')`, then best-effort: `sendWebsiteConversion` Purchase as the processor sends it, and `runSetPasswordStep` with `settings` from `readUn1tWriteSettings(db, locationId).settings`, `origin 'web_trial'`, `request: null`, the contact read by `contact_id` (`id, email, first_name, last_name`). No match and `created_at + 24h + 45min < now` → `update({ status: 'expired' })` under the same guard. Every error is counted and logged, never thrown.
- Produces: `UN1T_TRIAL_EXPIRY_MS = 24 * 60 * 60_000 + 45 * 60_000`.
- Status route: a `un1t_online` row skips the provider recheck (`canRecheck` requires revolut/stripe already; assert it) and returns `checkout: null`.

- [ ] **Step 1: Write the failing tests**

```js
it('settles a row off a matching transaction dated after it, sends Purchase once, runs the set-password step', ...)
it('an older transaction does not settle', ...)
it('a sub_renewal or €0 transaction does not settle', ...)
it('expires a row 24h45m old with no transaction; leaves a 24h old one', ...)
it('a status guard that matches nothing (raced) sends no Purchase', ...)
it('status route: a un1t row answers pending with checkout null and never calls the provider', ...)
```

- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** the sweeper, wire it into the cron (after the queue loop, before the heartbeat; a sweeper error does not stop the heartbeat, mirror `stats.reap_failed` style), update the status route.
- [ ] **Step 4: Run to see them pass**, plus `npx vitest run src/app/api/cron/process-trial-purchases` if a test exists.
- [ ] **Step 5: Commit** `TRIALSTUDIO.7 — the 2-minute cron settles Hatch trial rows off the un1t.online mirror and expires stale ones`

### Task 8: Approvals: the Needs-a-call card

**Files:**
- Modify: `src/lib/approvals/providers/trial-purchases.js`, `src/lib/approvals/providers/trial-purchases.test.js`
- Modify: `src/app/api/trial-purchases/[id]/review/route.js`, its test
- Modify: `src/components/TrialPurchaseReviewCard.jsx`

**Interfaces:**
- Provider: `fetchPending` and `countPending` select `status in ('needs_review','help_requested')` and drop the `payment_status = 'paid'` filter (a `needs_review` row is always paid; a help row never is). `toItem` adds `kind: 'help' | 'grant'`, `reasons: string[]` (from `splitReviewError(last_error).detail.split(', ')`), `why` for a help row = `REVIEW_REASONS[reason]`.
- Review route: `action` enum gains `'handled'`; `REVIEWABLE` is `needs_review`/`failed` for `retry`/`resolve` and `help_requested` for `handled`; `handled` updates `{ status: 'handled', last_error: null }` under `.eq('status', 'help_requested')`, no email. The `not_paid` 409 applies only to `retry`/`resolve`.
- Card: when `item.kind === 'help'` the chip reads "Needs a call", the line reads `item.why` plus the reasons, the date line reads `Asked <submittedAt>` (use `created_at`, exposed as `submittedAt` for help rows), and the only button is "Mark handled" → `act('handled')` with outcome text "Marked handled."

- [ ] **Step 1: Write the failing tests**

```js
// provider
it('lists help_requested rows as kind help with their reasons, and still lists needs_review as grant', ...)
it('counts both kinds', ...)
// review route
it("handled closes a help_requested row and sends no email", ...)
it("handled on a needs_review row is 409 in_progress; retry on a help row is 409", ...)
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run src/lib/approvals/providers/trial-purchases.test.js 'src/app/api/trial-purchases/[id]/review/route.test.js'`
- [ ] **Step 3: Implement** provider, route, card.
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: Commit** `TRIALSTUDIO.8 — Paid trials tab: Needs-a-call cards with Mark handled`

### Task 9: The settings editor

**Files:**
- Modify: `src/components/LandingPageSettingsForm.jsx:1080-1180` (`PaidTrialEdit`)
- Modify: `src/lib/landing-page-blocks.js` `BLOCK_TYPES` description for `paid_trial`

**Interfaces:**
- `PaidTrialEdit` receives `membershipSource` (the form already knows the location; pass `location.membership_source` the way `locationId` is passed). Fields added for both: "Studio label on /trial" (`studio_label`), "Already had a trial — message" (`trial_used_text`), "Already a member — message" (`active_member_text`), "Help button label" (`help_cta_label`), "Help sent — message" (`help_sent_text`). When `membershipSource === 'un1t_online'`: hide the Price field and the Glofox plan picker; show "un1t.online product" as a `<select>` of the studio's mirrored products from `GET /api/locations/[id]/un1t-online` (it reads `un1t_products`; use its product list field, option label `<title> · €<price>`, value `un1t_id`, writing `un1t_product_id`), with the text-input fallback while loading, as the Glofox plan picker does.

- [ ] **Step 1: Make the change** (no component test exists for this form; `LandingPageSettingsForm` has none).
- [ ] **Step 2: Verify** `npm run lint && npm run check:guardrails` and a manual look at `/settings/landing-page` for both studios on `npm run dev`.
- [ ] **Step 3: Commit** `TRIALSTUDIO.9 — paid_trial block editor: studio label, help copy, un1t.online product`

### Task 10: The page and the card

**Files:**
- Modify: `src/app/trial/page.js`
- Modify: `src/components/landing-page/PaidTrialFunnel.jsx`
- Test: `src/components/landing-page/PaidTrialFunnel.test.jsx` (new; RTL as `src/components/ClassFunnel.test.jsx` uses it)
- Modify: `src/lib/meta-pixel-paths.js` — no change (spec §6); note it in the PR.

**Interfaces:**
- Page: reads `?studio` (`stillorgan`|`hatch`, else none), `?purchase`, `?cancelled`; loads both studios with `loadTrialStudios(db)`; title/description/logo from `resolveOrgChrome({ orgId: UN1T_GROUP_ORG_ID })` (`chrome.companyName`, `chrome.logoUrl` if it has one, else the current `getLandingLogo('stillorgan', …)` call); the content blocks stay as today (Stillorgan's own, else Hatch's). Passes `studios` (the loader's array minus `block`'s unused fields; never `locationId`), `initialStudio`, `resumePurchaseId`, `cancelled` to the card. For Hatch the page also passes `terms` = `un1tTermsPayload({ blocks: hatchBlocks, studioName, publicPath: 'hatch-street' })`.
- Card props: `PaidTrialFunnel({ studios, initialStudio = null, resumePurchaseId = null, cancelled = false, hatchTerms = null })`. States: `choose` (no studio yet) → `form` → `payment` (Stillorgan, as today) | redirect (Hatch: `window.location.assign(data.redirect_url)`) → `confirming`/`done` (both; `?studio=hatch` return starts in `confirming` and the done copy for a `pending` Hatch row after 2 minutes of polling says the purchase is being confirmed and un1t.online will email the receipt) | `refused` (`trial_used`/`active_member`: the message, the help button) → `help_sent` (the thanks message). `cancelled` → `form` with the studio preselected and no error. The studio picker is two `type="button"` tiles (label = `studio_label || default`, price, duration) with a "Change studio" link on the form; an unsellable studio renders its tile disabled with "Not available online". Browser Lead/InitiateCheckout fire for both studios as today; the Purchase fires on `granted` (both) or `paid` (Stillorgan), as today.
- Help button → `POST /api/public/trial-purchases/help` with the form's fields and `studio`.

- [ ] **Step 1: Write the failing tests**

```js
it('shows the two studios and the form only after one is chosen', ...)
it('Stillorgan trial_used answer shows the message and the help button; pressing it posts to /help and shows help_sent_text', ...)
it('Hatch success redirects the browser to redirect_url', ...)   // stub window.location.assign
it('Hatch posts terms_accepted and shows the terms tick', ...)
it('cancelled return shows the form with Hatch preselected and no error', ...)
it('an unsellable studio tile is disabled', ...)
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run src/components/landing-page/PaidTrialFunnel.test.jsx`
- [ ] **Step 3: Implement** the page and the card.
- [ ] **Step 4: Run to see them pass**, then `npx vitest run src/public-compliance-paths.test.jsx tests/un1t-literal-sweep.test.js` and `npm run build`.
- [ ] **Step 5: Commit** `TRIALSTUDIO.10 — /trial: choose your studio, refusal and help states, Hatch checkout redirect`

### Task 11: `/start` redirects to `/trial`

**Files:**
- Modify: `src/app/start/page.js`, `src/app/start/[path]/page.js` (add the redirect at the top of the default export; leave metadata, constants and the rest of each file untouched so `tests/un1t-literal-sweep.test.js`'s pinned literals still hold)
- Test: `src/app/start/start-redirect.test.js` (new)

**Interfaces:**
- `src/app/start/page.js` default export: `redirect(trialRedirectFor('stillorgan', searchParams))` before any load.
- `src/app/start/[path]/page.js`: `redirect(trialRedirectFor(resolveLandingPath(params.path), searchParams))`.
- New pure helper in `src/lib/trial-studios.js`: `trialRedirectFor(publicPath, searchParams)` → `/trial?studio=<key>&<original query>` where `hatch-street` → `hatch`, `stillorgan` → `stillorgan`, anything else → no `studio` param; the original query (`utm_*`, `fbclid`, anything) is appended verbatim, `studio` from the original is dropped. A header comment on each page says why (Richard, 24 Oct 2026: the free-class campaign is finished) and how to reverse it (delete the two `redirect(...)` lines).

- [ ] **Step 1: Write the failing test**

```js
it('maps the studio and keeps the query', () => {
  expect(trialRedirectFor('hatch-street', new URLSearchParams('utm_campaign=x&fbclid=y'))).toBe('/trial?studio=hatch&utm_campaign=x&fbclid=y')
  expect(trialRedirectFor('stillorgan', new URLSearchParams(''))).toBe('/trial?studio=stillorgan')
  expect(trialRedirectFor('somewhere', new URLSearchParams('a=1'))).toBe('/trial?a=1')
})
it('/start and /start/hatch-street call redirect()', async () => { /* mock next/navigation redirect, render the page functions */ })
```

- [ ] **Step 2: Run to see it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/app/start tests/un1t-literal-sweep.test.js src/public-compliance-paths.test.jsx src/lib/trial-studios.test.js` → PASS; `npm run build`.
- [ ] **Step 5: Commit** `TRIALSTUDIO.11 — /start and /start/<studio> redirect to /trial with the studio preselected`

### Task 12: Guardrails list, changelog, CI mirror, PR

**Files:**
- Modify: `eslint.guardrails.config.mjs` (add to the `files:` list of the `no-unchecked-supabase-write` block the new files: `src/lib/trial-eligibility.js`, `src/lib/trial-studios.js`, `src/lib/trial-purchase-un1t-settle.js`, `src/app/api/public/trial-purchases/help/route.js`)
- Create: `docs/changelog/entries/<PR>.md` after `gh pr create` (one row keyed `#<PR>`)
- Modify: `CLAUDE.md` Invariants, Glofox bullet on the trial purchase: one sentence that `/trial` refuses a Stillorgan buyer with trial history BEFORE payment (`src/lib/trial-eligibility.js`) and sends a Hatch buyer to un1t.online's checkout, never a charge.

- [ ] **Step 1: Run the CI mirror** (the thirteen commands in CLAUDE.md) and `npm run build`. Expected: all green.
- [ ] **Step 2: Apply migration 764** with the Supabase MCP `apply_migration` on `iyvtbjjxdggiadzwwvdj`; run `get_advisors` type security; expect no new ERROR.
- [ ] **Step 3: Push and open the PR** against `main` (the branch rule: a PR is required; `main` is protected). Title `TRIALSTUDIO.1-11 — /trial: choose your studio, Stillorgan trial-history gate, Hatch Street via un1t.online checkout, /start retired`. Body: the spec path, the ops steps below, the pixel note from Task 10.
- [ ] **Step 4: Changelog entry** committed to the branch.

**Ops after merge (Richard, in the CRM UI):** on `/settings/landing-page` for Stillorgan set the block's studio label to "Stillorgan Village"; for Hatch Street add a `paid_trial` block with product name "The UN1T Trial", duration 14, ticks, and `un1t_product_id` `674d62bf-4d4b-4231-b1ba-d53543657bea`; open `/trial` on `www.un1tdublin.com`, pick each studio, and run a €1 test only at Stillorgan (Hatch's price is un1t.online's).
