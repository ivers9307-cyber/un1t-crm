# Move an event entry to another event (EVENT-MOVE)

**Date:** 2026-10-08
**Status:** design agreed with Richard (decisions below), awaiting spec review
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
  `team_members` today; for a future team-less entry it is 1. One helper,
  `entryHeadcount(registration)`, owns this. Never read `teams.size` directly.
- **Lead contact** — `race_registrations.contact_id`. The person who booked and
  who receives the email. Called "captain" only inside team UI.
- **Payee** — who the money went to: `race_events.host_id` (NULL = UN1T on
  Revolut). Two events share a payee when their `host_id` values are equal,
  treating NULL as equal to NULL.

## Rules

A move is **refused** unless all of these hold. Each failure has its own
error code so the dialog can say exactly why.

| Code | Rule | Why |
|---|---|---|
| `not_found` | Source entry exists | |
| `not_active` | Source status is `confirmed` or `pending_payment` | Cancelled and no-show entries are history. |
| `checked_in` | No `race_checkins` row for the source entry | The customer already attended. |
| `same_event` | Target event differs from the source event | Wave changes use the existing wave select. |
| `target_unavailable` | Target is `active`, `status = 'published'` and its date is today or later | Never move someone onto a draft or a past event. |
| `different_payee` | Target `host_id` equals source `host_id` (NULL equals NULL) | UN1T and each host are different merchants. Money cannot follow across them. |
| `already_entered` | No entry of ANY status on the target for the same `team_id` (when the entry has a team and the target is at the same studio) | `UNIQUE (race_event_id, team_id)` has no status condition, so a cancelled row would still reject the write; refuse first with a clear message that says a cancelled one counts. A cross-studio move gets a fresh team row, so it cannot collide. |
| `headcount_not_allowed` | Target `allowed_team_sizes` includes the entry's headcount (when the array is set) | A team of four cannot move to a solo-only event. |
| `wave_required` | A target wave is given when the target has waves | |
| `wrong_event` | The target wave belongs to the target event | |
| `wave_full` | The target wave has room for the entry's headcount, using the target's `capacity_mode` and the existing `event-signups.js` helpers, **unless `force` is true** | Same arithmetic the public register route uses. The refusal carries `spots_left` so the dialog can say how full it is. |

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

Defaults live in code, not the column: subject
`Your entry has moved to {{event_name}}`, intro
`Your entry for {{old_event_name}} has moved to {{event_name}} on {{event_date}} at {{wave_time}}. Your new tickets are below.`
Both are editable on the event form's Emails section beside the existing two.
The merge tags `old_event_name`, `old_event_date` and `old_wave_time` are added
to `applyEventMergeTags` extras for this kind only.

### SQL function `move_race_registration`

Supabase JS has no transactions, so the writes run inside one Postgres function
called through `db.rpc(...)`. It is created in the migration (so
`check:rpc-names` can see it) with
`REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`; only the service role
calls it. It performs only the writes; every eligibility
check above runs in JS first, where it is readable and unit-tested. The
function still relies on the existing unique constraint as a last line of
defence and raises if it fires.

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
3. `event_reminder_sends` where `registration_id = $reg`: delete, so the 3-day
   and 1-day reminders fire again for the new date.
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
// → { ok: true, move, registration } | { ok: false, error: <code>, detail? }
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
  unit, plus the studio name so the picker can show it. Used by both dialogs. Staff and hosts are operators, so spots
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
passes `getUserLocationIds(user)` as `allowedLocationIds`. Zod schema for the body. Errors map to 4xx with the code and a
plain-English message.

- `GET /api/events/[id]/teams` additionally returns `moved_out`: moves whose
  `from_event_id` is this event, with the entry label, target event name and
  date, actor name and time. It also attaches `last_move` to each registration
  whose latest move has `to_event_id = this event`, for the chip.

### UI

- `RaceTeamsManager.jsx` card: a new **Move to event** action beside the wave
  select. Hidden when status is cancelled or no-show. It opens
  `MoveEntryDialog`.
- `src/components/events/MoveEntryDialog.jsx`: title "Move <entry label> to
  another event"; target event select (from move-targets, grouped by studio
  when more than one studio is listed); wave select showing spots left and
  "full"; price-gap notice when non-zero (warning tint, states the per-person
  and total difference and that nothing is charged by the move); a studio
  notice when the target is at another studio ("This moves the entry to
  <studio>. The team is copied there."); "Email <lead first name> the new
  tickets" checkbox, ticked; optional internal note; Cancel / Move entry.
  When the server answers `wave_full`, the dialog replaces its footer with a
  warning, "This wave is full (N of M)", and two buttons: **Move anyway**
  (resends with `force: true`) and **Don't move** (back to the form). Empty-state copy when there are no eligible targets:
  "No other upcoming events are paid to the same host at this location."
- Card chip after a move in: "Moved from <date> · by <actor> · <when>", plus
  "€X difference outstanding" in the subtitle when the gap is positive.
- Source event footer: "N entries moved to other events" expanding to one line
  per move. Hidden when zero.
- The event form's Emails section gains the two moved-email fields.

## Host surface (PR 2)

- `src/app/host/(portal)/events/[id]/page.js` attendee table regroups by entry
  (one row per entry, people listed in a cell) and gains a **Move** action per
  live entry. Entries awaiting payment show "Pay first" instead, because a host
  cannot collect or waive money.
- `GET /api/host/registrations/[id]/move-targets` and
  `POST /api/host/registrations/[id]/move`: `getCurrentHost()`, the entry's
  event must have `host_id === session.host.id`, and `allowedEventIds` is the
  set of that host's own events, so the same-payee rule is enforced twice.
  `actor_type = 'host'`.
- Same `MoveEntryDialog`, dark-skinned through the existing host portal
  classes. Same price-gap notice, since the host's own prices differ between
  their events; the copy says the difference is between them and the customer.
  Hosts may force a full wave too (it is their capacity); recorded the same way.
- Footer "N entries moved out" as on the staff page.

## Mia (later, not in these PRs)

A `move_event_entry` tool behind the existing `agent_membership_requests`
approvals flow, `actor_type = 'agent'`. Until then, update the
`reschedule_event_wave` tool's wrong-event reply to say a staff member can move
the entry, instead of "cancel and rebook".

## Testing

- Unit (vitest): every rule in the table with a fake db; price gap for member,
  non-member and mixed entries, both signs; `entryLabel` and `entryHeadcount`
  for a team, a team of one, and an entry with no team; `listMoveTargets`
  filters and spots arithmetic for both capacity modes.
- Route tests: auth matrix (no user, no permission, non-manager, wrong
  location), schema rejection, error-code mapping, happy path calls the lib
  with the actor from the session.
- `check:select-columns` covers the new selects.
- Migration: applied by Claude through the Supabase MCP after the PR merges,
  forward-only. The SQL function is exercised once against a real entry on a
  Vercel preview after apply, and the resulting rows checked by hand.
- Host PR adds the host auth matrix and the `allowedEventIds` fence test.

## Non-goals (v1)

- Moving money in either direction, or minting a payment link automatically.
- Moves across payees.
- Moving one person out of a team onto a different event.
- Customer self-service moves on the public event page.
- SMS or WhatsApp on move.

## Open follow-ups

- Collect the price gap in one click from the chip (a "Send payment link for
  €X" action) once the first real gap turns up.
