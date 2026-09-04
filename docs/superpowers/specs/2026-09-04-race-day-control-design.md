# Race-day control — bottom-bar tab, richer rows, portrait TV board

**Date:** 2026-09-04
**Status:** design approved, ready for planning
**First live use:** Sat 5 Sep 2026 — `hyrox-sim-september-5th` at UN1T Stillorgan (15 teams, 9 waves, teams of 1–2)

---

## Problem

On race day a staff member reaches the control board through **More → Events → tap the race**, every single time they need to start someone. Three consequences:

1. Three taps and a scroll between every wave, on a phone, while holding a clipboard.
2. The rows are thin. A row is a team name and a wave sub-line — the people actually about to run are not on screen at all, even though the API already returns them.
3. The studio TV board only renders landscape. A portrait screen gets a landscape layout letterboxed into it.

## Goals

- Reach the live board in **zero taps** on race day.
- A row that answers "who is this, who's in it, which wave" at a glance.
- A portrait TV board for a rotated screen.

## Non-goals

- No change to the race data model, the timing maths, penalties, or the start/finish/reset routes' behaviour.
- No new public path (see §3 — this is deliberate; a new public route means touching four allowlists).
- No server-side geofence enforcement (see §4 for why).

---

## 1. The Race tab

### 1.1 Placement

`race` becomes a real entry in `MOBILE_NAV_FEATURES` (`shared/mobile-nav.js`):

```js
{ key: 'race', label: 'Race day', permKeys: ['races'], barEligible: true }
```

That one line lights up the machinery that already exists:

- **Admin, per person** — `MobileBarPlanner` (rendered by `StaffForm`) filters on `barEligible`, so **Race day** appears as a slot option and an *allowed* checkbox on each assignment. Writes `permissions.mobile.layout`.
- **Staff, themselves** — `mobile/app/(staff)/customise-bar.jsx` reads `MOBILE_NAV_FEATURES` for labels and lets them pin it if the admin allowed it. Writes via `PUT /api/mobile/layout`, which clamps server-side to the admin's allowed pool.

It is **not** added to any `DEFAULT_MOBILE_LAYOUT` template — nobody gets it pinned by default. Pinning is always deliberate.

### 1.2 Visibility matrix

| | On site | Offsite / unknown |
|---|---|---|
| **Pinned** (admin or self) | Tab shows | Tab shows |
| **Not pinned**, race today | Tab auto-appears | No tab |
| **Not pinned**, no race today | No tab | No tab |

The auto-appearing tab is **contextual**: inserted by `(tabs)/_layout.jsx`, never occupying one of the three resolved bar slots. A pinned tab *does* occupy a slot, because that is what pinning means.

`unknown` presence (permission denied, no GPS fix) counts as offsite for visibility. This costs nothing — More → Events still reaches the board.

### 1.3 No double-render

`_layout.jsx` resolves the bar first. **If `race` is already in the resolved bar, the contextual insert is skipped.** Two `<Tabs.Screen name="race">` in one navigator is an expo-router error, and this is the one way to produce it. A pinned user sees exactly one Race tab, in their chosen slot, every day.

Bar order on race day for a typical manager (`[schedule, whatsapp, studio]`):

```
Home · Race · Schedule · Messages · Studio · More      (6 tabs)
```

Six is tight but legible. The rejected alternative — demoting their third bar item to More for the day — was worse: a Studio tab silently vanishing is more confusing than a squeezed bar.

### 1.4 Today's-race signal

New route: **`GET /api/races/today?location_id=`**

- Gate: `hasPermission(user, 'races')` + `assertLocationAccessOr404`.
- Selects `race_events` where `kind = 'race'`, `active`, `status = 'published'`, `race_date = todayIsoDublin()` (from `@shared/events` — mobile carries no timezone maths), at that location.
- Returns `{ success: true, data: [{ id, name, slug, race_date, start_time }] }`, `[]` when there is none.
- An array, not a single row: a morning and an evening sim on one day is plausible.

`(tabs)/_layout.jsx` polls it on the **same 60s cadence and keep-last-value-on-failure posture** as the existing Messages and Mail badge polls in that file. Only polls when the user holds `races`.

### 1.5 The tab screen — `mobile/app/(staff)/(tabs)/race.jsx`

| Today's races | Renders |
|---|---|
| Exactly 1 | The board, immediately. Zero taps. |
| 2+ | Segmented pills across the top, defaulting to the race whose first wave is nearest now. Board below. |
| 0, but an upcoming race exists | The next race's board under a plain `Not today · Sat 5 Sep` line — lets a pinned user check waves and rosters in advance. |
| 0, nothing upcoming | Empty state pointing at Events. |

### 1.6 Extraction

The board is currently ~250 lines living entirely inside `mobile/app/(staff)/races/[id].jsx`. It moves to **`mobile/components/RaceControlBoard.jsx`**, taking `eventId` as a prop. Both `races/[id].jsx` and `(tabs)/race.jsx` render it. No copy-paste fork, and the write-gating in §4 has exactly one home.

---

## 2. Richer rows

### 2.1 Target row

```
┌──────────────────────────────────────────┐
│ ⏱ 10:30                                  │   wave chip — first thing you see
│ Tu Pac                                   │   team name — headline
│ Furlong · Graham Cullen                  │   participants
│                           [   Start   ]  │
└──────────────────────────────────────────┘
```

### 2.2 Wave chip

Leads the row: a filled pill showing `wave.label`, falling back to `wave.start_time.slice(0,5)`.

**Every wave in tomorrow's race has a null label** — they are identified by start time alone. The fallback is the normal case here, not an edge case.

A registration with **no wave** gets an amber **No wave** chip, not a blank line. One team tomorrow (*Clinging on*) has `wave_id = null` and would otherwise be visually indistinguishable from a rendering bug.

### 2.3 Participants line

Member names from `teams.team_members[].name`, which `GET /api/events/[id]/control-board` **already returns** — no API change. Dot-separated, wrapping to at most two lines.

**Suppression rule (pure, unit-tested):** hide the participants line when the team has exactly one member whose name is equal to, or a case-insensitive prefix of, the team name. Tomorrow's data needs both halves:

| Team | Member | Line shown? |
|---|---|---|
| `Mark Murphy` | `Mark Murphy` | No — exact duplicate |
| `John O'Kane` | `John` | No — prefix |
| `Coach Gibbers` | `Simon Gibney` | **Yes** — different person to the team name |
| `Tu Pac` | `Furlong`, `Graham Cullen` | **Yes** — two members |

### 2.4 Next Up grouped by wave

Next Up gets a small heading per wave (`10:30 · 2 teams`). Starting a wave becomes "the rows under this heading" rather than a scan of a flat list — the actual race-day motion.

On course and Completed stay flat (sorted by elapsed, and by adjusted finish time), with the chip still on every row.

### 2.5 Sort bug

`races/[id].jsx` sorts Next Up by `wavesById.get(...)?.start_time || ''`. Empty string sorts **before** every real time, so a team with no wave floats to the **top** of the start list. Nulls go last.

---

## 3. Portrait TV board

### 3.1 Detection

Same URL — `/event/[slug]/display`. `RaceDisplayBoard.jsx` reads `window.matchMedia('(orientation: portrait)')` and subscribes to changes, so rotating the screen re-renders. `?orientation=portrait|landscape` forces it if a screen ever guesses wrong.

**No new public path.** A separate `/display/portrait` route would mean touching all four public-path allowlists — avoidable risk the day before a race, for no benefit.

### 3.2 Layout

Both sections stacked, no tapping:

```
┌───────────────────────────┐
│  Race name                │
│  Saturday 5 September     │
│      [ logos ]            │
├───────────────────────────┤
│  ON COURSE            7   │
│  1  Tu Pac      12:04     │
│     Furlong · Graham…     │
│  …                        │
├───────────────────────────┤
│  FINISHED             3   │
│  1  McBabes     41:22     │
│  …                        │
└───────────────────────────┘
```

- The two panels **flex proportionally to their row counts** (with a floor), so 12 on course and 3 finished does not spend half the screen on three finishers.
- Whichever panel overflows shows `+N more` rather than clipping a row mid-height.
- Background tap-to-switch goes **inert** in portrait — both sections are already visible, and an accidental tap blanking half the board is a real failure mode on a touchscreen TV.
- The Teams/Names toggle stays, and keeps its `localStorage` persistence.
- Header stacks: name and date on top, logos centred below.

### 3.3 Wave-label bug fix (both orientations)

`RowNames` renders `row.wave_label` only. Every wave in tomorrow's race has a null label, so **the wave currently renders nowhere on the TV**. The public API already ships `wave_start_time` alongside it.

Fix: render `wave_label || wave_start_time.slice(0,5)`, and drop the `hidden lg:inline` that hides the wave on narrow screens. Same helper as §2.2, shared.

---

## 4. Write gating — offsite is read-only

### 4.1 Where it lives

On **`RaceControlBoard`**, not on the tab. It therefore applies however the board was reached: the tab, More → Events, or a direct link.

### 4.2 Presence signal

`usePhysicalLocation()` (`mobile/lib/use-physical-location.js`, HOME-LOC.5) → `at_studio` | `offsite` | `unknown`. This is the same primitive that already gates Sonos, Shelly, doors and AC: "you must be standing in the studio to command this" is an established pattern here, not a new one.

Verified config: **Stillorgan has `geofence.enabled = true`, 100m radius**, lat/lng set. Proven in that building by the device-control screens.

### 4.3 Behaviour

`offsite` or `unknown` → the board renders **read-only**. Every Start / Finish / Reset is replaced by one banner:

> **Viewing only** — you're not at UN1T Stillorgan.  `[ I'm at the gym — enable controls ]`

One deliberate tap unlocks the controls **for that visit** — component state only, cleared on unmount, so it cannot persist into next weekend.

The override is recorded by sending `override: true` on the `race-start` / `race-finish` / `race-reset` call. The route emits a `logWarn('race-control', 'offsite override', { actor, registration_id, race_event_id })` — a structured log line, readable in Vercel logs.

**Not** a database audit row: these three routes currently record *no actor at all* — not even who started a team — so there is no trail to append to, and adding one is a schema change the day before a race. The pre-existing gap is worth its own ticket; it is out of scope here.

The flag is a note about *how* the actor got here, never an input to whether the write is allowed. A client that omits it changes nothing about what the route permits.

### 4.4 Why not enforce it server-side

The phone asserts its own position. A server-side check on `race-start`/`race-finish`/`race-reset` would be **theatre against a spoofer and a real hazard against a bad indoor GPS fix** — a denied permission or a wobbling fix means the operator at the start line cannot start a wave, mid-race, with no way out. The threat here is an accidental tap by an offsite coach, not an attacker. A deliberate override tap defeats the accident, which is the whole requirement.

This is consistent with the codebase's own stated invariant (`shared/mobile-nav.js`): *layout is arrangement, never an access gate.* The real boundary stays `hasPermission('races')` + location scoping on the routes, unchanged.

---

## 5. Files

**Changed**
| File | Change |
|---|---|
| `shared/mobile-nav.js` | add the `race` feature |
| `shared/race-control.js` | wave-label fallback + participants-suppression helpers (pure, dependency-free) |
| `src/lib/race-control.js` | add the two new helpers to its existing re-export block, so web callers keep importing from `@/lib/race-control` |
| `src/app/api/registrations/[id]/race-{start,finish,reset}/route.js` | accept + log the optional `override` flag |
| `src/components/RaceDisplayBoard.jsx` | orientation detection, portrait layout, wave fallback |
| `mobile/app/(staff)/(tabs)/_layout.jsx` | today's-race poll, contextual tab, no-double-render guard |
| `mobile/app/(staff)/races/[id].jsx` | reduced to a thin wrapper around the extracted board |
| `mobile/lib/races-api.js` | `listTodaysRaces()` |

**New**
| File | Purpose |
|---|---|
| `src/app/api/races/today/route.js` | today's races at a location |
| `mobile/app/(staff)/(tabs)/race.jsx` | the tab screen |
| `mobile/components/RaceControlBoard.jsx` | extracted board + write gating |

---

## 6. Testing

**Unit (pure, in `shared/`)** — wave-label fallback; participants-suppression (all four cases in §2.3); nulls-last wave sort; portrait panel-split maths; today's-race selection against the Dublin date boundary.

**Route** — `/api/races/today`: permission denial, location scoping, non-race kinds excluded, empty array when nothing is on.

**Browser, not jsdom** — the portrait layout is verified **in a real browser at 1080×1920 against a Vercel preview**, with a screenshot. jsdom cannot see layout; a green suite has already shipped a dead toggle in this codebase once. Local dev has no database, so a preview is the only honest target.

**Manual, before Saturday** — the tab appearing on a real phone at the studio; the read-only banner offsite; a start/finish round trip.

---

## 7. Release

Web (portrait board, wave fix, `/api/races/today`) goes live on merge via Vercel.

The mobile side is **JS-only — no native change, so no `runtimeVersion` bump** — and ships OTA at **100%** (a partial rollout blocks the next publish). This is the **first mobile merge to exercise the OTA pre-flight guard fixed in #1601**, which had never actually run; the guard needs `mobile/node_modules` present for `update:list`. Publish early enough to confirm on a real phone before Saturday morning, and treat a pre-flight failure as a guard bug to diagnose rather than a reason to skip the publish.

---

## 8. Open risk

A coach who opens the board trackside on cellular with location permission denied resolves `unknown`, and gets the banner rather than buttons — one extra tap. Accepted: the alternative (treating `unknown` as on-site) means an offsite coach with location off has full control, which is the case the feature exists to prevent. If the start line finds the extra tap costly in practice, flip `unknown` to permissive and keep the block for a confirmed `offsite` only — a one-line change, deliberately isolated in the presence helper.
