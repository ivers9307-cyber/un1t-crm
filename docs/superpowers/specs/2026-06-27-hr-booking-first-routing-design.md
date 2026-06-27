# HR routing: booking-first class mapping + staff test mode + unmapped-detection display + class-aware session lifecycle

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

4. **A mid-class drop-out splits the session and emails early.** The strap goes
   silent (member steps out / a bridge blip), and within 5 min
   [`auto-end-stale-hr-sessions`](../../../src/app/api/cron/auto-end-stale-hr-sessions/route.js)
   (`STALE_AFTER_MS = 5 min`) closes the session and fires the post-class email —
   even though the class is still running. If the member returns mid-class they
   get a *new* session, and the post-class email per-session dedup
   (`email_sent_at`) is per-row, so a second session = a **second email** for the
   same class.

## Goals

- A registered strap maps to **the class the member is actually booked into**,
  not whichever class time happens to pick.
- Staff can **test a registered strap any time** (no live class) without leaving
  a permanent bypass on.
- **Every broadcasting strap is visible on the screen immediately**, labelled by
  its number, with no pairing step. Pairing/booking *upgrades* the tile from a
  number to a name with points.
- **One session per member per scheduled class.** A mid-class drop-out keeps the
  session open; HR returning during the class rejoins the same session; the
  post-class email is sent **once, at class end** — never mid-class, never
  duplicated.

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

### Layer 4 — Class-aware session lifecycle (rejoin + deferred email)

A single class session per member, kept open across mid-class drop-outs, closed
and emailed once at class end. The post-class email dedup (`email_sent_at`) is
**per session row**, so the only reliable way to avoid duplicate emails is to
guarantee one session per `(member, class)` — not to dedupe emails.

**A. Defer the stale auto-close while the class is still running.** In
[`auto-end-stale-hr-sessions`](../../../src/app/api/cron/auto-end-stale-hr-sessions/route.js),
a **class-linked** session (`glofox_event_id` set) is only closed when:

- it is silent > `STALE_AFTER_MS` (5 min) **AND** `now > occ.ends_at + CLASS_END_GRACE`, or
- the existing 4 h hard cap (`MAX_SESSION_LENGTH_MS`) fires (unchanged backstop).

So a class-linked session that is **silent but whose class is still scheduled**
is *deferred* (left open, rejoinable) rather than closed. A session that is
**still streaming** is never stale (its `last_sample_at` stays fresh — touched on
every sample batch), so a class running past its scheduled end is unaffected.
**Non-class** sessions (native PT/consultation bookings, test-mode presence-less,
off-site imports) keep the current 5-min stale-close — there is no class end to
wait for. The cron needs the occurrence `ends_at`; fetch it per class-linked
candidate (by `glofox_event_id`) — small N (open sessions at one location).

**B. Rejoin is then automatic.** Because the session stays open through the gap,
returning HR mid-class hits `findOrCreateAutoSession` step (a) (existing open
session) and appends to the **same** session. No new code on the rejoin path
beyond A keeping the row open.

**C. One session per member per class on the create path.** Before creating a
class-linked session, look for an existing session for
`(contact_id, glofox_event_id)`:

- **open** → return it (rejoin; already covered by step a),
- **closed + class still live** (`now ≤ occ.ends_at + CLASS_END_GRACE`) → reopen
  (`ended_at = null`) and return it (defensive — should not trigger once A defers;
  `email_sent_at` is still null because the email was deferred, so reopening
  cannot re-send),
- **closed + class ended** → return `null`: the class is over, so a returning
  strap is a live unpaired tile (Layer 3), **not** a new scoring session and not a
  second email.

This closes the duplicate-email hole: a post-class re-entry inside the
booking-first grace window cannot spawn a second session.

**Email timing, net:** the post-class email fires **exactly once**, when the
single class session closes — either the coach hits "end class" (`endAllAtLocation`)
at the bell, or the cron closes it at `ends_at + CLASS_END_GRACE`. Never mid-class.

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

  Note (Layer 4): step (a) reattaches a mid-class drop-out to its still-open
  session because the stale-close cron defers closing class-linked sessions
  until class end + grace; step (b)/(c) creation is class-keyed so a re-entry
  cannot spawn a second session for a class the member already has one for.

every 5 min — cron auto-end-stale-hr-sessions:
  class-linked session  → close only if silent>5min AND now > ends_at + 10min
  non-class session     → close if silent>5min (unchanged)
  any session           → close if started_at > 4h ago (unchanged backstop)
  → close = finalise + ONE post-class email (email_sent_at)
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
| `CLASS_END_GRACE` (defer close until after class end) | 10 min |
| Non-class stale-close (`STALE_AFTER_MS`) | 5 min (unchanged) |
| Max session length backstop (`MAX_SESSION_LENGTH_MS`) | 4 h (unchanged) |

## Components / files touched

| File | Change |
|---|---|
| `src/lib/class-bookings.js` | + `resolveBookedOccurrenceForMember` (pure-ish IO + a pure nearest-pick helper for unit tests) |
| `src/lib/bridge-samples.js` | reorder `findOrCreateAutoSession` (booking-first → presence → test-mode); thread `testModeActive`; backfill uses booking-first; class-keyed find-or-create (open→return, closed+live→reopen, closed+ended→null) [Layer 4C] |
| `src/app/api/cron/auto-end-stale-hr-sessions/route.js` | defer closing class-linked sessions until `ends_at + CLASS_END_GRACE`; non-class + 4h backstop unchanged [Layer 4A] |
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
- **Lifecycle (Layer 4)**: a class-linked session silent mid-class is NOT closed;
  the same session silent after `ends_at + grace` IS closed (+ one email); a
  still-streaming session past scheduled end stays open; a non-class session
  closes at 5-min silence as before; a re-entry after class end does not create a
  second session (closed+ended → null). Cover the email fires exactly once.
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
- **Layer 4 changes email *timing*, intentionally:** a member who leaves mid-class
  and never returns now gets their post-class email at **class end + grace**
  (≤ ~10 min after the bell) instead of ~5 min after they walked out. This is the
  requested behaviour and the cost of single-session-per-class. A coach who hits
  "end class" still emails immediately at the bell.
- **Class `ends_at` correctness depends on the occurrence spine.** A class
  missing/mis-timed in `class_occurrences` (e.g. a sync gap) falls back to the 4 h
  backstop for closing — the session won't hang forever, but the email could be
  late. The daily 04:00 sync keeps the spine current.
