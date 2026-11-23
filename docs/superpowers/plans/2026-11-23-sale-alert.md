# SALEALERT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners and managers get one push, with a cha-ching, for every new sale at their studio.

**Architecture:** One function, `notifyNewSale`, in `src/lib/sale-alert.js`, called fire-and-forget from every place a sale settles. It sends through the existing deduped role push (`sendPushToRolesAtLocationOnce`), keyed on the sale, so several observers of one payment ring once. The custom sound ships second, in a native app build.

**Tech Stack:** Next.js 16 route handlers, supabase-js (service role), Expo push, `expo-notifications`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-sale-alert-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Two PRs. **PR 1 (SALEALERT.1)** is Tasks 1 to 8: server and JS only, default chime. **PR 2 (SALEALERT.2)** is Task 9: the native build with the sound.
- Each PR branches off a fresh `origin/main` in its own worktree (`npm ci` first), adds `docs/changelog/entries/<PR>.md`, and passes the CI mirror in CLAUDE.md. Commit messages start `SALEALERT.N — `.
- No migration. `push_event_sends` already exists.
- Recipients are roles `['owner', 'manager']` at the sale's location, nothing wider.
- Category is the bare name `sale`; `data.type` is `sale_new`.
- Dedup keys: `sale:<source>:<saleId>`. Sources: `offer`, `trial`, `class_booking`, `pay_link`, `race`, `glofox`, `un1t`. Any sale paid on the un1t.online rail uses `sale:un1t:<un1t transaction id>` whichever path sees it.
- `notifyNewSale` never throws and is never awaited in a way that can fail or delay the payment path (`void notifyNewSale(...)` or inside the existing fire-and-forget block).
- It does not call `inStaffPushHours` (owner-chosen exception: rings at any hour).
- Does not ring: renewals, refunds, amount not above €0, fees and recovered arrears, donations, raffle, car deposits, entries paid to a host's Stripe account, `move_gap` payments, events with no `location_id`.
- No `'Europe/Dublin'` literal, no new `console.log`, destructure `error` from every read.
- Buyer and item names pass through the existing `oneLine()` helper (`src/lib/sale-offers.js`) before going into a push.

## Review Focus

1. The same payment observed by webhook, status poll and reconcile within a second: exactly one push per recipient. (Task 1 test.)
2. A manager at Hatch must not hear a Stillorgan sale. (Task 1 test: location passed through with `locationScoped: true`.)
3. Push send throws or the recipients read fails: the payment path's result is unchanged. (Task 1 and Task 3 tests.)
4. A retried Glofox delivery of the same PAID invoice, and a PAID complimentary invoice raised by the CRM's own trial grant: one ring and no ring. (Task 6 tests.)
5. First un1t.online sync after release, with a day of old transactions in the mirror: no rings. (Task 7 test.)

---

### Task 1: The alert function

**Files:**
- Create: `src/lib/sale-alert.js`
- Test: `src/lib/sale-alert.test.js`

**Interfaces:**
- Consumes: `sendPushToRolesAtLocationOnce(db, eventKey, locationId, roles, payload, opts)` from `src/lib/push-dedup.js`; `oneLine` and `formatEuro` as used in `src/lib/sale-offers.js`.
- Produces:
  ```js
  export const SALE_ALERT_ROLES = Object.freeze(['owner', 'manager'])
  export function saleAlertKey(source, saleId) // 'sale:<source>:<saleId>'
  export function buildSaleAlertPayload({ itemName, amountCents, buyerFirstName, locationName, contactId })
  // -> { title, body, category: 'sale', data: { type: 'sale_new', contact_id? } }
  export async function notifyNewSale(db, { source, saleId, locationId, itemName, amountCents, buyerFirstName, locationName, contactId })
  // -> { sent: boolean, reason?: 'missing_key' | 'zero_amount' | 'error' }   never throws
  ```

- [ ] **Step 1: Write failing tests** (mock `./push-dedup`):
  - `buildSaleAlertPayload` with `{ itemName: '20 Class Pack', amountCents: 25000, buyerFirstName: 'Jordan', locationName: 'Stillorgan' }` gives title `New sale: 20 Class Pack (€250)` and body `Jordan · Stillorgan`; with `amountCents: null` the title is `New sale: 20 Class Pack`; with no item name the item is `Purchase`.
  - `notifyNewSale` calls the dedup sender once with key `sale:offer:abc`, the location id, `['owner','manager']`, a payload with `category: 'sale'`, and opts `{ locationScoped: true }`.
  - `amountCents: 0` returns `{ sent: false, reason: 'zero_amount' }` and sends nothing; `amountCents: null` sends.
  - Missing `source`, `saleId` or `locationId` returns `reason: 'missing_key'`.
  - Sender rejects: resolves `{ sent: false, reason: 'error' }`, does not throw.
  - Two calls with the same key both delegate (dedup is the sender's job; assert the key is identical).
- [ ] **Step 2:** `npx vitest run src/lib/sale-alert.test.js` — FAIL (module missing).
- [ ] **Step 3:** Implement. Log failures with `logError('sale-alert', …)`; no customer names in logs.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit.

### Task 2: Register the category

**Files:**
- Modify: `src/lib/notifications-registry.js` (new entry after `lead`)
- Modify: `shared/permissions.js` (`notify_sale` beside `notify_lead` at ~717, and in every role default block ~833-1045)
- Modify: `shared/push-channels.js` (`CATEGORY_CHANNELS`)
- Modify: `mobile/lib/notification-nav.js` (`sale_new` case)
- Modify: `docs/rules/conventions.md`, `src/lib/staff-push-hours.js` header (record the any-hour exception)
- Test: `tests/push-category-literals.test.js`, `src/lib/push-channels.test.js`, the permissions tests that enumerate keys

**Interfaces:**
- Produces: category `sale` resolvable by `readPushAllowedIds`; `androidChannelId({ category: 'sale' }) === 'reminders'`.

Decisions:
- Registry entry: `label: 'New sales'`, `description: 'Fires when someone buys something new at your location. Renewals do not fire.'`, `recipients: { kind: 'roles_at_location', detail: 'owner / manager' }`, `configurable: { leadTimes: false, roles: false }`, `fallbackEmail: false`.
- `notify_sale` default `true` for owner and manager blocks, `false` everywhere else. Read each default block's role before setting it; do not copy `notify_lead`'s values.
- The permissions editor must not offer `notify_sale` for head_coach or staff. Find how `isNotify` keys are listed per role in the editor and filter this key to owner and manager; add a test.
- PR 1 maps `sale` to the existing `reminders` channel. The dedicated `sales` channel is created only in Task 9: an Android channel created before the sound file is bundled would be stuck without it for ever.
- `sale_new` tap-through: the contact screen when `data.contact_id` is set, otherwise the same destination the `lead` type uses for a missing id.
- `shared/` is mirrored: follow `docs/rules/champ-app-sync.md` for both shared files.

- [ ] **Step 1:** Add failing assertions: `androidChannelId({ category: 'sale' })` is `'reminders'`; the registry has `sale`; owner and manager defaults have `notify_sale: true`, head_coach and staff `false`.
- [ ] **Step 2:** Run those test files — FAIL.
- [ ] **Step 3:** Make the edits above.
- [ ] **Step 4:** `npx vitest run tests/push-category-literals.test.js src/lib/push-channels.test.js` plus the permissions tests, then `npm run check:mobile-parity && npm run check:mobile-lint` — PASS.
- [ ] **Step 5:** Commit.

### Task 3: Offers (both rails)

**Files:**
- Modify: `src/lib/sale-offers.js` (`notifyStaffOfPaidPurchase`, ~163)
- Modify: `src/lib/ops-alerts.js` only if needed to send email without the push branch
- Test: the existing tests for `sale-offers` and `un1t-offer-purchases`

**Interfaces:**
- Consumes: `notifyNewSale` (Task 1).

Decisions:
- `notifyStaffOfPaidPurchase` is already the one place both rails pass through. Call `notifyNewSale` there with `itemName: offer.name`, `amountCents: purchase.amount_cents`, first word of `purchase.buyer_name`, `contactId: purchase.contact_id`.
- Key: `sale:un1t:<purchase un1t transaction id>` when `purchase.payment_provider === 'un1t_online'`, else `sale:offer:<purchase.id>`. Confirm the transaction id column name on `offer_purchases` from `un1t-offer-purchases.js` before writing.
- The ops email stays. For paid offers the ops-alert push branch (taken when `ops_alert_emails` is empty) no longer fires; other `sendOpsAlert` callers are untouched.

- [ ] **Step 1:** Failing tests: a paid Revolut offer calls `notifyNewSale` with `source: 'offer'`; a un1t.online one with `source: 'un1t'` and the transaction id; with no ops emails configured, no uncategorised push is sent; `notifyNewSale` rejecting leaves the function's return value unchanged.
- [ ] **Step 2 to 5:** fail, implement, pass, commit.

### Task 4: Trials, paid class bookings, payment link

**Files:**
- Modify the three callers of `markTrialPurchasePaymentStatus` (`src/app/api/webhooks/revolut/class-bookings/route.js:~126`, `src/app/api/public/trial-purchases/[id]/route.js:~67`, `src/lib/revolut-reconcile.js:~379`)
- Modify: `src/lib/trial-purchase-un1t-settle.js`, `src/lib/un1t-paid-trial-purchases.js`
- Modify the four callers of `markClassBookingPaymentStatus` (Revolut webhook ~139, public poll ~36, reconcile ~364, `src/app/api/webhooks/stripe/route.js:~130`)
- Modify: `src/lib/staff-payment-link-sweep.js` (`settleLink`, ~172)
- Create: `src/lib/sale-alert-sources.js` — small adapters so call sites stay one line
- Test: `src/lib/sale-alert-sources.test.js` plus one assertion in each touched caller's existing test

**Interfaces:**
- Produces:
  ```js
  export function alertTrialSale(db, row)        // trial_purchases row
  export function alertClassBookingSale(db, row) // class_booking_requests row
  export function alertPayLinkSale(db, row)      // staff payment link row
  // each: maps the row to notifyNewSale args, returns its promise, never throws
  ```

Decisions:
- Call only on the first paid transition: where the mark function returns `released: true` (trials, class bookings), and after the winning compare-and-set in `settleLink`.
- Keys: Revolut trial `sale:trial:<row.id>`; un1t.online trial `sale:un1t:<transaction id>`; class booking `sale:class_booking:<row.id>`; payment link `sale:un1t:<row.paid_transaction_id>`.
- Class bookings ring only when the paid amount is above €0 (a funded or free booking is not a sale); the adapter passes the amount and Task 1's zero check does the rest. If the row's amount is null for a paid booking, read it from the row's price field; do not ring on an unknown amount for this source.
- Item names: `row.product_name` for trials, the class name for bookings, `row.product_title` for links.

- [ ] **Step 1:** Failing adapter tests: each maps to the key above; a €0 class booking does not send; each swallows a rejection.
- [ ] **Step 2:** Failing caller assertions: `released: true` calls the adapter once, `released: false` does not.
- [ ] **Step 3 to 5:** implement, pass, commit.

### Task 5: Event and race entries

**Files:**
- Modify: `src/lib/race-payment-completed.js` (`runRacePaymentCompletedEffects`, ~97)
- Modify: `src/lib/sale-alert-sources.js` (`alertRaceSale(db, payment, event)`)
- Test: both files' tests

Decisions:
- Rings only when all hold: the payment is an entry (not `move_gap`), `event.location_id` is set, and the money settled to the studio. Read `src/lib/race-payments.js:170-223` to find the field that marks a host's Stripe connected account and treat any such payment as not ringing.
- Key `sale:race:<payment.id>`. Item name: the event name.

- [ ] **Step 1:** Failing tests: studio-settled entry rings; host-account entry, `move_gap` and a null location do not.
- [ ] **Step 2 to 5:** fail, implement, pass, commit.

### Task 6: Glofox new purchases (Stillorgan)

**Files:**
- Create: `src/lib/glofox-sale-alert.js`
- Modify: `src/app/api/webhooks/glofox/route.js` (the `INVOICE_UPDATED` branch ~375, and the unmatched-member early return ~360)
- Test: `src/lib/glofox-sale-alert.test.js`

**Interfaces:**
- Produces:
  ```js
  export function glofoxInvoiceIsNewSale(invoice) // pure; -> { ring: boolean, reason: string }
  export function glofoxInvoiceItemName(payload)  // pure; -> string, falls back to 'Glofox purchase'
  export async function alertGlofoxInvoiceSale(db, { locationId, invoice, payload, contact })
  ```
  `invoice` is what `applyInvoiceWebhook` returns (status, `amount_cents`, `is_membership`, `line_item_subtypes`) plus `invoice_id` and payment method.

Decisions:
- **Before writing the filter, read real data.** Query `glofox_webhook_attempts` for recent `INVOICE_UPDATED` payloads (Supabase MCP, project `iyvtbjjxdggiadzwwvdj`, read-only) and record in the test file, as fixtures with names and emails replaced, one of each: a first membership payment, a renewal, a pack purchase, a fee, and the complimentary receipt raised by a CRM trial grant. If the MCP is not available, stop and report; do not guess the shapes.
- Allow-list: ring only when status is PAID, amount above €0, payment method is not complimentary, and every line-item sub-type is in the allowed set (first membership payment `SUBSCRIPTION_PAYMENT`, and the pack, credit and product sub-types found in the fixtures). `SUBSCRIPTION_RENEWAL`, `PRORATE`, `NON_SUFFICIENT_FUNDS`, fee and custom-charge sub-types never ring. Sub-type names come from `src/lib/glofox-arrears.js:~442`.
- Also skip an invoice whose id matches the stored grant invoice id on a CRM trial or offer purchase (`grant.invoice_id`; find the column from `trial-purchase-processor.js:192-200`).
- Key `sale:glofox:<invoice_id>`. A redelivery of the same PAID invoice is absorbed by the dedup claim; there is no need to read the previous status.
- An invoice for a member with no matching contact still rings (buyer name from the payload if present, else omitted). Place the alert call so the early return does not skip it, without changing what that return does for everything else.
- `MEMBERSHIP_CREATED` never rings.
- The amount shown is the delivery's own amount, as a label only.

- [ ] **Step 1:** Capture fixtures (above).
- [ ] **Step 2:** Failing tests on `glofoxInvoiceIsNewSale`: first payment rings; pack rings; renewal, fee, prorate, NSF recovery, complimentary, €0, unpaid and unknown sub-type do not.
- [ ] **Step 3:** Failing tests on `alertGlofoxInvoiceSale`: key shape; grant-matched invoice skipped; unmatched member still sends.
- [ ] **Step 4 to 6:** implement, pass, commit.

### Task 7: un1t.online in-app purchases (Hatch)

**Files:**
- Create: `src/lib/un1t-sale-alert.js`
- Modify: `src/lib/un1t-online-sync.js` (`runUn1tSync`, ~214, after transactions are mirrored)
- Test: `src/lib/un1t-sale-alert.test.js`

**Interfaces:**
- Produces:
  ```js
  export const UN1T_SALE_ALERT_FROM = '<ISO instant, set to the release time in the PR>'
  export const UN1T_SALE_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000
  export function un1tTransactionIsNewSale(tx, nowMs) // pure -> boolean
  export async function alertUn1tSales(db, { locationId, locationName, nowMs }) // -> { rung: number }
  ```

Decisions:
- Rings when: `type !== 'sub_renewal'`, not refunded, `amount_cents > 0`, `remote_created_at` is at or after `UN1T_SALE_ALERT_FROM` and within the last 24 hours, and the row is not a class-fee charge. Find how `chargeClassFee` marks its transaction (`src/lib/un1t-online-write-ops.js`) and exclude on that marker; if it leaves none, exclude by the `type` or `product_type` it produces and record the value in a test.
- Product purchases and first subscription payments ring; reuse the predicate at `src/lib/un1t-offer-purchases.js:~152` for the renewal, refund and zero checks so there is one rule, not two.
- Key `sale:un1t:<transaction id>`, the same key Tasks 3 and 4 use, so a transaction that also settled a CRM row rings once whoever saw it first.
- Read candidate rows with a bounded, ordered query on the window (it is at most a day of rows; still add `.order()` and a `.range()` cap of 200 and log if the cap is hit).
- One failed alert must not fail the sync; count and continue.

- [ ] **Step 1:** Failing tests: renewal, refund, €0, fee, row before the cutover, row older than 24h do not ring; a product purchase and a first subscription payment do; the key matches Task 3's un1t key for the same transaction id.
- [ ] **Step 2 to 5:** fail, implement, wire into `runUn1tSync`, pass, commit.

### Task 8: PR 1 wrap-up

- [ ] Add `docs/changelog/entries/<PR>.md` and a one-line rule in CLAUDE.md under "Conventions that bite": a new path that takes money for a new sale calls `notifyNewSale`; sale alerts ring at any hour by the owner's choice. Put the full rule in `docs/rules/conventions.md`.
- [ ] `npm run build`, then the CI mirror once (not alongside the build: 8 GB machine).
- [ ] Open the PR. No customer names in the body.
- [ ] After deploy: buy nothing. Ask Richard for one real or test sale, then confirm a single `push_event_sends` row per recipient for that key.

### Task 9 (PR 2): The cha-ching

**Files:**
- Create: `mobile/assets/sounds/cha-ching.wav` (file supplied or approved by Richard; licence noted in the PR)
- Modify: `mobile/app.config.js` (`expo-notifications` plugin `sounds: ['./assets/sounds/cha-ching.wav']`; `runtimeVersion` bump)
- Modify: `shared/push-channels.js` (new channel `sales`: name `Sales`, description `A new sale at your studio.`, importance `high`, `sound: 'cha-ching.wav'`; `sale: 'sales'`)
- Modify: `mobile/lib/push-register.js` (pass `sound: spec.sound` when a channel declares one)
- Modify: `src/lib/push.js:417` and `src/lib/sale-alert.js`
- Test: `src/lib/push.test.js`, `src/lib/push-channels.test.js`

**Interfaces:**
- Produces: `sendPush` payload accepts `sound: 'cha-ching.wav'`; allowed custom names come from a frozen list exported by `src/lib/push.js` (`PUSH_CUSTOM_SOUNDS`); anything else still resolves to `'default'`, and `null` still means silent.

Decisions:
- **Blocked until Richard supplies the sound file.** Do not source one yourself.
- `runtimeVersion` must change (currently `'2.4.0'`, `mobile/app.config.js:440-457`): the new JS creates the `sales` channel, and it must never run on a native build that lacks the sound file. Follow `mobile/docs/store-release-one-app.md` §8 and `mobile/docs/ota-rollout.md`.
- Old builds: before sending the custom name to everyone, test on an iPhone still on the old build. If it plays the default chime, send the custom name to all. If it is silent, send the custom name only to devices on the new version: check what the device row records about app or runtime version and gate on it; if nothing is recorded, add the gate to this task's scope and tell Richard.

- [ ] **Step 1:** Failing tests: `sendPush` with `sound: 'cha-ching.wav'` puts that on the Expo message; `sound: 'other.wav'` gives `'default'`; `androidChannelId({ category: 'sale' })` is `'sales'`.
- [ ] **Step 2 to 4:** fail, implement, pass.
- [ ] **Step 5:** Build for the store, install on a test iPhone, lock it, trigger one alert: cha-ching plays. Record the old-build result and apply the rule above.
- [ ] **Step 6:** Changelog entry, CI mirror, PR.
