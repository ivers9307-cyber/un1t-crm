## PR PAYROLL24.1 — payroll counts a shift ending at 24:00 as the hours it is, not 0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `timeToHours` (`src/lib/payroll.js`) reads exactly `'24:00'` and `'24:00:00'` as 24.0 hours and still refuses everything past it (`'24:01'`, `'24:00:01'`, `'24:30'`, `'25:00'`). Then `shiftHours`, `computeWeeklyCost` and every report, panel and projection built on them count a 22:00–24:00 shift as 2 hours instead of 0.

**Architecture:** One line in `timeToHours`. `shiftHours` itself does not change: once 24 parses, its existing rule (`end - start`, plus 24 when negative) already gives the right answer for every case (see Decisions). Tests pin the fix at every layer the index names (`shiftHours`, `computeWeeklyCost`, the staff_hours and staff_cost reports) plus utilisation and the contractor-spend summary. A parity test pins the sweep: payroll, both `shared/` `shiftDurationHours`, `roster-compare`'s `windowHours` and `workingWindow` must agree on every `24:00` window. The SNAPSHOT.1 pin that expected payroll's 0 flips, and the two comments that describe the old difference are corrected.

**Tech Stack:** plain ES modules, Vitest 5.

**Ships:** web deploy only. **No migration.** Nothing under `mobile/` or `shared/` changes, so **no OTA**. The new tests import from `shared/`, but they live in `src/lib/`, which is not a bundle path.

**Worktree:** branch `payroll24-1` off a fresh `origin/main`, in its own fresh worktree (never a shared one, and never `git stash` in it). If `node_modules` is missing, run `npm ci` once. Run tests per file with `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the PR gate (8GB machine).

**Merge order:** A1 merges before A2 CONTRACTORSPEND.1, whose pricing reads `payroll.js` (index "Conflict hotspots"). A1 appends to `src/lib/roster-summary.test.js`, which A2 will also touch. Append-only, so a rebase is trivial.

---

### What was found

**Checked against `origin/main` at `28d02e59` (#1779), 27 Sep 2026.**

#### The defect

`src/lib/payroll.js:32`:

```js
  if (h > 23 || mm > 59 || ss > 59) return null
```

`'24:00'` and `'24:00:00'` return `null`. Then `shiftHours` (`:57`) returns 0 for any shift whose effective start or end is `24:00`. Measured under both zones, same output (scratch copies of `origin/main` files, Node 24):

| window | `payroll.shiftHours` | `shared/roster-month` `shiftDurationHours` | `shared/working-time` `workingWindow` (h) |
|---|---|---|---|
| 22:00–24:00 | **0** | 2 | 2 |
| `22:00:00`–`24:00:00` (DB text) | **0** | 2 | 2 |
| 00:00–24:00 | **0** | 24 | 24 |
| 18:30–24:00 | **0** | 5.5 | 5.5 |
| 22:00–00:00 | 2 | 2 | 2 |
| 24:00–02:00 | **0** | 2 | null (untimed) |
| 24:00–24:00 | 0 | 0 | null (untimed) |

After the one-line fix, payroll's column equals `roster-month`'s on every row, under `TZ=Europe/Dublin` and `TZ=America/Los_Angeles` alike (measured the same way).

#### Prod: has anyone been under-paid? No. The bug is latent.

Read-only counts on `iyvtbjjxdggiadzwwvdj`, 27 Sep 2026 (counts only):

| Check | Result |
|---|---|
| `shift_blocks.end_time = '24:00:00'` / `start_time = '24:00:00'` | **0 / 0** of 934 blocks |
| `shift_assignments.end_time_override = '24:00:00'` / `start_time_override = '24:00:00'` | **0 / 0** of 872 assignments |
| `shift_templates.end_time = '24:00:00'` / `start_time = '24:00:00'` | **0 / 0** |
| `roster_publish_snapshots.snapshot::text LIKE '%24:00%'` | **0** |
| latest end anywhere (`max(end_time)` blocks / templates; `max(end_time_override)`) | 20:30 / 20:30 / 10:30 |
| blocks with `end_time < start_time`, or ending `00:00:00` | 0, 0 |
| legacy `public.shifts` | does not exist (retired) |

**Zero shifts were under-paid or under-counted.** Why none can exist today:

- **The DB would take one.** All six time columns are Postgres `time without time zone`, which accepts `'24:00:00'`. `shift_blocks` has `CHECK (end_time > start_time)` (`supabase/migrations/067_roster_v2_shift_blocks.sql:90`, `shift_blocks_time_order`). That allows a 24:00 end and makes a 24:00 **start** impossible on a block, since nothing is later than 24:00. `shift_assignments` and `shift_templates` carry no time CHECK.
- **No writer can send one.** Every schedule write validates with `timeOfDay` (`src/lib/schemas.js:51-54`, `^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$`), which refuses hour 24:
  - `POST /api/schedule/blocks` (`blocks/route.js:31-32`);
  - `PUT /api/schedule/blocks/[id]` (`blocks/[id]/route.js:179-180`, `194-195`);
  - the assignment override PUT (`assignments/[id]/route.js:56-57`);
  - templates create/update (`templates/route.js:18-19`, `templates/[id]/route.js:21-22`).

  Clone copies stored rows, and the assistant's `create_shift` goes through a template. So a `24:00` can only arrive by direct SQL or by a future writer: a widened `timeOfDay`, the un1t.online sync, or an import.

That is why this is S and not an incident: it fixes the reader before any writer can produce the value. Open question 1 asks whether a 24:00 end should become enterable.

#### Every caller of `timeToHours` / `shiftHours` / `computeWeeklyCost` (all fixed by the one line; none changes)

| Caller (file:line) | Surface | Reaches it via |
|---|---|---|
| `src/lib/payroll.js:100` `computeWeeklyCost` | (library) | `shiftHours` per shift |
| `src/lib/report-generator.js:230` (`staff_hours`), `:311` (`staff_cost`, through `computeWeeklyCost`), `:491` (`utilisation`) | `POST /api/schedule/reports`, `/api/cron/run-scheduled-reports`, Reporting tab (`ScheduleReporting.jsx`) | rows from `fetchScheduledShiftRows` (`:87-138`) carry `block_start_time`/`block_end_time` + overrides |
| `src/lib/roster-week-cost.js:107` `computeWeeklyFteHours` → `computeWeeklyCost` | `GET /api/schedule/week-cost` (the calendar's over-contract panel) | `blocksToShiftRows` |
| `src/lib/roster-summary.js:180` `sumHoursForProfile` → `summarizeWeek` (`:216`) / `summarizeMonth` (`:321`) | `GET /api/schedule/contractor-spend` (via `roster-summary-server.js`), `RosterSummaryPanel.jsx` | `blocksToShiftRows` (`:129-165`) |
| `src/lib/roster-publish.js:313` `blockContractorCost` | the contractor-budget publish gate: `projectPublishImpact` (`:375`), used by `POST /api/schedule/rosters`, `rosters/[id]/approve`, the approvals page/provider, `ScheduleCalendar.jsx` | `{ overrides, shift_templates: { block times } }` |
| `src/lib/contractor-invoices.js:140` `computeScheduledForPeriod` | invoice review "scheduled hours" (`/api/invoices/[id]`, `/approve`) | `{ overrides, start_time, end_time, shift_templates }` |
| `src/app/api/assistant/chat/route.js:367`, `:413` | staff assistant `generate_report` (staff_hours, staff_cost); the assistant is off everywhere | `fetchScheduledShiftRows` rows |
| `src/components/dashboard/MonthRoster.jsx:405` | web Today page month roster, "· 2h" per shift | the dashboard's normalised shift rows |
| `src/lib/roster-compare.test.js:70` | a **test pin** that expects payroll's 0 (SNAPSHOT.1 left it for this PR) | — |

Mobile: nothing under `mobile/` imports `@/lib/payroll` (`git grep payroll origin/main -- mobile` shows only comments). The phone's hours come from `shared/` and `mobile/lib/dates.js` (below).

#### The sweep: every other HH:MM parser that turns shift times into hours or instants

| Parser (file:line) | What it computes | `24:00` today | Action |
|---|---|---|---|
| `shared/roster-month.js:60-72` `durationMins` / `shiftDurationHours` / `summariseShifts` | Today dashboards' hours, web + phone | ✅ `split(':')` → 1440 min; 22–24 = 2h, 00–24 = 24h | none (pinned by the parity test) |
| `shared/dashboard-data.js:61-72` `shiftDurationHours` | Business labour estimate, Today strip, phone | ✅ same arithmetic, 1dp | none (pinned) |
| `shared/working-time.js:74-82` `parseEndTime`, `workingWindow` `:162-186` | rest/48h advisories, the grid's minutes (`roster-grid-model.js`), LABOUR.1's hours basis (`labour-month-model.js:160`) | ✅ **end** = next day's 00:00 (real instants). ❌ a 24:00 **start** refuses (`parseTime` `h > 23`) → untimed, counted by `untimedShiftCount` | none; the start case is a documented difference (Decision 4, open question 3) |
| `src/lib/roster-compare.js:61-83` `hhmm` / `minutesOf` / `windowHours` | SNAPSHOT.1 published-vs-now totals | ✅ both sides; start 24:00 = minute 1440 | comment only (Task 3) |
| `src/lib/staff-calendar-feed.js:49-66` `hhmm` / `wallInstant` | the ICS feed's instants | ✅ `'24:00'` = next day 00:00 | none |
| `mobile/lib/dates.js:66-72` `hoursBetween` | phone Schedule tab "· 2h" (`schedule.jsx:222`, `:265`) | ✅ `split(':')` arithmetic | none (would be an OTA; not needed) |
| `src/lib/shift-reminders.js:96`, `:330-341` `minutesOfDay` / `latestEndLabel` | reminder copy "until 24:00" | ✅ 1440, not before start | none |
| `src/lib/staff-attendance.js:57-66` `resolveScheduledAt`; `src/lib/push-reminders.js:42-60` `localToUtc` | START instants (lateness, reminders) | `Date.UTC(…, 24, 0)` rolls to next 00:00, which is correct by accident | none (starts cannot be 24:00 on a block) |
| `src/lib/tz-time.js:202-209` `wallMsInTz` | wall → instant | ❌ refuses 24 by design; `wallInstant` wraps it for ends | none |
| `shared/availability.js:32`, `:54-61` `TIME` / `minutes` | availability RULE times (stop at 23:59) | ❌ by design; `shared/candidates.js:381-386` and `roster-grid-model.js:123-128` already ask a 24:00 end as 23:59 | none |
| `src/lib/schemas.js:51` `timeOfDay`; `src/lib/roster-change-log.js:165`; `src/lib/roster-change-notify.js:36`; `src/lib/schedule/windows.js:22` | write validation / change-log detail shape / START label / Sonos-Shelly windows | ❌ refuse 24 | none here; `timeOfDay` is open question 1 |
| `src/lib/schedule-overlap.js:11-13`, `:30-37`, `:60-68` `fmtTime` / `formatTime12h` / `timeRangesOverlap` | clash check, card labels | overlap ✅ (lexical `'24:00'` > every start); label ❌ `formatTime12h('24:00')` → `'12pm'` | none; open question 2 (display, unreachable today) |
| `src/lib/push-reminders.js:68-74` `formatLocalTime` | push body start label | ❌ `'24:00'` → `'12:00pm'` | none (starts only) |

**So `payroll.timeToHours` was the only hours parser that refused a 24:00 end.** Every other duration reader already treats it as the end of the day, and nothing else needs a change for the rule the index sets.

#### Rules that bite in this PR
- The repo is PUBLIC: fixtures use `Coach Here`, `p-here`, `loc1`, `dan`, `sarah` (the names the existing fixtures already use). No real names.
- Keep dates away from 29 Mar / 25 Oct in the parity test. `workingWindow` measures real instants, so an `00:00–24:00` window on the clocks-back day is 25 hours there (correct for rest, not a wall-clock parity case).
- The `summarizeMonth` fixture uses the file's own local-date convention (`new Date('2026-05-15T12:00:00')`, read back with local getters), so it is zone-proof. A2 fixes that function's local parsing; do not touch it here.

---

### Decisions (each pinned by a test)

**D1. `timeToHours` accepts exactly `24:00` and `24:00:00` as 24.0, and nothing past it.** `'24:01'`, `'24:00:01'`, `'24:30'`, `'24:60'` and `'25:00'` stay `null`. Postgres `time` stores at most `24:00:00`, so anything past it is garbage, not a time. *Pinned:* Task 1, `timeToHours` "reads exactly 24:00 as the end of the day" and "refuses everything past 24:00".

**D2. A 24:00 END is midnight at the end of the block's day, so the shift runs up to it.** 22:00–24:00 = 2h, 18:30–24:00 = 5.5h, 00:00–24:00 = **24h**. This needs no new code: with `e = 24` and `s ≤ 23.99…`, `e - s` is never negative, so the overnight wrap never fires. An override end of `24:00` over a block ending 23:00 counts to 24:00, the same resolution as any override. *Pinned:* Task 1, `shiftHours` "a 24:00 end runs to the end of the day", in the three row shapes callers pass (legacy/block top-level, `block_*` normalised, `shift_templates`-only as `roster-publish.js:313` sends).

**D3. `22:00–00:00` and `22:00–24:00` are the same 2 hours.** This was already true for `00:00` through the wrap, and is now true for both spellings. `00:00–00:00` stays 0 (zero length, unchanged); only the explicit `24:00` spelling means a full day. *Pinned:* Task 1, "00:00 and 24:00 as an end are the same 2 hours; 00:00–00:00 stays 0".

**D4. A 24:00 START reads as that same midnight, with the existing wrap: 24:00–02:00 = 2h, 24:00–24:00 = 0h.** Neither refused nor treated as the start of the day. Why:

- **It needs no code.** It is what the one-line parser fix gives `shiftHours` by itself.
- **It matches the other readers.** It is exactly what `shared/roster-month`, `shared/dashboard-data` and `roster-compare.windowHours` already say. "Treat as 0" would make 24:00–24:00 a 24-hour shift, which nobody else says. "Refuse" would need new code in payroll and in `windowHours`, and it would still disagree with both `shared/` readers (an OTA to align).
- **Refusing is the class this PR removes.** Payroll's "refuse" is a silent 0 hours, and a silent 0 is exactly the defect being fixed.
- **It is nearly unreachable.** A block cannot start at 24:00 (`shift_blocks_time_order`). Only an assignment override written by SQL could.

`workingWindow` is the one reader that differs: it treats a 24:00 start as untimed and says so on screen. That is honest and stays (open question 3). *Pinned:* Task 1, "a 24:00 start reads as the same midnight, wrapping"; Task 4, the parity test's `KNOWN_DIFFERENCE` case.

**D5. One rule across the estate, pinned in one place.** A parity test fails if payroll, either `shared/` `shiftDurationHours`, `windowHours` or `workingWindow` ever disagree on a `24:00`-ending window. The SNAPSHOT.1 pin of the old difference (`roster-compare.test.js:67-70`) becomes an equality. *Pinned:* Task 3 and Task 4.

**D6. No historic correction.** No saved `generated_reports` row, invoice or snapshot is recomputed: prod holds no `24:00` time anywhere (count above), so there is nothing to correct. *Pinned by:* the prod counts in this plan (re-run them at the gate; Task 5 Step 3).

---

### File map

| File | Change |
|---|---|
| `src/lib/payroll.js` | Modify: header comment lines 14-17; `timeToHours` doc lines 21-24 and one inserted guard after line 31; `shiftHours` doc lines 36-43 |
| `src/lib/payroll.test.js` | Modify: new `it`s inside the `timeToHours` describe (lines 7-26); new describes appended at the end (after line 211) |
| `src/lib/report-generator.test.js` | Modify: new describe appended at the end (after line 786), reusing the module-scope `makeReportDb`, `assignmentRow`, `PERIOD`, `PL_ROWS`, `PROFILES` (lines 442-485) |
| `src/lib/roster-summary.test.js` | Modify: new describe appended at the end (after line 639), reusing module-scope `block`, `fteSarah`, `contractorDan` (lines 24-58) |
| `src/lib/roster-compare.test.js` | Modify: lines 65-71 (the pin) |
| `src/lib/roster-compare.js` | Modify: comment lines 23-27 only |
| `src/lib/hours-24.test.js` | Create: the cross-parser parity test |
| `docs/roster-v2.md` | Modify: lines 281-282 (the sentence about the difference) |
| `docs/CHANGELOG.md` | Modify: one new row, after `gh pr create` |

No route, no openapi, no migration, nothing under `mobile/` or `shared/`.

---

### Task 1: `timeToHours` reads exactly 24:00; `shiftHours` and `computeWeeklyCost` follow

**Files:** Modify `src/lib/payroll.test.js`, `src/lib/payroll.js`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/payroll.test.js`, inside `describe('timeToHours', …)`, add after the `'returns null for missing or malformed input'` case (after line 25, before the describe's closing `})` on line 26):

```js
  // PAYROLL24.1 — Postgres `time` holds '24:00:00': midnight at the END of the
  // day. It used to parse as null, so every shift ending at 24:00 was 0 hours.
  it('reads exactly 24:00 as the end of the day (PAYROLL24.1)', () => {
    expect(timeToHours('24:00')).toBe(24)
    expect(timeToHours('24:00:00')).toBe(24)
  })

  it('refuses everything past 24:00 (PAYROLL24.1)', () => {
    for (const t of ['24:01', '24:00:01', '24:30', '24:60', '25:00', '99:00']) {
      expect(timeToHours(t), t).toBeNull()
    }
  })
```

Append at the end of the file (after line 211):

```js
// ─── PAYROLL24.1 — a shift ending at 24:00 ───────────────────────────────────
//
// shiftHours needs no change of its own: once 24 parses, end - start is never
// negative for a 24:00 end, so the overnight wrap never fires. These pin it in
// the three row shapes the callers hand over.

describe('shiftHours — a 24:00 end (PAYROLL24.1)', () => {
  it('a 24:00 end runs to the end of the day', () => {
    // report-generator / roster-week-cost / roster-summary: block times on the row.
    expect(shiftHours({ start_time: '22:00', end_time: '24:00' })).toBe(2)
    // What Postgres hands back.
    expect(shiftHours({ start_time: '22:00:00', end_time: '24:00:00' })).toBe(2)
    expect(shiftHours({ start_time: '18:30:00', end_time: '24:00:00' })).toBe(5.5)
    expect(shiftHours({ start_time: '00:00', end_time: '24:00' })).toBe(24)
    // fetchScheduledShiftRows' normalised shape.
    expect(shiftHours({ block_start_time: '22:00:00', block_end_time: '24:00:00' })).toBe(2)
    // roster-publish.js blockContractorCost: block times inside shift_templates.
    expect(shiftHours({ shift_templates: { start_time: '22:00:00', end_time: '24:00:00' } })).toBe(2)
    // contractor-invoices.js: overrides + block times + template.
    expect(shiftHours({
      start_time_override: null, end_time_override: null,
      start_time: '22:00:00', end_time: '24:00:00',
      shift_templates: { start_time: '09:00:00', end_time: '10:00:00' },
    })).toBe(2)
  })

  it('an override ending at 24:00 wins over the block end', () => {
    expect(shiftHours({ start_time: '21:00:00', end_time: '23:00:00', end_time_override: '24:00:00' })).toBe(3)
  })

  it('00:00 and 24:00 as an end are the same 2 hours; 00:00-00:00 stays 0', () => {
    expect(shiftHours({ start_time: '22:00', end_time: '00:00' })).toBe(2)
    expect(shiftHours({ start_time: '22:00', end_time: '24:00' })).toBe(2)
    expect(shiftHours({ start_time: '00:00', end_time: '00:00' })).toBe(0)
  })

  // Decision D4: a 24:00 START is that same midnight, with the usual wrap. A
  // block cannot start at 24:00 (shift_blocks_time_order, mig 067:90); only an
  // override written by hand could. shared/roster-month and roster-compare
  // read it the same way; workingWindow calls it untimed (hours-24.test.js).
  it('a 24:00 start reads as the same midnight, wrapping', () => {
    expect(shiftHours({ start_time: '24:00', end_time: '02:00' })).toBe(2)
    expect(shiftHours({ start_time: '24:00', end_time: '24:00' })).toBe(0)
  })

  it('a time past 24:00 still counts 0, never NaN', () => {
    expect(shiftHours({ start_time: '22:00', end_time: '24:30' })).toBe(0)
    expect(shiftHours({ start_time: '22:00', end_time: '24:00:01' })).toBe(0)
  })
})

describe('computeWeeklyCost — a 24:00 end is paid (PAYROLL24.1)', () => {
  const fte = { employment_type: 'fte', annual_salary: 52000, contracted_hours_per_week: 40, overtime_rate: 35 } // 25/h
  const late = { start_time: '22:00:00', end_time: '24:00:00' }
  const day = (h) => ({ start_time: '09:00', end_time: `${String(9 + h).padStart(2, '0')}:00` })

  it('counts and costs the 2 hours', () => {
    const r = computeWeeklyCost({ shifts: [late], profile: fte })
    expect(r.actual_hours).toBe(2)
    expect(r.regular_cost).toBe(50)
    expect(r.total_cost).toBe(50)
  })

  it('a 24:00 shift can be the one that crosses into overtime', () => {
    const r = computeWeeklyCost({ shifts: [day(10), day(10), day(10), day(10), late], profile: fte }) // 42h
    expect(r.regular_hours).toBe(40)
    expect(r.overtime_hours).toBe(2)
    expect(r.overtime_cost).toBe(70) // 2 × 35
    expect(r.over_threshold).toBe(true)
  })

  it('a contractor is paid for it', () => {
    const r = computeWeeklyCost({ shifts: [late], profile: { employment_type: 'contractor', hourly_rate: 30 } })
    expect(r.total_cost).toBe(60)
  })
})
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/lib/payroll.test.js`
Expected: FAIL.
- `timeToHours('24:00')` receives `null`, expected 24.
- `shiftHours` 22:00–24:00 receives 0, expected 2 (every shape).
- `computeWeeklyCost` `actual_hours` 0, and `overtime_hours` 0, `over_threshold` false in the overtime case.
- `a 24:00 start reads as the same midnight` fails on its first line (24:00–02:00 receives 0, expected 2).
- Two new cases already PASS and must stay green: `refuses everything past 24:00` and `a time past 24:00 still counts 0, never NaN`. Every other new case fails.

- [ ] **Step 3: Write the minimal implementation**

In `src/lib/payroll.js`, replace lines 14-17:

```js
// Time format expected:
//   shifts: array of objects with `start_time` (HH:MM[:SS]) and `end_time`
//   (HH:MM[:SS]). Optional override fields take precedence:
//   start_time_override / end_time_override.
```

with:

```js
// Time format expected:
//   shifts: array of objects with `start_time` (HH:MM[:SS]) and `end_time`
//   (HH:MM[:SS]). Optional override fields take precedence:
//   start_time_override / end_time_override. '24:00[:00]' is midnight at the
//   END of the day (Postgres `time` stores it), PAYROLL24.1.
```

Replace the `timeToHours` doc comment, lines 21-24:

```js
/**
 * Convert a HH:MM[:SS] string to fractional hours since midnight.
 * Returns null if the input is missing or malformed.
 */
```

with:

```js
/**
 * Convert a HH:MM[:SS] string to fractional hours since midnight.
 * '24:00' / '24:00:00' is 24: midnight at the END of the day, the largest
 * value a Postgres `time` holds (PAYROLL24.1). Anything past it is null.
 * Returns null if the input is missing or malformed.
 */
```

Then, in the body, insert the new guard directly above the existing range check (line 32, `  if (h > 23 || mm > 59 || ss > 59) return null`), so it sits between `const ss = …` (line 31) and that check:

```js
  // PAYROLL24.1 — refusing hour 24 made every shift ending at 24:00 0 hours
  // in payroll and in every report built on shiftHours.
  if (h === 24 && mm === 0 && ss === 0) return 24
```

Leave the regex line, the three `const` lines, the range check and the `return` untouched. Afterwards the function body reads, in order:
- the null/type guard;
- the regex match, and null if no match;
- `h`, `mm`, `ss`;
- **the new 24:00 guard**;
- `if (h > 23 || mm > 59 || ss > 59) return null`;
- `return h + mm / 60 + ss / 3600`.

Replace lines 36-43 (the `shiftHours` doc comment):

```js
/**
 * Compute the duration of a single shift in hours.
 * Honours start_time_override / end_time_override when set.
 * Treats overnight shifts (end < start) as crossing midnight.
 *
 * @param {object} shift  A shift row joined with its shift_template.
 * @returns {number} duration in hours, 0 if either time is missing/malformed.
 */
```

with:

```js
/**
 * Compute the duration of a single shift in hours.
 * Honours start_time_override / end_time_override when set.
 * Treats overnight shifts (end < start) as crossing midnight.
 * A 24:00 end runs to the end of the day (22:00-24:00 = 2h, 00:00-24:00 =
 * 24h); a 24:00 start is that same midnight, so 24:00-02:00 wraps to 2h
 * (PAYROLL24.1; the same reading as shared/roster-month.js and
 * roster-compare.js windowHours, pinned in hours-24.test.js).
 *
 * @param {object} shift  A shift row joined with its shift_template.
 * @returns {number} duration in hours, 0 if either time is missing/malformed.
 */
```

`shiftHours`'s body (lines 44-61 before the edit) does not change.

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/lib/payroll.test.js`
Expected: all pass (the existing 25 plus the 10 new ones). The pre-existing `timeToHours('25:00')` null case still passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payroll.js src/lib/payroll.test.js
git commit -m "$(cat <<'EOF'
PAYROLL24.1 — timeToHours reads 24:00 as the end of the day; a 22:00-24:00 shift is 2h, not 0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: the reports and the contractor-spend summary count it

These tests go in after Task 1, so they pass at once. Step 4 proves each one bites against the old parser.

**Files:** Modify `src/lib/report-generator.test.js`, `src/lib/roster-summary.test.js`.

- [ ] **Step 1: Write the report tests**

Append to the end of `src/lib/report-generator.test.js` (after line 786). It reuses `makeReportDb`, `assignmentRow`, `PERIOD`, `PL_ROWS` and `PROFILES` from lines 442-485. `PROFILES[0]` (`p-here`) is €26,000 on 10h a week, so €50/h.

```js
// ─── PAYROLL24.1 — a shift ending at 24:00 is in every report ────────────────
//
// payroll.timeToHours refused hour 24, so these three reports counted a
// 22:00-24:00 shift as 0 hours (and €0).

describe('generateReport — a shift ending at 24:00 (PAYROLL24.1)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const late = () => assignmentRow('p-here', { startOverride: '22:00:00', endOverride: '24:00:00' })

  it('staff_hours counts its 2 hours', async () => {
    const { db, captured } = makeReportDb({ shift_assignments: [late()] })
    createServerClient.mockReturnValue(db)

    const res = await generateReport({ report_type: 'staff_hours', ...PERIOD })
    expect(res.success).toBe(true)
    expect(captured.inserted.summary.total_hours).toBe(2)
    expect(captured.inserted.report_data.staff[0].total).toBe(2)
    expect(captured.inserted.report_data.staff[0].days['2026-05-04']).toBe(2)
  })

  it('staff_cost costs its 2 hours', async () => {
    const { db, captured } = makeReportDb({
      profile_locations: PL_ROWS,
      profiles: [PROFILES[0]],
      shift_assignments: [late()],
    })
    createServerClient.mockReturnValue(db)

    const res = await generateReport({ report_type: 'staff_cost', ...PERIOD })
    expect(res.success).toBe(true)
    expect(captured.inserted.summary.total_hours).toBe(2)
    expect(captured.inserted.summary.total_cost).toBe(100) // 2h × €50
    expect(captured.inserted.report_data.staff[0].regular_hours).toBe(2)
  })

  it('utilisation counts its 2 hours', async () => {
    const { db, captured } = makeReportDb({
      profile_locations: PL_ROWS,
      profiles: [PROFILES[0]],
      shift_assignments: [late()],
    })
    createServerClient.mockReturnValue(db)

    await generateReport({ report_type: 'utilisation', ...PERIOD })
    expect(captured.inserted.report_data.staff[0].actual_hours).toBe(2)
    expect(captured.inserted.report_data.staff[0].utilisation_pct).toBe(20) // 2 of 10
  })

  it('the block\'s own 24:00 end counts too (no override)', async () => {
    const row = assignmentRow('p-here')
    row.shift_blocks = { ...row.shift_blocks, start_time: '22:00:00', end_time: '24:00:00' }
    const { db, captured } = makeReportDb({ shift_assignments: [row] })
    createServerClient.mockReturnValue(db)

    await generateReport({ report_type: 'staff_hours', ...PERIOD })
    expect(captured.inserted.summary.total_hours).toBe(2)
  })
})
```

- [ ] **Step 2: Write the contractor-spend and week-panel tests**

Append to the end of `src/lib/roster-summary.test.js` (after line 639). It reuses `block`, `fteSarah` (€25/h, 30h) and `contractorDan` (€35/h) from lines 24-58.

```js
// PAYROLL24.1 — contractor spend and the week panel read hours through
// payroll.shiftHours, which counted a shift ending at 24:00 as 0.
describe('a shift ending at 24:00 (PAYROLL24.1)', () => {
  const refMay = new Date('2026-05-15T12:00:00')
  const weekStart = new Date('2026-05-04T00:00:00')
  const today = new Date('2026-05-01T12:00:00')

  it('summarizeMonth prices its 2 contractor hours', () => {
    const blocks = [block({ id: 'late', date: '2026-05-04', start: '22:00:00', end: '24:00:00', coaches: ['dan'] })]
    const r = summarizeMonth({ blocks, staff: [contractorDan], referenceDate: refMay, monthlyBudgetEur: 100 })
    expect(r.contractorCostEur).toBe(70) // 2h × €35
    expect(r.remainingEur).toBe(30)
  })

  it('summarizeWeek allocates its 2 hours to the FTE and prices the contractor', () => {
    const blocks = [block({ id: 'late', date: '2026-05-05', start: '22:00:00', end: '24:00:00', coaches: ['sarah', 'dan'] })]
    const r = summarizeWeek({ blocks, staff: [fteSarah, contractorDan], weekStart, today })
    expect(r.fte[0]).toMatchObject({ profile_id: 'sarah', allocated_hours: 2 })
    expect(r.contractorWeekCostEur).toBe(70)
  })
})
```

- [ ] **Step 3: Run them, expect PASS**

Run: `npx vitest run src/lib/report-generator.test.js src/lib/roster-summary.test.js`
Expected: all pass.

- [ ] **Step 4: Prove they bite (old parser back, temporarily)**

Put the refusal back in `src/lib/payroll.js` by deleting the one added line `  if (h === 24 && mm === 0 && ss === 0) return 24`. Then run:

`npx vitest run src/lib/report-generator.test.js src/lib/roster-summary.test.js -t 'PAYROLL24.1'`

Expected: all 6 FAIL. Hours read 0 and cost 0. `summarizeWeek` has no `fte[0]`, because a 0-hour FTE is skipped by `if (allocated <= 0) continue` (`roster-summary.js:235`).

Then undo the edit (never `git stash` in a worktree):

```bash
git restore src/lib/payroll.js
```

Re-run the same command: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/report-generator.test.js src/lib/roster-summary.test.js
git commit -m "$(cat <<'EOF'
PAYROLL24.1 — pin the staff_hours, staff_cost, utilisation and contractor-spend figures for a 24:00 shift

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: retire SNAPSHOT.1's "deliberate difference"

**Files:** Modify `src/lib/roster-compare.test.js`, `src/lib/roster-compare.js`, `docs/roster-v2.md`.

- [ ] **Step 1: Flip the pin (it fails now, which is its purpose)**

Run first: `npx vitest run src/lib/roster-compare.test.js`
Expected: exactly 1 FAIL, `reads a '24:00' end as midnight`: `shiftHours(22:00–24:00)` is now 2, and the pin expected 0. That line was left to announce this fix.

In `src/lib/roster-compare.test.js`, replace lines 65-71:

```js
  it("reads a '24:00' end as midnight", () => {
    expect(windowHours({ start: '22:00', end: '24:00' })).toBe(2)
    // payroll.timeToHours refuses hour 24, so payroll counts this 0h. Pinned
    // so the day someone fixes payroll, this line tells them to delete it
    // (the follow-up in 32-SNAPSHOT.1.md).
    expect(shiftHours({ start_time: '22:00', end_time: '24:00' })).toBe(0)
  })
```

with:

```js
  it("reads a '24:00' end as midnight, exactly as payroll does (PAYROLL24.1)", () => {
    expect(windowHours({ start: '22:00', end: '24:00' })).toBe(2)
    for (const [start, end] of [['22:00', '24:00'], ['00:00', '24:00'], ['18:30', '24:00'], ['24:00', '02:00']]) {
      expect(windowHours({ start, end }), `${start}-${end}`).toBe(shiftHours({ start_time: start, end_time: end }))
    }
  })
```

- [ ] **Step 2: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-compare.test.js`
Expected: all pass.

- [ ] **Step 3: Correct the comment and the doc**

In `src/lib/roster-compare.js`, replace lines 23-27:

```js
// Hours are WALL-CLOCK minutes, wrapping past midnight when the end is before
// the start, which is payroll.shiftHours's rule, so these totals agree with
// every other hours figure (a shift across a DST change counts its wall-clock
// length there too). One deliberate difference: '24:00' is midnight here;
// payroll.timeToHours refuses hour 24 and counts such a shift 0h.
```

with:

```js
// Hours are WALL-CLOCK minutes, wrapping past midnight when the end is before
// the start, which is payroll.shiftHours's rule, so these totals agree with
// every other hours figure (a shift across a DST change counts its wall-clock
// length there too). '24:00' is midnight at the end of the day, here and in
// payroll (PAYROLL24.1; src/lib/hours-24.test.js pins the agreement).
```

In `docs/roster-v2.md`, replace lines 281-282:

```
coaches on profile id within it (a swap reads as removed + added). Hours are
wall-clock like payroll's, except that `'24:00'` counts as midnight here.
```

with:

```
coaches on profile id within it (a swap reads as removed + added). Hours are
wall-clock like payroll's; `'24:00'` counts as midnight in both (PAYROLL24.1).
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/roster-compare.test.js src/lib/roster-compare.js docs/roster-v2.md
git commit -m "$(cat <<'EOF'
PAYROLL24.1 — the published-vs-now totals and payroll now agree on 24:00; retire the pinned difference

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: one rule, pinned across every hours parser

**Files:** Create `src/lib/hours-24.test.js`.

- [ ] **Step 1: Write the test**

```js
// PAYROLL24.1 — every reader that turns a shift's times into hours reads
// '24:00' the same way: midnight at the END of the block's day.
//
// Before this PR payroll.timeToHours refused hour 24, so payroll, week cost,
// contractor spend, the publish budget gate, invoices and every report counted
// a 22:00-24:00 shift as 0 hours while the Today dashboards (shared/), the
// published-vs-now view and the working-time rules said 2. Five readers, one
// answer; this file fails the day one of them drifts.
//
// Dates avoid the clock changes on purpose: workingWindow measures REAL time,
// so 00:00-24:00 on 25 Oct is 25 hours there (right for rest; not a
// wall-clock parity case).
//
// Lives in src/lib (not shared/) so it is not a bundle path: no OTA.

import { describe, it, expect } from 'vitest'
import { shiftHours } from './payroll'
import { windowHours } from './roster-compare'
import { shiftDurationHours as rosterMonthHours } from '@shared/roster-month'
import { shiftDurationHours as dashboardHours } from '@shared/dashboard-data'
import { workingWindow } from '@shared/working-time'

const DATE = '2026-05-05' // a Tuesday, nowhere near a clock change

function allReaders(start, end) {
  const row = { profile_id: 'p1', block_date: DATE, start_time: start, end_time: end }
  const w = workingWindow(row)
  return {
    payroll: shiftHours(row),
    rosterMonth: rosterMonthHours(row),
    dashboard: dashboardHours(row),
    compare: windowHours({ start, end }),
    workingTime: w ? (w.endMs - w.startMs) / 3_600_000 : null,
  }
}

describe('every hours reader agrees on a 24:00 end (PAYROLL24.1)', () => {
  const CASES = [
    ['22:00', '24:00', 2],
    ['22:00:00', '24:00:00', 2],
    ['18:30:00', '24:00:00', 5.5],
    ['00:00', '24:00', 24],
    ['22:00', '00:00', 2], // the other spelling of the same midnight
    ['06:00:00', '07:30:00', 1.5], // an ordinary shift, as a control
  ]

  for (const [start, end, hours] of CASES) {
    it(`${start}-${end} is ${hours}h everywhere`, () => {
      expect(allReaders(start, end)).toEqual({
        payroll: hours, rosterMonth: hours, dashboard: hours, compare: hours, workingTime: hours,
      })
    })
  }

  // Decision D4. A 24:00 START (only reachable through a hand-written override:
  // shift_blocks_time_order forbids it on a block) is that same midnight in
  // payroll, both shared/ readers and roster-compare. workingWindow alone calls
  // it untimed, and the screens that use it say "not counted" rather than 0.
  // If workingWindow is ever aligned (an OTA), fold this into CASES.
  it('KNOWN_DIFFERENCE: a 24:00 start is 2h everywhere except workingWindow, which calls it untimed', () => {
    expect(allReaders('24:00', '02:00')).toEqual({
      payroll: 2, rosterMonth: 2, dashboard: 2, compare: 2, workingTime: null,
    })
  })
})
```

- [ ] **Step 2: Run it, expect PASS**

Run: `npx vitest run src/lib/hours-24.test.js`
Expected: 7 passed.

- [ ] **Step 3: Prove it bites**

Delete the added `if (h === 24 && mm === 0 && ss === 0) return 24` line from `src/lib/payroll.js` again and run `npx vitest run src/lib/hours-24.test.js`.
Expected: 5 FAIL. The four 24:00-end cases fail with `payroll: 0`, and `KNOWN_DIFFERENCE` fails with `payroll: 0`. The `22:00–00:00` and control cases still pass. Then:

```bash
git restore src/lib/payroll.js
```

Re-run: 7 passed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/hours-24.test.js
git commit -m "$(cat <<'EOF'
PAYROLL24.1 — pin one 24:00 rule across payroll, shared/ dashboards, roster-compare and working-time

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: the two zones, and the prod re-check

**Files:** none changed.

- [ ] **Step 1: Run every touched file under Europe/Dublin**

```bash
TZ=Europe/Dublin npx vitest run src/lib/payroll.test.js src/lib/hours-24.test.js src/lib/roster-compare.test.js src/lib/roster-summary.test.js
TZ=Europe/Dublin npx vitest run src/lib/report-generator.test.js -t 'PAYROLL24.1'
```

Expected: all pass. `report-generator.test.js` runs filtered because its calendar tests are pinned to their own zone files (`report-generator.period.tz*.test.js`). This PR's cases involve no `Date` at all.

- [ ] **Step 2: Same under America/Los_Angeles**

```bash
TZ=America/Los_Angeles npx vitest run src/lib/payroll.test.js src/lib/hours-24.test.js src/lib/roster-compare.test.js src/lib/roster-summary.test.js
TZ=America/Los_Angeles npx vitest run src/lib/report-generator.test.js -t 'PAYROLL24.1'
```

Expected: all pass. Why no pinned `*.tz.test.js` file: the change is string arithmetic with no `Date`. The only zone-sensitive fixture is `summarizeMonth`/`summarizeWeek`'s local `new Date('…T12:00:00')`, read back with local getters, and these two runs cover it. A pinned file would re-run string maths.

- [ ] **Step 3: Re-check prod (read-only, counts only)**

Via the Supabase MCP on `iyvtbjjxdggiadzwwvdj`:

```sql
select
 (select count(*) from shift_blocks where end_time = '24:00:00' or start_time = '24:00:00') blocks_24,
 (select count(*) from shift_assignments where end_time_override = '24:00:00' or start_time_override = '24:00:00') overrides_24,
 (select count(*) from shift_templates where end_time = '24:00:00' or start_time = '24:00:00') templates_24;
```

Expected: `0, 0, 0` (as on 27 Sep). If any is non-zero, stop and tell Richard. That means a writer this plan did not find exists, and the saved reports and invoices for those periods under-counted. List the periods (dates and location only, no names) before anything is regenerated.

---

### The gate (run once, at the end, in this order)

```bash
git fetch origin main && git rebase origin/main
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
npm run build
git diff --stat origin/main -- mobile shared
```

Expected:
- All twelve green, then a clean `next build`. No new import reaches a route or page, but `hours-24.test.js` resolves `@shared/*` aliases, and the build is cheap insurance.
- The last command prints **nothing**, which confirms no OTA.
- `check:ota-paths` stays green for the same reason.

Then independent review, then:

```bash
git push -u origin HEAD
gh pr create --base main --title "PAYROLL24.1 — payroll counts a shift ending at 24:00 as the hours it is, not 0" --body-file <scratchpad>/payroll24-pr.md
```

**PR title:** `PAYROLL24.1 — payroll counts a shift ending at 24:00 as the hours it is, not 0`

**PR body points:**
- **Why:** `payroll.timeToHours` refused hour 24, so `shiftHours` counted a shift ending `'24:00'` (a value Postgres `time` holds) as **0 hours**. Everything built on it read 0:
  - `computeWeeklyCost`;
  - the staff_hours, staff_cost and utilisation reports (and their cron);
  - week-cost;
  - contractor spend and the week panel;
  - the contractor-budget publish gate;
  - invoice "scheduled hours";
  - the assistant's reports;
  - the web Today month roster.

  The Today dashboards (`shared/`), the working-time rules and the published-vs-now view already said 2.
- **Prod:** 0 rows hold `24:00` in `shift_blocks`, `shift_assignments` overrides, `shift_templates` or snapshots (latest end anywhere 20:30), so **nobody was under-paid**. Every schedule write validates with `timeOfDay` (refuses hour 24), so the value can only arrive by SQL or a future writer. This fixes the reader first.
- **What:** one line. `'24:00'`/`'24:00:00'` = 24.0; `'24:01'`, `'24:00:01'`, `'24:30'`, `'25:00'` still null. `shiftHours` is unchanged:
  - 22:00–24:00 = 2h;
  - 00:00–24:00 = 24h;
  - 22:00–00:00 = 2h, as before;
  - a 24:00 start is the same midnight (24:00–02:00 = 2h), matching `shared/roster-month`, `shared/dashboard-data` and `roster-compare`.
- **Sweep:** payroll was the only hours reader that refused a 24:00 end. `src/lib/hours-24.test.js` pins payroll, both `shared/` `shiftDurationHours`, `windowHours` and `workingWindow` to one answer. The one difference left is recorded: `workingWindow` calls a 24:00 start untimed. SNAPSHOT.1's pin of the old difference is now an equality.
- **Tests:** payroll (parser, three row shapes, overtime crossover, contractor); generateReport staff_hours, staff_cost, utilisation; summarizeMonth, summarizeWeek. Each was shown to fail with the old line back. Touched files run under `TZ=Europe/Dublin` and `TZ=America/Los_Angeles`.
- **No migration. No OTA** (`git diff origin/main -- mobile shared` is empty). No route or API shape change.
- Last line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

**CHANGELOG row.** Add it once the PR number exists, as the first row under the `| # / PR | Item | Notes |` header in `docs/CHANGELOG.md`, and commit it to the branch. Never edit it after it is pushed to main (`merge=union` duplicates an edited row).

```
| #<PR> | PAYROLL24.1 — payroll counts a shift ending at 24:00 as the hours it is, not 0 | 2026-09-<dd>. Follow-ups A1. **Web only; no migration, no OTA.** `timeToHours` (`src/lib/payroll.js`) refused hour 24, so `shiftHours` read a shift ending `'24:00'` (Postgres `time` holds it) as 0h, and with it `computeWeeklyCost`, the staff_hours / staff_cost / utilisation reports, week-cost, contractor spend + the week panel, the contractor-budget publish gate, invoice scheduled hours, the assistant's reports and the web month roster. Now exactly `24:00`/`24:00:00` = 24.0 (nothing past it): 22:00–24:00 = 2h, 00:00–24:00 = 24h; a 24:00 start is the same midnight (24:00–02:00 = 2h). Prod on 27 Sep: 0 rows at 24:00 in blocks, overrides, templates or snapshots, so nobody was under-paid; every write path refuses hour 24 (`timeOfDay`). `src/lib/hours-24.test.js` pins payroll, both `shared/` `shiftDurationHours`, `roster-compare` `windowHours` and `workingWindow` to one answer (`workingWindow` alone calls a 24:00 start untimed, recorded). SNAPSHOT.1's pinned 0h difference retired; `docs/roster-v2.md` corrected. |
```

---

### Review notes / open questions (for the owner)

1. **A shift ending at midnight cannot be entered today.** `timeOfDay` (`src/lib/schemas.js:51-54`) refuses `24:00`, and `shift_blocks_time_order` refuses an end of `00:00` (it is not after the start). So a class running to midnight cannot be rostered at all. This PR makes the readers right *first*. Widening `timeOfDay` for END fields only (block, template, override end) is a product call and its own PR: the time pickers, `formatTime12h` (note 2) and the change-log `TIME_SHAPE` (`roster-change-log.js:165`) would follow. The schema must keep refusing a 24:00 START.
2. **`formatTime12h('24:00')` prints `'12pm'`** (`src/lib/schedule-overlap.js:30-37`), and `formatLocalTime('24:00')` (`push-reminders.js:68-74`) prints `'12:00pm'`; it should read `12am`/midnight. It is unreachable today (no 24:00 is stored or enterable) and it is display only. Fix it with note 1, not before.
3. **`workingWindow` refuses a 24:00 START** (`shared/working-time.js:64-72`, `parseTime` `h > 23`). The grid and the labour basis show such a row as "not counted", and every other reader says 2h for 24:00–02:00. It is honest (never a silent 0) and only reachable via a hand-written override, so it is left. Aligning it is a `shared/` change, so an OTA; `hours-24.test.js`'s `KNOWN_DIFFERENCE` case says so. Alternatively, a `CHECK` on `shift_assignments` refusing a 24:00 `start_time_override` would close it at the source (a migration). Richard's call if wanted; neither is needed now.
4. **No recompute.** Saved `generated_reports`, invoices and publish snapshots are not regenerated. Prod holds no 24:00 value, so none is wrong (Task 5 Step 3 re-checks at the gate).
5. **Not changed on purpose:**
   - `mobile/lib/dates.js` `hoursBetween` and the two `shared/` `shiftDurationHours` already read 24:00 correctly, and touching them would be an OTA for nothing;
   - `wallMsInTz`, `shared/availability.js` `TIME`, `roster-change-notify.js` `shiftStartLabel` and `schedule/windows.js` `HHMM` refuse 24 by design (starts, rule times, labels, Sonos/Shelly windows);
   - the `24:00` end cases that matter there are already mapped by their callers (`wallInstant`, the `23:59` availability mapping in `candidates.js`/`roster-grid-model.js`).
6. **Conflict note for A2/A3.** A2 CONTRACTORSPEND.1 edits `roster-summary.js` and appends to `roster-summary.test.js`. A3 INVOICEHOURS.1 edits `contractor-invoices.js`. This PR touches neither source file. Its test additions are append-only, so merging A1 first costs them a clean rebase.
7. **Size:** four small tasks: one line of code, the rest tests, two comments and one doc sentence. S.
