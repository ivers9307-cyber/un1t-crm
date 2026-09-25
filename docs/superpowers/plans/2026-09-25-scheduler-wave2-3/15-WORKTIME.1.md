## PR WORKTIME.1 — working-time advisories: 11 hours' rest and 48 hours a week, employees, both studios

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this section task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a manager publishes a roster, or picks a coach for a shift, the screen says so if an EMPLOYEE would have fewer than 11 hours between the end of one working day and the start of the next, or more than 48 rostered hours in a Monday to Sunday week. Both rules count the person's shifts at every studio of the same organisation. Advisory only: nothing here blocks an assign or a publish.

**Why:** The 19 Sep product review. Nothing in the product knows the Organisation of Working Time Act exists. A coach who closes Hatch Street at 22:00 and opens Stillorgan at 06:30 is invisible to both studios' screens, because each studio only ever looks at its own roster. Contractors are out of scope: the Act covers employees.

**Ships:** web deploy **and an OTA**. **No migration.** The rule lives in `shared/working-time.js` because CANDIDATES.1 (PR 19) runs the same rule on the phone. No phone screen uses it in THIS PR, but the OTA trigger takes `shared/**` wholesale (`tests/ota-trigger-paths.test.js:116`, "keeps shared/** wholesale"; the same accepted over-trigger as `shared/pipeline-classifier.js` at line 142), so **the merge publishes an OTA that changes nothing on a phone**. Say so in the PR body. Program rule: one phone update at a time. If SHIFTTYPE.1 (the other half of batch 2, also an OTA) merges first, wait for its EAS Update run to go green before merging this one.

**Decisions (each pinned by a test below):**
- **Who is covered.** `profiles.employment_type = 'fte'`: the column is NOT NULL, `'fte' | 'contractor'` (mig 070, `supabase/migrations/070_roster_v2_employment_constraints.sql:37-42`). `getEmploymentType` (`src/lib/time-off-leave.js:272`) reads the same column for one person; the reader here reads it for many in one query. A contractor is never flagged. So is anyone whose type could not be read. `profile_compensation` is NOT read: it holds pay (mig 152), and this feature must never select a pay column.
- **Rest.** Fewer than 11 hours between the END of a person's last shift on one working day (their `block_date`) and the START of their first shift on the next working day. Exactly 11:00 is fine; 10:59 flags. Shifts inside one day (a 06:30 class and an 18:00 class) never flag each other. The Act asks for 11 CONSECUTIVE hours in each 24; the overnight gap is where a coach gets them or doesn't. Treating every pair of shifts as a "rest" would flag every split shift in the estate. See Review notes.
- **Week.** More than 48 rostered hours in a Monday to Sunday week, by `block_date`. Exactly 48:00 is fine; 48:15 flags. **Per rostered week, not the Act's four-month average** (program default 3). An early flag is the safe side for an advisory.
- **Hours are the EFFECTIVE window.** The order is override, then block, then template: `effectiveShiftStart` / `effectiveShiftEnd` (`shared/roster-month.js:52-57`), the same resolution `shiftHours` uses (`src/lib/payroll.js:44`). A coach kept late by an override is kept late here too. `start_time_override` can be a geofence ARRIVAL (memory `rostering-review-2026-09-16`); that is still the paid window, so it counts.
- **Times are Dublin wall clock, turned into real instants.** `block_date` + `HH:MM` is Europe/Dublin wall clock (CLAUDE.md, Timezones). Rest is elapsed time. The night the clocks go back (Sat 24 → Sun 25 Oct 2026) is an hour longer than its wall clock says, and the night they go forward (Sat 28 → Sun 29 Mar 2026) an hour shorter. So `shared/working-time.js` converts each wall time to a UTC instant with `Intl` (Europe/Dublin), the same technique as `shared/dublin-time.js:74` `dublinDayStartMs`, generalised to any time of day. It never uses `new Date(\`${d}T${t}Z\`)`. For any shift not spanning 01:00-02:00 on a change night, the week total equals payroll's wall-clock hours.
- **An overnight shift cannot exist today** (the calendar and the template form never produce `end < start`). It is handled defensively anyway: the end runs into the next day, and the whole shift belongs to its `block_date` for both rules. An end equal to the start is a zero-length row and is skipped, which matches `shiftHours` returning 0.
- **Both studios, one organisation.** The reader reads the person's live assignments at this studio plus `siblingLocationIds(db, locationId)` (`src/lib/sibling-locations.js:19`, ORGSCOPE.1). The embedded `.in('shift_blocks.location_id', …)` is the boundary. Every row is re-checked against it afterwards, the way the assign route's double-booking read does (`src/app/api/schedule/blocks/[id]/assignments/route.js:266-289`). A studio of another organisation is never read. If it is returned anyway, it is dropped. Unreadable siblings narrow the read to this studio and mark the check incomplete; they never widen it.
- **Which shifts count.** Live assignments (`status !== 'cancelled'`, `isLiveAssignment` at `src/lib/roster.js:440`) on any block, published or draft. This is the same set `doubleBookings` reads (`src/lib/roster-publish-advisories.js:84`). Approved leave is NOT subtracted: a coach rostered on a day they are off is already listed by `leaveClashes` in the same preview. Admin blocks (SHIFTTYPE.1) count: the program decision says admin blocks "count toward working-time advisories", and nothing here filters by kind.
- **What the publish preview lists.** For the people rostered HERE in the period only. A rest gap is listed when its later shift is today or later, at least one of the two days is inside the period, and at least one of the two shifts is at this studio. This catches "close here on Sunday, open the other studio on Monday". A long week is listed when it overlaps the period, has not ended before today, and contains at least one shift here. Violations that live entirely at the other studio are that studio's publish to report. These are the same "at least one side is here" rules as `doubleBookings`.
- **Performance: one reader call per preview, never per block.** A preview dry run makes four more fixed queries: this studio's organisation, its sibling studios, `profiles(id, full_name, employment_type)` for the rostered people, and their `shift_assignments` paged at 1,000. A real publish and the approve route pass `advisories: false` (`src/app/api/schedule/rosters/route.js:234`, `src/app/api/schedule/rosters/[id]/approve/route.js:126-132`) and make none of them. The picker makes one GET per open, which does the same four reads plus the block and the studio's member list.
- **The picker asks the server; it does not compute from what the calendar holds.** The calendar only holds THIS studio's blocks for the visible range, and it cannot see the other studio or the day before Monday. So the picker calls a new manager-gated `GET /api/schedule/working-time?block_id=`, which answers per candidate. The URL deliberately avoids the substring `/schedule/blocks`: existing component tests route every URL containing it to the block list and count block reads (`src/components/ScheduleCalendar.errors.test.jsx:232,307`).
- **"Would create" in the picker** means: the violations with the candidate added, minus the violations without it. A short rest the person already has on other days is not blamed on this shift. For the week, the badge shows whenever the week INCLUDING this shift is over 48, even if it was already over. Adding hours to an over-long week is still worth saying.
- **Hours only.** Nothing here reads or returns a rate, cost, salary or contracted hours. The publish list prints names, dates, shift times, studio names and hours. The picker route returns no names at all (the calendar already has them), no employment type, and only a flag per person who has one.
- **`publish-summary.js` is not touched.** It is the AFTER-publish outcome line (PUBLISH-CONFIRM.1). The "fuller publish check" is the dry-run preview: `projectPublishImpact` (`src/lib/roster-publish.js:329`) → `PublishRosterModal` (`src/components/ScheduleCalendar.jsx:1856`), which already renders `PublishStaffingGaps` and `PublishRosterClashes` (`:2028-2034`).

**Prerequisite:** a fresh worktree off `origin/main` (`git fetch origin main && git worktree add ../un1t-crm-worktime -b worktime-1 origin/main`), then `npm ci` once. Tests: `npx vitest run <file>`. Date tests always run twice: `TZ=Europe/Dublin` and `TZ=America/Los_Angeles`. This PR adds a route, a shared module and new imports, which is exactly what only `next build` catches, so the gate runs `npm run build`.

**Files:**

| File | Responsibility |
|---|---|
| `shared/working-time.js` (create) | the pure rules: `workingWindow`, `restGapViolations`, `weekHoursOver`, `workingTimeAdvisories`, `candidateWorkingTime`, copy |
| `shared/working-time.test.js` (create) | tests for it, including both DST nights |
| `src/lib/working-time-data.js` (create) | server reader: one person set's shifts across the organisation's studios, employees only, no pay |
| `src/lib/working-time-data.test.js` (create) | tests for it |
| `src/lib/roster-publish.js` (modify: imports lines 19-26; `loadBudgetContext` lines 238-249; new helper above `impactFromContext` line 424; advisory branch after line 522) | read once per preview, add `impact.workingTime` |
| `src/lib/roster-publish.test.js` (modify: vitest import line 12, mocks after line 24, append a describe) | tests for the wiring |
| `src/app/api/schedule/working-time/route.js` (create) | manager-gated GET for the assign picker |
| `src/app/api/schedule/working-time/route.test.js` (create) | gate and shape tests |
| `src/lib/openapi.js` (modify: insert after line 4488) | register the route |
| `src/components/ScheduleCalendar.jsx` (modify: after line 64; `AssignCoachModal` lines 1679, 1726-1727, 1741, 1765; render after line 2034; new component before line 2209) | the publish list and the picker badges |
| `src/components/ScheduleCalendar.working-time.test.jsx` (create) | both surfaces reach the DOM |
| `docs/CHANGELOG.md` (modify) | one row keyed by the PR number, added after `gh pr create` |

**Naming traps, already avoided:** `tests/shared-pair-sync.test.js` makes you classify any module with the same filename in `shared/` and `src/lib/`, and any export NAME the two trees share. So the server file is `working-time-data.js`, not `working-time.js`. The date helpers in the shared file stay private: `src/lib/dublin-time.js:81` already exports `addDaysISO` and `src/lib/payroll.js:167` exports `mondayOf`. Every new export name was grepped against `src/`, `shared/` and `mobile/lib/` on 25 Sep: no collisions.

**Batch-2 neighbour:** SHIFTTYPE.1 (PR 13) also edits `src/lib/roster-publish.js` (admin blocks out of the budget gate and the staffing gaps) and `src/components/ScheduleCalendar.jsx`. Whichever merges second rebases. Nothing here depends on it. Admin blocks count toward working time with or without it.

---

### Task 1: `workingWindow` — a shift as a real-time window

**Files:**
- Create: `shared/working-time.js`
- Create: `shared/working-time.test.js`

The test file imports every name Tasks 2-4 add. Until those tasks land, the missing names are `undefined`, which is harmless because nothing in this task calls them.

- [ ] **Step 1: Write the failing test**

Create `shared/working-time.test.js`:

```js
// WORKTIME.1 — working-time advisories for employees: 11 hours between working
// days, 48 hours in a Monday-to-Sunday week, every studio of the organisation.
// Pure: no clock, no database. Run under TZ=Europe/Dublin AND a US zone; the
// rules must not move with the host.

import { describe, it, expect } from 'vitest'
import {
  MIN_REST_HOURS, MAX_WEEK_HOURS, EMPLOYEE_TYPE,
  workingWindow, restGapViolations, weekHoursOver,
  workingTimeAdvisories, candidateWorkingTime,
  hoursMinutesLabel, longWeeksHeadline, restGapsHeadline,
} from './working-time.js'

const HOUR = 60 * 60 * 1000

// One assignment, in the flat shape the reader returns. The block id is
// derived from person + date + start so a test can name it.
const S = (profile_id, block_date, start_time, end_time, over = {}) => ({
  profile_id,
  block_id: `${profile_id}-${block_date}-${start_time}`,
  block_date,
  start_time,
  end_time,
  location_id: 'loc1',
  location_name: 'Studio North',
  name: 'Class',
  status: 'scheduled',
  ...over,
})

describe('workingWindow', () => {
  it('resolves the window override, then block, then template', () => {
    expect(workingWindow(S('p1', '2026-09-22', '09:00:00', '12:00:00')))
      .toMatchObject({ profile_id: 'p1', date: '2026-09-22', start: '09:00', end: '12:00' })
    expect(workingWindow(S('p1', '2026-09-22', '09:00', '12:00', { start_time_override: '10:15', end_time_override: '12:30:00' })))
      .toMatchObject({ start: '10:15', end: '12:30' })
    expect(workingWindow(S('p1', '2026-09-22', null, null, { shift_templates: { start_time: '07:00', end_time: '08:30' } })))
      .toMatchObject({ start: '07:00', end: '08:30' })
  })

  it('is a real instant: 09:00 in September is 08:00 UTC, in November 09:00 UTC', () => {
    const sep = workingWindow(S('p1', '2026-09-22', '09:00', '12:00'))
    expect(sep.startMs).toBe(Date.UTC(2026, 8, 22, 8, 0))
    expect(sep.endMs - sep.startMs).toBe(3 * HOUR)
    expect(workingWindow(S('p1', '2026-11-03', '09:00', '12:00')).startMs).toBe(Date.UTC(2026, 10, 3, 9, 0))
  })

  it('a window through a clock change is its real length (25 Oct 2026 back, 29 Mar 2026 forward)', () => {
    const back = workingWindow(S('p1', '2026-10-25', '00:30', '03:30'))
    expect(back.startMs).toBe(Date.UTC(2026, 9, 24, 23, 30)) // 00:30 IST
    expect(back.endMs - back.startMs).toBe(4 * HOUR)
    const fwd = workingWindow(S('p1', '2026-03-29', '00:30', '03:30'))
    expect(fwd.endMs - fwd.startMs).toBe(2 * HOUR)
  })

  it('an end before the start runs into the next day, and the shift stays on its block date', () => {
    const w = workingWindow(S('p1', '2026-09-22', '22:00', '02:00'))
    expect(w.date).toBe('2026-09-22')
    expect(w.endMs).toBe(Date.UTC(2026, 8, 23, 1, 0)) // 02:00 IST on the 23rd
    expect(w.endMs - w.startMs).toBe(4 * HOUR)
  })

  it('is null for a cancelled row, no person, an unreadable date or time, or zero length', () => {
    expect(workingWindow(S('p1', '2026-09-22', '09:00', '12:00', { status: 'cancelled' }))).toBeNull()
    expect(workingWindow(S(null, '2026-09-22', '09:00', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '22/09/2026', '09:00', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '2026-09-22', '9am', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '2026-09-22', '25:00', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '2026-09-22', '09:00', '09:00'))).toBeNull()
    expect(workingWindow(null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/working-time.test.js`
Expected: `Test Files 1 failed`, `Error: Cannot find module './working-time.js'` (or "Failed to load url").

- [ ] **Step 3: Minimal implementation**

Create `shared/working-time.js`:

```js
// WORKTIME.1 — working-time advisories for EMPLOYEES.
//
// Two rules from the Organisation of Working Time Act, ADVISORY ONLY: nothing
// here may block an assign or a publish.
//
//   restGapViolations  fewer than 11 hours between the END of the last shift
//                      of one working day and the START of the first shift of
//                      the next. Shifts inside one day (a 06:30 class and an
//                      18:00 class) are one working day: the Act asks for 11
//                      CONSECUTIVE hours in each 24, which the overnight gap
//                      gives or does not. Every-pair checking would flag every
//                      split shift in the estate.
//   weekHoursOver      more than 48 rostered hours in a Monday-to-Sunday week.
//                      The Act averages over four months; this checks each
//                      rostered week on its own, so it flags EARLY, which is
//                      the safe side for an advisory (Scheduler Wave 2 default 3).
//
// Inputs are shift rows from EVERY studio of the person's organisation (the
// reader is src/lib/working-time-data.js). Only an employee is covered by the
// Act: workingTimeAdvisories filters to EMPLOYEE_TYPE itself, and the picker
// route asks per employee.
//
// Times: `block_date` + HH:MM is Europe/Dublin WALL CLOCK. It is turned into a
// real instant here (dublinWallMs) because rest is elapsed time: the night the
// clocks go back is an hour longer than its wall clock says, the night they go
// forward an hour shorter. Never `new Date(`${d}T${t}Z`)` (CLAUDE.md).
// The window per assignment is override → block → template: effectiveShiftStart
// / effectiveShiftEnd, the one resolution payroll's shiftHours also uses.
//
// Pure, no IO. In shared/ because the phone's candidate list (CANDIDATES.1)
// runs the same rule. Hours only: no rate, cost or contract figure is read or
// returned.

import { effectiveShiftStart, effectiveShiftEnd } from './roster-month.js'

export const MIN_REST_HOURS = 11
export const MAX_WEEK_HOURS = 48
// profiles.employment_type of an employee. Mig 070 pins the column to
// 'fte' | 'contractor', NOT NULL DEFAULT 'fte'. Nothing else is covered.
export const EMPLOYEE_TYPE = 'fte'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseTime(value) {
  const m = String(value ?? '').match(TIME_RE)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  const s = m[3] ? Number(m[3]) : 0
  if (h > 23 || mi > 59 || s > 59) return null
  return { h, mi, s }
}

function parseDate(value) {
  const m = String(value ?? '').match(DATE_RE)
  return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null
}

// Calendar arithmetic on YYYY-MM-DD strings through Date.UTC: no host timezone
// and no 23h/25h day can move a date. Private on purpose: src/lib already
// exports addDaysISO and mondayOf, and tests/shared-pair-sync.test.js makes a
// shared export NAME a pair someone must classify.
function addDays(iso, n) {
  const p = parseDate(iso)
  return new Date(Date.UTC(p.y, p.mo - 1, p.d) + n * DAY_MS).toISOString().slice(0, 10)
}

// Europe/Dublin wall-clock parts for an instant. Same formatter shape as
// shared/dublin-time.js (which normalises the same '24' midnight quirk).
const WALL_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Dublin',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
})

// How far Dublin's wall clock is ahead of UTC at instant `ms`: 0 in winter
// (GMT), one hour in summer (IST).
function dublinOffsetMs(ms) {
  const p = {}
  for (const { type, value } of WALL_FMT.formatToParts(new Date(ms))) p[type] = value
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second)) - ms
}

// The real instant of a Dublin wall-clock date + time. Read the wall time as if
// it were UTC, correct by Dublin's offset, then correct again with the offset
// AT the corrected instant: that second pass is what lands a time just after a
// clock change on the right side of it (08:00 on 25 Oct is 08:00 GMT, not IST).
// shared/dublin-time.js dublinDayStartMs does the one-pass version for midnight.
function dublinWallMs(date, time) {
  const naive = Date.UTC(date.y, date.mo - 1, date.d, time.h, time.mi, time.s)
  const first = naive - dublinOffsetMs(naive)
  return naive - dublinOffsetMs(first)
}

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * One assignment as a working window, or null when it is not one: cancelled,
 * no person, a date or time that does not parse, or zero length (shiftHours
 * gives such a row 0 hours too). An end before the start runs into the next
 * day: an overnight shift cannot be created today, so this is defence, not a
 * feature. The window belongs to its block_date for working days and weeks.
 *
 * @param {{ profile_id, block_id?, block_date, location_id?, location_name?,
 *   name?, status?, start_time_override?, end_time_override?, start_time?,
 *   end_time?, block_start_time?, block_end_time?, shift_templates? }} row
 */
export function workingWindow(row) {
  if (!row?.profile_id || row.status === 'cancelled') return null
  const date = parseDate(row.block_date)
  const start = parseTime(effectiveShiftStart(row))
  const end = parseTime(effectiveShiftEnd(row))
  if (!date || !start || !end) return null
  const startSecs = start.h * 3600 + start.mi * 60 + start.s
  const endSecs = end.h * 3600 + end.mi * 60 + end.s
  if (endSecs === startSecs) return null
  const endDate = endSecs < startSecs ? parseDate(addDays(row.block_date, 1)) : date
  return {
    profile_id: row.profile_id,
    block_id: row.block_id ?? null,
    date: row.block_date,
    location_id: row.location_id ?? null,
    location_name: row.location_name ?? null,
    name: row.name || 'Shift',
    start: `${pad2(start.h)}:${pad2(start.mi)}`,
    end: `${pad2(end.h)}:${pad2(end.mi)}`,
    startMs: dublinWallMs(date, start),
    endMs: dublinWallMs(endDate, end),
  }
}
```

- [ ] **Step 4: Run it, expect PASS, under two host timezones**

Run: `TZ=Europe/Dublin npx vitest run shared/working-time.test.js && TZ=America/Los_Angeles npx vitest run shared/working-time.test.js`
Expected: `5 passed` twice.

- [ ] **Step 5: Commit**

```bash
git add shared/working-time.js shared/working-time.test.js
git commit -m "WORKTIME.1 — workingWindow: a shift's effective window as real Dublin instants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `restGapViolations` — under 11 hours between working days

**Files:**
- Modify: `shared/working-time.js`
- Modify: `shared/working-time.test.js`

- [ ] **Step 1: Write the failing test**

Append to `shared/working-time.test.js`:

```js
describe('restGapViolations', () => {
  it('exactly 11 hours is fine', () => {
    expect(restGapViolations([S('p1', '2026-09-22', '18:00', '21:00'), S('p1', '2026-09-23', '08:00', '10:00')])).toEqual([])
  })

  it('10h 59m flags', () => {
    const v = restGapViolations([S('p1', '2026-09-22', '18:00', '21:01'), S('p1', '2026-09-23', '08:00', '10:00')])
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({
      profile_id: 'p1', rest_minutes: 659,
      before: { date: '2026-09-22', end: '21:01' }, after: { date: '2026-09-23', start: '08:00' },
    })
  })

  it('split shifts inside one working day never flag; the day\'s last end to the next day\'s first start is what counts', () => {
    const v = restGapViolations([
      S('p1', '2026-09-22', '06:30', '08:00'),
      S('p1', '2026-09-22', '18:00', '21:30'), // 10 hours after the first: same day, not a rest
      S('p1', '2026-09-23', '07:00', '09:00'),
    ])
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ rest_minutes: 570, before: { start: '18:00', end: '21:30' }, after: { start: '07:00' } })
  })

  it('a pair across the two studios flags, carrying both studios', () => {
    expect(restGapViolations([
      S('p1', '2026-09-22', '20:00', '22:00', { location_id: 'loc2', location_name: 'Studio South' }),
      S('p1', '2026-09-23', '06:30', '09:00'),
    ])).toEqual([{
      profile_id: 'p1',
      rest_minutes: 510,
      before: { block_id: 'p1-2026-09-22-20:00', date: '2026-09-22', start: '20:00', end: '22:00', name: 'Class', location_id: 'loc2', location_name: 'Studio South' },
      after: { block_id: 'p1-2026-09-23-06:30', date: '2026-09-23', start: '06:30', end: '09:00', name: 'Class', location_id: 'loc1', location_name: 'Studio North' },
    }])
  })

  it('people are judged separately, and a day off in between is never a short rest', () => {
    expect(restGapViolations([S('p1', '2026-09-22', '20:00', '22:00'), S('p2', '2026-09-23', '06:00', '08:00')])).toEqual([])
    expect(restGapViolations([S('p1', '2026-09-22', '20:00', '23:00'), S('p1', '2026-09-24', '06:00', '08:00')])).toEqual([])
  })

  it('clocks going back: Sat 24 Oct 22:00 to Sun 25 Oct 08:00 is 11 real hours; 22:30 is 10h 30m', () => {
    expect(restGapViolations([S('p1', '2026-10-24', '18:00', '22:00'), S('p1', '2026-10-25', '08:00', '12:00')])).toEqual([])
    expect(restGapViolations([S('p1', '2026-10-24', '18:00', '22:30'), S('p1', '2026-10-25', '08:00', '12:00')])
      .map((v) => v.rest_minutes)).toEqual([630])
  })

  it('clocks going forward: Sat 28 Mar 21:00 to Sun 29 Mar 08:00 is 10 real hours', () => {
    expect(restGapViolations([S('p1', '2026-03-28', '18:00', '21:00'), S('p1', '2026-03-29', '08:00', '12:00')])
      .map((v) => v.rest_minutes)).toEqual([600])
  })

  it('honours a per-coach override: a coach kept until 22:00 has 10 hours before an 08:00 start', () => {
    expect(restGapViolations([
      S('p1', '2026-09-22', '18:00', '20:00', { end_time_override: '22:00' }),
      S('p1', '2026-09-23', '08:00', '10:00'),
    ]).map((v) => v.rest_minutes)).toEqual([600])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/working-time.test.js`
Expected: `8 failed | 5 passed`, each `TypeError: restGapViolations is not a function`.

- [ ] **Step 3: Minimal implementation**

Append to `shared/working-time.js`:

```js
// Every usable window, once per (person, block): the same block reached by two
// reads must not count twice.
function windowsOf(shifts) {
  const seen = new Set()
  const out = []
  for (const row of shifts || []) {
    const w = workingWindow(row)
    if (!w) continue
    const key = `${w.profile_id}|${w.block_id ?? `${w.date}|${w.start}|${w.end}|${w.location_id}`}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(w)
  }
  return out
}

const slotOf = (w) => ({
  block_id: w.block_id,
  date: w.date,
  start: w.start,
  end: w.end,
  name: w.name,
  location_id: w.location_id,
  location_name: w.location_name,
})

/**
 * Per person, each pair of consecutive WORKING DAYS whose rest (the first
 * shift of the later day starting, minus the latest end on the earlier day)
 * is under `minRestHours`. A negative rest (an overnight shift running into
 * the next day's first) reports 0.
 *
 * @returns {Array<{ profile_id, rest_minutes, before: Slot, after: Slot }>}
 *   Slot = { block_id, date, start, end, name, location_id, location_name }
 */
export function restGapViolations(shifts, { minRestHours = MIN_REST_HOURS } = {}) {
  const minMs = minRestHours * HOUR_MS
  const days = new Map() // profile_id → Map(date → { first, last })
  for (const w of windowsOf(shifts)) {
    if (!days.has(w.profile_id)) days.set(w.profile_id, new Map())
    const byDate = days.get(w.profile_id)
    const day = byDate.get(w.date)
    if (!day) {
      byDate.set(w.date, { first: w, last: w })
      continue
    }
    if (w.startMs < day.first.startMs) day.first = w
    if (w.endMs > day.last.endMs) day.last = w
  }

  const out = []
  for (const [profileId, byDate] of days) {
    const list = [...byDate.keys()].sort().map((d) => byDate.get(d))
    for (let i = 1; i < list.length; i++) {
      const before = list[i - 1].last
      const after = list[i].first
      const restMs = after.startMs - before.endMs
      if (restMs >= minMs) continue
      out.push({
        profile_id: profileId,
        rest_minutes: Math.max(0, Math.floor(restMs / MINUTE_MS)),
        before: slotOf(before),
        after: slotOf(after),
      })
    }
  }
  return out.sort((a, b) =>
    a.after.date.localeCompare(b.after.date)
    || a.after.start.localeCompare(b.after.start)
    || String(a.profile_id).localeCompare(String(b.profile_id)))
}
```

- [ ] **Step 4: Run it, expect PASS, under two host timezones**

Run: `TZ=Europe/Dublin npx vitest run shared/working-time.test.js && TZ=America/Los_Angeles npx vitest run shared/working-time.test.js`
Expected: `13 passed` twice.

- [ ] **Step 5: Commit**

```bash
git add shared/working-time.js shared/working-time.test.js
git commit -m "WORKTIME.1 — restGapViolations: under 11 real hours between working days, both DST nights

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `weekHoursOver` — more than 48 hours in a Monday to Sunday week

**Files:**
- Modify: `shared/working-time.js`
- Modify: `shared/working-time.test.js`

- [ ] **Step 1: Write the failing test**

Append to `shared/working-time.test.js`:

```js
describe('weekHoursOver', () => {
  const SIX = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']
  const six = (lastEnd = '17:00') => SIX.map((d, i) => S('p1', d, '09:00', i === 5 ? lastEnd : '17:00'))
  const FIVE = SIX.slice(0, 5).map((d) => S('p1', d, '09:00', '17:00')) // 40h

  it('48.0 hours is fine', () => {
    expect(weekHoursOver(six())).toEqual([])
  })

  it('48.25 hours flags', () => {
    expect(weekHoursOver(six('17:15'))).toEqual([{
      profile_id: 'p1', week_start: '2026-09-21', minutes: 2895, shift_count: 6,
      block_ids: SIX.map((d) => `p1-${d}-09:00`), location_ids: ['loc1'],
    }])
  })

  it('sums both studios, and the limit is a parameter', () => {
    const rows = [
      ...SIX.map((d, i) => S('p1', d, '09:00', '17:00', i % 2 ? { location_id: 'loc2', location_name: 'Studio South' } : {})),
      S('p1', '2026-09-27', '10:00', '11:00', { location_id: 'loc2', location_name: 'Studio South' }),
    ]
    expect(weekHoursOver(rows)).toMatchObject([{ minutes: 2940, shift_count: 7, location_ids: ['loc1', 'loc2'] }])
    expect(weekHoursOver(rows, 50)).toEqual([])
  })

  it('Monday to Sunday: a Sunday belongs to the week that began the Monday before; the next Monday starts afresh', () => {
    expect(weekHoursOver([...FIVE, S('p1', '2026-09-27', '09:00', '18:00')])).toMatchObject([{ week_start: '2026-09-21', minutes: 2940 }])
    expect(weekHoursOver([...FIVE, S('p1', '2026-09-28', '09:00', '18:00')])).toEqual([])
  })

  it('the DST week (w/c 19 Oct 2026): Sunday 25 Oct counts in it, 48.0 is fine and 48.25 flags', () => {
    const OCT = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].map((d) => S('p1', d, '09:00', '17:00'))
    expect(weekHoursOver([...OCT, S('p1', '2026-10-25', '09:00', '17:00')])).toEqual([])
    expect(weekHoursOver([...OCT, S('p1', '2026-10-25', '09:00', '17:15')])).toMatchObject([{ week_start: '2026-10-19', minutes: 2895 }])
  })

  it('a shift through the clock change counts its real hours (wall clock would say 47h 15m)', () => {
    const OCT = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].map((d) => S('p1', d, '09:00', '17:00'))
    expect(weekHoursOver([
      ...OCT,
      S('p1', '2026-10-24', '09:00', '13:15'),
      S('p1', '2026-10-25', '00:30', '03:30'), // 4 real hours
    ])).toMatchObject([{ week_start: '2026-10-19', minutes: 2895 }])
  })

  it('a cancelled row does not count, and a row listed twice counts once', () => {
    const rows = six('17:15')
    expect(weekHoursOver([...rows, rows[0], S('p1', '2026-09-27', '09:00', '17:00', { status: 'cancelled' })]))
      .toMatchObject([{ minutes: 2895, shift_count: 6 }])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/working-time.test.js`
Expected: `7 failed | 13 passed`, each `TypeError: weekHoursOver is not a function`.

- [ ] **Step 3: Minimal implementation**

In `shared/working-time.js`, directly under `addDays`, add:

```js
// The Monday of the Mon-Sun week containing `iso`.
function weekStartOf(iso) {
  const p = parseDate(iso)
  const ms = Date.UTC(p.y, p.mo - 1, p.d)
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7
  return new Date(ms - sinceMonday * DAY_MS).toISOString().slice(0, 10)
}
```

Append to the end of the file:

```js
/**
 * Per person, each Mon-Sun week (by block_date) whose rostered hours are MORE
 * than `limit`. Real elapsed time, compared in milliseconds, so 48h 15m flags
 * and 48h does not.
 *
 * @returns {Array<{ profile_id, week_start, minutes, shift_count, block_ids: string[], location_ids: string[] }>}
 */
export function weekHoursOver(shifts, limit = MAX_WEEK_HOURS) {
  const limitMs = limit * HOUR_MS
  const weeks = new Map()
  for (const w of windowsOf(shifts)) {
    const weekStart = weekStartOf(w.date)
    const key = `${w.profile_id}|${weekStart}`
    if (!weeks.has(key)) {
      weeks.set(key, { profile_id: w.profile_id, week_start: weekStart, ms: 0, block_ids: [], location_ids: new Set() })
    }
    const acc = weeks.get(key)
    acc.ms += w.endMs - w.startMs
    acc.block_ids.push(w.block_id)
    if (w.location_id) acc.location_ids.add(w.location_id)
  }
  return [...weeks.values()]
    .filter((acc) => acc.ms > limitMs)
    .map((acc) => ({
      profile_id: acc.profile_id,
      week_start: acc.week_start,
      minutes: Math.round(acc.ms / MINUTE_MS),
      shift_count: acc.block_ids.length,
      block_ids: acc.block_ids,
      location_ids: [...acc.location_ids],
    }))
    .sort((a, b) => a.week_start.localeCompare(b.week_start) || String(a.profile_id).localeCompare(String(b.profile_id)))
}
```

- [ ] **Step 4: Run it, expect PASS, under two host timezones**

Run: `TZ=Europe/Dublin npx vitest run shared/working-time.test.js && TZ=America/Los_Angeles npx vitest run shared/working-time.test.js`
Expected: `20 passed` twice.

- [ ] **Step 5: Commit**

```bash
git add shared/working-time.js shared/working-time.test.js
git commit -m "WORKTIME.1 — weekHoursOver: more than 48 real hours in a Mon-Sun week

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `workingTimeAdvisories`, `candidateWorkingTime` and the copy

**Files:**
- Modify: `shared/working-time.js`
- Modify: `shared/working-time.test.js`

`workingTimeAdvisories` is the publish list: employees only, scoped to the period, today and this studio. `candidateWorkingTime` is the picker's question for one person: what would adding this shift create?

- [ ] **Step 1: Write the failing test**

Append to `shared/working-time.test.js`:

```js
const PEOPLE = new Map([
  ['emp', { full_name: 'Sam Demo', employment_type: 'fte' }],
  ['emp2', { full_name: 'Toby Beta', employment_type: 'fte' }],
  ['con', { full_name: 'Max Beta', employment_type: 'contractor' }],
])
const WEEK = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']
const NEXT_WEEK = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']
// 50 hours in five days, and 8 hours' rest after the first day.
const heavy = (pid, [d1, d2, d3, d4, d5], over = {}) => [
  S(pid, d1, '12:00', '22:00', over),
  S(pid, d2, '06:00', '16:00', over),
  S(pid, d3, '06:00', '16:00', over),
  S(pid, d4, '06:00', '16:00', over),
  S(pid, d5, '06:00', '16:00', over),
]
const OPTS = { people: PEOPLE, hereLocationId: 'loc1', from: '2026-09-21', to: '2026-09-27', todayIso: '2026-09-21' }

describe('workingTimeAdvisories', () => {
  it('a contractor is never flagged, whatever their hours or rest', () => {
    const out = workingTimeAdvisories([...heavy('emp', WEEK), ...heavy('con', WEEK)], OPTS)
    expect(out.restGaps.map((g) => [g.profile_id, g.rest_minutes])).toEqual([['emp', 480]])
    expect(out.longWeeks.map((w) => [w.profile_id, w.minutes])).toEqual([['emp', 3000]])
  })

  it('a person whose employment type is unknown is not flagged', () => {
    expect(workingTimeAdvisories(heavy('ghost', WEEK), OPTS)).toEqual({ restGaps: [], longWeeks: [] })
    expect(workingTimeAdvisories(heavy('emp', WEEK), { ...OPTS, people: null })).toEqual({ restGaps: [], longWeeks: [] })
  })

  it('names the other studio, never this one, and the coach', () => {
    const out = workingTimeAdvisories([
      S('emp', '2026-09-22', '20:00', '22:00', { location_id: 'loc2', location_name: 'Studio South', name: 'Evening' }),
      S('emp', '2026-09-23', '06:30', '09:00', { name: 'Early' }),
    ], OPTS)
    expect(out.restGaps).toEqual([{
      profile_id: 'emp', coach_name: 'Sam Demo', rest_minutes: 510,
      before: { block_id: 'emp-2026-09-22-20:00', date: '2026-09-22', start: '20:00', end: '22:00', name: 'Evening', location_name: 'Studio South' },
      after: { block_id: 'emp-2026-09-23-06:30', date: '2026-09-23', start: '06:30', end: '09:00', name: 'Early', location_name: null },
    }])
    expect(out.longWeeks).toEqual([])
  })

  it('lists only what this studio\'s publish is about: nothing that lives entirely at the other studio', () => {
    const away = heavy('emp', WEEK, { location_id: 'loc2', location_name: 'Studio South' })
    expect(workingTimeAdvisories(away, OPTS)).toEqual({ restGaps: [], longWeeks: [] })
    const unscoped = workingTimeAdvisories(away, { ...OPTS, hereLocationId: null })
    expect(unscoped.restGaps).toHaveLength(1)
    expect(unscoped.longWeeks).toMatchObject([{ studio_count: 1, shift_count: 5 }])
  })

  it('period and today: a past pair is dropped, a Sunday-close-Monday-open pair across the period end is kept', () => {
    const out = workingTimeAdvisories([
      S('emp', '2026-09-21', '20:00', '22:00'), S('emp', '2026-09-22', '06:00', '08:00'), // before today: history
      S('emp', '2026-09-27', '19:00', '22:00'), // last day of the period, here
      S('emp', '2026-09-28', '06:00', '08:00', { location_id: 'loc2', location_name: 'Studio South' }), // day after, elsewhere
      S('emp', '2026-09-28', '20:00', '22:00'), S('emp', '2026-09-29', '06:00', '08:00'), // wholly after the period
      ...heavy('emp2', NEXT_WEEK), // a long week that is next week's publish
    ], { ...OPTS, todayIso: '2026-09-23' })
    expect(out.restGaps.map((g) => [g.profile_id, g.before.date, g.after.date, g.after.location_name]))
      .toEqual([['emp', '2026-09-27', '2026-09-28', 'Studio South']])
    expect(out.longWeeks).toEqual([])
  })

  it('hours only: no pay, cost or employment field in the answer', () => {
    const out = workingTimeAdvisories(heavy('emp', WEEK), OPTS)
    expect(out.longWeeks).toEqual([{ profile_id: 'emp', coach_name: 'Sam Demo', week_start: '2026-09-21', minutes: 3000, shift_count: 5, studio_count: 1 }])
    expect(JSON.stringify(out)).not.toMatch(/rate|salary|cost|€|employment/i)
  })
})

describe('candidateWorkingTime', () => {
  const HERE = { hereLocationId: 'loc1' }

  it('flags the short rest assigning would create, naming the other shift, on either side', () => {
    const late = S('emp', '2026-09-22', '20:00', '22:00', { location_id: 'loc2', location_name: 'Studio South', name: 'Evening' })
    expect(candidateWorkingTime([late], S('emp', '2026-09-23', '06:30', '08:00'), HERE)).toEqual({
      restGap: {
        rest_minutes: 510, side: 'before',
        other: { block_id: 'emp-2026-09-22-20:00', date: '2026-09-22', start: '20:00', end: '22:00', name: 'Evening', location_name: 'Studio South' },
      },
      weekHours: null,
    })
    expect(candidateWorkingTime([S('emp', '2026-09-24', '06:00', '08:00')], S('emp', '2026-09-23', '19:00', '22:00'), HERE).restGap)
      .toEqual({
        rest_minutes: 480, side: 'after',
        other: { block_id: 'emp-2026-09-24-06:00', date: '2026-09-24', start: '06:00', end: '08:00', name: 'Class', location_name: null },
      })
  })

  it('says nothing when the rest stays at 11 hours or more', () => {
    expect(candidateWorkingTime([S('emp', '2026-09-22', '12:00', '19:00')], S('emp', '2026-09-23', '06:30', '08:00'), HERE))
      .toEqual({ restGap: null, weekHours: null })
  })

  it('does not blame the candidate for a short rest it does not touch', () => {
    const own = [S('emp', '2026-09-21', '18:00', '21:00'), S('emp', '2026-09-22', '06:00', '08:00')] // 9h already
    expect(candidateWorkingTime(own, S('emp', '2026-09-24', '10:00', '12:00'), HERE).restGap).toBeNull()
  })

  it('flags a week the shift would take over 48 hours; exactly 48 is fine', () => {
    const own = WEEK.map((d) => S('emp', d, '09:00', '18:00')) // 45h
    expect(candidateWorkingTime(own, S('emp', '2026-09-26', '09:00', '13:00'), HERE).weekHours)
      .toEqual({ week_start: '2026-09-21', minutes: 2940 })
    expect(candidateWorkingTime(own, S('emp', '2026-09-26', '09:00', '12:00'), HERE).weekHours).toBeNull()
  })

  it('ignores the candidate block already in the list, and other people\'s shifts', () => {
    const cand = S('emp', '2026-09-23', '06:30', '08:00')
    const others = [S('other', '2026-09-22', '20:00', '22:00'), cand]
    expect(candidateWorkingTime(others, cand, HERE)).toEqual({ restGap: null, weekHours: null })
  })
})

describe('copy', () => {
  it('hoursMinutesLabel', () => {
    expect([659, 660, 45, 2895, 0, -5].map(hoursMinutesLabel)).toEqual(['10h 59m', '11h', '45m', '48h 15m', '0m', '0m'])
  })

  it('headlines count people for weeks and rests for rests, and the limits are pinned', () => {
    expect(longWeeksHeadline([{ profile_id: 'a' }, { profile_id: 'a' }])).toBe('1 employee over 48 hours in a week')
    expect(longWeeksHeadline([{ profile_id: 'a' }, { profile_id: 'b' }])).toBe('2 employees over 48 hours in a week')
    expect(restGapsHeadline([{}])).toBe('1 rest under 11 hours between working days')
    expect(restGapsHeadline([{}, {}])).toBe('2 rests under 11 hours between working days')
    expect([MIN_REST_HOURS, MAX_WEEK_HOURS, EMPLOYEE_TYPE]).toEqual([11, 48, 'fte'])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/working-time.test.js`
Expected: `13 failed | 20 passed`: `TypeError: … is not a function` for `workingTimeAdvisories`, `candidateWorkingTime`, `hoursMinutesLabel`, `longWeeksHeadline`.

- [ ] **Step 3: Minimal implementation**

Append to `shared/working-time.js`:

```js
// A slot as a list shows it: the studio is named only when it is ANOTHER one
// (null = the studio being published or assigned at), and location_id stays
// behind.
function displaySlot({ location_id: locationId, ...slot }, hereLocationId) {
  return { ...slot, location_name: hereLocationId && locationId === hereLocationId ? null : (slot.location_name ?? null) }
}

// `people` is a Map or a plain object: id → { full_name, employment_type }.
function personOf(people, id) {
  if (!people || !id) return null
  return (typeof people.get === 'function' ? people.get(id) : people[id]) || null
}

/**
 * The publish preview's list. Employees only (EMPLOYEE_TYPE; an unknown type
 * is not flagged). A rest gap is listed when its later day is today or later,
 * one of its two days is in [from, to], and one of its two shifts is at
 * `hereLocationId`. A long week is listed when it overlaps [from, to], has not
 * ended before today, and has a shift at `hereLocationId`. A null bound or a
 * null hereLocationId does not filter.
 *
 * @returns {{
 *   restGaps: Array<{ profile_id, coach_name, rest_minutes, before, after }>,
 *   longWeeks: Array<{ profile_id, coach_name, week_start, minutes, shift_count, studio_count }>,
 * }}
 */
export function workingTimeAdvisories(shifts, {
  people, hereLocationId = null, from = null, to = null, todayIso = null,
  minRestHours = MIN_REST_HOURS, maxWeekHours = MAX_WEEK_HOURS,
} = {}) {
  const employees = (shifts || []).filter((s) => personOf(people, s?.profile_id)?.employment_type === EMPLOYEE_TYPE)
  const inPeriod = (d) => (!from || d >= from) && (!to || d <= to)
  const isHere = (locationId) => !hereLocationId || locationId === hereLocationId
  const coachName = (id) => personOf(people, id)?.full_name || 'Coach'

  const restGaps = restGapViolations(employees, { minRestHours })
    .filter((v) => (!todayIso || v.after.date >= todayIso)
      && (inPeriod(v.before.date) || inPeriod(v.after.date))
      && (isHere(v.before.location_id) || isHere(v.after.location_id)))
    .map((v) => ({
      profile_id: v.profile_id,
      coach_name: coachName(v.profile_id),
      rest_minutes: v.rest_minutes,
      before: displaySlot(v.before, hereLocationId),
      after: displaySlot(v.after, hereLocationId),
    }))

  const longWeeks = weekHoursOver(employees, maxWeekHours)
    .filter((w) => {
      const weekEnd = addDays(w.week_start, 6)
      return (!todayIso || weekEnd >= todayIso)
        && (!to || w.week_start <= to)
        && (!from || weekEnd >= from)
        && (!hereLocationId || w.location_ids.includes(hereLocationId))
    })
    .map((w) => ({
      profile_id: w.profile_id,
      coach_name: coachName(w.profile_id),
      week_start: w.week_start,
      minutes: w.minutes,
      shift_count: w.shift_count,
      studio_count: w.location_ids.length,
    }))

  return { restGaps, longWeeks }
}

/**
 * The assign picker's question for ONE person: what would adding `candidate`
 * to their shifts create? The caller checks the person is an employee.
 *
 *   restGap    the shortest NEW short rest (violations with the candidate,
 *              minus those without it), with the other shift and which side
 *              of the candidate it is on; null when none.
 *   weekHours  the candidate's week total when it is over the limit WITH the
 *              candidate (even if it already was); null otherwise.
 *
 * `shifts` may hold other people and the candidate's own block: both ignored.
 */
export function candidateWorkingTime(shifts, candidate, {
  hereLocationId = null, minRestHours = MIN_REST_HOURS, maxWeekHours = MAX_WEEK_HOURS,
} = {}) {
  const cand = workingWindow(candidate)
  if (!cand) return { restGap: null, weekHours: null }
  const own = (shifts || []).filter((s) => s?.profile_id === cand.profile_id && s.block_id !== cand.block_id)
  const withCandidate = [...own, candidate]

  const pairKey = (v) => `${v.before.block_id}|${v.after.block_id}`
  const existing = new Set(restGapViolations(own, { minRestHours }).map(pairKey))
  const worst = restGapViolations(withCandidate, { minRestHours })
    .filter((v) => !existing.has(pairKey(v)))
    .filter((v) => v.before.block_id === cand.block_id || v.after.block_id === cand.block_id)
    .sort((a, b) => a.rest_minutes - b.rest_minutes)[0]
  const candidateFirst = worst?.before.block_id === cand.block_id
  const restGap = worst
    ? {
      rest_minutes: worst.rest_minutes,
      side: candidateFirst ? 'after' : 'before',
      other: displaySlot(candidateFirst ? worst.after : worst.before, hereLocationId),
    }
    : null

  const weekStart = weekStartOf(cand.date)
  const week = weekHoursOver(withCandidate, maxWeekHours).find((w) => w.week_start === weekStart)
  return { restGap, weekHours: week ? { week_start: weekStart, minutes: week.minutes } : null }
}

// ── Copy ────────────────────────────────────────────────────────────────────

/** 659 → '10h 59m', 660 → '11h', 45 → '45m'. Negative or garbage → '0m'. */
export function hoursMinutesLabel(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h === 0) return `${r}m`
  return r === 0 ? `${h}h` : `${h}h ${r}m`
}

/** Counts PEOPLE: one person over in two weeks is still one employee. */
export function longWeeksHeadline(longWeeks) {
  const n = new Set((longWeeks || []).map((w) => w.profile_id)).size
  return `${n} employee${n === 1 ? '' : 's'} over ${MAX_WEEK_HOURS} hours in a week`
}

export function restGapsHeadline(restGaps) {
  const n = (restGaps || []).length
  return `${n} rest${n === 1 ? '' : 's'} under ${MIN_REST_HOURS} hours between working days`
}
```

- [ ] **Step 4: Run it, expect PASS, under two host timezones, plus the pair-sync guard**

Run: `TZ=Europe/Dublin npx vitest run shared/working-time.test.js && TZ=America/Los_Angeles npx vitest run shared/working-time.test.js && npx vitest run tests/shared-pair-sync.test.js`
Expected: `33 passed` twice, then the pair-sync file all passed. A pair-sync failure means an export name collided with `src/lib`. Rename it; never classify it.

- [ ] **Step 5: Commit**

```bash
git add shared/working-time.js shared/working-time.test.js
git commit -m "WORKTIME.1 — workingTimeAdvisories (employees, this studio's publish) and candidateWorkingTime (the picker)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The reader — a set of people's shifts across the organisation's studios

**Files:**
- Create: `src/lib/working-time-data.js`
- Create: `src/lib/working-time-data.test.js`

Four fixed reads, whatever the number of blocks: `siblingLocationIds` (two small `locations` reads), `profiles` for the given ids, and their `shift_assignments` paged at 1,000 with an explicit `.order('id')` (CLAUDE.md, 1,000-row cap). Contractors' shifts are never read: the assignments query takes the employee ids only.

- [ ] **Step 1: Write the failing test**

Create `src/lib/working-time-data.test.js`:

```js
// WORKTIME.1 — the working-time reader. The rules are pinned in
// shared/working-time.test.js; this file pins the READ: which studios, which
// people, which columns, and that a failure is never an all-clear.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./sibling-locations', () => ({ siblingLocationIds: vi.fn() }))
vi.mock('./log', async () => ({ ...(await vi.importActual('./log')), logWarn: vi.fn() }))

import { siblingLocationIds } from './sibling-locations'
import { loadWorkingTimeShifts } from './working-time-data'

const PEOPLE = [
  { id: 'emp', full_name: 'Sam Demo', employment_type: 'fte' },
  { id: 'con', full_name: 'Max Beta', employment_type: 'contractor' },
]
const NAMES = { loc1: 'Studio North', loc2: 'Studio South', loc9: 'Another Organisation' }

const row = (id, profile_id, loc, date, start, end, over = {}) => ({
  id, profile_id, status: 'scheduled', start_time_override: null, end_time_override: null,
  shift_blocks: {
    id: `b-${id}`, location_id: loc, block_date: date, start_time: start, end_time: end,
    shift_templates: { name: 'Class', start_time: start, end_time: end }, locations: { name: NAMES[loc] },
  },
  ...over,
})

function mockDb({ people = PEOPLE, assignments = [], failPeople = false, failAssignments = false, throwOn = null } = {}) {
  const log = { profiles: [], assignments: [] }
  return {
    log,
    from(table) {
      if (throwOn === table) throw new Error(`${table}: client exploded`)
      if (table === 'profiles') {
        const q = { select: null, ids: null }
        log.profiles.push(q)
        const chain = {
          select: (s) => { q.select = s; return chain },
          in: (_c, v) => { q.ids = v; return chain },
          then: (onF, onR) => Promise.resolve(failPeople
            ? { data: null, error: { message: 'profiles unreadable' } }
            : { data: people.filter((p) => q.ids.includes(p.id)), error: null }).then(onF, onR),
        }
        return chain
      }
      if (table === 'shift_assignments') {
        const q = { select: null, profileIds: null, locIds: null, gte: null, lte: null, orders: [], from: 0, to: Infinity }
        log.assignments.push(q)
        const chain = {
          select: (s) => { q.select = s; return chain },
          in: (c, v) => { if (c === 'profile_id') q.profileIds = v; else if (c === 'shift_blocks.location_id') q.locIds = v; return chain },
          gte: (c, v) => { q.gte = [c, v]; return chain },
          lte: (c, v) => { q.lte = [c, v]; return chain },
          order: (c) => { q.orders.push(c); return chain },
          range: (f, t) => { q.from = f; q.to = t; return chain },
          // Deliberately NOT filtered by studio: the reader must re-check the
          // organisation boundary itself.
          then: (onF, onR) => Promise.resolve(failAssignments
            ? { data: null, error: { message: 'assignments unreadable' } }
            : { data: assignments.filter((a) => q.profileIds.includes(a.profile_id)).slice(q.from, q.to + 1), error: null }).then(onF, onR),
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const ARGS = { locationId: 'loc1', profileIds: ['emp', 'con'], from: '2026-09-20', to: '2026-09-28' }

beforeEach(() => {
  siblingLocationIds.mockReset().mockResolvedValue({ ids: ['loc2'], error: null })
})

describe('loadWorkingTimeShifts', () => {
  it('reads this organisation\'s studios only, and drops a row from anywhere else even if it comes back', async () => {
    const db = mockDb({ assignments: [
      row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00'),
      row('a2', 'emp', 'loc2', '2026-09-22', '20:00:00', '22:00:00'),
      row('a9', 'emp', 'loc9', '2026-09-23', '06:00:00', '08:00:00'),
    ] })
    const out = await loadWorkingTimeShifts(db, ARGS)
    expect(siblingLocationIds).toHaveBeenCalledWith(db, 'loc1')
    expect(db.log.assignments[0].locIds).toEqual(['loc1', 'loc2'])
    expect(out.shifts.map((s) => s.location_id)).toEqual(['loc1', 'loc2'])
    expect(out.crossStudioChecked).toBe(true)
    expect(out.error).toBeNull()
  })

  it('reads names and employment type only: never a pay column', async () => {
    const db = mockDb()
    const out = await loadWorkingTimeShifts(db, ARGS)
    expect(db.log.profiles[0].select).toBe('id, full_name, employment_type')
    expect(db.log.assignments.map((q) => q.select).join(' ')).not.toMatch(/rate|salary|contracted|overtime|compensation/)
    expect(out.people.get('emp')).toEqual({ full_name: 'Sam Demo', employment_type: 'fte' })
  })

  it('never reads a contractor\'s shifts, and reads nothing at all when nobody is an employee', async () => {
    const db = mockDb()
    await loadWorkingTimeShifts(db, ARGS)
    expect(db.log.assignments[0].profileIds).toEqual(['emp'])
    const onlyCon = mockDb()
    const out = await loadWorkingTimeShifts(onlyCon, { ...ARGS, profileIds: ['con'] })
    expect(onlyCon.log.assignments).toHaveLength(0)
    expect(out).toMatchObject({ shifts: [], crossStudioChecked: true, error: null })
  })

  it('reads the window it is given, and flattens to the shape the rules read, live rows only', async () => {
    const db = mockDb({ assignments: [
      row('a1', 'emp', 'loc2', '2026-09-22', '20:00:00', '22:00:00', { end_time_override: '22:30:00' }),
      row('a2', 'emp', 'loc1', '2026-09-23', '06:30:00', '08:00:00', { status: 'cancelled' }),
    ] })
    const out = await loadWorkingTimeShifts(db, ARGS)
    expect(db.log.assignments[0].gte).toEqual(['shift_blocks.block_date', '2026-09-20'])
    expect(db.log.assignments[0].lte).toEqual(['shift_blocks.block_date', '2026-09-28'])
    expect(out.shifts).toEqual([{
      profile_id: 'emp', block_id: 'b-a1', block_date: '2026-09-22', location_id: 'loc2', location_name: 'Studio South',
      name: 'Class', status: 'scheduled', start_time_override: null, end_time_override: '22:30:00',
      start_time: '20:00:00', end_time: '22:00:00', shift_templates: { start_time: '20:00:00', end_time: '22:00:00' },
    }])
  })

  it('pages past the 1,000-row cap, ordered by id', async () => {
    const assignments = Array.from({ length: 1001 }, (_, i) =>
      row(`a${String(i).padStart(4, '0')}`, 'emp', 'loc1', '2026-09-22', '09:00:00', '10:00:00'))
    const db = mockDb({ assignments })
    const out = await loadWorkingTimeShifts(db, ARGS)
    expect(db.log.assignments).toHaveLength(2)
    expect(db.log.assignments[0].orders).toEqual(['id'])
    expect(out.shifts).toHaveLength(1001)
  })

  it('unreadable sibling studios narrow the read to this studio and say the check is incomplete', async () => {
    siblingLocationIds.mockResolvedValue({ ids: [], error: { message: 'siblings unreadable' } })
    const db = mockDb({ assignments: [row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00')] })
    const out = await loadWorkingTimeShifts(db, ARGS)
    expect(db.log.assignments[0].locIds).toEqual(['loc1'])
    expect(out.shifts).toHaveLength(1)
    expect(out.crossStudioChecked).toBe(false)
    expect(out.error).toBeNull()
  })

  it('a failed read is an error with NO shifts, never an empty all-clear', async () => {
    for (const fail of [{ failPeople: true }, { failAssignments: true }]) {
      const out = await loadWorkingTimeShifts(mockDb({ ...fail, assignments: [row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00')] }), ARGS)
      expect(out.shifts).toEqual([])
      expect(out.error).toMatchObject({ message: expect.stringMatching(/unreadable/) })
    }
  })

  it('never throws', async () => {
    const out = await loadWorkingTimeShifts(mockDb({ throwOn: 'shift_assignments' }), ARGS)
    expect(out).toMatchObject({ shifts: [], crossStudioChecked: false, error: { message: 'shift_assignments: client exploded' } })
  })

  it('nobody to check: no reads at all', async () => {
    const db = mockDb()
    const out = await loadWorkingTimeShifts(db, { ...ARGS, profileIds: [] })
    expect(siblingLocationIds).not.toHaveBeenCalled()
    expect(db.log.profiles).toHaveLength(0)
    expect(out).toMatchObject({ shifts: [], crossStudioChecked: true, error: null })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/working-time-data.test.js`
Expected: `Test Files 1 failed`, cannot resolve `./working-time-data`.

- [ ] **Step 3: Minimal implementation**

Create `src/lib/working-time-data.js`:

```js
// WORKTIME.1 — the shifts working-time advisories are judged on: every live
// assignment of these people, EMPLOYEES ONLY, at every studio of the
// organisation `locationId` belongs to, on block dates [from, to].
//
// ORGSCOPE.1: "both studios" means this studio plus its organisation's other
// studios (siblingLocationIds), never a studio of another organisation.
// Nothing keeps a person inside one organisation, and the advisory prints the
// other shift's times and studio. The embedded filter is the boundary; the rows
// are re-checked against it afterwards, like the assign route's double-booking
// read.
//
// Pay never enters. profiles is read for id, full_name and employment_type
// only (it still carries pay columns: CLAUDE.md, "name your columns"), and
// profile_compensation is not read at all. A contractor's shifts are never
// read: the assignments query takes the employees' ids only.
//
// Cost: four fixed reads whatever the number of blocks (two small locations
// reads in siblingLocationIds, one profiles read, the assignments paged at
// 1,000).
//
// Never throws. Unreadable siblings narrow the read to this studio and set
// crossStudioChecked false. A failed profiles or assignments read returns
// `error` with NO shifts, which callers report as "could not be checked",
// never as an all-clear.

import { isLiveAssignment } from './roster'
import { siblingLocationIds } from './sibling-locations'
import { logWarn } from './log'
import { EMPLOYEE_TYPE } from '@shared/working-time'

const PAGE = 1000

const SHIFT_SELECT = 'id, profile_id, status, start_time_override, end_time_override, '
  + 'shift_blocks!inner(id, location_id, block_date, start_time, end_time, shift_templates(name, start_time, end_time), locations(name))'

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {{ locationId: string, profileIds: string[], from: string, to: string }} opts
 * @returns {Promise<{
 *   shifts: Array<{ profile_id, block_id, block_date, location_id, location_name, name, status,
 *     start_time_override, end_time_override, start_time, end_time, shift_templates }>,
 *   people: Map<string, { full_name: string|null, employment_type: string|null }>,
 *   crossStudioChecked: boolean,
 *   error: { message: string } | null,
 * }>}
 */
export async function loadWorkingTimeShifts(db, { locationId, profileIds, from, to } = {}) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  if (!locationId || ids.length === 0) {
    return { shifts: [], people: new Map(), crossStudioChecked: true, error: null }
  }
  const failed = (error) => ({ shifts: [], people: new Map(), crossStudioChecked: false, error })

  try {
    const { ids: siblingIds, error: sibErr } = await siblingLocationIds(db, locationId)
    if (sibErr) {
      logWarn('working-time', 'sibling studios unreadable; working-time check is this studio only', { locationId, err: sibErr.message })
    }
    const crossStudioChecked = !sibErr
    const scopeIds = [locationId, ...(siblingIds || []).filter((id) => id && id !== locationId)]

    const { data: rows, error: peopleErr } = await db
      .from('profiles')
      .select('id, full_name, employment_type')
      .in('id', ids)
    if (peopleErr) return failed(peopleErr)
    const people = new Map()
    for (const p of rows || []) {
      if (p?.id) people.set(p.id, { full_name: p.full_name ?? null, employment_type: p.employment_type ?? null })
    }
    const employeeIds = ids.filter((id) => people.get(id)?.employment_type === EMPLOYEE_TYPE)
    if (employeeIds.length === 0) return { shifts: [], people, crossStudioChecked, error: null }

    const shifts = []
    for (let offset = 0; ; offset += PAGE) {
      const { data: page, error } = await db
        .from('shift_assignments')
        .select(SHIFT_SELECT)
        .in('profile_id', employeeIds)
        .in('shift_blocks.location_id', scopeIds)
        .gte('shift_blocks.block_date', from)
        .lte('shift_blocks.block_date', to)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) return failed(error)
      for (const a of page || []) {
        const b = a?.shift_blocks
        // The filter above is the boundary; this re-check does not depend on
        // how PostgREST applies an embedded filter.
        if (!b || !scopeIds.includes(b.location_id) || !isLiveAssignment(a)) continue
        shifts.push({
          profile_id: a.profile_id,
          block_id: b.id,
          block_date: b.block_date,
          location_id: b.location_id,
          location_name: b.locations?.name ?? null,
          name: b.shift_templates?.name || 'Shift',
          status: a.status ?? null,
          start_time_override: a.start_time_override ?? null,
          end_time_override: a.end_time_override ?? null,
          start_time: b.start_time ?? null,
          end_time: b.end_time ?? null,
          shift_templates: { start_time: b.shift_templates?.start_time ?? null, end_time: b.shift_templates?.end_time ?? null },
        })
      }
      if (!page || page.length < PAGE) break
    }
    return { shifts, people, crossStudioChecked, error: null }
  } catch (e) {
    return failed({ message: e?.message || 'working-time read threw' })
  }
}
```

- [ ] **Step 4: Run it, expect PASS, and the schema check**

Run: `npx vitest run src/lib/working-time-data.test.js && npm run check:select-columns`
Expected: `9 passed`; `check:select-columns` exits 0. Every column named exists: `shift_assignments.status/start_time_override/end_time_override`, `shift_blocks.start_time/end_time` (mig 067:70-71), `shift_templates.name/start_time/end_time`, `locations.name`, and `profiles.employment_type` (mig 070).

- [ ] **Step 5: Commit**

```bash
git add src/lib/working-time-data.js src/lib/working-time-data.test.js
git commit -m "WORKTIME.1 — working-time reader: employees' shifts across the organisation's studios, no pay columns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The publish preview carries `workingTime`

**Files:**
- Modify: `src/lib/roster-publish.js`
- Modify: `src/lib/roster-publish.test.js`

`loadBudgetContext` (`src/lib/roster-publish.js:88`) calls the reader ONCE when `advisories` is true, for the people with a live shift HERE inside the period. The window runs from the Sunday before the period's first week to the Monday after its last week: a rest gap reaches one day either side, and a week total needs the whole Monday to Sunday. `impactFromContext` (`:424`) turns it into `impact.workingTime = { restGaps, longWeeks, checked }`. The flag is separate from `crossLocationChecked`: a working-time read that failed is not a clash check that failed.

- [ ] **Step 1: Write the failing test**

In `src/lib/roster-publish.test.js`:

1. Line 12: `import { describe, it, expect, afterEach, vi } from 'vitest'` → `import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'`.
2. After the `vi.mock('./log', …)` block (ends line 24), add:

```js
// WORKTIME.1 — the reader is pinned in working-time-data.test.js. Here it is a
// seam, so no budget fixture above ever meets a profiles table. Default: an
// empty, complete read.
const EMPTY_WORKING_TIME = () => ({ shifts: [], people: new Map(), crossStudioChecked: true, error: null })
vi.mock('./working-time-data', () => ({ loadWorkingTimeShifts: vi.fn(async () => EMPTY_WORKING_TIME()) }))
```

vitest hoists `vi.mock` above the `const`, but the factory only CALLS `EMPTY_WORKING_TIME` when the mock runs, which is after module evaluation. If the runner complains about the hoisted reference anyway, inline the object literal in the factory.

3. After the last import (the `import { logWarn } from './log'` line), add:

```js
import { loadWorkingTimeShifts } from './working-time-data'
```

4. Append at the end of the file:

```js
describe('projectPublishImpact — working time (WORKTIME.1)', () => {
  const PERIOD = { locationId: 'loc1', periodStart: '2026-05-04', periodEnd: '2026-05-10', todayIso: '2026-05-01' }
  const PEOPLE = new Map([['sarah', { full_name: 'Sam Demo', employment_type: 'fte' }]])
  const read = (over = {}) => ({ shifts: [], people: PEOPLE, crossStudioChecked: true, error: null, ...over })
  const row = (block_id, block_date, start_time, end_time, location_id = 'loc1', location_name = 'Studio North') =>
    ({ profile_id: 'sarah', block_id, block_date, start_time, end_time, location_id, location_name, name: 'Class' })
  const fixture = () => mockDb({
    location: { id: 'loc1', monthly_contractor_budget_eur: 500 },
    contractors: [dan, sarah],
    blocks: [
      block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00', coaches: ['sarah', 'dan'] }),
      block({ id: 'b-later', date: '2026-05-20', start: '09:00', end: '11:00', coaches: ['eve'] }), // same month, outside the period
    ],
  })

  beforeEach(() => { loadWorkingTimeShifts.mockReset(); loadWorkingTimeShifts.mockResolvedValue(read()) })
  afterEach(() => { loadWorkingTimeShifts.mockReset(); loadWorkingTimeShifts.mockImplementation(async () => EMPTY_WORKING_TIME()) })

  it('reads ONCE per preview: the people rostered here in the period, Sunday before its first week to Monday after its last', async () => {
    await projectPublishImpact(fixture(), PERIOD)
    expect(loadWorkingTimeShifts).toHaveBeenCalledTimes(1)
    const [, args] = loadWorkingTimeShifts.mock.calls[0]
    expect({ ...args, profileIds: [...args.profileIds].sort() }).toEqual({
      locationId: 'loc1', profileIds: ['dan', 'sarah'], from: '2026-05-03', to: '2026-05-11',
    })
  })

  it('lists a long week, hours only', async () => {
    loadWorkingTimeShifts.mockResolvedValue(read({
      shifts: ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09']
        .map((d) => row(`w-${d}`, d, '09:00', '17:15')),
    }))
    const r = await projectPublishImpact(fixture(), PERIOD)
    expect(r.workingTime).toEqual({
      checked: true,
      restGaps: [],
      longWeeks: [{ profile_id: 'sarah', coach_name: 'Sam Demo', week_start: '2026-05-04', minutes: 2970, shift_count: 6, studio_count: 1 }],
    })
    expect(JSON.stringify(r.workingTime)).not.toMatch(/€|rate|salary|cost/i)
  })

  it('lists a short rest across the two studios, naming only the other one', async () => {
    loadWorkingTimeShifts.mockResolvedValue(read({
      shifts: [row('hs', '2026-05-05', '20:00', '22:00', 'loc2', 'Studio South'), row('b1', '2026-05-06', '06:30', '08:00')],
    }))
    const r = await projectPublishImpact(fixture(), PERIOD)
    expect(r.workingTime.restGaps).toMatchObject([{
      profile_id: 'sarah', coach_name: 'Sam Demo', rest_minutes: 510,
      before: { date: '2026-05-05', location_name: 'Studio South' }, after: { date: '2026-05-06', location_name: null },
    }])
  })

  it('a failed read, or one that throws, says "not checked" and touches neither the budget nor the clash lists', async () => {
    const baseline = await projectPublishImpact(fixture(), PERIOD)
    for (const setup of [
      () => loadWorkingTimeShifts.mockResolvedValue(read({ people: new Map(), crossStudioChecked: false, error: { message: 'down' } })),
      () => loadWorkingTimeShifts.mockRejectedValue(new Error('boom')),
    ]) {
      setup()
      const r = await projectPublishImpact(fixture(), PERIOD)
      expect(r.workingTime).toEqual({ restGaps: [], longWeeks: [], checked: false })
      expect(r.crossLocationChecked).toBe(true)
      expect(r.periodProjectedEur).toBe(baseline.periodProjectedEur)
      expect(r.overBudget).toBe(baseline.overBudget)
    }
  })

  it('unreadable other studios: lists what it could read and says the check is incomplete', async () => {
    loadWorkingTimeShifts.mockResolvedValue(read({
      crossStudioChecked: false,
      shifts: ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09']
        .map((d) => row(`w-${d}`, d, '09:00', '17:15')),
    }))
    const r = await projectPublishImpact(fixture(), PERIOD)
    expect(r.workingTime.checked).toBe(false)
    expect(r.workingTime.longWeeks).toHaveLength(1)
  })

  it('a real publish (advisories: false) never reads it and carries no workingTime key', async () => {
    const r = await projectPublishImpact(fixture(), { ...PERIOD, advisories: false })
    expect(loadWorkingTimeShifts).not.toHaveBeenCalled()
    expect('workingTime' in r).toBe(false)
  })
})
```

(`mockDb`, `block`, `dan` and `sarah` are the file's own fixtures, lines 54-203. `dan` is a €35/h contractor, so the budget figure the failure test compares is 2h × 35 = 70.)

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-publish.test.js`
Expected: `5 failed`, all in the new describe (`loadWorkingTimeShifts` never called; `r.workingTime` undefined). The sixth, the real-publish test, already holds, and it pins that this stays so. Every other test in the file passes.

- [ ] **Step 3: Minimal implementation**

In `src/lib/roster-publish.js`:

1. Imports. Line 19 `import { shiftHours } from './payroll'` → `import { shiftHours, mondayOf } from './payroll'`. Line 22 `import { dublinTodayStr } from './dublin-time'` → `import { dublinTodayStr, addDaysISO } from './dublin-time'`. After line 26 add:

```js
import { loadWorkingTimeShifts } from './working-time-data'
import { workingTimeAdvisories } from '@shared/working-time'
```

2. In `loadBudgetContext`, between the end of the other-studio `try/catch` (line 238) and `return {` (line 240), insert:

```js
  // WORKTIME.1 — every shift, at any studio of this organisation, of the
  // people rostered HERE in the period, from the Sunday before the period's
  // first week to the Monday after its last (a rest gap reaches one day either
  // side; a week total needs the whole Mon-Sun week). ONE reader call per
  // preview, never per block. The reader never throws and reads names and
  // employment type only, never a rate. The try is belt and braces: this
  // function is also the budget gate, and an advisory must never be able to
  // refuse a publish.
  let workingTime = null
  if (advisories) {
    const periodIds = [...new Set(monthBlocks
      .filter((b) => b.block_date >= periodStart && b.block_date <= periodEnd)
      .flatMap((b) => liveAssignments(b.shift_assignments).map((a) => a.profile_id))
      .filter(Boolean))]
    try {
      workingTime = await loadWorkingTimeShifts(db, {
        locationId,
        profileIds: periodIds,
        from: addDaysISO(mondayOf(periodStart), -1),
        to: addDaysISO(mondayOf(periodEnd), 7),
      })
    } catch (e) {
      logWarn('roster-publish', 'working-time read threw; omitted from the publish preview', { locationId, err: e?.message })
      workingTime = { shifts: [], people: new Map(), crossStudioChecked: false, error: { message: e?.message || 'working-time read threw' } }
    }
  }
```

and add `workingTime,` to the returned object after `otherAssignments,` (line 247).

3. Directly above `function impactFromContext` (line 424), add:

```js
/**
 * WORKTIME.1 — the preview's working-time list from the reader's answer.
 * `checked: false` when the read failed, could not see the other studios, or
 * the pure helper threw: an empty list is then "not checked", never "clear".
 */
function workingTimeList(wt, { locationId, periodStart, periodEnd, todayIso }) {
  const unchecked = { restGaps: [], longWeeks: [], checked: false }
  if (!wt || wt.error) return unchecked
  try {
    const { restGaps, longWeeks } = workingTimeAdvisories(wt.shifts, {
      people: wt.people, hereLocationId: locationId, from: periodStart, to: periodEnd, todayIso,
    })
    return { restGaps, longWeeks, checked: wt.crossStudioChecked !== false }
  } catch (e) {
    logWarn('roster-publish', 'working-time advisory threw; omitted from the publish preview', { locationId, err: e?.message })
    return unchecked
  }
}
```

4. In `impactFromContext`, add `workingTime` to the destructure on line 425 (`const { location, contractorRateById, leaveByProfile, monthBlocks, otherAssignments, workingTime, advisories = true } = ctx`). After `advisoryLists.crossLocationChecked = complete` (line 522), add:

```js
    // WORKTIME.1 — employees' rest and weekly hours, both studios. Its own
    // `checked`: a working-time read that failed is not a clash check that
    // failed, and neither may read as an all-clear.
    advisoryLists.workingTime = workingTimeList(workingTime, { locationId: location?.id, periodStart, periodEnd, todayIso })
```

5. In the `projectPublishImpact` JSDoc, under the `crossLocationChecked: boolean,` line, add:

```js
 *   // WORKTIME.1 — with `advisories: true` only. Employees, hours only.
 *   workingTime: { restGaps: Array<{ profile_id, coach_name, rest_minutes, before, after }>,
 *                  longWeeks: Array<{ profile_id, coach_name, week_start, minutes, shift_count, studio_count }>,
 *                  checked: boolean },
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-publish.test.js src/app/api/schedule/rosters/route.test.js && TZ=America/Los_Angeles npx vitest run src/lib/roster-publish.test.js`
Expected: all passed, 0 failed, including the 6 new tests and the batch-equivalence tests at lines 865-882. With `advisories: true`, the batch and single paths meet the same mocked reader, and `workingTimeAdvisories` scopes to each period, so they stay equal.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-publish.js src/lib/roster-publish.test.js
git commit -m "WORKTIME.1 — publish preview carries workingTime: one read per dry run, fails soft, never gates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `GET /api/schedule/working-time?block_id=` for the assign picker

**Files:**
- Create: `src/app/api/schedule/working-time/route.js`
- Create: `src/app/api/schedule/working-time/route.test.js`
- Modify: `src/lib/openapi.js` (insert after line 4488, the end of the `/api/schedule/runway` registration)

The gate is the assign route's gate (`src/app/api/schedule/blocks/[id]/assignments/route.js:62-90`): `MANAGER_ROLES` AT the block's studio. An outsider to that studio gets 404, so the id is never confirmed. The candidates are the studio's members (`profile_locations`), minus anyone already live on the block. The reader then keeps employees only.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/schedule/working-time/route.test.js`:

```js
// WORKTIME.1 — GET /api/schedule/working-time. The rules are pinned in
// shared/working-time.test.js and the read in src/lib/working-time-data.test.js.
// Locked here: the gate, who is asked about, and what never leaves the route.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccessOr404: vi.fn(() => null),
    // REAL: the role AT the block's studio is what is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/working-time-data', () => ({ loadWorkingTimeShifts: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser, assertLocationAccessOr404 } = await import('@/lib/auth')
const { loadWorkingTimeShifts } = await import('@/lib/working-time-data')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BLOCK_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

// Wednesday 23 Sep 2026, 06:30-08:00.
const BLOCK = {
  id: BLOCK_ID, location_id: LOC, block_date: '2026-09-23', start_time: '06:30:00', end_time: '08:00:00',
  shift_templates: { name: 'Early', start_time: '06:30:00', end_time: '08:00:00' },
  shift_assignments: [{ profile_id: 'already', status: 'scheduled' }, { profile_id: 'gone', status: 'cancelled' }],
}
const MEMBERS = ['already', 'gone', 'late', 'busy', 'free', 'con']

const row = (profile_id, block_id, block_date, start_time, end_time, over = {}) => ({
  profile_id, block_id, block_date, start_time, end_time, location_id: LOC, location_name: 'Studio North', name: 'Class', ...over,
})
const READ = {
  shifts: [
    // Closes the other studio at 22:00 the night before: 8h 30m to 06:30.
    row('late', 'hs-1', '2026-09-22', '20:00:00', '22:00:00', { location_id: OTHER, location_name: 'Studio South', name: 'Evening' }),
    // 47 hours already this week; the 1h 30m shift makes 48h 30m.
    row('busy', 'b1', '2026-09-21', '09:00:00', '18:00:00'),
    row('busy', 'b2', '2026-09-22', '09:00:00', '18:00:00'),
    row('busy', 'b4', '2026-09-24', '09:00:00', '18:00:00'),
    row('busy', 'b5', '2026-09-25', '09:00:00', '18:00:00'),
    row('busy', 'b6', '2026-09-26', '09:00:00', '20:00:00'),
    // A contractor the reader should never have returned: the route must not list them either.
    row('con', 'c1', '2026-09-22', '21:00:00', '23:00:00'),
  ],
  people: new Map([
    ['late', { full_name: 'Sam Demo', employment_type: 'fte' }],
    ['busy', { full_name: 'Max Beta', employment_type: 'fte' }],
    ['free', { full_name: 'Toby Beta', employment_type: 'fte' }],
    ['con', { full_name: 'Casey Manager', employment_type: 'contractor' }],
  ]),
  crossStudioChecked: true,
  error: null,
}

function dbWith({ block = BLOCK, blockError = null, members = MEMBERS } = {}) {
  return {
    from(table) {
      if (table === 'shift_blocks') {
        const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: blockError ? null : block, error: blockError }) }
        return chain
      }
      if (table === 'profile_locations') {
        return { select: () => ({ eq: async () => ({ data: members.map((profile_id) => ({ profile_id })), error: null }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const req = (params = {}) => {
  const url = new URL('http://test/api/schedule/working-time')
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const userWith = (rolesByLocation, profileRole = 'staff') => ({
  id: 'u1', profileRole, rolesByLocation, locations: Object.keys(rolesByLocation).map((id) => ({ id })),
})

let db
beforeEach(() => {
  db = dbWith()
  createServerClient.mockReset().mockImplementation(() => db)
  getCurrentUser.mockReset()
  assertLocationAccessOr404.mockReset().mockReturnValue(null)
  loadWorkingTimeShifts.mockReset().mockResolvedValue(READ)
})

describe('GET /api/schedule/working-time', () => {
  it('403 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req({ block_id: BLOCK_ID }))).status).toBe(403)
    expect(loadWorkingTimeShifts).not.toHaveBeenCalled()
  })

  it('403 for a coach at the block\'s studio, even though they manage another', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'staff', [OTHER]: 'manager' }))
    expect((await GET(req({ block_id: BLOCK_ID }))).status).toBe(403)
    expect(loadWorkingTimeShifts).not.toHaveBeenCalled()
  })

  it('400 on a missing or malformed block_id', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    expect((await GET(req({}))).status).toBe(400)
    expect((await GET(req({ block_id: 'nope' }))).status).toBe(400)
  })

  it('404 when the block does not exist', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    db = dbWith({ block: null })
    expect((await GET(req({ block_id: BLOCK_ID }))).status).toBe(404)
  })

  it('404, not 403, for a manager of another studio: the id is not confirmed', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [OTHER]: 'manager' }))
    assertLocationAccessOr404.mockReturnValue(NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }))
    expect((await GET(req({ block_id: BLOCK_ID }))).status).toBe(404)
    expect(loadWorkingTimeShifts).not.toHaveBeenCalled()
  })

  it('200: lists the employees this shift would leave short of rest or over 48 hours, from ONE read of the week', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'head_coach' }))
    const res = await GET(req({ block_id: BLOCK_ID }))
    expect(res.status).toBe(200)
    expect(loadWorkingTimeShifts).toHaveBeenCalledTimes(1)
    expect(loadWorkingTimeShifts).toHaveBeenCalledWith(db, {
      locationId: LOC, profileIds: ['gone', 'late', 'busy', 'free', 'con'], from: '2026-09-20', to: '2026-09-28',
    })
    expect(await res.json()).toEqual({
      success: true,
      data: {
        checked: true,
        byProfile: {
          late: {
            restGap: { rest_minutes: 510, side: 'before', other: { block_id: 'hs-1', date: '2026-09-22', start: '20:00', end: '22:00', name: 'Evening', location_name: 'Studio South' } },
            weekHours: null,
          },
          busy: { restGap: null, weekHours: { week_start: '2026-09-21', minutes: 2910 } },
        },
      },
    })
  })

  it('never lists a contractor or someone already on the block, and no pay or employment field leaves the route', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    const body = await (await GET(req({ block_id: BLOCK_ID }))).json()
    expect(Object.keys(body.data.byProfile).sort()).toEqual(['busy', 'late'])
    expect(JSON.stringify(body)).not.toMatch(/employment|contractor|hourly|salary|contracted|rate|full_name/i)
  })

  it('a failed working-time read is checked:false with nobody listed, never an all-clear', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    loadWorkingTimeShifts.mockResolvedValue({ shifts: [], people: new Map(), crossStudioChecked: false, error: { message: 'down' } })
    const res = await GET(req({ block_id: BLOCK_ID }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { byProfile: {}, checked: false } })
  })

  it('500 when the block read fails', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    db = dbWith({ blockError: { message: 'db down' } })
    expect((await GET(req({ block_id: BLOCK_ID }))).status).toBe(500)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/working-time/route.test.js`
Expected: `Test Files 1 failed`, cannot resolve `./route.js`.

- [ ] **Step 3: Minimal implementation**

Create `src/app/api/schedule/working-time/route.js`:

```js
// WORKTIME.1 — GET /api/schedule/working-time?block_id=<uuid>
//
// For the assign picker: for each EMPLOYEE of the block's studio who is not
// already on it, would assigning them to this block leave fewer than 11 hours
// between working days, or more than 48 rostered hours in its Mon-Sun week,
// counting their shifts at every studio of this organisation? ADVISORY ONLY:
// the picker shows a badge and the row stays tickable. POST
// /api/schedule/blocks/[id]/assignments is unchanged and never consults this.
//
// Gate: MANAGER_ROLES AT the block's studio (the assign route's gate). An
// outsider to that studio gets 404, so the block id is never confirmed.
//
// Returns { success, data: { byProfile: { [profileId]: { restGap, weekHours } },
// checked } }. Only people with something to say are listed; contractors never
// are. Shift times and hours only: no name, rate, cost, contract hours or
// employment type leaves this route. `checked: false` = the read failed or
// could not see the other studios, so an empty map is not an all-clear.
//
// The path deliberately avoids `/schedule/blocks`: calendar tests route that
// substring to the block list and count block reads.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { liveAssignments } from '@/lib/roster'
import { mondayOf } from '@/lib/payroll'
import { addDaysISO } from '@/lib/dublin-time'
import { loadWorkingTimeShifts } from '@/lib/working-time-data'
import { candidateWorkingTime, EMPLOYEE_TYPE } from '@shared/working-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({ block_id: uuidLike })

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({ block_id: url.searchParams.get('block_id') })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const db = createServerClient()

  // Block lookup: also the studio-ownership gate.
  const { data: block, error: blockErr } = await db
    .from('shift_blocks')
    .select('id, location_id, block_date, start_time, end_time, shift_templates(name, start_time, end_time), shift_assignments(profile_id, status)')
    .eq('id', parsed.data.block_id)
    .maybeSingle()
  if (blockErr) return NextResponse.json({ success: false, error: blockErr.message }, { status: 500 })
  if (!block) return NextResponse.json({ success: false, error: 'Block not found' }, { status: 404 })

  const notHere = assertLocationAccessOr404(user, block.location_id)
  if (notHere) return notHere
  if (!hasRoleAtLocation(user, block.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // The people the picker offers: this studio's members, minus anyone already
  // live on the block. The reader keeps employees only.
  const { data: members, error: memberErr } = await db
    .from('profile_locations')
    .select('profile_id')
    .eq('location_id', block.location_id)
  if (memberErr) return NextResponse.json({ success: false, error: memberErr.message }, { status: 500 })
  const onBlock = new Set(liveAssignments(block.shift_assignments).map((a) => a.profile_id))
  const candidateIds = [...new Set((members || []).map((m) => m.profile_id).filter((id) => id && !onBlock.has(id)))]

  // The block's Mon-Sun week, one day either side: every rest gap and the
  // week total the candidate could touch.
  const monday = mondayOf(block.block_date)
  const wt = await loadWorkingTimeShifts(db, {
    locationId: block.location_id,
    profileIds: candidateIds,
    from: addDaysISO(monday, -1),
    to: addDaysISO(monday, 7),
  })

  const byProfile = {}
  if (!wt.error) {
    for (const profileId of candidateIds) {
      if (wt.people.get(profileId)?.employment_type !== EMPLOYEE_TYPE) continue
      const result = candidateWorkingTime(
        wt.shifts.filter((s) => s.profile_id === profileId),
        {
          profile_id: profileId,
          block_id: block.id,
          block_date: block.block_date,
          location_id: block.location_id,
          location_name: null,
          name: block.shift_templates?.name || 'Shift',
          start_time: block.start_time,
          end_time: block.end_time,
          shift_templates: block.shift_templates,
        },
        { hereLocationId: block.location_id },
      )
      if (result.restGap || result.weekHours) byProfile[profileId] = result
    }
  }

  return NextResponse.json({ success: true, data: { byProfile, checked: !wt.error && wt.crossStudioChecked !== false } })
}
```

In `src/lib/openapi.js`, after line 4488 (the `})` that closes the `/api/schedule/runway` registration), insert:

```js

registry.registerPath({
  method: 'get',
  path: '/api/schedule/working-time',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Working-time advisories for assigning one shift (manager-only)',
  description: "WORKTIME.1. For each employee (profiles.employment_type = 'fte') of the block's studio who is not already live on it: would assigning them leave under 11 hours between the end of one working day and the start of the next, or over 48 rostered hours in the block's Monday-to-Sunday week, counting their live shifts at every studio of the same organisation (effective window: override, then block, then template; Dublin wall clock as real time)? Advisory only; POST /api/schedule/blocks/{id}/assignments never consults it. byProfile lists only people with a flag: restGap { rest_minutes, side, other { block_id, date, start, end, name, location_name } } and weekHours { week_start, minutes }. Contractors are never listed. No names, rates, costs, contracted hours or employment type are returned. checked is false when the read failed or the organisation's other studios could not be read. Manager-only (master, owner, manager, head_coach AT the block's studio); an outsider gets 404.",
  request: { query: z.object({ block_id: uuidLike }) },
  responses: {
    200: { description: '{ byProfile: { [profileId]: { restGap, weekHours } }, checked }' },
    400: { description: 'Missing or malformed block_id', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: "Forbidden: needs a manager role at the block's studio", content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Block not found (or not at a studio the caller belongs to)', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'The block or membership read failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 4: Run it, expect PASS, and the route checks**

Run: `npx vitest run src/app/api/schedule/working-time/route.test.js src/lib/openapi.test.js && npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails && npm run check:select-columns`
Expected: `9 passed` plus the openapi file all passed; the four checks exit 0. `check:route-guards` sees `getCurrentUser`. `check:location-scoping` sees `assertLocationAccessOr404` and `.eq('location_id', …)`. The guardrails pass because `.maybeSingle()` destructures `error` and nothing parses a `…Z` date.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/working-time/route.js src/app/api/schedule/working-time/route.test.js src/lib/openapi.js
git commit -m "WORKTIME.1 — GET /api/schedule/working-time: per-candidate rest and week-hours advisory for one block

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The publish preview lists it

**Files:**
- Modify: `src/components/ScheduleCalendar.jsx`
- Create: `src/components/ScheduleCalendar.working-time.test.jsx`

A new `PublishWorkingTime` sits directly under `PublishRosterClashes`, in the same amber box recipe. It lists long weeks first, then short rests, and says when the check was incomplete. It never shows money. A new test file keeps this out of the conflict hotspot `ScheduleCalendar.visibility.test.jsx`.

- [ ] **Step 1: Write the failing test**

Create `src/components/ScheduleCalendar.working-time.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// WORKTIME.1 — the working-time advisory reaches both web surfaces: the
// publish preview's list and the assign picker's badges. The rules are pinned
// in shared/working-time.test.js, the read in src/lib/working-time-data.test.js
// and the route in src/app/api/schedule/working-time/route.test.js. This file is
// the wiring, and that both stay ADVISORY: Publish stays enabled and a flagged
// coach stays tickable. jsdom has no layout, so only text, roles and presence
// are asserted.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

// The preview waits up to 5s for the modal's dry run; the file's budget must
// sit above that (tests/test-timeout-budgets.test.js).
vi.setConfig({ testTimeout: 20000 })

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

const LOC = 'loc1'
const user = {
  id: 'u1', role: 'manager', profileRole: 'manager', rolesByLocation: { [LOC]: 'manager' },
  activeLocation: { id: LOC, name: 'Studio North' },
}

// Wednesday of the week the URL pins.
const targetBlock = {
  id: 'b-target', location_id: LOC, template_id: 't2', block_date: '2026-05-06',
  start_time: '10:00:00', end_time: '12:00:00', max_coaches: 3, min_coaches: 1,
  shift_templates: { id: 't2', name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [],
}

const staff = [
  { id: 'c-rest', full_name: 'Rest Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'c-week', full_name: 'Week Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'c-free', full_name: 'Free Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
]

const PICKER_ANSWER = {
  success: true,
  data: {
    checked: true,
    byProfile: {
      'c-rest': {
        restGap: { rest_minutes: 570, side: 'before', other: { block_id: 'x', date: '2026-05-05', start: '20:00', end: '21:30', name: 'Evening', location_name: 'Studio South' } },
        weekHours: null,
      },
      'c-week': { restGap: null, weekHours: { week_start: '2026-05-04', minutes: 2910 } },
    },
  },
}

const BASE_IMPACT = {
  blockCount: 1, periodProjectedEur: 0, monthProjectedTotalEur: 0, monthlyBudgetEur: null,
  overBudget: false, overrunEur: 0, months: [], staffingGaps: [],
  leaveClashes: [], doubleBookings: [], crossLocationChecked: true,
}
const WORKING_TIME = {
  checked: true,
  longWeeks: [{ profile_id: 'c-week', coach_name: 'Week Coach', week_start: '2026-05-04', minutes: 2910, shift_count: 6, studio_count: 2 }],
  restGaps: [{
    profile_id: 'c-rest', coach_name: 'Rest Coach', rest_minutes: 570,
    before: { block_id: 'x', date: '2026-05-05', start: '20:00', end: '21:30', name: 'Evening', location_name: 'Studio South' },
    after: { block_id: 'b-target', date: '2026-05-06', start: '07:00', end: '09:00', name: 'Early', location_name: null },
  }],
}

function okResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

function mockFetch({ picker = PICKER_ANSWER, pickerStatus = 200, impact = { ...BASE_IMPACT, workingTime: WORKING_TIME } } = {}) {
  return vi.fn(async (url, opts) => {
    const u = String(url)
    if (u.includes('/api/schedule/working-time')) return okResponse(picker, pickerStatus)
    if (u.includes('/schedule/rosters') && opts?.method === 'POST') return okResponse({ success: true, impact })
    if (u.includes('/schedule/blocks')) return okResponse({ success: true, data: [targetBlock] })
    if (u.includes('/api/staff')) return okResponse({ success: true, data: staff })
    return okResponse({ success: true, data: [] })
  })
}

async function openPublishPreview() {
  render(<ScheduleCalendar user={user} />)
  await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
  fireEvent.click(screen.getByText('Publish'))
  await screen.findByText('Blocks in period', {}, { timeout: 5000 })
}

beforeEach(() => { global.fetch = mockFetch() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('publish preview: working time (WORKTIME.1)', () => {
  it('lists long weeks and short rests with names, hours and the other studio, and Publish stays enabled', async () => {
    await openPublishPreview()
    const box = screen.getByTestId('publish-working-time')
    const text = box.textContent
    expect(text).toMatch(/1 employee over 48 hours in a week/)
    expect(text).toMatch(/Week Coach/)
    expect(text).toMatch(/48h 30m rostered/)
    expect(text).toMatch(/across 2 studios/)
    expect(text).toMatch(/1 rest under 11 hours between working days/)
    expect(text).toMatch(/Rest Coach/)
    expect(text).toMatch(/ends 9:30pm \(Studio South\)/)
    expect(text).toMatch(/starts 7am/)
    expect(text).toMatch(/9h 30m rest/)
    expect(text).not.toMatch(/€/)
    const publishButtons = screen.getAllByRole('button', { name: 'Publish' })
    expect(publishButtons[publishButtons.length - 1].disabled).toBe(false)
  })

  it('says so when the check could not be completed, rather than implying an all-clear', async () => {
    global.fetch = mockFetch({ impact: { ...BASE_IMPACT, workingTime: { restGaps: [], longWeeks: [], checked: false } } })
    await openPublishPreview()
    expect(screen.getByTestId('publish-working-time').textContent).toMatch(/The working-time check could not be completed\./)
  })

  it('renders nothing when there is nothing to say', async () => {
    global.fetch = mockFetch({ impact: { ...BASE_IMPACT, workingTime: { restGaps: [], longWeeks: [], checked: true } } })
    await openPublishPreview()
    expect(screen.queryByTestId('publish-working-time')).toBeNull()
  })

  it('renders nothing for an older server that does not send it', async () => {
    global.fetch = mockFetch({ impact: BASE_IMPACT })
    await openPublishPreview()
    expect(screen.queryByTestId('publish-working-time')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/ScheduleCalendar.working-time.test.jsx`
Expected: `2 failed | 2 passed`: the first two cannot find `publish-working-time`; the two "renders nothing" tests already hold.

- [ ] **Step 3: Minimal implementation**

In `src/components/ScheduleCalendar.jsx`:

1. After line 64 (`import { leaveClashesHeadline, leaveRangeLabel } from '@/lib/roster-publish-advisories'`), add:

```js
// WORKTIME.1 — working-time copy and limits (pure, unit-tested in shared/).
import { hoursMinutesLabel, longWeeksHeadline, restGapsHeadline, MIN_REST_HOURS, MAX_WEEK_HOURS } from '@shared/working-time'
```

2. In `PublishRosterModal`, directly after the `<PublishRosterClashes … />` element (closes on line 2034), add:

```jsx
            {/* WORKTIME.1 — employees over 48 hours in a week, or under 11
                hours between working days, every studio counted. Information
                only. */}
            <PublishWorkingTime workingTime={impact.workingTime} />
```

3. Directly above `function SwapModal` (line 2209), add:

```jsx
// WORKTIME.1 — from projectPublishImpact's `workingTime`. An older server that
// sends none renders nothing; `checked: false` says the check is incomplete
// instead of implying an all-clear. Names, dates, times and hours only.
function PublishWorkingTime({ workingTime }) {
  if (!workingTime || !Array.isArray(workingTime.restGaps) || !Array.isArray(workingTime.longWeeks)) return null
  const { restGaps, longWeeks } = workingTime
  const unchecked = workingTime.checked === false
  if (restGaps.length === 0 && longWeeks.length === 0 && !unchecked) return null
  const dayOf = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })
  const shortDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })
  const where = (s) => (s.location_name ? ` (${s.location_name})` : '')
  return (
    <div
      data-testid="publish-working-time"
      className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      {longWeeks.length > 0 && (
        <div>
          <div className="font-medium text-amber-700 flex items-center gap-1.5">
            <AlertTriangle size={14} aria-hidden="true" />
            {longWeeksHeadline(longWeeks)}
          </div>
          <ul className="mt-1.5 max-h-32 overflow-y-auto space-y-1">
            {longWeeks.map((w) => (
              <li key={`${w.profile_id}|${w.week_start}`} className="text-xs text-un1t-text">
                <span className="font-medium">{w.coach_name}</span> · week of {shortDay(w.week_start)} · {hoursMinutesLabel(w.minutes)} rostered
                {w.studio_count > 1 && <span className="text-un1t-subtle">, across {w.studio_count} studios</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {restGaps.length > 0 && (
        <div className={longWeeks.length > 0 ? 'mt-3' : ''}>
          <div className="font-medium text-amber-700 flex items-center gap-1.5">
            <AlertTriangle size={14} aria-hidden="true" />
            {restGapsHeadline(restGaps)}
          </div>
          <ul className="mt-1.5 max-h-32 overflow-y-auto space-y-1">
            {restGaps.map((g) => (
              <li key={`${g.profile_id}|${g.before.block_id}|${g.after.block_id}`} className="text-xs text-un1t-text">
                <span className="font-medium">{g.coach_name}</span> · {dayOf(g.before.date)} ends {formatTime(g.before.end)}{where(g.before)}, {dayOf(g.after.date)} starts {formatTime(g.after.start)}{where(g.after)}
                <span className="text-un1t-subtle"> · {hoursMinutesLabel(g.rest_minutes)} rest</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {unchecked && (
        <div className="text-xs text-un1t-subtle mt-2">The working-time check could not be completed.</div>
      )}
      <div className="text-xs text-un1t-subtle mt-2">
        Employees only, every studio counted: {MIN_REST_HOURS} hours between working days, {MAX_WEEK_HOURS} hours in a Monday to Sunday week. You can still publish.
      </div>
    </div>
  )
}
```

(`formatTime` is `formatTime12h` from line 60: `'21:30'` → `9:30pm`, `'07:00'` → `7am`. `AlertTriangle` is already imported on line 26.)

- [ ] **Step 4: Run it, expect PASS, plus the neighbouring preview tests**

Run: `npx vitest run src/components/ScheduleCalendar.working-time.test.jsx src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.publish-confirm.test.jsx`
Expected: all passed, 0 failed (`4 passed` in the new file).

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.working-time.test.jsx
git commit -m "WORKTIME.1 — publish preview lists long weeks and short rests, advisory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The assign picker badges it

**Files:**
- Modify: `src/components/ScheduleCalendar.jsx` (`AssignCoachModal`, lines 1671-1792)
- Modify: `src/components/ScheduleCalendar.working-time.test.jsx`

The picker asks the Task 7 route once per open, for this block. It shows `9h 30m rest` or `48h 30m this week` beside the name, in the same chip recipe as the clash badge (`:1758-1765`). The title names the other shift. The row stays tickable. A failed ask says so in one quiet line. An answer this screen does not recognise (an older server, or a test mock that answers everything with `data: []`) says nothing. When the coach list itself failed (`unavailableReason`) there is no list, so the picker does not ask.

- [ ] **Step 1: Write the failing test**

Append to `src/components/ScheduleCalendar.working-time.test.jsx`:

```jsx
async function openAssignPicker() {
  render(<ScheduleCalendar user={user} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Manage 10am Midday Strength shift/ }))
  await waitFor(() => expect(screen.getByText('Add coach')).toBeTruthy())
  fireEvent.click(screen.getByText('Add coach'))
  await waitFor(() => expect(screen.getByText('Pick one or more coaches')).toBeTruthy())
}

describe('assign picker: working time (WORKTIME.1)', () => {
  it('badges an employee this shift would leave short of rest, naming the other shift in its title', async () => {
    await openAssignPicker()
    const badge = await screen.findByText('9h 30m rest')
    expect(badge.closest('li').textContent).toMatch(/Rest Coach/)
    expect(badge.getAttribute('title')).toMatch(/Evening 8pm–9:30pm at Studio South/)
    expect(badge.getAttribute('title')).toMatch(/11 hours between working days/)
  })

  it('badges an employee this shift would take over 48 hours in the week', async () => {
    await openAssignPicker()
    const badge = await screen.findByText('48h 30m this week')
    expect(badge.closest('li').textContent).toMatch(/Week Coach/)
    expect(badge.getAttribute('title')).toMatch(/over the 48-hour limit/)
  })

  it('asks once, for this block, and says nothing about a free coach', async () => {
    await openAssignPicker()
    await screen.findByText('9h 30m rest')
    const asks = global.fetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/api/schedule/working-time'))
    expect(asks).toEqual(['/api/schedule/working-time?block_id=b-target'])
    expect(screen.getByText('Free Coach').closest('li').textContent).not.toMatch(/ rest|this week/)
  })

  it('is advisory: a flagged coach can still be ticked', async () => {
    await openAssignPicker()
    const badge = await screen.findByText('9h 30m rest')
    const checkbox = badge.closest('label').querySelector('input[type="checkbox"]')
    expect(checkbox.disabled).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    expect(screen.getByText('Assign 1 coach')).toBeTruthy()
  })

  it('a failed check says so and badges nobody', async () => {
    global.fetch = mockFetch({ picker: { success: false, error: 'boom' }, pickerStatus: 500 })
    await openAssignPicker()
    expect(await screen.findByText('Rest and weekly-hours check could not be completed.')).toBeTruthy()
    expect(screen.queryByText('9h 30m rest')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/ScheduleCalendar.working-time.test.jsx`
Expected: `5 failed | 4 passed`: the badges and the note never appear (`findByText` times out), and the ask list is `[]`.

- [ ] **Step 3: Minimal implementation**

In `AssignCoachModal` (`src/components/ScheduleCalendar.jsx`):

1. After `const slotsLeft = …` (line 1679), add:

```jsx
  // WORKTIME.1 — would assigning this coach leave an EMPLOYEE under 11 hours
  // between working days, or over 48 hours in the week, counting every studio
  // of the organisation? Asked once per open. Advisory, like the clash badge.
  // A failed ask says so; an answer this screen does not recognise (an older
  // server) says nothing. No list (the coach list failed) = nothing to ask.
  const [workingTime, setWorkingTime] = useState({ byProfile: {}, failed: false })
  useEffect(() => {
    if (unavailableReason) return undefined
    let cancelled = false
    async function loadWorkingTime() {
      let res = null
      let json = null
      try {
        res = await fetch(`/api/schedule/working-time?block_id=${encodeURIComponent(block.id)}`)
        json = await res.json()
      } catch {
        json = null
      }
      if (cancelled) return
      if (!res?.ok || !json || json.success === false) {
        setWorkingTime({ byProfile: {}, failed: true })
        return
      }
      const by = json.data?.byProfile
      setWorkingTime({
        byProfile: by && typeof by === 'object' && !Array.isArray(by) ? by : {},
        failed: json.data?.checked === false,
      })
    }
    loadWorkingTime()
    return () => { cancelled = true }
  }, [block.id, unavailableReason])
  const wtDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })
  function restGapTitle(g) {
    const o = g.other || {}
    const where = o.location_name ? ` at ${o.location_name}` : ''
    return `Only ${hoursMinutesLabel(g.rest_minutes)} between this shift and ${o.name || 'another shift'} ${formatTime(o.start)}–${formatTime(o.end)}${where} on ${wtDay(o.date)}. Employees need ${MIN_REST_HOURS} hours between working days.`
  }
```

2. After the `leaveMissing` note (lines 1725-1727), add:

```jsx
          {!unavailableReason && workingTime.failed && (
            <p className="mb-2 text-[11px] text-un1t-subtle">Rest and weekly-hours check could not be completed.</p>
          )}
```

3. Inside `available.map`, after the `coachConflictsForBlock(…)` destructure (ends line 1741), add:

```jsx
                const wt = workingTime.byProfile[s.id]
```

4. After the clash badge's closing `)}` (line 1765), still inside the name `<span>`, add:

```jsx
                        {/* WORKTIME.1 — employees only (the route never lists
                            a contractor); advisory, the row stays tickable. */}
                        {wt?.restGap && (
                          <span
                            className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 whitespace-nowrap"
                            title={restGapTitle(wt.restGap)}
                          >
                            {hoursMinutesLabel(wt.restGap.rest_minutes)} rest
                          </span>
                        )}
                        {wt?.weekHours && (
                          <span
                            className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 whitespace-nowrap"
                            title={`Assigning this shift brings their week to ${hoursMinutesLabel(wt.weekHours.minutes)} across every studio, over the ${MAX_WEEK_HOURS}-hour limit.`}
                          >
                            {hoursMinutesLabel(wt.weekHours.minutes)} this week
                          </span>
                        )}
```

- [ ] **Step 4: Run it, expect PASS, plus every calendar test that opens the picker**

Run: `npx vitest run src/components/ScheduleCalendar.working-time.test.jsx src/components/ScheduleCalendar.assign-conflicts.test.jsx src/components/ScheduleCalendar.partial-load.test.jsx src/components/ScheduleCalendar.a11y.test.jsx src/components/ScheduleCalendar.errors.test.jsx`
Expected: all passed, 0 failed (`9 passed` in the new file). The older files' mocks answer the new URL with `{ success: true, data: [] }`. That is an unrecognised shape, so they get no badge and no note.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.working-time.test.jsx
git commit -m "WORKTIME.1 — assign picker badges short rest and long weeks, advisory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

- [ ] **Focused tests, both timezones:**

```bash
for tz in Europe/Dublin America/Los_Angeles; do
  TZ=$tz npx vitest run shared/working-time.test.js src/lib/working-time-data.test.js src/lib/roster-publish.test.js src/app/api/schedule/working-time/route.test.js src/components/ScheduleCalendar.working-time.test.jsx || break
done
npx vitest run tests/shared-pair-sync.test.js tests/ota-trigger-paths.test.js tests/staff-tombstone-readers.test.js tests/rtl-cleanup-after-each.test.js tests/test-timeout-budgets.test.js src/lib/openapi.test.js src/app/api/schedule/rosters/route.test.js
```

Expected: all passed, both timezones. `staff-tombstone-readers` accepts the new `profiles` read because it is filtered `.in('id', …)`.

- [ ] **CI mirror (all twelve), then the build:**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
npm run build
```

Expected: every command exits 0. `check:ota-paths` passes: nothing new at the top level of `mobile/`, and `shared/working-time.js` sits inside the wholesale `shared/**`, **which means the merge publishes an OTA**. `npm run build` resolves `@shared/working-time` from the route, the lib and the client component. That import resolution is the one thing only the build proves. On the 8GB machine, run the build with nothing else running. If it is too slow, push and let the required **Next build** check be the gate. Never skip both.

- [ ] **Open the PR.** Title: `WORKTIME.1 — working-time advisories: 11 hours' rest and 48 hours a week, employees, both studios`. The body must state:
  - No migration.
  - **The merge publishes an OTA** because `shared/**` is a wholesale trigger. No phone screen changes in this PR; the phone uses the module in CANDIDATES.1. If SHIFTTYPE.1 merged just before, its EAS Update run must be green first.
  - Employees only (`employment_type = 'fte'`, mig 070); contractors are never flagged; no pay column is selected anywhere (profiles read for `id, full_name, employment_type`; `profile_compensation` not read).
  - Rest is measured between working days, not every pair of shifts, and why (split shifts). The week is per rostered week, not the four-month average (program default 3).
  - Dublin wall clock is converted to real instants; the two DST nights are tested.
  - Both studios means this studio's organisation only (`siblingLocationIds`); a row from another organisation is dropped even if returned.
  - Cost: four fixed reads per preview dry run, none on a real publish or approve. One GET per picker open.
  - Advisory only: nothing blocks an assign or a publish; tests pin Publish enabled and the flagged row tickable.
  - The new route and its gate (manager AT the block's studio, 404 for an outsider).
  - End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Verify on the Vercel PREVIEW** (prod data; local dev has no database). As a manager of Stillorgan, open `/schedule` and open **Publish** for a week. The dry run is a POST that writes nothing: it returns at `src/app/api/schedule/rosters/route.js:246` before any insert. **Do not press the confirm button.** Expect the working-time box only if someone is actually over, or the "could not be completed" line if a read fails. Open a shift → **Add coach**: expect badges only on employees who would breach. `GET /api/schedule/working-time?block_id=<a Hatch Street block id>` as a Stillorgan-only manager: 404. As a coach: 403.

- [ ] **CHANGELOG.** After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md` (never edit another row), then commit and push:

```
| #<PR> | WORKTIME.1 — working-time advisories: 11 hours' rest and 48 hours a week, employees, both studios | 2026-09-2x. No migration, **OTA (no-op: `shared/**` trigger; the phone uses it in CANDIDATES.1)**. New pure `shared/working-time.js`: `restGapViolations` (under 11 real hours from a working day's last end to the next working day's first start; split shifts inside a day never flag), `weekHoursOver` (over 48 real hours in a Mon-Sun week by block_date; per rostered week, not the Act's four-month average), `workingTimeAdvisories` (publish list: employees only, this studio's period, one side here), `candidateWorkingTime` (picker: what adding this shift would create). Effective window override → block → template; Dublin wall clock → real instants via Intl (both DST nights tested). Reader `src/lib/working-time-data.js`: this studio + `siblingLocationIds` only (other organisations dropped even if returned), `profiles(id, full_name, employment_type)` only, contractors' shifts never read, paged, never throws. Publish preview (`projectPublishImpact`, dry run only) gains `workingTime { restGaps, longWeeks, checked }`: one reader call, fails soft, never gates. New `GET /api/schedule/working-time?block_id=` (manager AT the block's studio, 404 outsider) feeds picker badges `Xh Ym rest` / `Xh Ym this week`; rows stay tickable. Hours only, never pay. |
```

- [ ] **After merge:** check the EAS Update run for this merge went green before the next phone update merges (program rule). Nothing else to watch: no cron, no migration.

---

### Review notes / open questions

1. **Four-month average, simplified (program default 3, REVIEW).** The Act's 48 hours is an average over a four-month reference period (six for some sectors). This checks each rostered Monday to Sunday week on its own. So it flags a single 50-hour week that a real average would allow, and it misses nothing the average would catch. For an advisory, that errs on the safe side. A rolling 17-week average would need ~4 months of past assignments per person per preview (paged, bigger), and past rows carry geofence ARRIVAL overrides, not rostered times. If Richard wants the average, it is a second function over a longer read, not a change to this one.
2. **Rest is measured between working days, not between every pair of shifts.** A coach doing 06:30-08:00 and 18:00-21:00 on the same day has a 10-hour gap that is not flagged. The Act's daily rest is 11 CONSECUTIVE hours in each 24, and the overnight gap supplies it. Flagging every intra-day gap would put a badge on nearly every split-shift coach and teach managers to ignore it. The literal brief ("between the end of one shift and the start of the next") would flag those. Confirm the reading. Weekly rest (24 hours in each 7 days, or 48 in 14) is **not** checked. It is a candidate third rule.
3. **Drafts at the other studio count.** Any live assignment counts, published or not, the same as `doubleBookings`. A half-built draft week at Hatch Street can produce a flag on Stillorgan's publish. The alternative (published only elsewhere) would hide a real clash until Hatch publishes. Kept consistent with the double-booking check.
4. **Approved leave is not subtracted.** A coach rostered on a day off still counts those hours. The same preview already lists that shift under "rostered on approved leave". Subtracting it would need the leave rows in this rule too. Cheap to add if the double-listing proves noisy.
5. **Real elapsed time vs payroll's wall clock.** Week totals use real time, so a shift spanning 01:00-02:00 on a clock-change night is an hour longer or shorter than payroll's `shiftHours` says. No gym shift does that today. Everything else is identical.
6. **An overnight shift** (impossible today) belongs wholly to its `block_date` week, even the hours after midnight on a Sunday. Revisit if overnight templates ever exist.
7. **Surfaces not covered here.** The bulk-assign bar (`src/components/ScheduleCalendar.jsx` select mode, ~line 1567) and the copy-week or copy-month flows get no badge. Their result shows up in the next publish preview. The phone's Manage-mode picker is CANDIDATES.1 (PR 19), which reuses `candidateWorkingTime` and the Task 7 route or reader.
8. **OTA for a web-only change.** `shared/**` publishes on merge whatever is inside. The alternative is `src/lib/working-time.js` now, moved to `shared/` in PR 19. That would avoid a no-op OTA today but costs a file move and a pair-sync classification later. Recommended: keep `shared/` as planned (the index already records "yes (shared)").
9. **Cross-studio visibility.** A Stillorgan manager sees a coach's Hatch Street shift name, times and studio in both surfaces. `doubleBookings` already shows this, and it stays inside one organisation (ORGSCOPE.1). The picker route returns no names, only shift details for people the manager can already see at their studio.
10. **`employment_type` values.** Only `'fte'` is covered. `location_role_permissions.employment_type` allows `'casual'` (mig 367), but `profiles.employment_type` does not (mig 070 CHECK). If a casual employee type is ever added to profiles, decide whether the Act covers them (it does, for employees) and extend `EMPLOYEE_TYPE`.
11. **Arrival overrides.** Geofence stamps an early arrival into `start_time_override` (memory `rostering-review-2026-09-16`). For past days in the week, that makes the hours the ARRIVED window, which is the paid one and arguably the truer "working time". It can move a past-day rest gap by up to 45 minutes. No change proposed.
