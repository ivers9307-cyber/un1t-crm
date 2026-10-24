# Charity Donations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Donate card on the public event page, side by side with the team signup, that takes card donations on the event's own payment rail, matches them, sends a receipt, and gives staff a list, totals and a CSV.

**Architecture:** A new service-role `donations` table and two `race_events` columns (`charity_enabled`, `charity` jsonb) carry the settings and the money. The flow copies the paid trial's shape: public POST inserts `awaiting_payment` and opens a provider order, the embedded checkout mounts in the card, a public status route re-checks the provider under a rate cap, and a signed Revolut webhook (plus the Stripe route) confirms. Once-only side effects (contact, tag, consent, receipt) are keyed on their own null stamps, never on which call flipped the row.

**Tech Stack:** Next.js 16 App Router, Supabase (service role in routes), Zod, Revolut Merchant / Stripe Connect through `src/lib/payments`, Postmark through `sendTransactionalEmail`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-24-charity-donations-design.md` (sections 1 to 9; section 6b is a separate plan).

## Global Constraints

- Every `/api` route uses `createServerClient()` (service role, no RLS): the donate route and the staff routes scope by the event's `location_id`; detail misses are 404, never 403 (CLAUDE.md).
- New table closed to clients: `ALTER TABLE … ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public.donations FROM anon, authenticated, public;`, no policy. New `race_events` columns carry `-- column-grant: withheld race_events.<col>` (no client privilege since mig 682).
- Every supabase write destructures `error`; `.single()` only with a primary-key filter, else `.maybeSingle()` (`check:guardrails`).
- Every `.select()` column must exist in a migration (`check:select-columns`).
- Customer-facing copy is a settings field with a default in `src/lib/charity-donations.js`; nothing the donor reads lives only in JSX.
- Amount the server charges is the validated `amount_cents` from the body, bounded by the event's own `min_cents`/`max_cents`; defaults €5 and €5,000; presets default `[1000, 2500, 5000, 10000]`.
- Match multiplier 1 to 5, no cap; snapshotted onto the row at `paid`.
- Public status route returns no donor PII.
- Receipt is ADMINISTRATIVE: gated by `checkTransactionalConsent`, never by marketing consent; the send-once stamp is written AFTER the send.
- Migration number **765** (764 is taken by the unmerged `trial-studio-choice` branch; gaps are fine).
- Ticket prefix for commits: `CHARITY.<n>`.
- Before pushing: the CI mirror from CLAUDE.md (`npm test && npm run lint && … check:ota-paths`) and `npm run build`.

## Review Focus

1. A body with `amount_cents` as a float, negative, zero or a string → 400 before any DB read (Task 5 test).
2. A webhook or poll that reports `completed` for a donation already `refunded` must leave it `refunded` (Task 3 test).
3. The operator switches the charity section off after a checkout was opened: the status route must still resolve the row and mark it paid, since the money was taken (Task 6 test).
4. A donor email with uppercase and whitespace must match the existing contact (Task 3: `findOrCreateRaceContact` receives the raw email; it normalises; test asserts the call).
5. A charity name containing `<` must appear escaped in the receipt HTML and the statement description must still be plain text (Task 3 test).

---

### Task 1: Migration 765 — donations table, event columns, webhook provider

**Files:**
- Create: `supabase/migrations/765_charity_donations.sql`
- Test: `tests/migration-765-charity-donations.test.js`

**Interfaces:**
- Produces: table `public.donations` with the columns in spec §7 plus `refunded_by uuid`, `receipt_email_status text` (`'sent' | 'suppressed' | 'failed'`, null until attempted); `race_events.charity_enabled boolean not null default false`, `race_events.charity jsonb`; `webhook_events_provider_check` extended with `'revolut_donation'`.

- [ ] **Step 1: Write the failing guard test**

```js
// tests/migration-765-charity-donations.test.js
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
const sql = fs.readFileSync('supabase/migrations/765_charity_donations.sql', 'utf8')
describe('mig 765 — donations', () => {
  it('creates donations closed to every client session', () => {
    expect(sql).toMatch(/create table if not exists public\.donations/i)
    expect(sql).toMatch(/alter table public\.donations enable row level security/i)
    expect(sql).toMatch(/revoke all on public\.donations from anon, authenticated, public/i)
    expect(sql).not.toMatch(/create policy[^;]*on public\.donations/i)
  })
  it('constrains status and match multiplier', () => {
    expect(sql).toMatch(/status in \('awaiting_payment', ?'paid', ?'failed', ?'expired', ?'refunded'\)/i)
    expect(sql).toMatch(/match_multiplier numeric\(3,1\) not null default 1/i)
  })
  it('adds the event columns withheld from clients', () => {
    expect(sql).toMatch(/add column if not exists charity_enabled boolean not null default false/i)
    expect(sql).toMatch(/add column if not exists charity jsonb/i)
    expect(sql).toMatch(/column-grant: withheld race_events\.charity_enabled/)
    expect(sql).toMatch(/column-grant: withheld race_events\.charity/)
  })
  it('extends the webhook provider list with revolut_donation and keeps every existing value', () => {
    for (const p of ['postmark','revolut','revolut_race','revolut_class_booking','revolut_offer','whatsapp','instagram','twilio','xero','unifi_access','unifi_protect','revolut_donation']) {
      expect(sql).toContain(`'${p}'`)
    }
  })
})
```

- [ ] **Step 2: Run it to confirm it fails** — `npx vitest run tests/migration-765-charity-donations.test.js` → FAIL (ENOENT).

- [ ] **Step 3: Write the migration.** Columns per spec §7 table, plus `refunded_by uuid references public.profiles(id) on delete set null` and `receipt_email_status text`. `race_event_id … on delete restrict`, `location_id … references public.locations(id) on delete cascade`, `contact_id … on delete set null`. CHECK on status (five values) and `amount_cents > 0`. Indexes: `idx_donations_event_status (race_event_id, status)`, `idx_donations_provider_ref (payment_provider_ref) where payment_provider_ref is not null`, `idx_donations_contact (contact_id)`. Trigger `trg_donations_updated_at` → `update_updated_at()` (as mig 762). RLS on, `REVOKE ALL … FROM anon, authenticated, public`. Event columns with the two `-- column-grant: withheld` comments. Re-create `webhook_events_provider_check` with mig 505's eleven values plus `'revolut_donation'` (copy the DROP/ADD pair). Table COMMENT: `CHARITY.1: donations taken on the public event page. Service-role only.` Mention in a header comment that the file is applied via Supabase MCP against `iyvtbjjxdggiadzwwvdj` before the code deploys.

- [ ] **Step 4: Run the test and the schema replays** — `npx vitest run tests/migration-765-charity-donations.test.js && npm run check:select-columns && npm run check:rls-restrictive` → all PASS.

- [ ] **Step 5: Commit** — `git add supabase/migrations/765_charity_donations.sql tests/migration-765-charity-donations.test.js && git commit -m "CHARITY.1 — mig 765: donations table, race_events charity columns, revolut_donation webhook provider"`.

---

### Task 2: `src/lib/charity-donations.js` — settings, copy defaults, totals

**Files:**
- Create: `src/lib/charity-donations.js`
- Test: `src/lib/charity-donations.test.js`

**Interfaces:**
- Produces:
  - `CHARITY_DEFAULTS` (frozen object): `{ name: '', heading: "Can't race? Give a rep.", blurb: 'Every euro goes to {{charity}}.', presets_cents: [1000, 2500, 5000, 10000], custom_allowed: true, min_cents: 500, max_cents: 500000, match_multiplier: 1, match_label: 'Matched by {{brand}}', goal_cents: null, show_total: true, include_entries: true, consent_label: '', thank_you_title: 'Thank you, {{first_name}}.', thank_you_body: 'Your {{amount}} becomes {{matched}} for {{charity}}. {{brand}} passes every donation, matched, to {{charity}} after the event.', thank_you_body_unmatched: 'Thank you for your {{amount}} donation to {{charity}}. {{brand}} passes every donation to {{charity}} after the event.', receipt_subject: 'Thank you for your donation to {{charity}}', receipt_intro: '' }`
  - `CharitySettingsSchema` (Zod): every key above, all optional, `presets_cents: z.array(z.number().int().positive().max(100000000)).max(8)`, `min_cents`/`max_cents` positive ints, `match_multiplier: z.number().min(1).max(5)`, `goal_cents` nullable positive int, strings `max(4000)`; `.superRefine`: `min_cents <= max_cents`; at least one preset or `custom_allowed`.
  - `resolveCharitySettings(race) → settings` : `{ ...CHARITY_DEFAULTS, ...(race?.charity || {}) }` with nulls dropped, `enabled: !!race?.charity_enabled`.
  - `renderCharityCopy(str, vars) → string`: replaces `{{charity}}`, `{{brand}}`, `{{first_name}}`, `{{amount}}`, `{{matched}}`; unknown tags left as is.
  - `computeCharityTotals({ donations, entries, multiplier, includeEntries }) → { donations_cents, donations_matched_cents, entries_cents, entries_matched_cents, raised_cents, donation_count }` where `donations` are `{ amount_cents, match_multiplier, status }` rows (only `status === 'paid'` count), `entries` are `{ amount_cents, status }` (only `'completed'`), `raised_cents = donations_matched + (includeEntries ? entries_matched : 0)`, matched = `Math.round(cents * multiplier)`.
  - `donationPublicState(row) → 'pending' | 'paid' | 'failed' | 'refunded' | 'notfound'` (`failed`/`expired` → `'failed'`).
  - `formatCents(cents, currency) → '€25.00'` (reuse `Intl.NumberFormat('en-IE')`).

- [ ] **Step 1: Write the failing tests** — `computeCharityTotals` with: two paid donations at multipliers 2 and 1 plus a refunded one → `donations_matched_cents` excludes the refunded; entries in and out of the total; empty inputs → zeros; `resolveCharitySettings` on a row with `charity: null` → defaults and `enabled: false`; `CharitySettingsSchema` rejects `min_cents > max_cents` and `presets_cents: []` with `custom_allowed: false`; `renderCharityCopy('Your {{amount}} to {{charity}}', { amount: '€25.00', charity: 'MS Ireland' })`; `donationPublicState({ status: 'expired' }) === 'failed'`.

- [ ] **Step 2: Run** — `npx vitest run src/lib/charity-donations.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement the module** with the signatures above.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** — `CHARITY.2 — charity-donations lib: settings schema, copy defaults, totals`.

---

### Task 3: `src/lib/donation-payments.js` — provider order, status, side effects, receipt

**Files:**
- Create: `src/lib/donation-payments.js`
- Create: `src/lib/donation-receipt.js`
- Test: `src/lib/donation-payments.test.js`, `src/lib/donation-receipt.test.js`

**Interfaces:**
- Consumes: `paymentsFor` (`@/lib/payments`), `resolvePaymentProvider`, `hostCanTakePayments` (`@/lib/event-hosts`), `getLocationBranding`, `resolveCustomerBaseUrl`, `findOrCreateRaceContact({ db, locationId, email, name })`, `writeContactTag(db, { contactId, locationId, tag, metadata })`, `applyFormMarketingConsent(db, { contactId, consent, source, ipAddress, locationId })`, `resolveEventEmail`, `resolveEventCommsLocation(db, event)`, `checkTransactionalConsent`, `sendTransactionalEmail`, Task 2.
- Produces:
  - `DONATION_COLS` (string): every `donations` column the routes select.
  - `createDonationPayment({ db, donation, race, host, returnUrl }) → { donationId, checkout: { provider, token, url, connectedAccountId } }`. Provider = `resolvePaymentProvider(host)`; throws `payments_unavailable` when `stripe_connect` and `!hostCanTakePayments(host)`. Description `"{brand}: Donation to {charity name}"` (plain text, brand from `getLocationBranding(db, race.location_id).companyName`). `metadata: { donation_id, domain: 'un1t_donation', race_event_id, location_id }`, `idempotencyKey: donation.id`, `applicationFeeCents: 0`. Persists `payment_status`-equivalent fields on the row (`payment_provider`, `payment_provider_ref`, `payment_checkout_token`, `payment_checkout_url`, `connected_account_id`); throws if the update errors.
  - `resolveDonationByRef(db, providerRef) → row | null`.
  - `markDonationPaymentStatus({ db, donation, providerState, providerAmount, multiplier, now }) → { status, changed }`: `paid`/`refunded`/`failed`/`expired` rows never change; `completed` → `paid` with `paid_at`, `match_multiplier = multiplier`, and `amount_cents = providerAmount` when it differs; `failed|cancelled|expired` → `failed`/`expired`.
  - `markDonationRefunded({ db, donationId, byProfileId, now }) → { changed }` (only from `paid`).
  - `runPaidDonationSideEffects({ db, donation, race, ipAddress }) → { contact: 'linked'|'skipped'|'failed', consent: …, receipt: 'sent'|'suppressed'|'failed'|'skipped' }`: runs on every observation of `paid`; each step keyed on its stamp: contact only when `contact_id` is null (then tag `donor` + consent when `marketing_opt_in`), receipt only when `receipt_email_sent_at` is null. Never throws; each step in its own try/catch with `logError('donation-payments', …)`.
  - `donation-receipt.js`: `buildDonationReceiptDefaults(ctx) → { subject, intro, infoRows }` and `sendDonationReceipt({ db, donation, race, contact }) → { status: 'sent'|'suppressed'|'failed'|'skipped', reason? }`. Uses `resolveEventEmail({ db, kind: 'donation_receipt', race: { ...race, donation_receipt_email_subject: settings.receipt_subject, donation_receipt_email_intro: settings.receipt_intro }, contact, extras, defaults, brandLocationId })` so the operator's subject/intro ride the existing merge-tag path; the fixed body carries amount, the match line when multiplier > 1, the pass-on sentence, and "This is not a charity tax receipt." Every ctx string goes through the module's `escapeHtml` (copy from `race-confirmations.js`). After a send: `receipt_email_sent_at = now`, `receipt_email_status = 'sent'`; a suppression stamps both with `'suppressed'` and `logError`; a Postmark failure stamps only `receipt_email_status = 'failed'` (so the next observation retries).

- [ ] **Step 1: Write the failing tests** (mock `@/lib/payments`, `@/lib/event-hosts`, `@/lib/location-branding`, `@/lib/tenant-host`, `@/lib/race-contact-linking`, `@/lib/contact-tags`, `@/lib/marketing-consent`, `@/lib/event-email`, `@/lib/event-comms-location`, `@/lib/transactional-consent`, `@/lib/postmark`, `@/lib/log`; a hand-rolled `db.from` like the trial route test):
  - `createDonationPayment` calls `createPayment` with `description: 'UN1T Stillorgan: Donation to MS Ireland'`, `idempotencyKey: 'd1'`, `metadata.domain === 'un1t_donation'`; a failed ref update rejects with `/persist/`.
  - `markDonationPaymentStatus`: `completed` on `awaiting_payment` → `{ status: 'paid', changed: true }` and the update carries `match_multiplier: 2`, `paid_at`; the same call on a `paid` row → `changed: false` and no update; `completed` on a `refunded` row → stays `refunded`, no update (Review Focus 2); `cancelled` → `expired`.
  - `runPaidDonationSideEffects`: with `contact_id: null`, `donor_email: '  Sarah@Example.COM '` → `findOrCreateRaceContact` called with that email and `locationId: race.location_id`, `writeContactTag` with `tag: 'donor'`, consent called only when `marketing_opt_in`; with `contact_id` set → contact step skipped; with `receipt_email_sent_at` null → receipt sent once; with it set → not sent; a receipt that throws → `receipt: 'failed'`, stamp `receipt_email_status: 'failed'` and no `receipt_email_sent_at`.
  - `donation-receipt.test.js`: `buildDonationReceiptDefaults` with charity `'MS <b>Ireland</b>'` → HTML contains `MS &lt;b&gt;Ireland&lt;/b&gt;` (Review Focus 5); multiplier 2 → the body contains `€25.00` and `€50.00`; multiplier 1 → no "becomes" line; `sendDonationReceipt` on a suppressed gate → `{ status: 'suppressed' }` and the row stamped `'suppressed'`.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement both modules.**
- [ ] **Step 4: Run** `npx vitest run src/lib/donation-payments.test.js src/lib/donation-receipt.test.js` → PASS; `npm run check:guardrails` clean for the two files (add them to the armed `files` list in `eslint.guardrails.config.mjs` for `no-unchecked-supabase-write`).
- [ ] **Step 5: Commit** — `CHARITY.3 — donation payments: provider order, status machine, stamp-keyed side effects, receipt`.

---

### Task 4: Public event read gains `charity`

**Files:**
- Modify: `src/app/api/public/events/[slug]/route.js` (select list + response)
- Test: `src/app/api/public/events/[slug]/route.charity.test.js`

**Interfaces:**
- Consumes: Task 2 (`resolveCharitySettings`, `computeCharityTotals`).
- Produces: response `data.charity` = `{ enabled: true, name, heading, blurb, presets_cents, custom_allowed, min_cents, max_cents, match_multiplier, match_label, goal_cents, show_total, consent_label, thank_you_title, thank_you_body, thank_you_body_unmatched, raised_cents?, donation_count?, team_count? }` when `charity_enabled`; the key is ABSENT when not. `raised_cents`/`donation_count`/`team_count` present only when `show_total`; `team_count` = confirmed registrations across waves (already counted for `is_full`).

- [ ] **Step 1: Write the failing test** (mock `createServerClient` with a `from` switch for `race_events`, `race_registrations`, `donations`, `race_payments`, `org_settings`/branding as the existing route tests in that folder do; look at `route.test.js` beside it for the exact chain shape): an event with `charity_enabled: false` → `data.charity` is `undefined`; enabled with `show_total: true`, two paid donations (2500 at 2, 1000 at 1) and one completed entry (5000) with `include_entries: true`, multiplier 2 → `raised_cents === 16000`, `donation_count === 2`; `show_total: false` → no `raised_cents` key; `min_cents`/`presets_cents` come from defaults when `charity` is null.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Add `charity_enabled, charity` to the select; after `registration_state`, when enabled, read `donations` (`amount_cents, match_multiplier, status` where `race_event_id = data.id and status = 'paid'`) and, when `include_entries`, `race_payments` (`amount_cents, status` where `race_event_id = data.id and status = 'completed'`), both with `.range(0, 999)`; a failed read logs and omits the totals (never 500s the page). Strip `charity`/`charity_enabled` from `racePublic` and emit the resolved block.**
- [ ] **Step 4: Run** → PASS; `npm run check:select-columns` → PASS.
- [ ] **Step 5: Commit** — `CHARITY.4 — public event read: charity block and matched totals`.

---

### Task 5: `POST /api/public/events/[slug]/donate`

**Files:**
- Create: `src/app/api/public/events/[slug]/donate/route.js`
- Test: `src/app/api/public/events/[slug]/donate/route.test.js`
- Modify: `scripts/check-route-guards.mjs` (EXEMPT entry: public, rate-limited, inserts only under the event it names)

**Interfaces:**
- Consumes: Task 2, Task 3 (`createDonationPayment`), `checkRateLimit`/`getClientIp`/`rateLimitResponse`, `validateBody`, `resolveCustomerBaseUrl`, `readVisitOrigin` shape from the register route's `attribution`.
- Produces: body `{ amount_cents: int, name: string(1..120), email: email, message?: string(≤280), marketing_opt_in?: boolean, attribution?: object }` → `200 { success, data: { donation: { id, amount_cents, currency, checkout: { provider, token, url, connectedAccountId } } } }`. Errors: `400 { code: 'invalid_amount' }` outside bounds, `404` unknown/unpublished/inactive event, `400 { code: 'not_enabled' }` when `charity_enabled` false, `400 { code: 'payments_unavailable' }`, `429`, `502 { code: 'checkout_failed' }`, `500 { code: 'unavailable' }` on insert failure.

- [ ] **Step 1: Write the failing tests** (trial-purchases route test style): float/negative/zero/string `amount_cents` → 400 and no DB read (Review Focus 1); `amount_cents: 400` with default min → `invalid_amount`; event with `charity_enabled: false` → `not_enabled`; a closed-registration event still accepts (registration state is irrelevant); rate limit → 429; happy path inserts `{ race_event_id, location_id, donor_name, donor_email (trimmed, original case), message, amount_cents: 2500, currency: race.payment_currency, status: 'awaiting_payment', marketing_opt_in: true, attribution }` and returns the checkout; `createDonationPayment` rejecting → 502 and the row updated to `status: 'failed'`.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**: rate key `donate:${slug}:${ip}` `{ max: 10, windowMs: 15 * 60_000 }`; read the event (`id, slug, location_id, name, kind, active, status, payment_currency, charity_enabled, charity, host_id, host:event_hosts!host_id ( * )` — use the same host select the register route uses); `returnUrl = ${await resolveCustomerBaseUrl(db, race.location_id)}/event/${slug}?donation=${row.id}`.
- [ ] **Step 4: Run** → PASS; `npm run check:route-guards && npm run check:location-scoping` → PASS (the insert carries `location_id` from the event row; register the route's reason in `check-location-scoping.mjs` only if the scan flags it).
- [ ] **Step 5: Commit** — `CHARITY.5 — POST /api/public/events/[slug]/donate`.

---

### Task 6: `GET /api/public/donations/[id]` status poll

**Files:**
- Create: `src/app/api/public/donations/[id]/route.js`
- Test: `src/app/api/public/donations/[id]/route.test.js`
- Modify: `scripts/check-route-guards.mjs` (EXEMPT), `scripts/check-location-scoping.mjs` (the `donations` entry beside `trial_purchases`, same wording: the UUID is the capability token, no donor PII returned)

**Interfaces:**
- Consumes: Task 2 (`donationPublicState`), Task 3 (`markDonationPaymentStatus`, `runPaidDonationSideEffects`, `DONATION_COLS`), `paymentsFor`, `checkRateLimit`.
- Produces: `200 { success, data: { id, state, amount_cents, currency, match_multiplier, checkout: { provider, token, url, connectedAccountId } | null } }`; `404` unknown id. While `awaiting_payment` with a provider ref, re-checks the provider under `dpoll:${id}` `{ max: 20, windowMs: 5 * 60_000 }`; on `paid` (fresh or already) runs `runPaidDonationSideEffects` (stamps make it idempotent) with the event row read by `race_event_id`.

- [ ] **Step 1: Write the failing tests**: unknown id → 404; `awaiting_payment` + provider says `completed` → `state: 'paid'`, `markDonationPaymentStatus` called with the event's current multiplier, side effects called; a row whose event now has `charity_enabled: false` still returns `paid` and runs side effects (Review Focus 3); rate-capped → no provider call, state `pending`; response has no `donor_name`/`donor_email` keys.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (mirror `trial-purchases/[id]/route.js`).
- [ ] **Step 4: Run** + `npm run check:route-guards && npm run check:location-scoping` → PASS.
- [ ] **Step 5: Commit** — `CHARITY.6 — public donation status poll with provider re-check`.

---

### Task 7: Webhooks — Revolut donations route, Stripe route extension

**Files:**
- Create: `src/app/api/webhooks/revolut/donations/route.js`
- Modify: `src/lib/webhook-events.js` (`REVOLUT_DONATION: 'revolut_donation'`)
- Modify: `src/app/api/webhooks/stripe/route.js` (`checkout.session.completed` and `checkout.session.expired` with `session.metadata?.domain === 'un1t_donation'`; `charge.refunded`: after the `race_payments` miss, try `resolveDonationByRef` and `markDonationRefunded({ byProfileId: null })`)
- Modify: `docs/architecture/INTEGRATIONS.md` (env `REVOLUT_DONATION_WEBHOOK_SECRET`, the URL to register)
- Test: `src/app/api/webhooks/revolut/donations/route.test.js`; extend `src/app/api/webhooks/stripe/route.test.js`

**Interfaces:**
- Consumes: Task 3; `verifyWebhookSignature`, `getOrder` (`@/lib/revolut`); `recordWebhookEvent`.
- Produces: `POST` returns `401` bad signature; `200 { deduped }` on replay; `200 { skipped: 'unknown_order' }`; `200 { state }` after marking; `GET` → `200`. Secrets `[REVOLUT_DONATION_WEBHOOK_SECRET, REVOLUT_WEBHOOK_SECRET]`.

- [ ] **Step 1: Write the failing tests** (copy the offer-payments webhook test's mocks): bad signature → 401 and no DB; dedupe seen → 200 deduped; unknown order → 200 skipped; `ORDER_COMPLETED` → `markDonationPaymentStatus` then `runPaidDonationSideEffects`; a second delivery (dedupe key differs by event) on an already-paid row → side effects still invoked (stamps decide), no status change. Stripe: a `checkout.session.completed` with `domain: 'un1t_donation'` marks paid; `charge.refunded` with no `race_payments` match but a `donations` match → `markDonationRefunded`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Event multiplier: read `race_events.charity` by `donation.race_event_id` for the snapshot.
- [ ] **Step 4: Run** both test files → PASS; `npm run check:route-guards` → PASS (webhooks verify a signature).
- [ ] **Step 5: Commit** — `CHARITY.7 — Revolut donations webhook; Stripe route routes the un1t_donation domain`.

---

### Task 8: The page — `DonateCard`, side-by-side layout, resume on return

**Files:**
- Create: `src/components/DonateCard.jsx` (client)
- Modify: `src/components/RaceSignupWidget.jsx` (layout when `race.charity?.enabled && !embedded`)
- Test: `src/components/DonateCard.test.jsx`, `src/components/RaceSignupWidget.charity.test.jsx`

**Interfaces:**
- Consumes: Task 4's `data.charity`; `ClassFunnelCheckout` (`paymentId`, `checkout`, `priceLabel`, `onPaid`, `onCancel`, `statusPath = '/api/public/donations'`); Task 5 and 6 routes; `formatCents`, `renderCharityCopy` (Task 2).
- Produces: `<DonateCard slug charity currency brand resumeDonationId onRaised />`. Steps `form | payment | confirming | done`; `onRaised()` fires once on `done` so the widget re-fetches the event for the strip. The widget reads `?donation=<id>` (and `&cancelled=1`) from `useSearchParams` and passes `resumeDonationId`.

- [ ] **Step 1: Write the failing tests.** `DonateCard`: renders the four default chips and "Other"; picking a chip sets the button label `Donate €25.00`; "Other" shows a number input and an amount below `min_cents` shows the inline error `Minimum €5.00` and does not POST; submit POSTs `{ amount_cents: 2500, name, email, message, marketing_opt_in, attribution }` to `/api/public/events/<slug>/donate` and mounts the checkout (mock `ClassFunnelCheckout` to a stub that calls `onPaid`); after `onPaid` the done step polls `/api/public/donations/<id>` until `state: 'paid'` then shows `thank_you_title` rendered with the first name and `thank_you_body` with `€25.00` and `€50.00` for multiplier 2 (and the unmatched body for 1); `resumeDonationId` mounts straight into `confirming`. `RaceSignupWidget.charity.test.jsx` (price-box test style): with `charity` absent the body has no "Donate" button and the description is in the left column as today; with `charity.enabled` the page has an element with text `OR` between a `Donate` button and the `Register and pay` button, the description appears AFTER both, and the strip shows `€160.00 raised` when `raised_cents: 16000`; `embedded` mode never renders the card.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Layout: inside the `!embedded` branch, when `race.charity?.enabled`, replace the two-column grid with: the strip (`show_total` only: total, goal bar when `goal_cents`, `donation_count` donors · `team_count` teams), then `grid md:grid-cols-[1fr_auto_1fr]` with `<DonateCard/>`, an `OR` divider (`aria-hidden` rule + a 48px circle, `aria-label="or"` on the wrapper), the existing signup card; then the existing left-column content (description, details rows, pricing) full width below. The mobile sticky bar is unchanged. Use the `lp-card-glow rounded-2xl p-6` card classes, `lp-btn` for the button, the same input classes as the signup form (`inputCls`); chips are `rounded-xl border border-white/15 bg-white/5` with the selected one `bg-white text-black`. Consent copy: `charity.consent_label` when non-empty, else the widget's existing organisation consent line.
- [ ] **Step 4: Run** both test files and the existing `RaceSignupWidget.*.test.jsx` → PASS; `npm run check:guardrails` (`no-untyped-button-in-form`, `no-low-contrast-*`) → clean.
- [ ] **Step 5: Commit** — `CHARITY.8 — DonateCard and the side-by-side event page`.

---

### Task 9: Operator form — "Charity day" section

**Files:**
- Modify: `src/components/RaceEventForm.jsx` (state + section + payload)
- Modify: `src/app/api/events/[id]/route.js` (`UpdateSchema`: `charity_enabled: z.boolean().optional()`, `charity: CharitySettingsSchema.nullable().optional()`); same two keys on the create schema in `src/app/api/events/route.js`
- Modify: `src/app/(members)/events/[id]/edit/page.js` and `src/app/api/events/[id]/route.js` GET select if either names columns explicitly (add `charity_enabled, charity`)
- Test: `src/components/RaceEventForm.charity.test.jsx`, extend `src/app/api/events/[id]/route.test.js`

**Interfaces:**
- Consumes: Task 2 schema.
- Produces: PUT body carries `charity_enabled` and `charity` (object, presets typed as comma-separated euros in the UI and sent as cents; blank text fields sent as absent so defaults apply).

- [ ] **Step 1: Write the failing tests.** Form: a race with `charity_enabled: true, charity: { name: 'MS Ireland', presets_cents: [1000, 2500], match_multiplier: 2 }` shows the section ticked, the presets field reads `10, 25`, saving sends `charity.presets_cents: [1000, 2500]` and `charity.match_multiplier: 2`; unticked → `charity_enabled: false` and the `charity` object still sent (settings survive a toggle). Route: PUT with `charity: { min_cents: 900, max_cents: 100 }` → 400; valid → the update includes both columns.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Section placed after the pricing section, any kind: switch, charity name, heading, blurb, presets (text, `€10, 25, 50` → cents), allow other + min + max (euros), match multiplier (number 1–5, step 0.5) + match label, goal (euros, blank = none), show total, include entries, thank-you title/body/unmatched body, receipt subject/intro via `EventEmailFields` with `showTemplate={false}` and `extraTags={['{{charity}}','{{amount}}','{{matched}}']}`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `CHARITY.9 — event form: Charity day section; charity settings on create/update`.

---

### Task 10: Staff — donations page, list API, CSV, mark as refunded

**Files:**
- Create: `src/app/api/events/[id]/donations/route.js` (GET; `?format=csv`)
- Create: `src/app/api/events/[id]/donations/[donationId]/refunded/route.js` (POST)
- Create: `src/app/(members)/events/[id]/donations/page.js` (server) + `src/components/EventDonationsList.jsx` (client)
- Modify: `src/app/(members)/events/page.js` (row link `Donations` → `/events/${r.id}/donations` when `r.charity_enabled || r.donation_count > 0`; add `charity_enabled` to that page's select and a count read, or show the link on `charity_enabled` alone if the count is costly — builder's call, say which in the commit)
- Test: `src/app/api/events/[id]/donations/route.test.js`, `…/refunded/route.test.js`, `src/components/EventDonationsList.test.jsx`

**Interfaces:**
- Consumes: Task 2 (`computeCharityTotals`, `formatCents`), Task 3 (`markDonationRefunded`), `getCurrentUser`, `assertLocationAccessOr404`, `hasPermissionForLocation(user, loc, 'races')`, `hasRoleAtLocation(user, loc, MANAGER_ROLES)`, `getLocationZone`, `formatInZone`.
- Produces: GET `{ success, data: { donations: [{ id, paid_at, donor_name, donor_email, amount_cents, match_multiplier, matched_cents, currency, status, message, receipt_email_status, refunded_at }], totals: computeCharityTotals output, currency } }` (rows ordered `paid_at desc nulls last`, `awaiting_payment` rows older than 2 hours omitted); CSV columns `paid_at (event zone), name, email, amount, matched, status, message`. POST refunded → `{ success, data: { changed } }`; 404 off-location or wrong event; 409 when not `paid`.

- [ ] **Step 1: Write the failing tests**: GET 401 anonymous, 404 for an event at a studio the caller lacks, 200 with totals; CSV content type `text/csv` and the header row; refunded POST flips `paid` → `refunded` with `refunded_by = user.id`, second call 409. Component: renders totals and the "Mark as refunded" button only on `paid` rows.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (page mirrors `teams/page.js` gates; list component uses `Table`/`Button` from `@/components/ui`, status chips `bg-<c>-500/10 text-<c>-700`).
- [ ] **Step 4: Run** → PASS; `npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails` → PASS.
- [ ] **Step 5: Commit** — `CHARITY.10 — staff donations page, CSV export, mark as refunded`.

---

### Task 11: Registration, docs, CI mirror, build

**Files:**
- Modify: `src/lib/openapi.js` (the five new paths, tag `Public` for three, `Events` for two, in the trial-purchases wording style)
- Modify: `docs/events.md` (a "Charity donations" subsection: tables, routes, the Revolut webhook registration step, the Mark-as-refunded rule)
- Create: `docs/changelog/entries/<PR>.md` after `gh pr create` (one row keyed `#<PR>`)

- [ ] **Step 1: Register the routes in openapi.js and extend docs/events.md.**
- [ ] **Step 2: Run the CI mirror** — `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths` → all green.
- [ ] **Step 3: Run `npm run build`** → succeeds (new routes/pages resolve).
- [ ] **Step 4: Commit** — `CHARITY.11 — openapi, events.md`.
- [ ] **Step 5: Hand-off checklist for Richard (in the PR body):** apply mig 765 via Supabase MCP on `iyvtbjjxdggiadzwwvdj` and run `get_advisors` (security) BEFORE merging; after deploy register `https://crm.un1tdublin.com/api/webhooks/revolut/donations` in the Revolut dashboard and set `REVOLUT_DONATION_WEBHOOK_SECRET` in Vercel; switch the section on for `stillorgan-nov21-0900` and set charity name, multiplier 2, match label.
