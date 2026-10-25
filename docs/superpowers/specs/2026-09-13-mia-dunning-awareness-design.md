# Mia knows about the Pay now reminder — design

**Date:** 2026-09-13
**Status:** built (MIA-DUNNING.1)
**Follows:** PAYLINK (#1683), PRESEND.1 (#1684), DUNNING.1–.7 (#1502)

## Why

Overdue members now get a WhatsApp utility template `outstanding_payment_link_` ("Hi {{1}}, Garrett from UN1T here. Your membership payment of {{2}} didn't go through…") with a Pay now URL button to a hosted Glofox pay page, plus emails, over ~7 days. The run is a `sequence_enrollments` row with `source_type` in `TRANSACTIONAL_SOURCE_TYPES` and `metadata.payment = { invoice_id, link, amount, currency, … }`. The pre-send gate (`dunningPresendGate`) exits the run before the next send once Glofox no longer lists the invoice as overdue.

Members reply on WhatsApp and Mia answers. Until now her prompt said she had no billing standing and must hand off everything about payments, and she did not know a reminder existed. Richard's ask: "Agent aware of the new dunning process so it can reply correctly or handoff to a human."

## Design

### 1. Tool `get_my_payment_reminder` — `src/lib/agent/account-tools.js`

- In `ACCOUNT_TOOLS`, so `ACCOUNT_TOOL_NAMES`, `ALL_AGENT_TOOLS` and the auto-reply dispatch pick it up with no change to `auto-reply.js`.
- Verified-only: same `not_verified` refusal as `get_my_membership`.
- Read: newest `sequence_enrollments` row for the person's contact ids (`linkedAccountsForContact`; on `readFailed` the verified id alone) where `source_type IN TRANSACTIONAL_SOURCE_TYPES`, `order enrolled_at desc`, `limit 1`, any status. Columns: `id, contact_id, status, exit_reason, enrolled_at, metadata, source_type` — there is NO `created_at` on that table (ENROLFIX.1).
- Returns `{ has_reminder, status: 'active'|'completed'|'exited'|'none', amount, currency, pay_link, first_sent_at, exit_reason, still_overdue: true|false|'unknown' }`. amount/currency/link come from `paymentFromEnrollment(row)`; `first_sent_at` is `enrolled_at`; `pay_link` only when it is an `https://` link.
- `still_overdue` is a LIVE Glofox check via the run-owning contact's `glofox_member_id` and `glofoxCredentialsForLocation` → `getGlofoxOverdueInvoices(creds, { memberId })`, with the SAME inference rules as `dunningPresendGate`: invoice id present → `true`; `ok`, absent, and fewer than `GLOFOX_OVERDUE_INVOICES_PAGE_CAP` rows → `false`; no invoice id / no member id / no creds / `!ok` / list at cap → `'unknown'`.
- READ-ONLY: never exits or modifies the run. The pre-send gate does that before the next send, which is why "the reminders stop automatically" is a true statement.
- Never throws; a DB error returns `{ error }` written for the model (hand off), raw error in the log only.

### 2. Prompt — `src/lib/agent/prompt.js`

New `## Overdue payment reminders` section between the account section and pauses/cancellations:

- What the studio sends (WhatsApp + emails, Pay now button to a secure Glofox page, card update in the Glofox app); KNOWLEDGE wording wins for studio-specific facts.
- Reminder / failed payment / Pay now / "I've paid" / "why did I get this" → verify first, then call `get_my_payment_reminder` BEFORE answering.
- `has_reminder` false → never confirm a reminder was sent; hand off.
- `still_overdue` false → the payment has come through and the reminders stop automatically; thank them.
- `still_overdue` true and they say they've paid → a payment can take minutes to show; do NOT contradict them and do NOT say it is paid; hand off with amount + first_sent_at in the reason.
- `still_overdue` 'unknown' → never guess; hand off.
- Link not working / wants it again → send `pay_link` in plain text; no link → card update in the Glofox app; still stuck → hand off.
- Can't pay / more time / disputes amount / why it failed / refund / change plan → hand off. Cancel → existing cancellation flow.
- NEVER ask for or accept card numbers, expiry dates, CVV or bank details in chat; if sent, do not repeat them back, point to the secure link or app, hand off.
- The account-section billing line now carves out the reminder tool; everything else about billing/invoices still hands off.

### 3. Tests

- `src/lib/agent/account-tools-payment-reminder.test.js` — registry, unverified refusal, no row, marketing row ignored, still_overdue true/false/unknown across every branch, read-only (no `setEnrollmentStatus`), sibling contact holds the run, `readFailed` fallback, select contains no `created_at`, DB error → model-facing hand-off message.
- `src/lib/agent/prompt.test.js` — section heading and placement, tool name, outcome rules, no-card-details rule, amended billing line.
- `evals/agent/scenarios.js` — `payment-reminder-i-paid-still-overdue`: must call the tool and hand off.

## Not in scope (YAGNI)

- Mia never exits, refreshes or re-sends a reminder run.
- No new Glofox endpoints, no payment retry, no card update from chat.
