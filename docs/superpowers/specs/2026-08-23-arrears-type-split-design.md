# Arrears tabs split by charge type — design

**Date:** 2026-08-23 · **Status:** approved (Richard, 2026-08-23) · **Ticket prefix:** ARREARS-TYPE

## Problem

The churn radar's three arrears tabs route a member by **amount**: an open
`PAST_DUE` total of €50 or more goes to **Overdue**, less than €50 goes to
**Unpaid charges**, and `PENDING` goes to **Awaiting authorization**
(`bucketArrears`, `src/lib/churn-radar.js`). The €50 line was a proxy for
"is this a failed membership renewal or a small fee?". The proxy is wrong in
both directions: a €380 failed class-pack purchase is not a membership debt
but lands in Overdue, and a failed €25 renewal would land in Unpaid charges.

Richard's rule (2026-08-23): **Overdue shows failed membership payments
only; Unpaid charges is every other failing transaction; anything awaiting
authorization stays out of both.**

A second, older defect surfaced while verifying how Glofox categorises
transactions. The invoice in Richard's screenshot (`8e04230d…`, €467, shown
in Glofox as "Client confirmation required: Custom Charge / Awaiting
authorization") is stored locally as `PAST_DUE`. The Glofox TransactionsList
report carries it as `transaction_status: "PENDING_INTENT"`,
`status: "pending authorization"`, `paid: false`. `isPendingTxn`
(`src/lib/glofox-arrears.js`) only recognises `PENDING`, so the June backfill
wrote it as a debt and the nightly reconcile never proposes the
`PAST_DUE → PENDING` correction that AWAITING-AUTH.2 built for exactly this.
Probed live: at least three of the six large "Membership"-described custom
charges (€467, €447, €398) are this case. All six are sitting in Overdue.

## How Glofox categorises a transaction (verified live, Stillorgan)

Invoice webhook (`glofox_invoices.line_item_subtypes`, from
`line_items[].sub_type`; the parent `line_items[].type` is in `raw_payload`):

| `type / sub_type` | Meaning | Open `PAST_DUE` on 2026-08-23 |
|---|---|---|
| `MEMBERSHIPS / SUBSCRIPTION_RENEWAL` | recurring membership billing ("Subscription Renewal") | 8 rows, €1,870 |
| `MEMBERSHIPS / SUBSCRIPTION_PAYMENT` (+ a €0 `UPFRONT_PAYMENT` line) | first payment at membership signup | 0 |
| `MEMBERSHIPS / UPFRONT_PAYMENT` alone | class packs, credits, trials — one-off purchases | 7 rows, €1,070 |
| `CUSTOM_CHARGES / CUSTOM_CHARGE` | late-cancel / no-show fees, staff-created custom charges | 2 rows, €10 |
| `CLASSES / BOOK_CLASS`, `PRODUCTS / BUY_PRODUCT`, `WALLET_TOP_UP` | PAYG booking, gift voucher, wallet | 0 |

The 21 rows the June backfill created (`raw_payload.source =
'reconcile-arrears'`) have no line items. They carry the report's
`metadata.glofox_event` as `raw_payload.candidate.glofoxEvent`: 19
`custom_charge`, 1 `buy_product`, 1 `book_class`. The report's event
vocabulary seen live: `subscription_payment`, `subscription_payment_failed`,
`invoice_payment` (signup invoices, trials), `custom_charge`, `book_class`,
`book_time_slot`, `buy_product`, `wallet_top_up`.

The word "Membership" on the screenshot is the **free-text description**
staff typed when creating the custom charge. Glofox's own category is in the
title: Custom Charge.

## Design

### 1. Classify each `PAST_DUE` invoice as membership or not

New pure helper in `src/lib/glofox-arrears.js`, beside `isCustomChargeFee`:

```js
export const MEMBERSHIP_LINE_SUBTYPES = ['SUBSCRIPTION_RENEWAL', 'SUBSCRIPTION_PAYMENT', 'PRORATE', 'NON_SUFFICIENT_FUNDS']
export const MEMBERSHIP_REPORT_EVENTS = ['subscription_payment', 'subscription_payment_failed']

isMembershipInvoice({ line_item_subtypes, glofox_event }) → boolean
```

- `line_item_subtypes` (webhook rows) containing any `MEMBERSHIP_LINE_SUBTYPES`
  token → membership. `UPFRONT_PAYMENT` on its own is a one-off purchase,
  never membership. `PRORATE` / `NON_SUFFICIENT_FUNDS` are the spec's other
  recurring-plan sub_types; unseen live, included so a plan change or a
  bounced direct debit is not misrouted when one appears.
- otherwise `glofox_event` (backfilled rows, read from
  `raw_payload->candidate->>glofoxEvent`) in `MEMBERSHIP_REPORT_EVENTS` →
  membership.
- no signal at all → not membership. Zero such rows today; a new row always
  arrives via the webhook with line items.

Decisions taken with Richard:
- **Failed class-pack purchases → Unpaid charges.** Glofox files them under
  `MEMBERSHIPS` but they are one-off purchases, not renewals.
- **Custom charges → Unpaid charges, whatever the description says.** The
  description is free text and is not parsed.
- **Failed first payment at signup (`SUBSCRIPTION_PAYMENT`) → Overdue.** It is
  a membership payment that failed. None open today; a one-constant change
  if the operator wants it moved.

### 2. `fetchPastDue` aggregates per kind

`src/lib/churn-radar-data.js` `fetchPastDue(db, locationId)` selects
`line_item_subtypes` and `glofox_event:raw_payload->candidate->>glofoxEvent`
for `PAST_DUE` rows and returns:

```js
{
  ids,            // Set<contactId> — every contact with ANY open PAST_DUE (unchanged)
  byId,           // Map<contactId, agg> — all PAST_DUE (unchanged; drives classifyContact + P2-7)
  pendingById,    // Map — PENDING (unchanged)
  membershipById, // Map — PAST_DUE membership invoices only
  chargesById,    // Map — PAST_DUE everything else
}
```

`agg` stays `{ amountCents, count, oldestDueAt }`. The ±1-day retry netting
runs before aggregation on all open rows, as today. A contact with a failed
€199 renewal and a failed €10 fee gets €199 in `membershipById` and €10 in
`chargesById` (and €209 in `byId`).

`ids`/`byId` keep their meaning so nothing downstream moves: the "overdue"
pill, the at-risk exclusion, the profile arrears figure, the person aggregate
and the P2-7 engagement analytics all still mean "has any open `PAST_DUE`".

### 3. `bucketArrears` routes by kind, not amount

```js
bucketArrears({ membershipById, chargesById, pendingById })
→ { overdueById, unpaidById, awaitingAuthById }
```

- `overdueById` = `membershipById` entries with `amountCents > 0`
- `unpaidById` = `chargesById` entries with `amountCents > 0`
- `awaitingAuthById` = `pendingById` entries with `amountCents > 0`

`OVERDUE_MIN_CENTS` and `splitArrears` are deleted with their tests; nothing
else imports them. Both call sites (`loadRadar` summary badges,
`loadArrearsRows` tab lists) pass the `fetchPastDue` result.

### 4. `isPendingTxn` recognises Glofox's awaiting-authorization values

```js
t.transaction_status === 'PENDING' || t.transaction_status === 'PENDING_INTENT'
|| t.status === 'PENDING' || t.status === 'pending' || t.status === 'pending authorization'
```

Effects, all through existing code paths:
- `computeArrears` (the one-off backfill route) writes such a charge as
  `PENDING`, not `PAST_DUE`.
- `indexReportByInvoice` flags it `pending`; `reconcileOpenPastDue` proposes
  `restatus → PENDING` for a local `PAST_DUE` row with no failed attempt. An
  invoice with any failed attempt still stays a debt (`v.failed` guard).
- The nightly cron's writes are unchanged: it still only clears
  settled/forgiven/aged rows. It now *reports* `restated > 0` in its JSON.

### 5. The correction is clickable from the browser

`GET /api/glofox/reconcile-fees` (master-only, dry-run by default) gains
`restatus=true`. With `commit=true&restatus=true` it passes
`allowRestatus: true` to `runArrearsReconcile`; without `commit` the dry-run
already lists the proposed re-statuses in `sample`/`byReason`. The cron route
keeps its own `?restatus=1` control and stays gated for scheduled runs.

Operator sequence after deploy (Stillorgan):
1. `/api/glofox/reconcile-fees?location_id=<loc>` — review `byReason.awaiting_authorization` and `sample`.
2. `/api/glofox/reconcile-fees?location_id=<loc>&commit=true&restatus=true` — apply.

### 6. UI copy

`src/components/ChurnRadar.jsx`: the three info banners and empty states stop
mentioning €50 and describe the new rule. Tab names are unchanged.

- Overdue: "Members whose membership payment failed — a subscription renewal
  or first payment Glofox could not collect. Amount owed is the sum of their
  open past-due membership invoices, highest first."
- Unpaid charges: "Failed one-off charges — late-cancel and no-show fees,
  custom charges, class bookings, class packs and products. Any amount."
- Awaiting authorization: unchanged.

Comments in `overdue`/`unpaid-charges` routes and `churn-radar-data.js`
updated to match.

### Expected result at Stillorgan (approximate, pre-netting)

| Tab | Before | After code | After code + correction |
|---|---|---|---|
| Overdue | 15 contacts / €4,934 | 7 / €1,870 | 7 / €1,870 |
| Unpaid charges | 13 / €180 | 23 / €3,244 | ~17 / ~€1,325 |
| Awaiting authorization | 41 / €3,240 | 41 / €3,240 | ~47 / ~€5,159 |

The weekly snapshot trend (`computeTrend`) will show a one-off step in the
Overdue count the first week; no code change.

## Out of scope

- Showing *which* line item failed on an Overdue row (the row shape carries
  no line-item detail). Possible follow-up.
- Ungating the cron's automatic re-status. Revisit after the first reviewed
  run.
- The `invoice_payment` report event (signup invoices) is treated as
  non-membership for backfilled rows; it cannot be told apart from a trial
  without metadata the backfill did not keep. Zero such rows exist.
- Mobile: the staff app reads only the summary counts; nothing to change.
- No migration.

## Testing

Vitest, pure functions and the chainable db mock already in
`churn-radar-data.test.js`:

- `isMembershipInvoice`: each sub_type; `UPFRONT_PAYMENT` alone → false;
  `SUBSCRIPTION_PAYMENT,UPFRONT_PAYMENT` → true; backfilled
  `glofox_event` cases; null/undefined → false.
- `bucketArrears`: membership → Overdue regardless of amount (€25 renewal);
  charge → Unpaid charges regardless of amount (€380 class pack); the same
  contact in both with separate amounts; pending untouched; zero-amount
  entries dropped.
- `fetchPastDue` via `loadOverdue`/`loadUnpaidCharges`/`loadRadar`: a
  webhook renewal, a webhook class pack, a backfilled `custom_charge` row, a
  mixed contact; summary counts match the tabs; `byId`/`ids` still include
  every `PAST_DUE` contact.
- `computeArrears`: a `PENDING_INTENT` / `"pending authorization"` charge is
  a `PENDING` candidate; pending-then-failed stays `PAST_DUE`.
- `reconcileOpenPastDue` via `indexReportByInvoice`: a `PENDING_INTENT` report
  row against a local `PAST_DUE` proposes `restatus`; with a failed attempt
  it keeps.
- `runArrearsReconcile`: `allowRestatus` writes the re-status for the
  `PENDING_INTENT` case.
- Existing €50-based tests rewritten to the new rule.

Post-deploy verification (GET-only against the Vercel preview, prod data):
the `reconcile-fees` dry-run must show `restated ≥ 3` with reason
`awaiting_authorization`; the Overdue tab must list only renewal debts.
