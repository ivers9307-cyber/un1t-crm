## PR RUNWAY.1 — roster runway alert: say so when next week is not built

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this section task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an upcoming week is inside a 10-day horizon and is unpublished or has shifts with no coach, the people who can publish it see a chip (web Today, mobile Studio) and get one push per studio, per week, per severity.

**Why:** On 19 Sep the week of 28 Sep was 9 days away with 0 of 34 blocks staffed and nothing published, and nothing in the product noticed. Rosters are built in monthly batches; the first week's lead time slipped from 20 days to 12-14. The existing Today chip (`fetchStaffingGapsThisWeek`, `src/lib/roster-staffing.js:58`) stops at this Sunday and knows nothing about publication.

**Ships:** web deploy + OTA. **No migration** (decided, see below). **DEPLOY ORDER:** one merge does both. Vercel deploys the route, the Today chip and the cron arm; because `shared/**`, `mobile/lib/**`, `mobile/components/**` and `mobile/app/**` change, `eas-update.yml` **publishes an OTA at 100%**. Either half is safe alone: a phone on the new bundle that reaches a not-yet-deployed route gets a 404, which `fetchRosterRunway` turns into "no chip"; a phone on the old bundle that receives the push shows it, and the tap does nothing (unknown `data.type` is logged, never a crash). The first push goes out at the next 08:00 UTC tick.

**Decisions (each pinned by a test below):**
- **Which weeks.** This Mon-Sun week, next week, the week after. A 10-day horizon can never reach a fourth week (the third Monday is at most 14 days off). Only blocks dated **today or later** count: a past shift nobody covered is history (`futureBlockStaffing`, `shared/roster-staffing.js:71`).
- **Not ready** = some block has **no live coach**, or some block is **not on a published roster**. "Published" is exactly what a coach can see: `shift_blocks.roster_id -> rosters.status = 'published'` (a `superseded` roster is not published, and a draft awaiting approval tags no blocks at all).
- **Severity:** the week's Monday is 6-10 days away: `amber`. 5 or fewer (including the current week): `red`. More than 10: nothing.
- **Below-minimum alone does not raise it.** The brief says "unpublished or has unstaffed blocks". A built, published week that is one coach short is the existing staffing chip's job. `underMin` rides along for the copy only.
- **Zero blocks says nothing.** And a studio with **no active shift template that has a weekday** is skipped before its blocks are even read (Hatch Street today, and every non-gym location), so leftover blocks from a retired template can never raise an alert nobody can clear.
- **Who.** "Can publish rosters at that location" is `MANAGER_ROLES` AT that location: the gate on `POST /api/schedule/rosters` (`src/app/api/schedule/rosters/route.js:167`), i.e. `master`, `owner`, `manager`, `head_coach`. The brief says "managers/owners"; head coaches are included because the route lets them publish. The push goes to `['owner', 'manager', 'head_coach']`; `resolveRoleRecipientIds` (`src/lib/push.js:364`) always adds masters.
- **Which cron.** `/api/cron/contract-reminders` (`0 8 * * *`). Justification: (1) the hour. 08:00 UTC is 08:00 / 09:00 in Dublin, a civil time to tell a manager next week is not built. The roster cron, `extend-roster-horizon`, runs at 03:20 UTC and would push at 04:20. (2) It is already a once-a-day staff nudge with a single linear path and a heartbeat that carries an outcome object, so the arm is ten lines. `run-scheduled-reports` (07:00) has two exit paths and an early return; `equipment-inspection-reminder` (06:00 UTC) is 06:00 in winter. (3) `vercel.json` already has 79 entries.
- **Heartbeat, and why no mig 620.** No cron in the repo stamps two heartbeat names; the convention is one row per route. The arm's outcome rides in `cron_heartbeats.last_outcome.runway` on the existing `contract-reminders` row (seeded by mig 445, so `stampHeartbeat` has a row to write). A runway failure is logged at error level and recorded as `runway: { error }`; it does **not** withhold the contract-reminders stamp, the same partial-failure posture `extend-roster-horizon` documents (mig 601). A new heartbeat row was the only reason a migration could be needed, so there is none.
- **Idempotency** is `push_event_sends` (mig 349) via `notifyUsersAtRolesOnce` (`src/lib/push-dedup.js:153`), key `roster_runway:<location>:<weekStart>:<severity>`, one claim row per recipient. Rows are pruned after 30 days; a week leaves the horizon after at most 17.
- **Trap found while reading:** the `schedule` category has `fallbackEmail: true` with `emailSubject: 'Your schedule has been published'` (`src/lib/notifications-registry.js:78-93`). A manager with no device would get the runway alert by email **under that subject**. `notifyUsers` prefers `payload.emailSubject` (`src/lib/notify.js:110`), so the arm passes its own.
- **Brief correction:** `fetchStaffingGapsThisWeek` lives in `src/lib/roster-staffing.js`, not `shared/dashboard-data.js`. It is not called, because it is hard-wired to "today .. this Sunday" and returns three estate-wide totals. What IS reused is the part that matters: `futureBlockStaffing` (the single staffing answer) and the same select shape, plus the `rosters:roster_id ( status )` embed the manager blocks feed already uses (`src/app/api/schedule/blocks/route.js:53`).
- **Known limit, accepted:** `/schedule` (web) and the Schedule tab (mobile) show the user's ACTIVE studio. A manager of two studios who taps an alert for the other one lands on the right week of the wrong studio. The chip and the push both name the studio for that reason.

**Prerequisite:** your own fresh worktree off `origin/main` (`git fetch origin main && git worktree add ../un1t-crm-runway -b runway-1 origin/main`), `npm ci` once. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` locally (8GB machine). **This PR adds a route, a component and new imports, which is exactly what only `next build` catches** (CLAUDE.md), so watch the PR's **Next build** check.

**Files:**

| File | Responsibility |
|---|---|
| `shared/roster-runway.js` (create) | the pure rule, the per-week counter, the copy |
| `shared/roster-runway.test.js` (create) | tests for it |
| `src/lib/roster-runway-data.js` (create) | server read: counts per location for 3 weeks |
| `src/lib/roster-runway-data.test.js` (create) | tests for it |
| `src/app/api/schedule/runway/route.js` (create) | manager-gated GET for mobile |
| `src/app/api/schedule/runway/route.test.js` (create) | gate tests |
| `src/lib/openapi.js` (modify: insert after line 4451) | register the route |
| `src/components/dashboard/RosterRunwayChip.jsx` (create) | the web chip |
| `src/components/dashboard/RosterRunwayChip.test.jsx` (create) | render test |
| `src/app/dashboard/today/page.js` (modify: lines 25, 35, 219-236, after 399) | read + render the chip |
| `src/lib/roster-runway-notify.js` (create) | the daily push arm |
| `src/lib/roster-runway-notify.test.js` (create) | tests for it |
| `src/app/api/cron/contract-reminders/route.js` (modify: lines 27, 130-133) | run the arm, record its outcome |
| `src/app/api/cron/contract-reminders/route.test.js` (create) | wiring test (the route has none today) |
| `mobile/lib/notification-nav.js` (modify: after line 84) | `roster_runway` tap |
| `mobile/lib/notification-nav.test.js` (modify) | test for it |
| `mobile/lib/schedule-manage.js` (modify: after line 99) | `scheduleViewFromParam` |
| `mobile/lib/schedule-manage.test.js` (modify) | test for it |
| `mobile/app/(staff)/(tabs)/schedule.jsx` (modify: lines 37, 310-319, 425-427) | honour `?view=manage` |
| `mobile/lib/dashboard-api.js` (modify: lines 61-71) | `fetchRosterRunway`, folded into `fetchStudioDashboard` |
| `mobile/lib/dashboard-api.test.js` (modify) | tests for it, and one existing `toEqual` that gains a key |
| `mobile/components/dashboard/StudioDashboard.jsx` (modify: lines 8-15, 20-32, 78, 88) | the mobile chip |
| `src/lib/push-channels.test.js` (modify: line 19) | add the type to `STAFF_TYPES` |
| `docs/CHANGELOG.md` (modify) | row keyed by the PR number, added after `gh pr create` |

Naming trap, already avoided: `tests/shared-pair-sync.test.js` makes you classify (a) any module with the same filename in `shared/` and `src/lib/`, and (b) any export NAME the two trees share. So the server file is `roster-runway-data.js`, not `roster-runway.js`, and the date helpers in `shared/roster-runway.js` stay private (`src/lib/invoice-extraction.js:132` already exports `addDaysIso`, `src/lib/hyrox/mapping.js:32` exports `daysBetween`).

If SHIFTREMIND.1 has merged first, `mobile/lib/notification-nav.js`, its test and `src/lib/push-channels.test.js` already carry a `shift_reminder` line next to where you edit; keep it and add yours beside it.

---

### Task 1: `rosterRunway(weeks, today)` — the pure rule

**Files:**
- Create: `shared/roster-runway.js`
- Create: `shared/roster-runway.test.js`

Dates here are timezoneless `YYYY-MM-DD` strings and the caller supplies the Dublin "today". All arithmetic goes through `Date.UTC`, so a 23-hour or 25-hour DST day cannot move a calendar day. `check:guardrails` bans `new Date().toISOString().slice(...)` (the no-argument "UTC today" form); `new Date(ms).toISOString().slice(0, 10)` with an argument is the allowed form (`addDaysISO` in `src/lib/dublin-time.js:81` does the same).

The test file imports three names Task 2 adds (`runwayWeeksFromBlocks`, `rosterRunwayHeadline`, `rosterRunwayDetail`). Until then they are `undefined`, which is harmless because nothing in this task calls them.

- [ ] **Step 1: Write the failing test**

Create `shared/roster-runway.test.js`:

```js
// RUNWAY.1 — the roster runway: which upcoming week is not ready, and how loud.
// Pure date-string arithmetic: no clock, no timezone, no database.

import { describe, it, expect } from 'vitest'
import {
  RUNWAY_AMBER_DAYS, RUNWAY_RED_DAYS,
  runwayWindow, runwayWeeksFromBlocks, rosterRunway, rosterRunwayHeadline, rosterRunwayDetail,
} from './roster-runway.js'

const ready = (weekStart, n = 34) => ({ weekStart, blocks: n, staffed: n, underMin: 0, published: n })
const unbuilt = (weekStart, n = 34) => ({ weekStart, blocks: n, staffed: 0, underMin: 0, published: 0 })

// The live case: Sat 19 Sep 2026. This week and next are fine; w/c 28 Sep is not.
const LIVE = [ready('2026-09-14', 4), ready('2026-09-21'), unbuilt('2026-09-28')]

describe('runwayWindow', () => {
  it('is today to the Sunday of the third Mon-Sun week', () => {
    expect(runwayWindow('2026-09-19')).toEqual({
      from: '2026-09-19', to: '2026-10-04', weekStarts: ['2026-09-14', '2026-09-21', '2026-09-28'],
    })
  })
  it('a Monday is its own week start; a Sunday belongs to the week that began six days earlier', () => {
    expect(runwayWindow('2026-09-21').weekStarts[0]).toBe('2026-09-21')
    expect(runwayWindow('2026-09-27').weekStarts[0]).toBe('2026-09-21')
  })
  it('DST weeks are still seven calendar days (25 Oct 2026 is a 25-hour day, 29 Mar a 23-hour one)', () => {
    expect(runwayWindow('2026-10-25').weekStarts).toEqual(['2026-10-19', '2026-10-26', '2026-11-02'])
    expect(runwayWindow('2026-03-29').weekStarts).toEqual(['2026-03-23', '2026-03-30', '2026-04-06'])
  })
})

describe('rosterRunway', () => {
  it('the live case: 19 Sep, w/c 28 Sep is 9 days off with 0 of 34 staffed and nothing published -> amber', () => {
    expect(rosterRunway(LIVE, '2026-09-19')).toEqual({
      weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
      blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
    })
  })

  // [today, expected severity or null] for the same unbuilt w/c 28 Sep
  it.each([
    ['2026-09-17', null],    // 11 days: outside the horizon
    ['2026-09-18', 'amber'], // 10 days: the horizon is inclusive
    ['2026-09-22', 'amber'], // 6 days
    ['2026-09-23', 'red'],   // 5 days: the red line is inclusive
    ['2026-09-27', 'red'],   // tomorrow
    ['2026-09-28', 'red'],   // it is now this week
    ['2026-10-04', 'red'],   // its Sunday
    ['2026-10-05', null],    // fully past
  ])('on %s the unbuilt week of 28 Sep reads %s', (today, severity) => {
    expect(rosterRunway([unbuilt('2026-09-28')], today)?.severity ?? null).toBe(severity)
  })

  it('pins the two thresholds the table above rests on', () => {
    expect(RUNWAY_AMBER_DAYS).toBe(10)
    expect(RUNWAY_RED_DAYS).toBe(5)
  })

  it('returns the FIRST unready week, even when a later one is worse', () => {
    const weeks = [ready('2026-09-14'), { ...ready('2026-09-21'), published: 30 }, unbuilt('2026-09-28')]
    expect(rosterRunway(weeks, '2026-09-19')).toMatchObject({ weekStart: '2026-09-21', severity: 'red', unpublished: 4, unstaffed: 0 })
  })

  it('input order does not matter', () => {
    expect(rosterRunway([...LIVE].reverse(), '2026-09-19').weekStart).toBe('2026-09-28')
  })

  it('staffed but unpublished is unready; published but with an empty block is unready', () => {
    expect(rosterRunway([{ ...ready('2026-09-28'), published: 0 }], '2026-09-19')).toMatchObject({ unstaffed: 0, unpublished: 34 })
    expect(rosterRunway([{ ...ready('2026-09-28'), staffed: 33 }], '2026-09-19')).toMatchObject({ unstaffed: 1, unpublished: 0 })
  })

  it('a fully staffed, fully published week is ready, and below-minimum alone does not raise it', () => {
    expect(rosterRunway([ready('2026-09-28')], '2026-09-19')).toBeNull()
    expect(rosterRunway([{ ...ready('2026-09-28'), underMin: 5 }], '2026-09-19')).toBeNull()
  })

  it('a studio with no blocks at all (no active shift templates) produces nothing', () => {
    const none = (ws) => ({ weekStart: ws, blocks: 0, staffed: 0, underMin: 0, published: 0 })
    expect(rosterRunway([none('2026-09-14'), none('2026-09-21'), none('2026-09-28')], '2026-09-19')).toBeNull()
  })

  it('tolerates null, empty and malformed input', () => {
    expect(rosterRunway(null, '2026-09-19')).toBeNull()
    expect(rosterRunway([], '2026-09-19')).toBeNull()
    expect(rosterRunway([{ blocks: 3 }, null], '2026-09-19')).toBeNull()
  })

  it('never reports more staffed or published than there are blocks', () => {
    expect(rosterRunway([{ weekStart: '2026-09-28', blocks: 2, staffed: 9, underMin: 0, published: 0 }], '2026-09-19'))
      .toMatchObject({ staffed: 2, unstaffed: 0, unpublished: 2 })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/roster-runway.test.js`
Expected: `Test Files 1 failed`, `no tests`, `Error: Cannot find module './roster-runway.js'`.

- [ ] **Step 3: Minimal implementation**

Create `shared/roster-runway.js`:

```js
// RUNWAY.1 — roster runway: is the next week coming up ready?
//
// Live on 2026-09-19: the week of 28 Sep was 9 days away with 0 of 34 shifts
// staffed and nothing published, and no surface said so. Rosters are built in
// monthly batches, and the first week's lead time had slipped from 20 days to
// 12-14. The this-week staffing chip (shared/roster-staffing.js) cannot see
// it: it stops at Sunday and knows nothing about publication.
//
// `rosterRunway` is the one answer, shared by the web Today chip, the mobile
// Studio dashboard chip and the daily push, so the three cannot disagree.
//
// Dependency-free apart from roster-staffing: `shared/` is the mobile seam and
// cannot import src/lib. Dates are timezoneless YYYY-MM-DD strings; the caller
// supplies the Dublin "today" (dublinTodayStr on the server). All arithmetic
// goes through Date.UTC so a 23h / 25h DST day can never shift a calendar day.

export const RUNWAY_AMBER_DAYS = 10
export const RUNWAY_RED_DAYS = 5
export const RUNWAY_WEEKS = 3

const DAY_MS = 24 * 60 * 60 * 1000
const utcMs = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10)

// Whole calendar days from `fromIso` to `toIso` (negative when `toIso` is
// earlier). These three date helpers are deliberately NOT exported: src/lib
// already exports an `addDaysIso` (invoice-extraction.js) and a `daysBetween`
// (hyrox/mapping.js), and tests/shared-pair-sync.test.js makes any export name
// shared between shared/ and src/lib a pair someone must classify.
function daysBetween(fromIso, toIso) {
  return Math.round((utcMs(toIso) - utcMs(fromIso)) / DAY_MS)
}

// The Monday of the Mon-Sun week containing `dateIso`.
function weekStartIso(dateIso) {
  const ms = utcMs(dateIso)
  const daysSinceMonday = (new Date(ms).getUTCDay() + 6) % 7
  return isoOf(ms - daysSinceMonday * DAY_MS)
}

function addDaysIso(dateIso, days) {
  return isoOf(utcMs(dateIso) + days * DAY_MS)
}

/**
 * The block-date window the reader must fetch: today to the Sunday of the
 * third week (this week, next week, the week after). A 10-day horizon can
 * never reach a fourth week, because the third Monday is at most 14 days off.
 */
export function runwayWindow(todayIso) {
  const thisMonday = weekStartIso(todayIso)
  return {
    from: todayIso,
    to: addDaysIso(thisMonday, RUNWAY_WEEKS * 7 - 1),
    weekStarts: Array.from({ length: RUNWAY_WEEKS }, (_, i) => addDaysIso(thisMonday, i * 7)),
  }
}

/**
 * The first week, soonest first, whose Monday is within 10 days and that is
 * not ready: some block has no coach, or some block is not published.
 *
 *   severity 'red'   — the week starts in 5 days or fewer (or is this week)
 *   severity 'amber' — it starts in 6 to 10 days
 *
 * Returns null when every week inside the horizon is ready. A week with ZERO
 * blocks says nothing: a studio with no shift templates has no blocks at all,
 * and "0 of 0" is not a roster that needs building.
 *
 * `underMin` rides along for the copy but does not raise the alert on its own:
 * this is about a roster that has not been BUILT, and a built week that is one
 * coach short is the staffing chip's job.
 *
 * @param {Array<{ weekStart: string, blocks: number, staffed: number, underMin: number, published: number }>} weeks
 * @param {string} todayIso
 */
export function rosterRunway(weeks, todayIso) {
  const sorted = (weeks || [])
    .filter((w) => w?.weekStart)
    .slice()
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))

  for (const w of sorted) {
    const daysAway = daysBetween(todayIso, w.weekStart)
    if (daysAway > RUNWAY_AMBER_DAYS) break
    if (daysAway < -6) continue // a week that has fully passed
    const blocks = Number(w.blocks) || 0
    if (blocks === 0) continue
    const staffed = Math.min(blocks, Number(w.staffed) || 0)
    const published = Math.min(blocks, Number(w.published) || 0)
    const unstaffed = blocks - staffed
    const unpublished = blocks - published
    if (unstaffed === 0 && unpublished === 0) continue
    return {
      weekStart: w.weekStart,
      daysAway,
      severity: daysAway <= RUNWAY_RED_DAYS ? 'red' : 'amber',
      blocks,
      staffed,
      underMin: Number(w.underMin) || 0,
      published,
      unstaffed,
      unpublished,
    }
  }
  return null
}
```

- [ ] **Step 4: Run it, expect PASS, under two host timezones**

Run: `npx vitest run shared/roster-runway.test.js && TZ=America/Los_Angeles npx vitest run shared/roster-runway.test.js`
Expected: `20 passed` twice.

- [ ] **Step 5: Commit**

```bash
git add shared/roster-runway.js shared/roster-runway.test.js
git commit -m "RUNWAY.1 — rosterRunway: first unready week inside 10 days, amber then red at 5

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Per-week counts from block rows, and the copy

**Files:**
- Modify: `shared/roster-runway.js`
- Modify: `shared/roster-runway.test.js`

`futureBlockStaffing(block, todayIso)` → `{ status: 'empty'|'short'|'ok', count, min } | null` (`shared/roster-staffing.js:71`); `null` means the block is in the past. It counts only live assignments, so a cancelled coach is no coach.

- [ ] **Step 1: Write the failing test**

Append to `shared/roster-runway.test.js`:

```js
describe('runwayWeeksFromBlocks', () => {
  const block = (block_date, { coaches = 0, min = 1, roster = null, cancelled = 0 } = {}) => ({
    block_date,
    min_coaches: min,
    rosters: roster ? { status: roster } : null,
    shift_assignments: [
      ...Array.from({ length: coaches }, () => ({ status: 'scheduled' })),
      ...Array.from({ length: cancelled }, () => ({ status: 'cancelled' })),
    ],
  })

  it('counts only today-or-later blocks inside the three weeks, per Mon-Sun week', () => {
    const weeks = runwayWeeksFromBlocks([
      block('2026-09-18', { coaches: 0 }),                                   // yesterday: history
      block('2026-09-19', { coaches: 1, roster: 'published' }),              // today
      block('2026-09-28', { coaches: 1, min: 2 }),                           // short, unpublished
      block('2026-09-29', { coaches: 0, cancelled: 1, roster: 'superseded' }), // a cancelled coach is no coach; superseded is not published
      block('2026-10-05', { coaches: 0 }),                                   // a fourth week: out of the window
    ], '2026-09-19')
    expect(weeks).toEqual([
      { weekStart: '2026-09-14', blocks: 1, staffed: 1, underMin: 0, published: 1 },
      { weekStart: '2026-09-21', blocks: 0, staffed: 0, underMin: 0, published: 0 },
      { weekStart: '2026-09-28', blocks: 2, staffed: 1, underMin: 1, published: 0 },
    ])
  })

  it('feeds rosterRunway: the same rows give the alert', () => {
    const weeks = runwayWeeksFromBlocks([block('2026-09-28', { coaches: 1, min: 2 }), block('2026-09-29')], '2026-09-19')
    expect(rosterRunway(weeks, '2026-09-19')).toMatchObject({ weekStart: '2026-09-28', blocks: 2, unstaffed: 1, underMin: 1, unpublished: 2 })
  })

  it('no rows -> three empty weeks', () => {
    expect(runwayWeeksFromBlocks(null, '2026-09-19').map((w) => w.blocks)).toEqual([0, 0, 0])
  })
})

describe('copy', () => {
  const r = rosterRunway(LIVE, '2026-09-19')
  it('headline names the week, and the studio when asked', () => {
    expect(rosterRunwayHeadline(r)).toBe('Week of 28 Sep is not ready')
    expect(rosterRunwayHeadline(r, { locationName: 'Studio North' })).toBe('Studio North: week of 28 Sep is not ready')
  })
  it('detail says how far off and what is missing', () => {
    expect(rosterRunwayDetail(r)).toBe('Starts in 9 days: 34 of 34 shifts have no coach, not published.')
    expect(rosterRunwayDetail({ ...r, daysAway: 1, staffed: 33, unstaffed: 1, underMin: 2, published: 30, unpublished: 4 }))
      .toBe('Starts tomorrow: 1 of 34 shifts has no coach, 2 below the minimum, 4 shifts not published.')
    expect(rosterRunwayDetail({ ...r, daysAway: -2, blocks: 1, unstaffed: 1, unpublished: 0 }))
      .toBe('This week: 1 of 1 shift has no coach.')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/roster-runway.test.js`
Expected: `5 failed | 20 passed`: three `TypeError: runwayWeeksFromBlocks is not a function`, one each for `rosterRunwayHeadline` and `rosterRunwayDetail`.

- [ ] **Step 3: Minimal implementation**

In `shared/roster-runway.js` add this import directly under the header comment (above `export const RUNWAY_AMBER_DAYS`):

```js
import { futureBlockStaffing } from './roster-staffing.js'
```

and append to the end of the file:

```js
/**
 * Per-week counts from raw shift_blocks rows (ONE location's rows).
 *
 *   blocks    — blocks dated today or later (a past shift is history)
 *   staffed   — of those, blocks with at least one LIVE coach
 *   underMin  — of the staffed ones, blocks below their min_coaches
 *   published — blocks whose roster is published, i.e. exactly what a coach
 *               can see (`rosters.status === 'published'`; superseded is NOT)
 *
 * Staffing is futureBlockStaffing's answer, the same one the calendar, the
 * banner and the this-week chip use, so a cancelled assignment is not a coach.
 *
 * @param {Array<object>} blocks  rows: block_date, min_coaches, rosters: { status }, shift_assignments: [{ status }]
 * @param {string} todayIso
 * @returns {Array<{ weekStart: string, blocks: number, staffed: number, underMin: number, published: number }>}
 */
export function runwayWeeksFromBlocks(blocks, todayIso) {
  const byWeek = new Map(
    runwayWindow(todayIso).weekStarts.map((ws) => [ws, { weekStart: ws, blocks: 0, staffed: 0, underMin: 0, published: 0 }]),
  )
  for (const b of blocks || []) {
    const s = futureBlockStaffing(b, todayIso)
    if (!s) continue // past, or unreadable
    const week = byWeek.get(weekStartIso(b.block_date))
    if (!week) continue // beyond the third week
    week.blocks++
    if (s.status !== 'empty') week.staffed++
    if (s.status === 'short') week.underMin++
    if (b.rosters?.status === 'published') week.published++
  }
  return [...byWeek.values()]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (iso) => {
  const [, m, d] = String(iso).split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}`
}
const plural = (n, one, many) => (n === 1 ? one : many)

/** "Week of 28 Sep is not ready", or "Studio North: week of 28 Sep is not ready". */
export function rosterRunwayHeadline(runway, { locationName = '' } = {}) {
  const lead = locationName ? `${locationName}: week` : 'Week'
  return `${lead} of ${shortDate(runway.weekStart)} is not ready`
}

/** "Starts in 9 days: 34 of 34 shifts have no coach, not published." */
export function rosterRunwayDetail(runway) {
  const parts = []
  if (runway.unstaffed > 0) {
    parts.push(`${runway.unstaffed} of ${runway.blocks} ${plural(runway.blocks, 'shift', 'shifts')} ${plural(runway.unstaffed, 'has', 'have')} no coach`)
  }
  if (runway.underMin > 0) parts.push(`${runway.underMin} below the minimum`)
  if (runway.unpublished === runway.blocks) parts.push('not published')
  else if (runway.unpublished > 0) parts.push(`${runway.unpublished} ${plural(runway.unpublished, 'shift', 'shifts')} not published`)
  const when = runway.daysAway <= 0
    ? 'This week'
    : runway.daysAway === 1 ? 'Starts tomorrow' : `Starts in ${runway.daysAway} days`
  return `${when}: ${parts.join(', ')}.`
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run shared/roster-runway.test.js tests/shared-pair-sync.test.js`
Expected: `25 passed`, and the pair-sync suite passes (no export name collides with `src/lib`).

- [ ] **Step 5: Commit**

```bash
git add shared/roster-runway.js shared/roster-runway.test.js
git commit -m "RUNWAY.1 — per-week block counts (future, live, published) and the chip/push copy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The server reader — counts per location for the next three weeks

**Files:**
- Create: `src/lib/roster-runway-data.js`
- Create: `src/lib/roster-runway-data.test.js`

Signatures and columns you build on, all verified against `supabase/migrations/`:
- `selectAll(buildQuery, { pageSize = 1000 })` (`src/lib/select-all.js:46`): `buildQuery(from, to)` must return a query that already carries `.order(...)` AND `.range(from, to)`.
- `shift_templates(location_id, active)` mig 010, `days_of_week text[]` mig 067. An empty `days_of_week` generates no blocks (the column's own comment), so it does not count as an active template.
- `shift_blocks(id, location_id, block_date, roster_id)` mig 067, `min_coaches` mig 177; `shift_assignments(profile_id, status)`; `rosters(status)`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/roster-runway-data.test.js`:

```js
// RUNWAY.1 — the runway reader: which locations are read, what window, and
// that a failed read is a failure (never "ready").

import { describe, it, expect } from 'vitest'
import { fetchRosterRunways } from './roster-runway-data'

const TODAY = '2026-09-19'
const NORTH = 'loc-north'
const SOUTH = 'loc-south' // no active templates: the Hatch Street case

function makeDb({ templates = [], templatesError = null, blocks = [], blocksError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, filters: [] }
      calls.push(call)
      const result = table === 'shift_templates'
        ? { data: templates, error: templatesError }
        : { data: blocks, error: blocksError }
      const b = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'range']) {
        b[m] = (...args) => { call.filters.push([m, ...args]); return b }
      }
      b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
      return b
    },
  }
}

const tpl = (location_id, days_of_week = ['mon']) => ({ location_id, days_of_week })
const block = (location_id, block_date, { coaches = 0, roster = null } = {}) => ({
  id: `${location_id}-${block_date}`, location_id, block_date, min_coaches: 1,
  rosters: roster ? { status: roster } : null,
  shift_assignments: Array.from({ length: coaches }, () => ({ profile_id: 'p', status: 'scheduled' })),
})

describe('fetchRosterRunways', () => {
  it('no locations -> no queries', async () => {
    const db = makeDb()
    expect(await fetchRosterRunways(db, [], { todayIso: TODAY })).toEqual({ success: true, data: { byLocation: {} } })
    expect(db.calls).toEqual([])
  })

  it('a location with no active template is null and its blocks are never read', async () => {
    const db = makeDb({ templates: [tpl(NORTH)], blocks: [block(NORTH, '2026-09-28')] })
    const res = await fetchRosterRunways(db, [NORTH, SOUTH], { todayIso: TODAY })
    expect(res.success).toBe(true)
    expect(res.data.byLocation[SOUTH]).toBeNull()
    expect(res.data.byLocation[NORTH]).toMatchObject({ weekStart: '2026-09-28', severity: 'amber', unstaffed: 1, unpublished: 1 })
    const blockCall = db.calls.find((c) => c.table === 'shift_blocks')
    expect(blockCall.filters).toContainEqual(['in', 'location_id', [NORTH]])
  })

  it('a template with no weekdays generates nothing, so it does not count as active', async () => {
    const db = makeDb({ templates: [tpl(NORTH, [])] })
    const res = await fetchRosterRunways(db, [NORTH], { todayIso: TODAY })
    expect(res.data.byLocation).toEqual({ [NORTH]: null })
    expect(db.calls.map((c) => c.table)).toEqual(['shift_templates'])
  })

  it('reads today to the Sunday of the third week, ordered and ranged (the 1,000-row cap)', async () => {
    const db = makeDb({ templates: [tpl(NORTH)] })
    await fetchRosterRunways(db, [NORTH], { todayIso: TODAY })
    const f = db.calls.find((c) => c.table === 'shift_blocks').filters
    expect(f).toContainEqual(['gte', 'block_date', '2026-09-19'])
    expect(f).toContainEqual(['lte', 'block_date', '2026-10-04'])
    expect(f).toContainEqual(['order', 'id', { ascending: true }])
    expect(f).toContainEqual(['range', 0, 999])
  })

  it("keeps each location's blocks apart", async () => {
    const db = makeDb({
      templates: [tpl(NORTH), tpl(SOUTH)],
      blocks: [block(NORTH, '2026-09-28', { coaches: 1, roster: 'published' }), block(SOUTH, '2026-09-28')],
    })
    const { data } = await fetchRosterRunways(db, [NORTH, SOUTH], { todayIso: TODAY })
    expect(data.byLocation[NORTH]).toBeNull()
    expect(data.byLocation[SOUTH]).toMatchObject({ weekStart: '2026-09-28' })
  })

  it('a failed read is a failure, never "every week is ready"', async () => {
    expect(await fetchRosterRunways(makeDb({ templatesError: { message: 'tpl down' } }), [NORTH], { todayIso: TODAY }))
      .toEqual({ success: false, error: 'tpl down' })
    expect(await fetchRosterRunways(makeDb({ templates: [tpl(NORTH)], blocksError: { message: 'blocks down' } }), [NORTH], { todayIso: TODAY }))
      .toEqual({ success: false, error: 'blocks down' })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-runway-data.test.js`
Expected: `Test Files 1 failed`, `no tests`, `Cannot find module './roster-runway-data'`.

- [ ] **Step 3: Minimal implementation**

Create `src/lib/roster-runway-data.js`:

```js
// RUNWAY.1 — the server read behind the roster-runway chip and push.
//
// Named -data, not roster-runway.js: a src/lib module with the same filename
// as a shared/ one is a "pair" that tests/shared-pair-sync.test.js makes you
// classify. The rule itself lives in shared/roster-runway.js; this is the IO.
//
// Why this does not call fetchStaffingGapsThisWeek (src/lib/roster-staffing.js):
// that reader is hard-wired to "today .. this Sunday" and returns three totals
// across all locations. The runway needs three weeks, per location, plus each
// block's roster status. What IS reused is the part that matters, the staffing
// answer (futureBlockStaffing, via runwayWeeksFromBlocks) and the same select
// shape, so "staffed" means the same thing on every surface.

import { selectAll } from './select-all'
import { dublinTodayStr } from './dublin-time'
import { runwayWindow, runwayWeeksFromBlocks, rosterRunway } from '@shared/roster-runway'

/**
 * Roster runway per location.
 *
 * A location with no ACTIVE shift template that has at least one weekday is
 * skipped outright (Hatch Street today, and every non-gym location): it has
 * nothing to roster, and leftover blocks from a retired template must not
 * raise an alert nobody can clear.
 *
 * @param {object} db  service-role supabase client
 * @param {string[]} locationIds
 * @param {{ todayIso?: string }} [opts]  the Dublin business day
 * @returns {Promise<{ success: true, data: { byLocation: Record<string, object|null> } } | { success: false, error: string }>}
 */
export async function fetchRosterRunways(db, locationIds, { todayIso = dublinTodayStr() } = {}) {
  const ids = [...new Set((locationIds || []).filter(Boolean))]
  const byLocation = Object.fromEntries(ids.map((id) => [id, null]))
  if (ids.length === 0) return { success: true, data: { byLocation } }

  const { data: templates, error: tplErr } = await db
    .from('shift_templates')
    .select('location_id, days_of_week')
    .eq('active', true)
    .in('location_id', ids)
  if (tplErr) return { success: false, error: tplErr.message }

  const rostered = [...new Set(
    (templates || [])
      .filter((t) => Array.isArray(t.days_of_week) && t.days_of_week.length > 0)
      .map((t) => t.location_id),
  )]
  if (rostered.length === 0) return { success: true, data: { byLocation } }

  const { from, to } = runwayWindow(todayIso)
  let blocks
  try {
    // Paged: three weeks x ~50 blocks x several studios can pass the 1,000-row
    // select cap, and a truncated read would silently call a week "ready".
    blocks = await selectAll((lo, hi) => db
      .from('shift_blocks')
      .select('id, location_id, block_date, min_coaches, rosters:roster_id ( status ), shift_assignments(profile_id, status)')
      .in('location_id', rostered)
      .gte('block_date', from)
      .lte('block_date', to)
      .order('id', { ascending: true })
      .range(lo, hi))
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to read shift blocks' }
  }

  for (const id of rostered) {
    const mine = blocks.filter((b) => b.location_id === id)
    byLocation[id] = rosterRunway(runwayWeeksFromBlocks(mine, todayIso), todayIso)
  }
  return { success: true, data: { byLocation } }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-runway-data.test.js && npm run check:select-columns`
Expected: `6 passed`; the column check exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-runway-data.js src/lib/roster-runway-data.test.js
git commit -m "RUNWAY.1 — fetchRosterRunways: paged three-week read per studio, template-less studios skipped

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `GET /api/schedule/runway` — the manager-gated route mobile reads

**Files:**
- Create: `src/app/api/schedule/runway/route.js`
- Create: `src/app/api/schedule/runway/route.test.js`
- Modify: `src/lib/openapi.js` (insert after the `/api/schedule/week-cost` registration closes, line 4451)

Why a route and not a direct mobile Supabase read: the answer is ABOUT unpublished blocks, which coaches must never see, and every `/api` route is service-role with **no RLS** (CLAUDE.md, first invariant). The gate in this file is the only thing protecting it. It is a copy of `src/app/api/schedule/week-cost/route.js`: `hasRoleAtAnyLocation` → parse → `assertLocationAccess` → `hasRoleAtLocation(user, location_id, MANAGER_ROLES)`. Never `user.role`, which is the ACTIVE studio's role (SCHEDROLES.1).

- [ ] **Step 1: Write the failing test**

Create `src/app/api/schedule/runway/route.test.js`:

```js
// RUNWAY.1 — route contract for GET /api/schedule/runway. The arithmetic is
// pinned in shared/roster-runway.test.js and the read in
// src/lib/roster-runway-data.test.js. Locked here: the gate. This answer is
// about UNPUBLISHED rosters, so a coach must never get it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'service-role' })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    // REAL: the role AT location_id is what is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/roster-runway-data', () => ({ fetchRosterRunways: vi.fn() }))

const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { fetchRosterRunways } = await import('@/lib/roster-runway-data')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const RUNWAY = {
  weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
  blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
}

const req = (params = {}) => {
  const url = new URL('http://test/api/schedule/runway')
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const userWith = (rolesByLocation, profileRole = 'staff') => ({
  id: 'u1', profileRole, rolesByLocation, locations: Object.keys(rolesByLocation).map((id) => ({ id })),
})

beforeEach(() => {
  getCurrentUser.mockReset()
  assertLocationAccess.mockReset().mockReturnValue(null)
  fetchRosterRunways.mockReset().mockResolvedValue({ success: true, data: { byLocation: { [LOC]: RUNWAY } } })
})

describe('GET /api/schedule/runway', () => {
  it('403 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req({ location_id: LOC }))).status).toBe(403)
    expect(fetchRosterRunways).not.toHaveBeenCalled()
  })

  it('403 for a coach: whether a week is published is manager information', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'staff' }))
    expect((await GET(req({ location_id: LOC }))).status).toBe(403)
    expect(fetchRosterRunways).not.toHaveBeenCalled()
  })

  it('403 for the studio where the caller is only staff, even though they manage another', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'head_coach', [OTHER]: 'staff' }))
    expect((await GET(req({ location_id: OTHER }))).status).toBe(403)
    expect(fetchRosterRunways).not.toHaveBeenCalled()
  })

  it('403 from assertLocationAccess is passed straight through', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [OTHER]: 'manager' }))
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }))
    expect((await GET(req({ location_id: LOC }))).status).toBe(403)
    expect(fetchRosterRunways).not.toHaveBeenCalled()
  })

  it('400 on a missing or malformed location_id', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    expect((await GET(req({}))).status).toBe(400)
    expect((await GET(req({ location_id: 'nope' }))).status).toBe(400)
  })

  it('200 for a head coach at the location: reads that ONE location with the service-role client', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'head_coach' }))
    const res = await GET(req({ location_id: LOC }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { runway: RUNWAY } })
    expect(fetchRosterRunways).toHaveBeenCalledWith({ tag: 'service-role' }, [LOC])
  })

  it('a ready studio is runway:null, not a missing key; master is allowed', async () => {
    getCurrentUser.mockResolvedValue(userWith({}, 'master'))
    fetchRosterRunways.mockResolvedValue({ success: true, data: { byLocation: { [LOC]: null } } })
    expect(await (await GET(req({ location_id: LOC }))).json()).toEqual({ success: true, data: { runway: null } })
  })

  it('500 when the read fails: never "ready" by default', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'owner' }))
    fetchRosterRunways.mockResolvedValue({ success: false, error: 'blocks down' })
    const res = await GET(req({ location_id: LOC }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'blocks down' })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/runway/route.test.js`
Expected: `Test Files 1 failed`, `no tests`, `Cannot find module './route.js'`.

- [ ] **Step 3: Minimal implementation**

Create `src/app/api/schedule/runway/route.js`:

```js
// RUNWAY.1 — GET /api/schedule/runway
//
// The roster runway for ONE location: the first week inside a 10-day horizon
// that is unpublished or has a shift with no coach, or null when every week is
// ready. Drives the mobile Studio dashboard chip. (The web Today page calls
// fetchRosterRunways directly; it is a server component.)
//
// A route rather than a direct mobile Supabase read on purpose: the answer is
// ABOUT unpublished blocks, which coaches must never see, and mobile's
// authenticated client is RLS-bound. The gate below is the only thing that
// matters here, since a service-role route gets no RLS at all.
//
// Gate: MANAGER_ROLES AT location_id (hasRoleAtLocation, never `user.role`,
// which is the ACTIVE studio's role), after assertLocationAccess. location_id
// is a query param, so a foreign location is a 403; the 404 rule is for
// detail routes whose id comes from the path.
//
// Query params:  location_id  uuid (required)
// Returns:       { success, data: { runway: null | { weekStart, daysAway,
//                  severity, blocks, staffed, underMin, published, unstaffed,
//                  unpublished } } }

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { fetchRosterRunways } from '@/lib/roster-runway-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({ location_id: uuidLike })

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({ location_id: url.searchParams.get('location_id') })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }
  const { location_id } = parsed.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const res = await fetchRosterRunways(createServerClient(), [location_id])
  if (!res.success) {
    return NextResponse.json({ success: false, error: res.error }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { runway: res.data.byLocation[location_id] ?? null } })
}
```

Register it in `src/lib/openapi.js`, directly after the `/api/schedule/week-cost` block (it ends `})` on line 4451):

```js
// RUNWAY.1 — is the next week coming up built and published? One studio.
registry.registerPath({
  method: 'get',
  path: '/api/schedule/runway',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Roster runway for one studio (manager-only)',
  description: "The first Mon-Sun week, out of this week and the next two, whose Monday is within 10 days and that is not ready: some shift has no live coach, or some shift is not on a published roster. `runway` is null when every week inside the horizon is ready, and for a studio with no active shift template. severity is 'red' at 5 days or fewer (including the current week) and 'amber' at 6 to 10. Counts cover shifts dated today or later only. Manager-only (master, owner, manager, head_coach AT location_id) and scoped by assertLocationAccess: whether a week is published is not coach information. Drives the mobile Studio dashboard chip; the web Today page reads the same function server-side.",
  responses: {
    200: { description: '{ runway: null | { weekStart, daysAway, severity, blocks, staffed, underMin, published, unstaffed, unpublished } }' },
    400: { description: 'Missing or malformed location_id', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — needs a manager role at that location', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'The roster read failed (never reported as "ready")', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/runway/route.test.js && npm run check:route-guards && npm run check:location-scoping`
Expected: `8 passed`; both checks exit 0 (`getCurrentUser` is the session guard; the handler itself issues no table query, the scoping lives in `assertLocationAccess` + the single `[location_id]` it passes on).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/runway/route.js src/app/api/schedule/runway/route.test.js src/lib/openapi.js
git commit -m "RUNWAY.1 — GET /api/schedule/runway, gated on the manager role AT that studio

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(zsh: none of these paths contain `[brackets]`, so no quoting is needed here.)

---

### Task 5: The web chip on the Today page

**Files:**
- Create: `src/components/dashboard/RosterRunwayChip.jsx`
- Create: `src/components/dashboard/RosterRunwayChip.test.jsx`
- Modify: `src/app/dashboard/today/page.js`

The manager calendar reads `?view=` and `?week=` on mount (`src/components/ScheduleCalendar.jsx:164-175`), so the chip links to `/schedule?view=week&week=<weekStart>`. Colours follow the staffing chip directly above it (`page.js:378-399`): `bg-<c>-500/10` with `text-<c>-700`, the recipe `check:guardrails` (`no-low-contrast-chip`) accepts. Internal links use `<Link>`, never `<a href>` (`@next/next/no-html-link-for-pages` is an error).

The Today page is an async server component with a dozen data dependencies, so the chip is its own component with a static-markup test, and the page edit is wiring only.

- [ ] **Step 1: Write the failing test**

Create `src/components/dashboard/RosterRunwayChip.test.jsx`:

```jsx
// RUNWAY.1 — the chip's contract: nothing when ready, the right week in the
// link, and the severity visible in the markup. Rendered to static markup in
// the node environment (no jsdom), like KanbanBoard.test.jsx.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }) => <a href={typeof href === 'string' ? href : '#'} {...rest}>{children}</a>,
}))

import RosterRunwayChip from './RosterRunwayChip'

const RUNWAY = {
  weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
  blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
}

describe('RosterRunwayChip', () => {
  it('renders nothing when the studio is ready', () => {
    expect(renderToStaticMarkup(<RosterRunwayChip runway={null} />)).toBe('')
  })

  it('links to THAT week on the manager calendar and says what is missing', () => {
    const html = renderToStaticMarkup(<RosterRunwayChip runway={RUNWAY} locationName="Studio North" />)
    expect(html).toContain('href="/schedule?view=week&amp;week=2026-09-28"')
    expect(html).toContain('Studio North: week of 28 Sep is not ready')
    expect(html).toContain('Starts in 9 days: 34 of 34 shifts have no coach, not published.')
    expect(html).toContain('data-severity="amber"')
    expect(html).toContain('text-amber-700')
    expect(html).not.toContain('text-red-700')
  })

  it('is red inside five days, and drops the studio name when there is only one', () => {
    const html = renderToStaticMarkup(<RosterRunwayChip runway={{ ...RUNWAY, daysAway: 4, severity: 'red' }} />)
    expect(html).toContain('data-severity="red"')
    expect(html).toContain('text-red-700')
    expect(html).toContain('Week of 28 Sep is not ready')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/dashboard/RosterRunwayChip.test.jsx`
Expected: `Test Files 1 failed`, `no tests`, `Cannot find module './RosterRunwayChip'`.

- [ ] **Step 3: Minimal implementation**

Create `src/components/dashboard/RosterRunwayChip.jsx`:

```jsx
// RUNWAY.1 — the Today page's roster-runway chip. One per studio whose next
// week is not ready (shared/roster-runway.js decides). Amber inside 10 days,
// red inside 5. Links straight to that week on the manager calendar, which
// reads ?view= and ?week= on mount (ScheduleCalendar.jsx).
//
// Server-renderable: no state, no effects. The caller decides WHO sees it
// (managers at that studio only); this component only draws what it is given.

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { rosterRunwayHeadline, rosterRunwayDetail } from '@shared/roster-runway'

const TONES = {
  red: {
    box: 'border-red-500/40 bg-red-500/10 hover:bg-red-500/15',
    icon: 'text-red-600', title: 'text-red-700', detail: 'text-red-700/80',
  },
  amber: {
    box: 'border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15',
    icon: 'text-amber-600', title: 'text-amber-700', detail: 'text-amber-700/90',
  },
}

export default function RosterRunwayChip({ runway, locationName = '' }) {
  if (!runway) return null
  const tone = TONES[runway.severity] || TONES.amber
  return (
    <Link
      href={`/schedule?view=week&week=${runway.weekStart}`}
      data-testid="roster-runway-chip"
      data-severity={runway.severity}
      className={`block mt-3 p-3 rounded-lg border transition-colors ${tone.box}`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} className={`${tone.icon} mt-0.5 flex-shrink-0`} />
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-medium ${tone.title}`}>
            {rosterRunwayHeadline(runway, { locationName })}
          </div>
          <div className={`text-xs mt-0.5 ${tone.detail}`}>
            {rosterRunwayDetail(runway)} Click to open that week.
          </div>
        </div>
      </div>
    </Link>
  )
}
```

Wire it into `src/app/dashboard/today/page.js` with four edits.

(a) Line 25, add `hasRoleAtLocation`:

```js
import { getCurrentUser, getUserLocationIds, hasRoleAtLocation } from '@/lib/auth'
```

(b) Under the `@/lib/roster-staffing` import (line 35) add:

```js
import { fetchRosterRunways } from '@/lib/roster-runway-data'
import RosterRunwayChip from '@/components/dashboard/RosterRunwayChip'
```

(c) Directly ABOVE the comment `// ROSTERVIS.1 — empty AND below-minimum shifts.` (line 221) start the read, so it runs in parallel with the block below it:

```js
  // RUNWAY.1 — studios where THIS user can publish a roster (the gate on
  // POST /api/schedule/rosters). Deliberately not `locIds` below, which is
  // every studio the user belongs to: whether next week is published is
  // manager information, and hasRoleAtLocation judges the role AT that studio,
  // not the active one. Started here and awaited after the block below so the
  // two reads overlap. A failed read shows NO chip: an alert must never claim
  // a problem it could not read.
  const runwayLocations = (user.locations || []).filter((l) => hasRoleAtLocation(user, l.id, MANAGER_ROLES))
  const runwayPromise = runwayLocations.length > 0
    ? fetchRosterRunways(db, runwayLocations.map((l) => l.id)).catch(() => ({ success: false }))
    : Promise.resolve({ success: false })
```

and directly AFTER that `if (isManager || isOwnerSomewhere) { … }` block closes (after line 238), add:

```js
  const runwayRes = await runwayPromise
  const rosterRunways = runwayRes.success
    ? runwayLocations
        .map((l) => ({ id: l.id, name: l.name, runway: runwayRes.data.byLocation[l.id] }))
        .filter((r) => r.runway)
    : []
```

(`fetchRosterRunways` is an `async function`, so it returns a real Promise and `.catch` is safe. The "builders are thenables, no `.catch`" invariant is about supabase query builders, not this.)

(d) In the JSX, directly after the staffing-gaps chip's closing `)}` (line 399) and before the `{/* Roster v2 phase 3 — pay-data completeness … */}` comment:

```jsx
      {/* RUNWAY.1 — an upcoming week, inside 10 days, that is not built or not
          published. One chip per studio this user can publish at; the studio
          is named only when the user has more than one. */}
      {rosterRunways.map((r) => (
        <RosterRunwayChip key={r.id} runway={r.runway} locationName={showLocation ? r.name : ''} />
      ))}
```

`showLocation` already exists (line 243) and `user.locations` rows are full `locations` rows (`src/lib/auth.js:353`, `select('*')`), so `l.name` is there.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/components/dashboard/RosterRunwayChip.test.jsx && npm run lint && npm run check:guardrails && npm run check:location-scoping`
Expected: `3 passed`; lint and both checks exit 0. (`check:location-scoping` scans this server page since PAGE-SCOPE.1; the page issues no new table query of its own.)

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/RosterRunwayChip.jsx src/components/dashboard/RosterRunwayChip.test.jsx src/app/dashboard/today/page.js
git commit -m "RUNWAY.1 — Today page chip: the unready week, per studio the user can publish at

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The daily push arm

**Files:**
- Create: `src/lib/roster-runway-notify.js`
- Create: `src/lib/roster-runway-notify.test.js`

`notifyUsersAtRolesOnce(db, eventKey, locationId, roles, payload)` (`src/lib/push-dedup.js:153`) resolves the roles to profile ids FIRST, claims one `push_event_sends` row per recipient, sends through `notifyUsers` (push, plus the email fallback for users with zero device tokens), and releases the claims if the send fails outright. It returns the send counts plus `deduped`. Category is the BARE name `schedule` (push.js adds `notify_`); it is already registered and default ON for all six roles (`shared/permissions.js:776` and the five lines like it).

- [ ] **Step 1: Write the failing test**

Create `src/lib/roster-runway-notify.test.js`:

```js
// RUNWAY.1 — the daily push: who, what, and exactly once.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./push-dedup', () => ({ notifyUsersAtRolesOnce: vi.fn() }))
vi.mock('./roster-runway-data', () => ({ fetchRosterRunways: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn() }))

const { notifyUsersAtRolesOnce } = await import('./push-dedup')
const { fetchRosterRunways } = await import('./roster-runway-data')
const { runRosterRunwayAlerts, runwayEventKey, RUNWAY_NOTIFY_ROLES } = await import('./roster-runway-notify')

const NORTH = { id: 'loc-north', name: 'Studio North' }
const SOUTH = { id: 'loc-south', name: 'Studio South' }
const RUNWAY = {
  weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
  blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
}

function makeDb(locations, error = null) {
  const b = { select: () => b, then: (res, rej) => Promise.resolve({ data: locations, error }).then(res, rej) }
  return { from: (table) => { if (table !== 'locations') throw new Error(`unexpected table ${table}`); return b } }
}

beforeEach(() => {
  notifyUsersAtRolesOnce.mockReset().mockResolvedValue({ sent: 2, skipped: 0, invalidated: 0, failed: 0, emailed: 0, deduped: 0 })
  fetchRosterRunways.mockReset().mockResolvedValue({ success: true, data: { byLocation: { [NORTH.id]: RUNWAY, [SOUTH.id]: null } } })
})

describe('runRosterRunwayAlerts', () => {
  it('pushes once for the unready studio, to the roles that can publish, under the schedule category', async () => {
    const db = makeDb([NORTH, SOUTH])
    const outcome = await runRosterRunwayAlerts(db, { todayIso: '2026-09-19' })

    expect(fetchRosterRunways).toHaveBeenCalledWith(db, [NORTH.id, SOUTH.id], { todayIso: '2026-09-19' })
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledWith(
      db,
      'roster_runway:loc-north:2026-09-28:amber',
      NORTH.id,
      ['owner', 'manager', 'head_coach'],
      {
        title: 'Studio North: week of 28 Sep is not ready',
        body: 'Starts in 9 days: 34 of 34 shifts have no coach, not published.',
        category: 'schedule',
        emailSubject: 'Studio North: week of 28 Sep is not ready',
        data: { type: 'roster_runway', location_id: NORTH.id, week_start: '2026-09-28', severity: 'amber' },
      },
    )
    expect(outcome).toEqual({ locations: 2, alerts: 1, sent: 2, emailed: 0, deduped: 0, failed: 0 })
  })

  it('the key changes with severity and week, and with nothing else', () => {
    expect(runwayEventKey('L', RUNWAY)).toBe('roster_runway:L:2026-09-28:amber')
    expect(runwayEventKey('L', { ...RUNWAY, severity: 'red', daysAway: 4, staffed: 10 })).toBe('roster_runway:L:2026-09-28:red')
    expect(RUNWAY_NOTIFY_ROLES).toEqual(['owner', 'manager', 'head_coach'])
  })

  it('a second run the same day is reported as deduped, not as a send', async () => {
    notifyUsersAtRolesOnce.mockResolvedValue({ sent: 0, skipped: 0, invalidated: 0, failed: 0, deduped: 2 })
    const outcome = await runRosterRunwayAlerts(makeDb([NORTH]), { todayIso: '2026-09-19' })
    expect(outcome).toMatchObject({ alerts: 1, sent: 0, deduped: 2 })
  })

  it('nothing unready -> nothing sent', async () => {
    fetchRosterRunways.mockResolvedValue({ success: true, data: { byLocation: { [NORTH.id]: null } } })
    const outcome = await runRosterRunwayAlerts(makeDb([NORTH]), { todayIso: '2026-09-19' })
    expect(notifyUsersAtRolesOnce).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ locations: 1, alerts: 0 })
  })

  it("one studio's send throwing does not cost the next studio its alert", async () => {
    fetchRosterRunways.mockResolvedValue({ success: true, data: { byLocation: { [NORTH.id]: RUNWAY, [SOUTH.id]: RUNWAY } } })
    notifyUsersAtRolesOnce.mockRejectedValueOnce(new Error('expo down'))
    const outcome = await runRosterRunwayAlerts(makeDb([NORTH, SOUTH]), { todayIso: '2026-09-19' })
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(2)
    expect(outcome).toMatchObject({ alerts: 2, failed: 1, sent: 2 })
  })

  it('a failed read throws, so the cron can record it', async () => {
    await expect(runRosterRunwayAlerts(makeDb(null, { message: 'down' }))).rejects.toThrow(/locations read failed/)
    fetchRosterRunways.mockResolvedValue({ success: false, error: 'blocks down' })
    await expect(runRosterRunwayAlerts(makeDb([NORTH]))).rejects.toThrow(/runway read failed: blocks down/)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-runway-notify.test.js`
Expected: `Test Files 1 failed`, `no tests`, `Cannot find module './roster-runway-notify'`.

- [ ] **Step 3: Minimal implementation**

Create `src/lib/roster-runway-notify.js`:

```js
// RUNWAY.1 — the daily roster-runway push. ONE push per location, per week,
// per severity: a week is announced once when it enters the 10-day horizon
// unready (amber) and once more if it is still unready at 5 days (red).
//
// Idempotency is push_event_sends (mig 349) through notifyUsersAtRolesOnce:
// the claim key carries location + week + severity, and each recipient gets
// their own claim row, so a re-run, a retry or a second daily tick is a no-op.
// Rows are pruned after 30 days; a week leaves the horizon after at most 17.

import { notifyUsersAtRolesOnce } from './push-dedup'
import { fetchRosterRunways } from './roster-runway-data'
import { dublinTodayStr } from './dublin-time'
import { rosterRunwayHeadline, rosterRunwayDetail } from '@shared/roster-runway'
import { logWarn } from './log'

// Who may publish a roster: the gate on POST /api/schedule/rosters is
// MANAGER_ROLES at that location. `master` is not listed because
// resolveRoleRecipientIds (src/lib/push.js) always includes masters.
export const RUNWAY_NOTIFY_ROLES = Object.freeze(['owner', 'manager', 'head_coach'])

export const runwayEventKey = (locationId, runway) =>
  `roster_runway:${locationId}:${runway.weekStart}:${runway.severity}`

/**
 * @param {object} db  service-role supabase client
 * @param {{ todayIso?: string }} [opts]
 * @returns {Promise<{ locations: number, alerts: number, sent: number, emailed: number, deduped: number, failed: number }>}
 *   throws when the locations or runway read fails (the cron logs it).
 */
export async function runRosterRunwayAlerts(db, { todayIso = dublinTodayStr() } = {}) {
  const outcome = { locations: 0, alerts: 0, sent: 0, emailed: 0, deduped: 0, failed: 0 }

  const { data: locations, error: locErr } = await db.from('locations').select('id, name')
  if (locErr) throw new Error(`locations read failed: ${locErr.message}`)
  outcome.locations = (locations || []).length
  if (outcome.locations === 0) return outcome

  const res = await fetchRosterRunways(db, locations.map((l) => l.id), { todayIso })
  if (!res.success) throw new Error(`runway read failed: ${res.error}`)

  for (const loc of locations) {
    const runway = res.data.byLocation[loc.id]
    if (!runway) continue
    outcome.alerts++
    const title = rosterRunwayHeadline(runway, { locationName: loc.name })
    try {
      const r = await notifyUsersAtRolesOnce(db, runwayEventKey(loc.id, runway), loc.id, RUNWAY_NOTIFY_ROLES, {
        title,
        body: rosterRunwayDetail(runway),
        category: 'schedule',
        // The `schedule` category's registry subject is "Your schedule has
        // been published", which is the opposite of this message.
        emailSubject: title,
        data: { type: 'roster_runway', location_id: loc.id, week_start: runway.weekStart, severity: runway.severity },
      })
      outcome.sent += r.sent || 0
      outcome.emailed += r.emailed || 0
      outcome.deduped += r.deduped || 0
      outcome.failed += r.failed || 0
    } catch (err) {
      // One studio's failure must not cost the next studio its alert.
      outcome.failed++
      logWarn('roster-runway', 'notify failed for location', { locationId: loc.id, err: err?.message })
    }
  }
  return outcome
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-runway-notify.test.js && npm run check:select-columns`
Expected: `6 passed`; the column check exits 0 (`locations(id, name)`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-runway-notify.js src/lib/roster-runway-notify.test.js
git commit -m "RUNWAY.1 — daily runway push: once per studio, week and severity, to the roles that can publish

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Run the arm from `/api/cron/contract-reminders`

**Files:**
- Modify: `src/app/api/cron/contract-reminders/route.js` (line 27 and lines 130-133)
- Create: `src/app/api/cron/contract-reminders/route.test.js`

No `vercel.json` change and no migration: the cron and its heartbeat row already exist. See "Which cron" and "Heartbeat" in the decisions at the top.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/cron/contract-reminders/route.test.js`:

```js
// RUNWAY.1 — the roster-runway arm's WIRING inside the daily contract-reminders
// cron. The contract half has no route test of its own; this file pins only
// what RUNWAY.1 added: the arm runs, its outcome is recorded on the heartbeat,
// and its failure is contained.

import { describe, it, expect, vi, beforeEach } from 'vitest'

function makeBuilder() {
  const b = {}
  for (const m of ['select', 'in', 'lt', 'order', 'range', 'update', 'eq']) b[m] = () => b
  b.then = (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
  return b
}
const fakeDb = { from: () => makeBuilder() }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/contracts', () => ({ reminderDue: vi.fn(() => false) }))
vi.mock('@/lib/contracts-email', () => ({ sendContractReminderEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => ({ sent: 0 })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/roster-runway-notify', () => ({ runRosterRunwayAlerts: vi.fn() }))

const { GET } = await import('./route.js')
const { runRosterRunwayAlerts } = await import('@/lib/roster-runway-notify')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError } = await import('@/lib/log')

const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})
const OUTCOME = { locations: 3, alerts: 1, sent: 2, emailed: 0, deduped: 0, failed: 0 }

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  runRosterRunwayAlerts.mockResolvedValue(OUTCOME)
})

describe('GET /api/cron/contract-reminders — roster runway arm', () => {
  it('401 without the cron bearer, and the runway arm never runs', async () => {
    expect((await GET(req('Bearer wrong'))).status).toBe(401)
    expect(runRosterRunwayAlerts).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('runs the arm with the service-role client and records its outcome on the heartbeat and the response', async () => {
    const res = await GET(req())
    expect(runRosterRunwayAlerts).toHaveBeenCalledWith(fakeDb)
    expect(stampHeartbeat).toHaveBeenCalledWith('contract-reminders', {
      checked: 0, sent: 0, emailFailed: 0, rowErrors: 0, runway: OUTCOME,
    })
    expect(await res.json()).toMatchObject({ success: true, checked: 0, runway: OUTCOME })
  })

  it('a throwing arm is logged, recorded as an error outcome, and the contract heartbeat is still stamped', async () => {
    runRosterRunwayAlerts.mockRejectedValue(new Error('runway read failed: blocks down'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(logError).toHaveBeenCalledWith('cron-contract-reminders', 'roster runway arm threw', expect.anything())
    expect(stampHeartbeat).toHaveBeenCalledWith('contract-reminders', expect.objectContaining({
      runway: { error: 'runway read failed: blocks down' },
    }))
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/cron/contract-reminders/route.test.js`
Expected: `2 failed | 1 passed`. The first failure reads `expected "vi.fn()" to be called with arguments: [ { from: [Function from] } ]`.

- [ ] **Step 3: Minimal implementation**

(a) Replace line 27, `import { logWarn } from '@/lib/log'`, with:

```js
import { logWarn, logError } from '@/lib/log'
import { runRosterRunwayAlerts } from '@/lib/roster-runway-notify'
```

(b) Replace the last five lines of `GET` (the `await stampHeartbeat('contract-reminders', …)` statement and the final `return`, lines 130-133) with:

```js
  // RUNWAY.1 — second arm: the daily roster-runway push (one per location per
  // week per severity; src/lib/roster-runway-notify.js). It rides this cron
  // because both are once-a-day staff nudges and 08:00 UTC is 08:00/09:00 in
  // Dublin, a civil hour to tell a manager next week is not built; the roster
  // cron (extend-roster-horizon) runs at 03:20 UTC, which is not. Isolated: a
  // runway failure is logged and rides in last_outcome.runway, and never costs
  // the contract reminders their heartbeat (same partial-failure posture as
  // extend-roster-horizon).
  let runway
  try {
    runway = await runRosterRunwayAlerts(db)
  } catch (err) {
    logError('cron-contract-reminders', 'roster runway arm threw', { err })
    runway = { error: err?.message || 'runway arm failed' }
  }

  await stampHeartbeat('contract-reminders', { checked: candidates.length, sent, emailFailed, rowErrors, runway }).catch((err) =>
    logWarn('cron-contract-reminders', 'heartbeat failed', { err }))

  return NextResponse.json({ success: true, checked: candidates.length, sent, emailFailed, rowErrors, runway })
```

(c) Add one line to the file's header comment: `// RUNWAY.1 — also runs the daily roster-runway push (second arm, bottom of GET).`

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/cron/contract-reminders/route.test.js && npm run check:route-guards`
Expected: `3 passed`; the guard check exits 0 (`CRON_SECRET` is still referenced).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/contract-reminders/route.js src/app/api/cron/contract-reminders/route.test.js
git commit -m "RUNWAY.1 — contract-reminders cron runs the roster-runway arm; outcome rides on its heartbeat

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Mobile — the push tap opens that week in Manage mode

**Files:**
- Modify: `mobile/lib/notification-nav.js`, `mobile/lib/notification-nav.test.js`
- Modify: `mobile/lib/schedule-manage.js`, `mobile/lib/schedule-manage.test.js`
- Modify: `mobile/app/(staff)/(tabs)/schedule.jsx`
- Modify: `src/lib/push-channels.test.js` (line 19)

There is NO React Native component test runner in this repo, so the decision ("does this param open Manage mode for this role?") goes in `mobile/lib/` with a vitest test, and the screen only calls it. The Schedule tab already honours `?date=` (`schedule.jsx:310-330`); a manager landing on their own "Me" week of a week they are not rostered in would see an empty list, so the link also asks for Manage mode, which the screen grants to manager roles only.

- [ ] **Step 1: Write the failing tests**

In `mobile/lib/notification-nav.test.js`, directly above `it('routes WhatsApp health/template alerts to the WhatsApp tab', …)`:

```js
  // RUNWAY.1
  it('opens the unready week in Manage mode for a roster-runway alert', () => {
    expect(routeForNotification({ type: 'roster_runway', location_id: 'l1', week_start: '2026-09-28', severity: 'amber' }))
      .toBe('/(tabs)/schedule?date=2026-09-28&view=manage')
    expect(routeForNotification({ type: 'roster_runway' })).toBe('/(tabs)/schedule?view=manage')
    expect(routeForNotification({ type: 'roster_runway', week_start: '28 Sep' })).toBe('/(tabs)/schedule?view=manage')
  })
```

In `mobile/lib/schedule-manage.test.js`, add `scheduleViewFromParam` to the import from `./schedule-manage` (line 4) and append to the end of the file:

```js
// RUNWAY.1 — ?view=manage on the schedule tab.
describe('scheduleViewFromParam', () => {
  it('opens Manage mode for every manager role', () => {
    for (const role of ['master', 'owner', 'manager', 'head_coach']) {
      expect(scheduleViewFromParam('manage', role)).toBe('manage')
    }
  })
  it('never for a coach, whatever the link says', () => {
    expect(scheduleViewFromParam('manage', 'staff')).toBeNull()
    expect(scheduleViewFromParam('manage', 'reception')).toBeNull()
    expect(scheduleViewFromParam('manage', undefined)).toBeNull()
  })
  it('ignores every other value, so an absent or junk param leaves the view alone', () => {
    for (const v of ['', 'me', 'team', 'MANAGE', undefined, null, ['manage']]) {
      expect(scheduleViewFromParam(v, 'owner')).toBeNull()
    }
  })
})
```

In `src/lib/push-channels.test.js` line 19, add `'roster_runway'` to `STAFF_TYPES` on the `schedule_published` line.

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run mobile/lib/notification-nav.test.js mobile/lib/schedule-manage.test.js`
Expected: `1 failed` in the nav file (`expected undefined to be '/(tabs)/schedule?date=2026-09-28&view=manage'`) and `3 failed` in the other (`TypeError: scheduleViewFromParam is not a function`).

- [ ] **Step 3: Minimal implementation**

`mobile/lib/notification-nav.js`, in the `// ── Roster` group after the `shift_adjusted` case (line 84):

```js
    // RUNWAY.1 — manager alert that an upcoming week is not built. Opens that
    // week in Manage mode (schedule.jsx reads ?view=manage for manager roles
    // only; anyone else lands on their own week).
    case 'roster_runway':
      return isIsoDay(data.week_start)
        ? `/(tabs)/schedule?date=${data.week_start}&view=manage`
        : '/(tabs)/schedule?view=manage'
```

`mobile/lib/schedule-manage.js`, directly under `export const MANAGER_ROLES = [...]` (line 99):

```js

// RUNWAY.1 — the schedule tab's ?view= deep-link param (set by
// lib/notification-nav.js for roster_runway pushes and by the Studio
// dashboard's runway chip). Only 'manage' is honoured, and only for a manager
// role: a coach who is handed the link lands on their own week. null = leave
// the view alone.
export function scheduleViewFromParam(viewParam, role) {
  return viewParam === 'manage' && MANAGER_ROLES.includes(role) ? 'manage' : null
}
```

`mobile/app/(staff)/(tabs)/schedule.jsx`, three edits:

Line 37, import the helper:

```js
import { canAdjustShiftTimes, canCancelTimeOff, MANAGER_ROLES, scheduleViewFromParam } from '../../../lib/schedule-manage'
```

Under `const dateParam = …` (line 311) read the param, and seed the existing `view` state (line 319) from it:

```js
  // RUNWAY.1 — optional ?view=manage (roster_runway push / Studio chip).
  const viewParam = typeof params.view === 'string' ? params.view : ''
```

```js
  const [view, setView] = useState(() => scheduleViewFromParam(viewParam, profile?.role) || 'me') // 'me' | 'team' | 'manage'
```

Directly after the existing `useEffect` that drops a non-manager out of Manage mode (lines 425-427) add its mirror, for a push that re-targets an already-mounted tab:

```js
  // RUNWAY.1 — a push tap can re-target this mounted tab with ?view=manage.
  // scheduleViewFromParam returns null for a non-manager, so this can never
  // fight the effect above.
  useEffect(() => {
    const v = scheduleViewFromParam(viewParam, profile?.role)
    if (v) setView(v)
  }, [viewParam, profile?.role])
```

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run mobile/lib/notification-nav.test.js mobile/lib/schedule-manage.test.js src/lib/push-channels.test.js && npm run check:mobile-lint && npm run check:mobile-imports`
Expected: all passed; both checks exit 0.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/notification-nav.js mobile/lib/notification-nav.test.js mobile/lib/schedule-manage.js mobile/lib/schedule-manage.test.js 'mobile/app/(staff)/(tabs)/schedule.jsx' src/lib/push-channels.test.js
git commit -m "RUNWAY.1 — roster_runway tap opens that week in Manage mode (manager roles only)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(zsh: the parenthesised path MUST be single-quoted, or the glob silently stages nothing.)

---

### Task 9: Mobile — the Studio dashboard chip

**Files:**
- Modify: `mobile/lib/dashboard-api.js` (lines 61-71)
- Modify: `mobile/lib/dashboard-api.test.js`
- Modify: `mobile/components/dashboard/StudioDashboard.jsx`

`api(path, { locationId })` (`mobile/lib/api.js`) attaches auth, `x-active-location` and the impersonation header; never hand-roll a Bearer (CLAUDE.md). The Studio tab is gated by `dashboard_studio`, which a non-manager can be granted; the ROUTE is what decides, and a 403 simply means no chip.

- [ ] **Step 1: Write the failing test**

In `mobile/lib/dashboard-api.test.js`:

Replace the head of `routeApi` (lines 27-29) so it can answer the new call, defaulting to "ready":

```js
function routeApi({ timeOff, swaps, runway = { success: true, data: { runway: null } } }) {
  api.mockImplementation((path) => {
    if (path.startsWith('/api/schedule/runway')) return runway instanceof Error ? Promise.reject(runway) : Promise.resolve(runway)
    if (path.startsWith('/api/schedule/time-off')) return Promise.resolve(timeOff)
```

In the existing test `'merges the named rows into the shared payload'`, the payload gains a key, so its assertion becomes:

```js
    expect(res).toEqual({ success: true, data: { ...BASE, pendingTimeOff: timeOff, pendingSwaps: [swap], rosterRunway: null } })
```

Directly above `describe('swapRowTitle — …')` add:

```js
// RUNWAY.1 — the Studio tab's roster-runway chip.
describe('fetchStudioDashboard — roster runway', () => {
  const RUNWAY = {
    weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
    blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
  }

  it('reads the runway through the manager-gated route, scoped to the location', async () => {
    routeApi({ timeOff: OK_EMPTY, swaps: OK_EMPTY, runway: { success: true, data: { runway: RUNWAY } } })
    const res = await fetchStudioDashboard(LOC)
    expect(res.data.rosterRunway).toEqual(RUNWAY)
    const call = queryOf('/api/schedule/runway')
    expect(call.pathname).toBe('/api/schedule/runway')
    expect(call.params).toEqual({ location_id: LOC })
    expect(call.opts).toMatchObject({ locationId: LOC })
  })

  it('a 403 envelope, a rejected call and a ready studio are all null: no chip, and the tab still loads', async () => {
    for (const runway of [{ success: false, error: 'Unauthorized' }, new Error('offline'), { success: true, data: { runway: null } }]) {
      routeApi({ timeOff: OK_EMPTY, swaps: OK_EMPTY, runway })
      const res = await fetchStudioDashboard(LOC)
      expect(res.success).toBe(true)
      expect(res.data.rosterRunway).toBeNull()
      expect(res.data.pendingTimeOff).toEqual([])
    }
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run mobile/lib/dashboard-api.test.js`
Expected: `3 failed`: the two new tests and `'merges the named rows into the shared payload'` (the payload has no `rosterRunway` key yet).

- [ ] **Step 3: Minimal implementation**

`mobile/lib/dashboard-api.js`: replace `fetchStudioDashboard` (lines 61-71) with:

```js
// RUNWAY.1 — the roster runway for this studio (shared/roster-runway.js shape)
// or null. null means "no chip": every week is ready, the caller is not a
// manager here (the route 403s), or the read failed. Unlike the two pending
// lists above, hiding on failure is right: this is an alert, the daily push is
// its primary channel, and a chip must never claim a problem it could not read.
export async function fetchRosterRunway(locationId) {
  const qs = new URLSearchParams({ location_id: locationId })
  try {
    const res = await api(`/api/schedule/runway?${qs.toString()}`, { locationId })
    return res?.success ? (res.data?.runway ?? null) : null
  } catch {
    return null
  }
}

export async function fetchStudioDashboard(locationId) {
  const [base, pendingTimeOff, pendingSwaps, rosterRunway] = await Promise.all([
    fetchStudioDashboardData(supabase, locationId),
    // Manager scope (incl. LEAVE.2's "leave taken by anyone who belongs
    // here") and the expired-pending cut are the route's, not ours.
    pendingList('/api/schedule/time-off', locationId),
    swapQueue(locationId),
    fetchRosterRunway(locationId),
  ])
  if (!base.success) return base
  return { ...base, data: { ...base.data, pendingTimeOff, pendingSwaps, rosterRunway } }
}
```

`mobile/components/dashboard/StudioDashboard.jsx`, four edits:

Imports (lines 8-15): add `Pressable`, the shared copy functions, and the tested deep link.

```js
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
```

```js
import { rosterRunwayHeadline, rosterRunwayDetail } from 'shared/roster-runway'
import { routeForNotification } from '../../lib/notification-nav'
```

(`shared/...` is the bare package import. Never `../../../shared`: Metro will not resolve it, and `check:mobile-imports` proves the two names exist.)

Under the `STATUS_LABEL` map add the tones (same recipe as `BusinessDashboard.jsx:171-172`):

```js
// RUNWAY.1 — amber inside 10 days, red inside 5 (shared/roster-runway.js).
const RUNWAY_TONE = {
  red: { box: 'bg-red-500/10 border-red-500/30', title: 'text-red-700' },
  amber: { box: 'bg-amber-500/10 border-amber-500/30', title: 'text-amber-700' },
}
```

After `const pendingSwaps = data.pendingSwaps || []` (line 78) add:

```js
  const runway = data.rosterRunway
  const runwayTone = runway ? (RUNWAY_TONE[runway.severity] || RUNWAY_TONE.amber) : null
```

And as the FIRST child of the returned `<View>` (line 88, above `<KpiRow>`):

```jsx
      {/* RUNWAY.1 — an upcoming week that is not built or not published. The
          deep link is the push's own route, so the two cannot drift. */}
      {runway && (
        <Pressable
          onPress={() => router.push(routeForNotification({ type: 'roster_runway', week_start: runway.weekStart }))}
          className={`border rounded-2xl p-4 mb-3 active:opacity-80 ${runwayTone.box}`}
        >
          <Text className={`text-sm font-semibold ${runwayTone.title}`}>{rosterRunwayHeadline(runway)}</Text>
          <Text className="text-xs text-un1t-subtle mt-1">{rosterRunwayDetail(runway)} Tap to open that week.</Text>
        </Pressable>
      )}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run mobile/lib/dashboard-api.test.js && npm run check:mobile-lint && npm run check:mobile-imports && npm run check:ota-paths`
Expected: all passed; the three checks exit 0.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/dashboard-api.js mobile/lib/dashboard-api.test.js mobile/components/dashboard/StudioDashboard.jsx
git commit -m "RUNWAY.1 — mobile Studio dashboard chip, read through the manager-gated route

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### PR gate

- [ ] **Focused tests:**

```bash
npx vitest run shared/roster-runway.test.js src/lib/roster-runway-data.test.js src/lib/roster-runway-notify.test.js src/app/api/schedule/runway/route.test.js src/app/api/cron/contract-reminders/route.test.js src/components/dashboard/RosterRunwayChip.test.jsx mobile/lib/notification-nav.test.js mobile/lib/schedule-manage.test.js mobile/lib/dashboard-api.test.js src/lib/push-channels.test.js src/lib/roster-staffing.test.js tests/shared-pair-sync.test.js tests/ota-trigger-paths.test.js
```

Expected: all passed.

- [ ] **Lint and the relevant checks:**

```bash
npm run lint && npm run check:guardrails && npm run check:select-columns && npm run check:route-guards && npm run check:location-scoping && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:ota-paths
```

Expected: every command exits 0. `check:route-guards` has seen the new route's `getCurrentUser`. `check:ota-paths` passes because nothing new was added at the top level of `mobile/`; **the merge WILL publish an OTA**.

- [ ] **Open the PR.** Title: `RUNWAY.1 — roster runway alert: say so when next week is not built`. The body must state: no migration; the merge publishes an OTA; the first push goes at the next 08:00 UTC tick and will, if the week of 28 Sep is still unready, alert on it; head coaches are included because they can publish; the multi-studio deep-link limit. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. **Wait for the Next build check**: this PR adds a route, a component and new imports.

- [ ] **Verify on the Vercel PREVIEW (GET-only, prod data; local dev has no database).** As a manager, open `/dashboard/today`: expect the chip for any unready week inside 10 days, linking to `/schedule?view=week&week=<Monday>`. As a coach: no chip. `GET /api/schedule/runway?location_id=<Hatch Street id>` as a manager there: `{ success: true, data: { runway: null } }` (no active templates). Do NOT call the cron URL on a preview: it sends real pushes.

- [ ] **CHANGELOG.** After `gh pr create`, add ONE row keyed `| #<PR> | RUNWAY.1 — … |` directly under the table header in `docs/CHANGELOG.md` (never edit another row), commit, push.

- [ ] **After merge, the day after:** `cron_heartbeats` row `contract-reminders`, `last_outcome.runway` reads `{ locations, alerts, sent, emailed, deduped, failed }`. `{ error: … }` there means the arm threw; the message is in the Vercel logs under scope `cron-contract-reminders`.
