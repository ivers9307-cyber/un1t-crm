# HR class roster + anonymous sessions — design

**Date:** 2026-06-18
**Status:** Approved design, pre-implementation
**Ticket prefix:** HR-CLASS-ALLOC.2 (follows HR-CLASS-ALLOC.1 / #579 / mig 287)
**Related:** [[class-climate-v0]], [[champ-bridge-hr-live]], HR-CLASS-ALLOC.1 (presence stamp + spine readers)

## Motivation

HR-CLASS-ALLOC.1 made a live Glofox class the primary trigger for creating a
heart-rate session and stamped every session with the class it happened in
(`class_link_source='presence'`). Two gaps remain, both raised by Richard:

1. **"Actually booking in."** Today every session is `presence` — we never
   distinguish a member who was *booked* into the class from one who's merely
   present during it. We want the `booked` half of the `class_link_source`
   CHECK that mig 287 already allows.

2. **Outside / unknown people.** A person on the floor with a strap may be a
   Glofox member, a CRM-only contact (e.g. a trialist not yet in Glofox), or a
   total visitor. Today an **unregistered** strap (no `contact_devices` row,
   no `strap_assignment`) has its samples **dropped** and never appears
   anywhere. Richard wants them on the screen labelled by their device id
   (e.g. `ant:45075`) instead of vanishing.

Richard also asked for the **full class roster** as a visible surface: everyone
booked into the live class, with HR shown on whoever is wearing a strap and the
rest listed without HR — "not everybody will be appearing on it as they won't
broadcast the HR." The roster is a **superset** of the HR board.

## The three-tier model

Everyone broadcasting HR during a live class lands on the board. How they're
labelled depends on how well we know them:

| Tier | Who | Board label | `class_link_source` |
|---|---|---|---|
| 1 | Glofox member, strap registered, **booked** into this class | Name | `booked` |
| 2 | Known contact (Glofox member not booked, **or** CRM-only contact), strap registered | Name | `presence` |
| 3 | **Unregistered** strap (visitor / stranger) | Device id (`ant:45075`) | `presence` |

Tiers 1–2 already create sessions today (HR-CLASS-ALLOC.1). This feature adds
tier 3 (anonymous) and the booked-vs-presence split on tier 1. The **roster
panel** additionally shows booked members who have *no* HR session at all
(booked but not wearing a strap).

## Components

Five well-bounded units. Each can be built and tested independently.

### 1. `class_bookings` roster table (new)

The per-event, per-member booking roster. This is the "build the roster"
decision — it drives **both** the booked tag (component 4) and the roster panel
(component 5).

```
class_bookings
  id                 uuid pk
  location_id        uuid not null references locations(id)
  glofox_event_id    text not null              -- the class occurrence (soft ref to class_occurrences.glofox_event_id)
  glofox_booking_id  text not null              -- Glofox Booking _id; UNIQUE → idempotent upserts
  glofox_member_id   text                       -- Glofox user_id of the booker
  contact_id         uuid references contacts(id) on delete set null  -- resolved from glofox_member_id; nullable
  member_name        text                       -- snapshot (survives contact churn / unresolved members)
  class_name         text                       -- snapshot
  starts_at          timestamptz                -- class start (from booking.time_start)
  status             text                       -- BOOKED | CANCELLED | ATTENDED | NO_SHOW (Glofox status, uppercased)
  attended           boolean not null default false
  raw                jsonb                       -- full Glofox Booking for forward-compat
  synced_at          timestamptz not null default now()
  created_at         timestamptz not null default now()

  UNIQUE (location_id, glofox_booking_id)
  INDEX (location_id, glofox_event_id)          -- roster lookups
  INDEX (location_id, glofox_member_id, glofox_event_id)  -- booked-tag lookup
```

- **RLS:** location-scoped read for `authenticated` via
  `private.auth_is_in_location(location_id)`; writes are service-role only
  (the sync + webhook workers). Mirror the `class_occurrences` policy from mig
  284. `security_invoker` n/a (table, not view).
- `contact_id` is `ON DELETE SET NULL` so a contact deletion never orphans /
  cascades the roster; `member_name` keeps the row legible.

### 2. Roster population

Glofox exposes **no per-event roster endpoint** (confirmed — `/2.0/events`
returns a `booked` *count*, never the attendee list). We assemble the roster
from the **per-member booking fetches we already do**:

- **Hook into `applyMemberSync`** (`src/lib/glofox-sync.js`). It already calls
  `fetchUserBookings(creds, memberId)` whenever `creds && !skipBookings`
  (the daily `glofox-sync` cron **and** every `BOOKING_*` webhook, which
  re-fetches the member — see `webhooks/glofox/route.js:291-303`). Add a
  best-effort `upsertClassBookings(db, locationId, contactId, bookingsList)`
  call alongside the existing `trimRecentBookings` write. Each raw Booking
  carries `_id`, `event_id`, `event_name`, `time_start`, `status`, `attended`
  — everything the table needs. So every booking change refreshes the roster
  within seconds, no new ingestion pipeline.
- **Backfill:** a one-shot (operator-triggered route or a short cron) that
  pages active members with a `glofox_member_id`, fetches their bookings, and
  upserts rows for the next ~48h of classes. Reuses the same upsert helper.
- **Pruning (optional, later):** a periodic delete of rows whose `starts_at` is
  far in the past keeps the table small. Not required for v1.

**Honest limitation:** the roster is only as complete as the members we've
synced. A booking that never fired a webhook *and* predates the backfill could
be missing. Go-forward bookings are covered by webhooks; the backfill covers
the current window. We surface this as "roster reflects synced bookings" rather
than claiming guaranteed completeness. Acceptable — the board still shows every
HR broadcaster regardless of roster membership.

`upsertClassBookings` is a pure-ish IO helper (build rows from a bookings list +
a `contactId`/`glofox_member_id`, upsert on `glofox_booking_id`). The row-shaping
half is a pure function, unit-tested.

### 3. Anonymous sessions (tier 3)

- **Migration:** `ALTER TABLE heart_rate_sessions ALTER COLUMN contact_id DROP
  NOT NULL`. Anonymous sessions carry `contact_id = NULL` and
  `device_identifier = 'ant:45075'` (the device_key already lives in that
  column). No new column needed — the device id is the label.
- **Bridge ingest** (`src/lib/bridge-samples.js`): today an unmatched strap's
  samples increment `stats.dropped_unpaired` and are dropped. Change: in
  `resolveStrapsForBatch` (or the no-match branch feeding `buildHrSampleRows`),
  for an unmatched device **only when a class is live**
  (`resolveCurrentOccurrence`, the same gate tiers 1–2 use), create an anonymous
  session (`contact_id=NULL`, `device_identifier=deviceKey`, stamped with the
  live occurrence `glofox_event_id` / `class_name` / `class_link_source='presence'`)
  and attribute the batch's samples to it. No class live → still dropped, so a
  stray strap elsewhere in the building never appears.
- **Side-effect guards:** `endSession` fires post-class email + achievements +
  exports. All key off a contact. Guard each to no-op when `contact_id` is null
  (an anon session still gets `summariseSession` zones/points, just no email /
  achievement / export). Audit `live-class.js` + the consumers.
- **Boards:** `/api/public/live/[locationId]` and `/api/live/[locationId]`
  currently `contacts!inner(...)`. Switch to a left join (`contacts!contact_id(...)`,
  disambiguated per the two-FK rule in CLAUDE.md) and fall back to
  `device_identifier` for `displayName` when there's no contact. The public TV
  shows the device id (e.g. `ant:45075`); the coach view can show the same.
- **Customer isolation:** champ-app + the customer-self RLS policy key on
  `contact_id = private.auth_contact_id()`; a null-contact row never matches, so
  anonymous sessions stay invisible to members. Correct by construction.

### 4. Booked tag (tier 1)

At session-stamp time (both creation paths from HR-CLASS-ALLOC.1:
`bridge-samples.js findOrCreateAutoSession` and `live-class.js pairOverride`),
after `resolveCurrentOccurrence` yields the live occurrence:

- Look up `class_bookings` for `(location_id, glofox_event_id =
  occ.glofox_event_id, glofox_member_id = contact.glofox_member_id)` with
  `status NOT IN ('CANCELLED')`.
- Row found → `class_link_source = 'booked'`. Else → `'presence'`.
- Anonymous (tier 3) and CRM-only contacts (no `glofox_member_id`) → always
  `presence`.

This **replaces** the `recent_bookings` time-match idea — a direct
event-id + member-id lookup against the roster is cleaner and exact.
`class_link_source` already exists (mig 287) → no migration for this half.
A small pure helper `resolveClassLinkSource({ booked: boolean })` keeps the
branch testable; the lookup is a thin IO function.

### 5. Roster panel UI

On the **coach / staff `/live/[locationId]` view** (authenticated), add the live
class's full roster, composed from three sources:

- **Booked + HR broadcasting** → full tile (name, BPM, zone, points) — the
  existing live-session tile.
- **Booked + no strap** → name listed, greyed, "no HR" — from `class_bookings`
  rows for the live occurrence with no matching open session.
- **Anon walk-in** (HR session, not in roster) → device-id tile.

Backed by a roster read: `getClassRoster(db, { locationId, nowMs })` →
resolve the live occurrence, pull its `class_bookings` rows, left-join open
sessions, and tag each entry `{ booked, hasHr, displayName, ... }`. Pure
shaping (merge roster + sessions → tagged list) is unit-tested; the fetch is IO.

**Public TV stays the HR leaderboard** (now including anon tiles) and does
**not** list booked-but-absent names — it's a hype screen, and absent members'
names on a lobby display is a privacy smell. (Decision locked; revisit only if
the TV is later meant to be the attendance cockpit.)

## Data flow

```
Glofox booking made
  └─ BOOKING_CREATED webhook ─► applyMemberSync({creds})
        ├─ fetchUserBookings ─► trimRecentBookings → contacts.recent_bookings   (existing)
        └─ fetchUserBookings ─► upsertClassBookings → class_bookings            (NEW, component 2)

Strap broadcasts during live class
  └─ bridge POST /api/bridge/samples ─► resolveStrapsForBatch
        ├─ matched → contact session  ─┐
        │                              ├─ stamp class_link_source via class_bookings lookup (component 4)
        └─ unmatched + class live → anon session (component 3)

Coach opens /live/[locationId]
  └─ getClassRoster: class_bookings(live occ) ⟕ open sessions → tagged roster (component 5)

Public TV /tv/[locationId]
  └─ /api/public/live: open sessions (incl. anon), left-join contacts → leaderboard
```

## Phasing

- **PR1 — roster data layer:** `class_bookings` table (mig) + `upsertClassBookings`
  + the `applyMemberSync` hook + backfill route. Ships invisibly; verify rows
  populate. No UI.
- **PR2 — booked tag + anonymous sessions:** nullable `contact_id` (mig),
  ingest creates anon sessions, board label fallback + left-join, side-effect
  guards, booked-tag lookup at both stamp paths.
- **PR3 — roster panel UI:** `getClassRoster` + the coach `/live` roster panel.

Each PR runs the full CI mirror + a real `next build`, applies its migration to
prod, runs the security advisor, and ships as its own branch+PR.

## Edge cases & decisions

- **No per-event Glofox roster endpoint** → roster assembled from per-member
  fetches (component 2). Documented limitation, not a blocker.
- **Anonymous session lifecycle:** ended by the existing
  `endSession` / `endAllAtLocation` coach actions (they end *all* open sessions
  at a location, anon included). Post-class side-effects skip on null contact.
- **CRM-only contact (no `glofox_member_id`)** → tier 2, `presence`. Correct;
  they're known by name but not booked via Glofox.
- **`booked` then cancels:** a `BOOKING_DELETED` webhook re-syncs the member and
  upserts the roster row to `CANCELLED`; the booked-tag lookup excludes
  `CANCELLED`. A session already stamped `booked` is not retro-changed (it
  reflects the booking state at session start) — acceptable.
- **Two FKs to contacts:** `class_bookings.contact_id` is a *single* FK, but the
  board's `heart_rate_sessions → contacts` embed must stay disambiguated
  (`contacts!contact_id`) per the CLAUDE.md two-FK rule.
- **Privacy:** public TV shows device ids for anon (intended) but never the
  absent-member roster.

## Out of scope (explicit)

- Public-TV roster display (leaderboard only — locked).
- A Glofox-side attendance write-back (marking attended from HR presence).
- Mobile parity for the coach roster panel (web-first; decide in PR3 whether to
  add a `MOBILE_PERMISSIONS` counterpart or `WEB_ONLY_OK` it).
- The Myzone-style class timer — that is **Feature B**, its own spec.

## Testing

- Pure helpers unit-tested: roster row-shaping (component 2),
  `resolveClassLinkSource` (component 4), roster+sessions merge (component 5).
- Anon-session ingest: extend `bridge-samples.test.js` with an unmatched-device-
  during-live-class case (DB-mocked).
- Booked-tag: extend the `findOrCreateAutoSession` / `pairOverride` mocks with a
  `class_bookings` branch (booked vs not).
- Full CI mirror + real `next build` per PR; advisor after each migration.
