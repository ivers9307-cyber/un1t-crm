## PR HOLIDAYLEAVE.1 — bank holidays are not charged as leave

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `holiday`-type time-off request is charged only for working days: Mon-Fri, minus the national bank holidays of the studio's country, minus that studio's own `location_holidays` rows.

**Why:** `countLeaveDays` (`src/lib/time-off-days.js:7`) counts every Mon-Fri day for type `holiday` and never consults `src/lib/bank-holidays.js` (the static 2025-2030 list the calendar already renders) or the `location_holidays` table (mig 017). A coach who books Mon 1 Jun to Fri 5 Jun 2026 is charged 5 days from their allowance; Monday is the June Public Holiday, so the correct charge is 4. The number is stored on `time_off_requests.total_days` and the approval trigger (`update_holiday_allowance`, mig 616) adds exactly that number to `staff_allowances.used_days`.

**Ships:** web deploy only. **No migration.** Nothing under `mobile/` or `shared/` changes, so **no OTA**. One operator-run SQL correction (Task 5) AFTER the deploy.

**Worktree:** branch `holidayleave-1` off a fresh `origin/main`. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the PR gate (8GB machine).

---

### What was found (callers and conventions)

`grep -rn "countLeaveDays" src shared mobile tests` finds exactly ONE production caller:

| Site | What it does | Change |
|---|---|---|
| `src/app/api/schedule/time-off/route.js:218-219` (POST) | `splitAtYearEnd(...).map(([s, e]) => ({ s, e, days: countLeaveDays(type, s, e) }))`. `seg.days` is the "no working days" 400 (line 221), the balance check (line 253), and the inserted `total_days` (line 277) | pass a pre-fetched `Set` of non-working ISO dates |
| `approveRecordedLeave` (same file, 339-390) and `PUT /api/schedule/time-off/[id]` | never recount; they approve the stored `total_days` | none |
| Allowance maths: `getHolidayAllowance` (`src/lib/time-off-leave.js:197`), `GET /api/schedule/allowances`, the assistant tool, `report-generator.js`, the approvals provider, `TimeOffManager.jsx`, mobile `StudioDashboard.jsx` | all READ `total_days` / `used_days`; none recomputes days | none |
| Web and mobile request forms | no client-side day preview (`grep -n "getDay" src/components/TimeOffManager.jsx "mobile/app/(staff)/schedule/time-off-new.jsx"` is empty) | none |
| `leaveHoursInWeek` (`src/lib/roster-summary.js:46`) | **deliberately NOT changed**, see below | comment + one pinning test |

**Why `leaveHoursInWeek` keeps counting the bank holiday.** The header comment in `time-off-days.js` says the Mon-Fri rule "matches leaveHoursInWeek's Mon-Fri contract convention", which invites making the two agree again. They answer different questions. `countLeaveDays` answers "how many days of ALLOWANCE does this cost?" and a bank holiday costs none. `leaveHoursInWeek` answers "how many contracted hours is this FTE NOT available for this week?" (the denominator of the utilisation band, for every leave type, not only holiday). A coach whose approved leave spans a bank holiday is still not available that day, so removing it would RAISE their expected hours on a day they are off. Its existing test already uses the week of Mon 4 May 2026, the May Public Holiday, and expects 18h for Mon-Wed. Task 4 rewrites the misleading comment and names that decision in a test.

**Design decision: `countLeaveDays` takes a pre-fetched `Set`.** It stays pure and synchronous (no `db`, no `await`): the fourth parameter is a `Set<string>` of `YYYY-MM-DD` dates, default `null` = today's behaviour. The Set is built by a pure helper (`nonWorkingDateSet`, which reuses `mergeHolidays` from `bank-holidays.js`) and loaded by one I/O helper in `time-off-leave.js`, the file that already holds every other read the time-off routes make.

**Out of scope, on purpose:**
- A public holiday that falls on a weekend (26 Dec 2026 is a Saturday). Irish law gives a benefit for it; this codebase has never modelled one and the day is already not charged because it is not Mon-Fri.
- Half days. `total_days` is `NUMERIC(5,1)` but no code path writes a fraction.
- Telling the coach WHICH day was not charged. The row shows "4 days"; a label is a follow-up if anyone asks.

**Rules that bite in this PR:**
- Every read in the time-off POST **fails closed** (ROSTER-FIX.2, route.js lines 193-197 and 227-231): an unreadable holiday list is a 500, never "no holidays", because silently over-charging is the bug being fixed.
- `check:select-columns` verifies every literal column against `supabase/migrations/`. Used here: `locations.country` (mig 018), `location_holidays(date, name, location_id)` (mig 017).
- `const { data } = await ….single()` without `error` is lint-refused (`no-discarded-single-error`). The new reads destructure `error` and use `.maybeSingle()`.
- Never build a date with a `` `${d}T…Z` `` template literal (`check:guardrails`). The existing `new Date(cur + 'T00:00:00Z')` concatenation in `time-off-days.js` is left exactly as it is.
- The repo is PUBLIC: fixtures use `loc-1`, `Coach`, no real names.

---

### File map

| File | Change |
|---|---|
| `src/lib/time-off-days.js` | Modify: header comment lines 1-3; `countLeaveDays` lines 7-14 (4th param); new `nonWorkingDateSet` |
| `src/lib/time-off-days.test.js` | Modify: import line 2, new cases |
| `src/lib/time-off-leave.js` | Modify: new import + `getNonWorkingDates` (append to the "Employment + entitlement" section, after line 242) |
| `src/lib/time-off-leave.test.js` | Modify: import lines 4-7, new describe |
| `src/app/api/schedule/time-off/route.js` | Modify: import lines 10-14; lines 215-219 |
| `src/app/api/schedule/time-off/route.test.js` | Modify: `buildDb` lines 38-88; FOUR existing tests whose dates sit on the June bank holiday (lines 106-114, 161-176, 334-350, 428-441); new describe |
| `src/lib/roster-summary.js` | Modify: comment only, lines 34-38 |
| `src/lib/roster-summary.test.js` | Modify: one pinning test in `leaveHoursInWeek (phase 6)` |
| `src/lib/openapi.js` | Modify: description of `POST /api/schedule/time-off`, line 4459 |
| `docs/CHANGELOG.md` | Modify: one new row, after `gh pr create` |

---

### Task 1: `countLeaveDays` skips a pre-fetched set of dates

**Files:** Modify `src/lib/time-off-days.js`, `src/lib/time-off-days.test.js`.

Existing signature being extended (`src/lib/time-off-days.js:7`):

```js
export function countLeaveDays(type, startIso, endIso) {
```

- [ ] **Step 1: Write the failing tests**

In `src/lib/time-off-days.test.js` change the import (line 2):

```js
import { countLeaveDays, splitAtYearEnd, nonWorkingDateSet } from './time-off-days'
```

and add inside `describe('countLeaveDays'`:

```js
  // HOLIDAYLEAVE.1 — a bank holiday inside a holiday request costs no allowance.
  it('holiday: a weekday in the non-working set is not charged', () => {
    // Mon 1 Jun 2026 is the June Public Holiday.
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-07', new Set(['2026-06-01']))).toBe(4)
  })
  it('holiday: a non-working date that is ALREADY a weekend is not subtracted twice', () => {
    // Sat 6 Jun is in the set AND a weekend: still 5, not 4.
    expect(countLeaveDays('holiday', '2026-06-08', '2026-06-14', new Set(['2026-06-13']))).toBe(5)
  })
  it('holiday: a single day that is a bank holiday is 0 days', () => {
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-01', new Set(['2026-06-01']))).toBe(0)
  })
  it('other types ignore the set: sick and unavailable stay calendar days', () => {
    expect(countLeaveDays('sick', '2026-06-01', '2026-06-07', new Set(['2026-06-01']))).toBe(7)
    expect(countLeaveDays('unavailable', '2026-06-01', '2026-06-07', new Set(['2026-06-01']))).toBe(7)
  })
  it('no set, null, or an empty set = the old Mon-Fri count', () => {
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-07')).toBe(5)
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-07', null)).toBe(5)
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-07', new Set())).toBe(5)
  })
```

and a new describe at the end of the file:

```js
describe('nonWorkingDateSet', () => {
  it('Ireland by default: the national list inside the range', () => {
    const s = nonWorkingDateSet({ start: '2026-05-25', end: '2026-06-07' })
    expect([...s]).toEqual(['2026-06-01'])
  })
  it('adds the studio\'s own closures, and ignores ones outside the range', () => {
    const s = nonWorkingDateSet({
      country: 'IE', start: '2026-06-01', end: '2026-06-14',
      customHolidays: [{ date: '2026-06-10', name: 'Studio closed' }, { date: '2026-07-01', name: 'Later' }],
    })
    expect([...s].sort()).toEqual(['2026-06-01', '2026-06-10'])
  })
  it('follows the studio\'s country: 1 Jun is not a UK holiday, 25 May is', () => {
    const s = nonWorkingDateSet({ country: 'GB', start: '2026-05-25', end: '2026-06-07' })
    expect([...s]).toEqual(['2026-05-25'])
  })
  it('a country with no static list still honours the studio\'s closures', () => {
    const s = nonWorkingDateSet({ country: 'ZZ', start: '2026-06-01', end: '2026-06-07', customHolidays: [{ date: '2026-06-03', name: 'Closed' }] })
    expect([...s]).toEqual(['2026-06-03'])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/time-off-days.test.js`
Expected: `expected 5 to be 4`, `expected 1 to be 0`, and `nonWorkingDateSet is not a function`. The "no set" and "other types" cases pass already; they are the regression guard, not the proof.

- [ ] **Step 3: Minimal implementation**

Replace lines 1-14 of `src/lib/time-off-days.js` with:

```js
// ROSTER-FIX.2 — leave-day maths shared by the time-off POST.
// A holiday is charged for WORKING days only: Mon-Fri, and (HOLIDAYLEAVE.1)
// not a national bank holiday or one of the studio's own closures. Other leave
// types count calendar days.
//
// This is the ALLOWANCE count. It is deliberately not the same question as
// leaveHoursInWeek (roster-summary.js), which asks how many contracted hours a
// person is unavailable for and so keeps counting a bank holiday inside leave.
import { mergeHolidays } from './bank-holidays'

function addDay(iso) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10)
}

/**
 * Pure. Days of allowance [startIso, endIso] costs, both ends inclusive.
 *
 * @param {string} type  time_off_requests.type
 * @param {string} startIso  YYYY-MM-DD
 * @param {string} endIso    YYYY-MM-DD
 * @param {Set<string>|null} [nonWorkingDates]  HOLIDAYLEAVE.1 — YYYY-MM-DD
 *   dates that cost no allowance (nonWorkingDateSet). Only consulted for
 *   `holiday`. Pre-fetched by the caller so this stays pure and synchronous.
 */
export function countLeaveDays(type, startIso, endIso, nonWorkingDates = null) {
  let n = 0
  for (let cur = startIso; cur <= endIso; cur = addDay(cur)) {
    if (type !== 'holiday') { n++; continue }
    const dow = new Date(cur + 'T00:00:00Z').getUTCDay()
    if (dow < 1 || dow > 5) continue
    if (nonWorkingDates && nonWorkingDates.has(cur)) continue
    n++
  }
  return n
}

/**
 * HOLIDAYLEAVE.1 — pure. The dates in [start, end] that are a national bank
 * holiday for `country` (static list, bank-holidays.js) or one of the studio's
 * own location_holidays rows. mergeHolidays already de-duplicates by date and
 * applies the range, and returns [] for a country it has no list for.
 *
 * @param {object} args
 * @param {string} [args.country]  ISO 3166-1 alpha-2 (locations.country). Default 'IE'.
 * @param {Array<{ date: string }>} [args.customHolidays]  location_holidays rows
 * @param {string} args.start  YYYY-MM-DD
 * @param {string} args.end    YYYY-MM-DD
 * @returns {Set<string>}
 */
export function nonWorkingDateSet({ country = 'IE', customHolidays = [], start, end }) {
  return new Set(mergeHolidays(customHolidays, { start, end, country }).map((h) => h.date))
}
```

Leave `splitAtYearEnd` and its comment (lines 15-30) untouched.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/time-off-days.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/time-off-days.js src/lib/time-off-days.test.js
git commit -m "HOLIDAYLEAVE.1 — countLeaveDays takes a set of non-working dates"
```

---

### Task 2: `getNonWorkingDates`, the one read

**Files:** Modify `src/lib/time-off-leave.js`, `src/lib/time-off-leave.test.js`.

Pattern being copied: `getLeaveEntitlement` (`src/lib/time-off-leave.js:183-191`) returns `{ days, error }` and never throws. The test fake is `fakeDb(resolve)` from `src/lib/time-off.test-helpers.js`; `resolve` receives `{ table, action, eq, calls, terminal }`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/time-off-leave.test.js` add `getNonWorkingDates` to the import list (lines 4-7), then add:

```js
// HOLIDAYLEAVE.1 — which dates cost no holiday allowance at this studio.
describe('getNonWorkingDates', () => {
  const dbWith = ({ country = 'IE', custom = [], locError = null, customError = null } = {}) => fakeDb((q) => {
    if (q.table === 'locations') return { data: locError ? null : { country }, error: locError }
    if (q.table === 'location_holidays') return { data: customError ? null : custom, error: customError }
    throw new Error(q.table)
  })

  it('national bank holidays for the studio\'s country plus its own closures, inside the range', async () => {
    const db = dbWith({ custom: [{ date: '2026-06-10', name: 'Studio closed' }] })
    const { dates, error } = await getNonWorkingDates(db, 'loc-1', '2026-06-01', '2026-06-14')
    expect(error).toBeNull()
    expect([...dates].sort()).toEqual(['2026-06-01', '2026-06-10'])
  })

  it('scopes BOTH reads to the studio, and the closures read to the range', async () => {
    const db = dbWith()
    await getNonWorkingDates(db, 'loc-1', '2026-06-01', '2026-06-14')
    expect(queriesOf(db, 'locations')[0].eq).toEqual({ id: 'loc-1' })
    const closures = queriesOf(db, 'location_holidays')[0]
    expect(closures.eq).toEqual({ location_id: 'loc-1' })
    expect(closures.calls).toContainEqual(['gte', 'date', '2026-06-01'])
    expect(closures.calls).toContainEqual(['lte', 'date', '2026-06-14'])
  })

  it('a studio in another country gets that country\'s list', async () => {
    const { dates } = await getNonWorkingDates(dbWith({ country: 'GB' }), 'loc-1', '2026-05-25', '2026-06-07')
    expect([...dates]).toEqual(['2026-05-25'])
  })

  it('a studio with no country on file is treated as Ireland (the GET holidays route does the same)', async () => {
    const { dates } = await getNonWorkingDates(dbWith({ country: null }), 'loc-1', '2026-06-01', '2026-06-07')
    expect([...dates]).toEqual(['2026-06-01'])
  })

  it('an unreadable studio or closures list is an ERROR, never "no holidays"', async () => {
    expect(await getNonWorkingDates(dbWith({ locError: { message: 'loc boom' } }), 'loc-1', '2026-06-01', '2026-06-07'))
      .toEqual({ dates: null, error: { message: 'loc boom' } })
    expect(await getNonWorkingDates(dbWith({ customError: { message: 'closures boom' } }), 'loc-1', '2026-06-01', '2026-06-07'))
      .toEqual({ dates: null, error: { message: 'closures boom' } })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/time-off-leave.test.js -t getNonWorkingDates`
Expected: 5 failed, `getNonWorkingDates is not a function`.

- [ ] **Step 3: Minimal implementation**

In `src/lib/time-off-leave.js` add to the imports (after line 28):

```js
import { nonWorkingDateSet } from '@/lib/time-off-days'
```

and insert after `ensureHolidayAllowanceRow` (ends line 242), before the `// ── Shift clashes` divider:

```js
/**
 * HOLIDAYLEAVE.1 — the dates in [startIso, endIso] that cost no holiday
 * allowance at this studio: its country's national bank holidays
 * (bank-holidays.js, static) plus its own location_holidays rows (mig 017).
 *
 * Fails CLOSED like every other read behind the time-off POST: an unreadable
 * list returns the error, never an empty set, because an empty set silently
 * over-charges the allowance (the bug this exists to fix). A request is capped
 * at 366 days by the route, so the closures read cannot reach the 1,000-row
 * select cap and is not paged.
 *
 * @returns {Promise<{ dates: Set<string>|null, error: object|null }>}
 */
export async function getNonWorkingDates(db, locationId, startIso, endIso) {
  // Primary-key lookup; a missing row falls back to Ireland, as
  // GET /api/locations/[id]/holidays does.
  const { data: loc, error: locError } = await db
    .from('locations')
    .select('country')
    .eq('id', locationId)
    .maybeSingle()
  if (locError) return { dates: null, error: locError }

  const { data: custom, error: customError } = await db
    .from('location_holidays')
    .select('date, name')
    .eq('location_id', locationId)
    .gte('date', startIso)
    .lte('date', endIso)
  if (customError) return { dates: null, error: customError }

  return {
    dates: nonWorkingDateSet({ country: loc?.country || 'IE', customHolidays: custom || [], start: startIso, end: endIso }),
    error: null,
  }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/time-off-leave.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/time-off-leave.js src/lib/time-off-leave.test.js
git commit -m "HOLIDAYLEAVE.1 — read a studio's non-working dates (bank holidays + its own closures)"
```

---

### Task 3: the time-off POST charges working days only

**Files:** Modify `src/app/api/schedule/time-off/route.js:10-14, 215-219`, `src/app/api/schedule/time-off/route.test.js`.

**Read this before touching the tests.** Several existing fixtures sit on Mon 1 Jun 2026, which is the June Public Holiday, so the fix changes what they mean. One of them goes RED for a good reason. All four are listed in Step 1(b); change them in the same commit, do not "fix" the route to keep them green.

- [ ] **Step 1: Write the failing tests**

(a) `buildDb` (lines 38-88). Add three options to the destructured argument:

```js
  country = 'IE',
  customHolidays = [], holidaysError = null,
```

Replace line 65 (`if (q.table === 'location_role_permissions' || q.table === 'locations') return { data: [], error: null }`) with:

```js
    if (q.table === 'location_role_permissions') return { data: [], error: null }
    // HOLIDAYLEAVE.1 — `locations` is read two ways: the approver lookup lists
    // features (awaited, a list) and getNonWorkingDates reads one studio's
    // country (.maybeSingle()).
    if (q.table === 'locations') {
      return q.terminal === 'maybeSingle' ? { data: { country }, error: null } : { data: [], error: null }
    }
    if (q.table === 'location_holidays') return { data: holidaysError ? null : customHolidays, error: holidaysError }
```

(b) Existing tests that sit on the bank holiday:

1. Lines 106-114, `'a Mon-Sun holiday counts 5 working days'`: move it to a week with no bank holiday so it keeps meaning "weekends are free":

```js
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-08', end_date: '2026-06-14' }))
```

2. Lines 161-176, the straddling-year test. Still 400, but its comment is now wrong (Fri 1 Jan 2027 is New Year's Day). Replace the comment:

```js
    // 28-31 Dec 2026 = 4 working days against 20; 1-8 Jan 2027 = 5 working
    // days (Fri 1 Jan is a bank holiday) against 1. Charging the whole range to
    // the first year would pass.
```

3. Lines 334-350, `'checks the balance on the FIRST holiday of the year…'`. Still passes by luck (4 > 3). Move BOTH requests off the bank holiday so "Mon-Fri = 5 working days" stays true:

```js
    let res = await POST(req({ type: 'holiday', start_date: '2026-06-08', end_date: '2026-06-12' }))
```

```js
    res = await POST(req({ type: 'holiday', start_date: '2026-06-08', end_date: '2026-06-12' }))
```

4. Lines 428-441, `'applies the contractor and balance rules to the PERSON, not the caller'`. **This one goes RED.** `body()` (line 382) is Mon 1 Jun to Tue 2 Jun; with `entitlement: 1` it used to be 2 days against 1 (400). It is now 1 day against 1, which is allowed (201). Give the balance half its own bank-holiday-free dates:

```js
      ;({ db, insertSpy } = buildDb({ entitlement: 1 }))
      createServerClient.mockReturnValue(db)
      const res = await POST(req(body({ type: 'holiday', start_date: '2026-06-08', end_date: '2026-06-09' })))
```

(c) New describe, directly after `describe('POST /api/schedule/time-off — request integrity'` closes (line 177):

```js
// HOLIDAYLEAVE.1 — a bank holiday, or a day the studio is closed, inside a
// holiday request costs no allowance.
describe('POST /api/schedule/time-off — bank holidays are not charged', () => {
  it('Mon 1 Jun (June Public Holiday) to Sun 7 Jun is 4 days, not 5', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-07' }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledWith([expect.objectContaining({ total_days: 4 })])
  })

  it('the studio\'s own closure is not charged either, and is read for THAT studio over the requested range', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({ customHolidays: [{ date: '2026-06-10', name: 'Studio closed' }] })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-08', end_date: '2026-06-14' }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledWith([expect.objectContaining({ total_days: 4 })])
    const closures = queriesOf(db, 'location_holidays')[0]
    expect(closures.eq).toEqual({ location_id: 'loc-1' })
    expect(closures.calls).toContainEqual(['gte', 'date', '2026-06-08'])
    expect(closures.calls).toContainEqual(['lte', 'date', '2026-06-14'])
  })

  it('the balance check uses the working-day count: 4 days fit a 4-day balance', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({ entitlement: 4 })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-05' }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })

  it('a holiday that is ONLY a bank holiday is refused: nothing to take', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-01' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('No working days in that range')
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('follows the studio\'s country: 1 Jun is an ordinary Monday in the UK', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({ country: 'GB' })
    createServerClient.mockReturnValue(db)
    await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-07' }))
    expect(insertSpy).toHaveBeenCalledWith([expect.objectContaining({ total_days: 5 })])
  })

  it('sick leave still counts calendar days and never reads the holiday list', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    await POST(req({ type: 'sick', start_date: '2026-06-01', end_date: '2026-06-07' }))
    expect(insertSpy).toHaveBeenCalledWith([expect.objectContaining({ total_days: 7 })])
    expect(queriesOf(db, 'location_holidays')).toHaveLength(0)
  })

  it('500 and NO insert when the holiday list cannot be read: never charge blind', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({ holidaysError: { message: 'closures boom' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-05' }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('closures boom')
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('a year-straddling holiday: each year\'s row gets its own working-day count', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    // Mon 21 Dec 2026 - Fri 8 Jan 2027. 2026: 9 weekdays minus Fri 25 Dec = 8.
    // 2027: 6 weekdays minus Fri 1 Jan = 5.
    const res = await POST(req({ type: 'holiday', start_date: '2026-12-21', end_date: '2027-01-08' }))
    expect(res.status).toBe(201)
    expect(insertSpy.mock.calls[0][0].map((r) => [r.start_date, r.total_days])).toEqual([['2026-12-21', 8], ['2027-01-01', 5]])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/time-off/route.test.js`
Expected failures, and ONLY these: "is 4 days, not 5" (`total_days: 5` received), "own closure" (5 received, and `queriesOf(db, 'location_holidays')[0]` is undefined), "4 days fit a 4-day balance" (400), "ONLY a bank holiday" (201), "500 and NO insert" (201), "year-straddling" (`[…, 9], […, 6]`). The UK and sick-leave cases pass already; they are guards. The four edited older tests pass both before and after.

- [ ] **Step 3: Minimal implementation**

In `src/app/api/schedule/time-off/route.js`:

(a) Add `getNonWorkingDates` to the `@/lib/time-off-leave` import (lines 10-14):

```js
import {
  getLocationMemberIds, getProfileLocationIds, leaveScopeOrFilter, canDecideTimeOff,
  resolveTimeOffApproverIds, getEmploymentType, getHolidayAllowance, ensureHolidayAllowanceRow,
  countLeaveClashes, findLeaveClashes, getNonWorkingDates,
} from '@/lib/time-off-leave'
```

(b) Replace lines 215-219 (the ROSTER-FIX.2 comment and the `segments` assignment) with:

```js
  // HOLIDAYLEAVE.1 — a holiday is charged for working days only, so load the
  // dates that cost nothing at the studio it is filed at: national bank
  // holidays plus that studio's own closures. Only holiday needs it. Fails
  // closed like the reads around it: an unreadable list must not become
  // "no bank holidays", which is the over-charge this fixes.
  let nonWorkingDates = null
  if (type === 'holiday' && targetLocation) {
    const { dates, error: holidaysError } = await getNonWorkingDates(db, targetLocation, start_date, end_date)
    if (holidaysError) {
      return NextResponse.json({ success: false, error: holidaysError.message }, { status: 500 })
    }
    nonWorkingDates = dates
  }

  // ROSTER-FIX.2 — a range that straddles 31 December becomes one row per
  // year, so each year's allowance is charged its own days. Each segment is
  // counted with the leave-type's own day rule (holiday = working days).
  const segments = splitAtYearEnd(start_date, end_date)
    .map(([s, e]) => ({ s, e, days: countLeaveDays(type, s, e, nonWorkingDates) }))
```

Nothing else in the route changes: line 221's "No working days" 400, the balance loop and the insert all read `seg.days`.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/time-off/route.test.js 'src/app/api/schedule/time-off/[id]/route.test.js'`
Expected: all pass. (The `[id]` file is run because it shares the `2026-06-01` fixtures; it never counts days, so it is unaffected. Quote the path: `[id]` is a zsh glob.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/time-off/route.js src/app/api/schedule/time-off/route.test.js
git commit -m "HOLIDAYLEAVE.1 — a holiday request is not charged for bank holidays or studio closures"
```

---

### Task 4: say why `leaveHoursInWeek` does not follow

**Files:** Modify `src/lib/roster-summary.js:34-38` (comment only), `src/lib/roster-summary.test.js`.

This task changes no behaviour. The test below PASSES on first run; it is a pin that names a decision, so the normal "expect FAIL" step does not apply. Do not invent a failing variant.

- [ ] **Step 1: Add the pinning test**

Inside `describe('leaveHoursInWeek (phase 6)'` in `src/lib/roster-summary.test.js`:

```js
  // HOLIDAYLEAVE.1 — deliberately NOT bank-holiday aware. This answers "how
  // many contracted hours is the coach unavailable for", not "how much
  // allowance does it cost" (that is countLeaveDays). Mon 4 May 2026 is the May
  // Public Holiday: the coach on leave that day is still not available, so it
  // still comes off the expected hours. If this ever changes to 24, an FTE on
  // leave over a bank holiday reads as under-used for a day they are off.
  it('keeps counting a bank holiday that falls inside approved leave', () => {
    const r = leaveHoursInWeek({
      timeOff: [{ profile_id: 's1', status: 'approved', start_date: '2026-05-04', end_date: '2026-05-08' }],
      profileId: 's1', weekStart, contractedHoursPerWeek: fte30,
    })
    expect(r).toBe(30)
  })
```

- [ ] **Step 2: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-summary.test.js -t "leaveHoursInWeek"`
Expected: all pass, including the new one.

- [ ] **Step 3: Fix the comment**

In `src/lib/roster-summary.js`, after the paragraph that ends "…the contract didn't count it in the first place." (line 38), add:

```js
//
// HOLIDAYLEAVE.1 — a bank holiday inside approved leave STILL counts here.
// countLeaveDays (time-off-days.js) skips it because it costs no ALLOWANCE;
// this function measures AVAILABILITY, and the coach is no more available on a
// bank holiday they are on leave for. The two are different questions and are
// meant to disagree on that one day.
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/roster-summary.js src/lib/roster-summary.test.js
git commit -m "HOLIDAYLEAVE.1 — pin and explain why leaveHoursInWeek keeps counting bank holidays"
```

---

### Task 5: operator runbook — correct 2026 requests already charged for a bank holiday

**Not a migration, not code, not run by the implementing engineer.** It is run ONCE by the operator against the un1t-crm project (`iyvtbjjxdggiadzwwvdj`, confirm with `list_projects`; NOT the sentinel project) through Supabase MCP `execute_sql`, **after** the Task 3 deploy is live (otherwise a request filed between the fix and the deploy is charged the old way and missed).

Copy both statements into the PR description under a heading "Post-deploy data correction" so they travel with the change.

**What it fixes.** `total_days` on 2026 holiday requests that were counted with the old rule and include a weekday bank holiday or studio closure, and the matching over-charge on `staff_allowances.used_days`.

**Why it is safe to run twice (idempotent).** A row is only touched when `total_days` STILL EQUALS the old formula's answer (its plain Mon-Fri count). Once corrected it no longer equals that, and a request filed after the deploy never did. A second run therefore selects nothing and reports zeros. The same test also skips any row a human edited by hand, and any row from before ROSTER-FIX.2 that counted weekends; the dry run lists those as `will_fix = false` for a person to look at.

**Why the allowance is adjusted by hand.** `trg_update_holiday_allowance` (mig 011, function replaced in mig 616) is `AFTER UPDATE` but only acts when `status` CHANGES to or from `approved`. Updating `total_days` on an already-approved row fires it and it does nothing. So `used_days` must be reduced explicitly, only for APPROVED rows (a pending row has not been charged yet; fixing its `total_days` is what stops it being over-charged when it IS approved).

**Why one statement.** The MCP `execute_sql` rolls back a bare `begin;` that has no `commit;`. A single statement with data-modifying CTEs is atomic on its own: both updates land or neither does.

**Scope rules in the SQL, each mirroring the code:**
- type `holiday`, status `approved` or `pending`, wholly inside 2026 (rows are year-split since ROSTER-FIX.2; a straddler is reported, not touched);
- studios whose `locations.country` is `IE` or null (the route's default). The 2026 Irish list below is copied from `src/lib/bank-holidays.js:33-43`. Sat 26 Dec is omitted: it was never charged;
- contractors are excluded: they have no allowance (mig 616) and cannot file `holiday` (LEAVE.3);
- a studio closure counts only for the studio the request was filed at, as in `getNonWorkingDates`.

- [ ] **Step 1: DRY RUN (read-only). Run this first and read every row.**

```sql
WITH bank(d) AS (
  VALUES ('2026-01-01'::date), ('2026-02-02'), ('2026-03-17'), ('2026-04-06'), ('2026-05-04'),
         ('2026-06-01'), ('2026-08-03'), ('2026-10-26'), ('2026-12-25')
),
candidates AS (
  SELECT
    r.id, r.profile_id, p.full_name, p.employment_type, r.location_id, r.status,
    r.start_date, r.end_date, r.total_days,
    (SELECT count(*) FROM generate_series(r.start_date::timestamp, r.end_date::timestamp, interval '1 day') g(day)
      WHERE extract(isodow FROM g.day) < 6) AS weekday_count,
    (SELECT count(*) FROM generate_series(r.start_date::timestamp, r.end_date::timestamp, interval '1 day') g(day)
      WHERE extract(isodow FROM g.day) < 6
        AND (g.day::date IN (SELECT d FROM bank)
             OR EXISTS (SELECT 1 FROM public.location_holidays lh
                        WHERE lh.location_id = r.location_id AND lh.date = g.day::date))) AS holiday_count
  FROM public.time_off_requests r
  JOIN public.locations l ON l.id = r.location_id
  JOIN public.profiles p ON p.id = r.profile_id
  WHERE r.type = 'holiday'
    AND r.status IN ('approved', 'pending')
    AND r.end_date >= '2026-01-01' AND r.start_date <= '2026-12-31'
    AND coalesce(l.country, 'IE') = 'IE'
)
SELECT
  c.id, c.full_name, c.status, c.start_date, c.end_date,
  c.total_days              AS current_total_days,
  c.weekday_count,
  c.holiday_count,
  c.weekday_count - c.holiday_count AS proposed_total_days,
  (c.total_days = c.weekday_count
     AND c.start_date >= '2026-01-01' AND c.end_date <= '2026-12-31'
     AND coalesce(c.employment_type, 'fte') <> 'contractor') AS will_fix,
  CASE
    WHEN coalesce(c.employment_type, 'fte') = 'contractor' THEN 'contractor: no allowance'
    WHEN c.start_date < '2026-01-01' OR c.end_date > '2026-12-31' THEN 'straddles a year: look by hand'
    WHEN c.total_days = c.weekday_count - c.holiday_count THEN 'already correct'
    WHEN c.total_days <> c.weekday_count THEN 'total_days is not the old Mon-Fri count: edited by hand or pre-ROSTER-FIX.2, look by hand'
    ELSE 'old count, will be corrected'
  END AS note,
  sa.used_days AS allowance_used_days_now
FROM candidates c
LEFT JOIN public.staff_allowances sa ON sa.profile_id = c.profile_id AND sa.year = 2026
WHERE c.holiday_count > 0
ORDER BY c.full_name, c.start_date;
```

What to check before going on:
- every `will_fix = true` row: `proposed_total_days` is what a person would expect for those dates;
- a `proposed_total_days` of `0` means the whole request was a bank holiday. The statement will set it to 0 and return the day; consider cancelling that request in the app instead;
- for each person, `allowance_used_days_now` minus the sum of their APPROVED `holiday_count` must not be negative. If it would be, their allowance was edited by hand: stop and look (`GREATEST(0, …)` in Step 2 protects the column, but the person deserves a correct number).
- The output contains staff names. Do not paste it into the PR, an issue or the changelog: the repo is public.

- [ ] **Step 2: APPLY (one statement, atomic). Run only after Step 1 has been read.**

```sql
WITH bank(d) AS (
  VALUES ('2026-01-01'::date), ('2026-02-02'), ('2026-03-17'), ('2026-04-06'), ('2026-05-04'),
         ('2026-06-01'), ('2026-08-03'), ('2026-10-26'), ('2026-12-25')
),
candidates AS (
  SELECT
    r.id, r.profile_id, r.status, r.total_days,
    (SELECT count(*) FROM generate_series(r.start_date::timestamp, r.end_date::timestamp, interval '1 day') g(day)
      WHERE extract(isodow FROM g.day) < 6) AS weekday_count,
    (SELECT count(*) FROM generate_series(r.start_date::timestamp, r.end_date::timestamp, interval '1 day') g(day)
      WHERE extract(isodow FROM g.day) < 6
        AND (g.day::date IN (SELECT d FROM bank)
             OR EXISTS (SELECT 1 FROM public.location_holidays lh
                        WHERE lh.location_id = r.location_id AND lh.date = g.day::date))) AS holiday_count
  FROM public.time_off_requests r
  JOIN public.locations l ON l.id = r.location_id
  JOIN public.profiles p ON p.id = r.profile_id
  WHERE r.type = 'holiday'
    AND r.status IN ('approved', 'pending')
    AND r.start_date >= '2026-01-01' AND r.end_date <= '2026-12-31'
    AND coalesce(l.country, 'IE') = 'IE'
    AND coalesce(p.employment_type, 'fte') <> 'contractor'
),
fixable AS (
  -- Idempotency lives here: only rows still holding the OLD formula's answer.
  SELECT * FROM candidates WHERE holiday_count > 0 AND total_days = weekday_count
),
fixed_requests AS (
  UPDATE public.time_off_requests r
     SET total_days = f.weekday_count - f.holiday_count,
         updated_at = now()
    FROM fixable f
   WHERE r.id = f.id
  RETURNING r.id, r.profile_id, f.status, f.holiday_count
),
fixed_allowances AS (
  -- Only APPROVED requests were ever charged to the allowance.
  UPDATE public.staff_allowances sa
     SET used_days = GREATEST(0, sa.used_days - d.days_back),
         updated_at = now()
    FROM (SELECT profile_id, sum(holiday_count) AS days_back
            FROM fixed_requests
           WHERE status = 'approved'
           GROUP BY profile_id) d
   WHERE sa.profile_id = d.profile_id
     AND sa.year = 2026
  RETURNING sa.profile_id
)
SELECT
  (SELECT count(*) FROM fixed_requests)                                                       AS requests_corrected,
  (SELECT count(*) FROM fixed_requests WHERE status = 'pending')                              AS of_which_pending,
  (SELECT coalesce(sum(holiday_count), 0) FROM fixed_requests WHERE status = 'approved')      AS allowance_days_returned,
  (SELECT count(*) FROM fixed_allowances)                                                     AS allowance_rows_updated;
```

- [ ] **Step 3: Prove it is done**

Run Step 1 again. Expected: no row has `will_fix = true`; the rows corrected now read `already correct`. Run Step 2 again if in doubt: it must answer `0, 0, 0, 0`.

Record the four numbers from Step 2 (numbers only, no names) in the PR's changelog row.

---

### Task 6: OpenAPI + changelog

**Files:** Modify `src/lib/openapi.js:4459`, `docs/CHANGELOG.md`.

- [ ] **Step 1: Document the rule**

In the `POST /api/schedule/time-off` description (line 4459), append:

```
 A holiday is charged for working days only: Mon-Fri, excluding the national bank holidays of the studio's country and that studio's own closures (GET /api/locations/{id}/holidays); other leave types count calendar days. A holiday made up entirely of such days is refused (400, no working days).
```

and extend the `500`-less response list with:

```js
    500: { description: 'A read the decision depends on failed (employment type, overlap probe, balance, or the studio\'s holiday list); nothing was created', content: { 'application/json': { schema: ErrorResponse } } },
```

- [ ] **Step 2: Commit, push, open the PR**

```bash
git add src/lib/openapi.js
git commit -m "HOLIDAYLEAVE.1 — document the working-day rule"
git push -u origin HEAD
gh pr create --base main --fill
```

Paste Task 5's two SQL statements into the PR description under "Post-deploy data correction".

- [ ] **Step 3: Changelog row** (a NEW row at the top of the table, keyed by the PR number; never edit a pushed row)

```
| #<PR> | HOLIDAYLEAVE.1 — a holiday request is no longer charged for bank holidays or days the studio is closed | 2026-09-19. No migration; nothing under `mobile/` or `shared/` changed, so **no OTA**. `countLeaveDays` takes a pre-fetched `Set` of non-working dates (stays pure); `getNonWorkingDates` reads `locations.country` + `location_holidays` for the studio the request is filed at and fails closed (500, nothing inserted). Only the time-off POST counts days, so it is the only caller changed; approvals and every balance reader use the stored `total_days`. `leaveHoursInWeek` deliberately still counts a bank holiday inside leave (availability, not allowance), now pinned by a test. **One-off correction run by the operator after deploy** (SQL in the PR): <N> requests corrected (<P> pending), <D> allowance days returned across <A> people. |
```

```bash
git add docs/CHANGELOG.md
git commit -m "HOLIDAYLEAVE.1 — changelog"
git push
```

---

### PR gate

Focused tests:

```bash
npx vitest run src/lib/time-off-days.test.js src/lib/time-off-leave.test.js src/lib/roster-summary.test.js \
  src/app/api/schedule/time-off/route.test.js 'src/app/api/schedule/time-off/[id]/route.test.js'
for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/time-off-days.test.js; done
```

Repo checks relevant to this change:

- [ ] `npm run lint`
- [ ] `npm run check:select-columns` — two new literal selects: `locations.country`, `location_holidays(date, name)` filtered on `location_id` / `date`.
- [ ] `npm run check:guardrails` — `no-discarded-single-error` (both new reads destructure `error`; the country read is `.maybeSingle()` pinned by `.eq('id', …)`) and the UTC-date rules (no new date parsing was added).
- [ ] `npm run check:location-scoping` — `location_holidays` is a tenant table. The read lives in `src/lib/` and is filtered by `location_id`; the route itself names no new table. Expected unchanged green; if it flags the route, the fix is the `.eq('location_id', …)` already present, never an `EXEMPT` entry.
- [ ] `npm test` once, then `npm run build` once, immediately before pushing (`time-off-days.js` gained an import of `bank-holidays.js`).

Manual check on the Vercel PREVIEW (local dev has no database; GET-only habits apply to prod data, so use a test coach): file a holiday for a week containing a bank holiday and confirm the row reads 4 days and the balance drops by 4 on approval.
