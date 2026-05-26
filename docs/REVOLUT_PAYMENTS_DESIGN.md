# Authorised Supplier Payments via the Revolut Business API — Design

**Status:** Proposal / pre-build design. No work committed.
**Author:** drafted for Richard, May 2026.
**Related:** the invoice ingest (`INVOICES.1` / `INVOICES-QUEUE.1`), the Xero
push (`XERO-API.*`), the Xero paid-status webhook (`XERO-WEBHOOK.1`).

---

## Status & resume notes

> Keep this section live — update it as the doc gets reviewed and as decisions
> land. It's the "where are we" snapshot for whoever picks this back up.

**Current state:** under review by Richard. No code, no schema, no credentials
yet. The doc captures the intended shape; nothing has been done.

**Decision already made:**
- Use the **payment-draft model** (§4), not direct `POST /pay`. The CRM
  assembles the payment; a human approves the money movement in the Revolut
  Business app.

**Open decisions blocking build (from §10):**
- [ ] Connection scope — one Revolut Business connection per **location**, or
      per **org**? (UN1T locations currently share a Xero org under "Champ
      Fitness Ltd"; Revolut may follow the same pattern.)
- [ ] Approval workflow in Revolut — who approves, and is dual control
      required (CRM initiator ≠ Revolut approver)?
- [ ] Counterparty creation policy — let operators add payees from inside the
      CRM, or only **select** counterparties pre-created in Revolut?
      Recommendation in §10: select-only for v1 (safer).
- [ ] Re-consent cadence — confirm with Revolut, then design the reminder.

**Suggested next step when work resumes:**
1. Settle the four open decisions above.
2. Generate the X.509 cert + upload the public key in Revolut Business
   (sandbox first).
3. Start phase 1 (§9): auth + `revolut_business_connections` + Settings
   "Revolut" tab. Largest of the four PRs.

**Reviewer notes (free-form):**
- _Add observations / questions / counter-proposals here as you read._

---

## 1. Goal

Let an operator pay a supplier invoice from inside the CRM: pick the
Revolut account to pay from, pick the payee, confirm amount + reference,
and submit — with the actual money-movement **authorised by a human in
Revolut**, not by a raw click in the CRM.

This closes the last gap in the accounts-payable loop:

> invoice emailed in → extracted → coded → pushed to Xero as a bill →
> **paid via Revolut** → paid status synced back to both the CRM and Xero.

## 2. Background — what already exists

- **Inbound payments** use the Revolut **Merchant API** (`src/lib/revolut.js`)
  — car deposits and race payments. Static bearer key. This is a
  *different API* and **cannot move money out**; none of it is reusable
  here beyond general webhook-signature know-how.
- The **invoice ingest** already holds, per bill: the supplier, the
  amount, the invoice number, the original PDF, and (after
  `SUPPLIER-MEMORY.1`) a learned supplier identity. A payment feature is
  a natural extension of an `invoices_queue` row — most of the payment
  payload is already on hand.
- The CRM already runs **signed webhooks** (Postmark, Twilio, Xero,
  Revolut Merchant) and has an **audit-events** table (`AUDIT-EXPAND.1`)
  and a **`bookkeeper`** permission (`INVOICES-QUEUE.1`).

## 3. Scope

**In scope:** paying *supplier bills that already exist in the invoice
queue*, from a connected Revolut Business account, via a human-approved
payment draft, with the paid result synced back.

**Out of scope (v1):** ad-hoc payments unrelated to an ingested invoice;
payroll; bulk pay runs; FX/cross-currency optimisation; paying from
non-Revolut accounts.

## 4. Chosen approach — payment **drafts**, not direct pay

The Revolut Business API offers two ways to move money:

| | Direct payment (`POST /pay`) | **Payment draft (`POST /payment-drafts`)** |
|---|---|---|
| Behaviour | Money moves immediately on the API call | Creates a draft that lands in Revolut Business "Pending review" |
| Authorisation | None beyond the CRM's own UI | A designated approver **approves it in the Revolut Business app** |
| Audit trail of the release | CRM only | Revolut's own, plus the CRM's |
| SCA / PSD2 burden | Leans on the CRM | Stays inside the bank's app |
| Risk | A bug or bad click = money gone | A human in the bank reviews payee + amount before release |

**Decision: use the payment-draft model.** The CRM *assembles and stages*
the payment from invoice data it already has; Revolut remains the place
money is actually authorised. This is what makes it an *authorised
payment flow* rather than a "click → funds gone" flow. It also keeps the
regulatory authentication burden on Revolut.

Direct `POST /pay` is deliberately **not** used in v1. It can be revisited
later for trusted, low-value, repeat payments if there's appetite — but
only as an explicit follow-up decision.

## 5. User flow

1. Operator opens a bill in `/invoices` that has been pushed to Xero.
2. Clicks **Prepare payment**.
3. The CRM shows a payment form, pre-filled from the invoice:
   - **Pay from** — dropdown of the location's Revolut Business accounts.
   - **Payee** — the matched Revolut *counterparty* (see §7.2). If the
     supplier has no counterparty yet, the operator adds one (bank
     details) — a deliberate, audited, one-time step per supplier.
   - **Amount** — pre-filled from the invoice total, editable.
   - **Reference** — pre-filled with the invoice number.
   - The original invoice PDF is shown for reference (it already lives
     in the CRM; it is **not** sent to Revolut — the API has no
     attach-document concept).
4. Operator reviews a clear confirmation (amount, payee, account) and
   clicks **Send for approval**.
5. The CRM creates a **payment draft** in Revolut. The bill is marked
   *Payment pending approval* in the CRM.
6. A designated approver opens the **Revolut Business app**, reviews the
   draft, and approves it. Revolut executes the transfer.
7. Revolut fires a **webhook** (`TransactionStateChanged`); the CRM
   marks the bill **Paid** and records the date/amount. Xero's own
   webhook (`XERO-WEBHOOK.1`) independently flips the Xero bill to paid
   once reconciled.

## 6. Why this is feasible

The Revolut Business API exposes everything the flow needs: list
accounts, manage counterparties (payees), create payment drafts with a
built-in approval workflow, and webhooks for the result. The hard parts
are **auth setup** and **doing it safely** — not missing capability.

## 7. Architecture

### 7.1 Authentication (the heaviest part of the build)

The Business API uses OAuth 2.0 with a **JWT client assertion signed by
an X.509 certificate**:

1. Generate a key pair + certificate; upload the public key in the
   Revolut Business dashboard.
2. A human **consents to the app** inside Revolut Business → yields an
   authorisation code.
3. Exchange the code (with a signed client-assertion JWT) for an
   `access_token` (~40 min lifetime) + a `refresh_token`.
4. Refresh as needed. **Refreshing invalidates the previous access
   token** — token storage must be single-writer and careful.

Scopes: `READ`, `WRITE` (counterparties/webhooks), `PAY` (initiate/cancel
transactions). This feature needs all three.

Operational notes:
- Build and test against the **Revolut Business Sandbox**
  (`sandbox-b2b.revolut.com`) — it can simulate transfer state changes.
- The authorisation requires **periodic human re-consent** (confirm the
  exact cadence with Revolut — historically ~90 days). Plan an admin
  reminder + a clear "reconnect Revolut" path, like the Xero reconnect.
- This is materially more complex than the Merchant API's static key and
  is the single biggest piece of the build.

### 7.2 Data model (new)

- **`revolut_business_connections`** — per location (or per org): the
  certificate reference, `access_token`, `refresh_token`, `expires_at`,
  consent metadata. Service-role only, encrypted at rest, never
  client-exposed. Mirrors `xero_connections` in spirit.
- **`revolut_counterparties`** — cache of payees pulled from Revolut,
  plus a **`supplier ↔ counterparty` mapping** (which Xero contact /
  ingested supplier maps to which Revolut counterparty). Same shape of
  idea as `xero_supplier_defaults`.
- **`supplier_payments`** — one row per payment draft the CRM creates:
  the `invoices_queue` row it pays, the Revolut draft/transaction id,
  amount, account, counterparty, state (`drafted` → `pending_approval`
  → `completed` / `declined` / `failed`), timestamps, who initiated it.

### 7.3 CRM API surface (new)

- `GET  /api/locations/[id]/revolut/accounts` — list pay-from accounts.
- `GET  /api/locations/[id]/revolut/counterparties` — list payees.
- `POST /api/locations/[id]/revolut/counterparties` — add a payee
  (bank details). Tightly gated + audited.
- `POST /api/invoices-inbox/[id]/pay` — create the payment draft for a
  bill. Server re-validates amount/account/counterparty.
- OAuth connect/callback routes for the Revolut Business consent flow.
- Settings UI: a "Revolut" tab to connect the account (alongside Xero).

### 7.4 Revolut endpoints used

`GET /accounts`, `GET/POST /counterparty`, `POST /payment-drafts`,
`GET /payment-drafts/{id}`, webhooks (`POST /webhooks`). All payment
calls carry an **idempotency key** so a retry can never double-pay.

### 7.5 Payment confirmation loop

A Revolut Business **webhook (v2)** subscribed to `TransactionCreated` +
`TransactionStateChanged` tells the CRM when an approved draft executes
(or fails). The handler verifies the Revolut signature (the existing
`verifyWebhookSignature` HMAC pattern), matches the transaction to a
`supplier_payments` row, and updates its state — flipping the bill to
**Paid** in `/invoices`. Revolut retries failed deliveries 3× at 10-min
intervals.

## 8. Security & compliance

This feature **moves real money** — it gets a higher bar than anything
shipped so far.

- **Approval stays in Revolut.** The CRM never executes a payment; it
  only drafts one. A human releases it in the bank's app. This is the
  core safety property and the reason for the draft model.
- **Idempotency keys** on every payment call — a network retry must not
  create a second payment.
- **Tight gating.** Drafting a payment and (especially) adding a
  counterparty are restricted to `bookkeeper` / owner / master, and
  every such action writes an `audit_events` row.
- **Counterparty fraud is the main threat.** Saving a payee's bank
  details is the classic invoice-fraud vector (a spoofed "supplier
  changed bank details" email). Adding/editing a counterparty must be a
  deliberate, audited, ideally second-person-checked step — and the
  Revolut approver sees the payee before releasing funds.
- **Credential handling.** The Business API tokens can move money —
  treat them like the crown jewels: encrypted at rest, service-role
  only, never sent to the browser.
- **Confirmation UI.** Amount, payee and account are echoed back for
  explicit confirmation before a draft is created.
- **Sandbox first.** The entire flow is built and exercised against the
  Revolut sandbox before a single production credential exists.

## 9. Phasing

Suggested PR breakdown — sandbox-first throughout:

1. **Business API auth + connection** — certificate/JWT/OAuth machinery,
   `revolut_business_connections`, token refresh, a Settings "Revolut"
   connect tab. (Largest PR.)
2. **Accounts + counterparties** — list accounts, list/create
   counterparties, the supplier↔counterparty mapping + cache.
3. **Payment-draft creation + UI** — the "Prepare payment" form on a
   bill, `supplier_payments`, `POST .../pay`, idempotency, audit logging.
4. **Confirmation webhook** — Revolut Business webhook → `Paid` status
   in `/invoices`.

Each phase is independently shippable and testable in sandbox.

## 10. Open questions / decisions needed

- **Connection scope:** one Revolut Business connection per location, or
  one per org? (UN1T locations currently share a Xero org — Revolut may
  be similar.)
- **Who approves** in Revolut, and is the CRM initiator allowed to be
  the Revolut approver, or must it be a different person? (Recommend:
  different person — true dual control.)
- **Counterparty creation:** allow it in the CRM, or require payees to
  be pre-created in Revolut and only *selected* in the CRM? (Selecting
  only is the safer v1.)
- **Re-consent cadence** — confirm with Revolut and design the reminder.
- Production access timeline — sandbox build can start immediately;
  production needs the live certificate + consent.

## 11. Effort

Materially larger than the Xero pieces. The auth/cert/token machinery
(phase 1) alone is a substantial PR; phases 2–4 are moderate. Plus
non-code work: certificate generation, Revolut Business app
configuration, the consent step, and agreeing the approval workflow.
Realistically a multi-week effort spread over the four PRs, with
deliberate sandbox testing before any production credential is issued.

## 12. Risks

| Risk | Mitigation |
|---|---|
| A bug moves money wrongly | Draft model — a human approves in Revolut; nothing auto-executes |
| Double payment on retry | Idempotency keys on every payment call |
| Invoice-fraud / wrong payee | Audited counterparty management; Revolut approver sees payee; consider second-person check |
| Token leak | Encrypted at rest, service-role only, never client-exposed |
| Auth consent lapses silently | Monitored expiry + a clear "reconnect Revolut" path |
| Webhook missed | Reconcile by polling `GET /payment-drafts/{id}` as a backstop |

## 13. Recommendation

Feasible and a good strategic fit — it completes the AP loop. Proceed
**only** with: the payment-draft model (CRM assembles, Revolut
authorises), sandbox-first, tightly gated and audited. The CRM should
never be the final authoriser of money movement. Confirm the §10
decisions before phase 1.

## References

- [Revolut Business API — overview](https://developer.revolut.com/docs/business/business-api)
- [Payment drafts](https://developer.revolut.com/docs/guides/manage-accounts/transfers/payment-drafts)
- [Create a payment draft](https://developer.revolut.com/docs/business/create-payment-draft)
- [Create a counterparty](https://developer.revolut.com/docs/guides/manage-accounts/counterparties/create-a-counterparty)
- [Get the access token](https://developer.revolut.com/docs/guides/build-banking-apps/get-started/get-access-token)
- [Webhooks (v2)](https://developer.revolut.com/docs/business/webhooks-v-2)
- [Set up the Revolut Sandbox](https://developer.revolut.com/docs/guides/manage-accounts/get-started/prepare-sandbox-environment)
