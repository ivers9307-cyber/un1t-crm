# RAFFLE.1 Phase 1 — charity raffle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell raffle tickets at a till, email the numbers, and draw winners, on a charity event, for the charity day on Sat 21 Nov 2026.

**Architecture:** Four service-role tables plus one `security definer` function that sells (numbers tickets atomically). Staff routes under `/api/events/[id]/raffle/*` on `withAuth({ permission: null, location: false })` plus a shared resolver judged at the event's studio. One staff page `/events/[id]/raffle` (client component) with Sell, Sales and Draw panels and a full-screen draw view.

**Tech Stack:** Next.js 16 App Router, Supabase (service role), vitest, Postmark via `sendTransactionalEmail`.

**Spec:** `docs/superpowers/specs/2026-11-20-charity-raffle-design.md` (Phase 1 section).

## Global Constraints

- Gate: `races` at the event's studio; `assertLocationAccessOr404`; void and "not claimed" also need `MANAGER_ROLES` at the event's studio. Another studio's event is a 404.
- A sale never writes to `contacts` or any table but the raffle tables (and `email_sends` via the email helper).
- Tables: RLS on, `revoke all` from anon, authenticated, public; no policy. Function: `revoke execute` from public, anon, authenticated; grant `service_role`.
- Email via `checkTransactionalConsent` (administrative) + `resolveEventEmail` (kind `raffle_tickets`) + `sendTransactionalEmail`, tag `raffle-tickets`; a failed email never fails the sale.
- Search values through `escapeLikePattern`; PostgREST `.or()` tokens stripped of `(),`.
- Responses `{ success, data?, error? }`. Non-submit buttons `type="button"`. UI from `@/components/ui`.
- Ticket numbers display as `#` + 3-digit zero pad (`#007`, `#1234` unpadded beyond 3).

## Review Focus

- Two tablets selling at once → distinct numbers (the function locks the raffle row; test the route passes quantity through to the RPC and the SQL uses `for update`).
- Drawing when every ticket is drawn or voided → a clear 409 "No tickets left to draw", not a crash.
- Voiding a sale with a drawn ticket → 409, sale unchanged.
- A phone search typed as `087 123 4567` or `+353871234567` → finds `0871234567` (digits-only matching on the last 9 digits).
- Double-tap on Sell → the button disables while the request is in flight (UI), and the request carries a client `request_id` the function dedupes on.

---

### Task 1: Migration 864 — raffle tables and the sell function

**Files:** Create `supabase/migrations/864_charity_raffle.sql`

Tables (`uuid` pks, `created_at timestamptz default now()`):
- `raffles`: `race_event_id uuid not null unique references race_events on delete restrict`, `location_id uuid not null references locations on delete cascade`, `name text not null`, `ticket_price_cents integer not null check (>0)`, `currency text not null default 'EUR'`, `sales_open boolean not null default true`, `email_subject text`, `email_intro text`, `next_ticket_number integer not null default 1`, `created_by uuid references profiles on delete set null`, `updated_at`.
- `raffle_sales`: `raffle_id uuid not null references raffles on delete restrict`, `location_id`, `contact_id uuid references contacts on delete set null`, `buyer_name text not null`, `buyer_email text not null`, `quantity integer not null check (between 1 and 500)`, `total_cents integer not null`, `payment_method text not null check in ('cash','card')`, `first_ticket integer not null`, `last_ticket integer not null`, `request_id uuid not null`, unique `(raffle_id, request_id)`, `sold_by uuid references profiles`, `voided_at timestamptz`, `voided_by uuid`, `void_reason text`, `email_status text`, `email_sent_at timestamptz`.
- `raffle_tickets`: `raffle_id`, `sale_id uuid not null references raffle_sales on delete restrict`, `ticket_number integer not null`, unique `(raffle_id, ticket_number)`.
- `raffle_draws`: `raffle_id`, `prize_name text not null`, `ticket_id uuid not null unique references raffle_tickets`, `drawn_by uuid`, `drawn_at timestamptz not null default now()`, `unclaimed_at timestamptz`, `unclaimed_by uuid`, `unclaimed_note text`.

Function `public.sell_raffle_tickets(p_raffle_id uuid, p_request_id uuid, p_contact_id uuid, p_buyer_name text, p_buyer_email text, p_quantity int, p_payment_method text, p_sold_by uuid) returns raffle_sales`, `security definer`, `set search_path = public`: return the existing row when `(raffle_id, request_id)` exists; else `select … for update` the raffle, raise `raffle_closed` if not `sales_open`, take `next_ticket_number` as first, insert the sale (`total_cents = price × quantity`, `location_id` from the raffle), insert `generate_series(first, first+q-1)` tickets, bump `next_ticket_number`, return the sale.

- [ ] Write the file; apply with Supabase MCP `apply_migration` (name `charity_raffle`); run the security advisor.
- [ ] Commit.

### Task 2: `src/lib/raffle.js` — pure helpers + access resolver

**Interfaces (produces):**
- `formatTicketNumber(n: number) => string` — `#007`.
- `formatTicketRange(first, last) => string` — `#041` or `#041–#043`.
- `phoneDigitsTail(s: string) => string|null` — digits only, last 9; null under 6 digits.
- `pickRandomIndex(length: number, rand = crypto.randomInt) => number` — throws on length < 1.
- `RAFFLE_COLS`, `SALE_COLS`, `DRAW_COLS` column strings.
- `resolveStaffRaffleEvent(user, eventId, { manager = false }) => Promise<{ response } | { db, race, isManager }>` — copy of `resolveStaffWaitlistEvent` without the manager requirement unless `manager: true`; `race` selects `id, name, location_id, host_id, sending_location_id, accent_hex, hero_image_url, race_date`.
- `loadRaffleState(db, raceId) => Promise<{ error } | { raffle|null, sales, draws, totals: { cents, tickets, cashCents, cardCents } }>` — sales newest first with `.range` pagination to 5,000, totals exclude voided.

- [ ] Tests `src/lib/raffle.test.js`: format `7→'#007'`, `1234→'#1234'`; range `(41,41)→'#041'`, `(41,43)→'#041–#043'`; `phoneDigitsTail('+353 87 123 4567') === phoneDigitsTail('087 123 4567') === '871234567'`; `phoneDigitsTail('12')===null`; `pickRandomIndex(0)` throws; `pickRandomIndex(5, () => 3) === 3`.
- [ ] Implement; tests pass; commit.

### Task 3: Ticket email `src/lib/raffle-email.js`

`sendRaffleTicketsEmail({ db, sale, raffle, race, contact = null, now }) => Promise<{ status: 'sent'|'suppressed'|'failed'|'skipped' }>` — modelled on `sendDonationReceipt`: consent gate (`contactId = sale.contact_id`), comms location, `resolveEventEmail({ kind: 'raffle_tickets', race: { ...race, raffle_tickets_email_subject: raffle.email_subject, raffle_tickets_email_intro: raffle.email_intro } })`, info rows Event / Tickets (range + count) / Paid (`€15.00`), heading `Good luck, {first}!`, default subject `Your raffle tickets for {event name}`, footer "Keep this email: you'll need your numbers if you win." Stamps `raffle_sales.email_status` / `email_sent_at`. Never throws.

- [ ] Test `src/lib/raffle-email.test.js`: sent path calls `sendTransactionalEmail` with `to = sale.buyer_email`, tag `raffle-tickets`, html containing `#041–#043`, stamps `email_status: 'sent'`; consent refused → no send, stamps `suppressed`; send throws → `failed`, returns without throwing.
- [ ] Implement; pass; commit.

### Task 4: Routes

All `withAuth({ permission: null, location: false }, …)` then `resolveStaffRaffleEvent`.

- `src/app/api/events/[id]/raffle/route.js` — `GET` → `loadRaffleState`; `POST` (manager) body `{ name, ticket_price_cents, email_subject?, email_intro? }` creates or updates the event's raffle (`upsert` on `race_event_id`, `location_id = race.location_id`).
- `.../raffle/contacts/route.js` — `GET ?q=` (min 2 chars) → up to 20 `{ id, name, email, phone }` from `listStudioContactsQuery(db, { locationId: race.location_id, primaryOnly: true, columns: 'id, name, email, phone' })` with `.or()` over name/email ilike and, when `phoneDigitsTail(q)`, `wa_phone.ilike.%tail%` (check the view has `wa_phone`; else `phone`).
- `.../raffle/sales/route.js` — `POST` body `{ request_id (uuidLike), contact_id? (uuidLike), buyer_name, buyer_email (email), quantity (1–500), payment_method }`. With `contact_id`, re-check the contact is in `studio_contacts` at the event's studio (else 404). Calls `db.rpc('sell_raffle_tickets', …)`; `raffle_closed` → 409. Then `await sendRaffleTicketsEmail` and return `{ sale, email_status }`.
- `.../raffle/sales/[saleId]/void/route.js` — `POST` (manager) `{ reason }`; 404 if the sale isn't this event's raffle; 409 if any of its tickets has a draw; else set `voided_at/by/reason` where `voided_at is null`.
- `.../raffle/draws/route.js` — `POST { prize_name }`: read all tickets of the raffle (paginated) not in a voided sale and with no draw; 409 when none; `pickRandomIndex`; insert the draw (unique `ticket_id` makes a concurrent double-pick fail → retry once); return draw + ticket number + buyer name.
- `.../raffle/draws/[drawId]/unclaimed/route.js` — `POST` (manager) `{ note? }` sets `unclaimed_*` where null.

- [ ] Tests per route (`route.test.js` beside each, `createFakeDb` or the repo's existing mock pattern): another studio's event → 404; sale with a contact from another studio → 404; draw with no tickets left → 409; void with a drawn ticket → 409; non-manager void → 403; sale route never calls `from('contacts')` writes.
- [ ] Implement; pass; `npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns && npm run check:rpc-names`; commit.

### Task 5: Page `/events/[id]/raffle`

**Files:** `src/app/(members)/events/[id]/raffle/page.js` (server gate copied from the donations page, passes `raceId`, `raceName`, `canManage`), `src/components/raffle/RafflePanel.jsx` (client). Link "Raffle" next to "Donations" in both spots of `src/app/(members)/events/page.js` for events with `charity_enabled`.

Panel: no raffle → setup form (name, price €) for managers. Else tabs Sell / Sales / Draw.
- Sell: search box (debounced 250 ms) → result rows with Select; "Add as guest" (name + email); quantity stepper + total; Cash/Card; Sell button disabled while in flight, new `crypto.randomUUID()` per completed sale; success banner with range and email status; reset.
- Sales: totals line; rows (range, name, method, time, email status, Void for managers with a reason prompt).
- Draw: prize input + Draw; "Full screen" toggle shows a black overlay with prize, giant ticket number, first name + last initial; winners list with "Not claimed" for managers.

- [ ] Test `src/components/raffle/RafflePanel.test.jsx` for the guest path (fill name/email, choose 3, Cash, submit → fetch body has `quantity: 3`, `payment_method: 'cash'`, no `contact_id`).
- [ ] Implement; `npm run build`; walk it on the dev server; commit.

### Task 6: Ship

- [ ] CI mirror (once), changelog `docs/changelog/entries/<PR>.md`, push, PR.
