# HR routing: booking-first class mapping + staff test mode + unmapped-detection display

**Date:** 2026-06-27
**Status:** Design approved, pending spec review
**Area:** In-studio heart-rate (champ-bridge ↔ un1t-crm), Stillorgan

## Problem

A member's chest strap that is correctly registered to their profile
(`contact_devices`) does not appear on the TV and instead sits in the coach
view's "Available straps" panel asking to be paired — even though it is already
linked. Two root issues, confirmed against the live DB:

1. **No session gets created outside a live class.** A registered strap only
   auto-routes when [`findOrCreateAutoSession`](../../../src/lib/bridge-samples.js)
   finds (a) an existing open session, (b) a Glofox class "live now" (−20/+10 of
   start/end), or (c) an in-progress native CRM booking. With none of those (the
   common case when testing, or warming up well before class) it returns `null`,
   so no session exists, so the strap never reaches the board and stays
   "available." This is by design but surprises operators and makes testing
   impossible outside class hours.

2. **The class a session maps to is chosen by time, not by the member's
   booking.** [`resolveCurrentOccurrence`](../../../src/lib/class-occurrences.js)
   returns the *most-recently-started* occurrence within the location-wide
   −20/+10 window. The member's booking is only consulted afterward to set the
   `booked` vs `presence` *label* — never to pick the class. When two classes
   overlap (a class running long, back-to-back slots, two rooms), a member can be
   stamped onto the wrong class.

3. **Unmapped/broadcasting straps are invisible on the TV until paired.** The TV
   only renders `heart_rate_sessions`. A broadcasting strap with no session shows
   nowhere on the big screen; an operator must manually pair it first.

## Goals

- A registered strap maps to **the class the member is actually booked into**,
  not whichever class time happens to pick.
- Staff can **test a registered strap any time** (no live class) without leaving
  a permanent bypass on.
- **Every broadcasting strap is visible on the screen immediately**, labelled by
  its number, with no pairing step. Pairing/booking *upgrades* the tile from a
  number to a name with points.

## Non-goals

- No change to the anonymous-walk-in session path's window (stays −20/+10).
- No persistence/scoring for unmapped straps **outside** a live class — Layer 3
  is display-only (live BPM, no points/zones). In-class unmapped straps keep
  getting anonymous sessions (with points) exactly as today.
- No name resolution for unmapped straps — registered-but-unrouted straps display
  by number, not by member name (YAGNI; booking/test-mode/pair upgrades the label).
- No new permission key (reuses the existing live-view staff gate; test-mode
  toggle is gated to manager roles in-route).

## Design

### Layer 1 — Booking-first class selection

New IO helper in `src/lib/class-bookings.js` (it owns the roster):

```
resolveBookedOccurrenceForMember(db, { locationId, glofoxMemberId, nowMs, preMs, postMs })
  → { glofox_event_id, class_name } | null
```

- Returns the member's **nearest non-cancelled** `class_bookings` row whose
  occurrence is live within the supplied grace window, joined to
  `class_occurrences` for `ends_at` (bookings store `starts_at` but not
  `ends_at`).
- Selection: among the member's bookings with `starts_at` in
  `[now − 3h, now + preMs]` and not `CANCELLED`, join the occurrence, keep those
  satisfying `occurrenceIsLive(occ, now, { preMs, postMs })`, pick the one whose
  `starts_at` is **nearest to now**.
- Returns fast `null` when `glofoxMemberId` is missing (CRM-only contacts).

`findOrCreateAutoSession` registered-strap selection order becomes:

1. **Booking-first** — `resolveBookedOccurrenceForMember(...)` with the **wide**
   window (45 before / 30 after). Found → create the session stamped with that
   class, `class_link_source = 'booked'`.
2. **Presence fallback** — `resolveCurrentOccurrence(...)` with the **unchanged
   −20/+10** window. Found → `class_link_source = 'presence'` (current behaviour:
   an unbooked member on the board during a live class).
3. **Test mode** — see Layer 2. Bridge in test mode → presence-less session
   (`glofox_event_id = null`, `class_link_source = null`).
4. Otherwise `null` (unchanged: no class, no booking, no test mode → no session;
   the strap still shows via Layer 3).

The same booking-first-then-time helper replaces the bare
`resolveCurrentOccurrence` call in:

- the **step-(a) existing-session backfill** (so a session opened just before
  class gets the member's booked class, not the time guess), and
- [`pairOverride`](../../../src/lib/live-class.js) class stamping (manual pair
  during a class lands on the coach-picked member's booked class).

### Layer 2 — Staff test mode (time-boxed)

- **Migration:** add `ble_bridges.test_mode_until timestamptz NULL`, with a
  `COMMENT` describing it. `NULL` / past = off.
- **Threading:** `resolveStrapsForBatch` already has `bridgeId`; it fetches the
  bridge's `test_mode_until` once and passes a `testModeActive` boolean into
  `findOrCreateAutoSession`. When true and Layers 1–2 produced no occurrence, it
  creates a presence-less session for the registered contact.
- **Route:** `POST /api/live/[locationId]/test-mode` enables (body
  `{ minutes }`, default 120, clamped to a sane max e.g. 240); `DELETE` clears it.
  Manager-role gate in-route (`MANAGER_ROLES`) + `assertLocationAccess`. Stamps
  `test_mode_until = now() + minutes` on **all** `ble_bridges` at the location.
  Register in `src/lib/openapi.js`.
- **UI:** on `/live/[locationId]` a manager-only control — "Enable test mode
  (2h)" when off; an active banner with a live countdown + "Turn off" when on.
  The `/api/live` GET response surfaces `test_mode_until` so the client can
  render state. Scoped to registered straps only — anonymous walk-in testing
  continues to use the existing **Pair** button.

### Layer 3 — Unmapped detections on the TV (display-only)

- **`/api/public/live/[locationId]`** gains an `available_straps` array: every
  strap the bridge is broadcasting (`ble_bridges.last_seen_straps`) with **no
  open session** — reuse the existing `getAvailableStraps` filtering. Each entry:
  `{ label, protocol, currentBpm, stale }`.
  - **Privacy** (public screen): ANT+ → the number (e.g. `12511` or `Strap
    12511`). BLE → masked to last 4 (`Strap ••AB`), never the full MAC. This
    matches the feed's existing "no MACs on the public TV" bar. (Anonymous
    *sessions* already display `device_identifier`; this keeps the unpaired tiles
    to the same privacy floor.)
- **`LiveTvClient`** renders unmapped straps as **muted "unpaired" tiles**
  (number + live BPM, no zone colour, no points), visually subordinate to the
  named/anon leaderboard tiles.
- **No double-display:** `getAvailableStraps` already excludes any strap with an
  open session, so a strap is either a session tile *or* an unpaired tile, never
  both. When a booking/test-mode/pair creates a session, the tile flips from
  number to name on the next 2s poll.

## Data flow (registered strap, sample arrives)

```
bridge POST /api/bridge/samples
  → resolveStrapsForBatch(bridgeId, locationId, deviceKeys)
      → fetch bridge.test_mode_until
      → (1) override: strap_assignments
      → (2) auto: contact_devices match → findOrCreateAutoSession
              (a) existing open session  → return (backfill class booking-first)
              (b) booking-first (45/30)   → 'booked' session
              (c) presence (20/10)        → 'presence' session
              (d) test mode               → presence-less session
              else null
      → (3) anon: still-unmatched + class live (20/10) → anon session
  TV/coach poll → named/anon session tiles + unpaired number tiles (Layer 3)
```

## Defaults / parameters

| Parameter | Value |
|---|---|
| Booking-first window | 45 min before start / 30 min after end |
| Presence fallback window | 20 / 10 (unchanged) |
| Test mode duration | 120 min default, 240 max |
| Test mode toggle gate | manager roles (`MANAGER_ROLES`) |
| Test mode scope | registered straps only |
| Unpaired tile label | ANT+ number; BLE last-4 masked |

## Components / files touched

| File | Change |
|---|---|
| `src/lib/class-bookings.js` | + `resolveBookedOccurrenceForMember` (pure-ish IO + a pure nearest-pick helper for unit tests) |
| `src/lib/bridge-samples.js` | reorder `findOrCreateAutoSession` (booking-first → presence → test-mode); thread `testModeActive`; backfill uses booking-first |
| `src/lib/live-class.js` | `pairOverride` class stamp via booking-first helper |
| `supabase/migrations/NNN_hr_bridge_test_mode.sql` | + `ble_bridges.test_mode_until` |
| `src/app/api/live/[locationId]/test-mode/route.js` | new POST/DELETE (manager+) |
| `src/app/api/live/[locationId]/route.js` | surface `test_mode_until` in GET |
| `src/app/live/[locationId]/LiveClassClient.jsx` | test-mode toggle + countdown banner |
| `src/app/api/public/live/[locationId]/route.js` | + `available_straps` block (privacy-masked) |
| `src/app/tv/[locationId]/LiveTvClient.jsx` | render unpaired number tiles |
| `src/lib/openapi.js` | register the test-mode route |
| `docs/CHANGELOG.md` | Done entry |

## Testing

- **Pure unit tests** (no DB) for the nearest-booking pick: early arrival maps to
  the upcoming booked class even when a previous class is still in its window;
  cancelled bookings ignored; no `glofox_member_id` → null; tie-break nearest
  start.
- **`bridge-samples` tests**: booking-first beats time-based; presence fallback
  unchanged at 20/10; test-mode creates a presence-less session and is ignored
  once `test_mode_until` passes; anon path still gated on a live class.
- **Route guard**: `check:route-guards` covers the new `/api/live/.../test-mode`
  route (manager gate + `assertLocationAccess`).
- Display layers verified against the live bridge once a strap is broadcasting
  (the whole HR feature is still pending device verification).

## Risks / notes

- Widening the window **only** behind a confirmed booking is what makes 45/30
  safe — an unbooked strap can never use it, so no spurious sessions far from
  class.
- Test mode is time-boxed and self-expiring to avoid the
  `enabled + test_mode = live-for-everyone` footgun pattern; it is *not* a
  persistent flag.
- BLE MAC masking on the public feed is a deliberate privacy floor; staff coach
  view (`/api/live`, authenticated) may still show the full `device_key`.
- Migration is forward-only, applied via Supabase MCP against `iyvtbjjxdggiadzwwvdj`;
  run `get_advisors` (security) after the DDL.
