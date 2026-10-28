# Hatch Street payment reminders (UN1TDUN)

**Status:** proposed, 28 Oct 2026. Follows UN1TINCR.1 (#2244).
**Goal:** a Hatch member whose un1t.online membership payment fails gets the same chase a Stillorgan member gets from Glofox: the studio's dunning sequence (WhatsApp + email), a one-click "Send payment reminder" on the Churn Radar, the run stopping when they pay, and Mia able to say a reminder went out.

## Where things stand

| | Stillorgan (Glofox) | Hatch (un1t.online) |
|---|---|---|
| Detects a failed payment | `INVOICE_UPDATED` webhook → `maybeEnrolDunning` (`src/lib/dunning.js:91`) | Sync stores `un1t_subscriptions.past_due_at` / `un1t_invoices.status`; nothing acts on it. No un1t.online webhook exists. |
| Pay link | Glofox pay link minted per run (`dunning-payment.js`) | None. `invoice_url` is stripped from `un1t_invoices.raw` (PII rule, `un1t-online-map.js:26`). |
| Radar button | Shown | Hidden (`ChurnRadar.jsx:260`), refused 409 (`churn-radar/action/route.js:222`, `PAYMENT_REMINDER_UN1T`) |
| Mia | Confirms a live reminder | Always `has_reminder: false` (`agent/un1t-tools.js:440-480`, `prompt.js:109-112`) |

## What un1t.online lets us use (spec + live read, 28 Oct)

- `GET /invoices/{id}`: works with our API token (`invoices:read`). Every invoice carries `invoice_url`, a **Stripe hosted invoice page** (`invoice.stripe.com/i/<acct>/<id>?s=…`). Opening it lets the member pay the overdue invoice with a new card. This is the Glofox pay-link equivalent, and it is available today.
- `POST /payment-methods/client/{userId}/setup-requests` and `/resend` ("update your card" links): **`x-api-token: false`**, so our token cannot call them. That is Phase 2, behind un1t.online's decision.
- `POST /subscriptions/{id}/retry-payment`: token-callable, but it **charges money**. Not needed once the member pays through the hosted invoice. Left out (see decisions).

## Design

### 1. The link: our own short link, resolved live
Stripe's URL (three path segments plus a query) cannot sit behind a WhatsApp URL button, whose base URL is fixed with one suffix variable. It is also a bearer URL we choose not to store. So:

- **`/pay-link/<token>`** (new public route): `token` is random and its sha256 is stored on the enrolment's `metadata.payment`, the FEES.3 appeal-token pattern.
- On open, it looks up the run's `invoice_id`, calls `GET /invoices/{id}` **live**, and returns a 302 to `invoice_url`.
  - Invoice already paid: a "you're all paid up" page.
  - un1t.online unreachable: a "try again shortly" page with the studio's contact details.
- The URL is never stored and never logged.
- **Four public allowlists** (CLAUDE.md invariant): `src/proxy.js` `publicPaths`, AppShell `PUBLIC_PATHS`, `brands.js` un1t-marketing `allowedPaths`, `tenant-domains-edge.js` `DB_BRAND_DEFAULTS.allowedPaths`. Guard: `src/public-compliance-paths.test.jsx`.
- `metadata.payment` keeps the Glofox shape, so the senders change little: `{ invoice_id, link: <our short link>, link_suffix: <token>, amount, currency, retriable: false, fetched_at, error, platform: 'un1t_online' }`.

### 2. Detection: a sync step, not a webhook
New step 7d in `un1t-online-sync.js`, after the memberships, run only where `membership_source = 'un1t_online'`:

- Past-due set = `shapePastDue` (`membership/reads/un1t-online-shape.js:319`) over **this run's** fresh rows.
- Newly past due (a membership invoice open, not paused, not `cancel_at_period_end`) and `locations.dunning_auto_enroll` on → `maybeEnrolUn1tDunning`. Same sequence (`dunning_sequence_id`), `sourceType 'invoice_past_due'`, `allowReenrol`, idempotent on `invoice_id`.
- An active run whose `invoice_id` is now paid, forgiven or void → `exitDunningForContact(reason 'invoice_paid')`. That existing function already scopes to the run's invoice.
- Informational, like 6b: a failure is counted in `counts.dunning` and logged, never the run's status.
- Lag: up to 15 minutes either way, accepted (the Glofox webhook is near-instant).

### 3. Shared pieces made platform-aware
- `dunning.js` / `dunning-payment.js`: split the Glofox-only parts (`TROUBLE_COLUMNS`, `paymentTroubleKind`, pause check, `capturePaymentForRun`'s Glofox fetch) behind a `platform` switch. Add `src/lib/un1t-dunning.js` for the un1t versions built on the mirror. Glofox behaviour unchanged; its tests are the regression net.
- Presend gate (`dunningPresendGate`, `dunning-payment.js:192`): for un1t, re-read the mirror invoice (fresh rows only). Paid → exit with `invoice_settled_presend`. Unreadable → fail open, like Glofox.
- `CARD_UPDATE_WORDING` per platform: "update your card in the un1t.online app" at Hatch, operator-editable per the copy invariant.

### 4. WhatsApp template
- New Meta template **`outstanding_payment_link_un1t`**, URL button base `https://<customer host>/pay-link/{{1}}`. It needs Meta approval.
- `overdue_payment_dunning` (`sequence-templates.js:668`) picks the template by the location's membership source. The install check requires it APPROVED at Hatch.
- Until approval, the WhatsApp steps record a skip ('template not approved') and the emails still go.

### 5. Churn Radar
- Drop the 409 for `un1t_online` in the action route and add a un1t branch. It re-derives trouble from `shapePastDue` and never trusts the client. Crossover refusal (`PAYMENT_REMINDER_NOT_HOME`) kept.
- Show the button when the source is `glofox` or `un1t_online` (`ChurnRadar.jsx:260`).

### 6. Mia
- `un1t-tools.js` reminder tool: `has_reminder: true` with `sent_at` when an active run exists for the contact's open invoice. Prompt rule updated (`prompt.js:109-112`).
- Mia may send the member **our short link** for their run, never a Stripe URL. That is a read and a link, so the no-charge guard (`tests/mia-no-charge-no-refund-guard.test.js`) is unchanged.

### 7. No write-layer change in Phase 1
`GET /invoices/{id}` is a read through the existing read client. No `ENDPOINTS` entry, no `un1t_write_events` op, no migration for the op CHECK, no guard-test change.
One migration only if we choose a column over `metadata` for the token hash. Recommendation: keep it in `metadata` (FEES.3 used a column because appeals outlive runs; here a link dies with its run).

## Tasks (TDD, one PR)
1. `un1t-dunning.js`: trouble from `shapePastDue`, payment-for-run (token, hash, amount), presend check. Unit tests.
2. Platform switch in `dunning.js` / `dunning-payment.js`. Glofox tests unchanged and green.
3. Sync step 7d (enrol and exit), counts, never fatal. Sync tests on the existing fake.
4. `/pay-link/[token]` route + page, four allowlists, never logs or stores the URL. Tests: paid, unreachable, unknown token (404), Stripe URL never in a log or the response body.
5. Senders: template choice by source, wording per platform, WhatsApp skip until approved.
6. Radar: route branch + button. Route tests for the 409 removal and crossover refusal.
7. Mia tool + prompt.
8. Changelog, openapi entry for the public route, CLAUDE.md one-liner if a new invariant emerges.

Out of band: submit `outstanding_payment_link_un1t` to Meta (needs the final URL), then switch on `dunning_auto_enroll` at Hatch.

## Phase 2 (blocked on un1t.online)
Card-update links for a member whose card is expiring or missing **before** an invoice fails. These need `setup-requests` + `resend` callable by API token (today `x-api-token: false`). If un1t.online opens them, add the two POSTs to `ENDPOINTS` under a new op, with a migration for the op CHECK and the guard-test pins (the two-id `resend` path needs the pin helper widened). `DELETE` stays banned; an unused request simply expires.

## Decisions (Richard, 28 Oct 2026)
1. **un1t.online already emails failed payments.** So Hatch's chase is **WhatsApp only**, starting a day after the invoice fails so un1t.online's email lands first: a separate template `overdue_payment_dunning_un1t` (no email steps), installed as Hatch's dunning sequence.
2. **`retry-payment` is left out.** Paying the hosted invoice settles it; the CRM charges no card.
3. Phase 2 (card-update links) stays parked until un1t.online allows API tokens on `setup-requests` / `resend`.
