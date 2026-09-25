## PR GRID.1 — a coach-by-day grid in the manager's week view: both studios summed, contract and admin balance, leave, availability and working-time flags

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this section task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager looking at a week in `/schedule` can switch the layout from **Days** (today's day-column cards, still the default) to **Coaches**: one row per coach at the studio, seven day columns (Mon to Sun). Each cell lists that coach's shifts at THIS studio as buttons that open the existing block dialog, plus a muted marker for shifts at the organisation's OTHER studios. Approved leave and declared unavailability sit in the cell. Each row carries the week total (effective hours, every studio of the organisation), the contract (employees) and the **admin balance** (contract minus class hours minus placed admin hours, employees with a contract only). The row also carries the WORKTIME advisories (over 48 hours in the week, under 11 hours between working days). Hours only, never pay. Read-only: no drag-and-drop.

**Why:** The 19 Sep product review and Richard's HYBRID roster decision. Only admin work that needs a time and a person is placed. The rest of an employee's contract is an unplaced admin balance, and today nothing shows it. The day-column cards answer "who is on at 9am Tuesday". They cannot answer "how much of Alex's 39 hours is placed, and where". The ROSTER LOOK decision keeps the day cards; this grid is an ADDITIONAL view.

**Ships:** web only. **No migration. No OTA** (nothing under `mobile/` or `shared/` changes). One new read route, `GET /api/schedule/grid`.

**Decisions (each pinned by a test below):**

- **Data: ONE new server read for the shifts, and the leave, availability and holidays the calendar already holds.** Compose-only is impossible. The browser holds only THIS studio's blocks (`useScheduleData`, `src/components/schedule/useScheduleData.js:247`). The other studios' shifts and the day either side of the week (a rest gap reaches over midnight) are not on screen. A per-studio blocks read of a sibling studio is also the wrong boundary: the manager may not belong to it (`assertLocationAccess` 403), and ORGSCOPE.1 says "another studio" means another studio of THIS organisation (`src/lib/sibling-locations.js:19`). So `GET /api/schedule/grid?location_id=&start_date=` returns, in one round trip, the grid's people and every live shift they have from the Sunday before to the Monday after, at this studio and its sibling studios. It is ONE consistent snapshot: totals, balances and advisories never mix two reads taken at different moments. It is re-read after every roster mutation, the way `useWeekCost` is (`src/components/ScheduleCalendar.jsx:483`). Leave (`timeOff`), availability (`availability`, AVAIL.1b) and bank holidays are person-level or studio-level slices the calendar has already loaded for exactly this week. They are reused, not re-read.
- **Cost.** Server side: three reads in parallel (the team, this studio's shifts paged at 1,000, and the two small `locations` reads inside `siblingLocationIds`), then `profiles` (chunked by 200 ids), then the other studios' shifts for the grid's people (paged, chunked). The estate today is 15 live profiles and roughly 150 assignments a week across both studios: one page per read. Client side: the request is made **only while the grid is on screen** (manager, week view, Coaches). A Days viewer pays nothing.
- **Who gets a row.** The studio's team: `profile_locations` at the studio, `profiles.active IS NOT FALSE` and not tombstoned (mig 626's predicate, as `readStudioAvailability` uses in AVAIL.1a). **Plus** anyone holding a live shift at this studio that week who is no longer on the team (deactivated, moved, or a tombstone keeping history). Those rows are marked "Not on this studio's team now". So the grid never loses a shift the Days view shows. The team is ordered by name, the extras last.
- **Which shifts count.** Live assignments (`isLiveAssignment`, `src/lib/roster.js:440`), published or draft. That is what a manager's Days view shows, and what `doubleBookings` and WORKTIME count. The week is Mon to Sun by `block_date`. The Sunday before and the Monday after are read for rest gaps only, never shown or totalled.
- **Hours are the EFFECTIVE window, in real time.** Override, then block, then template, through `workingWindow` (`shared/working-time.js`, WORKTIME.1). Minutes are real elapsed time. That is identical to wall-clock hours except for a shift spanning 01:00-02:00 on a clock-change night, where it is the true length (same choice as the 48-hour rule). A shift with no usable times is shown ("No times"), not counted, and named.
- **Contracted hours: `profiles.contracted_hours_per_week`, selected by NAME, employees only.** Checked on 25 Sep, and this is the trap the brief asked about. Mig 152 moved the column's canonical copy to `profile_compensation` (master/owner-only RLS). Mig 153/153b REVOKEd SELECT on the `profiles` copy from `authenticated`/`anon` and commented it "DEPRECATED … To be dropped in phase 3". Both copies are still written together: `src/app/api/staff/route.js:216,257`, `src/lib/staff-write.js:217-240`. Every roster reader uses the `profiles` copy: `STAFF_PICKER_FIELDS` (`src/lib/staff.js:25-26`, shipped to every role since ROSTER-FIX.6c as "not pay data"), the Weekly hours notice (`src/lib/roster-week-cost.js`), `roster-summary-server.js` and payroll. A read-only aggregate on prod (25 Sep) found 15 non-deleted profiles with **zero drift** between the two copies: 8 active FTE all set, 6 contractors null. The grid therefore reads the **same copy as the Weekly hours notice on the same screen**, so one screen never shows two contracts for one person. The route selects `id, full_name, active, deleted_at, employment_type, contracted_hours_per_week`, never a rate. `profile_compensation` is not read. The route returns `contracted_hours` only for `employment_type = 'fte'` (`EMPLOYEE_TYPE`), and `null` for anyone else, even if the column holds mig 012's old default of 40. The phase-3 drop must move all these readers together; `check:select-columns` will fail loudly on this one if it is forgotten. See Review notes 1.
- **Admin balance (program default 4, REVIEW): `contract − class minutes − placed admin minutes`**, both studios, **employees with a contract only**, as hours. By construction that is `contract − week total`. It is shown split in the title ("39h contract − 7h class − 1h 30m placed admin = 30h 30m to place"). States: above 0 "to place"; 0 "contract met"; below 0 **over contract, displayed `−1h 30m`** in amber with the words "1h 30m over contract" for a screen reader. No contract (FTE with null or 0 hours): "No contract hours". A contractor: "Contractor". An unreadable type: "—". **Approved leave is not deducted** (the default's literal formula). A row with leave that week says so in the title. See Review notes 2.
- **Leave and availability overlay.** Leave: `dayLeaveBars` (`src/lib/roster-card-model.js:313`), one per person per day with the most specific type, exactly as the Days view. Unavailability: `unavailableFor` / `unavailableSummary` / `describeRule` from `shared/availability.js` (AVAIL.1a). As in the Days view (AVAIL.1b), leave wins over unavailability on the same day. A shift chip on a leave day, or overlapping an unavailable window, gets a small advisory word. A shift touching a window does not (AVAIL's strict overlap).
- **Working-time flags.** `workingTimeAdvisories` (WORKTIME.1) over the grid's shifts, with the same `people` Map shape `roster-publish.js:476` passes. Employees only (the helper filters). Both studios. `todayIso: null`, so a past week also shows its flags: this is a view, not a publish gate. A row shows `51h week` and/or the shortest `8h rest`, with the full ends in the title.
- **"Checked" is honest.** If the sibling studios, or the other studios' shifts, could not be read, the route says `cross_studio_checked: false`. The grid then says "The other studios could not be read, so week totals, balances and working-time flags count this studio only". A failed team, profiles or this-studio read is a 500, never an empty grid.
- **Read-only.** A chip at this studio is a `<button type="button">` that opens the same `BlockDetailModal` the day cards open (`setBlockDetail`). In select mode it toggles selection, as a card does (`src/components/ScheduleCalendar.jsx:1349-1353`). A marker for another studio is not a control. **No drag-and-drop** (briefed as not recommended; see Review notes 8).
- **Toggle "Days | Coaches".** A second segmented control after Week | Month, shown to a manager in week view only (`rosterToolbarModel().showLayoutToggle`). Month view has no Coaches layout. Returning to week brings the chosen layout back. It is persisted **per viewer** in `localStorage` under `un1t.schedule.layout.<user.id>`, every access in try/catch. It is read after mount, never in the `useState` initialiser: the server render has no storage, and a different first client render is a hydration mismatch. Cost: one Days paint before the grid on a reload (a browser check).
- **My shifts | All staff** still means something in the grid. "My shifts" shows only the viewer's row.
- **Pure model, thin UI.** Every decision is in `src/lib/roster-grid-model.js` (pure, tested under two host timezones). `RosterGrid.jsx` lays it out. jsdom cannot see layout (memory `jsdom-cannot-see-layout`). Sticky column, scroll and widths are browser checks in the PR body, not tests.

**Prerequisites (hard):**

1. **AVAIL.1a and AVAIL.1b merged to `main`.** The model imports `shared/availability.js`, and the calendar passes AVAIL.1b's `availability` slice and `availabilityMissing`. Neither exists on `main` at `d11e6971`: they live on `avail-1a` / `avail-1b` (`~/code/un1t-crm-avail1a`, `-avail1b`). SHIFTTYPE.1 (#1759) and WORKTIME.1 (#1758) are merged. Batch-6 neighbour REPLACE.1 also edits `src/components/ScheduleCalendar.jsx`: whichever merges second rebases.
2. A fresh worktree off `origin/main`: `git fetch origin main && git worktree add ../un1t-crm-grid1 -b grid-1 origin/main`, then `npm ci` once.
3. **Verify the names this plan imports exist on `main` before Task 1**, and adapt the CALL if a merged signature differs. Never adapt the shared module:

```bash
grep -nE "^export (const|function) (workingWindow|workingTimeAdvisories|hoursMinutesLabel|EMPLOYEE_TYPE|MAX_WEEK_HOURS|MIN_REST_HOURS)\b" shared/working-time.js
grep -nE "^export function (unavailableFor|unavailableSummary|describeRule)\b" shared/availability.js
grep -nE "^export function shiftKindOf\b" shared/shift-kind.js
grep -n "canReadAvailability\|availabilityMissing" src/components/ScheduleCalendar.jsx | head -3
```

Expected: 6 + 3 + 1 lines, and the calendar lines present. What this plan relies on for the working-time module (confirmed from `main`'s own call sites): `workingTimeAdvisories(shifts, { people: Map, hereLocationId, from, to, todayIso })` → `{ restGaps, longWeeks, untimed }` (`src/lib/roster-publish.js:476-479`); restGap items `{ profile_id, rest_minutes, before{date,end,location_name}, after{date,start,location_name} }` and longWeek items `{ profile_id, week_start, minutes }` (`src/components/ScheduleCalendar.jsx:2289-2340`); `workingWindow(row)` → `{ start, end, startMs, endMs, … }` or null (WORKTIME plan, Task 1).

Tests: `npx vitest run <file>`. Date code runs twice: `TZ=Europe/Dublin` and `TZ=America/Los_Angeles`. This PR adds a route, a page-level import graph and new imports, which only `next build` proves, so the gate runs `npm run build`.

**Files:** (line numbers are `origin/main` at `d11e6971`. AVAIL.1b, BLOCKEDIT.1 and REPLACE.1 move the calendar's lines, so find each anchor by the quoted text.)

| File | Responsibility |
|---|---|
| `src/lib/roster-grid-model.js` (create) | pure: `gridWeekDays`, layout preference (`loadRosterLayout`/`saveRosterLayout`, injected storage), `buildRosterGrid`, `adminBalanceLabel`, `restGapTitle`, `untimedLabel`, `GRID_COPY` |
| `src/lib/roster-grid-model.test.js` (create) | row totals across studios, balance math, overlays, advisories, both DST weeks |
| `src/lib/roster-grid-data.js` (create) | `loadRosterGrid(db, { locationId, weekStart })`: the one server read; org-scoped; paged; named columns; never throws |
| `src/lib/roster-grid-data.test.js` (create) | who gets a row, the boundary, no pay column, degrade vs fail, paging |
| `src/app/api/schedule/grid/route.js` (create) | `GET`: manager AT `location_id`, `realIsoDate`, snaps to Monday |
| `src/app/api/schedule/grid/route.test.js` (create) | gate, 400s, shape, no pay words, 500 |
| `src/lib/openapi.js` (modify: insert after line 4593, the `})` closing `/api/schedule/working-time`) | register the route |
| `src/lib/openapi.test.js` (modify: insert before line 341, `it('declares webhook + bridge auth schemes'`) | the route is documented |
| `src/components/schedule/useRosterGrid.js` (create) | the grid's read (generation guard, keep-on-refresh-failure), `browserStorage()` |
| `src/components/schedule/useRosterGrid.test.js` (create) | fires only when enabled, stale-loser drop, keep vs clear |
| `src/lib/roster-card-model.js` (modify: `rosterToolbarModel` lines 257-285) | `showLayoutToggle` |
| `src/lib/roster-card-model.test.js` (modify: inside `describe('rosterToolbarModel')`, before its closing `})` at line 330) | the rule |
| `src/components/schedule/RosterToolbar.jsx` (modify: import line 30, props lines 44-48, insert after line 93) | the Days \| Coaches control |
| `src/components/schedule/RosterToolbar.test.jsx` (modify: append before the final `})`, line 154) | its wiring |
| `src/components/schedule/RosterGrid.jsx` (create) | the table |
| `src/components/schedule/RosterGrid.test.jsx` (create) | what reaches the DOM (no layout claims) |
| `src/components/ScheduleCalendar.jsx` (modify: imports after line 85; state after line 200; hooks after line 425; `refreshAfterMutation` lines 479-494; before `const toolbarModel` line 995; `<RosterToolbar` lines 1038-1054; the week branch opener `) : (` line 1241) | wiring |
| `src/components/ScheduleCalendar.grid.test.jsx` (create) | the layout switch, persistence, the dialog, the coach boundary |
| `docs/CHANGELOG.md` (modify) | one row, added after `gh pr create` |

**Naming traps:** `tests/shared-pair-sync.test.js` makes you classify an export NAME shared by `shared/` and `src/lib/`. Before Task 1, run:

```bash
grep -rnE "export (const|function|async function) (ROSTER_LAYOUTS|DEFAULT_ROSTER_LAYOUT|rosterLayoutStorageKey|loadRosterLayout|saveRosterLayout|gridWeekDays|buildRosterGrid|adminBalanceLabel|restGapTitle|untimedLabel|GRID_COPY|loadRosterGrid|useRosterGrid|browserStorage)\b" shared src mobile/lib
```

Expected: no output. The date helpers inside the model stay private (`addDaysISO` and `mondayOf` are already exported from `src/lib`).

---

### Task 1: the week's days and the layout preference

**Files:**
- Create: `src/lib/roster-grid-model.js`
- Create: `src/lib/roster-grid-model.test.js`

The test file imports every name Tasks 2-5 add. Until those land, the missing names are `undefined`, which is harmless because nothing in this task calls them.

- [ ] **Step 1: Write the failing test**

Create `src/lib/roster-grid-model.test.js`:

```js
// src/lib/roster-grid-model.test.js
// GRID.1 — every decision the coach-by-day grid makes, pure. Run under
// TZ=Europe/Dublin AND America/Los_Angeles: no day, total or balance may move
// with the host's clock.

import { describe, it, expect } from 'vitest'
import {
  ROSTER_LAYOUTS, DEFAULT_ROSTER_LAYOUT, rosterLayoutStorageKey, loadRosterLayout, saveRosterLayout,
  gridWeekDays, buildRosterGrid, adminBalanceLabel, restGapTitle, untimedLabel, GRID_COPY,
} from './roster-grid-model'

const HERE = 'loc-north'
const SOUTH = 'loc-south'
const WEEK = '2026-09-21' // a Monday

// One shift in GET /api/schedule/grid's flat shape.
const S = (profile_id, block_date, start_time, end_time, over = {}) => ({
  assignment_id: `${profile_id}-${block_date}-${start_time}`,
  profile_id,
  block_id: `b-${profile_id}-${block_date}-${start_time}`,
  block_date,
  location_id: HERE,
  location_name: 'Studio North',
  here: true,
  kind: 'class',
  name: 'Strength',
  status: 'scheduled',
  start_time,
  end_time,
  start_time_override: null,
  end_time_override: null,
  shift_templates: { start_time, end_time },
  ...over,
})
const SOUTH_SHIFT = { location_id: SOUTH, location_name: 'Studio South', here: false }
const M = (profile_id, full_name, employment_type, contracted_hours, over = {}) => ({
  profile_id, full_name, employment_type, contracted_hours, member: true, ...over,
})

// The main fixture (Tasks 2-4). Every sum is worked out in the test that uses it.
const MEMBERS = [
  M('p-emp', 'Alex Example', 'fte', 39),
  M('p-con', 'Jordan Sample', 'contractor', null),
  M('p-over', 'Max Beta', 'fte', 1),
  M('p-nocon', 'Sam Demo', 'fte', null),
  M('p-gone', 'Toby Beta', 'fte', 20, { member: false }),
]
const SHIFTS = [
  S('p-emp', '2026-09-21', '09:00:00', '12:00:00'),
  S('p-emp', '2026-09-21', '06:30:00', '07:30:00'),
  S('p-emp', '2026-09-22', '18:00:00', '20:00:00', { ...SOUTH_SHIFT, name: 'Evening' }),
  S('p-emp', '2026-09-23', '13:00:00', '14:30:00', { kind: 'admin', name: 'Front desk' }),
  S('p-emp', '2026-09-25', '12:00:00', '13:00:00'),
  S('p-emp', '2026-09-20', '10:00:00', '11:00:00'), // the Sunday before: rest gaps only
  S('p-emp', '2026-09-28', '10:00:00', '11:00:00'), // the Monday after: likewise
  S('p-emp', '2026-09-24', '09:00:00', '10:00:00', { status: 'cancelled' }),
  S('p-con', '2026-09-24', '17:00:00', '18:00:00'),
  S('p-over', '2026-09-25', '06:00:00', '07:30:00'),
  S('p-nocon', '2026-09-24', '07:00:00', '08:00:00'),
  S('p-nocon', '2026-09-26', null, null),
  S('p-gone', '2026-09-22', '10:00:00', '11:00:00'),
]
const GRID = { week_start: WEEK, week_end: '2026-09-27', members: MEMBERS, shifts: SHIFTS, cross_studio_checked: true }
const rowOf = (model, id) => model.rows.find((r) => r.profile_id === id)

describe('gridWeekDays', () => {
  it('is the Monday-to-Sunday week holding any day of it', () => {
    const week = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']
    expect(gridWeekDays('2026-09-24')).toEqual(week)
    expect(gridWeekDays('2026-09-21')).toEqual(week)
    expect(gridWeekDays('2026-09-27')).toEqual(week)
  })

  it('crosses a month and a year end', () => {
    expect(gridWeekDays('2026-12-31')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03'])
  })

  it('has seven days in both clock-change weeks (Sun 29 Mar and Sun 25 Oct 2026)', () => {
    expect(gridWeekDays('2026-03-29')).toEqual(['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29'])
    expect(gridWeekDays('2026-10-25')).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'])
  })

  it('is empty for a date the calendar does not have', () => {
    expect(gridWeekDays('2026-02-30')).toEqual([])
    expect(gridWeekDays('24/09/2026')).toEqual([])
    expect(gridWeekDays(null)).toEqual([])
  })
})

describe('roster layout preference', () => {
  const store = () => {
    const m = new Map()
    return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) } }
  }

  it('is kept per viewer', () => {
    expect(rosterLayoutStorageKey('u1')).toBe('un1t.schedule.layout.u1')
    expect(rosterLayoutStorageKey(null)).toBe('un1t.schedule.layout.anon')
  })

  it('is Days when nothing, or junk, is stored, or there is no storage at all', () => {
    const s = store()
    expect(loadRosterLayout(s, 'u1')).toBe('days')
    s.setItem('un1t.schedule.layout.u1', 'month')
    expect(loadRosterLayout(s, 'u1')).toBe('days')
    expect(loadRosterLayout(null, 'u1')).toBe('days')
    expect(DEFAULT_ROSTER_LAYOUT).toBe('days')
    expect(ROSTER_LAYOUTS).toEqual(['days', 'coaches'])
  })

  it('reads back what was saved, for that viewer only', () => {
    const s = store()
    expect(saveRosterLayout(s, 'u1', 'coaches')).toBe(true)
    expect(loadRosterLayout(s, 'u1')).toBe('coaches')
    expect(loadRosterLayout(s, 'u2')).toBe('days')
  })

  it('never throws: storage that refuses reads is Days, and a refused save answers false', () => {
    const refusing = {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceededError') },
    }
    expect(loadRosterLayout(refusing, 'u1')).toBe('days')
    expect(saveRosterLayout(refusing, 'u1', 'coaches')).toBe(false)
    expect(saveRosterLayout(null, 'u1', 'coaches')).toBe(false)
  })

  it('refuses to save a layout that does not exist', () => {
    const s = store()
    expect(saveRosterLayout(s, 'u1', 'month')).toBe(false)
    expect(s.m.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-grid-model.test.js`
Expected: `Test Files 1 failed`, `Failed to resolve import "./roster-grid-model"`.

- [ ] **Step 3: Minimal implementation**

Create `src/lib/roster-grid-model.js`:

```js
// src/lib/roster-grid-model.js
//
// GRID.1 — the manager's coach-by-day grid (Schedule → Week → Coaches), as
// pure data. RosterGrid.jsx lays out what this decides; every decision is
// here because jsdom cannot see layout and a component test can only say
// "this text is present".
//
// Richard, 25 Sep 2026 (scheduler Wave 2 index): the roster is HYBRID. Only
// admin work that needs a time and a person is placed. The rest of an
// employee's contract is an unplaced ADMIN BALANCE, shown to managers as hours
// (program default 4): contract − class hours − placed admin hours, employees
// only, never pay. The ROSTER LOOK decision keeps the day-column cards; this
// grid is an ADDITIONAL view.
//
// No clock, no network, no host timezone. Dates are 'YYYY-MM-DD' strings and
// all day arithmetic is Date.UTC, so a 23h or 25h day cannot move a column.

export const ROSTER_LAYOUTS = Object.freeze(['days', 'coaches'])
export const DEFAULT_ROSTER_LAYOUT = 'days'

const DAY_MS = 86400000
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const pad2 = (n) => String(n).padStart(2, '0')

// Midnight UTC of a REAL calendar date, else null (30 Feb rolls in Date.UTC,
// so a round trip that changes the digits was never a date).
function dayMs(iso) {
  const m = (typeof iso === 'string' ? iso : '').match(ISO_DAY)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return ms
}

function isoOf(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/**
 * The Monday-to-Sunday week holding `anyDayIso`, as seven 'YYYY-MM-DD'
 * strings; [] for a date the calendar does not have.
 */
export function gridWeekDays(anyDayIso) {
  const ms = dayMs(anyDayIso)
  if (ms === null) return []
  const monday = ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS
  return Array.from({ length: 7 }, (_, i) => isoOf(monday + i * DAY_MS))
}

// ── The Days | Coaches preference ───────────────────────────────────────────
// Per viewer (a studio iPad is shared), per browser. `storage` is injected so
// this stays pure and testable: the calendar passes browserStorage(), which is
// null when the browser refuses. Every access is inside try/catch: a private
// window, blocked site data or a full quota throws, and a preference must
// never be able to break the roster.

export function rosterLayoutStorageKey(viewerId) {
  return `un1t.schedule.layout.${viewerId || 'anon'}`
}

export function loadRosterLayout(storage, viewerId) {
  try {
    const value = storage ? storage.getItem(rosterLayoutStorageKey(viewerId)) : null
    return ROSTER_LAYOUTS.includes(value) ? value : DEFAULT_ROSTER_LAYOUT
  } catch {
    return DEFAULT_ROSTER_LAYOUT
  }
}

/** true when the choice was stored; false when it could not be (the choice still applies for the visit). */
export function saveRosterLayout(storage, viewerId, layout) {
  if (!storage || !ROSTER_LAYOUTS.includes(layout)) return false
  try {
    storage.setItem(rosterLayoutStorageKey(viewerId), layout)
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run it, expect PASS, under two host timezones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/roster-grid-model.test.js && TZ=America/Los_Angeles npx vitest run src/lib/roster-grid-model.test.js`
Expected: `9 passed` twice.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-grid-model.js src/lib/roster-grid-model.test.js
git commit -m "GRID.1 — grid model: the week's days by string arithmetic, and the per-viewer Days | Coaches preference

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `buildRosterGrid` — rows, cells and week totals across studios

**Files:**
- Modify: `src/lib/roster-grid-model.js`
- Modify: `src/lib/roster-grid-model.test.js`

Three helpers are stubs in this task, each replaced by a later one: `balanceFor` (Task 3), `overlaysFor` (Task 4), `advisoriesFor` (Task 5). The row SHAPE is final here, so the later tasks only swap a stub.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/roster-grid-model.test.js`:

```js
describe('buildRosterGrid — rows, cells and week totals', () => {
  const build = () => buildRosterGrid({ weekStart: WEEK, grid: GRID })

  it('one row per person: the team by name, then anyone no longer on it', () => {
    const g = build()
    expect(g.days).toEqual(gridWeekDays(WEEK))
    expect(g.rows.map((r) => r.full_name)).toEqual(['Alex Example', 'Jordan Sample', 'Max Beta', 'Sam Demo', 'Toby Beta'])
    expect(g.rows.map((r) => r.member)).toEqual([true, true, true, true, false])
    expect(g.checked).toBe(true)
  })

  it("a cell holds this studio's shifts as chips, earliest first, and the other studio's as markers", () => {
    const [mon, tue, wed] = rowOf(build(), 'p-emp').cells
    expect(mon.date).toBe('2026-09-21')
    expect(mon.here.map((c) => c.time)).toEqual(['6:30–7:30am', '9am–12pm'])
    expect(mon.here[1]).toMatchObject({
      block_id: 'b-p-emp-2026-09-21-09:00:00', here: true, kind: 'class', name: 'Strength', minutes: 180,
    })
    expect(mon.elsewhere).toEqual([])
    expect(tue.here).toEqual([])
    expect(tue.elsewhere).toHaveLength(1)
    expect(tue.elsewhere[0]).toMatchObject({ here: false, location_name: 'Studio South', name: 'Evening', time: '6–8pm', minutes: 120 })
    expect(wed.here[0]).toMatchObject({ kind: 'admin', name: 'Front desk', time: '1–2:30pm', minutes: 90 })
  })

  it('the week total is every studio together, split into here, elsewhere, class and placed admin', () => {
    // Class: 60 + 180 (Mon) + 120 (Tue, Studio South) + 60 (Fri) = 420. Admin: 90 (Wed).
    expect(rowOf(build(), 'p-emp').totals).toEqual({
      minutes: 510, here_minutes: 390, elsewhere_minutes: 120, class_minutes: 420, admin_minutes: 90, untimed: 0,
    })
  })

  it('only the seven days count: the Sunday before and the Monday after are never shown or totalled', () => {
    const chips = rowOf(build(), 'p-emp').cells.flatMap((c) => [...c.here, ...c.elsewhere])
    expect(chips.map((c) => c.date).sort()).toEqual(['2026-09-21', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-25'])
  })

  it('a cancelled assignment is not a shift', () => {
    expect(rowOf(build(), 'p-emp').cells[3].here).toEqual([])
  })

  it('a shift with no usable times is shown, not counted, and counted as untimed', () => {
    const g = build()
    const sam = rowOf(g, 'p-nocon')
    expect(sam.cells[5].here).toHaveLength(1)
    expect(sam.cells[5].here[0]).toMatchObject({ minutes: null, time: 'No times' })
    expect(sam.totals.minutes).toBe(60)
    expect(sam.totals.untimed).toBe(1)
    expect(g.untimed).toBe(1)
    expect(untimedLabel(1)).toBe('1 shift without times, not counted')
    expect(untimedLabel(2)).toBe('2 shifts without times, not counted')
  })

  it('the effective window counts: an override beats the block (a geofence arrival included)', () => {
    const g = buildRosterGrid({
      weekStart: WEEK,
      grid: { ...GRID, members: [M('p1', 'Alex Example', 'fte', 10)], shifts: [S('p1', WEEK, '09:00:00', '12:00:00', { start_time_override: '09:40:00' })] },
    })
    expect(g.rows[0].totals.minutes).toBe(140)
    expect(g.rows[0].cells[0].here[0].time).toBe('9:40am–12pm')
  })

  it('other studios unread: checked is false, so nobody reads the totals as complete', () => {
    expect(buildRosterGrid({ weekStart: WEEK, grid: { ...GRID, cross_studio_checked: false } }).checked).toBe(false)
    expect(GRID_COPY.crossStudioUnchecked).toMatch(/this studio only/)
    expect(GRID_COPY.leaveMissing).toMatch(/nobody is shown on leave/)
    expect(GRID_COPY.availabilityMissing).toMatch(/nobody is shown as unavailable/)
  })

  it('nothing to build: no grid, a malformed one, or a date the calendar does not have', () => {
    expect(buildRosterGrid({ weekStart: WEEK, grid: null })).toEqual({ days: gridWeekDays(WEEK), rows: [], checked: false, untimed: 0 })
    expect(buildRosterGrid({ weekStart: WEEK, grid: { members: 'x', shifts: [] } }).rows).toEqual([])
    expect(buildRosterGrid({ weekStart: '2026-02-30', grid: GRID }).rows).toEqual([])
  })
})

describe('buildRosterGrid — the clock-change weeks', () => {
  it('autumn (Sun 25 Oct 2026): Sunday is in the week, a normal shift is its length, a shift over the change its REAL length', () => {
    const g = buildRosterGrid({
      weekStart: '2026-10-21',
      grid: {
        ...GRID,
        members: [M('p1', 'Alex Example', 'fte', 40)],
        shifts: [
          S('p1', '2026-10-25', '09:00:00', '12:00:00'),
          S('p1', '2026-10-25', '00:30:00', '03:30:00'), // 00:30 IST to 03:30 GMT: four real hours
          S('p1', '2026-10-26', '09:00:00', '10:00:00'), // the Monday after: not this week
        ],
      },
    })
    expect(g.days[0]).toBe('2026-10-19')
    expect(g.days[6]).toBe('2026-10-25')
    expect(g.rows[0].cells[6].here.map((c) => c.minutes)).toEqual([240, 180])
    expect(g.rows[0].totals.minutes).toBe(420)
  })

  it('spring (Sun 29 Mar 2026): the short night is two real hours', () => {
    const g = buildRosterGrid({
      weekStart: '2026-03-23',
      grid: {
        ...GRID,
        members: [M('p1', 'Alex Example', 'fte', 40)],
        shifts: [S('p1', '2026-03-29', '09:00:00', '12:00:00'), S('p1', '2026-03-29', '00:30:00', '03:30:00')],
      },
    })
    expect(g.days[6]).toBe('2026-03-29')
    expect(g.rows[0].cells[6].here.map((c) => c.minutes)).toEqual([120, 180])
    expect(g.rows[0].totals.minutes).toBe(300)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-grid-model.test.js`
Expected: the 11 new tests fail with `buildRosterGrid is not a function` (and `untimedLabel`); the 9 from Task 1 pass.

- [ ] **Step 3: Implement**

In `src/lib/roster-grid-model.js`, add below the header comment, before `export const ROSTER_LAYOUTS`:

```js
import { workingWindow } from '@shared/working-time'
import { formatTimeRange12h } from './schedule-overlap'
```

Append to the end of the file:

```js
// ── The grid ────────────────────────────────────────────────────────────────

export const GRID_COPY = Object.freeze({
  crossStudioUnchecked: 'The other studios could not be read, so week totals, balances and working-time flags count this studio only.',
  leaveMissing: 'Leave could not be loaded, so nobody is shown on leave.',
  availabilityMissing: 'Availability could not be loaded, so nobody is shown as unavailable.',
  noRows: 'Nobody is on this studio’s team this week.',
  legend: 'Hours only. Week = every studio in this organisation. Admin balance = contract − class − placed admin, for employees with contracted hours.',
})

export function untimedLabel(n) {
  const k = Math.max(0, Math.round(Number(n) || 0))
  return `${k} shift${k === 1 ? '' : 's'} without times, not counted`
}

const byStart = (a, b) => String(a.start ?? '99:99').localeCompare(String(b.start ?? '99:99'))
  || String(a.key).localeCompare(String(b.key))

// One shift as a chip or a marker. Minutes are REAL elapsed time from
// workingWindow (override → block → template, Dublin wall clock → instants),
// the same measure as the 48-hour rule; null = no usable times (shown, not
// counted). `flags` comes from the overlays (Task 4).
function chipOf(s, flags) {
  const w = workingWindow(s)
  return {
    key: String(s.assignment_id || `${s.block_id}|${s.profile_id}`),
    block_id: s.block_id ?? null,
    date: s.block_date,
    here: s.here === true,
    location_name: s.location_name || null,
    name: s.name || 'Shift',
    kind: s.kind === 'admin' ? 'admin' : 'class',
    start: w ? w.start : null,
    time: w ? formatTimeRange12h(w.start, w.end) : 'No times',
    minutes: w ? Math.round((w.endMs - w.startMs) / 60000) : null,
    onLeave: flags.onLeave,
    unavailable: Boolean(w && !flags.onLeave && flags.unavailableDuring(w.start, w.end)),
  }
}

/**
 * The grid for one week.
 *
 * @param {object} args
 * @param {string} args.weekStart  any day of the week (snapped to its Monday)
 * @param {{ members: Array, shifts: Array, cross_studio_checked?: boolean }} args.grid
 *        GET /api/schedule/grid's `data`
 * @param {Array} [args.timeOff]       the calendar's approved-leave slice
 * @param {Array} [args.availability]  the calendar's availability slice (AVAIL.1)
 * @returns {{ days: string[], rows: Array, checked: boolean, untimed: number }}
 */
export function buildRosterGrid({ weekStart, grid, timeOff = [], availability = [] } = {}) {
  const days = gridWeekDays(weekStart)
  if (days.length !== 7 || !grid || !Array.isArray(grid.members) || !Array.isArray(grid.shifts)) {
    return { days, rows: [], checked: false, untimed: 0 }
  }
  const week = new Set(days)
  // The server already drops cancelled rows; the same rule again here so a
  // stale or hand-made payload can never count one. The window days (Sunday
  // before, Monday after) stay in `live` for the rest-gap rule only.
  const live = grid.shifts.filter((s) => s?.profile_id && s.status !== 'cancelled')
  const byPerson = new Map()
  for (const s of live) {
    if (!week.has(s.block_date)) continue
    if (!byPerson.has(s.profile_id)) byPerson.set(s.profile_id, [])
    byPerson.get(s.profile_id).push(s)
  }
  const overlays = overlaysFor(days, timeOff, availability)
  const advice = advisoriesFor(days, grid.members, live)

  const rows = grid.members.filter((m) => m?.profile_id).map((m) => {
    const mine = byPerson.get(m.profile_id) || []
    const totals = { minutes: 0, here_minutes: 0, elsewhere_minutes: 0, class_minutes: 0, admin_minutes: 0, untimed: 0 }
    let leaveDays = 0
    const cells = days.map((date) => {
      const leave = overlays.leaveOn(m.profile_id, date)
      if (leave) leaveDays += 1
      const chips = mine
        .filter((s) => s.block_date === date)
        .map((s) => chipOf(s, {
          onLeave: Boolean(leave),
          unavailableDuring: (start, end) => overlays.unavailableDuring(m.profile_id, date, start, end),
        }))
        .sort(byStart)
      for (const c of chips) {
        if (c.minutes === null) { totals.untimed += 1; continue }
        totals.minutes += c.minutes
        if (c.here) totals.here_minutes += c.minutes
        else totals.elsewhere_minutes += c.minutes
        if (c.kind === 'admin') totals.admin_minutes += c.minutes
        else totals.class_minutes += c.minutes
      }
      return {
        date,
        here: chips.filter((c) => c.here),
        elsewhere: chips.filter((c) => !c.here),
        leave: leave ? { label: leave.label, title: leave.title } : null,
        // Leave says more than "unavailable", as in the Days view (AVAIL.1b).
        unavailable: leave ? null : overlays.unavailableCell(m.profile_id, date),
      }
    })
    return {
      profile_id: m.profile_id,
      full_name: m.full_name || 'Unknown coach',
      member: m.member !== false,
      employment_type: m.employment_type ?? null,
      ...balanceFor(m, totals),
      cells,
      totals,
      leaveDays,
      restGaps: advice.restGapsOf(m.profile_id),
      longWeekMinutes: advice.longWeekOf(m.profile_id),
    }
  })
  rows.sort((a, b) => (a.member === b.member ? 0 : a.member ? -1 : 1)
    || a.full_name.localeCompare(b.full_name)
    || String(a.profile_id).localeCompare(String(b.profile_id)))
  return {
    days,
    rows,
    checked: grid.cross_studio_checked !== false && advice.ok,
    untimed: rows.reduce((n, r) => n + r.totals.untimed, 0),
  }
}

// Task 3 replaces this stub.
function balanceFor() {
  return { isEmployee: false, contractMinutes: null, balance: null }
}

// Task 4 replaces this stub.
function overlaysFor() {
  return { leaveOn: () => null, unavailableCell: () => null, unavailableDuring: () => false }
}

// Task 5 replaces this stub.
function advisoriesFor() {
  return { ok: true, restGapsOf: () => [], longWeekOf: () => null }
}
```

- [ ] **Step 4: Run it, expect PASS, under two host timezones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/roster-grid-model.test.js && TZ=America/Los_Angeles npx vitest run src/lib/roster-grid-model.test.js`
Expected: `20 passed` twice. A DST failure (241 or 179 minutes) means the minutes are not coming from `workingWindow`. Fix the call, never the expectation.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-grid-model.js src/lib/roster-grid-model.test.js
git commit -m "GRID.1 — grid model: one row per coach, cells per day, week totals across studios in real minutes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: the admin balance

**Files:**
- Modify: `src/lib/roster-grid-model.js`
- Modify: `src/lib/roster-grid-model.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/roster-grid-model.test.js`:

```js
describe('admin balance: contract − class − placed admin, employees only, hours only', () => {
  const build = () => buildRosterGrid({ weekStart: WEEK, grid: GRID })
  const one = (member, shifts = []) => buildRosterGrid({ weekStart: WEEK, grid: { ...GRID, members: [member], shifts } }).rows[0]

  it('an employee under contract has the rest to place, every studio counted', () => {
    const alex = rowOf(build(), 'p-emp')
    expect(alex.isEmployee).toBe(true)
    expect(alex.contractMinutes).toBe(2340)
    // 2340 − 420 class − 90 placed admin = 1830.
    expect(alex.balance).toEqual({ minutes: 1830, state: 'to_place' })
    expect(adminBalanceLabel(alex)).toEqual({
      text: '30h 30m',
      tone: 'to_place',
      srText: '30h 30m of admin to place',
      title: '39h contract − 7h class − 1h 30m placed admin = 30h 30m to place',
    })
  })

  it('over contract is a negative balance, shown with a minus and said in words', () => {
    const max = rowOf(build(), 'p-over')
    expect(max.balance).toEqual({ minutes: -30, state: 'over' })
    expect(adminBalanceLabel(max)).toEqual({
      text: '−30m',
      tone: 'over',
      srText: '30m over contract',
      title: '1h contract − 1h 30m class − 0m placed admin = 30m over contract',
    })
  })

  it('exactly on contract is met, and a half-hour contract is kept to the minute', () => {
    const met = one(M('p1', 'Alex Example', 'fte', 1.5), [S('p1', WEEK, '09:00:00', '10:30:00')])
    expect(met.balance).toEqual({ minutes: 0, state: 'met' })
    expect(adminBalanceLabel(met)).toMatchObject({ text: '0h', tone: 'met', srText: 'contract met' })
    const half = one(M('p1', 'Alex Example', 'fte', '37.5'))
    expect(half.contractMinutes).toBe(2250)
    expect(adminBalanceLabel(half).text).toBe('37h 30m')
  })

  it('an employee with no contracted hours (null or 0) has no balance, and says why', () => {
    const sam = rowOf(build(), 'p-nocon')
    expect(sam.balance).toBeNull()
    expect(adminBalanceLabel(sam)).toMatchObject({ text: 'No contract hours', tone: 'none' })
    const zero = one(M('p1', 'Alex Example', 'fte', 0))
    expect(zero.contractMinutes).toBeNull()
    expect(zero.balance).toBeNull()
  })

  it('a contractor never has a balance, even if hours were sent', () => {
    expect(adminBalanceLabel(rowOf(build(), 'p-con'))).toMatchObject({ text: 'Contractor', tone: 'none' })
    const sent = one(M('p1', 'Jordan Sample', 'contractor', 40))
    expect(sent.isEmployee).toBe(false)
    expect(sent.contractMinutes).toBeNull()
    expect(sent.balance).toBeNull()
  })

  it('an unreadable employment type is neither: no contract, no balance, a dash', () => {
    const x = one(M('p1', 'Alex Example', null, 39))
    expect(x.isEmployee).toBe(false)
    expect(x.balance).toBeNull()
    expect(adminBalanceLabel(x).text).toBe('—')
  })

  it('someone no longer on the team keeps a balance for the week they were rostered', () => {
    // 1200 − 60 = 1140.
    expect(rowOf(build(), 'p-gone').balance).toEqual({ minutes: 1140, state: 'to_place' })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-grid-model.test.js`
Expected: the 7 new tests fail (`adminBalanceLabel is not a function`, `contractMinutes` null); the 20 earlier pass.

- [ ] **Step 3: Implement**

Change the working-time import at the top of `src/lib/roster-grid-model.js` to:

```js
import { workingWindow, hoursMinutesLabel, EMPLOYEE_TYPE } from '@shared/working-time'
```

Replace the `balanceFor` stub (and its `// Task 3 replaces this stub.` line) with:

```js
// Program default 4: contract − class − placed admin, every studio, EMPLOYEES
// WITH A CONTRACT ONLY. Hours only: `contracted_hours` is the only contract
// field the route sends, and only for employment_type 'fte'. The model checks
// the type again, so a payload carrying a contractor's old default of 40
// (mig 012) still gets no balance. Leave is NOT deducted (the default's
// literal formula); adminBalanceLabel says so when there is leave.
function balanceFor(m, totals) {
  const isEmployee = m.employment_type === EMPLOYEE_TYPE
  const hours = m.contracted_hours == null || m.contracted_hours === '' ? NaN : Number(m.contracted_hours)
  const contractMinutes = isEmployee && Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : null
  if (contractMinutes === null) return { isEmployee, contractMinutes: null, balance: null }
  const minutes = contractMinutes - totals.class_minutes - totals.admin_minutes
  return {
    isEmployee,
    contractMinutes,
    balance: { minutes, state: minutes > 0 ? 'to_place' : minutes < 0 ? 'over' : 'met' },
  }
}

/**
 * What the admin-balance column says for a row: `text` (visible, aria-hidden),
 * `srText` (the same in words for a screen reader, since "−30m" alone reads
 * as a hyphen), `tone` (to_place | met | over | none) and a `title` with the
 * arithmetic. Hours only.
 */
export function adminBalanceLabel(row) {
  if (!row?.balance) {
    if (row?.employment_type === 'contractor') {
      return { text: 'Contractor', tone: 'none', srText: 'contractor, no admin balance', title: 'Contractors have no contracted hours, so there is no admin balance.' }
    }
    if (row?.isEmployee) {
      return { text: 'No contract hours', tone: 'none', srText: 'no contracted hours set', title: 'No contracted weekly hours are set for this employee.' }
    }
    return { text: '—', tone: 'none', srText: 'no admin balance', title: 'No admin balance.' }
  }
  const h = hoursMinutesLabel
  const sum = `${h(row.contractMinutes)} contract − ${h(row.totals.class_minutes)} class − ${h(row.totals.admin_minutes)} placed admin`
  const n = row.leaveDays || 0
  const leaveNote = n > 0 ? `. ${n} day${n === 1 ? '' : 's'} of approved leave this week ${n === 1 ? 'is' : 'are'} not deducted` : ''
  const { minutes, state } = row.balance
  if (state === 'over') {
    return { text: `−${h(-minutes)}`, tone: 'over', srText: `${h(-minutes)} over contract`, title: `${sum} = ${h(-minutes)} over contract${leaveNote}` }
  }
  if (state === 'met') {
    return { text: '0h', tone: 'met', srText: 'contract met', title: `${sum} = contract met${leaveNote}` }
  }
  return { text: h(minutes), tone: 'to_place', srText: `${h(minutes)} of admin to place`, title: `${sum} = ${h(minutes)} to place${leaveNote}` }
}
```

The minus in `text` is U+2212 (`−`), not a hyphen. Keep the test and the code on the same character.

- [ ] **Step 4: Run it, expect PASS, under two host timezones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/roster-grid-model.test.js && TZ=America/Los_Angeles npx vitest run src/lib/roster-grid-model.test.js`
Expected: `27 passed` twice.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-grid-model.js src/lib/roster-grid-model.test.js
git commit -m "GRID.1 — grid model: admin balance = contract − class − placed admin, employees with a contract, over-contract shown as a minus

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: leave and unavailability in the cells

**Files:**
- Modify: `src/lib/roster-grid-model.js`
- Modify: `src/lib/roster-grid-model.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/roster-grid-model.test.js`:

```js
describe('leave and unavailability, per cell', () => {
  const LEAVE = [
    { id: 't1', profile_id: 'p-emp', type: 'holiday', start_date: '2026-09-25', end_date: '2026-09-26', profiles: { full_name: 'Alex Example' } },
    { id: 't2', profile_id: 'p-emp', type: 'unavailable', start_date: '2026-09-26', end_date: '2026-09-26', profiles: { full_name: 'Alex Example' } },
  ]
  const RULES = [
    { id: 'r1', profile_id: 'p-emp', kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '10:00', end_time: '11:00', note: 'School run' },
    { id: 'r2', profile_id: 'p-emp', kind: 'dated', weekday: null, start_date: '2026-09-25', end_date: '2026-09-25', all_day: true, start_time: null, end_time: null, note: null },
    { id: 'r3', profile_id: 'p-con', kind: 'weekly', weekday: 'thu', start_date: null, end_date: null, all_day: false, start_time: '18:00', end_time: '19:00', note: null },
  ]
  const build = () => buildRosterGrid({ weekStart: WEEK, grid: GRID, timeOff: LEAVE, availability: RULES })

  it('approved leave sits in its days: one per person per day, the most specific type', () => {
    const alex = rowOf(build(), 'p-emp')
    expect(alex.cells[4].leave).toEqual({ label: 'Holiday', title: 'Alex Example — Holiday, 25 Sep – 26 Sep' })
    expect(alex.cells[5].leave.label).toBe('Holiday')
    expect(alex.cells[5].leave.title).toMatch(/\+1 overlapping request/)
    expect(alex.cells[3].leave).toBeNull()
    expect(alex.leaveDays).toBe(2)
  })

  it('the leave days are named in the balance, not deducted from it (program default 4)', () => {
    const alex = rowOf(build(), 'p-emp')
    expect(alex.balance.minutes).toBe(1830)
    expect(adminBalanceLabel(alex).title).toBe(
      '39h contract − 7h class − 1h 30m placed admin = 30h 30m to place. 2 days of approved leave this week are not deducted',
    )
  })

  it('an unavailability window sits in its day, with the rule and its note in the title', () => {
    expect(rowOf(build(), 'p-emp').cells[0].unavailable).toEqual({ text: 'Unavailable 10am–11am', title: 'Mondays, 10am–11am (School run)' })
    expect(rowOf(build(), 'p-con').cells[3].unavailable).toEqual({ text: 'Unavailable 6pm–7pm', title: 'Thursdays, 6pm–7pm' })
  })

  it('leave wins over unavailability on the same day, as in the Days view', () => {
    const fri = rowOf(build(), 'p-emp').cells[4]
    expect(fri.leave).not.toBeNull()
    expect(fri.unavailable).toBeNull()
  })

  it('a shift on a leave day, or inside an unavailable window, is flagged; touching a window is not', () => {
    const alex = rowOf(build(), 'p-emp')
    // 6:30–7:30 is clear of 10–11; 9–12 overlaps it.
    expect(alex.cells[0].here.map((c) => c.unavailable)).toEqual([false, true])
    expect(alex.cells[4].here[0]).toMatchObject({ onLeave: true, unavailable: false })
    // Jordan's 17:00–18:00 ends as the 18:00 window starts.
    expect(rowOf(build(), 'p-con').cells[3].here[0].unavailable).toBe(false)
  })

  it("one person's leave or rules never land on another row", () => {
    const max = rowOf(build(), 'p-over')
    expect(max.cells.every((c) => c.leave === null && c.unavailable === null)).toBe(true)
    expect(max.leaveDays).toBe(0)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-grid-model.test.js`
Expected: the 6 new tests fail (leave and unavailable are null everywhere); 27 pass.

- [ ] **Step 3: Implement**

Add to the imports at the top of `src/lib/roster-grid-model.js`:

```js
import { unavailableFor, unavailableSummary, describeRule } from '@shared/availability'
import { timeOffLeaveLabel } from '@shared/time-off'
import { dayLeaveBars } from './roster-card-model'
```

Replace the `overlaysFor` stub (and its `// Task 4 replaces this stub.` line) with:

```js
// Leave: dayLeaveBars (the Days view's own rule: one bar per person per day,
// the most specific type wins) keyed by person and date. Availability: the
// AVAIL.1 rules per person. ADVISORY everywhere: nothing here blocks anything.
function overlaysFor(days, timeOff, availability) {
  const leave = new Map()
  for (const date of days) {
    for (const bar of dayLeaveBars(timeOff, date)) {
      if (bar.profileId) leave.set(`${bar.profileId}|${date}`, { label: timeOffLeaveLabel(bar.type), title: bar.title })
    }
  }
  const rules = new Map()
  for (const r of availability || []) {
    if (!r?.profile_id) continue
    if (!rules.has(r.profile_id)) rules.set(r.profile_id, [])
    rules.get(r.profile_id).push(r)
  }
  const titleOf = (hits) => hits.map((r) => (r.note ? `${describeRule(r)} (${r.note})` : describeRule(r))).join('; ')
  return {
    leaveOn: (id, date) => leave.get(`${id}|${date}`) || null,
    unavailableCell: (id, date) => {
      const hits = unavailableFor(rules.get(id), date)
      return hits ? { text: `Unavailable ${unavailableSummary(hits)}`, title: titleOf(hits) } : null
    },
    unavailableDuring: (id, date, start, end) => Boolean(unavailableFor(rules.get(id), date, start, end)),
  }
}
```

- [ ] **Step 4: Run it, expect PASS, under two host timezones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/roster-grid-model.test.js && TZ=America/Los_Angeles npx vitest run src/lib/roster-grid-model.test.js`
Expected: `33 passed` twice.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-grid-model.js src/lib/roster-grid-model.test.js
git commit -m "GRID.1 — grid model: approved leave and declared unavailability per cell, advisory flags on the shifts they touch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: working-time flags per row

**Files:**
- Modify: `src/lib/roster-grid-model.js`
- Modify: `src/lib/roster-grid-model.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/roster-grid-model.test.js`:

```js
describe('working-time flags per row (WORKTIME.1 rules, every studio)', () => {
  // 2h at Studio South Monday night, 1h here Tuesday at 6am, then four 12h days.
  const heavy = (pid) => [
    S(pid, '2026-09-21', '20:00:00', '22:00:00', SOUTH_SHIFT),
    S(pid, '2026-09-22', '06:00:00', '07:00:00'),
    ...['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'].map((d) => S(pid, d, '08:00:00', '20:00:00')),
  ]
  const build = () => buildRosterGrid({
    weekStart: WEEK,
    grid: {
      ...GRID,
      members: [M('p-emp', 'Alex Example', 'fte', 39), M('p-con', 'Jordan Sample', 'contractor', null)],
      shifts: [...heavy('p-emp'), ...heavy('p-con')],
    },
  })

  it('an employee over 48 hours and short of rest is flagged on their row, the other studio counted', () => {
    const alex = rowOf(build(), 'p-emp')
    expect(alex.totals.minutes).toBe(3060)
    expect(alex.longWeekMinutes).toBe(3060)
    expect(alex.restGaps).toHaveLength(1)
    expect(alex.restGaps[0]).toMatchObject({
      rest_minutes: 480,
      before: { date: '2026-09-21', end: '22:00' },
      after: { date: '2026-09-22', start: '06:00' },
    })
  })

  it('a contractor with the same week is never flagged (the Act covers employees)', () => {
    const jordan = rowOf(build(), 'p-con')
    expect(jordan.totals.minutes).toBe(3060)
    expect(jordan.longWeekMinutes).toBeNull()
    expect(jordan.restGaps).toEqual([])
  })

  it('the rest title names both ends, their days and studios', () => {
    expect(restGapTitle({
      rest_minutes: 480,
      before: { date: '2026-09-21', end: '22:00', location_name: 'Studio South' },
      after: { date: '2026-09-22', start: '06:00', location_name: null },
    })).toBe('8h rest: ends Mon 21 Sep 10pm (Studio South), starts Tue 22 Sep 6am')
    expect(restGapTitle(null)).toBe('')
  })

  it('a week with nothing to flag says nothing', () => {
    const alex = rowOf(buildRosterGrid({ weekStart: WEEK, grid: GRID }), 'p-emp')
    expect(alex.longWeekMinutes).toBeNull()
    expect(alex.restGaps).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-grid-model.test.js`
Expected: 3 of the 4 new tests fail (no flags; `restGapTitle is not a function`). "Says nothing" passes on the stub, which is fine: it pins the quiet case for the real helper.

- [ ] **Step 3: Implement**

Change the two earlier imports at the top of `src/lib/roster-grid-model.js` to:

```js
import { workingWindow, workingTimeAdvisories, hoursMinutesLabel, EMPLOYEE_TYPE } from '@shared/working-time'
import { formatTime12h, formatTimeRange12h } from './schedule-overlap'
```

Replace the `advisoriesFor` stub (and its `// Task 5 replaces this stub.` line) with:

```js
// WORKTIME.1's own rules over the grid's shifts: employees only (the helper
// filters on `people`), every studio, the week's days plus one either side for
// rest. `todayIso: null` on purpose: this is a view, not a publish gate, so a
// past week shows its flags too. `people` is a Map, the shape
// loadWorkingTimeShifts returns and roster-publish.js passes. If the helper
// throws, the grid says it could not check (`ok: false` → checked false)
// rather than implying an all-clear.
function advisoriesFor(days, members, live) {
  const people = new Map((members || []).filter((m) => m?.profile_id).map((m) => [
    m.profile_id, { full_name: m.full_name ?? null, employment_type: m.employment_type ?? null },
  ]))
  try {
    const { restGaps, longWeeks } = workingTimeAdvisories(live, { people, from: days[0], to: days[6], todayIso: null })
    return {
      ok: true,
      restGapsOf: (id) => (restGaps || [])
        .filter((g) => g.profile_id === id)
        .map((g) => ({ rest_minutes: g.rest_minutes, before: g.before, after: g.after })),
      longWeekOf: (id) => (longWeeks || []).find((w) => w.profile_id === id && w.week_start === days[0])?.minutes ?? null,
    }
  } catch {
    return { ok: false, restGapsOf: () => [], longWeekOf: () => null }
  }
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function dayLabel(iso) {
  const ms = dayMs(iso)
  if (ms === null) return String(iso ?? '')
  const d = new Date(ms)
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`
}

/** '8h rest: ends Mon 21 Sep 10pm (Studio South), starts Tue 22 Sep 6am'. */
export function restGapTitle(gap) {
  if (!gap) return ''
  const where = (s) => (s?.location_name ? ` (${s.location_name})` : '')
  return `${hoursMinutesLabel(gap.rest_minutes)} rest: ends ${dayLabel(gap.before?.date)} ${formatTime12h(gap.before?.end)}${where(gap.before)}, `
    + `starts ${dayLabel(gap.after?.date)} ${formatTime12h(gap.after?.start)}${where(gap.after)}`
}
```

- [ ] **Step 4: Run it, expect PASS, under two host timezones, plus the pair-sync guard**

Run: `TZ=Europe/Dublin npx vitest run src/lib/roster-grid-model.test.js && TZ=America/Los_Angeles npx vitest run src/lib/roster-grid-model.test.js && npx vitest run tests/shared-pair-sync.test.js`
Expected: `37 passed` twice, then the pair-sync file all passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-grid-model.js src/lib/roster-grid-model.test.js
git commit -m "GRID.1 — grid model: WORKTIME advisories per row (over 48h, under 11h rest), employees only, every studio

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: the reader — the grid's people and their shifts across the organisation

**Files:**
- Create: `src/lib/roster-grid-data.js`
- Create: `src/lib/roster-grid-data.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/roster-grid-data.test.js`:

```js
// src/lib/roster-grid-data.test.js
// GRID.1 — the grid's one server read. Pinned: who gets a row, the
// organisation boundary, that no pay column is ever selected, what degrades
// and what fails, and paging. The arithmetic is roster-grid-model.test.js's.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./sibling-locations', () => ({ siblingLocationIds: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { siblingLocationIds } = await import('./sibling-locations')
const { logWarn } = await import('./log')
const { loadRosterGrid } = await import('./roster-grid-data')

const HERE = 'loc-north'
const SOUTH = 'loc-south'
const FOREIGN = 'loc-other-org'
const WEEK = '2026-09-21'

const A = (id, profile_id, location_id, block_date, start_time, end_time, over = {}) => ({
  id,
  profile_id,
  status: over.status || 'scheduled',
  start_time_override: null,
  end_time_override: null,
  shift_blocks: {
    id: `b-${id}`,
    location_id,
    block_date,
    start_time,
    end_time,
    shift_templates: { name: over.name || 'Strength', start_time, end_time, kind: over.kind || 'class' },
    locations: { name: location_id === HERE ? 'Studio North' : 'Studio South' },
  },
})

const PROFILES = [
  { id: 'p-emp', full_name: 'Alex Example', active: true, deleted_at: null, employment_type: 'fte', contracted_hours_per_week: 39 },
  { id: 'p-con', full_name: 'Jordan Sample', active: true, deleted_at: null, employment_type: 'contractor', contracted_hours_per_week: 40 },
  { id: 'p-off', full_name: 'Sam Demo', active: false, deleted_at: null, employment_type: 'fte', contracted_hours_per_week: 20 },
  { id: 'p-visit', full_name: 'Max Beta', active: true, deleted_at: null, employment_type: 'fte', contracted_hours_per_week: '37.5' },
  { id: 'p-gone', full_name: 'Toby Beta', active: false, deleted_at: '2026-09-01T00:00:00Z', employment_type: 'fte', contracted_hours_per_week: 30 },
]
const LINKS = ['p-emp', 'p-con', 'p-off']
const HERE_ROWS = [
  A('h1', 'p-emp', HERE, '2026-09-21', '09:00:00', '12:00:00'),
  A('h2', 'p-visit', HERE, '2026-09-23', '10:00:00', '11:00:00'), // not on the team, holds a shift here
  A('h3', 'p-gone', HERE, '2026-09-24', '10:00:00', '11:00:00'), // a tombstone's history
  A('h4', 'p-off', HERE, '2026-09-20', '10:00:00', '11:00:00'), // inactive, the Sunday before only
  A('h5', 'p-emp', HERE, '2026-09-22', '09:00:00', '10:00:00', { status: 'cancelled' }),
]
const ELSEWHERE_ROWS = [
  A('s1', 'p-emp', SOUTH, '2026-09-22', '18:00:00', '20:00:00', { name: 'Evening' }),
  A('s2', 'p-emp', FOREIGN, '2026-09-22', '07:00:00', '08:00:00'), // another organisation: must be dropped
  A('s3', 'p-con', SOUTH, '2026-09-28', '09:00:00', '10:00:00'), // the Monday after: kept for rest gaps
]

function fakeDb({ links = LINKS, profiles = PROFILES, here = HERE_ROWS, elsewhere = ELSEWHERE_ROWS, fail = {} } = {}) {
  const calls = []
  const filter = (q, op, col) => q.filters.find(([o, c]) => o === op && c === col)?.[2]
  const answer = (q) => {
    if (fail[q.table]) return { data: null, error: { message: `${q.table} down` } }
    if (q.table === 'profile_locations') return { data: links.map((profile_id) => ({ profile_id })), error: null }
    if (q.table === 'profiles') {
      const ids = filter(q, 'in', 'id')
      return { data: profiles.filter((p) => ids.includes(p.id)), error: null }
    }
    if (q.table === 'shift_assignments') {
      const isHere = filter(q, 'eq', 'shift_blocks.location_id') === HERE
      if (isHere && fail.here) return { data: null, error: { message: 'here down' } }
      if (!isHere && fail.elsewhere) return { data: null, error: { message: 'elsewhere down' } }
      const ids = filter(q, 'in', 'profile_id')
      const rows = isHere ? here : elsewhere.filter((a) => ids.includes(a.profile_id))
      const [from, to] = q.range || [0, rows.length - 1]
      return { data: rows.slice(from, to + 1), error: null }
    }
    throw new Error(`unexpected table ${q.table}`)
  }
  return {
    calls,
    from(table) {
      const q = { table, select: null, filters: [], range: null }
      calls.push(q)
      const chain = {
        select(cols) { q.select = cols; return chain },
        eq(col, v) { q.filters.push(['eq', col, v]); return chain },
        in(col, v) { q.filters.push(['in', col, v]); return chain },
        gte(col, v) { q.filters.push(['gte', col, v]); return chain },
        lte(col, v) { q.filters.push(['lte', col, v]); return chain },
        order() { return chain },
        range(a, b) { q.range = [a, b]; return chain },
        then(resolve, reject) { return Promise.resolve().then(() => answer(q)).then(resolve, reject) },
      }
      return chain
    },
  }
}

beforeEach(() => {
  siblingLocationIds.mockReset().mockResolvedValue({ ids: [SOUTH], error: null })
  logWarn.mockReset()
})

describe('loadRosterGrid', () => {
  it('the team, plus anyone holding a shift here that week; contracted hours for employees only', async () => {
    const { data, error } = await loadRosterGrid(fakeDb(), { locationId: HERE, weekStart: WEEK })
    expect(error).toBeNull()
    expect(data.week_start).toBe(WEEK)
    expect(data.week_end).toBe('2026-09-27')
    expect(data.members).toEqual([
      { profile_id: 'p-emp', full_name: 'Alex Example', employment_type: 'fte', contracted_hours: 39, member: true },
      // A contractor's column holds 40 (mig 012's default): never sent.
      { profile_id: 'p-con', full_name: 'Jordan Sample', employment_type: 'contractor', contracted_hours: null, member: true },
      { profile_id: 'p-visit', full_name: 'Max Beta', employment_type: 'fte', contracted_hours: 37.5, member: false },
      { profile_id: 'p-gone', full_name: 'Toby Beta', employment_type: 'fte', contracted_hours: 30, member: false },
    ])
  })

  it("every live shift of those people, here and at the organisation's other studios, Sunday before to Monday after", async () => {
    const db = fakeDb()
    const { data } = await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK })
    expect(data.shifts.map((s) => s.assignment_id)).toEqual(['h1', 'h2', 'h3', 's1', 's3'])
    expect(data.shifts[0]).toEqual({
      assignment_id: 'h1', profile_id: 'p-emp', status: 'scheduled',
      block_id: 'b-h1', block_date: '2026-09-21', location_id: HERE, location_name: 'Studio North', here: true,
      kind: 'class', name: 'Strength', start_time: '09:00:00', end_time: '12:00:00',
      start_time_override: null, end_time_override: null,
      shift_templates: { start_time: '09:00:00', end_time: '12:00:00' },
    })
    expect(data.shifts[3]).toMatchObject({ assignment_id: 's1', location_id: SOUTH, location_name: 'Studio South', here: false, name: 'Evening' })
    const reads = db.calls.filter((q) => q.table === 'shift_assignments')
    for (const q of reads) {
      expect(q.filters).toContainEqual(['gte', 'shift_blocks.block_date', '2026-09-20'])
      expect(q.filters).toContainEqual(['lte', 'shift_blocks.block_date', '2026-09-28'])
    }
    const elsewhereRead = reads.find((q) => q.filters.some(([op, col]) => op === 'in' && col === 'shift_blocks.location_id'))
    expect(elsewhereRead.filters).toContainEqual(['in', 'shift_blocks.location_id', [SOUTH]])
    expect(elsewhereRead.filters).toContainEqual(['in', 'profile_id', ['p-emp', 'p-con', 'p-visit', 'p-gone']])
    expect(data.cross_studio_checked).toBe(true)
  })

  it('a row from a studio outside the organisation is dropped even if returned; so is a cancelled one', async () => {
    const { data } = await loadRosterGrid(fakeDb(), { locationId: HERE, weekStart: WEEK })
    expect(data.shifts.some((s) => s.location_id === FOREIGN)).toBe(false)
    expect(data.shifts.some((s) => s.assignment_id === 'h5')).toBe(false)
    // p-off is inactive and only had the Sunday before: no row, no shift.
    expect(data.members.some((m) => m.profile_id === 'p-off')).toBe(false)
    expect(data.shifts.some((s) => s.profile_id === 'p-off')).toBe(false)
  })

  it('names its columns: no pay column is ever selected, and profile_compensation is never read', async () => {
    const db = fakeDb()
    await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK })
    expect(db.calls.find((q) => q.table === 'profiles').select)
      .toBe('id, full_name, active, deleted_at, employment_type, contracted_hours_per_week')
    expect(db.calls.some((q) => q.table === 'profile_compensation')).toBe(false)
    for (const q of db.calls) {
      expect(q.select).not.toMatch(/\*|hourly_rate|annual_salary|overtime_rate|annual_leave/)
    }
  })

  it('unreadable sibling studios: this studio only, cross_studio_checked false, no other studio read', async () => {
    siblingLocationIds.mockResolvedValue({ ids: [], error: { message: 'locations down' } })
    const db = fakeDb()
    const { data, error } = await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK })
    expect(error).toBeNull()
    expect(data.cross_studio_checked).toBe(false)
    expect(data.shifts.every((s) => s.here)).toBe(true)
    expect(db.calls.filter((q) => q.table === 'shift_assignments')).toHaveLength(1)
    expect(logWarn).toHaveBeenCalled()
  })

  it("a failed read of the other studios' shifts narrows the grid, it does not fail it", async () => {
    const { data, error } = await loadRosterGrid(fakeDb({ fail: { elsewhere: true } }), { locationId: HERE, weekStart: WEEK })
    expect(error).toBeNull()
    expect(data.cross_studio_checked).toBe(false)
    expect(data.shifts.map((s) => s.assignment_id)).toEqual(['h1', 'h2', 'h3'])
  })

  it('a failed team, profiles or this-studio read is an error with no grid, never an empty one', async () => {
    for (const fail of [{ profile_locations: true }, { profiles: true }, { here: true }]) {
      const res = await loadRosterGrid(fakeDb({ fail }), { locationId: HERE, weekStart: WEEK })
      expect(res.data).toBeNull()
      expect(res.error.message).toMatch(/down/)
    }
  })

  it('pages this studio past 1,000 rows', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => A(`h${String(i).padStart(4, '0')}`, 'p-emp', HERE, '2026-09-21', '09:00:00', '10:00:00'))
    const db = fakeDb({ here: many })
    const { data } = await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK })
    expect(data.shifts.filter((s) => s.here)).toHaveLength(1001)
    const hereReads = db.calls.filter((q) => q.table === 'shift_assignments' && q.filters.some(([op]) => op === 'eq'))
    expect(hereReads.map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('never throws', async () => {
    const db = { from() { throw new Error('client gone') } }
    const res = await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK })
    expect(res).toEqual({ data: null, error: { message: 'client gone' } })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-grid-data.test.js`
Expected: `Test Files 1 failed`, cannot resolve `./roster-grid-data`.

- [ ] **Step 3: Implement**

Create `src/lib/roster-grid-data.js`:

```js
// src/lib/roster-grid-data.js
//
// GRID.1 — the ONE server read behind the coach-by-day grid.
//
// ROWS: the studio's team (profile_locations at the studio, profiles.active IS
// NOT FALSE, not tombstoned: mig 626's predicate) PLUS anyone holding a live
// shift at this studio that week who is no longer on it (deactivated, moved,
// or a tombstone keeping history), so the grid never loses a shift the Days
// view shows.
//
// SHIFTS: every live assignment of those people from the Sunday before the
// week to the Monday after (a rest gap reaches one day either side), at this
// studio and at the OTHER studios of the SAME organisation (siblingLocationIds,
// ORGSCOPE.1). The embedded filter is the boundary; every row is re-checked
// against it afterwards, like the working-time reader, so a studio of another
// organisation is dropped even if it comes back.
//
// PAY NEVER ENTERS. profiles is read BY NAME for id, full_name, active,
// deleted_at, employment_type and contracted_hours_per_week (CLAUDE.md: name
// your columns; profiles still carries the pay columns). Contracted hours are
// hours, not pay: STAFF_PICKER_FIELDS has shipped them to every role since
// ROSTER-FIX.6c. They are returned for employees only. profile_compensation is
// NOT read. The profiles copy (deprecated by mig 152, dual-written, REVOKEd
// from the browser roles by mig 153b) is the one the Weekly hours notice, the
// FTE bars and payroll read, and one screen must not show two contracts for
// one person. The phase-3 drop of that column moves all of them together.
//
// COST: three reads in parallel (the team; this studio's shifts, paged; the
// two small locations reads in siblingLocationIds), then profiles (200 ids a
// query), then the other studios' shifts for the grid's people (paged, 200
// ids a query).
//
// NEVER THROWS. A failed team, profiles or this-studio read is an error with
// NO grid (the route answers 500, never an empty grid). Unreadable sibling
// studios, or a failed read of their shifts, narrow the grid to this studio
// and set cross_studio_checked false; they never widen it.

import { isLiveAssignment } from './roster'
import { siblingLocationIds } from './sibling-locations'
import { addDaysISO } from './dublin-time'
import { logWarn } from './log'
import { EMPLOYEE_TYPE } from '@shared/working-time'
import { shiftKindOf } from '@shared/shift-kind'

const PAGE = 1000
const CHUNK = 200

function chunks(list) {
  const out = []
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK))
  return out
}

// One paged read of assignments with their block, template and studio.
// `narrow` adds who and where; the window is always [from, to]. The select is
// a LITERAL so check:select-columns resolves every column against the schema.
async function readShifts(db, narrow, from, to) {
  const rows = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await narrow(
      db.from('shift_assignments')
        .select('id, profile_id, status, start_time_override, end_time_override, shift_blocks!inner(id, location_id, block_date, start_time, end_time, shift_templates(name, start_time, end_time, kind), locations(name))'),
    )
      .gte('shift_blocks.block_date', from)
      .lte('shift_blocks.block_date', to)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { rows: null, error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { rows, error: null }
}

function flatten(a, locationId) {
  const b = a.shift_blocks
  return {
    assignment_id: a.id,
    profile_id: a.profile_id,
    status: a.status ?? null,
    block_id: b.id,
    block_date: b.block_date,
    location_id: b.location_id,
    location_name: b.locations?.name ?? null,
    here: b.location_id === locationId,
    kind: shiftKindOf(b),
    name: b.shift_templates?.name || 'Shift',
    start_time: b.start_time ?? null,
    end_time: b.end_time ?? null,
    start_time_override: a.start_time_override ?? null,
    end_time_override: a.end_time_override ?? null,
    shift_templates: { start_time: b.shift_templates?.start_time ?? null, end_time: b.shift_templates?.end_time ?? null },
  }
}

// Employees only: a contractor's column may still hold mig 012's default 40.
function contractedHoursOf(p) {
  if (p?.employment_type !== EMPLOYEE_TYPE || p.contracted_hours_per_week == null) return null
  const n = Number(p.contracted_hours_per_week)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {{ locationId: string, weekStart: string }} opts  weekStart is the week's MONDAY
 * @returns {Promise<{
 *   data: null | {
 *     week_start: string, week_end: string,
 *     members: Array<{ profile_id, full_name, employment_type, contracted_hours, member }>,
 *     shifts: Array<{ assignment_id, profile_id, status, block_id, block_date, location_id,
 *       location_name, here, kind, name, start_time, end_time, start_time_override,
 *       end_time_override, shift_templates }>,
 *     cross_studio_checked: boolean,
 *   },
 *   error: null | { message: string },
 * }>}
 */
export async function loadRosterGrid(db, { locationId, weekStart } = {}) {
  const fail = (error) => ({ data: null, error: { message: error?.message || 'grid read failed' } })
  if (!locationId || !weekStart) return fail({ message: 'location and week are required' })
  const weekEnd = addDaysISO(weekStart, 6)
  const from = addDaysISO(weekStart, -1)
  const to = addDaysISO(weekStart, 7)
  const inWeek = (d) => d >= weekStart && d <= weekEnd

  try {
    const [team, hereRead, siblings] = await Promise.all([
      db.from('profile_locations').select('profile_id').eq('location_id', locationId),
      readShifts(db, (q) => q.eq('shift_blocks.location_id', locationId), from, to),
      siblingLocationIds(db, locationId),
    ])
    if (team.error) return fail(team.error)
    if (hereRead.error) return fail(hereRead.error)

    const teamIds = new Set((team.data || []).map((l) => l?.profile_id).filter(Boolean))
    const here = hereRead.rows.filter((a) => a?.profile_id && a.shift_blocks?.location_id === locationId && isLiveAssignment(a))
    const heldHere = new Set(here.filter((a) => inWeek(a.shift_blocks.block_date)).map((a) => a.profile_id))

    const ids = [...new Set([...teamIds, ...heldHere])]
    const profiles = new Map()
    for (const slice of chunks(ids)) {
      const { data, error } = await db
        .from('profiles')
        .select('id, full_name, active, deleted_at, employment_type, contracted_hours_per_week')
        .in('id', slice)
      if (error) return fail(error)
      for (const p of data || []) if (p?.id) profiles.set(p.id, p)
    }

    const members = []
    for (const id of ids) {
      const p = profiles.get(id)
      const onTeam = teamIds.has(id) && Boolean(p) && p.active !== false && !p.deleted_at
      if (!onTeam && !heldHere.has(id)) continue
      members.push({
        profile_id: id,
        full_name: p?.full_name ?? null,
        employment_type: p?.employment_type ?? null,
        contracted_hours: contractedHoursOf(p),
        member: onTeam,
      })
    }
    const rowIds = members.map((m) => m.profile_id)
    const rowSet = new Set(rowIds)

    let crossStudioChecked = !siblings?.error
    if (siblings?.error) {
      logWarn('roster-grid', 'sibling studios unreadable; the grid counts this studio only', { locationId, err: siblings.error.message })
    }
    const siblingIds = (siblings?.ids || []).filter((id) => id && id !== locationId)
    let elsewhere = []
    if (crossStudioChecked && siblingIds.length > 0 && rowIds.length > 0) {
      for (const slice of chunks(rowIds)) {
        const res = await readShifts(db, (q) => q.in('profile_id', slice).in('shift_blocks.location_id', siblingIds), from, to)
        if (res.error) {
          logWarn('roster-grid', "the other studios' shifts could not be read; the grid counts this studio only", { locationId, err: res.error.message })
          crossStudioChecked = false
          elsewhere = []
          break
        }
        elsewhere.push(...res.rows)
      }
    }
    const siblingSet = new Set(siblingIds)
    const shifts = [
      ...here,
      ...elsewhere.filter((a) => siblingSet.has(a?.shift_blocks?.location_id) && isLiveAssignment(a)),
    ]
      .filter((a) => rowSet.has(a.profile_id))
      .map((a) => flatten(a, locationId))

    return {
      data: { week_start: weekStart, week_end: weekEnd, members, shifts, cross_studio_checked: crossStudioChecked },
      error: null,
    }
  } catch (e) {
    return fail({ message: e?.message || 'grid read threw' })
  }
}
```

- [ ] **Step 4: Run it, expect PASS, and the schema and tombstone checks**

Run: `npx vitest run src/lib/roster-grid-data.test.js tests/staff-tombstone-readers.test.js && npm run check:select-columns`
Expected: `9 passed`, the tombstone sweep passes (the `profiles` read is `.in('id', …)`), and `check:select-columns` exits 0. Every named column exists: `profiles.deleted_at` (mig 622), `profiles.employment_type` (mig 070), `profiles.contracted_hours_per_week` (mig 012), `shift_templates.kind` (mig 628), `shift_blocks.start_time/end_time` (mig 067), `locations.name`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-grid-data.js src/lib/roster-grid-data.test.js
git commit -m "GRID.1 — grid reader: the team plus anyone rostered here, their shifts at every studio of the organisation, named columns, no pay

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `GET /api/schedule/grid`

**Files:**
- Create: `src/app/api/schedule/grid/route.js`
- Create: `src/app/api/schedule/grid/route.test.js`
- Modify: `src/lib/openapi.js` (insert after line 4593, the `})` that closes the `/api/schedule/working-time` registration)
- Modify: `src/lib/openapi.test.js` (insert before line 341, `it('declares webhook + bridge auth schemes'`)

The gate is the week-cost route's (`src/app/api/schedule/week-cost/route.js:46-66`): `MANAGER_ROLES` somewhere, then `assertLocationAccess` on the caller-supplied `location_id` (a query-param route, so an outsider gets 403, not 404), then `MANAGER_ROLES` AT that studio (SCHEDROLES.1). The date is `realIsoDate` (DATECHECK.1).

- [ ] **Step 1: Write the failing test**

Create `src/app/api/schedule/grid/route.test.js`:

```js
// GRID.1 — GET /api/schedule/grid. The read is pinned in
// src/lib/roster-grid-data.test.js; locked here: the gate, the query contract,
// and that the body carries hours and never pay.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    // SCHEDROLES.1 — REAL: the role AT location_id is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/roster-grid-data', () => ({ loadRosterGrid: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { loadRosterGrid } = await import('@/lib/roster-grid-data')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const GRID = {
  week_start: '2026-09-21',
  week_end: '2026-09-27',
  members: [{ profile_id: 'p1', full_name: 'Alex Example', employment_type: 'fte', contracted_hours: 39, member: true }],
  shifts: [{
    assignment_id: 'a1', profile_id: 'p1', status: 'scheduled', block_id: 'b1', block_date: '2026-09-21',
    location_id: LOC, location_name: 'Studio North', here: true, kind: 'class', name: 'Strength',
    start_time: '09:00:00', end_time: '12:00:00', start_time_override: null, end_time_override: null,
    shift_templates: { start_time: '09:00:00', end_time: '12:00:00' },
  }],
  cross_studio_checked: true,
}

const req = (params = {}) => {
  const url = new URL('http://test/api/schedule/grid')
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const as = (rolesByLocation, profileRole = 'staff') => ({
  id: 'u1', role: Object.values(rolesByLocation)[0] || profileRole, profileRole, rolesByLocation,
  locations: Object.keys(rolesByLocation).map((id) => ({ id })),
})
const ok = { location_id: LOC, start_date: '2026-09-24' }

beforeEach(() => {
  getCurrentUser.mockReset()
  assertLocationAccess.mockReset().mockReturnValue(null)
  loadRosterGrid.mockReset().mockResolvedValue({ data: GRID, error: null })
})

describe('GET /api/schedule/grid', () => {
  it('403 with no session, and reads nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req(ok))).status).toBe(403)
    expect(loadRosterGrid).not.toHaveBeenCalled()
  })

  it('403 for a coach at the studio, even though they manage another', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'staff', [OTHER]: 'manager' }))
    expect((await GET(req(ok))).status).toBe(403)
    expect(loadRosterGrid).not.toHaveBeenCalled()
  })

  it('403 for a manager of another studio, via assertLocationAccess', async () => {
    getCurrentUser.mockResolvedValue(as({ [OTHER]: 'manager' }))
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false, error: 'Forbidden — location not in your assignments' }, { status: 403 }))
    expect((await GET(req(ok))).status).toBe(403)
    expect(assertLocationAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), LOC)
    expect(loadRosterGrid).not.toHaveBeenCalled()
  })

  it('400 on a missing or malformed location_id, and on a missing or impossible start_date', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    for (const params of [
      { start_date: '2026-09-24' },
      { location_id: 'nope', start_date: '2026-09-24' },
      { location_id: LOC },
      { location_id: LOC, start_date: '2026-02-30' },
      { location_id: LOC, start_date: '24/09/2026' },
    ]) {
      expect((await GET(req(params))).status, JSON.stringify(params)).toBe(400)
    }
    expect(loadRosterGrid).not.toHaveBeenCalled()
  })

  it('200 for a head coach at the studio: any day of the week is snapped to its Monday, one read', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'head_coach' }))
    const res = await GET(req(ok))
    expect(res.status).toBe(200)
    expect(loadRosterGrid).toHaveBeenCalledTimes(1)
    expect(loadRosterGrid).toHaveBeenCalledWith({ tag: 'db' }, { locationId: LOC, weekStart: '2026-09-21' })
    expect(await res.json()).toEqual({ success: true, data: GRID })
  })

  it('master is allowed', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    expect((await GET(req(ok))).status).toBe(200)
  })

  it('the body carries hours and names, never pay', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    const body = await (await GET(req(ok))).json()
    const wire = JSON.stringify(body).toLowerCase()
    for (const banned of ['rate', 'salary', 'hourly', 'annual', 'overtime', 'cost', 'eur', '€']) {
      expect(wire, banned).not.toContain(banned)
    }
    expect(Object.keys(body.data.members[0]).sort()).toEqual(['contracted_hours', 'employment_type', 'full_name', 'member', 'profile_id'])
  })

  it('500 when the read fails: never an empty grid', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    loadRosterGrid.mockResolvedValue({ data: null, error: { message: 'db down' } })
    const res = await GET(req(ok))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/grid/route.test.js`
Expected: `Test Files 1 failed`, cannot resolve `./route.js`.

- [ ] **Step 3: Implement**

Create `src/app/api/schedule/grid/route.js`:

```js
// GRID.1 — GET /api/schedule/grid?location_id=<uuid>&start_date=<YYYY-MM-DD>
//
// The coach-by-day grid's one read (Schedule → Week → Coaches). For the Mon-Sun
// week holding start_date: the studio's team plus anyone holding a shift there
// that week (name, employment type, contracted hours for employees), and every
// live shift those people have from the Sunday before to the Monday after, here
// and at the other studios of the same organisation. The arithmetic (totals,
// admin balance, advisories) happens in the browser, in the pure
// src/lib/roster-grid-model.js, over this one snapshot plus the leave and
// availability the calendar already holds.
//
// Gate: MANAGER_ROLES, then assertLocationAccess on the caller-supplied
// location_id (a query-param route: a studio outside the caller's assignments
// is a 403, as week-cost), then MANAGER_ROLES AT that studio (SCHEDROLES.1:
// never user.role). The date is a real calendar date (DATECHECK.1).
//
// Hours and times only. No rate, salary, cost or euro figure is read or sent.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, realIsoDate, MANAGER_ROLES } from '@/lib/schemas'
import { mondayOf } from '@/lib/payroll'
import { loadRosterGrid } from '@/lib/roster-grid-data'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  location_id: uuidLike,
  start_date: realIsoDate,
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    location_id: url.searchParams.get('location_id'),
    start_date: url.searchParams.get('start_date'),
  })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }
  const { location_id, start_date } = parsed.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden — needs a manager role at that location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data, error } = await loadRosterGrid(db, { locationId: location_id, weekStart: mondayOf(start_date) })
  if (error) {
    logError('api/schedule/grid', 'grid read failed', { location_id, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not load the coach grid' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data })
}
```

In `src/lib/openapi.js`, after line 4593 (the `})` that closes the `/api/schedule/working-time` registration), insert:

```js

// GRID.1 — the coach-by-day grid's read (Schedule → Week → Coaches).
registry.registerPath({
  method: 'get',
  path: '/api/schedule/grid',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Coach-by-day grid for one week (manager-only)',
  description: "GRID.1. Query: location_id (uuid) and start_date (any day of the target Mon-Sun week; snapped to its Monday). Returns members: the studio's team (profile_locations, active and not deleted) plus anyone holding a live shift at the studio that week (member: false), each with profile_id, full_name, employment_type and contracted_hours (employees only, else null); and shifts: every live shift those people have from the Sunday before to the Monday after, at this studio and at the other studios of the SAME organisation (never another organisation), with block_id, block_date, the block, override and template times, the template name and kind (class | admin), location_name and here. cross_studio_checked is false when the other studios could not be read; the shifts are then this studio's only. Hours and times only: no rate, salary, cost or euro figure is read or returned. Manager-only (master, owner, manager, head_coach AT location_id), scoped by assertLocationAccess: a studio outside the caller's assignments is a 403.",
  request: { query: z.object({ location_id: uuidLike, start_date: z.string() }) },
  responses: {
    200: { description: '{ week_start, week_end, members: [...], shifts: [...], cross_studio_checked }' },
    400: { description: 'Missing or malformed location_id / start_date, or start_date is not a real calendar date', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — needs a manager role at that location', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'The grid could not be read (never answered as an empty grid)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

In `src/lib/openapi.test.js`, before line 341 (`it('declares webhook + bridge auth schemes'`), insert:

```js
  // GRID.1
  it('documents the coach grid read as manager-only, hours only, one organisation', () => {
    const op = spec.paths['/api/schedule/grid']?.get
    expect(op).toBeDefined()
    expect(op.security).toContainEqual({ CookieAuth: [] })
    expect(op.description).toMatch(/manager-only/i)
    expect(op.description).toMatch(/no rate/i)
    expect(op.description).toMatch(/same organisation/i)
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '400', '403', '500']))
    expect(op.responses['400'].description).toMatch(/real calendar date/)
  })

```

- [ ] **Step 4: Run it, expect PASS, and the route checks**

Run: `npx vitest run src/app/api/schedule/grid/route.test.js src/lib/openapi.test.js && npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails`
Expected: `8 passed` plus the openapi file all passed; the three checks exit 0. `check:route-guards` sees `getCurrentUser`; `check:location-scoping` sees `assertLocationAccess` in the handler (the tenant-table queries live in the lib).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/grid/route.js src/app/api/schedule/grid/route.test.js src/lib/openapi.js src/lib/openapi.test.js
git commit -m "GRID.1 — GET /api/schedule/grid: manager at the studio, a real date snapped to Monday, hours never pay

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `useRosterGrid` — the grid's read in the browser

**Files:**
- Create: `src/components/schedule/useRosterGrid.js`
- Create: `src/components/schedule/useRosterGrid.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/components/schedule/useRosterGrid.test.js`:

```js
// @vitest-environment jsdom
//
// GRID.1 — the grid's read. Pinned: it fires only while the grid is on screen,
// a failed first load is an error and not an empty grid, a failed refresh of
// the same week keeps the grid, and a slow answer for a week the manager has
// left never lands under the new one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act, cleanup } from '@testing-library/react'
import { useRosterGrid, browserStorage } from './useRosterGrid'

const ARGS = { locationId: 'loc1', weekStart: '2026-09-21', enabled: true }
const GRID = { week_start: '2026-09-21', week_end: '2026-09-27', members: [], shifts: [], cross_studio_checked: true }
const ok = (body) => ({ ok: true, status: 200, redirected: false, json: async () => body })

beforeEach(() => { global.fetch = vi.fn(async () => ok({ success: true, data: GRID })) })
// cleanup unmounts each hook's host tree before jsdom is torn down
// (see tests/rtl-cleanup-after-each.test.js).
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useRosterGrid', () => {
  it('asks for the studio and the week, and hands back the grid', async () => {
    const { result } = renderHook(() => useRosterGrid(ARGS))
    await waitFor(() => expect(result.current.grid).toEqual(GRID))
    expect(global.fetch).toHaveBeenCalledWith('/api/schedule/grid?location_id=loc1&start_date=2026-09-21', undefined)
    expect(result.current.gridError).toBeNull()
    expect(result.current.gridLoading).toBe(false)
  })

  it('fires nothing while the grid is not on screen, or without a studio or a week', async () => {
    renderHook(() => useRosterGrid({ ...ARGS, enabled: false }))
    renderHook(() => useRosterGrid({ ...ARGS, locationId: null }))
    renderHook(() => useRosterGrid({ ...ARGS, weekStart: null }))
    await waitFor(() => expect(global.fetch).not.toHaveBeenCalled())
  })

  it('a failed first load is an error and no grid, never an empty grid', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, redirected: false, json: async () => ({ success: false, error: 'Could not load the coach grid' }) }))
    const { result } = renderHook(() => useRosterGrid(ARGS))
    await waitFor(() => expect(result.current.gridError).toBe('Could not load the coach grid'))
    expect(result.current.grid).toBeNull()
  })

  it('a failed refresh of the same week keeps the grid on screen and names the failure', async () => {
    const { result } = renderHook(() => useRosterGrid(ARGS))
    await waitFor(() => expect(result.current.grid).toEqual(GRID))
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await act(async () => { await result.current.refreshGrid() })
    expect(result.current.grid).toEqual(GRID)
    expect(result.current.gridError).toBe('Failed to fetch')
  })

  it('a slow answer for the week the manager has left never lands under the new one', async () => {
    const gate = {}
    let call = 0
    global.fetch = vi.fn(async () => {
      call += 1
      if (call === 1) return new Promise((resolve) => { gate.first = resolve })
      return ok({ success: true, data: { ...GRID, week_start: '2026-09-28' } })
    })
    const { result, rerender } = renderHook((props) => useRosterGrid(props), { initialProps: ARGS })
    rerender({ ...ARGS, weekStart: '2026-09-28' })
    await waitFor(() => expect(result.current.grid?.week_start).toBe('2026-09-28'))
    await act(async () => { gate.first(ok({ success: true, data: GRID })) })
    expect(result.current.grid.week_start).toBe('2026-09-28')
  })

  it('browserStorage is localStorage, or null when the browser refuses it', () => {
    expect(browserStorage()).toBe(window.localStorage)
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('SecurityError') })
    expect(browserStorage()).toBeNull()
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/schedule/useRosterGrid.test.js`
Expected: `Test Files 1 failed`, cannot resolve `./useRosterGrid`.

- [ ] **Step 3: Implement**

Create `src/components/schedule/useRosterGrid.js`:

```js
'use client'

// GRID.1 — the coach-by-day grid's read, as its own hook (like useWeekCost):
// the grid failing must never take the roster down, and a Days viewer must not
// pay for it. `enabled` is the calendar's showCoachGrid (manager, week view,
// Coaches); nothing is requested otherwise.
//
// Same request-ordering guard as useScheduleData: a monotonic generation stamps
// each request and only the newest writes state. The bump comes BEFORE the
// early return (the useWeekCost lesson), so disabling retires an in-flight
// request too.
//
// On failure: a refresh of the week already on screen KEEPS its grid (the
// component says it is the last one that loaded); a first load, or a load of a
// DIFFERENT week, shows no grid at all, never another week's rows under these
// dates. readJson (useScheduleData) gives the same signed-out and no-access
// words as the rest of the calendar.

import { useState, useEffect, useCallback, useRef } from 'react'
import { readJson } from './useScheduleData'

/**
 * window.localStorage, or null when there is no window or the browser refuses
 * it (merely touching the property throws a SecurityError when site data is
 * blocked). The layout preference helpers take this and never throw.
 */
export function browserStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function useRosterGrid({ locationId, weekStart, enabled = false }) {
  const [grid, setGrid] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  // The `${locationId}|${weekStart}` the grid in state was loaded for.
  const loadedKey = useRef(null)

  const refresh = useCallback(async () => {
    const gen = ++generation.current
    if (!enabled || !locationId || !weekStart) {
      setLoading(false)
      return
    }
    const key = `${locationId}|${weekStart}`
    if (loadedKey.current !== key) {
      // Another studio or week is in state: never show it under these dates.
      setGrid(null)
      loadedKey.current = null
    }
    setLoading(true)
    try {
      const body = await readJson(`/api/schedule/grid?location_id=${locationId}&start_date=${weekStart}`)
      if (gen !== generation.current) return
      setGrid(body.data ?? null)
      loadedKey.current = key
      setError(null)
    } catch (e) {
      if (gen !== generation.current) return
      setError(e?.message || 'Could not load the coach grid')
      if (loadedKey.current !== key) setGrid(null)
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }, [locationId, weekStart, enabled])

  useEffect(() => { refresh() }, [refresh])

  return { grid, gridError: error, gridLoading: loading, refreshGrid: refresh }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/components/schedule/useRosterGrid.test.js tests/rtl-cleanup-after-each.test.js`
Expected: `6 passed`, and the cleanup guard passes.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/useRosterGrid.js src/components/schedule/useRosterGrid.test.js
git commit -m "GRID.1 — useRosterGrid: the grid's read, only while it is on screen, stale answers dropped, refresh failures keep the week

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: the toolbar's Days | Coaches control

**Files:**
- Modify: `src/lib/roster-card-model.js` (`rosterToolbarModel`, lines 257-285)
- Modify: `src/lib/roster-card-model.test.js` (inside `describe('rosterToolbarModel')`, before its closing `})` at line 330)
- Modify: `src/components/schedule/RosterToolbar.jsx` (import line 30; props lines 44-48; insert after line 93)
- Modify: `src/components/schedule/RosterToolbar.test.jsx` (before the final `})`, line 154)

- [ ] **Step 1: Write the failing tests**

In `src/lib/roster-card-model.test.js`, inside `describe('rosterToolbarModel', …)`, after the "both copies are disabled" test and before the describe's closing `})` (line 330), insert:

```js

  // GRID.1 — Days | Coaches: the grid is a week-level layout, for managers.
  it('offers Days | Coaches to a manager in week view only', () => {
    expect(rosterToolbarModel(base).showLayoutToggle).toBe(true)
    expect(rosterToolbarModel({ ...base, viewType: 'month' }).showLayoutToggle).toBe(false)
    expect(rosterToolbarModel({ ...base, isManager: false }).showLayoutToggle).toBe(false)
  })
```

In `src/components/schedule/RosterToolbar.test.jsx`, before the final `})` (line 154), insert:

```js

  // GRID.1 — Days | Coaches. jsdom cannot say it fits on a 390px row (PR body).
  it('a manager in week view: Days | Coaches after Week | Month, Days on by default, Publish still last', () => {
    const onLayout = vi.fn()
    setup({ onLayout })
    const group = screen.getByRole('group', { name: 'Roster layout' })
    const days = within(group).getByRole('button', { name: 'Days' })
    const coaches = within(group).getByRole('button', { name: 'Coaches' })
    expect(days.getAttribute('aria-pressed')).toBe('true')
    expect(coaches.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Week' }).compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('schedule-toolbar-actions').lastElementChild).toBe(screen.getByRole('button', { name: 'Publish' }))
    for (const b of [days, coaches]) {
      expect(b.getAttribute('type')).toBe('button')
      expect(b.className).toMatch(/whitespace-nowrap/)
    }
    fireEvent.click(coaches)
    expect(onLayout).toHaveBeenCalledWith('coaches')
  })

  it('says Coaches is on when it is, and Days reports back', () => {
    const onLayout = vi.fn()
    setup({ layout: 'coaches', onLayout })
    expect(screen.getByRole('button', { name: 'Coaches' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Days' }))
    expect(onLayout).toHaveBeenCalledWith('days')
  })

  it('no layout control in month view, or for a coach', () => {
    setup({ viewType: 'month' }, { viewType: 'month' })
    expect(screen.queryByRole('group', { name: 'Roster layout' })).toBeNull()
    cleanup()
    setup({}, { isManager: false })
    expect(screen.queryByRole('group', { name: 'Roster layout' })).toBeNull()
  })
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/lib/roster-card-model.test.js src/components/schedule/RosterToolbar.test.jsx`
Expected: the 4 new tests fail (`showLayoutToggle` undefined; no "Roster layout" group). Every existing test passes.

- [ ] **Step 3: Implement**

In `src/lib/roster-card-model.js`, `rosterToolbarModel`: in the coach branch (line 259) add `showLayoutToggle: false`:

```js
    return { timeOffInline: true, moreItems: [], moreLabel: 'More', moreActive: false, showPublish: false, showLayoutToggle: false }
```

and in the manager object, after `showPublish: viewType === 'week',` (line 271), add:

```js
    // GRID.1 — Days | Coaches: the coach-by-day grid is a week layout.
    showLayoutToggle: viewType === 'week',
```

Also add a line to its doc comment above (after `*   manager + week view   Publish`, line 253): ` *   manager + week view   Days | Coaches (GRID.1)`.

In `src/components/schedule/RosterToolbar.jsx`:

Change line 30 to add two icons:

```js
import { ChevronLeft, ChevronRight, Send, Users, User, CalendarDays, CalendarRange, CalendarOff, Check, Copy, Settings, Columns3, Rows3 } from 'lucide-react'
```

Change the props (lines 44-48) to:

```js
export default function RosterToolbar({
  viewType, periodLabel, onPrev, onNext, onToday, statusChip,
  viewMode, onViewMode, onViewType,
  model, onSelectToggle, onCopyWeek, onCopyMonth, onPublish, publishing,
  layout = 'days', onLayout,
}) {
```

After line 93 (the `</div>` closing the Week | Month control), insert:

```jsx

        {/* GRID.1 — Days (the day-column cards) | Coaches (the coach-by-day
            grid). A manager in week view only (model.showLayoutToggle). Same
            segmented style and wrapping rules as the two toggles before it. */}
        {model.showLayoutToggle && (
          <div className={SEGMENTED} role="group" aria-label="Roster layout">
            <button type="button" aria-pressed={layout !== 'coaches'} onClick={() => onLayout?.('days')} className={segment(layout !== 'coaches')}>
              <Columns3 size={14} className="hidden sm:inline" aria-hidden="true" /> Days
            </button>
            <button type="button" aria-pressed={layout === 'coaches'} onClick={() => onLayout?.('coaches')} className={segment(layout === 'coaches')}>
              <Rows3 size={14} className="hidden sm:inline" aria-hidden="true" /> Coaches
            </button>
          </div>
        )}
```

Update the header comment's row sketch (line 8) to read `[My|All  Week|Month  Days|Coaches  More  Publish]`, and add one line under the WRAPPING paragraph: `GRID.1 added a third toggle for managers in week view: at 390px the actions group now takes two lines before Publish; still every control is a nowrap flex item narrower than the content box (browser check in the GRID.1 PR).`

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/lib/roster-card-model.test.js src/components/schedule/RosterToolbar.test.jsx`
Expected: both files all passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-card-model.js src/lib/roster-card-model.test.js src/components/schedule/RosterToolbar.jsx src/components/schedule/RosterToolbar.test.jsx
git commit -m "GRID.1 — toolbar: a Days | Coaches control for managers in week view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `RosterGrid` — the table

**Files:**
- Create: `src/components/schedule/RosterGrid.jsx`
- Create: `src/components/schedule/RosterGrid.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/schedule/RosterGrid.test.jsx`:

```js
// src/components/schedule/RosterGrid.test.jsx
// @vitest-environment jsdom
//
// GRID.1 — what the coach-by-day grid puts in the DOM. The decisions are
// roster-grid-model.test.js's; this is the layout of them.
// 🔴 NOT proof of layout: jsdom has no layout engine (memory
// `jsdom-cannot-see-layout`). The class pins below stop the sticky column and
// the scroller being dropped; the browser checks in the PR prove them.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import RosterGrid from './RosterGrid'
import { buildRosterGrid } from '@/lib/roster-grid-model'

afterEach(() => cleanup())

const WEEK = '2026-09-21'
const S = (profile_id, block_date, start_time, end_time, over = {}) => ({
  assignment_id: `${profile_id}-${block_date}-${start_time}`, profile_id, block_id: `b-${block_date}`, block_date,
  location_id: 'loc-north', location_name: 'Studio North', here: true, kind: 'class', name: 'Strength', status: 'scheduled',
  start_time, end_time, start_time_override: null, end_time_override: null, shift_templates: { start_time, end_time }, ...over,
})
const M = (profile_id, full_name, employment_type, contracted_hours) => ({ profile_id, full_name, employment_type, contracted_hours, member: true })
const SOUTH = { location_id: 'loc-south', location_name: 'Studio South', here: false }

const GRID = {
  members: [M('p-emp', 'Alex Example', 'fte', 39), M('p-con', 'Jordan Sample', 'contractor', null), M('p-over', 'Max Beta', 'fte', 1)],
  shifts: [
    S('p-emp', '2026-09-21', '09:00:00', '12:00:00', { block_id: 'b-mon' }),
    S('p-emp', '2026-09-22', '18:00:00', '20:00:00', { ...SOUTH, block_id: 'b-south', name: 'Evening' }),
    S('p-emp', '2026-09-23', '13:00:00', '14:30:00', { block_id: 'b-wed', kind: 'admin', name: 'Front desk' }),
    S('p-con', '2026-09-24', '17:00:00', '18:00:00', { block_id: 'b-thu' }),
    S('p-over', '2026-09-25', '06:00:00', '07:30:00', { block_id: 'b-fri' }),
  ],
  cross_studio_checked: true,
}
const LEAVE = [{ id: 't1', profile_id: 'p-con', type: 'holiday', start_date: '2026-09-26', end_date: '2026-09-26', profiles: { full_name: 'Jordan Sample' } }]
const RULES = [{ id: 'r1', profile_id: 'p-emp', kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '10:00', end_time: '11:00', note: null }]
const model = (over = {}) => buildRosterGrid({ weekStart: WEEK, grid: { ...GRID, ...over }, timeOff: LEAVE, availability: RULES })
const rowEl = (id) => screen.getAllByTestId('roster-grid-row').find((r) => r.dataset.profileId === id)
const shown = (el) => el.querySelector('[aria-hidden="true"]')

describe('RosterGrid', () => {
  it('a header, then one row per coach with the week, the contract and the admin balance', () => {
    render(<RosterGrid model={model()} onOpenBlock={vi.fn()} />)
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Coach', 'Week', 'Contract', 'Admin balance', 'Mon 21', 'Tue 22', 'Wed 23', 'Thu 24', 'Fri 25', 'Sat 26', 'Sun 27',
    ])
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Alex Example', 'Jordan Sample', 'Max Beta'])
    const alex = rowEl('p-emp')
    // 180 + 120 (Studio South) + 90 = 390.
    expect(within(alex).getByTestId('grid-week-total').textContent).toBe('6h 30m2h other studio')
    expect(within(alex).getByTestId('grid-contract').textContent).toBe('39h')
    expect(shown(within(alex).getByTestId('grid-balance')).textContent).toBe('32h 30m')
    expect(within(alex).getByTestId('grid-balance').getAttribute('title')).toBe('39h contract − 5h class − 1h 30m placed admin = 32h 30m to place')
  })

  it('a shift here is a button that opens its block; a shift at the other studio is a marker, not a control', () => {
    const onOpenBlock = vi.fn()
    render(<RosterGrid model={model()} onOpenBlock={onOpenBlock} />)
    const alex = rowEl('p-emp')
    fireEvent.click(within(alex).getByRole('button', { name: /9am–12pm/ }))
    expect(onOpenBlock).toHaveBeenCalledWith('b-mon')
    expect(within(alex).queryByRole('button', { name: /6–8pm/ })).toBeNull()
    const marker = within(alex).getByTestId('grid-elsewhere')
    expect(marker.textContent).toMatch(/6–8pm/)
    expect(marker.textContent).toMatch(/Studio South/)
    expect(within(alex).getByRole('button', { name: /1–2:30pm/ }).textContent).toMatch(/Admin · Front desk/)
  })

  it('a shift whose block is not on screen cannot be opened', () => {
    const onOpenBlock = vi.fn()
    render(<RosterGrid model={model()} onOpenBlock={onOpenBlock} canOpenBlock={() => false} />)
    const button = within(rowEl('p-emp')).getByRole('button', { name: /9am–12pm/ })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onOpenBlock).not.toHaveBeenCalled()
  })

  it('over contract reads as a minus and says so in words; a contractor has no contract and no balance', () => {
    render(<RosterGrid model={model()} onOpenBlock={vi.fn()} />)
    const balance = within(rowEl('p-over')).getByTestId('grid-balance')
    expect(shown(balance).textContent).toBe('−30m')
    expect(shown(balance).className).toMatch(/text-amber-700/)
    expect(balance.querySelector('.sr-only').textContent).toBe('30m over contract')
    const jordan = rowEl('p-con')
    expect(within(jordan).getByTestId('grid-contract').textContent).toBe('—')
    expect(shown(within(jordan).getByTestId('grid-balance')).textContent).toBe('Contractor')
  })

  it('leave and unavailability sit in their day; a shift inside a window says so', () => {
    render(<RosterGrid model={model()} onOpenBlock={vi.fn()} />)
    expect(within(rowEl('p-con')).getByTestId('grid-leave').textContent).toBe('Holiday')
    const unavailable = within(rowEl('p-emp')).getByTestId('grid-unavailable')
    expect(unavailable.textContent).toBe('Unavailable 10am–11am')
    expect(unavailable.getAttribute('title')).toBe('Mondays, 10am–11am')
    expect(within(rowEl('p-emp')).getByRole('button', { name: /9am–12pm/ }).textContent).toMatch(/Unavailable$/)
  })

  it('working-time flags sit under the name, with both ends of a short rest in the title', () => {
    const heavy = buildRosterGrid({
      weekStart: WEEK,
      grid: {
        members: [M('p-emp', 'Alex Example', 'fte', 39)],
        shifts: [
          S('p-emp', '2026-09-21', '20:00:00', '22:00:00', SOUTH),
          S('p-emp', '2026-09-22', '06:00:00', '07:00:00'),
          ...['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'].map((d) => S('p-emp', d, '08:00:00', '20:00:00')),
        ],
        cross_studio_checked: true,
      },
    })
    render(<RosterGrid model={heavy} onOpenBlock={vi.fn()} />)
    expect(screen.getByTestId('grid-long-week').textContent).toBe('51h week')
    const rest = screen.getByTestId('grid-short-rest')
    expect(rest.textContent).toBe('8h rest')
    expect(rest.getAttribute('title')).toMatch(/^8h rest: ends Mon 21 Sep 10pm \(Studio South\), starts Tue 22 Sep 6am/)
  })

  it('says when the other studios, leave or availability could not be read', () => {
    render(<RosterGrid model={model({ cross_studio_checked: false })} leaveMissing availabilityMissing onOpenBlock={vi.fn()} />)
    const text = screen.getByTestId('roster-grid').textContent
    expect(text).toMatch(/other studios could not be read/)
    expect(text).toMatch(/nobody is shown on leave/)
    expect(text).toMatch(/nobody is shown as unavailable/)
  })

  it('first load says so; a failed first load offers Retry; a failed refresh keeps the grid and says so', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<RosterGrid model={null} loading onOpenBlock={vi.fn()} />)
    expect(screen.getByTestId('roster-grid-loading').textContent).toBe('Loading coaches…')
    rerender(<RosterGrid model={null} error="Request failed (500)" onRetry={onRetry} onOpenBlock={vi.fn()} />)
    expect(screen.getByText('Could not load the coach grid')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    rerender(<RosterGrid model={model()} error="Request failed (500)" onRetry={onRetry} onOpenBlock={vi.fn()} />)
    expect(screen.getByText(/Showing the last grid that loaded/)).toBeTruthy()
    expect(screen.getAllByTestId('roster-grid-row')).toHaveLength(3)
  })

  it("My shifts: only the viewer's row", () => {
    render(<RosterGrid model={model()} onlyProfileId="p-over" onOpenBlock={vi.fn()} />)
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Max Beta'])
  })

  it('select mode marks the selected shift pressed', () => {
    render(<RosterGrid model={model()} selectMode selectedBlockIds={new Set(['b-mon'])} onOpenBlock={vi.fn()} />)
    expect(within(rowEl('p-emp')).getByRole('button', { name: /9am–12pm/ }).getAttribute('aria-pressed')).toBe('true')
    expect(within(rowEl('p-emp')).getByRole('button', { name: /1–2:30pm/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('layout classes jsdom can pin: its own relative scroller, a sticky opaque first column, separate borders; no pay', () => {
    render(<RosterGrid model={model()} onOpenBlock={vi.fn()} />)
    const scroller = screen.getByTestId('roster-grid-scroller')
    expect(scroller.className).toMatch(/\boverflow-x-auto\b/)
    expect(scroller.className).toMatch(/\brelative\b/)
    for (const el of [screen.getByTestId('roster-grid-corner'), ...screen.getAllByRole('rowheader')]) {
      expect(el.className).toMatch(/\bsticky\b/)
      expect(el.className).toMatch(/\bleft-0\b/)
      expect(el.className).toMatch(/\bbg-un1t-(bg|surface)\b/)
    }
    expect(screen.getByRole('table').className).toMatch(/\bborder-separate\b/)
    expect(screen.getByTestId('roster-grid').textContent).not.toMatch(/€|salary|hourly/i)
  })
})
```

The Alex balance title says `5h class`: this fixture's class hours are 180 + 120 = 300 (the main model fixture's 420 includes two more shifts).

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/schedule/RosterGrid.test.jsx`
Expected: `Test Files 1 failed`, cannot resolve `./RosterGrid`.

- [ ] **Step 3: Implement**

Create `src/components/schedule/RosterGrid.jsx`:

```jsx
'use client'

// GRID.1 — the manager's coach-by-day grid: Schedule → Week → Coaches.
//
// An ADDITIONAL layout, not a replacement: the day-column cards stay the
// default (the ROSTER LOOK decision). One row per coach at this studio, then
// three numbers (the week's hours across every studio of the organisation,
// the contract for employees, and the admin balance = contract − class −
// placed admin, program default 4), then seven day columns. The numbers sit
// next to the name so they are on screen without scrolling. Hours only:
// nothing here is, or can be turned into, pay.
//
// READ-ONLY. A shift at this studio is a button that opens the same block
// dialog a day card opens (in select mode it toggles selection, as a card
// does: the calendar decides, in onOpenBlock). A shift at another studio is a
// muted marker, not a control: that studio's dialog is not this screen's to
// open. No drag-and-drop (GRID.1 plan, review notes).
//
// Every decision is in src/lib/roster-grid-model.js (pure, tested). This file
// lays it out. 🔴 jsdom cannot see layout: the sticky first column, the
// horizontal scroller and the 1280/390 widths are browser checks (PR body).
//   - The scroller is `relative overflow-x-auto` for the week grid's reason
//     (ROSTERLOOK.1): it must be the containing block of every sr-only span,
//     or they stretch the DOCUMENT sideways on a phone.
//   - `border-separate border-spacing-0`, not `border-collapse`: a sticky cell
//     in a collapsed-border table loses its borders while it scrolls.
//   - Sticky cells carry their own background, or the day columns show
//     through them as they scroll underneath.

import { CalendarOff, CalendarX } from 'lucide-react'
import { hoursMinutesLabel, MAX_WEEK_HOURS, MIN_REST_HOURS } from '@shared/working-time'
import { adminBalanceLabel, restGapTitle, untimedLabel, GRID_COPY } from '@/lib/roster-grid-model'
import { indexByDate } from '@/lib/bank-holidays'
import ScheduleErrorBanner from './ScheduleErrorBanner'

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const TONE = {
  to_place: 'text-un1t-text',
  met: 'text-green-700',
  over: 'text-amber-700 font-semibold',
  none: 'text-un1t-muted',
}
const HEAD = 'border-b border-un1t-border px-2 py-2 font-semibold text-un1t-subtle whitespace-nowrap'
const CELL = 'border-b border-un1t-border px-2 py-2 align-top'
const NOTE = 'mb-2 text-xs px-3 py-2 rounded-md bg-amber-500/10 text-amber-700'
const hoursOrZero = (m) => (m > 0 ? hoursMinutesLabel(m) : '0h')

export default function RosterGrid({
  model, loading = false, error = null, onRetry, onOpenBlock, canOpenBlock = () => true,
  selectMode = false, selectedBlockIds = null, onlyProfileId = null, holidays = [],
  leaveMissing = false, availabilityMissing = false,
}) {
  if (!model) {
    if (error) return <ScheduleErrorBanner title="Could not load the coach grid" message={error} onRetry={onRetry} busy={loading} />
    return (
      <div data-testid="roster-grid-loading" className="text-center py-20 text-un1t-subtle">
        {loading ? 'Loading coaches…' : 'Nothing to show for this week.'}
      </div>
    )
  }
  const rows = onlyProfileId ? model.rows.filter((r) => r.profile_id === onlyProfileId) : model.rows
  const holidayByDate = indexByDate(holidays)
  const selected = selectedBlockIds instanceof Set ? selectedBlockIds : new Set()

  return (
    <section data-testid="roster-grid" aria-label="Coaches by day">
      {error && (
        <ScheduleErrorBanner
          title="Could not refresh the coach grid"
          message={`${error} Showing the last grid that loaded.`}
          onRetry={onRetry}
          busy={loading}
        />
      )}
      {!model.checked && <p className={NOTE}>{GRID_COPY.crossStudioUnchecked}</p>}
      {leaveMissing && <p className={NOTE}>{GRID_COPY.leaveMissing}</p>}
      {availabilityMissing && <p className={NOTE}>{GRID_COPY.availabilityMissing}</p>}

      <div data-testid="roster-grid-scroller" className="relative overflow-x-auto rounded-lg border border-un1t-border">
        <table className="min-w-[1180px] w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr className="bg-un1t-surface text-left">
              <th scope="col" data-testid="roster-grid-corner" className={`${HEAD} sticky left-0 z-20 w-36 sm:w-44 bg-un1t-surface border-r`}>Coach</th>
              <th scope="col" className={`${HEAD} text-right`}>Week</th>
              <th scope="col" className={`${HEAD} text-right`}>Contract</th>
              <th scope="col" className={`${HEAD} text-right border-r`}>Admin balance</th>
              {model.days.map((date, i) => {
                const holiday = holidayByDate.get(date)
                return (
                  <th key={date} scope="col" className={`${HEAD} min-w-[7.5rem]`} title={holiday?.name || undefined}>
                    {DAY_LABELS[i]} {Number(date.slice(8, 10))}
                    {holiday && <span className="ml-1 font-normal text-amber-700">· {holiday.name || 'Bank holiday'}</span>}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} className={`${CELL} py-8 text-center text-un1t-muted`}>{GRID_COPY.noRows}</td>
              </tr>
            ) : rows.map((row) => (
              <GridRow
                key={row.profile_id}
                row={row}
                onOpenBlock={onOpenBlock}
                canOpenBlock={canOpenBlock}
                selectMode={selectMode}
                selected={selected}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[11px] text-un1t-muted">
        {GRID_COPY.legend} Flags (employees): over {MAX_WEEK_HOURS} hours in a week, under {MIN_REST_HOURS} hours between working days.
        {model.untimed > 0 && ` ${untimedLabel(model.untimed)}.`}
      </p>
    </section>
  )
}

function GridRow({ row, onOpenBlock, canOpenBlock, selectMode, selected }) {
  const balance = adminBalanceLabel(row)
  const shortestRest = row.restGaps.length ? Math.min(...row.restGaps.map((g) => g.rest_minutes)) : null
  return (
    <tr data-testid="roster-grid-row" data-profile-id={row.profile_id}>
      <th scope="row" className={`${CELL} sticky left-0 z-10 w-36 sm:w-44 bg-un1t-bg border-r text-left font-medium text-un1t-text`}>
        <div className="truncate" title={row.full_name}>{row.full_name}</div>
        {!row.member && <div className="text-[11px] font-normal text-un1t-muted">Not on this studio’s team now</div>}
        {(row.longWeekMinutes !== null || shortestRest !== null) && (
          <div className="mt-1 flex flex-wrap gap-1 font-normal">
            {row.longWeekMinutes !== null && (
              <span
                data-testid="grid-long-week"
                title={`Over ${MAX_WEEK_HOURS} hours rostered this week, every studio counted`}
                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 whitespace-nowrap"
              >
                {hoursMinutesLabel(row.longWeekMinutes)} week
              </span>
            )}
            {shortestRest !== null && (
              <span
                data-testid="grid-short-rest"
                title={row.restGaps.map(restGapTitle).join('; ')}
                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 whitespace-nowrap"
              >
                {hoursMinutesLabel(shortestRest)} rest
              </span>
            )}
          </div>
        )}
      </th>
      <td data-testid="grid-week-total" className={`${CELL} text-right tabular-nums whitespace-nowrap`}>
        <div className="font-medium text-un1t-text">{hoursOrZero(row.totals.minutes)}</div>
        {row.totals.elsewhere_minutes > 0 && (
          <div className="text-[11px] text-un1t-muted">{hoursMinutesLabel(row.totals.elsewhere_minutes)} other studio</div>
        )}
        {row.totals.untimed > 0 && <div className="text-[11px] text-un1t-muted">{untimedLabel(row.totals.untimed)}</div>}
      </td>
      <td data-testid="grid-contract" className={`${CELL} text-right tabular-nums whitespace-nowrap text-un1t-text`}>
        {row.contractMinutes !== null ? hoursMinutesLabel(row.contractMinutes) : <span className="text-un1t-muted">—</span>}
      </td>
      <td data-testid="grid-balance" title={balance.title || undefined} className={`${CELL} text-right tabular-nums whitespace-nowrap border-r`}>
        <span aria-hidden="true" className={TONE[balance.tone] || TONE.none}>{balance.text}</span>
        <span className="sr-only">{balance.srText}</span>
      </td>
      {row.cells.map((cell) => (
        <GridCell
          key={cell.date}
          cell={cell}
          onOpenBlock={onOpenBlock}
          canOpenBlock={canOpenBlock}
          selectMode={selectMode}
          selected={selected}
        />
      ))}
    </tr>
  )
}

function GridCell({ cell, onOpenBlock, canOpenBlock, selectMode, selected }) {
  return (
    <td className={`${CELL} min-w-[7.5rem]`}>
      <div className="flex flex-col gap-1">
        {cell.leave && (
          <div data-testid="grid-leave" title={cell.leave.title} className="flex items-center gap-1 rounded px-1.5 py-0.5 bg-sky-500/10 text-sky-700">
            <CalendarOff size={11} className="shrink-0" aria-hidden="true" />{cell.leave.label}
          </div>
        )}
        {cell.unavailable && (
          <div data-testid="grid-unavailable" title={cell.unavailable.title} className="flex items-center gap-1 rounded px-1.5 py-0.5 bg-slate-500/10 text-slate-700">
            <CalendarX size={11} className="shrink-0" aria-hidden="true" />{cell.unavailable.text}
          </div>
        )}
        {cell.here.map((chip) => {
          const isSelected = selected.has(chip.block_id)
          const flag = chip.onLeave ? 'On leave' : chip.unavailable ? 'Unavailable' : null
          return (
            <button
              key={chip.key}
              type="button"
              data-testid="grid-shift"
              data-kind={chip.kind}
              disabled={!chip.block_id || !canOpenBlock(chip.block_id)}
              aria-pressed={selectMode ? isSelected : undefined}
              onClick={() => onOpenBlock?.(chip.block_id)}
              title={`${chip.name}, ${chip.time}${flag ? ` (${flag.toLowerCase()})` : ''}`}
              className={`w-full rounded border px-1.5 py-1 text-left transition-colors hover:border-un1t-text/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent disabled:opacity-60 ${
                chip.kind === 'admin' ? 'bg-slate-500/10 border-slate-500/30' : 'bg-un1t-surface border-un1t-border'
              } ${flag ? 'ring-1 ring-amber-500/60' : ''} ${selectMode && isSelected ? 'ring-2 ring-un1t-accent' : ''}`}
            >
              <span className="block whitespace-nowrap font-medium text-un1t-text">{chip.time}</span>
              <span className="block truncate text-un1t-subtle">{chip.kind === 'admin' ? 'Admin · ' : ''}{chip.name}</span>
              {flag && <span className="block text-[10px] text-amber-700">{flag}</span>}
            </button>
          )
        })}
        {cell.elsewhere.map((chip) => (
          <div
            key={chip.key}
            data-testid="grid-elsewhere"
            title={`${chip.location_name || 'Another studio'}: ${chip.name}, ${chip.time}`}
            className="rounded border border-dashed border-un1t-border px-1.5 py-1 text-un1t-muted"
          >
            <span className="sr-only">At another studio: </span>
            <span className="block whitespace-nowrap">{chip.time}</span>
            <span className="block truncate">{chip.location_name || 'Another studio'}</span>
          </div>
        ))}
      </div>
    </td>
  )
}
```

- [ ] **Step 4: Run it, expect PASS, and the guardrails**

Run: `npx vitest run src/components/schedule/RosterGrid.test.jsx tests/rtl-cleanup-after-each.test.js && npm run check:guardrails`
Expected: `11 passed`, the cleanup guard passes, and `check:guardrails` exits 0. Chips use `bg-<c>-500/10 text-<c>-700`; no `-300/400/500` text; only live `un1t-*` tokens; every button has `type="button"`.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/RosterGrid.jsx src/components/schedule/RosterGrid.test.jsx
git commit -m "GRID.1 — RosterGrid: coach rows, day cells, week, contract and admin balance, flags; shifts here open their block

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: wire it into the calendar

**Files:**
- Modify: `src/components/ScheduleCalendar.jsx`
- Create: `src/components/ScheduleCalendar.grid.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/ScheduleCalendar.grid.test.jsx`:

```js
// @vitest-environment jsdom
//
// GRID.1 — the Coaches layout's wiring in the calendar: the toggle, the
// per-viewer memory, the read (only while the grid is shown), the block dialog
// from a grid shift, and the coach boundary. The grid's rules are pinned in
// src/lib/roster-grid-model.test.js and its markup in RosterGrid.test.jsx.
// jsdom has no layout: only presence, roles and text are asserted.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

const LOC = 'loc1'
const manager = {
  id: 'u1', role: 'manager', profileRole: 'manager', rolesByLocation: { [LOC]: 'manager' },
  activeLocation: { id: LOC, name: 'Studio North' },
}
const coach = {
  id: 'u2', role: 'staff', profileRole: 'staff', rolesByLocation: { [LOC]: 'staff' },
  activeLocation: { id: LOC, name: 'Studio North' },
}
const KEY = (id) => `un1t.schedule.layout.${id}`

// Wednesday of the week the URL pins.
const targetBlock = {
  id: 'b-target', location_id: LOC, template_id: 't2', block_date: '2026-05-06',
  start_time: '10:00:00', end_time: '12:00:00', max_coaches: 3, min_coaches: 1,
  shift_templates: { id: 't2', name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [{ id: 'a1', profile_id: 'c-a', status: 'scheduled', profiles: { full_name: 'Alex Example' } }],
}
const staff = [{ id: 'c-a', full_name: 'Alex Example', role: 'staff', active: true, employment_type: 'fte', contracted_hours_per_week: 10, profile_locations: [{ location_id: LOC }] }]
const GRID = {
  week_start: '2026-05-04', week_end: '2026-05-10',
  members: [{ profile_id: 'c-a', full_name: 'Alex Example', employment_type: 'fte', contracted_hours: 10, member: true }],
  shifts: [{
    assignment_id: 'a1', profile_id: 'c-a', status: 'scheduled', block_id: 'b-target', block_date: '2026-05-06',
    location_id: LOC, location_name: 'Studio North', here: true, kind: 'class', name: 'Midday Strength',
    start_time: '10:00:00', end_time: '12:00:00', start_time_override: null, end_time_override: null,
    shift_templates: { start_time: '10:00:00', end_time: '12:00:00' },
  }],
  cross_studio_checked: true,
}
const GRID_URL = `/api/schedule/grid?location_id=${LOC}&start_date=2026-05-04`

const ok = (body, status = 200) => ({ ok: status < 400, status, redirected: false, json: async () => body })
function mockFetch() {
  return vi.fn(async (url) => {
    const u = String(url)
    if (u.startsWith('/api/schedule/grid')) return ok({ success: true, data: GRID })
    if (u.includes('/schedule/blocks')) return ok({ success: true, data: [targetBlock] })
    if (u.includes('/api/staff')) return ok({ success: true, data: staff })
    return ok({ success: true, data: [] })
  })
}
const gridCalls = () => global.fetch.mock.calls.filter(([u]) => String(u).startsWith('/api/schedule/grid'))

async function renderLoaded(user = manager) {
  render(<ScheduleCalendar user={user} />)
  await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
}

beforeEach(() => {
  global.fetch = mockFetch()
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('ScheduleCalendar: the Coaches layout (GRID.1)', () => {
  it('a manager whose last layout was Coaches gets the grid for the week on screen, not the day cards', async () => {
    window.localStorage.setItem(KEY('u1'), 'coaches')
    await renderLoaded()
    const grid = await screen.findByTestId('roster-grid')
    expect(gridCalls().map(([u]) => String(u))).toContain(GRID_URL)
    expect(within(grid).getByRole('rowheader').textContent).toMatch(/Alex Example/)
    expect(within(grid).getByTestId('grid-week-total').textContent).toMatch(/^2h/)
    expect(within(grid).getByTestId('grid-contract').textContent).toBe('10h')
    expect(within(grid).getByTestId('grid-balance').textContent).toMatch(/^8h/)
    expect(screen.queryByText('Add Slot')).toBeNull()
    expect(screen.getByRole('button', { name: 'Coaches' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a shift in the grid opens the same block dialog a day card opens', async () => {
    window.localStorage.setItem(KEY('u1'), 'coaches')
    await renderLoaded()
    const grid = await screen.findByTestId('roster-grid')
    fireEvent.click(within(grid).getByRole('button', { name: /10am–12pm/ }))
    expect(await screen.findByRole('dialog', { name: 'Midday Strength' })).toBeTruthy()
  })

  it('Days | Coaches switches the layout and remembers it for this viewer', async () => {
    await renderLoaded()
    expect(screen.getAllByText('Add Slot').length).toBeGreaterThan(0)
    expect(gridCalls()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Coaches' }))
    await screen.findByTestId('roster-grid')
    expect(window.localStorage.getItem(KEY('u1'))).toBe('coaches')
    fireEvent.click(screen.getByRole('button', { name: 'Days' }))
    await waitFor(() => expect(screen.queryByTestId('roster-grid')).toBeNull())
    expect(screen.getAllByText('Add Slot').length).toBeGreaterThan(0)
    expect(window.localStorage.getItem(KEY('u1'))).toBe('days')
  })

  it('a coach gets neither the control nor a grid request, whatever was stored', async () => {
    window.localStorage.setItem(KEY('u2'), 'coaches')
    await renderLoaded(coach)
    expect(screen.queryByRole('group', { name: 'Roster layout' })).toBeNull()
    expect(screen.queryByTestId('roster-grid')).toBeNull()
    expect(gridCalls()).toHaveLength(0)
  })

  it('Month view has no Coaches layout; back to Week brings the grid back', async () => {
    window.localStorage.setItem(KEY('u1'), 'coaches')
    await renderLoaded()
    await screen.findByTestId('roster-grid')
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Roster layout' })).toBeNull())
    expect(screen.queryByTestId('roster-grid')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Week' }))
    expect(await screen.findByTestId('roster-grid')).toBeTruthy()
  })

  it('a browser that refuses storage gets Days, and the control still works for the visit', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    await renderLoaded()
    expect(screen.getAllByText('Add Slot').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Coaches' }))
    expect(await screen.findByTestId('roster-grid')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/ScheduleCalendar.grid.test.jsx`
Expected: every test fails except the coach one (no "Roster layout" group, no grid). The coach test passes, which is right: it pins the boundary before and after.

- [ ] **Step 3: Implement**

All edits are in `src/components/ScheduleCalendar.jsx`.

(a) After the `roster-card-model` import (line 85), add:

```js
// GRID.1 — the Coaches layout: the coach-by-day grid, its read, and its pure model.
import RosterGrid from './schedule/RosterGrid'
import { useRosterGrid, browserStorage } from './schedule/useRosterGrid'
import { buildRosterGrid, loadRosterLayout, saveRosterLayout, DEFAULT_ROSTER_LAYOUT } from '@/lib/roster-grid-model'
```

(b) After `const [viewMode, setViewMode] = useState('all') // 'my' or 'all'` (line 200), add:

```js
  // GRID.1 — Days (the day-column cards, the default) or Coaches (the coach-by-
  // day grid, managers in week view). Per viewer, per browser, in localStorage;
  // every access is inside loadRosterLayout/saveRosterLayout's try/catch. Read
  // AFTER mount, not in the useState initialiser: the server render has no
  // storage, and a different first client render is a hydration mismatch. The
  // cost is one Days paint before the grid on a reload (a browser check).
  const [rosterLayout, setRosterLayout] = useState(DEFAULT_ROSTER_LAYOUT)
  useEffect(() => { setRosterLayout(loadRosterLayout(browserStorage(), user.id)) }, [user.id])
  const chooseRosterLayout = useCallback((next) => {
    setRosterLayout(next)
    saveRosterLayout(browserStorage(), user.id, next)
  }, [user.id])
```

(c) After `const { draftRosters, refreshDraftRosters } = useDraftRosters({ locationId, enabled: isManager })` (line 425), add:

```js
  // GRID.1 — the grid's own read, made only while the grid is on screen. Its
  // own hook, like useWeekCost: the grid failing must never take the roster
  // down. Leave, availability and bank holidays are NOT re-read: this calendar
  // already holds them for exactly this week.
  const showCoachGrid = isManager && viewType === 'week' && rosterLayout === 'coaches'
  const weekStartIso = formatDate(weekStart)
  const { grid: gridData, gridError, gridLoading, refreshGrid } = useRosterGrid({
    locationId, weekStart: weekStartIso, enabled: showCoachGrid,
  })
  const rosterGridModel = useMemo(
    () => (gridData ? buildRosterGrid({ weekStart: weekStartIso, grid: gridData, timeOff, availability }) : null),
    [gridData, weekStartIso, timeOff, availability],
  )
```

(d) In `refreshAfterMutation` (lines 479-494), after `refreshWeekCost()` add:

```js
    // GRID.1 — the grid is a separate read too; it must follow every edit.
    refreshGrid()
```

and add `refreshGrid` to its dependency array:

```js
  }, [fetchData, refreshWeekCost, refreshGrid, refreshDraftRosters, onDataChange, visiblePeriodKey])
```

(e) Immediately before `const toolbarModel = rosterToolbarModel({` (line 995), add:

```js
  // GRID.1 — a grid shift opens the block dialog a day card opens, or in
  // select mode toggles it, exactly as ShiftCard's onActivate does. Only this
  // studio's blocks can be opened: they are the ones this calendar holds.
  function openBlockFromGrid(blockId) {
    const block = blocks.find((b) => b.id === blockId)
    if (!block) return
    if (selectMode) toggleBlockSelection(block.id)
    else setBlockDetail(block)
  }
```

(f) In the `<RosterToolbar` JSX (lines 1038-1054), after `publishing={publishing}` add:

```jsx
        layout={rosterLayout}
        onLayout={chooseRosterLayout}
```

(g) Replace the week branch's opener (line 1241, the `) : (` directly before `// ── WEEK VIEW ──`) with:

```jsx
      ) : showCoachGrid ? (
        // ── COACHES VIEW (GRID.1) ──
        // One row per coach, seven day columns, every studio of the
        // organisation summed. Read-only: a shift here opens the same block
        // dialog the day cards open. Manager + week view only (showCoachGrid).
        // Layout (sticky column, scroll, 1280/390) is a browser check.
        <RosterGrid
          model={rosterGridModel}
          loading={gridLoading}
          error={gridError}
          onRetry={refreshGrid}
          onOpenBlock={openBlockFromGrid}
          canOpenBlock={(id) => blocks.some((b) => b.id === id)}
          selectMode={selectMode}
          selectedBlockIds={selectedBlockIds}
          onlyProfileId={viewMode === 'my' ? user.id : null}
          holidays={holidays}
          leaveMissing={leaveMissing}
          availabilityMissing={availabilityMissing}
        />
      ) : (
```

`availability` and `availabilityMissing` come from AVAIL.1b (prerequisite 1). `leaveMissing`, `holidays`, `timeOff`, `selectMode`, `selectedBlockIds`, `toggleBlockSelection` and `setBlockDetail` are already in scope.

- [ ] **Step 4: Run it, expect PASS, plus every calendar test**

Run: `npx vitest run src/components/ScheduleCalendar.grid.test.jsx && npx vitest run src/components/ScheduleCalendar src/components/schedule`
Expected: `6 passed`, then every calendar and schedule component file passed. The existing files never see the grid: it is off by default, and none of their URLs contains `/api/schedule/grid`.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.grid.test.jsx
git commit -m "GRID.1 — calendar: the Coaches layout for managers in week view, remembered per viewer; grid shifts open their block

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

- [ ] **Focused tests, both timezones:**

```bash
for tz in Europe/Dublin America/Los_Angeles; do
  TZ=$tz npx vitest run src/lib/roster-grid-model.test.js src/lib/roster-grid-data.test.js src/app/api/schedule/grid/route.test.js src/components/schedule/useRosterGrid.test.js src/components/schedule/RosterGrid.test.jsx src/components/ScheduleCalendar.grid.test.jsx || break
done
npx vitest run tests/shared-pair-sync.test.js tests/staff-tombstone-readers.test.js tests/rtl-cleanup-after-each.test.js tests/test-timeout-budgets.test.js tests/fixture-pii.test.js src/lib/openapi.test.js src/lib/roster-card-model.test.js src/components/schedule/RosterToolbar.test.jsx
```

Expected: all passed, both timezones (37 + 9 + 8 + 6 + 11 + 6 = 77 in the loop).

- [ ] **CI mirror (all twelve), then the build:**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
npm run build
```

Expected: every command exits 0. `check:ota-paths` passes and nothing under `mobile/` or `shared/` changed, so **the merge publishes no OTA**. `npm run build` resolves the new route, `@/lib/roster-grid-model` from a client component (it imports `@shared/working-time`, `@shared/availability`, `@shared/time-off` and `./roster-card-model`, none of which may reach `next/headers` or the service client), and `@/lib/roster-grid-data` from the route. That import graph is the one thing only the build proves. On the 8GB machine, run the build with nothing else running. If it is too slow, push and let the required **Next build** check be the gate. Never skip both.

- [ ] **Open the PR.** Title: `GRID.1 — a coach-by-day grid in the manager's week view: both studios summed, contract and admin balance, leave, availability and working-time flags`. The body must state:
  - Web only. No migration. **No OTA** (nothing under `mobile/` or `shared/`).
  - An ADDITIONAL layout: Days (the day cards) stays the default; Coaches is a toolbar choice for managers in week view, remembered per viewer in `localStorage` (try/catch everywhere; refused storage = Days).
  - Data: one new read, `GET /api/schedule/grid`, with why (the browser only holds this studio; other studios and the day either side need the server; one snapshot per week; re-read after every mutation; only while the grid is shown). Leave, availability and holidays reuse the calendar's slices.
  - Gate: `MANAGER_ROLES` AT `location_id` after `assertLocationAccess` (403 outsider, a query-param route like week-cost); `realIsoDate`.
  - Org boundary: this studio plus `siblingLocationIds` only; other organisations dropped even if returned; `cross_studio_checked: false` and a note when siblings cannot be read; 500 (never an empty grid) when this studio cannot be read.
  - Pay: `profiles` selected by name (`id, full_name, active, deleted_at, employment_type, contracted_hours_per_week`); `profile_compensation` not read; contracted hours sent for employees only; a route test greps the body for pay words. Contracted hours come from the same (deprecated, dual-written, 0 drift on 25 Sep) `profiles` copy the Weekly hours notice reads.
  - Admin balance = contract − class − placed admin, both studios, employees with a contract only; over-contract shows `−1h 30m`; leave not deducted (named in the title). Program default 4, REVIEW.
  - Working-time flags: WORKTIME's own `workingTimeAdvisories`, employees only, both studios, past weeks included.
  - Read-only: a shift here opens the existing block dialog (select mode toggles, as a card); other-studio shifts are markers; no drag-and-drop.
  - **Browser checks owed (jsdom cannot see layout)**, on the Vercel PREVIEW (prod data; GET-only; do not press Publish, assign or delete):
    1. 1280×800, manager at Stillorgan, Week → **Coaches**: the table scrolls sideways inside its own box; `document.documentElement.scrollWidth <= document.documentElement.clientWidth`; the Coach column stays pinned while scrolling; sticky cells are opaque (no day text shows through) and keep their right border while scrolled; Week / Contract / Admin balance are visible without scrolling.
    2. 390×844 (phone): the same document-width check; the toolbar wraps with Days | Coaches, More and Publish all on screen; the Coach column is ≤ ~176px and names truncate; chip text stays inside its cell; sr-only spans do not widen the page.
    3. Reload with Coaches chosen: one Days paint then the grid; no hydration warning in the console.
    4. A private window (or site data blocked): Days; the control still switches for the visit.
    5. Click a Stillorgan shift in the grid: the block dialog opens. Close it. (Do not assign; that is a write on prod data. The refresh-after-mutation is pinned by the calendar test.)
    6. A coach with a Hatch Street shift: a dashed "Hatch Street" marker in that day, and the week total includes it; the "other studio" line under the total matches.
    7. Compare one employee's grid week total with the Weekly hours notice above the grid: they may differ for someone who also works at Hatch Street (review note 3). Record it in the PR.
    8. More → Select multiple, then click grid shifts: each toggles its selection ring; the bulk bar counts them.
    9. As a coach (View as user): no Days | Coaches control; Network shows no `/api/schedule/grid` request.
    10. `GET /api/schedule/grid?location_id=<Hatch Street id>&start_date=<today>` as a Stillorgan-only manager: 403. As a coach: 403. As a manager: the response body has no `rate`, `salary` or `€`.
  - End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **CHANGELOG.** After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md` (under the `|---|------|-------|` line; never edit another row), then commit and push:

```
| #<PR> | GRID.1 — a coach-by-day grid in the manager's week view: both studios summed, contract and admin balance, leave, availability and working-time flags | 2026-09-2x. Wave 2 PR 21. Web only: no migration, no OTA. New toolbar control **Days \| Coaches** (managers, week view; Days stays the default; remembered per viewer in localStorage, try/catch). Coaches = `src/components/schedule/RosterGrid.jsx`: one row per coach (the studio's active team, plus anyone still holding a shift here that week), Week / Contract / Admin balance next to the name, seven day cells (shifts here open the existing block dialog; other studios' shifts are dashed markers), approved leave and AVAIL.1 unavailability per cell, WORKTIME flags per row (over 48h, under 11h rest; employees only). Pure model `src/lib/roster-grid-model.js` (real minutes via `workingWindow`, both DST weeks tested). Admin balance = contract − class − placed admin, both studios, employees with contracted hours; over contract shows `−Xh`; leave not deducted (program default 4). New `GET /api/schedule/grid` (`src/lib/roster-grid-data.js`): manager AT the studio, `realIsoDate` snapped to Monday, this studio + `siblingLocationIds` only (other organisations dropped even if returned), paged, `profiles` by name (contracted hours = the `profiles` copy the Weekly hours notice reads; employees only), `profile_compensation` not read, 500 never an empty grid, `cross_studio_checked` when siblings are unreadable. Read only while the grid is shown; re-read after every roster edit. No drag-and-drop. |
```

- [ ] **After merge:** nothing to watch: no cron, no migration, no OTA. Tell Richard the layout exists and where (Schedule → Week → Coaches), that it is his to try on real weeks, and that review notes 1-4 are his calls.

---

### Review notes / open questions

1. **Where contracted hours come from (checked 25 Sep).** Two copies exist. `profile_compensation.contracted_hours_per_week` is canonical since mig 152 (master/owner-only RLS). `profiles.contracted_hours_per_week` is "DEPRECATED … To be dropped in phase 3" (mig 152/153 comments). Mig 153b revoked table SELECT on `profiles` from the browser roles. Both copies are still written on every staff create and update (`src/app/api/staff/route.js:216,257`; `src/lib/staff-write.js:217-240`). A read-only aggregate on prod on 25 Sep found zero drift across 15 non-deleted profiles. The grid reads the `profiles` copy by name because every other roster surface does: `STAFF_PICKER_FIELDS` (sent to every role since ROSTER-FIX.6c), the Weekly hours notice, `roster-summary-server.js` and payroll. One screen should not show two contracts. When phase 3 drops the column, all of those readers must move to `profile_compensation` together (`check:select-columns` will fail on each one that is missed). If Richard would rather the grid read the canonical copy now, it is a one-line select change in `roster-grid-data.js` plus a second query. The price is possible disagreement with the notice if the copies ever drift.
2. **Leave is not deducted from the balance (program default 4, taken literally).** An employee on holiday Thursday and Friday shows about 15 hours "to place" that are really leave. The title says so ("2 days of approved leave this week are not deducted"). The repo already has a convention for this: `leaveHoursInWeek` (`src/lib/roster-summary.js:56`) takes contract/5 per weekday of approved leave, and RosterSummaryPanel's FTE bars use it. Adopting it would be `balance = contract − leave allowance − class − admin`. That is cheap, but it changes Richard's formula, so it is his call.
3. **Two weekly totals on one screen.** The Weekly hours notice above the grid (`/api/schedule/week-cost`, `src/lib/roster-week-cost.js`) counts THIS studio's blocks only, and so do the FTE bars in RosterSummaryPanel. The grid counts every studio of the organisation. For a coach who also works at Hatch Street, the notice and the grid will disagree. The grid is the truer number for a contract. Follow-up (not in this PR): make week-cost cross-studio with the same reader, or relabel the notice "at this studio".
4. **Who gets a row.** Every active team member at the studio, whatever their role: reception, owners and head coaches too, because the assign picker offers the same population (`locationStaff`, `src/components/ScheduleCalendar.jsx:531`). An FTE receptionist with a 39-hour contract and no rostered shifts shows "39h to place". That is arguably true under HYBRID, but it may be noise. Options: hide rows with no shifts in either studio and no contract; or filter by `profile_locations.role`. Not done without a decision.
5. **Drafts count.** Every live assignment counts, published or draft, as in the manager's Days view and in WORKTIME. A half-built draft week at Hatch Street therefore moves Stillorgan's grid totals. That is consistent with the double-booking and working-time checks.
6. **Real minutes, not payroll's wall clock.** A shift spanning 01:00-02:00 on a clock-change night is counted at its true length (for example 4h for 00:30-03:30 on 25 Oct). `shiftHours` would say 3h. No gym shift does that today. The week total and the 48-hour flag always agree with each other.
7. **The three numbers sit next to the name, not at the end.** This departs from the usual "totals on the right". At 1280px the seven day columns do not all fit beside the sidebar, and the brief's point is the balance, so it is on screen without scrolling. Cheap to move if Richard prefers totals at the end.
8. **No drag-and-drop (as briefed).** Dragging a chip between rows would reassign a shift without the picker's advisories (leave, availability, rest, 48 hours, double-booking). It would have no keyboard equivalent, and on a trackpad it invites a mis-drop that notifies a coach once published. The grid opens the existing dialog, which already carries every advisory.
9. **Past weeks show flags.** `todayIso: null`, unlike the publish preview, which only lists what is still ahead. In a past week the "rest" and "week" badges are history, and past days may use geofence ARRIVAL overrides as the effective start (memory `rostering-review-2026-09-16`). That is the paid window and arguably the truer working time.
10. **Someone no longer on the team** (deactivated, moved, or a tombstone) still gets a row for a week in which they hold a shift here: "Not on this studio's team now". Their Hatch Street shifts are read too, so their total is complete. This keeps the grid and the Days view agreeing on who is rostered.
11. **Other-studio detail.** A Stillorgan manager sees a coach's Hatch Street shift time, template name and studio name (the dashed marker and its title). This is the same disclosure as `doubleBookings` and WORKTIME's publish list, and it stays inside one organisation (ORGSCOPE.1).
12. **Preference scope.** Per viewer, per browser (`localStorage`, as briefed), so it does not follow a manager to another device. A server-side preference would need a settings column; not worth it for a view toggle.
13. **Flash on reload.** Reading the preference after mount avoids a hydration mismatch at the cost of one Days paint before the grid. If it proves annoying, the fix is to put `layout=coaches` in the URL alongside `view=` (SCHEDULE-PERSIST.1 already mirrors state there) and read it in the initialiser like `viewType`.
14. **No phone grid.** Web only. The phone's Manage mode is a list per day. A phone grid would be its own design (the table needs about 1180px).
