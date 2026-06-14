# Churn Radar — "Overdue" tab audit (2026-06-14)

**Status: findings + recommendations only. No code changed.** Review before we implement.

## TL;DR

The Overdue chase-list is driven by the **wrong Glofox signal**. It flags members whose
`glofox_membership_state = 'locked'` — a value read from Glofox's **stale, singular
`member.membership.status`** field, which Glofox's own spec and our prior GLOFOX2.1.9
finding both describe as the *initial/stale* membership reference, not the member's
current product.

Measured against the **authoritative** invoice data (which we already store):

| | today's live Overdue tab |
|---|---|
| Shown | **11** |
| Genuinely owe money (have a `PAST_DUE` invoice) | 8 |
| **False positives** (owe nothing) | **3** — incl. **Gareth Fox** |
| Real debtors **missing** from the tab (have `PAST_DUE`, not flagged) | **28** |
| Real debtors actually caught | **8 of 36 (22%)** |

So the tab shows people who don't owe money and hides most who do. Glofox exposes a correct
signal — **`PAST_DUE` invoices** — that we already ingest via the `INVOICE_UPDATED` webhook
but the Overdue tab never reads.

---

## 1. How the Overdue tab works today

Code path:

- `src/lib/churn-radar.js` → `classifyContact(contact)`: `if (state === 'locked') return 'overdue'`.
  `state` = `contact.glofox_membership_state`.
- `buildOverdue()` lists every `classifyContact() === 'overdue'` member, sorted by monthly value.
- `src/lib/churn-radar-data.js` → `loadOverdue()` → `/api/churn-radar/overdue` → the **Overdue** tab in `ChurnRadar.jsx`.
- The **"Unpaid N days"** chip = days since `contact.last_payment_at`.

Where the inputs come from in the Glofox sync (`src/lib/glofox-sync.js`):

- `glofox_membership_state` ← `extractMembershipState(member)` (line 686) ← **`member.membership.status`** (the singular object).
- `last_payment_at` ← `src/lib/glofox-invoices.js:164` — the most recent **paid** invoice date (i.e. *when they last paid*, not when a charge failed).

---

## 2. The Gareth Fox case (the smoking gun)

His synced row:

| field | value |
|---|---|
| `glofox_membership_status` | `credit_member` |
| `glofox_membership_type` | `num_classes` (a class pack) |
| `glofox_membership_plan` | **"10 Class Pack"** |
| `glofox_billing_interval` | **null** (no recurring charge) |
| `trial_credits_remaining` | **21** |
| `last_attended_at` | 2026-06-11 (**3 days before the sync**) |
| `last_payment_at` | 2026-05-26 (≈18 days before — when he **bought** the pack) |
| `glofox_membership_state` | **`locked`** |
| `glofox_synced_at` | 2026-06-14 (today — fresh) |

→ He lands in Overdue as **"Unpaid 18 days."**

**His authoritative invoices: 4 PAID + 4 FORGIVEN, ZERO PAST_DUE.** He owes nothing — exactly
what you saw on his Glofox profile. A locked membership can't book/attend per Glofox's own
rules (`CANNOT_BOOK_DUE_TO_MEMBERSHIP_BEING_LOCKED`), yet he attended 3 days ago and holds 21
credits.

---

## 3. Root cause — three compounding faults

1. **Stale signal.** `member.membership` (singular) is the initial/stale membership reference,
   *not* the member's current product. Glofox spec `UserMembership` (line ~4993): the
   "current" states are `ACTIVE / LOCKED / PAUSED`. Our own **GLOFOX2.1.9** note already says
   this exact field "returns a stale/initial reference (the trial pack), not the user's current
   product" — which is why credit-member detection was moved to the `/2.0/credits` +
   `/2.0/memberships` endpoints (Plan A). The Overdue tab never got that memo: it still trusts
   `membership.status`. Even a fresh re-pull (`/2.0/members/{id}`) returns the same stale status.

2. **Category error: class packs can't be "overdue."** A `num_classes` pack is paid **upfront** —
   there is no recurring charge to fall into arrears on. Per spec (line 5002), a pack's live
   state is its **credit balance** (`/2.0/credits`), which we already store as
   `trial_credits_remaining`. `membership.status` is not a payment signal for a pack. Gareth has
   21 credits → live, paid, owes nothing.

3. **Wrong "days unpaid" metric.** The chip counts from `last_payment_at` = the member's *last
   successful* payment (or, for a pack, the purchase date). "Owes money for 18 days" actually
   means "paid 18 days ago." The real arrears clock should start at the **failed charge /
   past-due invoice due date**.

---

## 4. The correct signal — and we already have it

Glofox does NOT expose a "get outstanding balance" pull endpoint. Arrears come through two
authoritative channels, both of which we already receive:

- **`INVOICE_UPDATED` webhook → `glofox_invoices` table.** Statuses: `PAID / PAST_DUE / PENDING /
  FORGIVEN`. Spec (line 7450): **`PAST_DUE` = "the payment attempt failed and the invoice
  remains unpaid"** — the exact "this member owes money" signal.
- **Payments report (`POST /2.0/payments`)** carries `SUBSCRIPTION_CYCLE_PAYMENT_FAILED` (spec
  line 6530) — corroborating signal for a failed recurring charge.

**Freshness check (done):** `glofox_invoices` is current — 44 `PAST_DUE` invoices, newest
2026-06-13, table last updated 2026-06-13 23:55 via the live webhook. (Backfill base date
2026-05-13.) Usable today, with one caveat in R4 below.

**The two cohorts barely overlap** (raw `locked` vs `PAST_DUE`):

- 18 `locked` → only **8** have a `PAST_DUE` invoice (true positives); **10 owe nothing** (false positives).
- **36** contacts have a `PAST_DUE` invoice; only 8 are `locked`. **28 real debtors are missed.**

Today's live tab (after CHURN-CLEAN.1 cleared the spent packs) = 11: the 3 false positives are
**Gareth Fox** (class pack), **Laura Mulvaney** (Post Natal), **Margaret Lord** (Elite).

---

## 5. Recommendations (for review — nothing applied)

**R1 — Immediate, low-risk: class packs can never be "overdue."**
Exclude `num_classes` from the overdue branch in `classifyContact` / `buildOverdue`. A pack is
paid upfront; `membership.status='locked'` on a pack is meaningless. Fixes **Gareth** instantly.
~2 lines + tests. Safe to ship on its own.

**R2 — The real fix: drive Overdue off open `PAST_DUE` invoices, not `membership.status='locked'`.**
Add a per-contact "has an open past-due invoice" signal (denormalised `contacts` column kept in
sync by the `INVOICE_UPDATED` webhook, mirroring how `email_marketing`/`pipeline_stage_slug`
are denormalised — avoids a fragile join in the radar). Overdue = that flag is true. This drops
the 3 false positives **and** surfaces the 28 missed debtors. Keep `membership.status='locked'`
at most as a *secondary* corroborating hint, never the driver.

**R3 — Fix the metric + show the real number.**
Replace "Unpaid N days" (from `last_payment_at`) with days since the **past-due invoice's due
date**, and show the **amount actually owed** (sum of the contact's open `PAST_DUE` invoice
amounts) instead of "days since last payment."

**R4 — Confirm invoice freshness before making `PAST_DUE` the sole driver.**
Edge case spotted: Rachael Clarke shows a `PAST_DUE` invoice **and** a payment dated today +
attendance today — she's probably just cleared it and the `→ PAID` webhook hasn't landed (or is
a different cycle). Two safeguards: (a) suppress a `PAST_DUE` invoice if a payment/PAID invoice
post-dates it; (b) do a one-time `glofox_invoices` re-sync + spot-check (ties into the existing
"glofox_invoices is stale" backlog item) so we trust the table before it drives dunning.

**R5 — Related blast radius: the `membership_state_change` sequence trigger.**
The same unreliable `glofox_membership_state` field powers the `membership_state_change` sequence
trigger (active/paused/**locked**) used for dunning/win-back. If the field flaps on stale data,
those sequences mis-fire. Re-evaluate that trigger once the signal is fixed (probably re-key the
dunning trigger off the same past-due-invoice signal).

---

## 6. Open questions for Richard

1. Make Overdue **invoice-driven** (R2, recommended), or keep `membership.status=locked` as a
   secondary hint alongside it?
2. Show **amount owed** on each row (sum of open `PAST_DUE` invoices)? (R3)
3. OK to ship **R1 (exclude class packs)** immediately as a quick correctness fix while R2 is built?
4. Appetite for the **`glofox_invoices` re-sync** (R4) — it's a prerequisite for trusting the
   invoice signal end-to-end and is already on the backlog.

---

## Appendix — files involved

- `src/lib/churn-radar.js` — `classifyContact` (overdue branch), `buildOverdue`, `MEMBERSHIP_ENDED_STATES`.
- `src/lib/churn-radar-data.js` — `loadOverdue`.
- `src/lib/glofox-sync.js` — `extractMembershipState` (line 686, reads `member.membership.status`).
- `src/lib/glofox-invoices.js` — `glofox_invoices` ingest + `last_payment_at` derivation (line 164).
- `glofox_invoices` table — `status` ∈ {PAID, PAST_DUE, PENDING, FORGIVEN}; fed by the `INVOICE_UPDATED` webhook.
- Glofox spec (`openapi (1).yaml`): `UserMembership` (~4986), membership status enum (5012),
  `num_classes`/credits note (5002), invoice `PAST_DUE` (7450), payment `SUBSCRIPTION_CYCLE_PAYMENT_FAILED` (6530), `INVOICE_UPDATED` webhook (3938).
