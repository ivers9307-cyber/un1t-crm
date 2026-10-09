# Move an event entry to another event (EVENT-MOVE)

**Date:** 2026-10-08
**Status:** approved 8 Oct 2026; built on branch `event-registration-move` (PR 1, staff). Updated during the build to match what shipped.
**Repo:** un1t-crm · Events applet (`race_events` system)

## Problem

A customer who has booked an event sometimes needs a different date. Today staff
have two bad options: cancel the entry and ask the customer to rebook and pay
again (refunds are a separate manual step in Orders), or edit nothing and keep a
note. There is no way to carry the entry, its people, its payment and its
history from one event to another. Hosts, who run their own events in the host
portal, have no attendee actions at all.

The only "move" that exists is between waves of the same event
(`moveRegistrationWave` in `src/lib/race-cancel.js`). Mia's `reschedule_event_wave`
tool tells the customer that a different event means cancel plus rebook.

## Decisions (Richard, 8 Oct 2026)

| Question | Decision |
|---|---|
| Data model | **Re-point the existing registration row** to the new event and wave. Its payment and order follow it. A new `registration_moves` table holds the history. |
| Price gap | **Show it, move anyway.** The dialog shows the per-person and total difference. The move goes ahead, the gap is recorded on the move row and shown on the card. Staff collect it with a payment link or leave it. Nothing is charged or refunded automatically, ever. |
| Customer email | **Yes, ticked by default.** A "your entry has moved" email with the new date, wave and fresh QR codes. Staff can untick it per move. Copy is operator-editable. |
| Scope | **Staff first, host next.** PR 1 is the migration, the shared move function, the staff route, dialog and chips. PR 2 adds the host portal action on the same function. Mia later, through approvals. |
| Unit of move | **The entry (one `race_registrations` row), not the team.** Today every entry is a team (a solo is a team of one). Soon there will be single-person bookings with no team. Code and copy must not assume a team. |
| Across studios | **Allowed** (Richard, 8 Oct, second pass). Same payee is still required. Teams are unique per studio and team-member edits are authorised on the team's home studio, so a cross-studio move **clones the team into the target studio** inside the same transaction and points the entry at the clone. The original team row stays with its history. |
| Full wave | **Staff may force it** (Richard, 8 Oct, second pass). Without `force` a full wave refuses with `wave_full`. The dialog then shows "This wave is full" with two choices: **Move anyway** (resends with `force: true`) or **Don't move**. A forced move is recorded as `forced = true` on the history row. |

## Terminology

- **Entry** — one `race_registrations` row. It is what moves. In UI copy say
  "entry", never "team", unless naming the specific team.
- **Entry label** — what the UI calls a given entry: the team name when the
  entry has a team of two or more, otherwise the lead person's name. One helper,
  `entryLabel(registration)`, owns this.
- **Headcount** — the number of people on the entry. Derived from
  `team_members` today, falling back to `teams.size` when the roster is not
  loaded; for a future team-less entry it is 1. One helper,
  `entryHeadcount(registration)`, owns this and is the only place that may
  read `teams.size`.
- **Lead contact** — `race_registrations.contact_id`. The person who booked and
  who receives the email. Called "captain" only inside team UI. The address
  used for the email and the contact event is one rule, `entryLeadEmail`:
  the lead contact's email, else the captain's, else the first member with
  one, else the `contact_email` of the completed payment (or, failing that,
  the newest payment row); none at all is logged
  at error level and the move still stands.
- **Not emailed** — a move whose email failed or was skipped leaves
  `registration_moves.notified_at` null; the move route returns
  `notified: false` and the teams page chip says "not emailed" so staff can
  tell the customer themselves.
- **Payee** — who the money went to: `race_events.host_id` (NULL = UN1T on
  Revolut). Two events share a payee when their `host_id` values are equal,
  treating NULL as equal to NULL.

## Rules

A move is **refused** unless all of these hold. Each failure has its own
error code so the dialog can say exactly why.

| Code | Rule | Why |
|---|---|---|
| `not_found` | Source entry exists | |
| `not_active` | Source status is `confirmed` | Cancelled and no-show entries are history. |
| `pending_payment` | Source status is not `pending_payment` (EVENT-MOVE.4; `force` does not skip it) | The customer's existing payment link (the Stripe Checkout session or Revolut order) still carries the source event's price and id; paid after a move, the webhook would confirm the entry on the target at the source's price. Collect payment first, or cancel and rebook, then move it. |
| `checked_in` | No `race_checkins` row for the source entry, and `race_started_at` / `race_finished_at` are both null | The customer already attended or raced; results and penalties must not follow an entry to another event. |
| `same_event` | Target event differs from the source event | Wave changes use the existing wave select. |
| `target_unavailable` | Target is `active`, `status = 'published'` and its date is today or later | Never move someone onto a draft or a past event. |
| `different_payee` | Target `host_id` equals source `host_id` (NULL equals NULL) | UN1T and each host are different merchants. Money cannot follow across them. |
| `already_entered` | No entry of ANY status on the target for the same `team_id` (when the entry has a team and the target is at the same studio) | `UNIQUE (race_event_id, team_id)` has no status condition, so a cancelled row would still reject the write; refuse first with a clear message that says a cancelled one counts. A cross-studio move gets a fresh team row, so it cannot collide. |
| `headcount_not_allowed` | Target `allowed_team_sizes` includes the entry's headcount (when the array is set) | A team of four cannot move to a solo-only event. |
| `wave_required` | A target wave is given when the target has waves | |
| `wrong_event` | The target wave belongs to the target event | |
| `wave_full` | The target wave has room for the entry's headcount, using the target's `capacity_mode` and the existing `event-signups.js` helpers, **unless `force` is true** | Same arithmetic the public register route uses: it counts **confirmed** entries only, so an entry awaiting payment holds no spot (a pre-existing property of `computeSignupCounts`, kept for consistency). The refusal carries `spots_left` so the dialog can say how full it is. |
| `load_failed` / `write_failed` | The entry and the target waves could be read / the SQL function succeeded | Database errors are named, never folded into `not_found`, and a failed wave read **fails closed** (no move, "try again"). A missing or unreadable target is `target_unavailable`. |
| `conflict` | Under the row lock, the SQL function re-checks that the source event is the one the caller judged, the status is still live, nobody has checked in or raced, and the wave belongs to the target | Two staff moving the same entry at once, or a check-in landing between the JS checks and the write, must not produce a bogus history row or a second email. |

A move across studios is allowed. The caller must hold the `races` permission
and a manager role at **both** studios (the staff route checks both; the host
route's `allowedEventIds` already restricts hosts to their own events).

A **price gap** is `(target per-person fee − source per-person fee) × headcount`,
using the member or non-member fee per person according to each person's
`is_member` flag, in cents. It can be negative. It is recorded, shown, and
never acted on by code.

## Data model (migration 708)

### `registration_moves`

One row per move, written in the same transaction as the move itself.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `registration_id` | uuid → `race_registrations` ON DELETE CASCADE | The entry that moved. Same id before and after. |
| `from_event_id` | uuid → `race_events` ON DELETE SET NULL | |
| `from_wave_id` | uuid → `race_waves` ON DELETE SET NULL | |
| `to_event_id` | uuid → `race_events` ON DELETE SET NULL | |
| `to_wave_id` | uuid → `race_waves` ON DELETE SET NULL | |
| `headcount` | int | At the time of the move. |
| `price_gap_cents` | int | Signed. 0 when prices match. |
| `actor_type` | text check in (`staff`, `host`, `agent`) | |
| `actor_id` | uuid null | profiles id for staff, host_users id for host, null for agent |
| `actor_name` | text | Snapshot for display, so the chip never needs a join. |
| `note` | text null | Internal, optional. |
| `notified_at` | timestamptz null | Set when the moved email was sent. |
| `forced` | boolean default false | True when the wave was full and the operator chose Move anyway. |
| `from_team_id` | uuid → `teams` ON DELETE SET NULL | The team before the move. Equals `to_team_id` unless the move crossed studios. |
| `to_team_id` | uuid → `teams` ON DELETE SET NULL | The team after the move. |
| `created_at` | timestamptz default now() | |

Indexes on `registration_id`, `from_event_id`, `to_event_id`. RLS enabled,
service-role only (same posture as `event_reminder_sends`): the migration
states `REVOKE ALL ON public.registration_moves FROM anon, authenticated`
(mig 677 default, made explicit). Staff and host routes read it through the
service-role client after their own authorization.

### `race_events` email copy

Two new nullable columns, following the existing `confirmation_email_*` and
`reminder_email_*` pattern so `resolveEventEmail` can take `kind: 'moved'`:

- `moved_email_subject text`
- `moved_email_intro text`

Defaults live in code, not the column (`buildMovedDefaults` in
`race-confirmations.js`): subject `Your entry has moved to <new event>`, and an
intro paragraph naming the old event with its date and wave and the new event,
above the new date, wave and place in the info rows and the fresh QR codes. As
with the other two kinds, `moved_email_intro` replaces the grey "what's next"
box. Both are editable on the event form's Emails section beside the existing
two. The merge tags `old_event_name` and `old_when` (the old date and wave
together, e.g. `Saturday 18 October 2026 · 11:00`) are added to
`applyEventMergeTags` extras; only this kind sets them, so they render blank
elsewhere. The new event is `{{event_name}}` and `{{when}}` (its wave, or its
date when it has none), as in the other two.

### SQL function `move_race_registration`

Supabase JS has no transactions, so the writes run inside one Postgres function
called through `db.rpc(...)`. It is created in the migration (so
`check:rpc-names` can see it) with
`REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`; only the service role
calls it. Every eligibility check above runs in JS first, where it is
readable and unit-tested; the function takes `p_from_event_id` (the source
the caller judged) and, under `SELECT ... FOR UPDATE`, re-checks the cheap
invariants (source unchanged, status live, not checked in or raced, wave on
the target) and raises `conflict` if any moved underneath. "Live" there still
includes `pending_payment` (as it does for `already_entered` and capacity
counting); the JS `pending_payment` rule is what refuses an unpaid entry. The existing
unique constraint remains the last line of defence.

Writes, in order:

0. **Only when the target studio differs from the source studio:** insert a
   new `teams` row at the target `location_id` with the same `name`, `size`
   and `captain_contact_id` (on a name clash under `UNIQUE(location_id, name)`
   append ` (2)`, ` (3)`, … until it fits), copy every `team_members` row
   (`name`, `email`, `phone`, `role`, `contact_id`, `is_member`,
   `member_validation_status`, `member_contact_id`, `member_validated_at`)
   onto it, and use the new id as `to_team_id`. (`team_members` has no
   `phone` column; the booking phone lives on `race_payments`.) The original team row and
   its members stay untouched for the source event's history. Entries with
   no team (future) skip this step.
1. `race_registrations`: set `race_event_id`, `wave_id`, `team_id`
   (`to_team_id`), `updated_at`.
2. `race_payments` where `race_registration_id = $reg`: set `race_event_id`.
   Amounts, provider refs and the connected account stay as they are.
   `orders` rows need no change: they hold no event id, only the studio
   that took the money. On a cross-studio move that stays as it is on
   purpose: the money landed under the source studio's books, so the order
   record stays there while the entry and its payment follow the move.
   `syncOrderFromRacePayment` therefore keeps an EXISTING order's
   `location_id` and `organization_id` on every later upsert (it used to
   re-derive them from the payment's event each time, which would have
   silently re-homed the order at the next status change). **Open for
   Richard:** whether a cross-studio move should instead carry the order to
   the target studio's books.
3. `event_reminder_sends` where `registration_id = $reg`: delete, so the 3-day
   and 1-day reminders fire again for the new date. For the same reason delete
   the `race.starts_in_24h` / `race.starts_in_1h` rows in `contact_events` for
   this registration (they are keyed per registration by
   `uq_contact_events_time_anchored`), so the timing cron can emit them for
   the new date.
4. `registration_moves`: insert the history row. Return it.

Nothing is written to `race_checkins`, `race_penalties` or `promo_codes`;
`teams` and `team_members` are only ever inserted (the clone), never updated. `promo_code_id` stays on the entry as a
record of what was redeemed.

## Shared function

`src/lib/registration-move.js`

```js
export async function moveRegistration(db, {
  registrationId, targetEventId, targetWaveId,
  actor: { type, id, name },
  note,
  notify,            // boolean; default true
  force,             // boolean; default false. True skips the wave_full rule
  allowedEventIds,   // optional Set; the host caller passes its own event ids
})
// → { ok: true, move, registration, notified } | { ok: false, error: <code>, spots_left? }
```

Steps: load source entry with team, members, wave and event; load target
event with waves; run every rule in the table; compute headcount and price
gap; call the SQL function; then, outside the transaction, run the
after-effects and never let one of them fail the move:

- `emitEvent` a new `race.moved` contact event (`EVENT_TYPES.RACE_MOVED` in
  `contact-events.js`, matching the existing `race.*` names) for the lead
  contact, with from/to ids.
- Insert an `activities` timeline line on the lead contact:
  "Entry moved from <from event> to <to event> by <actor>".
- `addEventAttendeesToHostList(db, targetEventId)` when the target has a host.
- When `notify` is true, send the moved email (below) and stamp
  `registration_moves.notified_at`.

Also exported:

- `listMoveTargets(db, { registrationId, allowedEventIds, allowedLocationIds })`
  → the eligible target events (same payee, published, upcoming, not the
  source; at any studio in `allowedLocationIds`, null meaning every studio)
  each with its waves and `spots_left` per wave in the target's capacity
  unit, plus the studio name so the picker can show it. Events whose
  `allowed_team_sizes` exclude the entry's headcount are left out. Used by both dialogs. Staff and hosts are operators, so spots
  are shown to them; this endpoint is never public.
- `entryLabel(registration)`, `entryHeadcount(registration)` and the error
  tables live in `src/lib/registration-entry.js`, the browser-safe half (no
  server imports), re-exported from `registration-move.js`. The dialog
  imports from `registration-entry` so no server code reaches the bundle.
- `computePriceGapCents({ sourceEvent, targetEvent, members })`.

`moveRegistrationWave` in `race-cancel.js` stays as it is for same-event wave
changes.

## Moved email

`sendRegistrationMovedEmail(db, { registrationId, moveId })` in
`src/lib/race-confirmations.js` next to `sendRaceConfirmations`. It reuses the
same shell, consent gate (`email_administrative`, unrecoverable), QR minting per
member and Postmark send, with tag `event-moved`. It resolves copy with
`resolveEventEmail({ kind: 'moved', race: targetEvent, extras })`. It is not
gated by `confirmation_email_sent_at`; the move row's `notified_at` is its
send-once guard. SMS is not sent for moves in v1.

The QR tokens embed the target event id, so the new tickets scan at the new
event and the old tickets are refused at the old one. No change to the scan
route.

## Staff surface (PR 1)

### Routes

- `GET /api/event-registrations/[id]/move-targets` → `listMoveTargets`.
- `POST /api/event-registrations/[id]/move` body
  `{ target_event_id, target_wave_id, notify, note, force }` → `moveRegistration`.
  A `wave_full` refusal returns 409 with `{ error: 'wave_full', spots_left }`.

Auth on both: `getCurrentUser`, the `races` permission and a `MANAGER_ROLES`
role at the source event's studio (matches the cancel route) with
`assertLocationAccessOr404` on it. The move route repeats the permission,
role and access checks on the **target** event's studio. The targets route
passes `getUserLocationIds(user)` as `allowedLocationIds`. Zod schema for the body, validated AFTER the source-studio gate so an
unauthorised caller never learns the body was bad. Every refusal carries
`error` (the code) and `message` (from `MOVE_ERROR_MESSAGES`): `not_found`
404, `wave_full` and `conflict` 409, `load_failed` and `write_failed` 500,
every other rule 400. A non-UUID id is a 404 with no read. The move route
passes `expectedSourceEventId` so the lib refuses `conflict` if the entry
moved between the route's own read and the lib's. The Move action on the
teams page is gated by the same rule as the route (manager role plus
`races` at the event's studio), so staff who may cancel but not move never
see a button that would 403. Under impersonation the recorded actor is the
real caller.

- `GET /api/events/[id]/teams` additionally returns `moved_out`: moves whose
  `from_event_id` is this event, with the entry label, target event name and
  date, actor name and time. It also attaches `last_move` to each registration
  whose latest move has `to_event_id = this event`, for the chip.

### UI

- `RaceTeamsManager.jsx` card: a new **Move to event** action beside the wave
  select. Shown only when status is `confirmed`: hidden on cancelled and
  no-show entries, and on entries awaiting payment (they keep their Payment
  link / Text link actions; see the `pending_payment` rule). It opens
  `MoveEntryDialog`.
- `src/components/MoveEntryDialog.jsx` (flat `components/` dir, the repo
  convention): title "Move <entry label> to another event"; target event
  select (from move-targets, grouped by studio when more than one studio is
  listed); time select showing "N left" or "full"; price-gap notice when
  non-zero (warning tint, per-person average and total, and that nothing is
  charged or refunded by the move); a studio notice when the target is at
  another studio ("This moves the entry to <studio>." plus "<team> is copied
  there." only for a team of two or more); "Email <lead first name> the new
  tickets" checkbox, ticked, naming the person `entryLeadEmail` resolves;
  optional internal note; Cancel / Move entry. When the server answers
  `wave_full`, the dialog replaces its footer with "This time is full (N
  left). Move anyway?" and two buttons: **Move anyway** (resends with
  `force: true`) and **Don't move** (back to the form, no second request).
  Every other refusal, `conflict` included, shows its `message` inside the
  dialog; a non-JSON answer tells staff to reload and check before retrying.
  After a move whose email did not go out, the dialog hands the teams page
  an amber notice ("Moved. The customer could not be emailed; tell them
  yourself."), never the red error banner. Empty-state copy when there are no eligible targets:
  "No other upcoming events are paid to the same host."
- Card chips after a move in: "Moved from <event>" (tooltip: actor, date,
  and "wave was full" when forced), "€X difference outstanding" when the gap
  is positive, and "Not emailed" when `notified_at` is null.
- Source event footer: "N moves to other events" expanding to one line per
  move (label → event, date, actor). Hidden when zero.
- **Settling the gap (EVENT-MOVE.3, mig 709).** Beside "€X difference
  outstanding" staff who may move entries see two actions, **Collected** and
  **Waived** (after a confirm). `POST
  /api/event-registrations/[id]/moves/[moveId]/settle` with `{ how }` records
  `gap_settled_at`, `gap_settled_how` and `gap_settled_by_name` on the move
  row (the real caller under impersonation), gated like the move route at the
  entry's CURRENT event studio; the move must belong to the entry; a move with
  no positive gap answers `no_gap`; the write is a compare-and-set on
  `gap_settled_at IS NULL`, so a second click, or a colleague settling first,
  answers `unchanged: true`. Once settled the chip disappears and the "Moved
  from" tooltip notes "difference collected|waived by <name> on <date>". It
  records a decision staff made elsewhere (a payment link, cash, a waiver);
  no money moves. Staff only: the host table shows no gap chip.
- The event form's Emails section gains the two moved-email fields.

## Host surface (PR 2)

- `src/app/host/(portal)/events/[id]/page.js` attendee table regroups by entry
  (one row per entry, people listed in a cell) and gains a **Move** action per
  live entry. Entries awaiting payment show "Pay first" instead: their payment
  link is priced for the source event (the `pending_payment` rule).
- `GET /api/host/registrations/[id]/move-targets` and
  `POST /api/host/registrations/[id]/move`: `getCurrentHost()`, the entry's
  event must have `host_id === session.host.id` (404 otherwise), and
  `allowedEventIds` is the set of that host's own events, so the same-payee
  rule is enforced twice. `actor_type = 'host'`, `actor_id = event_hosts.id`,
  `actor_name = host.name` ("<admin email> as <host name>" under admin
  view-as). An entry awaiting payment is refused with `pending_payment`
  (400, the lib's message) before the body is read, which the lib cannot do;
  the lib refuses it for staff too (EVENT-MOVE.4). The
  same status mapping as the staff route otherwise, except that host routes
  have no 403 at all: there is no permission concept, every refusal is a 404.
  The own-events fence query is limited to published, active, upcoming
  events (targets only; the source may be past or unpublished).
- Same `MoveEntryDialog`, unchanged, with `targetsUrl`/`moveUrl` pointed at
  the host routes. It keeps its light panel on the dark host page (the shared
  Modal primitive); the table around it is host-dark. Same price-gap notice,
  since the host's own prices differ between their events. Hosts may force a
  full wave too (it is their capacity); recorded the same way. After a move
  the page re-renders with `router.refresh()` (not a full reload, which
  would wipe the "not emailed" notice before the host could read it; the
  moved entry has left this page's rows, so the notice is the only trace).
  The People cell lists each person with their email, as the old table did.
- The move-history reads (`last_move` per entry, moves out of the event) are
  one shared loader, `src/lib/registration-move-history.js`, used by the
  staff teams route and the host page. Footer "N moves to other events" as
  on the staff page; chips "moved in <date>" and "Not emailed". The gap chip
  is not shown on the host table in PR 2.

## Paying the gap (EVENT-MOVE.5, mig 710)

A payment can be the price difference of a move: `race_payments.kind` is
`entry` (every existing row, every entry insert by default) or `move_gap`,
and a gap payment carries `registration_move_id`. `createGapPayment` mints
it through the same provider adapters and the same `/event-pay/[paymentId]`
embedded checkout: amount = `price_gap_cents`, no platform fee (the
per-ticket fee was taken on the entry), the event's currency and merchant,
Revolut idempotency key `move:<id>:<n>`, and a pending gap payment for the
move is reused rather than minted twice. It never touches
`active_payment_id` or the registration.

On completion (webhook or the checkout page's provider refresh) a gap
payment writes its status, syncs its order, emits `ORDER_COMPLETED`
(`kind: move_gap`), settles the move through the EVENT-MOVE.3 compare-and-set
as `collected` by "Customer (paid online)", and sends the gap RECEIPT
(fixed transactional wording, "Difference paid for <event>"). The status
write is a compare-and-set on the status the caller read, so a webhook and
the checkout page's refresh cannot both complete one payment, and the
refresh path re-reads the full row first. It never re-runs entry side effects: no registration status change, no host
contact-list sync, no tag rules, no sequences, no entry confirmation, no
Glofox push. Failed, abandoned and refunded gap transitions likewise skip
tag rules and sequences; a refund leaves the move settled (staff decide).
Readers that take "the latest payment" (the teams list, the moved email's
Total paid) skip gap rows.

Only one pending gap link can exist per move (a unique partial index);
a reused link is refreshed with the provider first and re-minted when it
has expired (Stripe sessions last about 24 hours, and the link email says
so). The checkout page says "expired" or "already settled" instead of
mounting when that is the case, and settling a gap by hand abandons its
pending links. The gap-link and settle routes refuse a non-confirmed entry.
Staff: **Send payment link** beside the chip (confirm first) posts to
`POST /api/event-registrations/[id]/moves/[moveId]/settle`'s sibling
`.../gap-link` `{ email }`, gated identically (a settled move answers 409
`already_settled`), which mints or reuses the link, emails it when asked,
and returns the URL (also copied to the clipboard). The link email resolves
through `resolveEventEmail({ kind: 'gap' })` with the operator-editable
`gap_email_subject/intro` on the event form and the merge tags
`{{difference}}`, `{{old_event_name}}`, `{{pay_url}}`; it always carries a
pay button. The checkout page labels a gap
payment "Price difference" and shows no roster. EVENT-MOVE.6 (customer
self-service) carries `metadata.pending_move` on the same kind so the move
lands when the difference is paid.

## Mia (EVENT-MOVE.7, mig 711)

Two agent tools. `list_event_move_options` shows a verified customer the
dates their confirmed entry can move to: the same eligibility as staff's
`listMoveTargets`, scoped to the conversation studio's organisation, with
only the times the entry fits (teams-mode: one place; people-mode: its
headcount), as name, date, time and a price-difference sentence (a team's
difference is stated in total). It never returns capacity, spots or
counts. `move_event_entry` never moves: it files an
`agent_membership_requests` row of kind `event_move` (pending, one per
entry at a time) and notifies approvals; Mia says the request is with the
team and, when the new date costs more, that the team will send a link for
the difference. `reschedule_event_wave` stays for a time change on the same
event and points to these tools for a different event.

Approving the card runs `moveRegistration` with
`actor = { type: 'agent', name: 'Mia, approved by <staff>' }`, `notify: true`,
no force, and `expectedSourceEventId` from the request; the customer gets
an operator-editable confirmation in the thread (`event_move_confirmation_text`),
or an operator-editable plain reason on refusal (`event_move_failed_text`);
decline uses the existing notice. A conflict whose entry is already on the
target is recorded as done. The approvals card summary, failure explanation
and done line for `event_move` live in a web-only module
(`src/lib/approvals/event-move-card.js`); `shared/**` is untouched so no
phone OTA is published, and the phone shows a generic card until a later
release.

## Customer self-service move (EVENT-MOVE.6, mig 712)

The person who booked can change the date themselves. Both the entry
confirmation and the moved email carry a "Need a different date? Change it
here." line (merge tag `{{manage_url}}`; operators who write their own intro
keep the link by using the tag). The link is a signed entry token (HMAC on
the service-role key, kind-tagged, 90-day expiry) opening `/event/entry/[token]`,
a public page outside the staff shell and on all four public-path allowlists.

The page shows the entry and, when it may move, the dates it can move to: the
same eligibility staff see, fenced to the entry's organisation, listing only
times with room, as date, time and a price note. Never any capacity, spots or
counts. An unpaid, cancelled, no-show, checked-in or past entry cannot move
and the page says why in one sentence. A customer can never force a full
time. Every bad or expired token is a 404.

An equal-or-cheaper date moves at once (`actor_type = 'customer'`, the lead
contact), with the moved email and fresh QR codes; nothing is refunded. A
dearer date is paid for first: the move route mints a `move_gap` payment
(EVENT-MOVE.5) carrying `metadata.pending_move` (target, time, the source the
customer judged, the actor) and sends them to the same embedded checkout,
with their own entry token carried back in the URL fragment so the checkout
returns them to the entry page. When the payment completes, the stored move
runs under the same rules, the payment is linked to the new move row and
settled as collected; if the move is refused after payment (the time filled
meanwhile), the payment stays recorded, the failure is written on it, an
`error_events` row pages Sentinel, and the receipt says the team will be in
touch. A paid amount that no longer matches the gap recomputed at landing is
recorded as a mismatch and, if underpaid, left outstanding for staff. A new
dearer change closes the customer's older pending links, and an immediate
move closes them too, so two changes can never both be paid. Each customer
gap link uses its own provider idempotency key.

Tokens cannot be revoked per entry (rotating the service-role key revokes
them all), as with every other public token in the repo.

## Testing

- Unit (vitest): every rule in the table with a fake db; price gap for member,
  non-member and mixed entries, both signs; `entryLabel` and `entryHeadcount`
  for a team, a team of one, and an entry with no team; `listMoveTargets`
  filters and spots arithmetic for both capacity modes.
- Route tests: auth matrix (no user, no permission, non-manager, wrong
  location), schema rejection, error-code mapping, happy path calls the lib
  with the actor from the session.
- `check:select-columns` covers the new selects.
- Migration: applied by Claude through the Supabase MCP BEFORE the PR merges
  (the code selects the new columns), forward-only, then `get_advisors`. The SQL function is exercised once against a real entry on a
  Vercel preview after apply, and the resulting rows checked by hand.
- Host PR adds the host auth matrix and the `allowedEventIds` fence test.

## Non-goals (v1)

- Moving money in either direction, or minting a payment link automatically.
- Moves across payees.
- Moving one person out of a team onto a different event.
- SMS or WhatsApp on move.

## Open follow-ups

- A "Send payment link for €X" action from the chip, once the first real
  gap turns up (settling is EVENT-MOVE.3; collecting is still manual).
