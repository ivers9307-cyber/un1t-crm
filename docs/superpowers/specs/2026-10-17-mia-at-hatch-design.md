# Mia at Hatch Street: answers, booking and upsell (spec E)

**Date:** 2026-10-17
**Status:** design, not built. Fifth of five sibling specs. Ships in two slices (Claude's call E-2, section 6.0): slice 1 (routing + read tools) after A; slice 2 (book, cancel, upsell) after D lands.
**Revised 17 Oct** after the builder checks and Richard's answers (`hatch-specs-resolutions.md`, items G1-G11 and E-1 to E-8), aligned with spec D's real interfaces.
**Repo:** un1t-crm. **Siblings:** A `2026-10-17-hatch-pipeline-and-invoices-design.md`, B `2026-10-17-hatch-radar-arrears-briefing-design.md`, C `2026-10-17-hatch-bookings-projection-design.md`, D `2026-10-17-un1t-online-write-back-design.md`.
**Roadmap:** `docs/superpowers/plans/2026-10-17-un1t-online-p1-plan.md` §P1.4, `2026-10-17-un1t-online-followups.md` §P1.4 / §P2.2, Mia org settings `2026-10-17-mia-org-settings.md` (MIAORG.1, mig 729).

---

## 1. Intent and why

Hatch Street's members live on un1t.online. Mia is off at Hatch, and where she does meet a Hatch member (a Hatch thread, or a dual-studio member on Stillorgan's number) she either has no account tools at all or reads the wrong system (the Stillorgan contact's Glofox columns). This spec makes Mia answer a member from the studio where that member actually holds a membership, book and cancel Hatch classes through spec D's write client, and, when a Hatch member has nothing left to book with, offer the packs and memberships staff have chosen, send a hosted payment link, and book the class they asked for once the payment lands. The goal is the Stillorgan experience at Hatch with as little staff work as possible.

## 2. Goals

1. Mia's account and booking tools dispatch on the **member's** studio(s) with an active membership (decision 12), not the thread's studio, for all three cases: Hatch-only, Stillorgan-only, active at both.
2. Every account tool has a un1t.online source (section 5.3), with no capacity numbers ever reaching the model.
3. `book_class` and `cancel_class_booking` work at Hatch through spec D's write client, with the same honesty rules as Stillorgan: success judged on the response, unknown outcomes verified, and a staff card only when a write fails or its outcome stays unknown.
4. Upsell (decision 10): offer configured products, send a checkout link (D's primitive, the member's `userId`), detect the purchase, book the requested class if still bookable, confirm in-thread.
5. A settings surface where staff choose the offered products (any active product, public or private), their order and a short description.
6. Every customer-facing line in these flows is operator-editable with a default; no em-dashes.
7. The `credits` capability flips true for un1t.online.
8. Replies-only rollout, switched on by Richard, tested with the MIA TEST account up to and including getting a payment link (G4); Richard tests actually paying by hand after go-live.
9. Hatch's read tools work for a Hatch member as soon as slice 1 ships and Hatch's Mia gate passes, without waiting for D's `bookings` flip or B's `memberships` flip (E-1).

## 3. Non-goals

- Creating un1t.online accounts or the first-class path for new people (spec D, path 8c).
- Staff booking from the contact page (D). The bookings projection into `class_bookings` (C). Invoices and arrears reads (A). Radars and briefings (B).
- Follow-ups and first-class check-ins at Hatch (decision 3: replies only at first).
- Membership pause or cancellation execution in un1t.online. `request_pause` / `request_cancellation` stay staff-actioned requests.
- Moving Mia off the Anthropic Messages API, or any OpenAI use.
- Booking or selling on Instagram at first (E-3): there the Hatch write and purchase tools are not offered, refuse if named, and hand off to staff.
- Any new outbound WhatsApp send through Stillorgan's number (G7). Every send in this spec is an in-thread reply or confirmation inside an open customer-service window (WAHOMESTUDIO.1); org-wide WhatsApp routing is a separate follow-up task.

## 4. Anti-goals (must never happen)

- Mia tells a customer a class's capacity, spaces left or headcount. The un1t timetable gives the model `full: true|false` only.
- A Glofox studio's tool block, prompt or executor output changes byte-for-byte. Stillorgan-only members see no difference.
- A Glofox executor runs for a un1t.online studio (or the reverse) because `bookings` flipped true. Today `canBook = providerTakesBookings(...)` (`src/lib/agent/auto-reply.js:520`) picks the Glofox block whenever bookings is true; slice 1 replaces that switch, so it is gone before D flips the capability.
- Mia calling `POST /purchases/charge` or sending `bypassCredit` / `forceRefund`. The only charge anywhere is inside D's `grantTrial` (€0, guarded by a live price-is-0 read, D-4); Mia reaches it only through `grantTrial`.
- Two bookings, or two charges, from one member intent because two detectors raced.
- Two live payment links for one member at once (E-6).
- Stillorgan's knowledge base answering Hatch prices or Hatch's timetable (E-4).
- Mia says "booked", "paid" or "cancelled" without the tool result saying so.
- Hatch's org-inherited follow-up settings switch follow-ups on at Hatch by accident.

## 5. Current state (read 17 Oct, origin/main d75b064d)

### 5.1 Tool set and gating
- Tools: `ALL_AGENT_TOOLS = [...ACCOUNT_TOOLS, ...BOOKING_TOOLS, ...EVENT_TOOLS, ...CARD_TOOLS]` (`auto-reply.js:114`), cached with a 1h breakpoint on the last tool (`:122-126`). A second block `CACHED_NO_BOOKING_TOOLS` is derived once by `deriveNoBookingTools` (`:132-137`); `agentToolsFor(canBook)` picks one (`:139-141`) and is sent every loop iteration (`:922`).
- `BOOKING_SYSTEM_TOOL_NAMES` (`src/lib/agent/tool-capability.js:25-40`): get_my_membership, get_my_payment_reminder, get_my_next_class, get_my_recent_attendance, request_cancellation, book_class, list_my_upcoming_bookings, cancel_class_booking. Dropped from the block and refused by `refuseAtNoBookingStudio` (`:89-93`) at a studio whose provider has `bookings !== true`; the refusal runs before every executor (`auto-reply.js:987`, `account-tools.js:637`, `booking-tools.js:666`). The comment at `tool-capability.js:12-16` records why: Sonnet 5 has invented tool names.
- Provider: `membershipSource = providerFor(loc.membership_source)` off the THREAD's location row (`auto-reply.js:516`); `canBook` from it (`:520`); `toolCtx` carries `locationId` (thread), `canBook`, `membershipSourceKey` (`:862-883`).
- Settings: `resolveAgentSettings(db, locationId)` merges DEFAULTS, `org_settings.customer_agent` (mig 729) and the studio blob (`src/lib/agent/settings-resolve.js`). `followups` and `first_class_checkin` are inheritable object keys merged per field (`src/lib/agent/settings-overrides.js:42`); `enabled`, `test_mode`, `test_phones`, `booking_mode`, `booking_url` are studio-only (`:26-38`). Gate: `shouldAgentReply` (`src/lib/agent/core.js:258-297`); enabled false + test_mode true answers only `test_phones`.
- un1t.online provider: every capability false (`src/lib/membership/sources/un1t-online.js:16`). Nothing reads `capabilities.credits` today (grep: only `tool-capability.js:54` reads bookings, `account-tools.js:609` reads invoices).

### 5.2 What the tools read today
- `verify_identity` pools contacts at the thread's `location_id` (`account-tools.js:442-486`). A Stillorgan-owned contact verifying on an unlinked channel in a Hatch thread cannot match by email.
- `get_my_membership`, `get_my_next_class`, `get_my_recent_attendance` read Glofox-synced columns on `contacts` across the person group (`account-tools.js:724-815`). `get_my_payment_reminder` reads the CRM's dunning run plus a live Glofox overdue check gated on `capabilities.invoices` (`:551-628`).
- `list_upcoming_classes` at a un1t.online studio reads `un1t_events` (status `scheduled`, 14 days, limit 100) and returns `{ name, starts_at }` only: no event id, no full flag (`booking-tools.js:281-343`, dispatch `:668-672`).
- `book_class` (`booking-tools.js:692-1014`): Glofox only. Person-group election, already-booked fan-out, credits pre-flight (`:892`), `no_credits` approval card + deterministic handoff (`:897-931`, handled `auto-reply.js:1158-1164`), draft mode (`:935`), write-ahead `agent_membership_requests` row then `createBooking` (`:950-961`), `bookingRejectionRoute` (`:552-555`) sends EVENT_FULL / cancelled to the chat and everything else to a card with `booking_issue_handoff_text`.
- Approving a `class_booking` / `class_cancellation` card executes in Glofox (`src/app/api/agent/membership-requests/[id]/route.js:367-430`, `:539-705`); a `needs_credit_grant` card buys a Glofox trial first (`grantTrialBeforeBooking`, `src/lib/agent/trial-grant.js`). The /start funnel files cards through `routeToReview` (`src/lib/class-booking-processor.js:81`).
- In-thread confirmations outside a turn go through `sendAgentThreadMessage` (`src/lib/agent/notify.js:163-200`): em-dash scrub, 24h window check (`window_closed`), the thread's own number (`replyInConversation`, so Hatch-filed threads work under WAHOMESTUDIO.1).

### 5.3 un1t data available (mig 726)
- `contacts.un1t_user_id` (unique per organisation, `726:50-55`): set on a Stillorgan-owned contact too when the sync attached a Hatch client to it.
- `un1t_clients`: `credit_balance`, `credit_unlimited`, `last_attended_at`, `bookings_30d_attended`, `bookings_30d_no_show`. **No 7-day attendance column.**
- `un1t_subscriptions`: status, product_id / product_title, price, interval, `current_period_end`, `cancel_at_period_end`, `paused_at` / `paused_until`, `past_due_at`. Live statuses: `MEMBERSHIP_ACTIVE_STATUSES = ['active','trialing','past_due']` (`src/lib/un1t-online-map.js:19`).
- `un1t_products` (title, type, status, visibility, price, interval, credits_per_period), `un1t_events` (capacity, bookings_count: never to the model), `un1t_bookings` (event_id, status), `un1t_transactions` (product_id, remote_created_at). All service-role only.
- API facts from the 16 Oct snapshot: `POST /purchases/checkout` **requires an `idempotency-key` header**. Its response is `{ checkoutUrl, free }`. Per-member reads exist: `GET /credits/ledgers/{userId}/{studioId}` (balance, is_unlimited), `GET /users/{id}/bookings`, `GET /subscriptions/history/{userId}`.

### 5.4 What spec D gives E (its real interfaces)
From `2026-10-17-un1t-online-write-back-design.md` §6.1-6.7 with resolutions D-3, D-4, D-7, D-8:
- `src/lib/un1t-online-write.js` exports `book`, `cancel`, `grantTrial`, `createCheckoutLink`. Every result carries D's judged verdict `done | refused | unknown` (`judgeUn1tWrite`: `id`, `code`, `message`, `alreadyBooked`, `recovered`). `book` and `cancel` already run D's one-attempt **dedupe read** after a 5xx / no reply / unclear 2xx (book: `GET /users/{id}/bookings`; cancel: `GET /bookings/{id}`) and re-send once only on "absent", so an `unknown` reaching E is already "checked and still unknown".
- Every primitive refuses `UN1T_WRITES_OFF` unless `settings.un1t_online.writes_enabled` is true at the studio, and `UN1T_PERMISSION_MISSING` when the token lacks a permission. Each call takes `origin` (`'mia'` for E) and `originRef` (E's card or intent id), and writes one row of D's ledger `un1t_write_events`.
- After a `done`, D's `applyUn1tWriteToMirror` updates `un1t_bookings`, `un1t_clients` credits and C's `class_bookings` row at once, so E's next read sees the booking.
- `createCheckoutLink(db, { locationId, userId, productId, idempotencyKey, successUrl, cancelUrl, origin, originRef })` takes the un1t.online `userId` (not a contact id) and returns `{ checkoutUrl, free }` on success (plus D's `code` / `message` on refusal). It refuses a €0 product (the trial has one path). D has no return page of its own: E's `/pay-done/<token>` is the only one (D-3).
- `grantTrial` runs D-4's chain: €0 `POST /purchases/charge` (live price-is-0 check) → if refused, a `free: true` checkout completed server-side → if that cannot complete without the customer, `POST /credits/grant` for the trial's 3 credits with the trial product's expiry, recorded on the ledger as a trial grant → only then a staff card. The CRM adds no one-trial check (G10).
- `executeUn1tApproval()` executes a `details.provider = 'un1t_online'` card (D-8 stamps the marker on queue-cap cards too).
- D's rate budget counts per HTTP request (D-7) and is shared with the sync.

## 6. Design

### 6.0 Two slices (Claude's call E-2: the reads help members now and do not need D)
- **Slice 1, routing + reads** (after A, before D): 6.1 member studios, the read-only provider-aware tool blocks (6.2), every read tool in 6.3, the Hatch facts block (6.2), the `credits` flip, the `membership_at_other_studio` answer. `book_class` / `cancel_class_booking` for a `un1t:` id answer with `chat_booking_unavailable_text` (6.6) and `booking_url`, or a handoff. No migration.
- **Slice 2, writes + upsell** (after D is deployed): 6.4, 6.5, 6.6, the two tables, the `/pay-done` page, the approval branches. D's `bookings` flip waits for slice 2.

### 6.1 Member studios: who answers
New module `src/lib/agent/member-studios.js`, pure core + one IO function:

`resolveMemberStudios(db, { anchorContactId, threadLocationId, organizationId, senderPhone })` returns `{ studios: [{ locationId, providerKey, active, contactIds, un1tUserId?, glofoxMemberId? }], readFailed }`.

- Reads the person group (`linkedAccountsForContact`) plus the anchor.
- **Glofox studio active** = any group contact at that studio with `hasBookableMembership(row)` (`src/lib/person-accounts.js:63`) or `trial_credits_remaining > 0`.
- **un1t.online studio active** = the group's `un1t_user_id` has, at that studio, a `un1t_subscriptions` row in `MEMBERSHIP_ACTIVE_STATUSES`, or `un1t_clients.credit_unlimited = true`, or `credit_balance > 0`.
- **Answerable** = active AND that studio's Mia is on for this sender: `resolveAgentSettings(studio).settings` passes the same enabled / test_phones rule `shouldAgentReply` applies. So before Richard switches Hatch on, no Stillorgan thread ever shows Hatch data, and while Hatch is in test mode only the MIA TEST phone does. **This gate plus the dispatch is what switches Hatch's tools on, not `capabilities.bookings`** (E-1); the capabilities only say what D and A have built.
- Status is per studio (G1): a member's Stillorgan membership and Hatch membership are read and reported separately; only the contact (and the person group) is shared.
- **Fallback when nobody is answerable-active** (a lapsed member, a finished trial): the studios where the person has any account (a Glofox member id, a un1t client row); if exactly one is answerable, that one; else the thread's studio. This is where the upsell happens, so a finished-trial Hatch member on a Stillorgan thread still reaches the Hatch offer list.

The resolver runs once at turn start (from the thread's bound or pre-verified contact) and again after a `verify_identity` success mid-turn. A failed read is `readFailed`: the turn falls back to today's thread-studio behaviour, never a confident wrong studio.

**The four cases:**

| Case | Thread filed at | Answerable studios | What Mia does |
|---|---|---|---|
| Hatch member (contact at Hatch) on Stillorgan's number | Hatch (WAHOMESTUDIO.1) | Hatch | provider-aware block, un1t executors, Hatch's settings |
| Hatch member whose contact Stillorgan owns, active only at Hatch | Stillorgan | Hatch (once Hatch is on) | same as above, on a Stillorgan thread; Stillorgan's voice, Hatch's data, timetable, facts block and action settings (E-4) |
| Stillorgan-only member | Stillorgan | Stillorgan | today's Glofox block, byte-identical |
| Active at both | either | both | provider-aware block; reads return one section per studio; classes and bookings carry a studio tag |

**Claude's call (kept, E-8):** for the second row while Hatch is still off, account and booking tools return a new `membership_at_other_studio` answer (Mia says she is looking at Hatch Street, which she cannot answer for yet, and hands off) instead of reading the Stillorgan contact's Glofox columns, which today report "no membership" to a paying Hatch member. Reason: a wrong confident answer is worse than a handoff. Small change at live Stillorgan, tested on its own.

**Claude's call:** "action settings" (`booking_mode`, offer list, the copy in 6.6) come from the studio the action runs at; voice, quiet hours and caps stay the thread's. Reason: the studio that takes the booking or the money decides how it is done.

### 6.2 Tool blocks, gating and dispatch
Byte-stable cached blocks, each derived once at module load:

1. **Glofox block** (`CACHED_ACCOUNT_TOOLS`): unchanged. Used when every answerable studio is Glofox.
2. **No-booking block** (`CACHED_NO_BOOKING_TOOLS`): unchanged. Used at a studio with source `none`, and at a un1t.online thread studio when no studio is answerable (Hatch off, or a stranger).
3. **Provider-aware blocks** (new), the same tool names as block 1 with provider-neutral descriptions, in fixed variants:
   - **3a reads** (`CACHED_UN1T_READ_TOOLS`): reads, `list_upcoming_classes`, the request tools; `book_class` / `cancel_class_booking` / `list_my_upcoming_bookings` only when a Glofox studio is also answerable (their `un1t:` ids then answer "not from chat yet"). Used in slice 1, on Instagram (E-3), and wherever Hatch's writes are off.
   - **3b writes** (`CACHED_UN1T_FULL_TOOLS`): 3a plus un1t booking and cancelling plus `list_purchase_options`, `send_purchase_link`, `check_my_purchase`. Used only when all hold: the channel is WhatsApp, slice 2 is deployed, and the un1t.online studio has `writes_enabled`.

`agentToolsFor(canBook)` becomes `agentToolsFor({ answerable, threadProvider, channel, un1tWrites })`. `canBook` / `capabilities.bookings` stops being the switch for Hatch (E-1). `refuseAtNoBookingStudio` is rewritten as `refuseToolForTurn(toolName, ctx)`: a read tool is allowed when a studio of its provider is answerable; a un1t write or purchase tool is allowed only under 3b's three conditions; anything else returns `not_available_at_this_studio` (or, on Instagram, `handoff_to_staff`) before any read or API call.

**Hatch facts block (E-4).** When an answerable studio is not the thread's studio, the prompt gets a short block for that studio, in the uncached suffix: studio name and address (location row), its `booking_url` / `membership_signup_url`, the offer list titles and prices (6.6), and that studio's own `agent_knowledge` rows if any. A rule says: "Prices and the timetable for {studio} come only from your tools and this block, never from the studio knowledge above." Hatch's timetable comes from `list_upcoming_classes` dispatched to Hatch. The thread studio's knowledge still answers about the thread studio. Ids the model sees are tagged so the executor can dispatch without a studio parameter: un1t event and booking ids are `un1t:<uuid>` (the `class_occurrences` convention, mig 734); Glofox ids stay raw 24-hex. A tagged id is accepted only if its studio is in `answerable`; anything else answers `not_available_at_this_studio`.

Executors: `executeBookingTool` / `executeAccountTool` gain a provider switch. un1t implementations live in new `src/lib/agent/un1t-tools.js` (reads) and `src/lib/agent/un1t-booking.js` (book, cancel, upsell). Glofox executors receive the answerable Glofox studio's `locationId` instead of the thread's only when the thread studio is not Glofox (a Stillorgan member on a Hatch-filed thread must use Stillorgan credentials, not Hatch's empty ones).

**Sonnet-5 invented-tools risk.** The three purchase tools exist only in block 3b, and `refuseToolForTurn` refuses them (and every un1t write) outside 3b's conditions even when the model names them. `tool-schemas.test.js` budget is re-checked (strict tool use stays off; the optional-parameter count must not push it further from 24 without a note). Each variant is its own 1h cache entry; at Hatch's volume that cost is small.

**Prompt.** `renderCustomerAgentBasePrompt` gets provider-aware variants matching 3a and 3b: booking rules without "limited" (un1t gives full only), the upsell rules (6.5) in 3b only, and for a two-studio member "say which studio each answer is for". The Glofox and no-booking renders stay byte-identical (test).

### 6.3 Each tool's un1t source

| Tool | Source | Notes |
|---|---|---|
| `get_my_membership` | `un1t_subscriptions` (studio, user, live statuses, latest `current_period_end`) + `un1t_products` by `un1t_id` for title / price / interval; credits from `un1t_clients` | Returns status (active, paused until X, ending on X when `cancel_at_period_end`, payment issue when `past_due_at`), plan, price, renews on. Credits as a number or `unlimited`, gated on `credits` capability. Two studios: `{ studios: [...] }`. |
| `get_my_next_class`, `list_my_upcoming_bookings` | live `GET /users/{id}/bookings` through the read client's `getOne` (D §6.1; slice 1 adds `getOne` itself if D has not landed), joined to `un1t_events` for title and start; falls back to the `un1t_bookings ⨝ un1t_events` mirror with `may_be_stale: true` | Live first because the mirror can be 15 minutes behind the member's own app; ids `un1t:<uuid>`. Only future, booked rows. |
| `get_my_recent_attendance` | `un1t_clients.bookings_30d_attended`, `last_attended_at` | `total_attended_7d: null` with `note: 'no 7-day count at this studio; never state one'`. No-shows omitted (Claude's call). |
| `list_upcoming_classes` | `un1t_events` as today, plus `event_id` (`un1t:<uuid>`) and `full` computed server-side as `capacity > 0 && bookings_count >= capacity` | Never selects capacity into the payload; never a `limited` flag. Full may be up to 15 min stale; un1t.online arbitrates at booking. |
| `get_my_payment_reminder` | spec A's seam read for overdue invoices / `past_due_at` | No CRM dunning run exists at Hatch, so `has_reminder: false`; `still_overdue` from A; no pay link (un1t.online handles card updates). Gated on `invoices` (A flips it). |
| `request_pause`, `request_cancellation` | unchanged staff requests, filed at the member's studio | `request_cancellation` is in `BOOKING_SYSTEM_TOOL_NAMES` only because approval can execute in Glofox; in blocks 3a and 3b it is offered, and the approval route must never run the Glofox cancel for a row filed at a un1t.online studio (test). Staff cancel in un1t.online by hand. |

`credits` flips true in `src/lib/membership/sources/un1t-online.js` in slice 1, with a test that lists every reader of `capabilities.credits` (today: none; after E: the un1t tools). The four member reads (`get_my_membership`, `get_my_next_class`, `list_my_upcoming_bookings`, `get_my_recent_attendance`) do not read `memberships` or `bookings` and do not wait for either flip (E-1); `get_my_payment_reminder` waits for A's `invoices` flip.

### 6.4 book_class and cancel_class_booking at Hatch (slice 2)
Offered only in block 3b (WhatsApp, slice 2 deployed, Hatch `writes_enabled`). A D refusal `UN1T_WRITES_OFF` or `UN1T_PERMISSION_MISSING` at call time answers "booking is not available from chat right now" with `booking_url` or a handoff, never a card.

`book_class` (un1t):
1. Guards: verified; Hatch answerable or the fallback studio; `un1t_user_id` resolved (none → `not_linked`, hand off with `booking_url` if set). Event `un1t:<uuid>` exists at that studio, status `scheduled`, starts in the future, and the relayed `starts_at` matches (MIA-BOARD.2 analogue).
2. Already booked: live bookings (6.3) contain the event → answer booked, no write.
3. Entitlement pre-flight: live ledger `balance > 0` or `is_unlimited`, or a live subscription in the mirror. An unreadable ledger proceeds (un1t.online arbitrates), as Stillorgan does. Confirmed nothing → the upsell (6.5): `{ booked: false, needs_purchase: true, offers }`. With no offers configured it falls back to today's `no_credits` card + deterministic handoff.
4. Draft mode (`booking_mode: 'draft'` at that studio) → pending `class_booking` card, as Stillorgan.
5. Auto: write-ahead `agent_membership_requests` row (kind `class_booking`, `details.provider: 'un1t_online'`, `un1t_event_id`, `un1t_user_id`, `stage: 'executing'`), then D's `book` with `origin: 'mia'`, `originRef: <that row id>` (D stamps its ledger id back onto `details.un1t_write_id`). Mia never sends `bypassCredit`. Mapped from D's verdict: **done** (including `alreadyBooked` and `recovered`) → `actioned`, confirm; **refused** with a customer-answerable code from D's mapping table (class full, cancelled, started) → `failed`, relay and offer the next slot; **refused** no credit (a race after pre-flight) → upsell; **refused** with any other or unmapped code → card `booking_rejected` + `booking_issue_handoff_text`, quoting un1t.online's words on the card; **unknown** (D's dedupe read already ran and could not tell) → card `un1t_outcome_unknown` + the same handoff text. Never "booked" on unknown.

`cancel_class_booking` (un1t): booking id must appear in the member's live bookings (else `CANCELLATION_UNCERTAIN` as Glofox); draft → card; auto → write-ahead `class_cancellation` row, D's `cancel` (`origin 'mia'`, never `forceRefund`); done → cancelled; refused (late cancel, or D's "already happened" for an attended class) → relay honestly, never promise a credit back; unknown → card + handoff text.

**Approval cards.** The PATCH executor's `class_booking` and `class_cancellation` branches (`membership-requests/[id]/route.js:367`, `:539`) send `details.provider === 'un1t_online'` rows to D's `executeUn1tApproval()`. D wires the funnel cards; E wires Mia's cards through the same call and adds what Mia's cards need around it: ACCOUNT_MISMATCH (the `un1t_user_id` stamped on the card against the contact now), the past-start expiry, the in-thread confirmation via `sendAgentThreadMessage`, and Fix & retry. `approval-suggest.js` reads un1t context (membership, next class) for un1t cards instead of `glofox_membership_state` / `recent_bookings` (`:218`). There is no `needs_credit_grant` card from Mia at Hatch: the upsell replaces it. **Claude's call:** E owns Mia's branches, D owns the executor they call. Reason: one executor, so a staff approve can never behave differently by who filed the card.

### 6.5 Upsell, checkout link, book after payment (slice 2, WhatsApp only)
**Trigger** (decision 10): `book_class` pre-flight confirms no credits and no live subscription, or the member asks to buy.

**Trial first (Claude's call, kept per E-8):** when D's `settings.un1t_online.trial_product_id` is set and the mirror shows no transaction for that product for this member, Mia offers the public "The UN1T Trial" before the paid list, and choosing it calls D's `grantTrial` (the D-4 chain), never checkout. Reason: a member who never had the trial should not be asked to pay first. Reading the mirror only decides what to offer; it is not an eligibility check (G10): un1t.online decides, and a refusal ("trial already used") is answered cleanly by dropping the trial and showing the paid offers. `grantTrial` done → book the class as in 6.4; its final staff card → `booking_issue_handoff_text`.

**Flow.**
1. `book_class` returns `needs_purchase` with `offers` from `list_purchase_options` shape: `{ offer_id, title, price_label ('€125', '€189 a month'), credits, blurb }`. Mia presents them (WhatsApp buttons when 3 or fewer, a list otherwise; never more than the configured list).
2. Member picks. Mia restates product and price and gets a clear yes, then calls `send_purchase_link({ offer_id, event_id?, class_name?, class_time?, starts_at? })`.
3. The tool looks for this member's live intent (below). **Live intent for the same product** → re-call `createCheckoutLink` with the same idempotency key (the intent id), which returns the same hosted session, and resend it. **Live intent for a different product** → no second link (E-6): Mia says the open link is still waiting, using `purchase_link_open_text`, and offers the team if they want something else. **None** → a new intent, then `createCheckoutLink(db, { locationId, userId: intent.un1t_user_id, productId, idempotencyKey: intent.id, successUrl, cancelUrl, origin: 'mia', originRef: intent.id })`, with E's own `/pay-done/<token>` URLs built from `getAppUrl()`. Done → store `checkoutUrl`, return `{ link_sent: true, url, wording }`; Mia sends it with `purchase_link_text` and the link button. `free: true` → treat as paid at once (step 5). A refusal (`UN1T_WRITES_OFF`, permission missing, product no longer sellable) → intent `refused`, Mia hands off with `booking_issue_handoff_text`.
4. Detection (section 6.5.2).
5. On detection: CAS the intent `link_sent → paid` (`update ... where status = 'link_sent' returning`), so exactly one detector proceeds. With a class: re-check the event (scheduled, not started), then `book_class`'s execute step (write-ahead row, D's `book`). Send in-thread via `sendAgentThreadMessage`: booked → `purchase_paid_booked_text`; class full / gone / started → `purchase_paid_class_gone_text` (Mia offers alternatives on the next turn); refused or unknown → `purchase_paid_booking_failed_text` + a `class_booking` card (`reason: 'paid_booking_failed'`). Without a class: `purchase_paid_no_class_text`. `window_closed` → no send, the card carries it (decision log + staff push).

This confirmation is an in-thread reply inside the member's own open window, never a template or a new outbound send (G7). **Claude's call:** it sends with follow-ups off. Reason: it completes the member's own request; it is not a nudge.

#### 6.5.1 Where the pending intent lives: new table `mia_purchase_intents`
Not `agent_membership_requests`: every pending row there is a staff card, and decision 10 says minimise staff work. Columns: `id uuid pk`, `location_id` (the un1t studio), `organization_id`, `contact_id`, `conversation_id`, `channel`, `un1t_user_id text not null`, `un1t_product_id text not null`, `product_title`, `price_cents`, `event_un1t_id text null`, `class_name`, `class_time`, `starts_at timestamptz null`, `checkout_url text`, `success_token_hash text` (6.5.2), `status text check in ('link_sent','paid','booked','book_failed','no_class','expired','refused')`, `un1t_write_id uuid` (D's ledger row), `entitlement_snapshot jsonb` (balance / unlimited / live subscription ids at link time), `outcome jsonb`, `created_at`, `expires_at`, `paid_detected_at`, `detected_by text`, `updated_at`.
- **Duplicate-link safety (E-6):** partial unique index `(location_id, un1t_user_id) where status = 'link_sent'`: one live link per member, and Mia never sends a second live link while one is open. Same product → the same session again (same idempotency key; verify with MIA TEST that un1t.online returns the same session for a repeated key). Different product → refused in chat (step 3). Accepted risk (Richard, E-6): if a member still manages to pay twice (for example an expired link that un1t.online kept alive), Hatch staff refund in un1t.online.
- **Expiry:** `expires_at = created_at + 23h` (inside the WhatsApp customer-service window). The post-sync hook (6.5.2) marks it `expired`, silently (MIA-EXPIRY-QUIET posture), which frees the member for a new link. A payment after expiry is just a purchase: no auto-booking.
- **Class filled or passed:** never expires the intent early; it changes the outcome message in step 5.
- **Grants (CLAUDE.md, mig 677):** `ENABLE ROW LEVEL SECURITY`, no policy, `REVOKE ALL ON public.mia_purchase_intents FROM anon, authenticated`, `GRANT SELECT, INSERT, UPDATE, DELETE ... TO service_role` (mig 726's pattern). Nothing client-side reads it; staff see intents through an `/api` route on the contact page (Builder: small "Payment link sent" chip).

#### 6.5.2 Payment detection timing
Three detectors (Claude's call, trimmed per E-8), all funnelling into one `settlePurchaseIntent(db, intentId, { detectedBy })` that is safe to call concurrently:
1. **Return page `/pay-done/<token>`**, the only payment return page in the estate (D-3: D has none). `successUrl` = this page; the token is 32 random bytes, stored hashed on the intent. Loading it is never proof of payment: it only triggers a member check (live ledger + `GET /subscriptions/history/{userId}`, through D's read client and rate budget), at most one per intent per 30 s, and shows operator-editable thanks copy and the studio's branding, nothing personal, `noindex`. `cancelUrl` = the same page with a "nothing was charged" line. All four public allowlists (`src/proxy.js:214` `publicPaths` `/pay-done/`, `AppShell` `PUBLIC_PATHS` `/pay-done`, `brands.js` un1t-marketing `allowedPaths`, `tenant-domains-edge.js` `DB_BRAND_DEFAULTS.allowedPaths`) plus `src/public-compliance-paths.test.jsx`. Reason: the member usually lands here seconds after paying, so they are booked before they put the phone down.
2. **`check_my_purchase` tool**: the member says "paid"; the same check now.
3. **After each `un1t-online-sync` run** (every 15 min): evaluate live intents against the fresh mirror (zero extra API calls; a `un1t_transactions` row for the user and product with `remote_created_at >= created_at` also records which product was bought), and sweep expiry.

No separate watcher cron. The worst case (a member who pays, closes the page before it loads and never messages) waits for the next sync, at most about 15 minutes. If the builder shows the sync hook cannot cover that (for example a sync that stays `in_progress` for long stretches), a 5-minute watcher is the fallback, with its own heartbeat row.

"Paid" = entitled now vs the snapshot: balance went up, unlimited turned on, or a new live subscription appeared. The product match is recorded when the transaction shows, not required to book (un1t.online arbitrates).

### 6.6 Offer list settings and copy
**Storage:** new table `mia_purchase_offers (id, location_id, un1t_product_row_id uuid references un1t_products(id), sort_order int, blurb text check length <= 140, created_by, created_at, updated_at, unique (location_id, un1t_product_row_id))`. Same grants as 6.5.1. A table, not the `customer_agent` blob, because product ids are per studio and validated by foreign key. **Claude's call (per E-8):** editing uses the same rule as Hatch's Mia settings, `canEditMiaSettings(user, locationId)` (owner at the studio or master, `src/lib/agent/settings-access.js:12-21`), not the broader `settings` permission. Reason: what Mia sells is part of how Mia behaves. No new permission key, so `check:mobile-parity` is not triggered.
- **Validation (E-5, Richard):** on save, the product must belong to the studio, be **active** (exact `status` value: builder reads live `un1t_products`) and cost more than €0 (D's `createCheckoutLink` refuses €0; the trial has its own path, 6.5). Public **and private** products are allowed; private ones carry a "Private" flag in the picker. At read time, an offer whose product is no longer active is skipped and flagged on the settings page.
- **Surface:** web only, a section "What Mia can sell" on Settings → Customer agent at a un1t.online studio: pick products, drag order, edit the blurb. Phone: no counterpart (Mia settings has no phone editor today); if the builder adds a permission key it goes in `WEB_ONLY_OK` with that reason.
- **Default (Claude's call):** empty until staff configure it. Reason: nothing is sold that nobody chose; an empty list keeps today's no-credits handoff. A "Suggested starter" button pre-fills 1 Class Credit, 5 Class Pack, 10 Class Pack and The Monthly Foundation Membership for staff to confirm.
- **API:** `GET/PUT /api/locations/[id]/mia-offers` (`assertLocationAccess`, `canEditMiaSettings` for PUT, studio membership for GET, 404 on a foreign id), registered in `src/lib/openapi.js`.

**Operator-editable copy** (new `customer_agent` keys in `settings-contract.js` DEFAULTS / `SettingsSchema` / builder, inheritable, null → code default in `default-copy.js`; no em-dashes, test-guarded):

| Key | Default |
|---|---|
| `purchase_offer_intro_text` | `You've used all your classes. Here's how to keep training with us:` |
| `purchase_link_text` | `Here's your secure payment link for {product}. Once it goes through I'll book you into {class}.` (no class: `...I'll let you know when it's done.`) |
| `purchase_link_open_text` | `You already have a payment link waiting for {product}. Use that one, or I can ask the team if you'd like something different.` |
| `purchase_paid_booked_text` | `Payment received, thank you! You're booked into {class}. See you there.` |
| `purchase_paid_class_gone_text` | `Payment received, thank you! {class} is no longer available, so I haven't booked it. Reply here and I'll find you another class.` |
| `purchase_paid_booking_failed_text` | `Payment received, thank you! I couldn't book {class} just now, so the team will sort it and confirm with you shortly.` |
| `purchase_paid_no_class_text` | `Payment received, thank you! It's on your account now. Would you like me to book you a class?` |
| `pay_done_page_text` / `pay_cancel_page_text` | `Thanks! You can go back to WhatsApp now.` / `No problem, nothing was charged. You can go back to WhatsApp.` |
| `chat_booking_unavailable_text` | `I can't book classes at {studio} from here just yet. You can book here: {link}` (no link: `...the team will help you book.`) |

## 7. Decided (Richard, 17 Oct)
- Decisions 3 (build and test, Richard switches on, replies only), 4 (book and cancel through the un1t.online API), 9 (new people get the public trial; D's path), 10 (upsell via `POST /purchases/checkout` with the member's userId; configurable list; minimise staff), 11 (live testing with MIA TEST), 12 (answer from the studio with an active membership, both if both). Mia stays on the Anthropic Messages API.
- **G1:** membership status and the pipeline are separate per studio; only the contact is shared. Mia reports each studio's membership on its own.
- **G4 / E-7:** the automated MIA TEST plan stops at getting a payment link. Richard tests actually paying by hand after go-live.
- **G7:** org-wide WhatsApp routing is a separate follow-up; nothing here sends a new outbound message through Stillorgan's number. E's sends are in-thread only.
- **G10:** the trial is the public "The UN1T Trial"; un1t.online enforces one per member; the CRM adds no check, handles a refusal cleanly, and MIA TEST verifies it (add a CRM check only if a second grant succeeds).
- **E-5:** the offer list may hold any active product, public or private, chosen by staff; private ones are flagged in the picker. (Was open question 1.)
- **E-6:** a double payment is refunded by Hatch staff in un1t.online, an accepted risk; Mia never sends a second live link while one is open. (Was open question 2.)

## 8. Claude's calls (for Richard to check)
1. **Claude's call:** credits holders count as "active" for decision 12 routing. Reason: a pack holder needs answers and bookings at that studio as much as a member does.
2. **Claude's call (E-1):** Hatch's tools are switched by Hatch's Mia gate plus the member-studio dispatch, not by `capabilities.bookings`; the four reads work before D's flip, the writes only once D's client is deployed and `writes_enabled`. Reason: reads need nothing from D, and the gate is the switch Richard already controls.
3. **Claude's call (E-8):** a Hatch-only member on a Stillorgan thread while Hatch is off is told Mia is looking at Hatch Street and handed off, never given Stillorgan's Glofox answer (a live Stillorgan change). Reason: today that member is told they have no membership.
4. **Claude's call:** action settings follow the studio the action runs at; voice, quiet hours and caps follow the thread. Reason: the studio that takes the booking or the money decides how.
5. **Claude's call (E-4):** a Hatch-only member on a Stillorgan thread gets Hatch's timetable and a short Hatch facts block; Stillorgan's knowledge never answers Hatch prices or timetable. Reason: Stillorgan's prices are wrong for Hatch.
6. **Claude's call (E-3):** booking and upsell are WhatsApp-only at first; on Instagram the write and purchase tools are not offered and hand off. Reason: the payment link and in-thread confirmation are built and tested on WhatsApp only.
7. **Claude's call (E-8):** never-trialled members are offered the trial first, through D's `grantTrial` (D-4 chain). Reason: nobody should be asked to pay before their free trial.
8. **Claude's call:** pending intents live in a new service-role table, not the approvals queue; one live link per member; 23h expiry. Reason: a pending link is not staff work, and 23h keeps the confirmation inside the WhatsApp window.
9. **Claude's call (E-8):** three detectors only: `/pay-done`, the post-sync hook, `check_my_purchase`; no watcher cron unless the builder shows the hook cannot cover it. Reason: the page and the tool cover the fast cases, the sync covers the rest within 15 minutes.
10. **Claude's call:** the paid-then-booked message sends with follow-ups off. Reason: it completes the member's own request.
11. **Claude's call (E-8):** the offer list is a new table edited by whoever may edit Hatch's Mia settings (`canEditMiaSettings`), web only, empty by default with a starter button. Reason: what Mia sells is Mia's behaviour.
12. **Claude's call:** attendance answers omit no-shows; the un1t timetable exposes `full` only, never `limited`. Reason: no-shows read as a telling-off; "limited" needs a count we never give the model.
13. **Claude's call (E-2):** two slices, reads first. Reason: members get correct answers weeks before writes are proven.
14. **Claude's call:** E owns Mia's approval branches and approval-suggest; both call D's `executeUn1tApproval`. Reason: one executor for every Hatch card.

## 9. Left to the builder
- Exact `un1t_bookings.status`, `un1t_products.status` / `visibility` and `access_mode` values (read live, read-only).
- Whether `GET /users/{id}/bookings` needs paging; how to label an event not yet mirrored.
- The ledger response's batch fields (enough for "balance went up" is enough).
- Widening `verify_identity`'s email pool to contacts with an active membership at the thread studio (crossover), if MIA TEST shows the gap.
- Next free migration number at build time (A-D land first). Slice 2's migration: the two tables only (no cron, so no heartbeat row unless the watcher fallback is needed).
- Whether a repeated `idempotency-key` on checkout returns the same hosted session (MIA TEST, up to the link only).
- Decision-log fields: `member_studios`, `tool_block`, intent id on purchase tools. Log module `mia-un1t` (`logWarn`/`logError`), every API failure with status and no token or PII.

## 10. Tests
- Dispatch: the four cases in 6.1, each with Hatch on, off and test mode; `readFailed` falls back to the thread studio.
- Glofox block, no-booking block and both prompts byte-identical to today (snapshot); a Stillorgan-only turn unchanged end to end.
- With `bookings` true on un1t.online, a Hatch turn never reaches a Glofox executor (anti-goal 3); with `bookings` and `memberships` false, a Hatch member still gets the four reads (E-1).
- Block selection: 3a in slice 1, on Instagram and with `writes_enabled` off; 3b only on WhatsApp with slice 2 and writes on. Write and purchase tools refused outside 3b even when named (invented-tool test); on Instagram they hand off. Tagged ids from another studio refused.
- Hatch-only member on a Stillorgan thread: Hatch timetable, Hatch facts block present, prompt rule present; Stillorgan knowledge not cited for Hatch prices (E-4).
- `list_upcoming_classes` payload has no capacity, bookings_count or limited field; full computed correctly.
- `get_my_recent_attendance` says no 7-day count.
- book, against a stubbed D client: `done`, `alreadyBooked`, `recovered`, refused full, refused no credit (upsell), refused unmapped (card with un1t.online's words), `unknown` (card, never "booked"), `UN1T_WRITES_OFF` (link or handoff, no card); draft mode; `origin 'mia'` and `originRef` passed; never `bypassCredit`.
- cancel: done, late-cancel refusal, "already happened", unknown; never `forceRefund`.
- Approval: Mia's un1t cards go to `executeUn1tApproval`, ACCOUNT_MISMATCH refuses, past-start expires, confirmation sent in-thread.
- Upsell: offer list ordering, private flag, €0 products refused on save, inactive skipped; trial offered only when the mirror shows none, trial refusal drops it cleanly; `grantTrial` used, never checkout, for the trial; one live link per member (unique index, PGlite); same product re-uses the key; different product refused with `purchase_link_open_text`; `createCheckoutLink` called with `userId`, not a contact id; three detectors racing settle once (CAS); class full / passed / failed messages; `free: true`; expiry silent; `window_closed`.
- `/pay-done`: in all four allowlists (`public-compliance-paths.test.jsx`), loading it never marks paid on its own, rate-limited, no personal data rendered.
- Copy defaults contain no em-dash or en-dash; every key round-trips through `buildCustomerAgentSettings`.
- Migration test: tables, grants (`table-default-acl-guard`), unique index. `check:select-columns`, `check:rpc-names`, `check:location-scoping`, `check:route-guards`, `tests/whatsapp-config-callers.test.js` (new caller rows for the settle sender).

## 11. Rollout and live verification
**Slice 1 (reads):**
1. Merge with Hatch off. Verify Stillorgan unchanged (decision log: same tool block hash, same replies on a replayed sample).
2. Richard (or Claude on his word) sets at Hatch's **studio layer** `followups.enabled = false` and `first_class_checkin.enabled = false` as explicit overrides (both inherit per field from `org_settings.customer_agent`, so an org default copied from Stillorgan would otherwise switch them on at Hatch), and `booking_url` for the slice-1 fallback.
3. Test mode: Hatch `enabled = false`, `test_mode = true`, `test_phones` = the MIA TEST phone only (enabled + test_mode is live for everyone). MIA TEST asks membership, credits, next class, upcoming bookings, attendance (no 7-day number), timetable (no numbers, full only), and "book me in" (link or handoff, never "booked"). Repeat once from a Stillorgan-filed thread for a Hatch-only contact (Hatch facts, no Stillorgan prices).
4. Richard may switch Hatch on for replies (`enabled = true`) at this point, or wait for slice 2.

**Slice 2 (writes + upsell), after D's own live test:**
5. Hatch `writes_enabled` on (D's switch), offer list configured, copy reviewed, `booking_mode` `auto`, Hatch back in test mode for MIA TEST.
6. MIA TEST script, up to the link only (G4): book a class with credits; book it again (already booked); cancel it; with credits at zero ask to book, get the trial offer (expect un1t.online's refusal if MIA TEST already had the trial: it drops cleanly) then the paid offers; pick 1 Class Credit and receive a link; **do not pay**; ask for the same product again (same link); ask for a different product (`purchase_link_open_text`, no second link); open the cancel URL and the success URL (copy, no "paid"); say "I've paid" (`check_my_purchase` finds nothing, says so); after 23h the intent is `expired`, silently. On Instagram: a booking request hands off. Check every `agent_membership_requests`, `un1t_write_events` (`origin 'mia'`) and `mia_purchase_intents` row, and that un1t.online shows exactly one booking per step and no purchase.
7. D flips `bookings` only with slice 2 deployed (anti-goal 3).
8. Richard switches Hatch on (`enabled = true`). Replies only. **Richard tests the paid path himself** (G4): a real small purchase, confirming the booking lands and the message arrives, then a refund in un1t.online. Watch the decision log and intents for a week before anyone discusses follow-ups.

## 12. Dependencies on siblings
- **D** (hard, slice 2 only): `book`, `cancel` (with D's dedupe read inside), `grantTrial` (D-4 chain), `createCheckoutLink(db, { locationId, userId, productId, idempotencyKey, successUrl, cancelUrl, origin, originRef })` → `{ checkoutUrl, free }` (D-3), `executeUn1tApproval`, the `un1t_write_events` ledger, `applyUn1tWriteToMirror`, `writes_enabled` and the permission check, the per-request rate budget (D-7), the MIA TEST account and test route, and the `bookings` flip timing. D has no checkout return page; `/pay-done` is E's (D-3). Slice 1 needs only D's read helper `getOne` (or adds it).
- **A**: the invoices / past-due seam read for `get_my_payment_reminder`, and the `invoices` flip.
- **C**: none at runtime; C guarantees no CRM reminders or attendance pushes for bookings Mia makes at Hatch, and D's mirror writes C's `class_bookings` row.
- **B**: none.

## 13. Open questions only Richard can answer
None. Both earlier questions were answered on 17 Oct (private products allowed, E-5; double payment refunded by Hatch staff, E-6) and are in section 7.
