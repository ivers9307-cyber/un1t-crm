# BATHROOM-CLIMATE — class-driven bathroom AC schedule

**Status:** Design approved by Richard 2026-07-26. Ready for implementation plan.
**Author:** drafted with Richard (brainstorming session, 2026-07-26).

---

## Why this exists

The gym floor AC already runs on the class schedule via the `class_climate`
automation (on 15 min before each Glofox class, off 5 min after). The two
bathroom LG ThinQ units (already registered in `ac_devices` since
STUDIO-AC-DEVICES) have no schedule at all — staff turn them on manually.

Bathroom usage peaks when people hit the showers, i.e. *towards the end of*
and *after* a class — not before it. So the bathrooms need their own
schedule, driven by the same class timings but with completely different
timing semantics, and configured independently of the gym floor.

**Richard's locked behaviour:** bathroom AC turns **ON 45 minutes after each
class starts** and runs on a **30-minute timer**. Class at 06:00 → bathrooms
on 06:45, off 07:15.

---

## Locked decisions

| Decision | Choice |
|---|---|
| Architecture | **Option A** — a second automation key `bathroom_climate` in the existing automations hub. No config-shape migration; gym floor card untouched. |
| Timing model | Delayed start relative to class **start**: on at `start + delay_after_start_min`, off at `on + run_duration_min`. No pre-class lead, class *end* is irrelevant. |
| Defaults | `delay_after_start_min = 45`, `run_duration_min = 30`. |
| Auto-off anchoring | `auto_off_at` anchored to the class schedule (`start + delay + duration`), not to when the cron actually fired — a late tick still switches off at the same wall-clock time. |
| Overlap behaviour | Same as gym floor: if a device already has an active `ac_sessions` row, record `skipped` and retry next tick once it ends. Closely-spaced classes may produce a short gap, accepted. |
| Filters | Same affordances as the gym card: optional `class_filter` (name contains) and recurring `excluded_slots` (click-to-exclude weekly slots, reusing `slotKey`). |
| Off mechanism | Reuse the existing `ac-auto-off` cron via `ac_sessions.auto_off_at` — the runner never performs the OFF itself. |
| Devices | Operator picks which `ac_devices` rows the automation drives (expected: the two bathroom ThinQ units). Provider-agnostic via the `ac-devices` dispatcher. |

Rejected alternatives: **B** — generalise `class_climate` into multi-zone
config (config migration + touches working gym card, YAGNI for two zones);
**C** — plain time-of-day cron (ignores timetable changes and cancelled
classes, which the class-driven approach skips for free via `cancelled_at`).

---

## Config

Stored in `location_automations.config` for `automation_key =
'bathroom_climate'` (the existing `unique (location_id, automation_key)`
constraint gives it a row independent of the gym floor's — **no schema
migration needed** for config).

```js
export const DEFAULT_CONFIG = Object.freeze({
  device_ids: [],              // ac_devices uuids to drive
  delay_after_start_min: 45,   // AC on this many minutes AFTER class start
  run_duration_min: 30,        // off timer, minutes from the scheduled on-time
  class_filter: [],            // [] = all classes; else name-contains, case-insensitive
  excluded_slots: [],          // recurring "<weekday> HH:MM" Dublin slots to skip
})
```

`resolveConfig` coerces types the same way `class-climate.js` does
(hand-edited JSONB must not crash the runner); numeric fields floor at 0,
except `run_duration_min` which floors at 1 (a 0-duration run is meaningless
and would produce `auto_off_at` in the past).

---

## Components

### `src/lib/bathroom-climate.js` — pure planner (no DB/vendor imports)

Mirrors `class-climate.js`. Reuses `slotKey` and `classMatchesFilter` by
importing them from `@/lib/class-climate` (they are already exported and
pure) rather than duplicating.

- `planBathroomClimate({ occurrences, config, nowMs })` — for each
  occurrence passing filter + not slot-excluded: `windowOpen = start +
  delay`, `windowClose = windowOpen + duration`. Emit when `windowOpen <=
  now <= windowClose`. Bad/missing `starts_at` rows are dropped. `ends_at`
  is ignored by design.
- `autoOffAtFor(occurrence, config, nowMs)` — `start + delay + duration`,
  clamped to `now + 60s` minimum (same past-time guard as the gym planner).

### `src/lib/bathroom-climate-runner.js` — IO runtime

Near-clone of `class-climate-runner.js` with `AUTOMATION_KEY =
'bathroom_climate'`:

1. Load enabled `location_automations` rows for the key (all locations on
   the cron path, one on run-now).
2. Read `class_occurrences` in a `now-2h .. now+6h` window (the lookback is
   2h, not the gym runner's 1h, because a window can open up to
   `delay_after_start_min` after a class starts — a 1h lookback would miss a
   06:00 class when the cron ticks at 07:10 with delay=65; 2h covers any
   sane delay).
   Filter `cancelled_at is null` — cancelled classes never fire.
3. Plan, then fire per (occurrence, device): skip pairs already `fired` in
   `automation_fire_log` (key `bathroom_climate`, `action_step 'on'`), skip
   with a `skipped` log row when the device has an active `ac_sessions`
   row, else `vendorTurnOn` and insert a system `ac_sessions` row
   (`started_by NULL`, `auto_off_at` from the planner). Existing
   `ac-auto-off` cron performs the OFF; the external-rule cron sees the
   active session and leaves the unit alone.
4. Audit event: `ac.bathroom_auto_on`, category `business`, device identity
   in `target.resource` (never `target.id` — profiles FK trap).

Shared machinery reused as-is: `vendorTurnOn`/`loadDeviceWithLocation` from
`@/lib/ac-devices`, `AC_SESSION_*` enums, `automation_fire_log` upsert on
`(automation_key, glofox_event_id, device_id, action_step)`.

### `/api/cron/bathroom-climate` — cron route

Clone of `/api/cron/class-climate`: Bearer `CRON_SECRET`, calls
`runBathroomClimate(db)`, `stampHeartbeat('bathroom-climate')` on success.
`vercel.json` entry at `*/5 * * * *` (same cadence as class-climate; a
5-min tick against a 30-min window can never miss it).

### Migration `447_bathroom_climate_heartbeat.sql`

Single insert into `cron_heartbeats` for `bathroom-climate`
(`expected_interval_seconds` 300, grace consistent with the class-climate
row — copy the pattern from mig 445). Verify 447 is still the next free
number at PR time. `get_advisors` after applying (per invariant, even for
DML-only migrations).

### Registry + generic routes

- `src/lib/automations/registry.js`: add the `bathroom_climate` definition
  (`label: 'Bathroom climate control'`, `supportsBackfill: false`,
  `reviewBase: '/automations'`) and a `automationStatus` branch identical
  to `class_climate` (gates on `glofoxConnected` only).
- The generic `/api/automations/[key]` PUT, `/schedule`, and `/history`
  routes already operate by key — verified: history filters
  `automation_fire_log` by key and states it "works for any automation
  key"; check `/schedule` the same way at implementation time.
- `/api/automations/[key]/run-now`: verified it rejects any key other than
  `class_climate` with a 400. Add a dispatch branch so `bathroom_climate`
  invokes `runBathroomClimate` (keeping the schedule-refresh-first step).
  Supports `dry_run`.
- `src/app/automations/page.js`: hard-codes which card component renders
  per key (verified — it imports `ClassClimateCard` directly). Add the
  `BathroomClimateCard` branch there.

### `src/components/automations/BathroomClimateCard.jsx`

Near-clone of `ClassClimateCard.jsx`, rendered on `/automations` for the
new registry entry:

- Device multi-select from the location's enabled `ac_devices` (operator
  ticks the bathroom units).
- Two timing fields: **“Start after class begins (min)”** (default 45) and
  **“Run for (min)”** (default 30). These labels are card copy for
  operators, not customer-facing — the operator-editable-copy invariant
  does not apply.
- Same synced-schedule view with click-to-exclude weekly slots, the
  optional class-name filter, Run-schedule-check-now (+ dry-run), Test AC
  now, and fire history.
- Enable gate: Glofox connected + ≥1 device selected (same as gym card).

If, while cloning, the shared skeleton is worth extracting into a common
component, prefer a light shared child (schedule list + history list) over
a parameterised mega-card — the two cards' timing semantics differ and
should stay readable independently.

---

## Interaction with the gym floor automation

Both automations may drive **disjoint** device sets (gym card → studio
Sensibo unit, bathroom card → ThinQ units). Nothing enforces disjointness;
if an operator ticks the same device in both, the active-session skip makes
the outcome safe (first automation wins the overlap, the second logs
`skipped`) — accepted, not worth a guard for v1. The fire log keys by
`automation_key`, so histories and idempotency never cross.

---

## Failure handling

Inherited semantics from the class-climate runner, unchanged:

- Vendor error (LG cloud down / device offline) → `failed` fire-log row,
  retried next tick while the window is open; visible in card history.
- Session-insert failure after a successful vendor ON → `failed` row; the
  external-rule cron caps the orphaned unit.
- No devices configured → `no_devices_configured` error in the run result.
- Windows already closed when the cron catches up → nothing fires (the
  window check is both-sided), no stale blast of ONs after downtime.

---

## Testing

- `src/lib/bathroom-climate.test.js` — table tests on the planner: window
  maths (before/inside/after window, exact boundaries), delay/duration
  coercion, filter + excluded-slot behaviour, `autoOffAtFor` anchoring and
  the past-time clamp, missing `starts_at`/bad dates dropped.
- `src/lib/bathroom-climate-runner.test.js` — mirror of
  `class-climate-runner.test.js`: fired-set idempotency, active-session
  skip, vendor-failure path, dry-run, cancelled-class exclusion, the 2h
  lookback actually catching a late window.
- Run the full six-check CI mirror; `npm run build` locally (new route +
  imports).

## Out of scope

- Humidity/temperature-sensor-driven control — timer only.
- Bridging/coalescing consecutive windows into one long run (the 30-min
  timer per class is the requested behaviour; overlap-skip handles
  collisions).
- Mobile surface — web `/automations` only, matching the gym card.
- Second location rollout — config is per-location already; nothing extra.
