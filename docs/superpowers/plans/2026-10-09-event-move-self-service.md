# Customer self-service move (EVENT-MOVE.6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The person who booked an entry can move it to another date themselves from a link in their confirmation email, under the same rules staff use; a dearer target is paid for before the move lands; nothing is ever refunded.

**Architecture:** A signed, expiring entry token (`src/lib/entry-manage-tokens.js`, HMAC on the service-role key like every other public token) identifies the entry. A public page `/event/entry/[token]` shows the entry and its move options; two public routes (`move-options`, `move`) wrap `listMoveTargets` and `moveRegistration` with the customer rules. Equal-or-cheaper targets move at once (`actor_type = 'customer'`, mig 712). Dearer targets create a `move_gap` payment (EVENT-MOVE.5) carrying `metadata.pending_move`; its completion runs the move and settles the gap in one go. The confirmation and moved emails carry the link.

**Tech Stack:** Next.js 16 (one public page in a FOUR-allowlist repo; see house rule), service-role routes with rate limits, Postgres CHECK change, vitest (+ jsdom for the page's client component).

**Worktree:** `~/code/un1t-crm-evmove8`, branch `event-move-self-service`, off `origin/main` AFTER EVENT-MOVE.5 (#gap payment PR) merged.

**Decisions fixed (Richard, 9 Oct):** dearer target → pay the difference first through the same checkout; cheaper or equal → move at once, no refund. Customers cannot force a full time, cannot move unpaid entries, cannot move after check-in, and see no capacity numbers (eligible options only).

**Facts to verify by reading:** `src/lib/race-gap-payment.js` (`createGapPayment`, the `move_gap` kind, how `markRacePaymentStatus` settles a gap; EVENT-MOVE.5), `src/lib/registration-move.js` (`listMoveTargets`, `moveRegistration`: `allowedLocationIds: null`, `actor`, `expectedSourceEventId`, `notify`), the public register route's rate-limit helpers (`src/lib/rate-limit.js`: `getClientIp`, `checkRateLimit`, `rateLimitResponse`), token helpers (`src/lib/host-onboarding-tokens.js` with its `iat` TTL pattern; `src/lib/event-checkin-tokens.js`), the public registration API (`src/app/api/public/event-registrations/[id]/route.js`), `RaceConfirmedPage.jsx` (dark public styling to match), `sendRaceConfirmations` and `sendRegistrationMovedEmail` in `src/lib/race-confirmations.js` (where the link goes: a "Change your date" line in the "what's next" area, as a merge tag `{{manage_url}}` available to operator copy), and the FOUR public-path allowlists: `src/proxy.js` `publicPaths`, `AppShell` `PUBLIC_PATHS`, `src/lib/brands.js` `allowedPaths`, `src/lib/tenant-domains-edge.js` `DB_BRAND_DEFAULTS.allowedPaths`, plus the regression test `src/public-compliance-paths.test.jsx`. Allowlist the whole flow: `/event/entry/` and the existing `/event-pay/` (already listed).

---

### Task 1: Migration 712 + token helper

- `supabase/migrations/712_registration_moves_actor_customer.sql`: widen `registration_moves.actor_type` CHECK to include `'customer'` (drop + re-add by name, catalog-guarded as mig 709 did), comment. `race_payments.metadata` is jsonb already (verify in mig 084); no column needed for `pending_move`.
- `src/lib/entry-manage-tokens.js`: `signEntryManageToken({ registrationId }, secret)` / `verifyEntryManageToken(token, secret)` → `{ registrationId }` or null; base64url `payload.sig`, HMAC-SHA256, `iat` with a 90-day TTL (`ENTRY_MANAGE_TOKEN_TTL_MS`), constant-time compare; `entryManageUrl(registrationId)` = `${getAppUrl()}/event/entry/${token}`. Tests: round-trip, tamper, expiry, wrong secret.
- Commit `EVENT-MOVE.6 — mig 712 (customer actor) + entry manage tokens`.

### Task 2: Public routes

- `GET /api/public/entry/[token]`: verify token (404 on any failure, never 401/403), rate limit `entry:${ip}` 60/5min; returns the entry summary (same shape as `/api/public/event-registrations/[id]` plus `can_move: boolean` and `move_blocked_reason` as a plain sentence when not: unpaid, checked in, cancelled, past). No capacity, no emails of other people.
- `GET /api/public/entry/[token]/move-options`: `listMoveTargets(db, { registrationId, allowedLocationIds: null })` mapped exactly like Mia's `list_event_move_options` (reuse that mapper if EVENT-MOVE.7 has landed; else implement `publicMoveOptions(targets, headcount)` in `src/lib/registration-move-public.js` and let Mia adopt it later): events/times with room only, no numbers, `price_difference_cents` and a sentence.
- `POST /api/public/entry/[token]/move` body `{ target_event_id, target_wave_id }`: rate limit `entry-move:${ip}` 10/15min; token → entry; refuse unless `confirmed` (`pending_payment` → 400 with the lib's message); compute the gap via `computePriceGapCents` on the loaded target: if `gap <= 0` → `moveRegistration({ actor: { type:'customer', id: contact_id, name: lead name }, notify: true, force: false, expectedSourceEventId })`, map refusals like the staff route (no 403s; `wave_full` is 409 with no force offer), answer `{ moved: true, registration }`; if `gap > 0` → `createGapPayment(..., { pendingMove: { target_event_id, target_wave_id, expected_source_event_id, actor: {...customer} } })` with `returnUrl = entryManageUrl(id)` and `cancelUrl` the same, answer `{ moved: false, pay_url }`. If EVENT-MOVE.5's `createGapPayment` has no `pendingMove` option yet, add it: it stores `metadata.pending_move` and leaves `registration_move_id` null.
- Completion (in `markRacePaymentStatus`'s `move_gap` branch): when `payment.metadata.pending_move` is set and no `registration_move_id`: run `moveRegistration` with the stored actor and `expectedSourceEventId`; on `ok` set `race_payments.registration_move_id = move.id` and settle that move `collected`; on refusal (e.g. the time filled meanwhile): leave the payment completed, write `metadata.pending_move_failed = { error, at }`, `logError`, insert an `error_events` row (`route_type 'move_gap'`, name `pending_move_failed`) so Sentinel pages, and send the customer the receipt email with a "we will be in touch" line instead of the moved copy. Tests for both paths.
- All three routes registered in `src/lib/openapi.js` (Public tag); `check:route-guards` EXEMPT entry for the token routes with the reason (token is the credential), mirroring how `/api/public/event-registrations/[id]` is classified.
- Commit `EVENT-MOVE.6 — public entry routes: summary, move options, move (pay first when dearer)`.

### Task 3: Page + emails + allowlists

- `src/app/event/entry/[token]/page.js` (server shell, outside any auth-gated segment) mounting `src/components/EntryManagePage.jsx` ('use client'): dark public styling like `RaceConfirmedPage`; shows event, date, time, people, status; a "Change your date" section listing options as cards (date, time, "same price" / "€X more, paid before the move" / "€X less, not refunded"); confirm sheet; on `moved: true` re-fetch and show "Moved. New tickets are on their way by email."; on `pay_url` navigate there; errors inline with the server's `message`. When `can_move` is false show `move_blocked_reason` and no options. Tests (jsdom): options render without any number that looks like capacity; dearer path navigates; equal path posts and re-fetches; blocked state.
- Add `/event/entry/` to the FOUR allowlists and extend `src/public-compliance-paths.test.jsx` (or its sibling) so a missing allowlist fails.
- Emails: `sendRaceConfirmations` and `sendRegistrationMovedEmail` pass `manage_url` as a merge tag and the default "what's next" copy ends with "Need a different date? Change it here: <link>" (operator copy may use `{{manage_url}}`; add it to `applyEventMergeTags`/HTML, escaped). The confirmation's byte-for-byte characterisation tests must be updated deliberately (they pin today's output; the new line is an intended change: update the snapshot with a comment).
- Commit `EVENT-MOVE.6 — /event/entry/[token] page, email link, public allowlists`.

### Task 4: Spec, gate, PR
Spec section "Customer self-service move (EVENT-MOVE.6)"; full CI mirror + build; PR leading with "🔴 Apply mig 712 before merging"; changelog; report.
