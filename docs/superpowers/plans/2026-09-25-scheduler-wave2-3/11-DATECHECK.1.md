## PR DATECHECK.1 — every schedule route refuses a date the calendar does not have

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No route under `src/app/api/schedule/**` hands Postgres, or its own date arithmetic, a date that does not exist (`2026-02-30`, `2026-04-31`, `2026-13-01`, `2027-02-29`). Each one answers 400 in the error shape that route already uses, before any read or write.

**Architecture:** One shared Zod schema, `realIsoDate` (= `isoDate.refine(isRealCalendarDate, 'Use a real date, YYYY-MM-DD')`), exported from `src/lib/schemas.js` and used for every body or query-schema date. Raw `searchParams.get()` dates are checked with `isRealCalendarDate` directly, in the words `change-log` already uses (`<name>: not a real date`). The one local-midnight + `toISOString()` day walk found on a schedule path (the roster coverage report) moves to `addDaysISO`. A source-scan test stops a schedule route from going back to the shape-only check.

**Tech Stack:** Next.js 16 App Router route handlers, Zod 4 (4.4.3), Vitest.

**Ships:** web deploy only. **No migration.** Nothing under `mobile/` or `shared/` changes, so **no OTA**.

**Worktree:** branch `datecheck-1` off a fresh `origin/main`, in its own fresh worktree. If `node_modules` is absent, `npm ci` once. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the PR gate (8GB machine).

---

### What was found (every date input under `src/app/api/schedule/**` and `src/app/api/mobile/**`)

How the two engines treat an impossible date, measured on this machine (Node 24.15):

- V8 **rolls** a day of 29-31 into the next month: `new Date('2026-02-30T00:00:00Z')` is 2 March, `new Date(2026, 1, 30)` is 2 March. A day of 32+ or a month of 00/13 is `Invalid Date`.
- Postgres **refuses** it: `date/time field value out of range` (SQLSTATE 22008). PostgREST returns that as an error, which the routes below pass through as either a 400 or a 500 carrying Postgres's own text.

`src/lib/schemas.js:20-23` `isoDate` is the regex `^\d{4}-\d{2}-\d{2}$` only. `isRealCalendarDate` (`schemas.js:32-38`) is the pure arithmetic calendar check added by CHANGELOG.1.

| Route (file:line) | Input | Check today | What `2026-02-30` does today | Fix |
|---|---|---|---|---|
| `GET /api/schedule/blocks` (`blocks/route.js:45-46`, used 79-80) | `start_date`, `end_date` query | **none**, not even the shape | reaches `.gte/.lte('block_date')`, Postgres refuses, **400 with Postgres's text** (line 84). `start_date=abc` does the same | `isRealCalendarDate`, 400 `{ success:false, error:'start_date: not a real date' }` before `createServerClient()` |
| `POST /api/schedule/blocks` (`blocks/route.js:29`) | `block_date` body | `isoDate` (shape) | `findPublishedRosterFor` (`src/lib/roster.js:483-502`) read fails, is logged and read as "not published"; the insert fails, **400 with Postgres's text** (line 258). Nothing written | `realIsoDate`; `validateBody`'s 400 `{ success:false, error:'Invalid request body', issues }` (its existing shape) |
| `GET /api/schedule/shifts` (`shifts/route.js:23-24`) | `start_date`, `end_date` query (the phone's Schedule tab, `mobile/lib/schedule-api.js:6-26`) | **none** | `fetchApiShiftRows` (`src/lib/roster-read.js:204-209`) errors, **400 with Postgres's text** (line 54) | `isRealCalendarDate`, 400 `{ success:false, error:'<name>: not a real date' }` before `createServerClient()` |
| `GET /api/schedule/time-off` list (`time-off/route.js:61-62`, filters 112-113) | `start_date`, `end_date` query | **none** (the `preview=1` branch at 555 is already checked) | for a manager the member read runs first; then the list read fails, **400 with Postgres's text** (line 154) | `isRealCalendarDate`, same 400 shape, before `createServerClient()` (line 65) |
| `POST /api/schedule/time-off` (`time-off/route.js:27`, 35-36) | `start_date`, `end_date` body | already `isoDate.refine(isRealCalendarDate)` (SCHEDHYGIENE.1, #1755) | 400 already | behaviour unchanged; the local `ISO_DATE` becomes the shared `realIsoDate` (same message) |
| `GET /api/schedule/overview` (`overview/route.js:48-49`) | `from`, `to` query | own regex (shape) | `Date.UTC` rolls it to 2 March so the span check passes; then the parallel reads fail, **500 with Postgres's text** (line 203) | `realIsoDate`; the route's existing 400 `{ success:false, error:'from: …' }` (issues joined with `; `) |
| `GET /api/schedule/week-cost` (`week-cost/route.js:40`) | `week_start` query | `isoDate` (shape) | `parseLocalDate` (`src/lib/roster-week-cost.js:28-31`) makes 2 March 2026 (a Monday); **200 with the week of 2-8 March, silently** | `realIsoDate`; the route's existing 400 `{ success:false, error:'week_start: …' }` |
| `GET /api/schedule/contractor-spend` (`contractor-spend/route.js:36`) | `reference_date` query | `isoDate` (shape) | `monthBoundsIso` (`src/lib/roster-summary-server.js:26-31`) makes 2 March; **200 with March's spend and budget, silently**. `2026-13-01` is `Invalid Date` → `NaN-NaN-NaN` → 500 | `realIsoDate`; the route's existing 400 `{ success:false, error:'reference_date: …' }` |
| `POST /api/schedule/rosters` (`rosters/route.js:52-53`) | `period_start`, `period_end` body | `isoDate` (shape) | `findConflictingPublishedRosters` (`src/lib/roster-publish.js:613-628`) read fails, **400 with Postgres's text** (line 210), dry run or not. Nothing written | `realIsoDate`; `validateBody`'s 400 |
| `POST /api/schedule/reports` (`reports/route.js:24-25`) | `period_start`, `period_end` body | `isoDate` (shape) | `generateReport`: four types fail the shift read, **400 "Failed to load scheduled shifts: <Postgres text>"**; `time_off_summary` discards its read error (`src/lib/report-generator.js:303-308`) and fails at the `generated_reports` insert (DATE columns, mig 012:65), 400 with Postgres's text. Nothing saved | `realIsoDate`; `validateBody`'s 400. Plus a real-date floor inside `generateReport` for the cron path (Task 8) |
| `POST /api/schedule/shifts/copy-week` (`copy-week/route.js:14-15`) | `source_start`, `target_start` body | `isoDate` (shape) | impossible `source_start`: source read fails, **400 with Postgres's text** (line 95). Impossible `target_start` with coaches in the source week: the leave read (`fetchApprovedLeave`, `src/lib/roster-copy.js:76-88`) fails, **500** (line 109); with none, 404. Nothing written | `realIsoDate`; `validateBody`'s 400 |
| `POST /api/schedule/shifts/copy-month` (`copy-month/route.js:59-60`) | `source_month_start`, `target_month_start` body | `isoDate` + first-of-month regex (line 117) | day 30 cannot pass the `-01` check, so the reachable impossible dates are month `00`/`13`: `daysInMonth` → `NaN`, `2026-13-NaN` reaches the source read, **400 with Postgres's text**; as target, the leave read **500s** | `realIsoDate` (the first-of-month check stays) |
| `GET /api/schedule/change-log` (`change-log/route.js:41-42`, 66-71) | `from`, `to` query | `isoDate` + `isRealCalendarDate` loop | 400 `from: not a real date` already | **none**; left as is (its test pins the message) |

**No date input** (read to confirm): `allowances` (`year` is an integer, see review notes), `assignments/[id]`, `blocks/[id]`, `blocks/[id]/assignments`, `blocks/bulk-assign`, `reports/scheduled` (`day_of_week`/`day_of_month` integers), `rosters/[id]/approve`, `rosters/[id]/reject`, `runway`, `swaps`, `swaps/[id]`, `templates`, `templates/[id]`, `time-off/[id]`, `time-off/[id]/cancel-request`, `time-off/[id]/unassign-clashes`. Their Zod schemas carry no date field and they read no date query param.

**`src/app/api/mobile/**`:** 11 route files (`checklists/*`, `device-tokens`, `impersonate/*`, `layout`, `me`, `radar`, `review-login`, `today-feed`). **None takes a schedule date**; the only query param is `impersonate/users?q=`. The phone reads schedules through `/api/schedule/shifts`, `/blocks`, `/time-off` (list and preview), `/swaps` and `/runway` (`mobile/lib/schedule-api.js`), all covered above. The phone builds every date from a `Date` it formatted itself, so no phone change is needed.

**Every in-repo web caller sends real dates:** `useWeekCost` gets `formatDate(weekStart)` (`src/components/ScheduleCalendar.jsx:416-419`), contractor-spend gets `formatDate(spendMonth.monthStart)` (`:398`), the overview dialog gets `formatDate(...)` ranges (`:192`, `:557`). So the three routes that answer 200 today for a rolled date lose no working caller.

**Local-midnight + `toISOString()` (the summer-time bug):** `grep -rn "T00:00:00'" src/app/api/schedule src/lib/roster*.js` finds local-midnight Dates in `copy-week` (32, 43-44, 54), `copy-month` (70, 83-84), `roster-summary.js` (74-75) and `roster-summary-server.js` (27). All of them read back through LOCAL getters (`formatDate`, `getDay`, `getDate`), never `toISOString()`, so they are consistent and left alone. `src/lib/roster-publish.js` and `roster-change-notify.js` build UTC dates and read UTC; fine.

**One real instance:** `src/lib/report-generator.js:346-369`, the `roster_coverage` report, reached from `POST /api/schedule/reports` and the scheduled-report cron. It walks `new Date(period_start + 'T00:00:00')` with `setDate` and keys each day with `d.toISOString().split('T')[0]`. Measured under `TZ=Europe/Dublin`:

```
2026-05-04..2026-05-10  →  2026-05-03,2026-05-04,…,2026-05-09        (starts Sunday, loses the last Sunday)
2026-03-27..2026-04-02  →  …,2026-03-29,2026-03-29,2026-03-30,…,2026-04-01  (29 Mar twice, 2 Apr lost)
```

Under UTC (Vercel, CI) and US zones the keys are right, so **the live reports were correct**; the defect bites any process east of UTC (local dev, a Dublin-TZ test, a future host). Task 8 fixes it with `addDaysISO` (`src/lib/dublin-time.js:81-85`) and pins it in TZ-specific test files, following `src/lib/report-generator.period.tz.test.js`.

**Rules that bite in this PR:**
- Keep each route's error SHAPE: `validateBody` routes answer `{ success:false, error:'Invalid request body', issues:[{ path, message }] }` (`src/lib/validate.js:65-77`); the query-schema routes (`overview`, `week-cost`, `contractor-spend`) join issues into `error` as `name: message; …`; the hand-read query routes (`blocks`, `shifts`, `time-off` GET) answer `{ success:false, error }`. Status stays 400.
- Zod 4 runs `.refine` even after the regex fails, so a bad SHAPE (`25/09/2026`) reports two issues (`Use YYYY-MM-DD` and `Use a real date, YYYY-MM-DD`). That is already what `POST /time-off` does. A well-shaped impossible date reports exactly one. Tests assert the one-issue case exactly and the bad-shape case with `toContain`.
- An empty query param (`?start_date=`) stays "no bound", as today (`if (startDate)`), so the checks only fire on a present, non-empty value.
- The repo is PUBLIC: fixtures use `Coach One`, `loc-1`, no real names.

---

### File map

| File | Change |
|---|---|
| `src/lib/schemas.js` | Modify: add `realIsoDate` after `isRealCalendarDate` (after line 38) |
| `src/lib/schemas.test.js` | Modify: import (line 3), new describe after the `isRealCalendarDate` describe (after line 313) |
| `src/app/api/schedule/time-off/route.js` | Modify: import line 6; lines 24-27 (`ISO_DATE`); new check between lines 64 and 65 |
| `src/app/api/schedule/time-off/route.test.js` | Modify: new describe at the end |
| `src/app/api/schedule/blocks/route.js` | Modify: import line 22; line 29; new check between lines 46 and 47 |
| `src/app/api/schedule/blocks/route.test.js` | Modify: new GET describe after line 161; new POST case inside the POST describe |
| `src/app/api/schedule/rosters/route.js` | Modify: import line 32; lines 52-53 |
| `src/app/api/schedule/rosters/route.test.js` | Modify: new describe at the end |
| `src/app/api/schedule/week-cost/route.js` | Modify: import line 32; lines 38-41 |
| `src/app/api/schedule/week-cost/route.test.js` | Modify: two cases in the `contract` describe |
| `src/app/api/schedule/contractor-spend/route.js` | Modify: import line 28; lines 34-37 |
| `src/app/api/schedule/contractor-spend/route.test.js` | Modify: one case in `GET — query validation` |
| `src/app/api/schedule/overview/route.js` | Modify: import line 27; lines 47-51 |
| `src/app/api/schedule/overview/route.test.js` | Modify: one case at the end of the describe |
| `src/app/api/schedule/shifts/route.js` | Modify: import line 6; new check between lines 25 and 26 |
| `src/app/api/schedule/shifts/route.test.js` | Modify: new describe at the end |
| `src/app/api/schedule/reports/route.js` | Modify: import line 7; lines 24-25 |
| `src/app/api/schedule/reports/route.test.js` | Modify: new describe at the end |
| `src/app/api/schedule/shifts/copy-week/route.js` | Modify: import line 6; lines 14-15 |
| `src/app/api/schedule/shifts/copy-week/route.test.js` | Modify: new describe at the end |
| `src/app/api/schedule/shifts/copy-month/route.js` | Modify: import line 47; lines 59-60 |
| `src/app/api/schedule/shifts/copy-month/route.test.js` | Modify: new describe at the end |
| `src/lib/report-generator.js` | Modify: imports (lines 1-6); real-date floor after line 149; `roster_coverage` day walk lines 345-369 |
| `src/lib/report-generator.test.js` | Modify: new describe at the end |
| `src/lib/report-generator.coverage.tz.test.js` | Create: Europe/Dublin half |
| `src/lib/report-generator.coverage.tz-us.test.js` | Create: America/New_York half |
| `src/app/api/schedule/date-inputs.test.js` | Create: the source-scan guard |
| `src/lib/openapi.js` | Modify: lines 4327-4328 (shifts 400), 4361 (blocks `block_date`), 4453 (week-cost 400) |
| `docs/CHANGELOG.md` | Modify: one new row, after `gh pr create` |

---

### Task 1: `realIsoDate`, the shape check and the calendar check as one schema

**Files:** Modify `src/lib/schemas.js`, `src/lib/schemas.test.js`, `src/app/api/schedule/time-off/route.js`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/schemas.test.js` change line 3:

```js
  isoDate, isRealCalendarDate, realIsoDate, timeOfDay, hexColor, email, url,
```

and add after the `describe('isRealCalendarDate', …)` block (it ends at line 313):

```js
// DATECHECK.1 — the two checks as one schema, for every schedule route.
describe('realIsoDate', () => {
  it('passes a real date through unchanged, leap day included', () => {
    expect(realIsoDate.parse('2026-09-25')).toBe('2026-09-25')
    expect(realIsoDate.parse('2028-02-29')).toBe('2028-02-29')
  })

  it('refuses a well-shaped date the calendar does not have, with exactly one message', () => {
    for (const d of ['2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2027-02-29']) {
      const r = realIsoDate.safeParse(d)
      expect(r.success).toBe(false)
      expect(r.error.issues.map((i) => i.message)).toEqual(['Use a real date, YYYY-MM-DD'])
    }
  })

  it('still names the shape when the shape is wrong', () => {
    const r = realIsoDate.safeParse('25/09/2026')
    expect(r.success).toBe(false)
    expect(r.error.issues.map((i) => i.message)).toContain('Use YYYY-MM-DD')
  })

  it('refuses a non-string without throwing', () => {
    expect(realIsoDate.safeParse(null).success).toBe(false)
    expect(realIsoDate.safeParse(20260925).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/schemas.test.js`
Expected: the four `realIsoDate` cases fail with `Cannot read properties of undefined (reading 'parse')` / `(reading 'safeParse')`. Everything else passes.

- [ ] **Step 3: Minimal implementation**

In `src/lib/schemas.js`, insert after the closing `}` of `isRealCalendarDate` (line 38):

```js

/**
 * DATECHECK.1 — isoDate AND isRealCalendarDate as one schema. Use it for any
 * date a route hands to the database or does arithmetic on: the shape alone
 * lets 2026-02-30 through, which V8 reads as 2 March and Postgres refuses.
 * A well-shaped impossible date gets one issue (the message below); a bad
 * shape gets 'Use YYYY-MM-DD' as well (Zod runs the refine after a failed
 * regex). For a raw query param, call isRealCalendarDate directly.
 */
export const realIsoDate = isoDate.refine(isRealCalendarDate, 'Use a real date, YYYY-MM-DD')
```

In `src/app/api/schedule/time-off/route.js` change line 6:

```js
import { timeOffTypeSchema, MANAGER_ROLES, realIsoDate, isRealCalendarDate } from '@/lib/schemas'
```

and replace lines 24-27:

```js
// SCHEDHYGIENE.1 — the shared shape check plus the shared calendar check. The
// pattern alone let 2026-02-30 through: V8 rolled it to 2 March for the day
// count, and Postgres refused it at the insert with a 500.
const ISO_DATE = isoDate.refine(isRealCalendarDate, 'Use a real date, YYYY-MM-DD')
```

with:

```js
// SCHEDHYGIENE.1 — the shared shape check plus the shared calendar check. The
// pattern alone let 2026-02-30 through: V8 rolled it to 2 March for the day
// count, and Postgres refused it at the insert with a 500. DATECHECK.1 moved
// the pair into schemas.js as realIsoDate (same message), shared by every
// schedule route.
const ISO_DATE = realIsoDate
```

(`isRealCalendarDate` stays imported: the preview at line 555 uses it.)

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/schemas.test.js src/app/api/schedule/time-off/route.test.js`
Expected: all pass. The time-off file is the regression guard for the refactor: its SCHEDHYGIENE.1 impossible-date POST cases still get the same 400.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas.js src/lib/schemas.test.js src/app/api/schedule/time-off/route.js
git commit -m "$(cat <<'EOF'
DATECHECK.1 — realIsoDate: the shape check and the calendar check as one schema

POST /api/schedule/time-off now uses it in place of its local copy (same
message, same 400).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `/api/schedule/blocks`, GET range and POST `block_date`

**Files:** Modify `src/app/api/schedule/blocks/route.js`, `src/app/api/schedule/blocks/route.test.js`.

- [ ] **Step 1: Write the failing tests**

In `src/app/api/schedule/blocks/route.test.js`, add this describe after the `GET /api/schedule/blocks — manager view` describe (it ends at line 161):

```js
// DATECHECK.1 — the range bounds went to Postgres unchecked, and the route
// answered 400 with Postgres's own "date/time field value out of range".
describe('GET /api/schedule/blocks — a date the calendar does not have', () => {
  const MANAGER = { id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' } }

  it('400s in the route\'s own words, before any read', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    for (const [qs, name] of [
      ['&start_date=2026-02-30&end_date=2026-03-06', 'start_date'],
      ['&start_date=2026-04-27&end_date=2026-04-31', 'end_date'],
      ['&start_date=2026-13-01', 'start_date'],
      ['&end_date=soon', 'end_date'],
    ]) {
      const res = await GET(req(`http://x/api/schedule/blocks?location_id=loc-1${qs}`))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ success: false, error: `${name}: not a real date` })
    }
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('a real range (leap day included) still reads, bounded on block_date', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    const q = {}
    for (const op of ['eq', 'in', 'gte', 'lte', 'order']) q[op] = (...args) => { calls.push([op, ...args]); return q }
    q.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej)
    createServerClient.mockReturnValue({ from: () => ({ select: () => q }) })

    const res = await GET(req('http://x/api/schedule/blocks?location_id=loc-1&start_date=2028-02-28&end_date=2028-02-29'))
    expect(res.status).toBe(200)
    expect(calls).toContainEqual(['gte', 'block_date', '2028-02-28'])
    expect(calls).toContainEqual(['lte', 'block_date', '2028-02-29'])
  })
})
```

and inside `describe('POST /api/schedule/blocks — post-publish blocks join the roster', …)`, directly after the `'does not touch the removal when the create fails'` case (ends at line 294):

```js
  // DATECHECK.1 — an impossible date used to reach the insert, which Postgres
  // refused with its own text as a 400, after a rosters read that logged a
  // warning and answered "not published".
  it('400s on a block_date the calendar does not have, and reads or writes nothing', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } })
    const { POST } = await import('./route.js')

    for (const block_date of ['2026-02-30', '2026-06-31', '2027-02-29']) {
      const res = await POST(postReq({ location_id: LOC, template_id: TPL, block_date }))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toBe('Invalid request body')
      expect(json.issues).toEqual([{ path: 'block_date', message: 'Use a real date, YYYY-MM-DD' }])
    }
    expect(createServerClient).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/blocks/route.test.js`
Expected: the GET refusal case and the POST case fail with `TypeError: Cannot read properties of undefined (reading 'from')` (the reset `createServerClient` returns nothing because the route got past validation and built a query). The "real range" case passes already; it is the guard that the fix does not refuse real dates.

- [ ] **Step 3: Minimal implementation**

In `src/app/api/schedule/blocks/route.js` change line 22:

```js
import { uuidLike, realIsoDate, isRealCalendarDate, timeOfDay, MANAGER_ROLES } from '@/lib/schemas'
```

change line 29:

```js
  block_date: realIsoDate,
```

and insert between line 46 (`const endDate = searchParams.get('end_date')`) and line 47 (`const db = createServerClient()`):

```js
  // DATECHECK.1 — these bounds reach Postgres as they are, and it refuses
  // 2026-02-30 (the route used to hand back its error text as the 400). Refuse
  // it here, in change-log's words. Absent or empty = no bound, as before.
  for (const [name, value] of [['start_date', startDate], ['end_date', endDate]]) {
    if (value && !isRealCalendarDate(value)) {
      return NextResponse.json({ success: false, error: `${name}: not a real date` }, { status: 400 })
    }
  }
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/blocks/route.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/blocks/route.js src/app/api/schedule/blocks/route.test.js
git commit -m "$(cat <<'EOF'
DATECHECK.1 — /api/schedule/blocks refuses a date the calendar does not have

GET start_date/end_date had no check at all; POST block_date was shape-only.
Both reached Postgres and came back as a 400 carrying its error text.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `POST /api/schedule/rosters`, the publish period

**Files:** Modify `src/app/api/schedule/rosters/route.js`, `src/app/api/schedule/rosters/route.test.js`.

- [ ] **Step 1: Write the failing test**

Append to the end of `src/app/api/schedule/rosters/route.test.js`:

```js
// DATECHECK.1 — an impossible period reached the overlap probe, and the publish
// (or its dry run) answered 400 with Postgres's "date/time field value out of range".
describe('POST /api/schedule/rosters — a period the calendar does not have', () => {
  it('400s before any read, dry run or not', async () => {
    for (const [body, path] of [
      [{ period_start: '2026-02-30', period_end: '2026-03-06' }, 'period_start'],
      [{ period_start: '2026-04-27', period_end: '2026-04-31' }, 'period_end'],
      [{ period_start: '2026-13-01', period_end: '2026-13-07', dry_run: true }, 'period_start'],
    ]) {
      const res = await publish(body)
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toBe('Invalid request body')
      expect(json.issues).toContainEqual({ path, message: 'Use a real date, YYYY-MM-DD' })
    }
    expect(createServerClient).not.toHaveBeenCalled()
    expect(projectPublishImpact).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/rosters/route.test.js`
Expected: the new case fails with `TypeError: Cannot read properties of undefined (reading 'from')` (validation passed, the reset client is undefined). Every other case passes.

- [ ] **Step 3: Minimal implementation**

In `src/app/api/schedule/rosters/route.js` change line 32:

```js
import { uuidLike, realIsoDate, MANAGER_ROLES } from '@/lib/schemas'
```

and lines 52-53:

```js
  // DATECHECK.1 — real dates, not just the shape: 2026-02-30 reached the
  // overlap probe and came back as Postgres's own 400.
  period_start: realIsoDate,
  period_end: realIsoDate,
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/rosters/route.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/rosters/route.js src/app/api/schedule/rosters/route.test.js
git commit -m "$(cat <<'EOF'
DATECHECK.1 — roster publish refuses a period the calendar does not have

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `week-cost` and `contractor-spend` stop answering for the month a bad date rolls into

These two are the silent ones: today they answer **200** for `2026-02-30`, with the week of 2 March and with March's spend.

**Files:** Modify `src/app/api/schedule/week-cost/route.js`, `src/app/api/schedule/week-cost/route.test.js`, `src/app/api/schedule/contractor-spend/route.js`, `src/app/api/schedule/contractor-spend/route.test.js`.

- [ ] **Step 1: Write the failing tests**

In `src/app/api/schedule/week-cost/route.test.js`, inside `describe('GET /api/schedule/week-cost — contract', …)`, after the `'400 on a missing or malformed param, before any work is done'` case (ends at line 156):

```js
  // DATECHECK.1 — 2026-02-30 was parsed as 2 March and answered 200 with the
  // week of 2 March: numbers for a week nobody asked about, with no error.
  it('400 on a week_start the calendar does not have, and computes nothing', async () => {
    for (const week_start of ['2026-02-30', '2026-04-31', '2026-13-01', '2027-02-29']) {
      const res = await GET(buildReq({ location_id: LOC, week_start }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('week_start: Use a real date, YYYY-MM-DD')
    }
    expect(computeWeeklyFteHours).not.toHaveBeenCalled()
  })

  it('29 Feb in a leap year is a real date', async () => {
    const res = await GET(buildReq({ location_id: LOC, week_start: '2028-02-29' }))
    expect(res.status).toBe(200)
    expect(computeWeeklyFteHours).toHaveBeenCalledWith(expect.objectContaining({ weekStart: '2028-02-29' }))
  })
```

In `src/app/api/schedule/contractor-spend/route.test.js`, inside `describe('GET — query validation', …)`, after the `'400 on a non-uuid location_id'` case (ends at line 149):

```js
  // DATECHECK.1 — 2026-02-30 was read as 2 March and answered 200 with
  // MARCH's spend and budget.
  it('400 on a reference_date the calendar does not have, and computes nothing', async () => {
    for (const reference_date of ['2026-02-30', '2026-09-31', '2026-13-01']) {
      const res = await GET(buildReq({ location_id: LOC, reference_date }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('reference_date: Use a real date, YYYY-MM-DD')
    }
    expect(computeMonthlyContractorSpend).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/app/api/schedule/week-cost/route.test.js src/app/api/schedule/contractor-spend/route.test.js`
Expected: `expected 200 to be 400` in both new refusal cases (the helper mocks resolve, so the rolled date sails through). The leap-day case passes already.

- [ ] **Step 3: Minimal implementation**

In `src/app/api/schedule/week-cost/route.js` change line 32:

```js
import { uuidLike, realIsoDate, MANAGER_ROLES } from '@/lib/schemas'
```

and replace lines 38-41:

```js
const QuerySchema = z.object({
  location_id: uuidLike,
  week_start: isoDate,
})
```

with:

```js
const QuerySchema = z.object({
  location_id: uuidLike,
  // DATECHECK.1 — a real date, not just the shape: 2026-02-30 was parsed as
  // 2 March and answered 200 with the week of 2 March, silently.
  week_start: realIsoDate,
})
```

In `src/app/api/schedule/contractor-spend/route.js` change line 28:

```js
import { uuidLike, realIsoDate, MANAGER_ROLES } from '@/lib/schemas'
```

and replace lines 34-37:

```js
const QuerySchema = z.object({
  location_id: uuidLike,
  reference_date: isoDate,
})
```

with:

```js
const QuerySchema = z.object({
  location_id: uuidLike,
  // DATECHECK.1 — a real date, not just the shape: 2026-02-30 was read as
  // 2 March and answered 200 with March's spend and budget, silently.
  reference_date: realIsoDate,
})
```

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/app/api/schedule/week-cost/route.test.js src/app/api/schedule/contractor-spend/route.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/week-cost src/app/api/schedule/contractor-spend
git commit -m "$(cat <<'EOF'
DATECHECK.1 — week-cost and contractor-spend refuse a date the calendar does not have

Both answered 200 for 2026-02-30, with the week of 2 March and with March's
spend: a silently wrong answer, not an error.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `GET /api/schedule/overview`

**Files:** Modify `src/app/api/schedule/overview/route.js`, `src/app/api/schedule/overview/route.test.js`.

- [ ] **Step 1: Write the failing test**

In `src/app/api/schedule/overview/route.test.js`, inside the describe, after the `'401 with no session'` case (ends at line 89):

```js
  // DATECHECK.1 — Date.UTC rolled 2026-02-30 to 2 March, the span check
  // passed, and the reads then 500'd on Postgres's refusal.
  it('a manager sending a date the calendar does not have gets a 400, and nothing is read', async () => {
    getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(LOC_A))
    for (const [qs, name] of [['from=2026-02-30&to=2026-03-06', 'from'], ['from=2026-09-01&to=2026-09-31', 'to']]) {
      const res = await GET({ url: `http://test/api/schedule/overview?${qs}&location_id=${LOC_A}` })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(`${name}: Use a real date, YYYY-MM-DD`)
    }
    expect(db.tables).toEqual([])
  })
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/overview/route.test.js`
Expected: `expected 200 to be 400` (the fake db answers every read with `[]`, so the rolled date produces an overview).

- [ ] **Step 3: Minimal implementation**

In `src/app/api/schedule/overview/route.js` change line 27:

```js
import { MANAGER_ROLES, uuidLike, realIsoDate } from '@/lib/schemas'
```

and replace lines 47-51:

```js
const QuerySchema = z.object({
  from:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  to:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  location_id: uuidLike,
})
```

with:

```js
// DATECHECK.1 — the shared shape+calendar schema. The old regex let 2026-02-30
// through; Date.UTC below rolled it to 2 March and the reads 500'd.
const QuerySchema = z.object({
  from:        realIsoDate,
  to:          realIsoDate,
  location_id: uuidLike,
})
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/overview/route.test.js`
Expected: all pass (the existing `from=bad` case still gets its 400).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/overview
git commit -m "$(cat <<'EOF'
DATECHECK.1 — the studio overview refuses a date the calendar does not have

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: the phone-facing lists, `GET /api/schedule/shifts` and `GET /api/schedule/time-off`

**Files:** Modify `src/app/api/schedule/shifts/route.js`, `src/app/api/schedule/shifts/route.test.js`, `src/app/api/schedule/time-off/route.js`, `src/app/api/schedule/time-off/route.test.js`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `src/app/api/schedule/shifts/route.test.js`:

```js
// DATECHECK.1 — the phone's Schedule tab feed. Its range went to Postgres
// unchecked and came back as a 400 carrying Postgres's error text.
describe('GET /api/schedule/shifts — a date the calendar does not have', () => {
  const COACH = { id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] }

  it('400s in the route\'s own words, before any read', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    for (const [qs, name] of [
      ['&start_date=2026-02-30&end_date=2026-03-06', 'start_date'],
      ['&start_date=2026-06-01&end_date=2026-06-31', 'end_date'],
    ]) {
      const res = await GET(req(`http://x/api/schedule/shifts?location_id=loc-1${qs}`))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ success: false, error: `${name}: not a real date` })
    }
    expect(fetchApiShiftRows).not.toHaveBeenCalled()
  })

  it('a real range (leap day included) is handed to the reader unchanged', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    const res = await GET(req('http://x/api/schedule/shifts?location_id=loc-1&start_date=2028-02-28&end_date=2028-02-29'))
    expect(res.status).toBe(200)
    expect(fetchApiShiftRows.mock.calls[0][1]).toMatchObject({ startDate: '2028-02-28', endDate: '2028-02-29' })
  })
})
```

Append to the end of `src/app/api/schedule/time-off/route.test.js`:

```js
// DATECHECK.1 — the list's range (the Time Off page, the roster's leave read,
// the phone's My leave) reached Postgres unchecked and came back as a 400 with
// its error text, after the member read had already run. preview=1 and the
// POST were checked already (SCHEDHYGIENE.1).
describe('GET /api/schedule/time-off — a date the calendar does not have', () => {
  const getReq = (qs) => ({ url: `http://x/api/schedule/time-off${qs}`, headers: { get: () => '' } })
  const MANAGER = { id: 'boss', role: 'manager', profileRole: 'staff', activeLocation: { id: 'loc-1' }, locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } }

  it('400s in the route\'s own words, before any read', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    for (const [qs, name] of [
      ['?location_id=loc-1&start_date=2026-02-30&end_date=2026-03-06', 'start_date'],
      ['?location_id=loc-1&start_date=2026-04-01&end_date=2026-04-31', 'end_date'],
      ['?location_id=loc-1&start_date=2026-13-01', 'start_date'],
    ]) {
      const db = fakeDb(() => ({ data: [], error: null }))
      createServerClient.mockReturnValue(db)
      const res = await GET(getReq(qs))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ success: false, error: `${name}: not a real date` })
      expect(db.queries).toHaveLength(0)
    }
  })

  it('a real range still lists the requests that overlap it', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const db = fakeDb(() => ({ data: [], error: null }))
    createServerClient.mockReturnValue(db)
    const res = await GET(getReq('?location_id=loc-1&start_date=2026-02-23&end_date=2026-03-01'))
    expect(res.status).toBe(200)
    const list = queriesOf(db, 'time_off_requests')[0]
    expect(list.calls).toContainEqual(['lte', 'start_date', '2026-03-01'])
    expect(list.calls).toContainEqual(['gte', 'end_date', '2026-02-23'])
  })
})
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/app/api/schedule/shifts/route.test.js src/app/api/schedule/time-off/route.test.js`
Expected: both "400s" cases fail with `expected 200 to be 400` (the mocked reader and fake db answer `[]`). The "real range" cases pass already.

- [ ] **Step 3: Minimal implementation**

In `src/app/api/schedule/shifts/route.js` change line 6:

```js
import { MANAGER_ROLES, isRealCalendarDate } from '@/lib/schemas'
```

and insert between line 25 (`const profileId = searchParams.get('profile_id')`) and line 26 (`const db = createServerClient()`):

```js
  // DATECHECK.1 — these bounds reach Postgres as they are, and it refuses
  // 2026-02-30 (the route used to hand back its error text as the 400). Refuse
  // it here, in change-log's words. Absent or empty = no bound, as before.
  for (const [name, value] of [['start_date', startDate], ['end_date', endDate]]) {
    if (value && !isRealCalendarDate(value)) {
      return NextResponse.json({ success: false, error: `${name}: not a real date` }, { status: 400 })
    }
  }
```

In `src/app/api/schedule/time-off/route.js` (import already done in Task 1) insert between line 64 (`const profileId = searchParams.get('profile_id')`) and line 65 (`const db = createServerClient()`):

```js
  // DATECHECK.1 — the list's range bounds reach Postgres as they are, and it
  // refuses 2026-02-30 with a 400 carrying its own text (after the member read
  // had run). Refuse it first, in change-log's words. The preview above has its
  // own check. Absent or empty = no bound, as before.
  for (const [name, value] of [['start_date', startDate], ['end_date', endDate]]) {
    if (value && !isRealCalendarDate(value)) {
      return NextResponse.json({ success: false, error: `${name}: not a real date` }, { status: 400 })
    }
  }
```

(After Task 1 the line numbers in `time-off/route.js` are +2, because the `ISO_DATE` comment grew by two lines: insert after the GET's `const profileId = searchParams.get('profile_id')` (now line 66), before its `const db = createServerClient()` (now line 67).)

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/app/api/schedule/shifts/route.test.js src/app/api/schedule/time-off/route.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/shifts/route.js src/app/api/schedule/shifts/route.test.js src/app/api/schedule/time-off/route.js src/app/api/schedule/time-off/route.test.js
git commit -m "$(cat <<'EOF'
DATECHECK.1 — the shifts and leave lists refuse a date the calendar does not have

Both read start_date/end_date straight into a Postgres filter; an impossible
date came back as a 400 carrying Postgres's error text.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: the remaining body routes, `reports`, `copy-week`, `copy-month`

**Files:** Modify `src/app/api/schedule/reports/route.js`, `src/app/api/schedule/reports/route.test.js`, `src/app/api/schedule/shifts/copy-week/route.js`, `src/app/api/schedule/shifts/copy-week/route.test.js`, `src/app/api/schedule/shifts/copy-month/route.js`, `src/app/api/schedule/shifts/copy-month/route.test.js`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `src/app/api/schedule/reports/route.test.js`:

```js
// DATECHECK.1 — an impossible period reached generateReport, whose reads (or,
// for time_off_summary, the save) Postgres refused: a 400 with its text.
describe('POST /api/schedule/reports — a period the calendar does not have', () => {
  it('400s and generates nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    for (const [period_start, period_end, path] of [
      ['2026-02-30', '2026-03-06', 'period_start'],
      ['2026-04-01', '2026-04-31', 'period_end'],
    ]) {
      const res = await POST(postReq({ report_type: 'staff_hours', period_start, period_end, location_id: LOC_A }))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toBe('Invalid request body')
      expect(json.issues).toEqual([{ path, message: 'Use a real date, YYYY-MM-DD' }])
    }
    expect(generateReport).not.toHaveBeenCalled()
  })
})
```

Append to the end of `src/app/api/schedule/shifts/copy-week/route.test.js`:

```js
// DATECHECK.1 — an impossible source week 400'd on Postgres's text from the
// source read; an impossible target week 500'd from the leave read.
describe('POST /api/schedule/shifts/copy-week — a date the calendar does not have', () => {
  it('400s and reads or writes nothing', async () => {
    for (const [over, path] of [
      [{ source_start: '2026-02-30' }, 'source_start'],
      [{ target_start: '2026-02-30' }, 'target_start'],
      [{ target_start: '2026-13-02' }, 'target_start'],
    ]) {
      const res = await POST(req({ location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08', ...over }))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toBe('Invalid request body')
      expect(json.issues).toEqual([{ path, message: 'Use a real date, YYYY-MM-DD' }])
    }
    expect(fetchSourceBlocks).not.toHaveBeenCalled()
    expect(fetchLeaveLookup).not.toHaveBeenCalled()
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
  })
})
```

Append to the end of `src/app/api/schedule/shifts/copy-month/route.test.js`:

```js
// DATECHECK.1 — the first-of-month check stops day 30, but month 00 and 13
// passed it: daysInMonth gave NaN and '2026-13-NaN' reached the source read.
describe('POST /api/schedule/shifts/copy-month — a month the calendar does not have', () => {
  it('400s and reads or writes nothing', async () => {
    for (const [over, path] of [
      [{ source_month_start: '2026-13-01' }, 'source_month_start'],
      [{ target_month_start: '2026-00-01' }, 'target_month_start'],
    ]) {
      const res = await POST(req({ location_id: LOC, source_month_start: '2026-08-01', target_month_start: '2026-09-01', ...over }))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toBe('Invalid request body')
      expect(json.issues).toEqual([{ path, message: 'Use a real date, YYYY-MM-DD' }])
    }
    expect(fetchSourceBlocks).not.toHaveBeenCalled()
    expect(fetchLeaveLookup).not.toHaveBeenCalled()
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/app/api/schedule/reports/route.test.js src/app/api/schedule/shifts/copy-week/route.test.js src/app/api/schedule/shifts/copy-month/route.test.js`
Expected: reports: `expected 201 to be 400` (the mocked generator succeeds). copy-week and copy-month: `TypeError: Cannot destructure property 'blocks' of '(intermediate value)' as it is undefined` (validation passed; the reset `fetchSourceBlocks` returns nothing).

- [ ] **Step 3: Minimal implementation**

`src/app/api/schedule/reports/route.js` line 7:

```js
import { uuidLike, realIsoDate, reportTypeSchema, MANAGER_ROLES } from '@/lib/schemas'
```

lines 24-25:

```js
  // DATECHECK.1 — real dates, not just the shape.
  period_start: realIsoDate,
  period_end: realIsoDate,
```

`src/app/api/schedule/shifts/copy-week/route.js` line 6:

```js
import { uuidLike, realIsoDate, MANAGER_ROLES } from '@/lib/schemas'
```

lines 14-15:

```js
  // DATECHECK.1 — real dates, not just the shape.
  source_start: realIsoDate,
  target_start: realIsoDate,
```

`src/app/api/schedule/shifts/copy-month/route.js` line 47:

```js
import { uuidLike, realIsoDate, MANAGER_ROLES } from '@/lib/schemas'
```

lines 59-60:

```js
  // DATECHECK.1 — real dates, not just the shape (month 00/13 passed the
  // first-of-month check below).
  source_month_start: realIsoDate,
  target_month_start: realIsoDate,
```

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/app/api/schedule/reports/route.test.js src/app/api/schedule/shifts/copy-week/route.test.js src/app/api/schedule/shifts/copy-month/route.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/reports src/app/api/schedule/shifts/copy-week src/app/api/schedule/shifts/copy-month
git commit -m "$(cat <<'EOF'
DATECHECK.1 — reports, copy-week and copy-month refuse a date the calendar does not have

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `generateReport` — a real-date floor, and the coverage report walks calendar strings

**Files:** Modify `src/lib/report-generator.js`, `src/lib/report-generator.test.js`. Create `src/lib/report-generator.coverage.tz.test.js`, `src/lib/report-generator.coverage.tz-us.test.js`.

Why a floor inside `generateReport` when Task 7 already guards the route: the scheduled-report cron calls it too (its period comes from `calculatePeriodForSchedule`, real by construction), and the new day walk steps a string forward until it passes `period_end`, which is only finite when both ends are real dates. The old `Date` walk ended by accident on an `Invalid Date` (`NaN <= NaN` is false).

- [ ] **Step 1: Write the failing tests**

Append to the end of `src/lib/report-generator.test.js`:

```js
// DATECHECK.1 — the routes refuse an impossible period before calling this;
// this is the floor for any other caller, checked before a single read.
describe('generateReport — a period the calendar does not have', () => {
  beforeEach(() => { vi.clearAllMocks() })

  for (const [period_start, period_end] of [['2026-02-30', '2026-03-06'], ['2026-04-01', '2026-04-31'], ['2026-13-01', '2026-13-07']]) {
    it(`${period_start} to ${period_end} is refused, and nothing is read`, async () => {
      const { db } = makeReportDb({})
      createServerClient.mockReturnValue(db)

      const res = await generateReport({ report_type: 'roster_coverage', period_start, period_end, location_id: 'loc1' })
      expect(res).toEqual({ success: false, error: 'period_start and period_end must be real dates, YYYY-MM-DD' })
      expect(db.from).not.toHaveBeenCalled()
    })
  }
})
```

Create `src/lib/report-generator.coverage.tz.test.js`:

```js
// DATECHECK.1 — the roster coverage report's days, pinned to Europe/Dublin.
//
// roster_coverage walked its period with LOCAL-midnight Dates and keyed each
// day with toISOString(), which is UTC. Under Irish summer time local midnight
// is 23:00 UTC the day before, so every key slid back a day: a Mon 4 - Sun 10
// May report ran Sun 3 - Sat 9 May and never counted a shift on the last
// Sunday, and the week the clocks go forward keyed Sun 29 Mar twice and lost
// its last day. CI and Vercel run in UTC, where the two readings agree, so only
// a file that pins the zone can see it (same reasoning, same mechanics, as
// report-generator.period.tz.test.js). The US half is
// report-generator.coverage.tz-us.test.js.
process.env.TZ = 'Europe/Dublin'

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { generateReport } = await import('./report-generator.js')

function coverageDb({ shifts = [], timeOff = [] } = {}) {
  const captured = {}
  const from = (table) => {
    const b = {
      select: () => b, eq: () => b, gte: () => b, lte: () => b, in: () => b, order: () => b, range: () => b,
      insert: (rec) => { captured.inserted = rec; return b },
      single: () => Promise.resolve({ data: { id: 'gen-1', ...captured.inserted }, error: null }),
      then: (ok, err) => Promise.resolve({
        data: table === 'shift_assignments' ? shifts : table === 'time_off_requests' ? timeOff : [],
        error: null,
      }).then(ok, err),
    }
    return b
  }
  return { db: { from }, captured }
}

function shiftOn(date) {
  return {
    profile_id: 'p1', status: 'scheduled', start_time_override: null, end_time_override: null,
    profiles: { full_name: 'Coach One', role: 'staff', employment_type: 'fte' },
    shift_blocks: {
      block_date: date, start_time: '09:00:00', end_time: '10:00:00', location_id: 'loc1',
      shift_templates: { name: 'AM', start_time: '09:00:00', end_time: '10:00:00' },
    },
  }
}

async function coverageDays(period_start, period_end, data = {}) {
  const { db, captured } = coverageDb(data)
  createServerClient.mockReturnValue(db)
  const res = await generateReport({ report_type: 'roster_coverage', period_start, period_end, location_id: 'loc1' })
  expect(res.success).toBe(true)
  return captured.inserted.report_data.days
}

describe('roster_coverage — Europe/Dublin (BST, UTC+1)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('the host really is on Dublin time', () => {
    // Guard the guard: without this, a TZ that stopped taking effect would
    // turn the cases below into a UTC re-run that can never fail.
    expect(new Date('2026-05-15T12:00:00+01:00').getHours()).toBe(12)
  })

  it('a summer week runs Monday to Sunday, and the Sunday shift is counted', async () => {
    const days = await coverageDays('2026-05-04', '2026-05-10', { shifts: [shiftOn('2026-05-10')] })
    expect(days.map((d) => d.date)).toEqual([
      '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09', '2026-05-10',
    ])
    expect(days.find((d) => d.date === '2026-05-10').shifts_count).toBe(1)
  })

  it('the week the clocks go forward has seven different days', async () => {
    const days = await coverageDays('2026-03-27', '2026-04-02')
    expect(days.map((d) => d.date)).toEqual([
      '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02',
    ])
  })

  it('leave lands on its own days, clipped to the period', async () => {
    const days = await coverageDays('2026-05-04', '2026-05-10', {
      timeOff: [{ start_date: '2026-05-09', end_date: '2026-05-12', profile_id: 'p2', type: 'holiday', profiles: { full_name: 'Coach Two' } }],
    })
    const off = Object.fromEntries(days.map((d) => [d.date, d.staff_off]))
    expect(off['2026-05-08']).toEqual([])
    expect(off['2026-05-09']).toEqual(['Coach Two'])
    expect(off['2026-05-10']).toEqual(['Coach Two'])
  })
})
```

Create `src/lib/report-generator.coverage.tz-us.test.js`:

```js
// DATECHECK.1 — the US half of report-generator.coverage.tz.test.js. West of
// UTC, local midnight is the same UTC day, so the old walk happened to be right
// here; this file keeps the new one right too (CLAUDE.md: test date code under
// Europe/Dublin AND a US zone). It passes before and after the fix: it is a
// guard, not the proof. US clocks go forward on Sun 8 Mar 2026.
process.env.TZ = 'America/New_York'

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { generateReport } = await import('./report-generator.js')

function coverageDb({ shifts = [] } = {}) {
  const captured = {}
  const from = (table) => {
    const b = {
      select: () => b, eq: () => b, gte: () => b, lte: () => b, in: () => b, order: () => b, range: () => b,
      insert: (rec) => { captured.inserted = rec; return b },
      single: () => Promise.resolve({ data: { id: 'gen-1', ...captured.inserted }, error: null }),
      then: (ok, err) => Promise.resolve({ data: table === 'shift_assignments' ? shifts : [], error: null }).then(ok, err),
    }
    return b
  }
  return { db: { from }, captured }
}

async function coverageDates(period_start, period_end, data = {}) {
  const { db, captured } = coverageDb(data)
  createServerClient.mockReturnValue(db)
  const res = await generateReport({ report_type: 'roster_coverage', period_start, period_end, location_id: 'loc1' })
  expect(res.success).toBe(true)
  return captured.inserted.report_data.days
}

describe('roster_coverage — America/New_York', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('the host really is on New York time', () => {
    expect(new Date('2026-05-15T12:00:00-04:00').getHours()).toBe(12)
  })

  it('a summer week runs Monday to Sunday', async () => {
    const days = await coverageDates('2026-05-04', '2026-05-10')
    expect(days.map((d) => d.date)).toEqual([
      '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09', '2026-05-10',
    ])
  })

  it('the week US clocks go forward has seven different days', async () => {
    const days = await coverageDates('2026-03-05', '2026-03-11')
    expect(days.map((d) => d.date)).toEqual([
      '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11',
    ])
  })
})
```

- [ ] **Step 2: Run them, expect FAIL (Dublin and the floor), PASS (US)**

Run: `npx vitest run src/lib/report-generator.test.js src/lib/report-generator.coverage.tz.test.js src/lib/report-generator.coverage.tz-us.test.js`
Expected:
- `report-generator.test.js`: the three new cases fail (`expected { success: true, … } to deeply equal { success: false, … }`; the rolled period produces a report).
- `coverage.tz.test.js`: the guard passes; the summer week fails with `2026-05-03` first and `2026-05-10` missing; the clocks-forward week fails with `2026-03-29` twice / six keys; the leave case fails with `off['2026-05-08']` = `['Coach Two']`.
- `coverage.tz-us.test.js`: all pass (see its header).

- [ ] **Step 3: Minimal implementation**

In `src/lib/report-generator.js`, after line 6 (`import { roleAtDeletion } from '@/lib/staff-tombstone'`) add:

```js
import { isRealCalendarDate } from '@/lib/schemas'
import { addDaysISO } from '@/lib/dublin-time'
```

After the required-fields check (lines 147-149, `if (!report_type || !period_start || !period_end || !locId) { … }`) insert:

```js

  // DATECHECK.1 — POST /api/schedule/reports refuses an impossible date before
  // calling this, and the cron builds its period from real Dates; this is the
  // floor for any other caller. It also keeps roster_coverage's day walk
  // finite: that walk steps a calendar string forward until it passes
  // period_end.
  if (!isRealCalendarDate(period_start) || !isRealCalendarDate(period_end)) {
    return { success: false, error: 'period_start and period_end must be real dates, YYYY-MM-DD' }
  }
```

Replace the day walk and the leave walk in `case 'roster_coverage'` (current lines 345-369):

```js
      const days = {}
      const start = new Date(period_start + 'T00:00:00')
      const end = new Date(period_end + 'T00:00:00')
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const ds = d.toISOString().split('T')[0]
        days[ds] = { shifts: 0, staff_on_shift: [], staff_off: [] }
      }

      for (const s of (shifts || [])) {
        if (days[s.shift_date]) {
          days[s.shift_date].shifts++
          if (!days[s.shift_date].staff_on_shift.includes(s.profile_id)) {
            days[s.shift_date].staff_on_shift.push(s.profile_id)
          }
        }
      }

      for (const t of (timeOff || [])) {
        const ts = new Date(t.start_date + 'T00:00:00')
        const te = new Date(t.end_date + 'T00:00:00')
        for (let d = new Date(ts); d <= te; d.setDate(d.getDate() + 1)) {
          const ds = d.toISOString().split('T')[0]
          if (days[ds]) {
            days[ds].staff_off.push(t.profiles?.full_name || 'Unknown')
          }
        }
      }
```

with:

```js
      // DATECHECK.1 — walk the period as calendar strings. The old walk built
      // LOCAL-midnight Dates and keyed them with toISOString(), which is UTC:
      // under Irish summer time every key slid back a day (the report started
      // on the Sunday before and lost its last day, and the spring-forward
      // week keyed one day twice). Vercel runs in UTC, where both readings
      // agree, so live reports were right; any process east of UTC was not.
      const days = {}
      for (let ds = period_start; ds <= period_end; ds = addDaysISO(ds, 1)) {
        days[ds] = { shifts: 0, staff_on_shift: [], staff_off: [] }
      }

      for (const s of (shifts || [])) {
        if (days[s.shift_date]) {
          days[s.shift_date].shifts++
          if (!days[s.shift_date].staff_on_shift.includes(s.profile_id)) {
            days[s.shift_date].staff_on_shift.push(s.profile_id)
          }
        }
      }

      // Only the part of the leave inside the period can land on a day, so the
      // walk is clipped to it (a year-long request no longer walks a year).
      for (const t of (timeOff || [])) {
        const from = t.start_date > period_start ? t.start_date : period_start
        const to = t.end_date < period_end ? t.end_date : period_end
        for (let ds = from; ds <= to; ds = addDaysISO(ds, 1)) {
          if (days[ds]) days[ds].staff_off.push(t.profiles?.full_name || 'Unknown')
        }
      }
```

Leave the `utilisation` week count (lines 405-407) as it is: it subtracts two local-midnight Dates and rounds to whole weeks, so a DST hour cannot change it.

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/lib/report-generator.test.js src/lib/report-generator.coverage.tz.test.js src/lib/report-generator.coverage.tz-us.test.js src/lib/report-generator.period.tz.test.js src/lib/report-generator.period.tz-us.test.js`
Expected: all pass (the two `period.tz` files are the neighbours; they must stay green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/report-generator.js src/lib/report-generator.test.js src/lib/report-generator.coverage.tz.test.js src/lib/report-generator.coverage.tz-us.test.js
git commit -m "$(cat <<'EOF'
DATECHECK.1 — roster coverage walks calendar strings; generateReport refuses an impossible period

The coverage report keyed LOCAL-midnight Dates with toISOString(): under Irish
summer time it ran Sunday to Saturday and dropped the last day. Correct on
Vercel (UTC), wrong in any process east of UTC. Now addDaysISO, pinned by a
Europe/Dublin and a New York test file.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: a guard so a schedule route cannot go back to the shape-only check

**Files:** Create `src/app/api/schedule/date-inputs.test.js`.

- [ ] **Step 1: Write the test**

```js
// DATECHECK.1 — a floor, not a proof (the check:select-columns posture).
//
// isoDate (src/lib/schemas.js) checks the SHAPE of a date only, and 2026-02-30
// passes it: V8 reads it as 2 March and Postgres refuses it. Every schedule
// route now takes realIsoDate (shape AND calendar) for a schema date, or checks
// a raw query param with isRealCalendarDate. These two rules catch the
// regression that matters: a new or edited schedule route that goes back to
// the shape-only check.
//
// What they cannot see: a date that arrives some other way (a path segment, a
// body field read without a schema, a query param whose name is not
// date-like). Those still need a reviewer.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEDULE_DIR = path.dirname(fileURLToPath(import.meta.url))

function routeFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (entry.name === 'route.js') out.push(full)
  }
  return out
}

const ROUTES = routeFiles(SCHEDULE_DIR).map((file) => ({
  rel: path.relative(SCHEDULE_DIR, file),
  src: fs.readFileSync(file, 'utf8'),
}))

// An import of the shape-only isoDate from the shared schemas (comments that
// merely mention it do not count).
const IMPORTS_ISO_DATE = /import\s*{[^}]*\bisoDate\b[^}]*}\s*from\s*'@\/lib\/schemas'/
// A query param whose name says it is a date.
const DATE_PARAM = /searchParams\.get\(\s*'(?:[a-z_]*_date|from|to|[a-z_]*_start|[a-z_]*_end)'\s*\)/
const CALENDAR_CHECK = /\b(?:isRealCalendarDate|realIsoDate)\b/

describe('schedule routes refuse a date the calendar does not have (DATECHECK.1)', () => {
  it('the walk finds the schedule routes', () => {
    expect(ROUTES.map((r) => r.rel)).toContain(path.join('blocks', 'route.js'))
    expect(ROUTES.length).toBeGreaterThan(20)
  })

  it('a route that imports the shape-only isoDate also checks the calendar', () => {
    const offenders = ROUTES
      .filter((r) => IMPORTS_ISO_DATE.test(r.src) && !/\bisRealCalendarDate\b/.test(r.src))
      .map((r) => r.rel)
    expect(offenders).toEqual([])
  })

  it('a route that reads a date-named query param checks the calendar', () => {
    const offenders = ROUTES
      .filter((r) => DATE_PARAM.test(r.src) && !CALENDAR_CHECK.test(r.src))
      .map((r) => r.rel)
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, expect PASS (it is written after the fixes)**

Run: `npx vitest run src/app/api/schedule/date-inputs.test.js`
Expected: 3 passed. Today only `change-log/route.js` imports `isoDate`, and it pairs it with `isRealCalendarDate`.

- [ ] **Step 3: Prove it bites**

Temporarily edit `src/app/api/schedule/week-cost/route.js`: change `realIsoDate` back to `isoDate` in both the import (line 32) and the schema. Run `npx vitest run src/app/api/schedule/date-inputs.test.js`.
Expected: BOTH rules fail, each naming `week-cost/route.js` (it imports `isoDate` without `isRealCalendarDate`, and it reads `week_start` with no calendar check). Then undo the edit:

```bash
git restore src/app/api/schedule/week-cost/route.js
```

and re-run: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/schedule/date-inputs.test.js
git commit -m "$(cat <<'EOF'
DATECHECK.1 — guard: a schedule route cannot go back to the shape-only date check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: OpenAPI

**Files:** Modify `src/lib/openapi.js`.

- [ ] **Step 1: Document the refusals**

`GET /api/schedule/shifts` responses (lines 4326-4329) gain a 400. Replace:

```js
    200: { description: 'Shifts' },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } },
```

with:

```js
    200: { description: 'Shifts' },
    400: { description: 'start_date or end_date is not a real calendar date (YYYY-MM-DD), or the read failed', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } },
```

`POST /api/schedule/blocks` body (line 4361). Replace:

```js
      block_date: z.string().openapi({ description: 'YYYY-MM-DD' }),
```

with:

```js
      block_date: z.string().openapi({ description: 'YYYY-MM-DD, a real calendar date (2026-02-30 is refused with a 400)' }),
```

`GET /api/schedule/week-cost` (line 4453). Replace:

```js
    400: { description: 'Missing or malformed location_id / week_start', content: { 'application/json': { schema: ErrorResponse } } },
```

with:

```js
    400: { description: 'Missing or malformed location_id / week_start, or week_start is not a real calendar date', content: { 'application/json': { schema: ErrorResponse } } },
```

- [ ] **Step 2: Run it, expect PASS**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/openapi.js
git commit -m "$(cat <<'EOF'
DATECHECK.1 — document the real-date refusals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### The gate (run once, at the end, in this order)

```bash
git fetch origin main && git rebase origin/main
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
npm run build
```

Expected: all twelve green, then a clean `next build` (this PR adds imports to route files, so the build is the check that catches a wrong export name). `check:ota-paths` stays green because nothing under `mobile/` or `shared/` changes; confirm with `git diff --stat origin/main -- mobile shared` = empty.

Then independent review, then:

```bash
git push -u origin HEAD
gh pr create --base main --title "DATECHECK.1 — every schedule route refuses a date the calendar does not have" --body-file <scratchpad>/datecheck-pr.md
```

**PR title:** `DATECHECK.1 — every schedule route refuses a date the calendar does not have`

**PR body points:**
- Why: `isoDate` checks the shape only. `2026-02-30` passed nine schedule routes. Postgres refused it on most (a 400 or 500 carrying Postgres's own error text); `week-cost` and `contractor-spend` answered **200 for the month it rolled into** (the week of 2 March, March's spend).
- What: `realIsoDate` in `src/lib/schemas.js` (shape + `isRealCalendarDate`, one message) for every schema date: `blocks` POST, `rosters` POST, `reports` POST, `copy-week`, `copy-month`, `week-cost`, `contractor-spend`, `overview`; `POST /time-off` reuses it in place of its local copy. Raw query params checked with `isRealCalendarDate`: `blocks` GET, `shifts` GET (the phone's Schedule feed), `time-off` list GET. Each keeps its route's error shape; status 400, before any read.
- The one local-midnight + `toISOString()` walk on a schedule path, `roster_coverage` in `report-generator.js`: under Irish summer time it ran Sunday to Saturday and dropped the period's last day. Correct on Vercel (UTC), wrong east of UTC. Now `addDaysISO`, pinned by a Europe/Dublin and a New York test file. `generateReport` also refuses an impossible period itself (cron path floor).
- Guard: `src/app/api/schedule/date-inputs.test.js` fails if a schedule route imports the shape-only `isoDate` without the calendar check, or reads a date-named query param with no calendar check. A floor, not a proof.
- Checked and unchanged: `change-log` (already correct), the 17 schedule routes with no date input, all 11 `/api/mobile` routes (none takes a schedule date). Every in-repo caller sends formatted real dates, so no client change.
- **No migration. No OTA** (nothing under `mobile/` or `shared/`).
- Last line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

**CHANGELOG row** (add once the PR number exists, as the first row under the `| # / PR | Item | Notes |` header in `docs/CHANGELOG.md`; commit it to the branch; never edit it after it is pushed to main):

```
| #<PR> | DATECHECK.1 — every schedule route refuses a date the calendar does not have | 2026-09-<dd>. No migration, **no OTA**. `realIsoDate` (`src/lib/schemas.js`, = `isoDate.refine(isRealCalendarDate)`) on every schedule schema date: `blocks` POST, `rosters` POST, `reports` POST, `copy-week`, `copy-month`, `week-cost`, `contractor-spend`, `overview` (and `POST /time-off`, replacing its local copy). Raw query dates checked with `isRealCalendarDate` (`<name>: not a real date`): `blocks` GET, `shifts` GET, `time-off` list GET. `2026-02-30` used to reach Postgres (400/500 carrying its error text) or, on `week-cost`/`contractor-spend`, answer 200 for 2 March's week / March's spend. `roster_coverage` walked local-midnight Dates keyed by `toISOString()`: under Irish summer time it ran Sun-Sat and dropped the last day (right on Vercel/UTC); now `addDaysISO`, pinned under Europe/Dublin and New York. `generateReport` refuses an impossible period itself. Guard `src/app/api/schedule/date-inputs.test.js`. `change-log` and the 11 `/api/mobile` routes unchanged (checked). |
```

---

### Review notes / open questions (for the owner)

1. **Error text changes, status does not.** `blocks` GET, `shifts` GET and the `time-off` list used to answer a bad date with Postgres's text (`date/time field value out of range: "2026-02-30"`, or `invalid input syntax for type date` for `abc`); they now say `start_date: not a real date`. Still 400. No in-repo client parses the text.
2. **A bad SHAPE now names two things** on `overview`, `week-cost`, `contractor-spend`: `from: Use YYYY-MM-DD; from: Use a real date, YYYY-MM-DD` (Zod 4 runs the refine after a failed regex). `overview` used to say just `from: YYYY-MM-DD`. Same behaviour `POST /time-off` already has. If one message is wanted, `realIsoDate` could be built on `z.string().refine(isRealCalendarDate, …)` alone, at the cost of losing the shape hint.
3. **Found, out of scope:** `generateReport`'s `time_off_summary` discards its read error (`src/lib/report-generator.js:303-308`), so a failed read saves an empty "0 days" report. The discarded-error class; worth its own PR.
4. **Found, out of scope:** no route in this set checks ORDER on a range read (`blocks` GET, `shifts` GET, `time-off` list, `reports` POST). A reversed range reads as empty, and `reports` saves a report of an empty period. `rosters`, `overview`, `change-log`, `time-off` POST already refuse it.
5. **Found, outside `/api/schedule`:** the staff assistant's `create_shift` (`shift_date`) and `get_time_off` (`start_date`/`end_date`) tools in `src/app/api/assistant/chat/route.js:132-151` and `:278-283` pass dates to Postgres with no calendar check (`get_shifts_for_week` at `:186` has one). The assistant is off at every location; a follow-up if it is turned on.
6. **Not a date, left alone:** `GET /api/schedule/allowances?year=` (`allowances/route.js:45`) is unvalidated; `year=abc` reaches Postgres. The PUT validates `year` as an integer.
7. **The coverage bug never reached a live report** (Vercel runs in UTC). The fix matters for correctness in any non-UTC process and removes the last local-midnight + `toISOString()` pair on a schedule path. Other local-midnight Dates on schedule paths (`copy-week`, `copy-month`, `roster-summary.js`, `roster-summary-server.js`) read back through local getters and are consistent; left alone on purpose.
8. **The guard is a floor.** It cannot see a date that arrives in a path segment, a body field read without a schema, or a query param not named like a date. None exists today.
9. **Not audited:** date inputs outside `src/app/api/schedule/**` and `src/app/api/mobile/**` (crons, staff, bookings, events). The assistant finding in note 5 was spotted in passing.
10. **Size:** ten small tasks, but every one is a two-line schema swap or a five-line loop plus tests. Still S.
