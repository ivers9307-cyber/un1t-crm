## PR ARRIVALSHOW.1 — coaches see their own arrival on the phone's Schedule tab

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the phone's Schedule tab (Me view, phone list and iPad grid), each of the coach's OWN shifts gets one quiet line saying what the app recorded: "Arrived 06:52", "On site from your earlier shift (arrived 06:52)", "No arrival recorded yet" (the shift has started) or "No arrival recorded" (it has ended). Nothing is shown before a shift starts, at a studio where arrivals are not tracked, for a coach who is geofence-exempt, or when the server could not read the arrivals. The facts come from `GET /api/schedule/shifts` as a new `arrival` field on the caller's own rows only. A colleague's row always carries `arrival: null`, and so does a manager's Team feed.

**Why:** 00-INDEX Wave 3 PR 34, "the first half of late and no-show alerts". The alerts are held because arrival stamps are thin. Measured on prod for this plan (Stillorgan, published shifts, the 30 days to 24 Sep):
- **38 of 198 shifts (19%)** carry `arrived_at`. With the attendance report's back-to-back carry-over, 53 (27%). Per coach-day, 33 of 107 (31%).
- **2 of 9 rostered coaches have no stamp at all** (the index says three; it has moved). Every one of the 9 has "always" location permission on their newest device, and 7 of 9 are on 2.4.0. **So the gap is not permission.** 51 of 107 coach-days (48%) had no geofence ping at all. Of the 23 coach-days that had a ping but no stamp, 11 pinged more than 45 minutes before the first shift (the region never fires again while the coach stays inside) and 5 only after the last shift ended.
- 0 manual arrivals. **No code writes `arrival_source = 'manual'`** (see Follow-ups).

A coach cannot see any of this today. Once coaches can see their own stamp, a missing arrival shows up on the screen of the one person who knows whether they were there. That is the only coverage lever that does not need a manager, and it is the first step before an alert can be trusted.

**Architecture:** One new server module, `src/lib/shift-arrivals.js`. It has a pure `annotateOwnArrivals` (the meaning of "arrived", the carry-over, the double-stamp rule, the display window) and a never-throwing `fetchOwnArrivalFacts` (three small reads keyed on the caller: stamps, studio timezone plus geofence config, the caller's exemption). `GET /api/schedule/shifts` calls it beside COVERLOOP.2's `fetchOwnOpenSwaps`, in the same own-rows-only pattern (`src/lib/shift-open-swaps.js`). On the phone, a pure `mobile/lib/shift-arrival.js` turns `arrival` plus "now" into one line of words. `mobile/components/schedule/ArrivalLine.jsx` renders it. `schedule.jsx` mounts it on the Me view's `ShiftRow` and `ShiftCard`.

**Tech Stack:** Next.js 16 route handler, Supabase (service role, read-only here), Vitest (node), Expo / React Native with NativeWind.

**Size / ships:** S. **No migration** (none reserved; `arrived_at` / `arrival_source` exist since mig 609). **Web deploy + OTA**: `mobile/lib/**`, `mobile/components/**` and `mobile/app/**` are bundle paths (`.github/workflows/eas-update.yml:154-156`), so merging publishes a phone update at 100% on the **2.4.0** runtime lane (`mobile/app.config.js:457`). **No native dependency**, so no store build and no `runtimeVersion` bump. The two coaches still on a 2.3.x binary (device data above) will not see it until they update the app.

**DEPLOY ORDER:** none needed. Web and OTA ship from the same merge, and either can land first:
- New phone, old server: `arrival` is absent, so the line never renders (pinned in Task 4).
- Old phone, new server: the extra field is ignored.

**Batch 8 pairing:** rides beside 35 LABOUR.1 (web only, no OTA), so this PR's EAS Update run is the batch's only phone publish. Conflict hotspots: `mobile/app/(staff)/(tabs)/schedule.jsx` (14, 17, 19, 20 and 22 all touched it; 14 and 22 are on main), `src/app/api/schedule/shifts/route.js` and its test (19 CANDIDATES.1 / 20 REPLACE.1 may add to them), `src/lib/openapi.js`, `docs/CHANGELOG.md`. **Find every anchor below by its quoted text, not the line number.**

**Worktree:** `git fetch origin main && git worktree add ../un1t-crm-arrivalshow1 -b arrivalshow-1 origin/main`, then `npm ci`. Never `git stash`. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the PR gate (8GB machine).

**Rules that bite in this PR (read `CLAUDE.md` Invariants first):**
- **Service-role routes get no RLS.** Every new read is keyed on `profile_id = user.id` in code (`shift_assignments`, `profile_locations`), or bounded to studios that come from the caller's own rows (`locations`). `annotateOwnArrivals` re-checks `profile_id` on every row, so a colleague's arrival cannot ride this field even if a read returned one.
- **Mobile cannot import `src/lib`.** The phone gets FACTS from the server (instants, a local `HH:MM`, flags) and makes one pure decision in `mobile/lib/shift-arrival.js` (vitest). No timezone maths runs on the phone. A Hermes build without full ICU throws on `Intl.DateTimeFormat({ timeZone })` (ROSTER-FIX.7f, `mobile/lib/dates.js`), so the server formats the time.
- **No React Native component test runner.** Every decision and every word lives in `mobile/lib/shift-arrival.js`. The `.jsx` only renders.
- **NativeWind compiles only class names it can see**, and `mobile/tailwind.config.js` scans `./app/**` and `./components/**` only, **not `./lib/**`**. So the tone classes are whole literals inside `ArrivalLine.jsx`, never built in the lib.
- **"Removing a silent failure must never create a louder one."** A failed arrivals read must never fail the roster (the phone's most-called feed), and must never read as "No arrival recorded". Unknown means `arrival: null`, and null means the phone shows nothing.
- **Quiet hours gate notices, not state.** This PR sends no notice. It only shows state, whatever the hour.
- **The repo is PUBLIC.** Fixtures use no real names.

---

### What was found (verified against `origin/main` at `27500a90`, #1764)

**The 16 Sep defects this work used to sit on are fixed on main. Do not re-fix them.**
- The geofence check-in writes ONLY `arrived_at` + `arrival_source` (`src/app/api/attendance/geofence-checkin/route.js:12-18` header; the stamp at `:275-280`, the lost-claim recovery at `:180-187`). It never writes `start_time_override`. Mig 609 added the columns (with a CHECK of `'geofence' | 'manual'`). **Mig 610** moved every old stamp out of the paid window into `private.shift_assignment_arrival_backfill_610`. Prod today: **0** `start_time_override` values with non-zero seconds in the last 30 days, and 1 override of any kind.
- The double stamp is gone. The decision now loads the coach's shifts INCLUDING ones already arrived for (`route.js:202-215`), and `decideGeofenceStamp` (`src/lib/staff-attendance.js:171-234`) turns a second ping into `reentry` / `already`. The mig 465 per-minute unique index and the 10-minute dedup (`route.js:157-196`) stop duplicates. ARRIVAL.2 (#1695) made the phone's queue flush single-flight. Prod today: **0** groups of one coach with the same `arrived_at` on two assignments, over all history.
- The display still defends against that shape (D3). It costs one comparison, and it is the one place a leftover or future double stamp would reach a coach.

**How an arrival is matched (the rule the phone's words must agree with):**
- `decideGeofenceStamp`: a ping may stamp a shift from **45 minutes before its BLOCK start** (`GEOFENCE_EARLY_WINDOW_MS`, `staff-attendance.js:135`) until the block's end. A running shift beats a future one. A ping within 60 minutes after a shift the coach already arrived for is a re-entry and stamps nothing (`GEOFENCE_REENTRY_GAP_MS`, `:140`).
- The attendance report (`src/app/api/attendance/route.js:108-152`) reads `arrived_at` only (`:105-107`). It carries an arrival onto a back-to-back shift with `inferContinuousArrivals` (`staff-attendance.js:245-271`): no stamp, same coach, same `block_date`, and a gap of at most 60 minutes from the previous shift's BLOCK end. It shows that as "on site" (`arrival_inferred`) with `minutes_late: null`. The report is per studio (`withAuth({ location: true })`), so the carry never crosses studios.
- Mig 622 (tombstone) also treats a matched `staff_attendance_events` row as an arrival (CLAUDE.md). Mig 610 already copied those into `arrived_at`, and the report does not read them, so this PR does not either (the same choice as SNAPSHOT.1's D10).

**The phone feed and its precedent:**
- The Me view calls `getMyShifts` → `GET /api/schedule/shifts?location_id=<active>&profile_id=<me>&start_date&end_date` (`mobile/lib/schedule-api.js:6-13`; `schedule.jsx:416-427`). The Team view calls the same route without `profile_id` (`schedule-api.js:15-26`), so the feed carries colleagues' rows.
- `fetchApiShiftRows` → `toApiShiftRow` (`src/lib/roster-read.js:99-145`) does NOT select `arrived_at`. Rows carry `id` (the assignment id), `profile_id`, `location_id`, `shift_date`, `block_start_time`, `block_end_time`, and `start_time_override` / `end_time_override` as the collapsed EFFECTIVE override (`effectiveOverride`, `:33-37`: the assignment's override, else the block time when it differs from the template).
- COVERLOOP.2 is the exact precedent for an own-rows-only field: `fetchOwnOpenSwaps(db, user.id, ownShiftIds(rows, user.id))` plus `annotateOwnOpenSwaps` (`src/lib/shift-open-swaps.js`; route `:64-68`). It is keyed on the caller, bounded to the caller's own ids, never throws (a failed read costs only the chip), and puts `null` on every colleague row. Its route test (`route.test.js:72-124`) pins "a manager's team feed carries nobody else's swap state".
- Tracking applies when the studio's `settings.geofence` is configured (`geofenceFromLocationSettings` + `geofenceIsConfigured`, `src/lib/geofence-attendance.js:46-66`) AND the caller's `profile_locations.geofence_exempt` is false. That is the same rule `GET /api/attendance/geofence-config` uses to decide which regions the phone registers (`route.js:20-48`). Prod: Stillorgan and Hatch Street are enabled; every location's `timezone` is `Europe/Dublin`.
- Phone rendering: `ShiftRow` (`schedule.jsx:251-322`, Me view list, iPhone) and `ShiftCard` (`:91-144`, iPad grid, both views via `teamMode`). The Me list footer (`:747-753`) already tells a coach "Your hours are set by your manager". The `CalendarSubscribeRow` mount (`:757-758`) is the last element in the ScrollView.
- `mobile/lib/dates.js` builds Dublin formatters lazily, because a Hermes build without ICU throws (ROSTER-FIX.7f). `mobile/tailwind.config.js` content globs are `./app/**` and `./components/**` only.

**Helpers this PR reuses, unchanged:** `resolveScheduledAt`, `inferContinuousArrivals`, `arrivalToTimeOnly` (`src/lib/staff-attendance.js:56, 245, 278`); `resolveTz`, `dayStrInTz` (`src/lib/tz-time.js:119, 184`); `effectiveShiftStart`, `effectiveShiftEnd` (`shared/roster-month.js`, already imported server-side as `@shared/roster-month`); `ownShiftIds` (`src/lib/shift-open-swaps.js:38`); `logWarn` (`src/lib/log.js:123`).

---

### What "arrived" means (the table the code and the tests implement)

One row per case, for one of the coach's own shifts. "Earlier shift" means an earlier shift of the same coach on the same date at the same studio.

| Stored facts | `arrival` on the row (server) | Phone line |
|---|---|---|
| `arrived_at` set on this shift (geofence, or a future manual one) | `at`, `at_local` `HH:MM`, `at_local_date`, `source`, `carried: false` | **"Arrived 06:52"**. If `at_local_date` is before `shift_date` (a 00:30 shift arrived for at 23:50): "Arrived 23:50 the day before" |
| No stamp here; an earlier shift has an arrival (stamped or itself carried) and this shift starts ≤ 60 min after that shift's BLOCK end | the earlier arrival's `at` / `at_local`, `carried: true`, `source: null` | **"On site from your earlier shift (arrived 06:52)"** |
| **Double-stamp shape:** a stamp here whose instant EQUALS the earlier shift's arrival instant | its own `at`, `carried: true` | **"On site from your earlier shift (arrived 06:52)"**, never a second "Arrived" |
| `start_time_override` / `end_time_override` set, no stamp | `at: null`. The override is **never** an arrival | Nothing about arrival from the override. The card keeps showing the override as its times with the "Adjusted" chip, exactly as today. The override only moves the window the absence line is judged on (`starts_at` / `ends_at` = the EFFECTIVE window) |
| No stamp, no carry; tracked; now before the effective start | `at: null`, `tracked: true` | nothing |
| … now at or after the effective start and before the end | same | **"No arrival recorded yet"** (grey) |
| … now at or after the effective end | same | **"No arrival recorded"** (grey). Never "late", "missed", "no-show" or "absent" |
| No stamp; not tracked (studio geofence off, the coach is exempt, or no membership) | `tracked: false` | nothing |
| No stamp; the tracking read failed | `tracked: null` | nothing |
| A stamp on a shift that is not tracked (exempted later) | `at` set, `tracked: false` | "Arrived …". A stored fact is shown |
| The arrivals read failed, or an old server | `arrival: null`, or the field absent | nothing, on every row |
| A colleague's row (Team feed, manager or coach) | `arrival: null` | nothing (and the Team view never renders the line) |
| A draft own row (managers only see these) | as above | no absence line; a stamp still shows |

---

### Decisions (made here, each pinned by a test)

**D1. Own rows only, enforced twice on the server.** `fetchOwnArrivalFacts` reads `shift_assignments` with `.eq('profile_id', viewerId).in('id', ownIds)`. `annotateOwnArrivals` sets `arrival: null` on any row whose `profile_id !== viewerId`, whatever the facts hold. A manager's Team feed gets their own rows' arrivals and nobody else's. Managers already see everyone's arrivals on `/schedule/attendance` (`attendance_reports` permission), and this PR adds no manager surface. Under "View as user", `user.id` is the viewed coach, so a master sees that coach's arrivals, which the master can already read on the report. *Pinned:* `shift-arrivals.test.js` "a colleague's row is null even when the facts name it", "a manager's team feed carries nobody else's arrival"; `route.test.js` "puts the arrival on the caller's row and null on a colleague's".

**D2. Carry-over is the report's rule, reused, not re-written.** `annotateOwnArrivals` calls `inferContinuousArrivals` from `src/lib/staff-attendance.js`, measured on BLOCK times like the report, so the phone and `/schedule/attendance` agree on which shifts are "on site". The group key is the STUDIO (every row is the caller's own, so `profileId` carries `location_id`). An arrival at Stillorgan never makes a coach "on site" at Hatch Street, which also matches the per-studio report. *Pinned:* "a back-to-back shift within 60 minutes is on site", "61 minutes is not", "another studio the same day is not", "a carry chains across three shifts".

**D3. The double-stamp shape reads as "on site".** A stamp whose instant equals the arrival instant of the coach's previous same-day shift at the same studio is shown as that earlier arrival (`carried: true`), not as a second walk-in. This is mig 610's `duplicate_orphan` definition (same coach, same day, the same value on an earlier-starting block), and there are 0 on prod today. The stored row is not touched: this is display only, and the report still shows what is stored. *Pinned:* "the same instant on two shifts reads the second as on site", "two different instants are two arrivals".

**D4. The server sends facts; the phone decides with "now" only.** Per own row: `at` (ISO), `at_local` (`HH:MM` in the studio's timezone), `at_local_date`, `source`, `carried`, `tracked` (`true | false | null`), `starts_at` / `ends_at` (ISO instants of the EFFECTIVE window). The phone compares `Date.now()` with two instants and formats nothing. That keeps the Hermes-ICU trap off this screen and makes the line correct on a phone set to any timezone. "Now" is read at render, and the tab re-renders on every focus refetch (`schedule.jsx:446`), so no ticking timer is added. *Pinned:* the phone table runs under `TZ=Europe/Dublin` and `TZ=America/Los_Angeles`; the server table includes BST, GMT and the spring-forward day.

**D5. The absence line is judged on the EFFECTIVE window, the times the card shows.** `starts_at` / `ends_at` use `effectiveShiftStart` / `effectiveShiftEnd` (`shared/roster-month.js`: override → block → template), and an end at or before the start wraps to the next day (payroll's rule). A coach whose manager moved their start to 08:00 is not told "No arrival recorded yet" at 07:10. The carry (D2) stays on block times, so the phone and the report agree about "on site". The report measures lateness against the BLOCK start (`attendance/route.js:115`). That divergence is a follow-up for the alert half, not something this PR changes. *Pinned:* "an override moves the window", "an override ending after midnight wraps".

**D6. Unknown is never absence.**
- A failed stamps read → `arrival: null` on every row.
- A failed tracking read → `tracked: null`, and the phone shows only real stamps.
- A studio missing from a successful tracking read → `tracked: false`.
- A failed timezone read → `Europe/Dublin` (`resolveTz`; every studio is Dublin).
- Nothing here ever fails the roster. It logs `logWarn('schedule', …)`, like `fetchOwnOpenSwaps`.

*Pinned:* "a failed stamps read is null on every row, never an absence", "a failed tracking read keeps the stamps and says tracked null", the route test "a failed arrivals read still returns the roster", and on the phone "tracked null shows nothing".

**D7. Words: neutral, no lateness, never alarming.** The phone shows the time and nothing about minutes early or late. Held alerts must not arrive through the back door as a red "LATE" chip. Absence is grey (`text-un1t-subtle`), a stamp is green-700 with a check icon, and there is no red or amber anywhere. Under the Me list, one help line appears whenever any arrival line is showing: "Arrival times come from your phone's location when you reach the studio. They don't change your hours." Both statements are true today: the gate copy already says the app "clocks you in for your shift" (`DEFAULT_GATE_COPY`, `geofence-attendance.js:25-28`), and ARRIVAL.1 took arrivals out of paid hours. The line promises nothing about alerts or managers. *Pinned:* "no word says late, missed, no-show or absent", "the help line shows only when a line shows".

**D8. Tracking = the studio's geofence is on AND the coach is not exempt**, the same rule the phone's region registration uses (`geofence-config/route.js:27-47`). An exempt coach, or a studio with the feature off, never sees "No arrival recorded". *Pinned:* "an exempt coach is not tracked", "a studio with the geofence off is not tracked", "no membership row is not tracked".

**D9. Draft own rows never show an absence.** Only managers see their own drafts (ROSTER-FIX.1 D1). Nobody was told to be there, so "No arrival recorded" would be false. A stamp, if one ever exists, still shows. *Pinned:* phone "a draft shows no absence line".

**D10. Me view only.** `ShiftRow` (iPhone, used only in the Me list) and `ShiftCard` when `!teamMode` (iPad Me grid). The Team view's `TeamShiftRow` is untouched, and the Home tab is untouched: it reads `shared/dashboard-data.js` mobile-direct under RLS, and arrivals stay behind the service-role route (open question 4). *Pinned by data:* colleague rows are null (D1). *Checked by hand:* the handset checklist.

**D11. The alert half is NOT built.** No push, no cron, no heartbeat, no settings toggle, no report change. What it will need is listed below.

**Not touched, on purpose:** the geofence check-in route and `decideGeofenceStamp` (the matcher), the attendance report route and page, `toApiShiftRow` / `fetchApiShiftRows` (so `shift-reminders` and the assistant never see arrivals), `shared/dashboard-data.js`, any migration, `mobile/lib/schedule-api.js` (its test pins its export list).

---

### What the alert half (late and no-show alerts) will need

Recorded here so the next plan starts from it. None of it is in this PR.

1. **A coverage gate that is measured, not guessed.** Per coach-day, with the carry rule, over a rolling 30 days, per studio. Held until above ~80% for a month (00-INDEX). Today it is 31% of coach-days, and 48% of coach-days have no geofence ping at all even though every coach has "always" permission, so that is the first thing to diagnose (OS delivery, radius, iOS region state on entry). Saved SQL for the measurement is in the PR body.
2. **A way to correct an arrival.** `arrival_source = 'manual'` is allowed by mig 609's CHECK, but no route or UI writes it. Before anyone is alerted, a manager (or a coach's "I was here" request that a manager approves) must be able to set or clear `arrived_at`. Otherwise an alert on a missed stamp cannot be answered.
3. **The early-arrival hole.** A ping more than 45 minutes before the first shift is stored as `no_shift_in_window` and the region does not fire again while the coach stays inside. That is 11 of the 23 pinged-but-unstamped coach-days above. Options: re-match an earlier same-day `no_shift_in_window` event at report/alert time, or widen the window for a coach's FIRST shift of the day. That is a matcher decision for Richard.
4. **One lateness reference.** The report measures against the BLOCK start. This PR's absence line uses the EFFECTIVE (override) window. An alert must pick one (recommend effective: it is what the coach was told), and the report should follow.
5. **Judged on real instants in the studio timezone**, with the 60-second grace (`bucketLateness`, `staff-attendance.js:106-118`). No-show only after the EFFECTIVE end. Carried shifts are never late (the report already nulls `minutes_late`). Exempt or untracked coaches, and studios with the geofence off, are never alerted.
6. **Delivery rules.** Who is told (the coach, and/or managers at that studio). A registered `notify_*` category with defaults, or categoryless (CLAUDE.md: an unregistered category fails closed). Quiet hours gate the NOTICE, never the state. Send-once per assignment with a durable log (a migration). The arm gets its own `cron_heartbeats` row, applied after deploy (CLAUDE.md arm rule). An operator toggle per studio, off by default.
7. **The coach's view is this PR.** The alert must use the same meaning of "arrived" (the table above), so what a coach is told matches what their phone shows.

---

### File map

| File | Change | Ships |
|---|---|---|
| `src/lib/shift-arrivals.js` (create) | `annotateOwnArrivals` (pure), `ownLocationIds`, `fetchOwnArrivalFacts` (IO, never throws), `OWN_ARRIVAL_ID_CHUNK` | web |
| `src/lib/shift-arrivals.test.js` (create) | the table above, DST, the failure rules, the chunked keyed read | test |
| `src/app/api/schedule/shifts/route.js` (modify: the import block, and the final `fetchOwnOpenSwaps` / `return` lines, `:64-68`) | wire the facts beside the swap read | web |
| `src/app/api/schedule/shifts/route.test.js` (modify: mock block after the `shift-open-swaps` mock; three existing `toEqual`s gain `arrival: null`; one new `describe`) | wiring | test |
| `src/lib/openapi.js` (modify: the `/api/schedule/shifts` GET `description`) | document `arrival` | web |
| `mobile/lib/shift-arrival.js` (create) | `ARRIVAL_WORDS`, `arrivalLine`, `arrivalHelpFor` | **OTA** |
| `mobile/lib/shift-arrival.test.js` (create) | the phone table, both TZs | **OTA** (test-only over-trigger, accepted per CLAUDE.md) |
| `mobile/components/schedule/ArrivalLine.jsx` (create) | renders one line; tone classes as literals | **OTA** |
| `mobile/app/(staff)/(tabs)/schedule.jsx` (modify: imports after `import { briefingOf } from 'shared/shift-briefing'`; `ShiftCard`, `WeekGridView`, `ShiftRow` gain `nowMs`; one help line before the `CalendarSubscribeRow` mount) | mounts it in the Me view | **OTA** |
| `docs/staff-attendance.md` (modify: append a section) | what coaches see | no |
| `docs/CHANGELOG.md` | one row after `gh pr create` | no |

No new top-level entry under `mobile/`, so `check:ota-paths` needs no decision. `mobile/components/schedule/` already exists.

---

### Task 0: Preconditions (no commit)

- [ ] **Step 1: The anchors still read as described**

```bash
git fetch origin main
git show origin/main:src/app/api/schedule/shifts/route.js | grep -n "fetchOwnOpenSwaps(db, user.id, ownShiftIds(rows, user.id))"
git show origin/main:src/app/api/attendance/geofence-checkin/route.js | grep -n "arrived_at: eventAt.toISOString(), arrival_source: 'geofence'"
git show origin/main:src/app/api/attendance/geofence-checkin/route.js | grep -c "start_time_override"
git show origin/main:src/lib/staff-attendance.js | grep -nE "^export (function|const) (resolveScheduledAt|inferContinuousArrivals|arrivalToTimeOnly|GEOFENCE_REENTRY_GAP_MS)"
git show origin/main:src/lib/tz-time.js | grep -nE "^export function (resolveTz|dayStrInTz)"
git show origin/main:shared/roster-month.js | grep -nE "^export function effectiveShift(Start|End)"
git show 'origin/main:mobile/app/(staff)/(tabs)/schedule.jsx' | grep -n "function ShiftRow\|function ShiftCard\|function WeekGridView\|<CalendarSubscribeRow />\|from 'shared/shift-briefing'"
git show origin/main:mobile/tailwind.config.js | grep -n "content:"
```

Expected: the swap line exists once; the geofence stamp writes `arrived_at`; the check-in route contains **only comment mentions** of `start_time_override` (read each hit: none may be a write); four exports, two, two; the five schedule anchors; content globs without `./lib`. If CANDIDATES.1 / REPLACE.1 reshaped the route's ending, keep their additions and wire this PR's read beside the swap read the same way.

- [ ] **Step 2: Prod facts the plan leans on still hold** (Supabase MCP `execute_sql` on **un1t-crm** `iyvtbjjxdggiadzwwvdj`, read-only)

```sql
select count(*) from shift_assignments
 where start_time_override is not null and extract(second from start_time_override) <> 0;           -- expect 0
select count(*) from (select profile_id, arrived_at from shift_assignments
 where arrived_at is not null and status <> 'cancelled' group by 1,2 having count(*) > 1) g;          -- expect 0
select name, timezone, settings->'geofence'->>'enabled' from locations
 where settings ? 'geofence';                                                                          -- expect Stillorgan + Hatch, Europe/Dublin
```

If the first two are not 0, stop and tell the orchestrator: the double-stamp or override-stamp defect has come back, and that comes before any display.

---

### Task 1: The pure server model, `annotateOwnArrivals`

**Files:**
- Create: `src/lib/shift-arrivals.test.js`
- Create: `src/lib/shift-arrivals.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/shift-arrivals.test.js
//
// ARRIVALSHOW.1 — what "arrived" means on a coach's own shift, as the phone
// is told it. Every row in the table in the plan
// (docs/superpowers/plans/2026-09-25-scheduler-wave2-3/34-ARRIVALSHOW.1.md)
// is a case here. Fixture names are made up (the repo is public).

import { describe, it, expect, vi } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn() }))
const { annotateOwnArrivals, ownLocationIds } = await import('./shift-arrivals')

const L1 = 'loc-still'
const L2 = 'loc-hatch'
const ME = 'me'

// A toApiShiftRow()-shaped row (src/lib/roster-read.js): only the keys the
// model reads. start/end_time_override are the collapsed EFFECTIVE override.
const row = (id, over = {}) => ({
  id,
  profile_id: ME,
  location_id: L1,
  shift_date: '2026-09-24',
  block_start_time: '07:00:00',
  block_end_time: '08:00:00',
  start_time_override: null,
  end_time_override: null,
  ...over,
})
const stamp = (id, at, source = 'geofence') => [id, { id, arrived_at: at, arrival_source: source }]
const facts = (stamps, over = {}) => ({
  stamps: new Map(stamps),
  timezones: new Map([[L1, 'Europe/Dublin'], [L2, 'Europe/Dublin']]),
  tracked: new Map([[L1, true], [L2, true]]),
  ...over,
})
const arrivalOf = (rows, f, id) => annotateOwnArrivals(rows, f, ME).find((r) => r.id === id).arrival

describe('annotateOwnArrivals — a stamp on this shift', () => {
  it('reads as arrived, with the studio-local time and the effective window (BST)', () => {
    expect(arrivalOf([row('a1')], facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), 'a1')).toEqual({
      at: '2026-09-24T05:52:00.000Z',
      at_local: '06:52',
      at_local_date: '2026-09-24',
      source: 'geofence',
      carried: false,
      tracked: true,
      starts_at: '2026-09-24T06:00:00.000Z',
      ends_at: '2026-09-24T07:00:00.000Z',
    })
  })

  it('an arrival before midnight for a 00:30 shift keeps its own local date', () => {
    const r = row('a1', { shift_date: '2026-09-25', block_start_time: '00:30:00', block_end_time: '01:30:00' })
    const a = arrivalOf([r], facts([stamp('a1', '2026-09-24T22:50:00.000Z')]), 'a1')
    expect(a.at_local).toBe('23:50')
    expect(a.at_local_date).toBe('2026-09-24')
  })

  it('a stamp is shown even where arrivals are no longer tracked (exempted later)', () => {
    const a = arrivalOf([row('a1')], facts([stamp('a1', '2026-09-24T05:52:00.000Z')], { tracked: new Map([[L1, false]]) }), 'a1')
    expect(a.at).toBe('2026-09-24T05:52:00.000Z')
    expect(a.tracked).toBe(false)
  })
})

describe('annotateOwnArrivals — on site from an earlier shift (the report rule, D2)', () => {
  it('a back-to-back shift within 60 minutes of the earlier BLOCK end is on site', () => {
    const rows = [row('a1'), row('a2', { block_start_time: '08:30:00', block_end_time: '09:30:00' })]
    const a = arrivalOf(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), 'a2')
    expect(a).toMatchObject({ at: '2026-09-24T05:52:00.000Z', at_local: '06:52', carried: true, source: null })
  })

  it('61 minutes after is not on site', () => {
    const rows = [row('a1'), row('a2', { block_start_time: '09:01:00', block_end_time: '10:00:00' })]
    const a = arrivalOf(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), 'a2')
    expect(a).toMatchObject({ at: null, at_local: null, carried: false })
  })

  it('another studio the same day is not on site', () => {
    const rows = [row('a1'), row('a2', { location_id: L2, block_start_time: '08:30:00', block_end_time: '09:30:00' })]
    expect(arrivalOf(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), 'a2').carried).toBe(false)
  })

  it('another day is not on site', () => {
    const rows = [row('a1'), row('a2', { shift_date: '2026-09-25' })]
    expect(arrivalOf(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), 'a2').carried).toBe(false)
  })

  it('a carry chains across three back-to-back shifts', () => {
    const rows = [
      row('a1'),
      row('a2', { block_start_time: '08:00:00', block_end_time: '09:00:00' }),
      row('a3', { block_start_time: '09:30:00', block_end_time: '10:30:00' }),
    ]
    const out = annotateOwnArrivals(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), ME)
    expect(out.map((r) => r.arrival.carried)).toEqual([false, true, true])
    expect(out[2].arrival.at_local).toBe('06:52')
  })

  it('order in the payload does not matter', () => {
    const rows = [row('a2', { block_start_time: '08:30:00', block_end_time: '09:30:00' }), row('a1')]
    const out = annotateOwnArrivals(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), ME)
    expect(out.map((r) => r.id)).toEqual(['a2', 'a1'])
    expect(out[0].arrival.carried).toBe(true)
  })
})

describe('annotateOwnArrivals — the double-stamp shape (D3)', () => {
  it('the same instant on two shifts reads the second as on site, not a second arrival', () => {
    const rows = [row('a1'), row('a2', { block_start_time: '07:30:00', block_end_time: '08:30:00' })]
    const f = facts([stamp('a1', '2026-09-24T05:52:00.000Z'), stamp('a2', '2026-09-24T05:52:00.000Z')])
    const out = annotateOwnArrivals(rows, f, ME)
    expect(out[0].arrival.carried).toBe(false)
    expect(out[1].arrival).toMatchObject({ at: '2026-09-24T05:52:00.000Z', carried: true })
  })

  it('two different instants are two arrivals', () => {
    const rows = [row('a1'), row('a2', { block_start_time: '12:00:00', block_end_time: '13:00:00' })]
    const f = facts([stamp('a1', '2026-09-24T05:52:00.000Z'), stamp('a2', '2026-09-24T10:40:00.000Z')])
    expect(annotateOwnArrivals(rows, f, ME).map((r) => r.arrival.carried)).toEqual([false, false])
  })

  it('the same instant at two different studios is not folded', () => {
    const rows = [row('a1'), row('a2', { location_id: L2, block_start_time: '07:30:00', block_end_time: '08:30:00' })]
    const f = facts([stamp('a1', '2026-09-24T05:52:00.000Z'), stamp('a2', '2026-09-24T05:52:00.000Z')])
    expect(annotateOwnArrivals(rows, f, ME)[1].arrival.carried).toBe(false)
  })
})

describe('annotateOwnArrivals — the window the absence line is judged on (D5)', () => {
  it('no stamp: the window is still sent, for the phone to judge against now', () => {
    expect(arrivalOf([row('a1')], facts([]), 'a1')).toEqual({
      at: null, at_local: null, at_local_date: null, source: null, carried: false, tracked: true,
      starts_at: '2026-09-24T06:00:00.000Z', ends_at: '2026-09-24T07:00:00.000Z',
    })
  })

  it('an override moves the window; the override is never an arrival', () => {
    const r = row('a1', { block_start_time: '07:00:00', block_end_time: '10:00:00', start_time_override: '08:00:00' })
    expect(arrivalOf([r], facts([]), 'a1')).toMatchObject({ at: null, starts_at: '2026-09-24T07:00:00.000Z', ends_at: '2026-09-24T09:00:00.000Z' })
  })

  it('an override ending after midnight wraps to the next day', () => {
    const r = row('a1', { start_time_override: '22:00:00', end_time_override: '01:00:00' })
    expect(arrivalOf([r], facts([]), 'a1')).toMatchObject({ starts_at: '2026-09-24T21:00:00.000Z', ends_at: '2026-09-25T00:00:00.000Z' })
  })

  it('winter time (GMT)', () => {
    const r = row('a1', { shift_date: '2026-01-10', block_start_time: '09:00:00', block_end_time: '10:00:00' })
    expect(arrivalOf([r], facts([]), 'a1').starts_at).toBe('2026-01-10T09:00:00.000Z')
  })

  it('the spring-forward day', () => {
    const r = row('a1', { shift_date: '2026-03-29', block_start_time: '09:00:00', block_end_time: '10:00:00' })
    expect(arrivalOf([r], facts([]), 'a1').starts_at).toBe('2026-03-29T08:00:00.000Z')
  })

  it('a row without times sends no window (the phone then shows no absence)', () => {
    const r = row('a1', { block_start_time: null, block_end_time: null })
    expect(arrivalOf([r], facts([]), 'a1')).toMatchObject({ starts_at: null, ends_at: null })
  })

  it('an unknown studio timezone falls back to Dublin', () => {
    expect(arrivalOf([row('a1')], facts([], { timezones: new Map() }), 'a1').starts_at).toBe('2026-09-24T06:00:00.000Z')
  })
})

describe('annotateOwnArrivals — tracking (D8)', () => {
  it('a studio in the tracking map as false is not tracked', () => {
    expect(arrivalOf([row('a1')], facts([], { tracked: new Map([[L1, false]]) }), 'a1').tracked).toBe(false)
  })
  it('a studio missing from a successful tracking read is not tracked', () => {
    expect(arrivalOf([row('a1')], facts([], { tracked: new Map() }), 'a1').tracked).toBe(false)
  })
  it('a failed tracking read is unknown (null), and the stamps still ride', () => {
    const a = arrivalOf([row('a1')], facts([stamp('a1', '2026-09-24T05:52:00.000Z')], { tracked: null }), 'a1')
    expect(a.tracked).toBeNull()
    expect(a.at).toBe('2026-09-24T05:52:00.000Z')
  })
})

describe('annotateOwnArrivals — own rows only, unknown is never absence (D1, D6)', () => {
  it("a colleague's row is null even when the facts name it", () => {
    const rows = [row('a1'), row('c1', { profile_id: 'colleague' })]
    const f = facts([stamp('a1', '2026-09-24T05:52:00.000Z'), stamp('c1', '2026-09-24T05:40:00.000Z')])
    const out = annotateOwnArrivals(rows, f, ME)
    expect(out[1].arrival).toBeNull()
    expect(out[0].arrival.at).toBe('2026-09-24T05:52:00.000Z')
  })

  it("a manager's team feed carries nobody else's arrival", () => {
    const rows = [row('m1', { profile_id: 'manager' }), row('c1', { profile_id: 'coach-a' }), row('c2', { profile_id: 'coach-b' })]
    const f = facts([stamp('m1', '2026-09-24T05:50:00.000Z'), stamp('c1', '2026-09-24T05:51:00.000Z'), stamp('c2', '2026-09-24T05:52:00.000Z')])
    const out = annotateOwnArrivals(rows, f, 'manager')
    expect(out.map((r) => r.arrival?.at ?? null)).toEqual(['2026-09-24T05:50:00.000Z', null, null])
  })

  it("a colleague's stamp is never carried onto the viewer's shift", () => {
    const rows = [row('c1', { profile_id: 'colleague' }), row('a2', { block_start_time: '08:30:00', block_end_time: '09:30:00' })]
    const out = annotateOwnArrivals(rows, facts([stamp('c1', '2026-09-24T05:52:00.000Z')]), ME)
    expect(out[1].arrival.carried).toBe(false)
  })

  it('a failed stamps read is null on every row, never an absence', () => {
    const out = annotateOwnArrivals([row('a1'), row('c1', { profile_id: 'x' })], facts([], { stamps: null }), ME)
    expect(out.map((r) => r.arrival)).toEqual([null, null])
  })

  it('no viewer: every row is null', () => {
    expect(annotateOwnArrivals([row('a1')], facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), null).map((r) => r.arrival)).toEqual([null])
  })

  it('keeps every other field and does not mutate its input', () => {
    const r = row('a1', { open_swap_status: 'pending' })
    const before = JSON.parse(JSON.stringify(r))
    const out = annotateOwnArrivals([r], facts([]), ME)
    expect(out[0].open_swap_status).toBe('pending')
    expect(r).toEqual(before)
  })

  it('a non-array input is an empty list', () => {
    expect(annotateOwnArrivals(null, facts([]), ME)).toEqual([])
  })
})

describe('ownLocationIds', () => {
  it("is the studios of the caller's own rows, de-duplicated, nobody else's", () => {
    const rows = [row('a1'), row('a2'), row('a3', { location_id: L2 }), row('c1', { profile_id: 'x', location_id: 'loc-other' })]
    expect(ownLocationIds(rows, ME)).toEqual([L1, L2])
  })
  it('no viewer or no rows is empty', () => {
    expect(ownLocationIds([row('a1')], null)).toEqual([])
    expect(ownLocationIds(null, ME)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/shift-arrivals.test.js`
Expected: FAIL, "Failed to resolve import './shift-arrivals'".

- [ ] **Step 3: Write the pure half of the module**

```js
// src/lib/shift-arrivals.js
//
// ARRIVALSHOW.1 — "did the app record my arrival for this shift?" for
// GET /api/schedule/shifts, so the phone's Schedule tab (Me view) can show a
// coach their OWN arrival stamp. The first half of late/no-show alerts: the
// coach sees exactly what an alert would later judge.
//
// What "arrived" means (the table in the ARRIVALSHOW.1 plan):
//   - shift_assignments.arrived_at (mig 609) is the ONLY arrival. The geofence
//     check-in writes it (arrival_source 'geofence'); 'manual' is allowed by
//     the CHECK but nothing writes it yet.
//   - start_time_override / end_time_override are the MANAGER-set paid window
//     (mig 099). They are never an arrival (ARRIVAL.1; mig 610 moved the old
//     geofence stamps out). They only move the window an absence is judged
//     on, because that is the time the coach's card shows.
//   - No stamp, but an earlier same-day shift at the SAME studio has an
//     arrival and this one starts within 60 minutes of its BLOCK end: "on
//     site" (the attendance report's rule, inferContinuousArrivals).
//   - The double-stamp shape (16 Sep review; fixed by ARRIVAL.1/.2, cleaned
//     by mig 610): a stamp at the same instant as the earlier same-day
//     shift's arrival at the same studio IS that earlier arrival, so it also
//     reads "on site", never a second walk-in. Display only.
//
// Own rows only. The feed also serves the Team view: a coach or a manager
// gets the field on their OWN rows and null on everybody else's. The read is
// keyed on the caller AND bounded to the caller's own assignment ids, and
// annotateOwnArrivals re-checks profile_id on every row.
//
// Never throws and never fails the roster. Unknown is NEVER absence: a failed
// stamps read gives every row `arrival: null`, which the phone renders as
// nothing, not as "No arrival recorded".

import { logWarn } from './log'
import { resolveScheduledAt, inferContinuousArrivals, arrivalToTimeOnly } from './staff-attendance'
import { geofenceFromLocationSettings, geofenceIsConfigured } from './geofence-attendance'
import { resolveTz, dayStrInTz } from './tz-time'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'

const ms = (d) => (d instanceof Date ? d.getTime() : NaN)
const sortMs = (d) => { const v = ms(d); return Number.isFinite(v) ? v : Infinity }

function nextDateKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + 1))
  const pad = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

// The EFFECTIVE window as instants (override → block → template, the card's
// times). An end at or before the start ends the next day (payroll's rule).
function effectiveWindow(row, tz) {
  const startT = effectiveShiftStart(row)
  const endT = effectiveShiftEnd(row)
  const start = resolveScheduledAt(row.shift_date, startT, tz)
  let end = resolveScheduledAt(row.shift_date, endT, tz)
  if (start && end && end.getTime() <= start.getTime()) end = resolveScheduledAt(nextDateKey(row.shift_date), endT, tz)
  return {
    starts_at: start && Number.isFinite(start.getTime()) ? start.toISOString() : null,
    ends_at: end && Number.isFinite(end.getTime()) ? end.toISOString() : null,
  }
}

// Ids of rows whose OWN stamp is the same instant as the previous shift's
// arrival (same studio, same date): the double-stamp shape.
function sameInstantAsEarlier(rows) {
  const out = new Set()
  const ordered = [...rows].sort((a, b) => (
    a.profileId.localeCompare(b.profileId)
    || String(a.blockDate).localeCompare(String(b.blockDate))
    || sortMs(a.scheduledAt) - sortMs(b.scheduledAt)
  ))
  let prev = null
  for (const r of ordered) {
    if (
      prev && prev.profileId === r.profileId && prev.blockDate === r.blockDate
      && !r.arrivalInferred && r.arrivalAt && prev.arrivalAt
      && new Date(r.arrivalAt).getTime() === new Date(prev.arrivalAt).getTime()
    ) out.add(r.id)
    prev = r
  }
  return out
}

/**
 * The caller's own studios in this payload (for the tracking read).
 * De-duplicated, in first-seen order; never a colleague's row.
 */
export function ownLocationIds(rows, viewerId) {
  if (!viewerId) return []
  const ids = new Set()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.location_id && r.profile_id === viewerId) ids.add(r.location_id)
  }
  return [...ids]
}

/**
 * @param {Array<object>} rows toApiShiftRow() results (id = the assignment id)
 * @param {{ stamps: Map<string,{arrived_at:string,arrival_source:string|null}>|null,
 *           timezones: Map<string,string|null>|null,
 *           tracked: Map<string,boolean>|null }} facts  fetchOwnArrivalFacts()
 * @param {string|null} viewerId
 * @returns {Array<object>} new rows, each with `arrival`: an object on the
 *   viewer's own rows (when the stamps read succeeded), otherwise null.
 */
export function annotateOwnArrivals(rows, facts, viewerId) {
  const list = Array.isArray(rows) ? rows : []
  const stamps = facts?.stamps instanceof Map ? facts.stamps : null
  if (!viewerId || !stamps) return list.map((r) => ({ ...r, arrival: null }))

  const tzOf = (loc) => resolveTz(facts.timezones instanceof Map ? facts.timezones.get(loc) : null)
  const trackedOf = (loc) => (facts.tracked instanceof Map ? facts.tracked.get(loc) === true : null)

  // inferContinuousArrivals groups by (profileId, blockDate). Every row here is
  // the viewer's own, so the group key carries the STUDIO instead: an arrival
  // at one studio never makes the coach "on site" at another (the report is
  // per studio too). Block times, like the report.
  const base = list
    .filter((r) => r && r.profile_id === viewerId)
    .map((r) => {
      const tz = tzOf(r.location_id)
      const s = stamps.get(r.id)
      return {
        id: r.id,
        profileId: String(r.location_id ?? ''),
        blockDate: r.shift_date,
        scheduledAt: resolveScheduledAt(r.shift_date, r.block_start_time, tz),
        scheduledEndAt: resolveScheduledAt(r.shift_date, r.block_end_time, tz),
        arrivalAt: s?.arrived_at ? new Date(s.arrived_at) : null,
        source: s?.arrived_at ? (s.arrival_source ?? null) : null,
      }
    })
  const inferred = inferContinuousArrivals(base)
  const dup = sameInstantAsEarlier(inferred)
  const byId = new Map(inferred.map((b) => [b.id, b]))

  return list.map((r) => {
    if (!r || r.profile_id !== viewerId) return { ...r, arrival: null }
    const b = byId.get(r.id)
    const tz = tzOf(r.location_id)
    const at = b?.arrivalAt ? new Date(b.arrivalAt) : null
    const atOk = at && Number.isFinite(at.getTime())
    return {
      ...r,
      arrival: {
        at: atOk ? at.toISOString() : null,
        at_local: atOk ? arrivalToTimeOnly(at, tz).slice(0, 5) : null,
        at_local_date: atOk ? dayStrInTz(at, tz) : null,
        source: b?.arrivalInferred ? null : (b?.source ?? null),
        carried: !!b?.arrivalInferred || dup.has(r.id),
        tracked: trackedOf(r.location_id),
        ...effectiveWindow(r, tz),
      },
    }
  })
}
```

(`fetchOwnArrivalFacts` and `OWN_ARRIVAL_ID_CHUNK` come in Task 2, and nothing in Task 1 uses the `logWarn` or geofence imports. **Leave those two import lines out in Task 1 and add them in Task 2**, so this commit is lint-clean.)

- [ ] **Step 4: Run it to see it pass, in both timezones**

Run: `npx vitest run src/lib/shift-arrivals.test.js && TZ=America/Los_Angeles npx vitest run src/lib/shift-arrivals.test.js`
Expected: PASS both times.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shift-arrivals.js src/lib/shift-arrivals.test.js
git commit -m "ARRIVALSHOW.1 — what 'arrived' means on a coach's own shift (pure)

annotateOwnArrivals: arrived_at is the only arrival (never the paid-window
override); a back-to-back shift at the same studio is 'on site' by the
attendance report's own inferContinuousArrivals; a stamp at the same instant
as the earlier shift's arrival (the 16 Sep double-stamp shape) reads 'on
site' too; the absence window is the EFFECTIVE (card) window. Own rows only;
a failed stamps read is null on every row, never an absence.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The keyed reads, `fetchOwnArrivalFacts`

**Files:**
- Modify: `src/lib/shift-arrivals.test.js` (append)
- Modify: `src/lib/shift-arrivals.js` (append)

- [ ] **Step 1: Write the failing test (append)**

```js
// ── fetchOwnArrivalFacts ──────────────────────────────────────────
const { fetchOwnArrivalFacts, OWN_ARRIVAL_ID_CHUNK } = await import('./shift-arrivals')
const { logWarn } = await import('./log')

// Records EVERY query with its filters; `result(q)` answers per query.
function mockDb(result) {
  const queries = []
  return {
    queries,
    from(t) {
      const q = { table: t, select: null, filters: [] }
      queries.push(q)
      const b = {
        select: (c) => { q.select = c; return b },
        eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
        in: (c, v) => { q.filters.push(['in', c, v]); return b },
        then: (res, rej) => Promise.resolve(result(q)).then(res, rej),
      }
      return b
    },
  }
}
const ok = (data) => ({ data, error: null })
const answers = (byTable) => (q) => byTable[q.table](q)
const geoOn = { geofence: { enabled: true, latitude: 53.29, longitude: -6.2, radius_m: 100 } }

describe('fetchOwnArrivalFacts', () => {
  it('reads stamps keyed on the caller AND bounded to their own ids; tracking keyed on the caller', async () => {
    const db = mockDb(answers({
      shift_assignments: () => ok([{ id: 'a1', arrived_at: '2026-09-24T05:52:00.000Z', arrival_source: 'geofence' }, { id: 'a2', arrived_at: null, arrival_source: null }]),
      locations: () => ok([{ id: L1, timezone: 'Europe/Dublin', settings: geoOn }, { id: L2, timezone: 'Europe/Dublin', settings: {} }]),
      profile_locations: () => ok([{ location_id: L1, geofence_exempt: false }, { location_id: L2, geofence_exempt: false }]),
    }))
    const f = await fetchOwnArrivalFacts(db, ME, ['a1', 'a2'], [L1, L2])

    const sa = db.queries.find((q) => q.table === 'shift_assignments')
    expect(sa.select).toBe('id, arrived_at, arrival_source')
    expect(sa.filters).toEqual([['eq', 'profile_id', ME], ['in', 'id', ['a1', 'a2']]])
    const pl = db.queries.find((q) => q.table === 'profile_locations')
    expect(pl.select).toBe('location_id, geofence_exempt')
    expect(pl.filters).toEqual([['eq', 'profile_id', ME], ['in', 'location_id', [L1, L2]]])
    const lo = db.queries.find((q) => q.table === 'locations')
    expect(lo.select).toBe('id, timezone, settings')
    expect(lo.filters).toEqual([['in', 'id', [L1, L2]]])

    expect([...f.stamps.keys()]).toEqual(['a1'])           // a row with no arrival is not a stamp
    expect(f.timezones.get(L1)).toBe('Europe/Dublin')
    expect(Object.fromEntries(f.tracked)).toEqual({ [L1]: true, [L2]: false }) // L2 geofence not configured
  })

  it('an exempt coach is not tracked; no membership row is not tracked', async () => {
    const db = mockDb(answers({
      shift_assignments: () => ok([]),
      locations: () => ok([{ id: L1, timezone: null, settings: geoOn }, { id: L2, timezone: null, settings: geoOn }]),
      profile_locations: () => ok([{ location_id: L1, geofence_exempt: true }]),
    }))
    const f = await fetchOwnArrivalFacts(db, ME, ['a1'], [L1, L2])
    expect(Object.fromEntries(f.tracked)).toEqual({ [L1]: false, [L2]: false })
  })

  it('chunks the stamps read past OWN_ARRIVAL_ID_CHUNK ids', async () => {
    const ids = Array.from({ length: OWN_ARRIVAL_ID_CHUNK + 5 }, (_, i) => `a${i}`)
    const db = mockDb(answers({ shift_assignments: () => ok([]), locations: () => ok([]), profile_locations: () => ok([]) }))
    await fetchOwnArrivalFacts(db, ME, ids, [L1])
    const reads = db.queries.filter((q) => q.table === 'shift_assignments')
    expect(reads).toHaveLength(2)
    expect(reads[0].filters[1][2]).toHaveLength(OWN_ARRIVAL_ID_CHUNK)
    expect(reads[1].filters[1][2]).toHaveLength(5)
  })

  it('no viewer or no own ids costs no query at all', async () => {
    const db = mockDb(() => { throw new Error('should not query') })
    expect(await fetchOwnArrivalFacts(db, ME, [], [L1])).toEqual({ stamps: new Map(), timezones: new Map(), tracked: new Map() })
    expect(await fetchOwnArrivalFacts(db, null, ['a1'], [L1])).toEqual({ stamps: new Map(), timezones: new Map(), tracked: new Map() })
    expect(db.queries).toHaveLength(0)
  })

  it('a failed stamps read is null (unknown), logged, never thrown', async () => {
    logWarn.mockClear()
    const db = mockDb(answers({
      shift_assignments: () => ({ data: null, error: { message: 'boom' } }),
      locations: () => ok([{ id: L1, timezone: 'Europe/Dublin', settings: geoOn }]),
      profile_locations: () => ok([{ location_id: L1, geofence_exempt: false }]),
    }))
    const f = await fetchOwnArrivalFacts(db, ME, ['a1'], [L1])
    expect(f.stamps).toBeNull()
    expect(f.tracked.get(L1)).toBe(true)
    expect(logWarn).toHaveBeenCalledWith('schedule', expect.stringContaining('arrivals'), expect.anything())
  })

  it('a failed membership read makes tracking unknown (null) but keeps the timezones', async () => {
    const db = mockDb(answers({
      shift_assignments: () => ok([]),
      locations: () => ok([{ id: L1, timezone: 'Europe/Dublin', settings: geoOn }]),
      profile_locations: () => ({ data: null, error: { message: 'boom' } }),
    }))
    const f = await fetchOwnArrivalFacts(db, ME, ['a1'], [L1])
    expect(f.tracked).toBeNull()
    expect(f.timezones.get(L1)).toBe('Europe/Dublin')
  })

  it('a failed locations read makes tracking unknown and leaves the timezones empty (Dublin)', async () => {
    const db = mockDb(answers({
      shift_assignments: () => ok([]),
      locations: () => ({ data: null, error: { message: 'boom' } }),
      profile_locations: () => ok([]),
    }))
    const f = await fetchOwnArrivalFacts(db, ME, ['a1'], [L1])
    expect(f.tracked).toBeNull()
    expect(f.timezones.size).toBe(0)
  })

  it('a read that throws is caught', async () => {
    const db = mockDb(() => { throw new Error('socket hang up') })
    const f = await fetchOwnArrivalFacts(db, ME, ['a1'], [L1])
    expect(f.stamps).toBeNull()
    expect(f.tracked).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/shift-arrivals.test.js`
Expected: FAIL, `fetchOwnArrivalFacts is not a function`.

- [ ] **Step 3: Implement.** Add the two imports Task 1 left out at the top of `src/lib/shift-arrivals.js` (`import { logWarn } from './log'` and `import { geofenceFromLocationSettings, geofenceIsConfigured } from './geofence-attendance'`), then append:

```js
// Ids per stamps query. A coach has a handful of shifts a week, so a chunk
// is far under the 1,000-row select cap and ~4KB of `in.(…)` on the URL
// (the same bound as shift-open-swaps.js).
export const OWN_ARRIVAL_ID_CHUNK = 100

const uniq = (xs) => [...new Set((Array.isArray(xs) ? xs : []).filter(Boolean))]

async function readStamps(db, viewerId, ids) {
  try {
    const out = new Map()
    for (let i = 0; i < ids.length; i += OWN_ARRIVAL_ID_CHUNK) {
      const { data, error } = await db.from('shift_assignments')
        .select('id, arrived_at, arrival_source')
        .eq('profile_id', viewerId)
        .in('id', ids.slice(i, i + OWN_ARRIVAL_ID_CHUNK))
      if (error) throw error
      for (const r of data || []) if (r?.id && r.arrived_at) out.set(r.id, r)
    }
    return out
  } catch (err) {
    logWarn('schedule', 'own arrivals read failed; shifts returned without arrival', { err: err?.message || String(err) })
    return null
  }
}

// Tracking = the studio's geofence is configured AND the caller is not exempt
// there: the same rule GET /api/attendance/geofence-config uses to pick the
// regions the phone registers. Timezones survive a failed membership read.
async function readTracking(db, viewerId, locIds) {
  const timezones = new Map()
  if (locIds.length === 0) return { timezones, tracked: new Map() }
  try {
    const [locRes, linkRes] = await Promise.all([
      db.from('locations').select('id, timezone, settings').in('id', locIds),
      db.from('profile_locations').select('location_id, geofence_exempt').eq('profile_id', viewerId).in('location_id', locIds),
    ])
    if (locRes.error) throw locRes.error
    for (const l of locRes.data || []) timezones.set(l.id, l.timezone ?? null)
    if (linkRes.error) throw linkRes.error
    const notExempt = new Set((linkRes.data || []).filter((l) => !l.geofence_exempt).map((l) => l.location_id))
    const tracked = new Map()
    for (const l of locRes.data || []) {
      tracked.set(l.id, notExempt.has(l.id) && geofenceIsConfigured(geofenceFromLocationSettings(l.settings)))
    }
    return { timezones, tracked }
  } catch (err) {
    logWarn('schedule', 'arrival tracking read failed; absence will not be shown', { err: err?.message || String(err) })
    return { timezones, tracked: null }
  }
}

/**
 * Facts for annotateOwnArrivals. Bounded twice: keyed on the caller (a per-user
 * row: the owner check IS the access rule) and on the caller's own assignment
 * ids / studios in the payload. A caller with no own row costs no query.
 * Never throws: a failed read is `null` (unknown), never "no arrival".
 */
export async function fetchOwnArrivalFacts(db, viewerId, ownIds, locationIds) {
  const ids = uniq(ownIds)
  const locs = uniq(locationIds)
  if (!viewerId || ids.length === 0) return { stamps: new Map(), timezones: new Map(), tracked: new Map() }
  const [stamps, tracking] = await Promise.all([readStamps(db, viewerId, ids), readTracking(db, viewerId, locs)])
  return { stamps, ...tracking }
}
```

- [ ] **Step 4: Run it to see it pass, both timezones**

Run: `npx vitest run src/lib/shift-arrivals.test.js && TZ=America/Los_Angeles npx vitest run src/lib/shift-arrivals.test.js`
Expected: PASS.

- [ ] **Step 5: Lint and schema checks on the new file**

Run: `npx eslint src/lib/shift-arrivals.js src/lib/shift-arrivals.test.js && npm run check:select-columns && npm run check:guardrails`
Expected: clean. `check:select-columns` resolves `shift_assignments.arrived_at/arrival_source` (mig 609), `locations.timezone/settings`, `profile_locations.geofence_exempt` (mig 463).

- [ ] **Step 6: Commit**

```bash
git add src/lib/shift-arrivals.js src/lib/shift-arrivals.test.js
git commit -m "ARRIVALSHOW.1 — keyed, never-throwing reads for the caller's own arrivals

Stamps keyed on profile_id AND the caller's own assignment ids (chunked);
tracking = studio geofence configured AND caller not exempt (the
geofence-config rule). A failed read is null (unknown), logged, never
thrown, never read as 'no arrival'.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Wire it into `GET /api/schedule/shifts`, and document it

**Files:**
- Modify: `src/app/api/schedule/shifts/route.test.js`
- Modify: `src/app/api/schedule/shifts/route.js`
- Modify: `src/lib/openapi.js`

- [ ] **Step 1: Update the test file**

(a) After the `vi.mock('@/lib/shift-open-swaps', …)` block, add:

```js
// ARRIVALSHOW.1 — keep the real annotate (pure); stub only the read. The
// default answers "stamps unreadable", so every row carries arrival: null.
vi.mock('@/lib/shift-arrivals', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchOwnArrivalFacts: vi.fn(() => Promise.resolve({ stamps: null, timezones: new Map(), tracked: null })),
}))
```

and after `const { fetchOwnOpenSwaps } = await import('@/lib/shift-open-swaps')` add:

```js
const { fetchOwnArrivalFacts } = await import('@/lib/shift-arrivals')
```

(b) The three existing `open_swap_status` expectations gain `arrival: null` on every row (the field is explicit on every row, own or not):

```js
    expect(body.data).toEqual([
      { id: 'a1', profile_id: 'c', open_swap_status: 'pending', arrival: null },
      { id: 'a2', profile_id: 'other', open_swap_status: null, arrival: null },
    ])
```
```js
    expect(body.data).toEqual([
      { id: 'a1', profile_id: 'coach-a', open_swap_status: null, arrival: null },
      { id: 'a2', profile_id: 'm', open_swap_status: 'awaiting_approval', arrival: null },
    ])
```
```js
    expect(body.data).toEqual([{ id: 'a1', profile_id: 'coach-a', open_swap_status: null, arrival: null }])
```

(c) Append a new block:

```js
// ARRIVALSHOW.1 — the Schedule tab's arrival line reads `arrival`. Own rows only.
describe('GET /api/schedule/shifts — own arrival (ARRIVALSHOW.1)', () => {
  const coach = { id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] }
  const shiftRow = (id, profileId) => ({
    id, profile_id: profileId, location_id: 'loc-1', shift_date: '2026-09-24',
    block_start_time: '07:00:00', block_end_time: '08:00:00', start_time_override: null, end_time_override: null,
  })

  it("asks about the caller's own assignment ids and studios only", async () => {
    getCurrentUser.mockResolvedValue(coach)
    fetchApiShiftRows.mockResolvedValueOnce({ rows: [shiftRow('a1', 'c'), shiftRow('a2', 'other')], error: null })
    await GET(req())
    expect(fetchOwnArrivalFacts).toHaveBeenLastCalledWith(expect.anything(), 'c', ['a1'], ['loc-1'])
  })

  it("puts the arrival on the caller's row and null on a colleague's", async () => {
    getCurrentUser.mockResolvedValue(coach)
    fetchApiShiftRows.mockResolvedValueOnce({ rows: [shiftRow('a1', 'c'), shiftRow('a2', 'other')], error: null })
    fetchOwnArrivalFacts.mockResolvedValueOnce({
      stamps: new Map([
        ['a1', { id: 'a1', arrived_at: '2026-09-24T05:52:00.000Z', arrival_source: 'geofence' }],
        ['a2', { id: 'a2', arrived_at: '2026-09-24T05:40:00.000Z', arrival_source: 'geofence' }],
      ]),
      timezones: new Map([['loc-1', 'Europe/Dublin']]),
      tracked: new Map([['loc-1', true]]),
    })
    const body = await (await GET(req())).json()
    expect(body.data[0].arrival).toMatchObject({ at: '2026-09-24T05:52:00.000Z', at_local: '06:52', carried: false, tracked: true })
    expect(body.data[1].arrival).toBeNull()
  })

  it('a failed arrivals read still returns the roster, with no arrival on any row', async () => {
    getCurrentUser.mockResolvedValue(coach)
    fetchApiShiftRows.mockResolvedValueOnce({ rows: [shiftRow('a1', 'c')], error: null })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((r) => r.arrival)).toEqual([null])
  })
})
```

- [ ] **Step 2: Run it to see the new block fail** (the three edited assertions and the new ones)

Run: `npx vitest run src/app/api/schedule/shifts/route.test.js`
Expected: FAIL. `arrival` is missing from the rows and `fetchOwnArrivalFacts` was never called.

- [ ] **Step 3: Wire the route**

In `src/app/api/schedule/shifts/route.js`, after `import { fetchOwnOpenSwaps, annotateOwnOpenSwaps, ownShiftIds } from '@/lib/shift-open-swaps'` add:

```js
import { fetchOwnArrivalFacts, annotateOwnArrivals, ownLocationIds } from '@/lib/shift-arrivals'
```

Replace the final two statements (the `// COVERLOOP.2 — the caller's OWN rows say whether a swap is open…` comment block, `const ownOpenSwaps = await fetchOwnOpenSwaps(db, user.id, ownShiftIds(rows, user.id))` and the `return NextResponse.json({ success: true, data: annotateOwnOpenSwaps(rows, ownOpenSwaps, user.id) })`) with:

```js
  // COVERLOOP.2 — the caller's OWN rows say whether a swap is open on them
  // (the phone's "Swap pending" chip). Keyed on the caller AND bounded to the
  // caller's own assignment ids in this payload; no own rows = no query.
  // ARRIVALSHOW.1 — and what the app recorded as their arrival (the Schedule
  // tab's arrival line). Same bounds, same rule: own rows only, never throws,
  // and an unreadable arrival is null on every row, never "not recorded".
  const ownIds = ownShiftIds(rows, user.id)
  const [ownOpenSwaps, arrivalFacts] = await Promise.all([
    fetchOwnOpenSwaps(db, user.id, ownIds),
    fetchOwnArrivalFacts(db, user.id, ownIds, ownLocationIds(rows, user.id)),
  ])
  const withSwaps = annotateOwnOpenSwaps(rows, ownOpenSwaps, user.id)
  return NextResponse.json({ success: true, data: annotateOwnArrivals(withSwaps, arrivalFacts, user.id) })
```

- [ ] **Step 4: Document the field**

In `src/lib/openapi.js`, in the `/api/schedule/shifts` GET registration, append to the end of the `description` string (inside the closing quote, after "…(never set on a colleague's row)."):

```
 Each row also carries arrival (ARRIVALSHOW.1): on the CALLER's own rows an object { at, at_local, at_local_date, source, carried, tracked, starts_at, ends_at } — at is shift_assignments.arrived_at (never the manager-set paid-window override); carried = on site from an earlier back-to-back shift that day at the same studio (the attendance report's rule), or a stamp at the same instant as that earlier arrival; tracked = the studio's geofence is on and the caller is not exempt (null when unknown); starts_at/ends_at = the shift's effective window. null on colleagues' rows and whenever the arrival read failed.
```

- [ ] **Step 5: Run the route, openapi and neighbours**

Run: `npx vitest run src/app/api/schedule/shifts/route.test.js src/lib/shift-arrivals.test.js src/lib/shift-open-swaps.test.js src/lib/roster-read.test.js src/lib/openapi.test.js`
Expected: PASS.

Run: `npx eslint src/app/api/schedule/shifts/route.js src/app/api/schedule/shifts/route.test.js src/lib/openapi.js && npm run check:route-guards && npm run check:location-scoping`
Expected: clean. The route still calls `getCurrentUser` and `assertLocationAccess`, and the new reads live in `src/lib`, keyed on the caller.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/schedule/shifts/route.js src/app/api/schedule/shifts/route.test.js src/lib/openapi.js
git commit -m "ARRIVALSHOW.1 — GET /api/schedule/shifts carries the caller's own arrival

Beside COVERLOOP.2's own open-swap read, in parallel, same bounds. A
colleague's row, and a manager's team feed, carry arrival: null. A failed
read never fails the roster.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The phone's decision, `mobile/lib/shift-arrival.js` (OTA bundle path)

**Files:**
- Create: `mobile/lib/shift-arrival.test.js`
- Create: `mobile/lib/shift-arrival.js`

- [ ] **Step 1: Write the failing test**

```js
// mobile/lib/shift-arrival.test.js
//
// ARRIVALSHOW.1 — the one line a coach sees under their own shift. Pure: the
// server sends facts (src/lib/shift-arrivals.js), this decides with "now".
// Runs under TZ=Europe/Dublin and TZ=America/Los_Angeles in the gate: nothing
// here may depend on the phone's zone.

import { describe, it, expect } from 'vitest'
import { arrivalLine, arrivalHelpFor, ARRIVAL_WORDS } from './shift-arrival'

const START = '2026-09-24T06:00:00.000Z' // 07:00 Dublin
const END = '2026-09-24T07:00:00.000Z'   // 08:00 Dublin
const at = (iso) => Date.parse(iso)

const shift = (arrival, over = {}) => ({ id: 'a1', shift_date: '2026-09-24', published: true, arrival, ...over })
const none = (over = {}) => ({
  at: null, at_local: null, at_local_date: null, source: null, carried: false, tracked: true,
  starts_at: START, ends_at: END, ...over,
})
const stamped = (over = {}) => none({ at: '2026-09-24T05:52:00.000Z', at_local: '06:52', at_local_date: '2026-09-24', source: 'geofence', ...over })

describe('arrivalLine — a stamp', () => {
  it('reads "Arrived 06:52", before, during and after the shift', () => {
    for (const now of [at('2026-09-24T05:55:00Z'), at('2026-09-24T06:30:00Z'), at('2026-09-24T09:00:00Z')]) {
      expect(arrivalLine(shift(stamped()), now)).toEqual({ kind: 'arrived', text: 'Arrived 06:52' })
    }
  })

  it('an arrival the evening before a just-after-midnight shift says so', () => {
    const s = shift(stamped({ at_local: '23:50', at_local_date: '2026-09-24' }), { shift_date: '2026-09-25' })
    expect(arrivalLine(s, at('2026-09-25T01:00:00Z')).text).toBe('Arrived 23:50 the day before')
  })

  it('carried (back-to-back, or the double-stamp shape) reads as on site', () => {
    expect(arrivalLine(shift(stamped({ carried: true, source: null })), at('2026-09-24T09:00:00Z')))
      .toEqual({ kind: 'on_site', text: 'On site from your earlier shift (arrived 06:52)' })
  })

  it('a stamp shows even where arrivals are not tracked, and on a draft', () => {
    expect(arrivalLine(shift(stamped({ tracked: false })), 0).kind).toBe('arrived')
    expect(arrivalLine(shift(stamped({ tracked: null })), 0).kind).toBe('arrived')
    expect(arrivalLine(shift(stamped(), { published: false }), 0).kind).toBe('arrived')
  })
})

describe('arrivalLine — no stamp', () => {
  it.each([
    ['before the shift starts', '2026-09-24T05:59:59Z', null],
    ['exactly at the start', '2026-09-24T06:00:00Z', 'not_yet'],
    ['during the shift', '2026-09-24T06:30:00Z', 'not_yet'],
    ['exactly at the end', '2026-09-24T07:00:00Z', 'not_recorded'],
    ['after the shift', '2026-09-25T12:00:00Z', 'not_recorded'],
  ])('%s', (_name, nowIso, kind) => {
    const line = arrivalLine(shift(none()), at(nowIso))
    expect(line?.kind ?? null).toBe(kind)
  })

  it('the words', () => {
    expect(arrivalLine(shift(none()), at('2026-09-24T06:30:00Z')).text).toBe('No arrival recorded yet')
    expect(arrivalLine(shift(none()), at('2026-09-24T08:00:00Z')).text).toBe('No arrival recorded')
  })

  it('not tracked (studio off, exempt) shows nothing', () => {
    expect(arrivalLine(shift(none({ tracked: false })), at('2026-09-24T08:00:00Z'))).toBeNull()
  })

  it('tracking unknown (a failed read) shows nothing: unknown is never absence', () => {
    expect(arrivalLine(shift(none({ tracked: null })), at('2026-09-24T08:00:00Z'))).toBeNull()
  })

  it('a draft shows no absence line', () => {
    expect(arrivalLine(shift(none(), { published: false }), at('2026-09-24T08:00:00Z'))).toBeNull()
  })

  it('no window, or a broken one, shows nothing', () => {
    expect(arrivalLine(shift(none({ starts_at: null })), at('2026-09-24T08:00:00Z'))).toBeNull()
    expect(arrivalLine(shift(none({ ends_at: 'soon' })), at('2026-09-24T08:00:00Z'))).toBeNull()
  })

  it('a malformed local time falls back to the absence rules, never "Arrived undefined"', () => {
    expect(arrivalLine(shift(stamped({ at_local: '6:52' })), at('2026-09-24T08:00:00Z')).kind).toBe('not_recorded')
  })

  it('a missing "now" shows no absence line', () => {
    expect(arrivalLine(shift(none()), undefined)).toBeNull()
    expect(arrivalLine(shift(none()), NaN)).toBeNull()
  })
})

describe('arrivalLine — nothing to say', () => {
  it.each([
    ['an old server (no field)', { id: 'a1', shift_date: '2026-09-24' }],
    ["a colleague's row, or a failed read (null)", shift(null)],
    ['a garbage value', shift('arrived')],
    ['no shift', null],
  ])('%s', (_name, s) => {
    expect(arrivalLine(s, at('2026-09-24T08:00:00Z'))).toBeNull()
  })
})

describe('the words (D7)', () => {
  it('no word says late, missed, no-show or absent', () => {
    const all = [
      ARRIVAL_WORDS.arrived('06:52'), ARRIVAL_WORDS.arrivedDayBefore('23:50'), ARRIVAL_WORDS.onSite('06:52'),
      ARRIVAL_WORDS.notYet, ARRIVAL_WORDS.notRecorded, ARRIVAL_WORDS.help,
    ].join(' ').toLowerCase()
    for (const w of ['late', 'missed', 'no-show', 'no show', 'absent']) expect(all).not.toContain(w)
  })
})

describe('arrivalHelpFor', () => {
  it('shows only when a line shows', () => {
    const now = at('2026-09-24T08:00:00Z')
    expect(arrivalHelpFor([], now)).toBeNull()
    expect(arrivalHelpFor(null, now)).toBeNull()
    expect(arrivalHelpFor([shift(none({ tracked: false })), shift(null)], now)).toBeNull()
    expect(arrivalHelpFor([shift(null), shift(none())], now)).toBe(ARRIVAL_WORDS.help)
    expect(arrivalHelpFor([shift(stamped())], now)).toBe(ARRIVAL_WORDS.help)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run mobile/lib/shift-arrival.test.js`
Expected: FAIL, "Failed to resolve import './shift-arrival'".

- [ ] **Step 3: Implement**

```js
// mobile/lib/shift-arrival.js
//
// ARRIVALSHOW.1 — the one line under a coach's OWN shift on the Schedule tab
// (Me view): what the app recorded as their arrival. Pure, no React, no Intl:
// the server (src/lib/shift-arrivals.js, via GET /api/schedule/shifts) sends
// the facts, including the studio-local HH:MM, so a Hermes build without ICU
// and a phone set to another zone both read it right. This file only compares
// "now" with two instants and picks words.
//
// Unknown is never absence: no `arrival` (an old server), null (a colleague's
// row, or a failed read), or tracked !== true all show NOTHING about a
// missing arrival. A stored stamp is always shown.
//
// Words are neutral on purpose (late/no-show alerts are held, 00-INDEX): the
// time, never minutes late, never "missed". Tone classes live in
// components/schedule/ArrivalLine.jsx (NativeWind does not scan mobile/lib).

export const ARRIVAL_WORDS = Object.freeze({
  arrived: (hhmm) => `Arrived ${hhmm}`,
  arrivedDayBefore: (hhmm) => `Arrived ${hhmm} the day before`,
  onSite: (hhmm) => `On site from your earlier shift (arrived ${hhmm})`,
  notYet: 'No arrival recorded yet',
  notRecorded: 'No arrival recorded',
  help: "Arrival times come from your phone's location when you reach the studio. They don't change your hours.",
})

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * @param {object|null} shift  a GET /api/schedule/shifts row
 * @param {number} nowMs       Date.now() at render
 * @returns {{ kind: 'arrived'|'on_site'|'not_yet'|'not_recorded', text: string } | null}
 */
export function arrivalLine(shift, nowMs) {
  const a = shift?.arrival
  if (!a || typeof a !== 'object') return null

  if (typeof a.at_local === 'string' && HHMM.test(a.at_local)) {
    if (a.carried === true) return { kind: 'on_site', text: ARRIVAL_WORDS.onSite(a.at_local) }
    const dayBefore = DATE.test(a.at_local_date || '') && DATE.test(shift.shift_date || '') && a.at_local_date < shift.shift_date
    return { kind: 'arrived', text: dayBefore ? ARRIVAL_WORDS.arrivedDayBefore(a.at_local) : ARRIVAL_WORDS.arrived(a.at_local) }
  }

  // No stamp: say so only where arrivals are really tracked, on a published
  // shift, once it has started.
  if (a.tracked !== true || shift.published === false) return null
  const starts = Date.parse(a.starts_at ?? '')
  const ends = Date.parse(a.ends_at ?? '')
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || !Number.isFinite(nowMs)) return null
  if (nowMs < starts) return null
  if (nowMs < ends) return { kind: 'not_yet', text: ARRIVAL_WORDS.notYet }
  return { kind: 'not_recorded', text: ARRIVAL_WORDS.notRecorded }
}

/** The help line under the Me list: shown only when some line shows. */
export function arrivalHelpFor(shifts, nowMs) {
  for (const s of Array.isArray(shifts) ? shifts : []) {
    if (arrivalLine(s, nowMs)) return ARRIVAL_WORDS.help
  }
  return null
}
```

- [ ] **Step 4: Run it, both timezones**

Run: `npx vitest run mobile/lib/shift-arrival.test.js && TZ=America/Los_Angeles npx vitest run mobile/lib/shift-arrival.test.js`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/shift-arrival.js mobile/lib/shift-arrival.test.js
git commit -m "ARRIVALSHOW.1 — phone: the arrival line's words, decided in a pure lib

Arrived HH:MM / on site from your earlier shift / no arrival recorded (yet).
Unknown, untracked, drafts and not-yet-started shifts say nothing about
absence. No Intl on the phone: the server sends the local time.

Bundle path: merging publishes an OTA at 100%.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The line on the Schedule tab (OTA bundle paths)

**Files:**
- Create: `mobile/components/schedule/ArrivalLine.jsx`
- Modify: `mobile/app/(staff)/(tabs)/schedule.jsx`

- [ ] **Step 1: Write the component**

```jsx
// mobile/components/schedule/ArrivalLine.jsx
// ARRIVALSHOW.1 — one line under a coach's own shift: what the app recorded
// as their arrival. Words and every decision: lib/shift-arrival.js. Tone
// classes are whole literals HERE because NativeWind does not scan mobile/lib.
// Green for a recorded arrival, grey for none. Never red or amber: late and
// no-show alerts are held (00-INDEX).

import { View, Text } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { arrivalLine } from '../../lib/shift-arrival'

const TONE = {
  arrived: { icon: 'checkmark-circle-outline', color: '#15803D', text: 'text-green-700' },
  on_site: { icon: 'checkmark-circle-outline', color: '#15803D', text: 'text-green-700' },
  not_yet: { icon: 'time-outline', color: '#64748B', text: 'text-un1t-subtle' },
  not_recorded: { icon: 'remove-circle-outline', color: '#64748B', text: 'text-un1t-subtle' },
}

export default function ArrivalLine({ shift, nowMs, compact = false }) {
  const line = arrivalLine(shift, nowMs)
  if (!line) return null
  const tone = TONE[line.kind]
  return (
    <View className="flex-row items-center mt-1" accessible accessibilityLabel={line.text}>
      <Ionicons name={tone.icon} size={compact ? 11 : 13} color={tone.color} />
      <Text
        className={compact ? `text-[10px] ml-1 flex-1 ${tone.text}` : `text-xs ml-1 flex-1 ${tone.text}`}
        numberOfLines={compact ? 2 : 1}
      >
        {line.text}
      </Text>
    </View>
  )
}
```

- [ ] **Step 2: Mount it in `schedule.jsx`** (find each anchor by its text)

(a) Imports: after `import { briefingOf } from 'shared/shift-briefing'` add:

```js
import ArrivalLine from '../../../components/schedule/ArrivalLine'
import { arrivalHelpFor, ARRIVAL_WORDS } from '../../../lib/shift-arrival'
```

(b) `ShiftCard` (the iPad card). Change its signature from `function ShiftCard({ shift, onPress, onLongPress, teamMode, selfId })` to:

```js
function ShiftCard({ shift, onPress, onLongPress, teamMode, selfId, nowMs }) {
```

and directly after the `<Text className="text-[11px] text-un1t-subtle mt-0.5">` … `{timeRange(effStart, effEnd)}` … `</Text>` element, add:

```jsx
      {/* ARRIVALSHOW.1 — own shifts only (Me grid); the Team grid never shows arrivals. */}
      {!teamMode && <ArrivalLine shift={shift} nowMs={nowMs} compact />}
```

(c) `WeekGridView`: add `nowMs` to its destructured props (`function WeekGridView({ anchor, shiftsByDate, timeOff, todayIso, canAdjust, openAdjust, requestSwap, teamMode, selfId, nowMs })`) and pass `nowMs={nowMs}` on its `<ShiftCard … />`.

(d) `ShiftRow`: change `function ShiftRow({ shift, onPress, onLongPress })` to `function ShiftRow({ shift, onPress, onLongPress, nowMs })`, and directly after the `<View className="flex-row items-center">` block that renders `{timeRange(effStart, effEnd)} · {hours}h` (the one closing before `{adjusted && (`), add:

```jsx
      {/* ARRIVALSHOW.1 — what the app recorded as your arrival (arrived_at,
          never the Adjusted paid time below). */}
      <ArrivalLine shift={shift} nowMs={nowMs} />
```

(e) In `Schedule()`, directly before `return (`, add:

```js
  // ARRIVALSHOW.1 — "now" for the arrival lines, read at render. The tab
  // refetches (and so re-renders) on every focus, so no ticking timer.
  const nowMs = Date.now()
  const arrivalHelp = view === 'me' && !loading ? arrivalHelpFor(isTablet ? shifts : todays, nowMs) : null
```

(f) Pass `nowMs={nowMs}` to `<WeekGridView … />` and to the Me list's `<ShiftRow … />` (the one inside `{todays.map(s => (`).

(g) Directly before `{/* ICSFEED.1 — own published shifts in the coach's calendar app. Me view only, phone and iPad. */}`, add:

```jsx
        {/* ARRIVALSHOW.1 — what the arrival lines are, once, when one shows. */}
        {arrivalHelp ? (
          <Text className="text-[11px] text-un1t-muted text-center mt-2 px-4">{ARRIVAL_WORDS.help}</Text>
        ) : null}
```

- [ ] **Step 3: Lint, imports, OTA paths**

Run: `npm run check:mobile-lint && npm run check:mobile-imports && npm run check:ota-paths`
Expected: all exit 0. `check:mobile-imports` resolves `arrivalLine`, `arrivalHelpFor` and `ARRIVAL_WORDS` from `lib/shift-arrival`.

- [ ] **Step 4: Commit**

```bash
git add mobile/components/schedule/ArrivalLine.jsx 'mobile/app/(staff)/(tabs)/schedule.jsx'
git commit -m "ARRIVALSHOW.1 — phone: the arrival line on the Schedule tab's Me view

iPhone ShiftRow and the iPad Me grid card; never the Team view. One help
line under the list when any arrival line shows.

Bundle paths: merging publishes an OTA at 100%.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The attendance doc

**Files:**
- Modify: `docs/staff-attendance.md` (append at the end)

- [ ] **Step 1: Append**

```markdown
### What coaches see (ARRIVALSHOW.1)

The phone's Schedule tab (Me view, phone and iPad) shows one line under each of the coach's OWN shifts: "Arrived 06:52", "On site from your earlier shift (arrived 06:52)", "No arrival recorded yet" (the shift has started) or "No arrival recorded" (it has ended). Nothing is shown before a shift starts, at a studio with the geofence off, for a geofence-exempt coach, on a draft, or when the server could not read the arrivals. It never shows minutes late, and no alert is sent (late and no-show alerts are held until coverage is above ~80%).

- Source: `GET /api/schedule/shifts` adds `arrival` on the caller's own rows only (`src/lib/shift-arrivals.js`); colleagues' rows, and a manager's Team feed, carry `null`.
- **Arrived = `shift_assignments.arrived_at`, nothing else.** The manager-set `start_time_override` is the paid window and is never an arrival; it only moves the window the "No arrival recorded" line is judged on (the times the card shows).
- **On site** = the attendance report's carry-over (`inferContinuousArrivals`: the same coach, day and studio, the next shift starting ≤ 60 min after the previous block's end), plus a stamp at the same instant as the earlier shift's arrival (the old double-stamp shape; display only).
- The server sends the studio-local `HH:MM`; the phone does no timezone maths (`mobile/lib/shift-arrival.js`).
```

- [ ] **Step 2: Commit**

```bash
git add docs/staff-attendance.md
git commit -m "ARRIVALSHOW.1 — docs: what coaches see of their own arrival

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine). Rebase on `origin/main` (CANDIDATES.1 / REPLACE.1 may have touched `schedule.jsx` or the shifts route), then:

- [ ] **Focused tests, both zones:**

```bash
git fetch origin main && git rebase origin/main
npx vitest run src/lib/shift-arrivals.test.js mobile/lib/shift-arrival.test.js src/app/api/schedule/shifts/route.test.js \
  src/lib/shift-open-swaps.test.js src/lib/roster-read.test.js src/lib/staff-attendance.test.js src/lib/openapi.test.js \
  mobile/lib/schedule-api.test.js tests/ota-trigger-paths.test.js
for tz in Europe/Dublin America/Los_Angeles; do
  TZ=$tz npx vitest run src/lib/shift-arrivals.test.js mobile/lib/shift-arrival.test.js
done
```

Expected: `0 failed` every time.

- [ ] **The 12-command CI mirror (CLAUDE.md "Build, test & ship"):**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0, and vitest reports `0 failed`.
- `check:select-columns`: the three new selects resolve against migs 463/609 and the `locations` table.
- `check:mobile-imports` / `check:mobile-lint`: clean on `ArrivalLine.jsx`, `schedule.jsx`, `shift-arrival.js`.
- `check:ota-paths`: no new top-level `mobile/` entry.
- `check:mobile-parity`, `check:rls-restrictive` and `check:bundle-sql` are untouched (no permission key, no migration).

- [ ] **The build:**

```bash
npm run build
```

Expected: `✓ Compiled successfully`. This is the only check that catches a bad `@shared/roster-month` / `./tz-time` import in the new server module (vitest runs on mocked imports).

- [ ] **On the PR:** **Test & lint** and **Next build** (required) green on the final rebase, and **Mobile bundle export** (`mobile-export.yml`) green.

- [ ] **Independent review** (standing rule). Point the reviewer at:
  - D1: can any path put a colleague's `arrived_at` on a row? The read is keyed on `profile_id`, and the annotate re-checks it. Also check the manager Team feed.
  - D6: can any failure become "No arrival recorded"? Trace `stamps: null`, `tracked: null`, missing studio, missing window, missing field.
  - D2/D3 against `inferContinuousArrivals` and mig 610's `duplicate_orphan`. The studio-as-group-key trick in `annotateOwnArrivals`.
  - D5: the effective window versus the report's block start (intentional; a follow-up).
  - The phone in the iOS Simulator (Claude Code iOS Simulator panel): Me view on the smallest iPhone and on an iPad, VoiceOver on a line, the largest text size. jsdom cannot see layout, and there is no RN test runner. The simulator talks to PROD and this PR only reads, so any account is safe.

### Merge steps (after review is approved and the gate is green)

1. No migration. Check that no other OTA PR's EAS Update run is in flight (LABOUR.1, the batch partner, is web only).
2. Rebase, wait for the required checks on the final rebase, and merge.
3. Watch the EAS Update run (`eas-update.yml`) to success before merging any other OTA PR. It re-runs the whole suite, so an unrelated flake can block it. Also check that the prod deploy is green.
4. Verify on prod with a read: signed in as yourself in Chrome, `GET /api/schedule/shifts?location_id=<Stillorgan>&profile_id=<you>&start_date=<Mon>&end_date=<Sun>` shows `arrival` objects on your rows. With no `profile_id` (the Team feed), every other coach's row shows `arrival: null`.
5. Handset checklist (Richard's, or with him alongside), below.

### PR

**Title:** `ARRIVALSHOW.1 — coaches see their own arrival on the phone's Schedule tab`

**Body must say, in this order:**
1. **🔴 This merge publishes an OTA at 100%** (2.4.0 lane; `mobile/lib`, `mobile/components`, `mobile/app`). No native dependency, no `runtimeVersion` bump. **No migration.** Web and phone can land in either order (an old server means the line simply never shows).
2. What coaches see: the table from the plan (Arrived / On site / No arrival recorded yet / No arrival recorded / nothing), Me view only, own shifts only. Neutral words, no minutes late, green or grey, never red. One help line.
3. **What "arrived" means:** `arrived_at` only. The paid-window override is never an arrival. The report's carry-over is reused (same studio, ≤ 60 min). The old double-stamp shape reads as on site. Verified on prod before the build: 0 seconds-bearing overrides, 0 same-instant double stamps.
4. **Own rows only** (keyed read plus a re-check); a manager's Team feed carries no colleague's arrival. Unknown is never absence: a failed read is `null`, and the phone shows nothing. The roster never fails because of it.
5. **Late and no-show alerts are NOT in this PR.** The plan lists what they will need (coverage gate, a manual-arrival writer, the early-arrival hole, one lateness reference, delivery rules).
6. Coverage now, for the record (Stillorgan, 30 days): 19% of shifts stamped (27% with carry-over; 31% of coach-days). 48% of coach-days had no geofence ping, although all 9 coaches report "always" permission. Two coaches on 2.3.x will not get this update until they update the app.
7. **Handset checklist** (after the update lands):
   - [ ] Me view, a day with a stamped shift: "Arrived HH:MM" under the time, in green, matching `/schedule/attendance`.
   - [ ] A back-to-back second shift: "On site from your earlier shift (arrived HH:MM)".
   - [ ] A shift that has started with no stamp: "No arrival recorded yet" (grey). After it ends: "No arrival recorded".
   - [ ] A future shift: no line. The help line appears only when a line does.
   - [ ] Team view: no arrival anywhere, including your own row.
   - [ ] A shift with an Adjusted time: the arrival line is separate from "Block default …", and "No arrival recorded yet" starts at the adjusted start, not the block start.
   - [ ] iPad Me grid: a compact line on each card; the Team grid shows none.
   - [ ] VoiceOver reads the line; the largest text size wraps without overlap.
   - [ ] View as user (master) on a coach: that coach's lines; your own arrival is not mixed in.
8. Follow-ups found (see below).
9. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit another row: `merge=union` duplicates an edited row.

```
| #<PR> | ARRIVALSHOW.1 — coaches see their own arrival on the phone's Schedule tab | 2026-09-2x. Wave 3 PR 34. **No migration; OTA** (mobile/lib, components, app; no native dependency). The first half of late/no-show alerts (the alerts stay held). `GET /api/schedule/shifts` adds `arrival` on the CALLER's own rows only (keyed read on profile_id + own assignment ids, re-checked per row; colleagues and a manager's Team feed get null), beside COVERLOOP.2's own-swap read: `{ at, at_local, at_local_date, source, carried, tracked, starts_at, ends_at }` from new `src/lib/shift-arrivals.js` (pure `annotateOwnArrivals` + never-throwing `fetchOwnArrivalFacts`). Arrived = `arrived_at` only, never the paid-window override; on site = the attendance report's `inferContinuousArrivals` (same studio, ≤60 min) plus a stamp at the same instant as the earlier shift's (the 16 Sep double-stamp shape, display only); tracked = studio geofence configured AND not exempt; absence judged on the EFFECTIVE window; unknown (failed read, untracked, draft, old server) never reads as absence. Phone: pure `mobile/lib/shift-arrival.js` (no Intl; both TZs) + `components/schedule/ArrivalLine.jsx` on the Me view's ShiftRow and iPad Me card: "Arrived 06:52" / "On site from your earlier shift (arrived 06:52)" / "No arrival recorded yet" / "No arrival recorded", green or grey, no minutes late; one help line. Prod before build: 19% of shifts stamped (31% of coach-days), 0 seconds-bearing overrides, 0 same-instant double stamps. |
```

---

### Review notes / open questions (for Richard)

1. **Show the absence at all? (REVIEW, default: yes, neutral grey.)** About 70% of ended shifts will read "No arrival recorded" at today's coverage. That is the point (the coach is the one person who knows), but it could read as a black mark. The fallback is a one-line change in `arrivalLine`: show stamps only.
2. **Minutes early or late (default: not shown).** The line shows the time only. Showing "4 min after the start" would be the alert arriving early by another route. Revisit with the alert half.
3. **"I was here."** A coach who sees "No arrival recorded" has nothing to press, and a manager has nowhere to record it either: nothing writes `arrival_source = 'manual'`. Should the next PR be a manager "record arrival" action on the attendance report, a coach request, or both? This is a precondition for alerts.
4. **Home tab.** The Home "today" card could show the same line. It reads `shared/dashboard-data.js` mobile-direct under RLS, so it would need a service-role read. Not done here; say if you want it.
5. **Managers on the phone** see only their own arrival. Everyone else's stays on `/schedule/attendance` (web, `attendance_reports`). A phone attendance view for managers would be a separate PR.
6. **The help line's second sentence** ("They don't change your hours") restates ARRIVAL.1's rule that an arrival never moves paid hours (its decision D-A). Confirm that is the rule you want coaches told.
7. **Two coaches are on 2.3.x** and will not see this until they update the app. The in-app update nudge exists; a word from a manager may be quicker.

### Follow-ups found while planning (not in this PR)

- 🔴 **No writer for a manual arrival.** Mig 609 allows `arrival_source = 'manual'`, but no route or UI sets or clears `arrived_at` except the geofence check-in (and the swap RPCs clearing it on a moved shift). A wrong or missing stamp cannot be corrected. Blocks the alert half.
- **Early arrivals are lost.** A geofence ENTER more than 45 minutes before the first shift is stored `no_shift_in_window`, and the region never re-fires while the coach stays inside: 11 of 23 pinged-but-unstamped coach-days in the last 30 days. A matcher decision (re-match at report time, or widen the window for the day's first shift).
- **48% of coach-days have no geofence ping at all**, although every rostered coach reports "always" permission and 7 of 9 are on 2.4.0. Diagnose before any alert: OS delivery, the 100 m radius, iOS not firing ENTER when registration happens inside the region.
- **The attendance report measures lateness against the BLOCK start, ignoring a manager's `start_time_override`** (`src/app/api/attendance/route.js:115-116, 122, 147`). A coach told to start at 08:00 in a 07:00 block reads 60 minutes late. The phone line uses the effective window; the alert half must pick one.
- **The attendance report's default window uses UTC "today"** (`route.js:36-39`: `today.toISOString().slice(0, 10)` through a variable, which the guardrail's AST rule cannot see). Between 00:00 and 01:00 Irish summer time, the default `to` is yesterday.
- **The attendance report validates dates by shape only** (`route.js:44`), so `2026-02-30` reaches Postgres and 500s. DATECHECK.1 covered `/api/schedule/*` only. Its select is also unpaged (1,000-row cap, about five months at Stillorgan's volume), and it discards the `staff_attendance_events` read error (`:90-94`), so a failed read silently drops the Source badges.
- 00-INDEX's "three of nine coaches have none" is now two of nine (30-day window, 24 Sep).

---

### Self-review (done while writing)

- **Spec coverage:**
  - Coaches see their own stamp on the phone: Tasks 3-5.
  - Own only, no colleague data: D1, Task 1 (two tests), Task 3 (route test).
  - What "arrived" means for a stamp, an override or nothing: the table and D5, with Task 1 and Task 4 tests.
  - The double stamp: What was found (fixed on main, verified in prod) plus D3, Task 1.
  - Dublin wall clock: server-formatted `at_local`, BST/GMT/spring-forward tests, phone tests in both zones.
  - `shared/` seam: not needed. The phone imports nothing from `src/lib`, and the one shared helper (`effectiveShiftStart/End`) is used server-side via `@shared/roster-month`.
  - `api()`: the phone reuses `getMyShifts` (already `api()`).
  - No RN tests: decisions in `mobile/lib/shift-arrival.js`.
  - Quiet hours: no notice is sent.
  - The alert half is not built, and its needs are listed.
  - OTA yes, migration none.
  - Gate, PR, CHANGELOG and open questions are above.
- **Placeholders:** none. The only blanks are the CHANGELOG date and PR number, filled at PR time.
- **Names:** `annotateOwnArrivals`, `fetchOwnArrivalFacts`, `ownLocationIds`, `OWN_ARRIVAL_ID_CHUNK`, `arrivalLine`, `arrivalHelpFor`, `ARRIVAL_WORDS`, `ArrivalLine` are used with the same names and argument shapes in every task and test. The facts shape `{ stamps, timezones, tracked }` is the same in Tasks 1-3. The `arrival` object keys are the same on the server, in the route test, in the phone lib and in the openapi text.
