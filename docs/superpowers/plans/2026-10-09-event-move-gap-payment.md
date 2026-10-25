# Event move: pay the price difference (EVENT-MOVE.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can send the customer a payment link for a moved entry's price difference; when it is paid, the difference is settled as collected automatically. The same payment kind later carries the "pay the difference first" leg of customer self-service moves.

**Architecture:** A new payment kind, `race_payments.kind = 'move_gap'`, linked to the move row (`registration_move_id`). `createGapPayment` builds it through the same provider adapters and the same `/event-pay/[paymentId]` embedded checkout, with no platform fee and no `active_payment_id` change. The two payment webhooks already resolve any `race_payments` row by provider ref; `markRacePaymentStatus` gains a kind-aware branch so a completed gap payment settles the move (`gap_settled_how = 'collected'`) and sends a short receipt instead of the entry confirmation, and never re-runs entry side effects (registration status, sequences, tags, host list, Glofox). A staff route mints or reuses the link; the teams-page chip gains "Send payment link" (copy + email).

**Tech Stack:** Postgres (mig 710), Next.js 16 routes, Stripe Connect / Revolut adapters (unchanged), Postmark, React, vitest.

**Spec:** append the "Paying the gap (EVENT-MOVE.5)" section (Task 6) to `docs/superpowers/specs/2026-10-08-event-entry-move-design.md`.

**Worktree:** `~/code/un1t-crm-evmove6`, branch `event-move-gap-payment`, off `origin/main` AFTER #1953 (EVENT-MOVE.4) merged.

**Facts to rely on (from the survey; verify by reading):**
- `createRacePayment` (`src/lib/race-payments.js:74`) is entry-only: it overwrites `active_payment_id`, emits `RACE_REGISTERED`, and passes `idempotencyKey: registration.id` (Revolut sends it as a header; Stripe ignores it). Do NOT reuse it for the gap.
- `markRacePaymentStatus` (`:291-397`) on `completed`: flips `pending_payment → confirmed` (filtered, so a no-op for a confirmed entry), then host-list sync, `syncOrderFromRacePayment`, `ORDER_COMPLETED`, `applyTagRules`, `triggerSequencesForOrderStatus`. The webhooks then call `sendRaceConfirmations` when `applied.status === 'completed'`; the Revolut webhook also runs the Glofox push.
- Provider adapters: `paymentsFor(name).createPayment({ amountCents, currency, description, returnUrl, cancelUrl, metadata, idempotencyKey, connectedAccountId, applicationFeeCents })`; Stripe builds one line item named `description` plus a "Booking fee" line when the fee > 0.
- `/event-pay/[paymentId]` (`RaceCheckoutPage.jsx`) reads `GET /api/public/event-payments/[id]`, mounts the embedded checkout, and redirects to `/event/<slug>/confirmed?registration=<id>` on completion.
- `race_payments` has no `kind`; statuses `pending|completed|failed|abandoned|refunded`; `registration_moves` has `price_gap_cents`, `gap_settled_at/how/by_name` (migs 708/709).
- Customer-facing copy must be operator-editable: follow the `moved_email_subject/intro` pattern (`resolveEventEmail({ kind })` reads `race[`${kind}_email_subject`]`).

---

### Task 1: Migration 710

**Files:** Create `supabase/migrations/710_race_payments_kind_move_gap.sql`

```sql
-- 710 — EVENT-MOVE.5: a payment can be the PRICE DIFFERENCE of a move.
--
-- WHY. A move never moves money (mig 708); the difference was recorded (709)
-- and collected by hand. Staff now send a payment link for it, and a customer
-- moving themselves (EVENT-MOVE.6) pays it before the move lands. Such a
-- payment must not be mistaken for an entry payment: it must not re-send the
-- entry confirmation, re-enrol sequences, push to Glofox, or become the
-- registration's active payment.
--
-- WHAT. race_payments.kind ('entry' | 'move_gap', default 'entry' for every
-- existing row) and registration_move_id (the move a gap payment settles when
-- it completes). Two operator-editable copy columns on race_events for the
-- "pay the difference" email, same pattern as mig 385/708. Safe to apply
-- before the code deploys (every existing row is an 'entry').

alter table public.race_payments
  add column if not exists kind text not null default 'entry',
  add column if not exists registration_move_id uuid references public.registration_moves(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'race_payments_kind_check') then
    alter table public.race_payments
      add constraint race_payments_kind_check check (kind in ('entry', 'move_gap'));
  end if;
end
$$;

create index if not exists race_payments_registration_move_idx
  on public.race_payments (registration_move_id) where registration_move_id is not null;

comment on column public.race_payments.kind is 'EVENT-MOVE.5 — entry (the ticket) | move_gap (the price difference of a move; never re-runs entry side effects).';
comment on column public.race_payments.registration_move_id is 'EVENT-MOVE.5 — for kind=move_gap: the move this payment settles on completion.';

alter table public.race_events
  add column if not exists gap_email_subject text,
  add column if not exists gap_email_intro text;

comment on column public.race_events.gap_email_subject is 'EVENT-MOVE.5 — subject of the "pay the difference" email; NULL = default.';
comment on column public.race_events.gap_email_intro is 'EVENT-MOVE.5 — intro copy of the "pay the difference" email; NULL = default.';
```

- [ ] Write it; run `npm test -- tests/table-default-acl-guard.test.js tests/migration-708-registration-moves.test.js`; commit `EVENT-MOVE.5 — mig 710: race_payments.kind (entry | move_gap), registration_move_id, gap email copy`.

---

### Task 2: `createGapPayment` + kind-aware completion

**Files:**
- Create `src/lib/race-gap-payment.js` (+ test)
- Modify `src/lib/race-payments.js` (`markRacePaymentStatus`: kind branch; the `race_payments` selects that feed it must include `kind, registration_move_id`)
- Modify `src/app/api/webhooks/stripe/route.js` and `src/app/api/webhooks/revolut/race-payments/route.js` (confirmation + Glofox only for `kind === 'entry'`; gap receipt for `move_gap`) + their tests
- Modify `src/lib/race-confirmations.js` (`sendGapPaidEmail`, `buildGapDefaults`; `sendRaceConfirmations` skips non-entry rows with `skipped: 'kind=move_gap'`) + test
- Modify `src/lib/event-email.js` JSDoc kinds; `src/app/api/events/[id]/route.js` + `src/app/api/events/route.js` schemas/selects/insert for `gap_email_*`; `RaceEventForm.jsx` Emails section gains a fourth `EventEmailFields` block "Pay the difference" (`showTemplate={false}`, extra tags `{{difference}}`, `{{old_event_name}}`)

`createGapPayment({ db, move, registration, race, returnUrl, cancelUrl })`:
- Preconditions (return `{ ok:false, error }`): `move.registration_id === registration.id`; `move.to_event_id === registration.race_event_id`; `move.price_gap_cents > 0`; `!move.gap_settled_at`. If a `race_payments` row with `kind='move_gap'`, `registration_move_id = move.id`, `status='pending'` already exists, return it (`reused: true`) instead of minting another (Revolut's idempotency key is `move:${move.id}` anyway).
- Provider: `resolveEventHost(race)` → `resolvePaymentProvider(host)`; same `hostCanTakePayments` guard as entry payments. `applicationFeeCents: 0` (the per-ticket platform fee was taken on the entry). `description: \`${race.name} — price difference\``. `metadata: { race_event_id, race_registration_id, registration_move_id, domain: 'un1t_race_gap' }`. `connectedAccountId` as for entries.
- Insert `race_payments` with `kind:'move_gap'`, `registration_move_id`, `amount_cents = price_gap_cents`, `member_count/non_member_count/member_fee_cents/non_member_fee_cents` NULL, contact fields copied from the registration's lead contact / latest entry payment (`entryLeadEmail` order), `status:'pending'`, provider fields. Do NOT touch `active_payment_id`. `syncOrderFromRacePayment` yes (money is real); emit `ORDER_CREATED` yes; `RACE_REGISTERED` no.
- Returns `{ ok:true, payment, checkoutUrl: \`${getAppUrl()}/event-pay/${payment.id}\`, reused }`.

`markRacePaymentStatus` kind branch: when `payment.kind === 'move_gap'` and the transition is to `completed`: write status/completed_at (as now), `syncOrderFromRacePayment`, `ORDER_COMPLETED` with `metadata.kind:'move_gap'`, then settle the move with the CAS from EVENT-MOVE.3 (`update registration_moves set gap_settled_at=now(), gap_settled_how='collected', gap_settled_by_name='Customer (paid online)' where id = registration_move_id and gap_settled_at is null`), and return `applied` with `kind:'move_gap'`. Skip: registration status update, host-list sync, `applyTagRules`, `triggerSequencesForOrderStatus`. Non-completed transitions (failed/abandoned/refunded) behave as today. On `refunded` of a gap payment: do not un-settle (log it; staff decide).

Webhooks: after `markRacePaymentStatus`, `if (applied?.status === 'completed') { if (payment.kind === 'move_gap') sendGapPaidEmail({ db, paymentId }) else sendRaceConfirmations(...) }`; the Revolut Glofox push runs only for `kind === 'entry'`. `refreshRacePaymentFromProvider` path unchanged (it already never sends).

`sendGapPaidEmail({ db, paymentId })`: resolves `kind: 'gap_paid'`? No: keep ONE copy pair. The email sent when the LINK is created (Task 3) and the receipt when it is paid share nothing; the receipt is a plain short shell email with fixed copy "Thanks, the €X difference for <event> is paid" (transactional receipt, not marketing: acceptable as fixed copy? House rule says customer copy editable: make the RECEIPT subject/intro resolve through `resolveEventEmail({ kind: 'gap' })` with the `gap_email_*` columns, and the LINK email (Task 3) use the same kind with `{{pay_url}}` available; defaults differ by a `defaults` argument). Send-once on the payment row's `confirmation_email_sent_at` (reuse the column; it means "the customer-facing email for this payment row went"). Consent gate as the confirmation.

Tests: TDD each unit with the existing fake-db style (`src/lib/race-payments.test.js` exists? check; else mirror `race-confirmations.moved.test.js`). Webhook route tests exist (`src/app/api/webhooks/stripe/route.test.js`?): add gap cases: completion of a `move_gap` row settles the move, sends the gap receipt, does not call `sendRaceConfirmations`, does not run Glofox.

- [ ] Commit `EVENT-MOVE.5 — move_gap payments: createGapPayment, kind-aware completion, gap receipt`.

---

### Task 3: Staff route + chip action + link email

**Files:**
- Create `src/app/api/event-registrations/[id]/moves/[moveId]/gap-link/route.js` (+ test): `POST { email: boolean }` → gate identical to the settle route (manager + `races` at the entry's current studio; move belongs to entry and is the move into its current event; `no_gap`; already settled → 409 `already_settled`). Calls `createGapPayment` with `returnUrl = ${getAppUrl()}/event/${race.slug}/confirmed?registration=${id}` and `cancelUrl = ${getAppUrl()}/event/${race.slug}`. When `email` is true, sends the link email (`sendGapLinkEmail`: `resolveEventEmail({ kind:'gap' })` defaults: subject "Pay the difference for {{event_name}}", intro "Your entry moved from {{old_event_name}} to {{event_name}}, which costs {{difference}} more. Pay it here: {{pay_url}}"; the shell's body carries a button to `pay_url`), consent-gated, logged; returns `{ success, data: { payment_id, url, reused, emailed } }`. Register in openapi.
- `RaceTeamsManager.jsx`: beside Collected / Waived add **Send payment link** → `confirm("Send <lead> a payment link for €X?")` → POST with `email: true` → amber notice "Payment link sent to <name>" (or "copied" when the email could not be sent; always copy the URL to the clipboard too). Tests in `RaceTeamsManager.move.test.jsx`.
- `src/app/api/public/event-payments/[id]/route.js` + `RaceCheckoutPage.jsx`: include `kind` in the response; the checkout summary says "Price difference" (not "race entry") and lists no roster when `kind === 'move_gap'`. Test.

- [ ] Commit `EVENT-MOVE.5 — Send payment link for the difference; checkout labels it`.

---

### Task 4: Spec + gate + PR

- Spec section "Paying the gap (EVENT-MOVE.5)" covering: the kind, what completion does and does not do, the link route and email, the receipt, refunds not un-settling, operator-editable copy, and that EVENT-MOVE.6 (self-service) will carry `metadata.pending_move` on the same kind.
- Full CI mirror + `npm run build`; push; PR titled `EVENT-MOVE.5 — a payment link for a moved entry's price difference` leading with "🔴 Apply mig 710 before merging"; changelog entry; report.
