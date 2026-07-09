# Host platform hardening wave 1 — design (HOST-PORTAL.6/.7/.8)

**Date:** 2026-07-09
**Status:** approved (scope + order picked by Richard from the gap audit)
**Shipped as three PRs, in order:** PR-1 Stripe links + review notifications · PR-2 refund webhook sync · PR-3 org-wide fee reporting.

## Context

The events host platform (HOST-PORTAL.1–.5) is live. A grounded gap audit found four items worth shipping next; Richard picked all four ("proceed with 1 & 2 then 3 then 4"). Grounding facts verified in code:

- Stripe Connect creates **`type: 'standard'`** accounts (`src/lib/payments/stripe-connect.js:30`) → `accounts.createLoginLink` (Express-only) does NOT apply. The platform's view of a connected account is `https://dashboard.stripe.com/connect/accounts/{acct_id}`; the host's own view is their normal `https://dashboard.stripe.com` login.
- Transactional email helper: `sendTransactionalEmail` from `src/lib/postmark.js` (used by race-confirmations).
- The review route (`src/app/api/events/[id]/review/route.js`) sends **no** notification; the submit route (`/api/host/events/[id]/submit`) alerts **nobody**; the pending-review queue is pull-only (no badge).
- Sidebar badges: `usePolledCount` (`src/components/use-polled-count.js`) polling small count routes (e.g. `/api/approvals/count`).
- Stripe webhook (`src/app/api/webhooks/stripe/route.js`) handles `account.updated` + `checkout.session.completed/expired`; `charge.refunded`/payout explicitly deferred (line ~88). Payments resolve via `resolveRacePaymentByProviderRef(db, session.id)` — keyed by **checkout session id**.
- Staff refund semantics (`/api/orders/[id]/refund`): `refunded_amount_cents` is CUMULATIVE/absolute; `status='refunded'` only when fully refunded, partial stays `'completed'`. `aggregateHostRevenue` counts both.
- No org-wide booking-fee (`application_fee_cents`) rollup exists anywhere; per-host only (`getHostRevenue`).

## PR-1 — HOST-PORTAL.6: Stripe dashboard links + review-loop notifications

### 1a. Stripe links (no backend)
- **HostDetail (staff, Stripe card):** when `host.stripe_connected_account_id` is set, render an external link **"View in Stripe"** → `https://dashboard.stripe.com/connect/accounts/${stripe_connected_account_id}` (`target="_blank" rel="noopener noreferrer"`). This is the admin's "open the connect profile".
- **Host portal (`/host` dashboard):** for `payment_provider === 'stripe_connect'` hosts with an account id, a muted external link **"Stripe dashboard →"** → `https://dashboard.stripe.com` (Standard accounts log in with their own credentials — no login-link API exists for them).

### 1b. Review-loop notifications
New lib `src/lib/host-notifications.js` with two fire-and-forget senders (each wrapped in its own try/catch by callers; failures logged via `logError`, never block the response — repo convention):

- `notifyHostEventReviewed({ db, event, host, action, reason })` — called from the review route after the CAS update succeeds. Recipients: dedupe(lowercase) of `event_hosts.email` + all `host_users.email` for that host. Subject/body: **approve** → "Your event ‘X’ is now live" + the public `/event/[slug]` URL; **reject** → "Your event ‘X’ needs changes" + the reason + a link to the portal (`getAppUrl() + '/host'`). Plain shell via `sendTransactionalEmail` (no marketing gate — transactional, operator-to-host).
- `notifyAdminsEventSubmitted({ db, event, host, orgId })` — called from the submit route after the status update. Recipients: `profiles.email` of users holding an ADMIN role in the host's org (resolve org admins via `profile_locations` role in ADMIN_ROLES joined to the org's locations; dedupe; skip empties). Subject: "Host event awaiting review: ‘X’ (Host Y)" + link `getAppUrl() + '/settings/hosts'`.

### 1c. Pending-review badge
- **`GET /api/hosts/pending-events/count`** — same gate as the list route (getCurrentUser → ADMIN_ROLES → session orgId), returns `{ success, data: { count } }` (count of `status='pending_review'` events across the org's hosts; head/count-style query, no embeds — count-only selects with embedded filters are a repo trap, so count on `race_events` via `.in('host_id', ids)`).
- **Sidebar:** `usePolledCount` on the count route; render the red badge on the **Settings** nav entry (admins only — the hook/URL only mounts when the user is ADMIN_ROLES; follow how existing badges gate).

## PR-2 — HOST-PORTAL.7: `charge.refunded` webhook sync

In `src/app/api/webhooks/stripe/route.js` add a `charge.refunded` branch:
1. The charge lives on the **connected account** (direct charges): the event carries `event.account`. Resolve the checkout session: `stripe.checkout.sessions.list({ payment_intent: charge.payment_intent, limit: 1 }, { stripeAccount: event.account })` → `session.id` → `resolveRacePaymentByProviderRef(db, session.id)`. Unresolvable → log + **200** (never non-2xx for recognised-but-unmatched; provider auto-disable trap).
2. Update the payment idempotently with **absolute** amounts: `refunded_amount_cents = charge.amount_refunded`, `refunded_at = now()` (only set if not already set or amount changed), `status = charge.amount_refunded >= amount_cents ? 'refunded' : 'completed'` — exactly mirroring the staff refund route's semantics so `aggregateHostRevenue` stays correct.
3. Re-delivery safe: same event twice writes the same absolute values.
Payout events remain out of scope (deferred).

## PR-3 — HOST-PORTAL.8: org-wide booking-fee report

- **Lib `src/lib/org-event-fees.js`:** `getOrgEventFees(db, orgId)` → org's hosts → their events → settled payments (`status in (completed, refunded)`), `.range()`-paginated. Pure `aggregateOrgEventFees(payments, events, hosts)` returns `{ total_fee_cents, perHost: [{host_id, name, fee_cents, paidCount}], perMonth: [{month:'YYYY-MM', fee_cents}] }` (last 6 months by payment `created_at`, Dublin month bucketing via existing dublin-time helpers if available, else UTC month — note which).
- **Route `GET /api/accounting/event-fees`** — getCurrentUser → ADMIN_ROLES → session orgId → lib. (Accounting surface is admin-level; match the existing accounting routes' gate — read one first and mirror it.)
- **UI:** an "Event booking fees" card on the `/accounting` page (match its existing tab/card structure): total fees, per-host table, per-month mini-table. Light-theme primitives.

## Security / conventions checklist
- No new writes to money tables outside the webhook's absolute-value update. Notifications fire-and-forget. All new routes session-gated + org-scoped (route-guards recognises `getCurrentUser`). Detail-less counts only in the badge route. No migration in any PR.

## Out of scope (unchanged from the audit)
Host statements/invoices, payout-event sync, host-initiated refunds, host promo codes, multi-member host logins, host terms/DPA acceptance, subdomain DNS (operator).

## Testing
- PR-1: unit-test recipient assembly (dedupe/lowercase/skip-empty) + subject/body building as pure functions; route wiring by inspection + build; badge route counted correctly (unit on the query shape is impractical — verify by hand/SQL).
- PR-2: pure helper for the status/amount mapping (`refundPatchFromCharge(charge, payment)`) unit-tested (partial/full/re-delivery); webhook branch by inspection + build.
- PR-3: `aggregateOrgEventFees` unit-tested (multi-host, refunds excluded from fee? NO — fees were still taken on refunded charges unless Stripe reversed the application fee; v1 reports fees on settled payments as-collected, noting refunds separately is out of scope).
- Every PR: full CI mirror + `next build`; adversarial review on PR-2 (money) before merge.
