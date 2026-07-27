# Agent booking rejection → approval fallback

**Date:** 2026-07-27 · **Trigger incident:** Mia told Lucinda Kinghan "You're booked in" twice for SQUAD - CONDITIONING Tue 28 Jul 07:00 while Glofox rejected both attempts with HTTP 200 + `message_code: YOU_HAVE_NO_CREDITS_LEFT`. Same false-success hit Colm Keegan 2026-07-22.

## Problem

`book_class` (auto mode) and the approval-execution path judge Glofox booking success on `result.ok` (HTTP status) alone. Glofox returns failures **in-body with HTTP 200**. Consequences today:

1. Customer is told they're booked when they aren't (`{ booked: true }` returned to the model).
2. The audit row is finalised `actioned` (false success), though `details.result.message_code` does record the code.
3. No human ever hears about it — no approval, no alert.
4. The `/start` funnel processor (`class-booking-processor.js:134`) has the same latent bug (it pre-checks credits, so it rarely triggers).
5. No `glofox_booking_id` is stored for agent bookings, so they can't be reconciled against Glofox.

## Desired behaviour (Richard, 2026-07-27)

When Glofox rejects a booking for an account-shaped reason, the agent must NOT claim success. It creates a **pending approval** summarising the issue so a human fixes the account and completes the booking, and tells the customer, in words close to: *"There seems to be an issue with the account, handing this off to a human to resolve, you'll hear from them shortly once resolved."* Capacity/schedule rejections (class full, event cancelled) stay in-chat: Mia relays honestly and offers an alternative.

## Design

### 1. `interpretBookingResult(result)` — shared truth about a Glofox booking response

New export in `src/lib/glofox.js` beside `createBooking`. Input: `{ ok, status, body }`. Output: `{ success, bookingId, messageCode, alreadyBooked }`.

- `messageCode` = `body.message_code || body.message || null` (existing convention).
- `alreadyBooked` = `messageCode === 'YOU_HAVE_BOOKED_FOR_THIS_EVENT'` → **success** (precedent: `class-booking-processor.js:133`, Glofox dedupes server-side).
- `success` = `alreadyBooked || (ok && !KNOWN_FAILURE_CODES.has(messageCode))`.
- `bookingId` harvested best-effort: `body.id || body._id || body.booking_id || body.data?.id` (same as processor line 139).
- `KNOWN_FAILURE_CODES` (exported): codes Glofox is known to send inside a 2xx that mean the booking did NOT happen. Seed: `YOU_HAVE_NO_CREDITS_LEFT`, `EVENT_HAS_BEEN_CANCELLED`. Grows as codes are observed. Deliberately conservative: an *unknown* code inside a 2xx is treated as success — false "issue with your account" messages on benign success bodies are worse than the rare unknown failure code, which still lands in `details.result.message_code` for detection.

### 2. Failure routing (booking-tools.js, auto mode)

On `!success`, classify `messageCode`:

- `CUSTOMER_ANSWERABLE_CODES` = `EVENT_HAS_BEEN_CANCELLED` + future capacity/waitlist codes → current behaviour: finalise row `failed`, return `{ booked: false, reason, message: relay honestly + offer alternative }`.
- **Everything else** (incl. `YOU_HAVE_NO_CREDITS_LEFT`, non-2xx statuses, unknown reasons) → **approval fallback**:
  - Finalise the existing intent row to **`status: 'pending'`** (not `failed`) with `details`: `{ ...baseDetails, reason: 'booking_rejected', summary: <human sentence>, result: { ok: false, status, message_code } }` and the `stage: 'executing'` marker cleared. `summary` example: `"Glofox rejected this booking (YOU_HAVE_NO_CREDITS_LEFT). Fix the member's account (credits/membership), then Approve to retry the booking."`
  - **Dedup:** before finalising to pending, look up another `pending` `class_booking` row for the same `contact_id` + `details.event_id` (same query shape as `routeToReview`, `class-booking-processor.js:28-30`). If one exists, finalise the current intent row as `declined` with `decision_note: 'superseded duplicate'` and still return the handoff message — Lucinda's double-call must produce ONE approval, not two.
  - Tool returns `{ requested: true, booked: false, reason, message: 'There is an account issue the team needs to fix. Tell the customer, close to this wording: "<handoff copy>". Never say the booking is confirmed.' }`.

### 3. Approval side (no new UI)

The pending row surfaces through the existing agent-requests provider. **Approve** re-runs the booking via the existing execution branch in `membership-requests/[id]/route.js:224-301` — which also adopts `interpretBookingResult`, so approving a still-broken account finalises `failed` instead of falsely `actioned`. Staff workflow: fix the account in Glofox (or grant credit/decide), then Approve; the existing code already sends the customer the in-thread booking confirmation on success. The existing `needs_credit_grant` auto-grant branch is untouched (it's the /start-funnel new-lead path; agent-side rejections must stay a human decision — the customer may have used their trial, as in the trigger incident).

### 4. Customer copy — operator-editable

New nullable setting `locations.settings.customer_agent.booking_issue_handoff_text` (max 500), following the `booking_confirmation_text` pattern exactly (`api/settings/customer-agent/route.js` DEFAULTS + zod + persist; input in `settings/customer-agent/page.js`). Default (code fallback, no em-dashes): `"There seems to be an issue with your account, so I'm handing this over to the team to sort it out. You'll hear from them shortly once it's resolved."`

### 5. Same treatment for `cancel_class` — NO (out of scope)

`cancelBooking` failures are usually policy (late cancellation), already relayed honestly; no incident evidence of in-body 200 failures. Not touched.

### 6. Hardening in passing

- `logBookingRequest` (`booking-tools.js:379-388`): check the destructured `error` (supabase-js resolves errors, doesn't throw) and `console.error` loudly; still return null (best-effort stays best-effort, but visible).
- Auto-mode success details gain `glofox_booking_id` from the interpreter.
- `class-booking-processor.js:128-140` switches to `interpretBookingResult` (fixes its latent 200-failure bug; behaviour otherwise identical).

### 7. Testing

Vitest, mocked DB/Glofox (existing patterns in `booking-tools.test.js` / `booking-tools-audit.test.js`):
- `interpretBookingResult` unit table: 200+bookingId → success; 200+NO_CREDITS → failure; 200+ALREADY_BOOKED → success; 500 → failure; body-shape variants for bookingId.
- Auto book_class: 200+NO_CREDITS → row finalised `pending` with summary, return carries handoff message, `booked` not true.
- Dedup: second rejection for same contact+event → `declined` row, single pending remains.
- Customer-answerable code → row `failed`, honest reply (existing behaviour pinned).
- Success → `glofox_booking_id` persisted, `actioned`.
- Approval route: rejected re-run → `failed` (not `actioned`).
- Settings route round-trips `booking_issue_handoff_text`.

## Out of scope

- Untangling Lucinda's three duplicate contacts / wrong Glofox identity (separate data task; see memory `agent-dupe-phone-reauth`).
- Event bookings (`event-tools.js` uses a different result shape `{ ok, reason }`; audit separately).
- Notifying staff beyond the approvals inbox badge (no push/email alert here).
