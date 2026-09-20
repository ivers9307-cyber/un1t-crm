## PR COPYLEAVE.1 — leave-aware copy + fuller publish check

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy Last Week / Copy Last Month never roster a coach onto a day they have APPROVED leave, and the publish preview lists (advisory only) every coach rostered on approved leave and every coach double-booked in the period, including at another studio.

**Why:** `buildCopyPlan` (`src/lib/roster-copy.js:133`) and both copy routes never read `time_off_requests`, so a copy puts coaches straight back onto days they booked off; coaches filed 36 approved "unavailable" requests in 120 days precisely so the roster would honour them. The publish dry run (`projectPublishImpact`, `src/lib/roster-publish.js:251`) already loads approved leave (lines 146-167) but only uses it to zero the cost; the modal lists staffing gaps only, so a manager publishes a clash without ever being told.

**Ships:** web deploy only. No migration. Nothing under `mobile/` or `shared/` changes, so **no OTA**.

**Worktree:** branch `copyleave-1` off a fresh `origin/main`. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the PR gate (8GB machine).

**Rules that bite in this PR (read `CLAUDE.md` first):**
- PostgREST returns at most 1,000 rows per select whatever `.limit()` says. Every new read here pages with `.order()` + `.range()`.
- A column named in a `.select()` is checked by `npm run check:select-columns` against `supabase/migrations/`. Every column used below was verified: `time_off_requests(id, profile_id, start_date, end_date, status)` — mig 011; `shift_assignments(id, profile_id, status, start_time_override, end_time_override)`; `shift_blocks(id, location_id, block_date, start_time, end_time)`; `shift_templates(name)`; `locations(name)`; `profiles(full_name)`.
- The repo is PUBLIC. Fixtures use `coach-1`, `Coach A`, `Studio B`. Never a real name, email or phone.
- Leave covers the PERSON, not the studio it was filed at (LEAVE.2, `src/lib/time-off-leave.js:1-20`). A copy at Stillorgan must honour leave the coach filed from Hatch Street. That is why the new leave read filters by `profile_id`, not `location_id`.
- The publish advisories must never block or fail a publish. `projectPublishImpact` is also the hard budget gate for the real publish, so an advisory read that fails is logged and degrades, it does not throw (CLAUDE.md: "removing a silent failure must never create a louder one").
- Names and times only in the new payloads. Never a rate, a cost or an hours-against-contract figure.

**Naming decision:** the brief called the new impact keys `leave_clashes` / `double_bookings`. Every existing top-level key on the impact object is camelCase (`staffingGaps`, `blockCount`, `overBudget`) while the ITEMS inside are snake_case (`block_id`, `block_date`). This plan follows the file: top-level `leaveClashes`, `doubleBookings`, `crossLocationChecked`; snake_case item fields. The copy routes' response keys are snake_case already (`skipped_removed`), so the new one is `skipped_on_leave`.

---

### File map

| File | Change |
|---|---|
| `src/lib/roster-copy.js` | Modify: `approvedLeaveLookup`, `liveCoachIds`, `fetchApprovedLeave` (new); `buildCopyPlan` lines 133-208 (new `isOnLeave` option, `skippedOnLeave` in the result); `copyResultToast` lines 239-262 |
| `src/lib/roster-copy.test.js` | Modify: import line 9 + new describes |
| `src/app/api/schedule/shifts/copy-week/route.js` | Modify: imports line 8, body of `POST` lines 86-168 |
| `src/app/api/schedule/shifts/copy-week/route.test.js` | Modify: mock lines 22-25, import line 45, `beforeEach` lines 69-82, three `toEqual` bodies (lines 94, 204, 226), new describe |
| `src/app/api/schedule/shifts/copy-month/route.js` | Modify: import line 50, body of `POST` lines 139-214 |
| `src/app/api/schedule/shifts/copy-month/route.test.js` | Modify: same four places as copy-week (mock 22-25, import 43, `beforeEach`, `toEqual` lines 94 and 213), new describe |
| `src/lib/roster-publish-advisories.js` | Create: pure `leaveCovering`, `leaveClashes`, `doubleBookings` |
| `src/lib/roster-publish-advisories.test.js` | Create |
| `src/lib/roster-publish.js` | Modify: imports 20-24, block select 119-124, leave read 146-167, context return 169-176, `isOnLeave` 184-188, `impactFromContext` 342-433, JSDoc 232-249 |
| `src/lib/roster-publish.test.js` | Modify: `mockDb` lines 32-129, new describe |
| `src/components/ScheduleCalendar.jsx` | Modify: toast call line 897; publish modal line 2267; new `PublishRosterClashes` after `PublishStaffingGaps` (ends line ~2386) |
| `src/components/ScheduleCalendar.errors.test.jsx` | Modify: one new test in `copy chooser (COPYMODES.1)` (after line 552) |
| `src/components/ScheduleCalendar.visibility.test.jsx` | Modify: one new describe at the end |
| `src/lib/openapi.js` | Modify: `CopyShiftsResponse` lines 4335-4340 |
| `docs/CHANGELOG.md` | Modify: one new row, after `gh pr create` |

---

### Task 1: pure leave lookup and coach-id helpers

**Files:** Modify `src/lib/roster-copy.js`, `src/lib/roster-copy.test.js`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/roster-copy.test.js` replace the import on line 9 with:

```js
import {
  buildCopyPlan, mapNthWeekdayOfMonth, weekdayCodeOf, fetchSourceBlocks, copyResultToast,
  approvedLeaveLookup, liveCoachIds, fetchApprovedLeave,
} from './roster-copy'
```

Then add, directly after the `weekdayCodeOf` describe (ends line 38):

```js
// COPYLEAVE.1 — the copy honours APPROVED leave, and only approved leave.
describe('approvedLeaveLookup', () => {
  const onLeave = approvedLeaveLookup([
    { profile_id: 'p1', status: 'approved', start_date: '2026-07-06', end_date: '2026-07-08' },
    { profile_id: 'p2', status: 'pending', start_date: '2026-07-06', end_date: '2026-07-08' },
    { profile_id: 'p3', status: 'rejected', start_date: '2026-07-06', end_date: '2026-07-08' },
  ])

  it('covers the first and the last day: end_date is inclusive (mig 011)', () => {
    expect(onLeave('p1', '2026-07-06')).toBe(true)
    expect(onLeave('p1', '2026-07-07')).toBe(true)
    expect(onLeave('p1', '2026-07-08')).toBe(true)
  })

  it('does not cover the day before or the day after', () => {
    expect(onLeave('p1', '2026-07-05')).toBe(false)
    expect(onLeave('p1', '2026-07-09')).toBe(false)
  })

  it('PENDING and REJECTED leave never count, even if a caller hands them in', () => {
    expect(onLeave('p2', '2026-07-07')).toBe(false)
    expect(onLeave('p3', '2026-07-07')).toBe(false)
  })

  it('an unknown coach, and an empty or missing list, are never on leave', () => {
    expect(onLeave('nobody', '2026-07-07')).toBe(false)
    expect(approvedLeaveLookup([])('p1', '2026-07-07')).toBe(false)
    expect(approvedLeaveLookup(null)('p1', '2026-07-07')).toBe(false)
  })
})

describe('liveCoachIds', () => {
  it('returns each live coach once, and never a cancelled one', () => {
    const ids = liveCoachIds([
      block({ shift_assignments: [
        { profile_id: 'p1', status: 'scheduled' },
        { profile_id: 'p2', status: 'cancelled' },
      ] }),
      block({ id: 'b2', shift_assignments: [
        { profile_id: 'p1', status: 'swapped' },
        { profile_id: 'p3', status: 'scheduled' },
      ] }),
    ])
    expect(ids.sort()).toEqual(['p1', 'p3'])
  })

  it('is empty for no blocks', () => {
    expect(liveCoachIds([])).toEqual([])
    expect(liveCoachIds(null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-copy.test.js`
Expected: the two new describes fail with `approvedLeaveLookup is not a function` / `liveCoachIds is not a function`. Every pre-existing test still passes.

- [ ] **Step 3: Minimal implementation**

In `src/lib/roster-copy.js`, insert directly after `templateRunsOn` (ends line 115), before the `buildCopyPlan` JSDoc:

```js
/**
 * COPYLEAVE.1 — pure. Turn time_off_requests rows into
 * `(profileId, dateIso) => boolean`: is this coach on APPROVED leave that day?
 * Both ends inclusive (time_off_requests.end_date is inclusive, mig 011). Dates
 * are YYYY-MM-DD strings, so string comparison IS date comparison.
 *
 * The status is re-checked here rather than trusted from the caller's query:
 * this is the function that says "on leave", so it must not be able to say it
 * about a request nobody approved (same posture as coachConflictsForBlock in
 * schedule-overlap.js). Any leave TYPE counts: holiday, sick, unavailable.
 */
export function approvedLeaveLookup(leaveRows) {
  const byProfile = new Map()
  for (const r of leaveRows || []) {
    if (r?.status !== 'approved' || !r.profile_id || !r.start_date || !r.end_date) continue
    if (!byProfile.has(r.profile_id)) byProfile.set(r.profile_id, [])
    byProfile.get(r.profile_id).push(r)
  }
  return (profileId, dateIso) =>
    (byProfile.get(profileId) || []).some((r) => r.start_date <= dateIso && r.end_date >= dateIso)
}

/** COPYLEAVE.1 — pure. Distinct profile ids with a LIVE assignment in these blocks. */
export function liveCoachIds(sourceBlocks) {
  const ids = new Set()
  for (const b of sourceBlocks || []) {
    for (const a of (b.shift_assignments || []).filter(isLiveAssignment)) {
      if (a.profile_id) ids.add(a.profile_id)
    }
  }
  return [...ids]
}
```

- [ ] **Step 4: Run it, expect PASS for those two describes**

Run: `npx vitest run src/lib/roster-copy.test.js`
Expected: `approvedLeaveLookup` and `liveCoachIds` pass. The file as a whole still reports a failure ONLY if you already added tests for `fetchApprovedLeave` (you have not; the unused import resolves to `undefined` and harms nothing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-copy.js src/lib/roster-copy.test.js
git commit -m "COPYLEAVE.1 — pure approved-leave lookup for the roster copy"
```

---

### Task 2: `buildCopyPlan` skips a coach on approved leave

**Files:** Modify `src/lib/roster-copy.js:117-208`, `src/lib/roster-copy.test.js`.

Existing signature being extended (`src/lib/roster-copy.js:133`):

```js
export function buildCopyPlan(sourceBlocks, { mode, mapDate }) {
```

- [ ] **Step 1: Write the failing tests**

Add after the last `buildCopyPlan` describe and before `describe('fetchSourceBlocks'` in `src/lib/roster-copy.test.js`:

```js
// COPYLEAVE.1 — Copy Last Week rostered coaches onto days they had booked off.
describe('buildCopyPlan — approved leave on the TARGET date', () => {
  const live = (id) => ({ profile_id: id, status: 'scheduled', notes: null, partial_reason: null, start_time_override: null, end_time_override: null })
  // Source Mon 29 Jun -> target Mon 6 Jul. p1 is off on the 6th.
  const isOnLeave = approvedLeaveLookup([
    { profile_id: 'p1', status: 'approved', start_date: '2026-07-06', end_date: '2026-07-06' },
  ])

  for (const mode of ['exact', 'template']) {
    it(`${mode}: the coach on leave is skipped and counted, the other coach is copied`, () => {
      const plan = buildCopyPlan([block({ shift_assignments: [live('p1'), live('p2')] })], { mode, mapDate: weekMap, isOnLeave })
      expect(plan.rows.map((r) => r.profileId)).toEqual(['p2'])
      expect(plan.sourceAssignments).toBe(2)
      expect(plan.skipped).toBe(1)
      expect(plan.skippedOnLeave).toBe(1)
    })
  }

  it('judges the TARGET date, not the source date', () => {
    // p1 was off on the SOURCE Monday only. They worked it anyway (they are on
    // the block), and the target Monday is a normal day: they are copied.
    const offAtSource = approvedLeaveLookup([
      { profile_id: 'p1', status: 'approved', start_date: '2026-06-29', end_date: '2026-06-29' },
    ])
    const plan = buildCopyPlan([block({ shift_assignments: [live('p1')] })], { mode: 'exact', mapDate: weekMap, isOnLeave: offAtSource })
    expect(plan.rows.map((r) => r.profileId)).toEqual(['p1'])
    expect(plan.skippedOnLeave).toBe(0)
  })

  it('exact: the slot is still ensured on the target when its only coach is on leave, so the gap is visible', () => {
    const plan = buildCopyPlan([block({ shift_assignments: [live('p1')] })], { mode: 'exact', mapDate: weekMap, isOnLeave })
    expect(plan.rows).toEqual([])
    expect(plan.blocks.map((b) => b.shiftDate)).toEqual(['2026-07-06'])
  })

  it('PENDING leave does not skip anyone', () => {
    const pendingOnly = approvedLeaveLookup([
      { profile_id: 'p1', status: 'pending', start_date: '2026-07-06', end_date: '2026-07-06' },
    ])
    const plan = buildCopyPlan([block({ shift_assignments: [live('p1')] })], { mode: 'exact', mapDate: weekMap, isOnLeave: pendingOnly })
    expect(plan.rows).toHaveLength(1)
    expect(plan.skipped).toBe(0)
    expect(plan.skippedOnLeave).toBe(0)
  })

  it('no isOnLeave option = today\'s behaviour, and skippedOnLeave is 0 not undefined', () => {
    const plan = buildCopyPlan([block({ shift_assignments: [live('p1')] })], { mode: 'exact', mapDate: weekMap })
    expect(plan.rows).toHaveLength(1)
    expect(plan.skippedOnLeave).toBe(0)
  })

  it('a day with no counterpart is NOT counted as on leave (that skip has its own reason)', () => {
    const plan = buildCopyPlan([block({ shift_assignments: [live('p1')] })], { mode: 'exact', mapDate: () => null, isOnLeave })
    expect(plan.skipped).toBe(1)
    expect(plan.skippedOnLeave).toBe(0)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-copy.test.js -t "approved leave on the TARGET date"`
Expected: the `exact`/`template` cases fail with `expected [ 'p1', 'p2' ] to deeply equal [ 'p2' ]`; the `skippedOnLeave` assertions fail with `expected undefined to be 0`.

- [ ] **Step 3: Minimal implementation**

In `src/lib/roster-copy.js`:

(a) In the `buildCopyPlan` JSDoc, add the option and the result field:

```js
 * @param {(profileId: string, targetDate: string) => boolean} [opts.isOnLeave]
 *   COPYLEAVE.1 — approvedLeaveLookup(...). A live source coach on APPROVED
 *   leave on the TARGET date is not copied; they count in `skipped` and in
 *   `skippedOnLeave`. Omitted = nobody is on leave.
```

and in the `@returns` block add `*   skippedOnLeave: number,  // the part of skipped that was approved leave`.

(b) Change the signature and the counters (lines 133-138):

```js
export function buildCopyPlan(sourceBlocks, { mode, mapDate, isOnLeave = null }) {
  if (!COPY_MODES.includes(mode)) throw new Error(`unknown copy mode: ${mode}`)
  const onLeave = typeof isOnLeave === 'function' ? isOnLeave : () => false
  const rows = []
  const blocks = []
  let skipped = 0
  let skippedOnLeave = 0
  let sourceAssignments = 0
```

(c) In the exact-mode loop (line 164), make the first statement of `for (const a of live) {`:

```js
      for (const a of live) {
        // COPYLEAVE.1 — a coach on approved leave that day is not put back on
        // it. The block above is still ensured, so the slot shows as a gap.
        if (onLeave(a.profile_id, targetDate)) { skipped++; skippedOnLeave++; continue }
        rows.push({
```

(d) In the template-mode loop (line 193), the same first statement:

```js
    for (const a of live) {
      if (onLeave(a.profile_id, targetDate)) { skipped++; skippedOnLeave++; continue }
      rows.push({
```

(e) The return (line 207):

```js
  return { rows, blocks, skipped, skippedOnLeave, sourceAssignments }
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-copy.test.js`
Expected: all pass. Then the BST/host-TZ rule this file documents at its top:

```bash
for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/roster-copy.test.js; done
```

Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-copy.js src/lib/roster-copy.test.js
git commit -m "COPYLEAVE.1 — buildCopyPlan skips a coach on approved leave on the target date"
```

---

### Task 3: `fetchApprovedLeave`, the paged read

**Files:** Modify `src/lib/roster-copy.js`, `src/lib/roster-copy.test.js`.

- [ ] **Step 1: Write the failing tests**

Add after the `fetchSourceBlocks` describe in `src/lib/roster-copy.test.js`:

```js
describe('fetchApprovedLeave', () => {
  // Records what was asked for and serves `total` rows a page at a time.
  function leaveDb(total, { fail = false } = {}) {
    const calls = []
    const all = Array.from({ length: total }, (_, i) => ({
      id: `l${String(i).padStart(5, '0')}`, profile_id: 'p1', status: 'approved', start_date: '2026-07-06', end_date: '2026-07-06',
    }))
    return {
      calls,
      from(table) {
        expect(table).toBe('time_off_requests')
        const q = { filters: [], orders: [] }
        const chain = {
          select: (s) => { q.select = s; return chain },
          in: (c, v) => { q.filters.push(['in', c, v]); return chain },
          eq: (c, v) => { q.filters.push(['eq', c, v]); return chain },
          lte: (c, v) => { q.filters.push(['lte', c, v]); return chain },
          gte: (c, v) => { q.filters.push(['gte', c, v]); return chain },
          order: (c) => { q.orders.push(c); return chain },
          range: (from, to) => {
            q.range = [from, to]
            calls.push(q)
            if (fail) return Promise.resolve({ data: null, error: { message: 'leave boom' } })
            return Promise.resolve({ data: all.slice(from, to + 1), error: null })
          },
        }
        return chain
      },
    }
  }

  it('asks for APPROVED leave of these coaches that overlaps the target range', async () => {
    const db = leaveDb(2)
    const { leave, error } = await fetchApprovedLeave(db, { profileIds: ['p1', 'p2'], startDate: '2026-07-06', endDate: '2026-07-12' })
    expect(error).toBeNull()
    expect(leave).toHaveLength(2)
    expect(db.calls[0].filters).toEqual([
      ['in', 'profile_id', ['p1', 'p2']],
      ['eq', 'status', 'approved'],
      // overlap: starts on or before the range ends, ends on or after it starts
      ['lte', 'start_date', '2026-07-12'],
      ['gte', 'end_date', '2026-07-06'],
    ])
    expect(db.calls[0].orders).toEqual(['start_date', 'id'])
  })

  it('pages past the 1,000-row cap', async () => {
    const db = leaveDb(1500)
    const { leave } = await fetchApprovedLeave(db, { profileIds: ['p1'], startDate: '2026-07-01', endDate: '2026-07-31' })
    expect(leave).toHaveLength(1500)
    expect(db.calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('no coaches = no query', async () => {
    const db = leaveDb(5)
    expect(await fetchApprovedLeave(db, { profileIds: [], startDate: 'a', endDate: 'b' })).toEqual({ leave: [], error: null })
    expect(db.calls).toHaveLength(0)
  })

  it('returns the error and no partial rows', async () => {
    const db = leaveDb(5, { fail: true })
    expect(await fetchApprovedLeave(db, { profileIds: ['p1'], startDate: 'a', endDate: 'b' }))
      .toEqual({ leave: [], error: { message: 'leave boom' } })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-copy.test.js -t fetchApprovedLeave`
Expected: 4 failed, `fetchApprovedLeave is not a function`.

- [ ] **Step 3: Minimal implementation**

In `src/lib/roster-copy.js`, first correct the header comment (lines 19-21), which says the block read is the only I/O:

```js
// The reads (fetchSourceBlocks, and COPYLEAVE.1's fetchApprovedLeave) are the
// only I/O here. Everything that decides
```

Then insert directly after `fetchSourceBlocks` (ends line 65):

```js
/**
 * COPYLEAVE.1 — APPROVED time off, of any type, for these coaches that
 * overlaps [startDate, endDate] (the TARGET period). Filtered by PERSON, not by
 * location: leave covers the person (LEAVE.2), so a coach who filed from
 * another studio is still off here. Paged like fetchSourceBlocks.
 *
 * @returns {Promise<{ leave: Array<object>, error: object|null }>}
 */
export async function fetchApprovedLeave(db, { profileIds, startDate, endDate }) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  if (ids.length === 0) return { leave: [], error: null }
  const leave = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('time_off_requests')
      // Literal on purpose: check:select-columns only resolves literal selects.
      .select('id, profile_id, start_date, end_date, status')
      .in('profile_id', ids)
      .eq('status', 'approved')
      .lte('start_date', endDate)
      .gte('end_date', startDate)
      .order('start_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { leave: [], error }
    const page = data || []
    leave.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return { leave, error: null }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-copy.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-copy.js src/lib/roster-copy.test.js
git commit -m "COPYLEAVE.1 — paged read of approved leave for the coaches being copied"
```

---

### Task 4: wire copy-week

**Files:** Modify `src/app/api/schedule/shifts/copy-week/route.js`, `src/app/api/schedule/shifts/copy-week/route.test.js`.

Why the existing tests need touching first: the test file mocks `@/lib/roster-copy` as `{ ...actual, fetchSourceBlocks: vi.fn() }` (lines 22-25) and hands the route `createServerClient.mockReturnValue({})`. Once the route calls the REAL `fetchApprovedLeave` against `{}` it throws `db.from is not a function`. So the read is mocked too, exactly the way `fetchSourceBlocks` is.

- [ ] **Step 1: Write the failing tests**

(a) Mock, lines 22-25:

```js
vi.mock('@/lib/roster-copy', async () => {
  const actual = await vi.importActual('@/lib/roster-copy')
  return { ...actual, fetchSourceBlocks: vi.fn(), fetchApprovedLeave: vi.fn() }
})
```

(b) Import, line 45:

```js
const { fetchSourceBlocks, fetchApprovedLeave } = await import('@/lib/roster-copy')
```

(c) In `beforeEach` (after `fetchSourceBlocks.mockReset()`):

```js
  fetchApprovedLeave.mockReset()
  fetchApprovedLeave.mockResolvedValue({ leave: [], error: null })
```

(d) The three exact-body assertions gain the new key. Lines 94 and 204:

```js
    expect(json).toEqual({ success: true, copied: 1, skipped: 0, skipped_removed: 0, skipped_on_leave: 0, mode: 'exact' })
```

Line 226:

```js
    expect(json).toEqual({ success: true, copied: 1, skipped: 2, skipped_removed: 0, skipped_on_leave: 0, mode: 'template' })
```

(e) New describe at the end of the file:

```js
// COPYLEAVE.1 — the copy reads approved leave for the TARGET week and does not
// roster a coach onto a day they are off.
describe('POST /api/schedule/shifts/copy-week — approved leave', () => {
  const BODY = { location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }

  beforeEach(() => {
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1', 'coach-2'])], error: null })
  })

  it('reads leave for the source coaches over the TARGET week, before anything is written', async () => {
    await POST(req(BODY))
    expect(fetchApprovedLeave).toHaveBeenCalledTimes(1)
    const [, args] = fetchApprovedLeave.mock.calls[0]
    expect([...args.profileIds].sort()).toEqual(['coach-1', 'coach-2'])
    expect(args).toMatchObject({ startDate: '2026-06-08', endDate: '2026-06-14' })
    expect(fetchApprovedLeave.mock.invocationCallOrder[0])
      .toBeLessThan(bulkUpsertShiftAssignments.mock.invocationCallOrder[0])
  })

  it('does not send the coach on leave to the writer, and reports the skip', async () => {
    // The source block is Mon 1 Jun, so the target is Mon 8 Jun.
    fetchApprovedLeave.mockResolvedValue({
      leave: [{ id: 'l1', profile_id: 'coach-1', status: 'approved', start_date: '2026-06-08', end_date: '2026-06-09' }],
      error: null,
    })
    const res = await POST(req(BODY))
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(bulkUpsertShiftAssignments.mock.calls[0][1].rows.map((r) => r.profileId)).toEqual(['coach-2'])
    expect(json).toEqual({ success: true, copied: 1, skipped: 1, skipped_removed: 0, skipped_on_leave: 1, mode: 'exact' })
  })

  it('500s and writes NOTHING when the leave read fails: copying blind is the bug', async () => {
    fetchApprovedLeave.mockResolvedValue({ leave: [], error: { message: 'leave boom' } })
    const res = await POST(req(BODY))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('leave boom')
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
    expect(readAssignmentKeysInRange).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it('a source week with nobody on it still 404s, without a leave read', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock([])], error: null })
    const res = await POST(req(BODY))
    expect(res.status).toBe(404)
    expect(fetchApprovedLeave).toHaveBeenCalledTimes(1) // called, but liveCoachIds is [] so it made no query
  })
})
```

Note on the last test: the route always calls `fetchApprovedLeave`; the "no coaches = no query" short-circuit lives inside it and is pinned in Task 3. The mock cannot see that, so the assertion here is only that the 404 still wins.

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/shifts/copy-week/route.test.js`
Expected: the three edited `toEqual`s fail (`skipped_on_leave` missing from the received body) and the four new tests fail (`fetchApprovedLeave` called 0 times; rows contain `coach-1`; status 201 not 500).

- [ ] **Step 3: Minimal implementation**

In `src/app/api/schedule/shifts/copy-week/route.js`:

(a) Import, line 8:

```js
import { fetchSourceBlocks, fetchApprovedLeave, approvedLeaveLookup, liveCoachIds, buildCopyPlan, COPY_MODES } from '@/lib/roster-copy'
```

(b) Update the response comment on line 63:

```js
// Response: { success, copied, skipped, skipped_removed, skipped_on_leave, mode }
```

(c) Replace lines 98-103 (the `dayOffset` / `buildCopyPlan` block) with:

```js
  // Target week bounds. Hoisted above the plan (it used to sit below it)
  // because the leave read needs them.
  const targetEnd = sourceWeekEnd(target_start)

  // COPYLEAVE.1 — approved leave for the coaches being copied, over the TARGET
  // week. Read before any write, and a failed read stops the copy: copying
  // blind is exactly how coaches landed back on days they had booked off.
  const { leave, error: leaveError } = await fetchApprovedLeave(db, {
    profileIds: liveCoachIds(sourceBlocks),
    startDate: target_start,
    endDate: targetEnd,
  })
  if (leaveError) return NextResponse.json({ success: false, error: leaveError.message }, { status: 500 })

  // Re-date each source block into the target week (same weekday).
  const dayOffset = weekDayOffset(source_start, target_start)
  const plan = buildCopyPlan(sourceBlocks, {
    mode,
    mapDate: (d) => redateShiftDate(d, dayOffset),
    isOnLeave: approvedLeaveLookup(leave),
  })
```

(d) Delete the now-duplicate declaration on line 114 (`const targetEnd = sourceWeekEnd(target_start)`), keeping the NOTIFY.1 comment and the `const before = …` line beneath it.

(e) The final response (lines 166-168):

```js
  // skipped_removed (SLOTREMOVAL.1) and skipped_on_leave (COPYLEAVE.1) are
  // parts of `skipped`, so the toast can say why.
  return NextResponse.json({
    success: true,
    copied: count,
    skipped: plan.skipped + skippedRemoved,
    skipped_removed: skippedRemoved,
    skipped_on_leave: plan.skippedOnLeave,
    mode,
  }, { status: 201 })
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/shifts/copy-week/route.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/shifts/copy-week/route.js src/app/api/schedule/shifts/copy-week/route.test.js
git commit -m "COPYLEAVE.1 — copy-week skips coaches on approved leave and reports skipped_on_leave"
```

---

### Task 5: wire copy-month

**Files:** Modify `src/app/api/schedule/shifts/copy-month/route.js`, `src/app/api/schedule/shifts/copy-month/route.test.js`.

- [ ] **Step 1: Write the failing tests**

Apply the SAME four edits as Task 4 Step 1 (a)-(d) to `copy-month/route.test.js`: the mock (lines 22-25), the import (line 43), the two `beforeEach` lines, and the two exact bodies:

Line 94:

```js
    expect(json).toEqual({ success: true, copied: 1, skipped: 0, skipped_removed: 0, skipped_on_leave: 0, mode: 'exact' })
```

Line 213:

```js
    expect(json).toEqual({ success: true, copied: 0, skipped: 1, skipped_removed: 0, skipped_on_leave: 0, mode: 'template' })
```

Then add at the end of the file (this file's `sourceBlock` default date is Fri 5 Jun 2026, and exact mode maps day-of-month, so 5 Jun lands on 5 Jul):

```js
// COPYLEAVE.1 — see copy-week.
describe('POST /api/schedule/shifts/copy-month — approved leave', () => {
  const BODY = { location_id: LOC, source_month_start: '2026-06-01', target_month_start: '2026-07-01' }

  beforeEach(() => {
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1', 'coach-2'])], error: null })
  })

  it('reads leave over the whole TARGET month', async () => {
    await POST(req(BODY))
    const [, args] = fetchApprovedLeave.mock.calls[0]
    expect([...args.profileIds].sort()).toEqual(['coach-1', 'coach-2'])
    expect(args).toMatchObject({ startDate: '2026-07-01', endDate: '2026-07-31' })
  })

  it('skips the coach who is off on the mapped day and reports it', async () => {
    fetchApprovedLeave.mockResolvedValue({
      leave: [{ id: 'l1', profile_id: 'coach-2', status: 'approved', start_date: '2026-07-04', end_date: '2026-07-06' }],
      error: null,
    })
    const json = await (await POST(req(BODY))).json()
    expect(bulkUpsertShiftAssignments.mock.calls[0][1].rows.map((r) => [r.profileId, r.shiftDate])).toEqual([['coach-1', '2026-07-05']])
    expect(json).toMatchObject({ success: true, skipped: 1, skipped_on_leave: 1 })
  })

  it('template mode with EVERY coach on leave: 201, copied 0, the skip is named, nothing is written', async () => {
    fetchApprovedLeave.mockResolvedValue({
      leave: ['coach-1', 'coach-2'].map((id) => ({ id: `l-${id}`, profile_id: id, status: 'approved', start_date: '2026-07-01', end_date: '2026-07-31' })),
      error: null,
    })
    const res = await POST(req({ ...BODY, mode: 'template' }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ success: true, copied: 0, skipped: 2, skipped_removed: 0, skipped_on_leave: 2, mode: 'template' })
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
  })

  it('500s and writes nothing when the leave read fails', async () => {
    fetchApprovedLeave.mockResolvedValue({ leave: [], error: { message: 'leave boom' } })
    const res = await POST(req(BODY))
    expect(res.status).toBe(500)
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/shifts/copy-month/route.test.js`
Expected: the two edited `toEqual`s and the four new tests fail, for the same reasons as Task 4.

- [ ] **Step 3: Minimal implementation**

In `src/app/api/schedule/shifts/copy-month/route.js`:

(a) Import, line 50:

```js
import { fetchSourceBlocks, fetchApprovedLeave, approvedLeaveLookup, liveCoachIds, buildCopyPlan, mapNthWeekdayOfMonth, COPY_MODES } from '@/lib/roster-copy'
```

(b) Replace lines 139-147 (the comment plus `buildCopyPlan` call) with:

```js
  // Target month bounds. Hoisted (it used to be computed below) because the
  // leave read needs them.
  const targetEnd = `${target_month_start.slice(0, 7)}-${String(daysInMonth(target_month_start)).padStart(2, '0')}`

  // COPYLEAVE.1 — see copy-week: approved leave over the TARGET month, read
  // before any write; a failed read stops the copy.
  const { leave, error: leaveError } = await fetchApprovedLeave(db, {
    profileIds: liveCoachIds(sourceBlocks),
    startDate: target_month_start,
    endDate: targetEnd,
  })
  if (leaveError) return NextResponse.json({ success: false, error: leaveError.message }, { status: 500 })

  // Map each source block's date into the target month; a day with no
  // counterpart (e.g. Jan 31 -> Feb, or a 5th weekday in template mode) is
  // dropped and its coaches are reported back as `skipped`.
  const plan = buildCopyPlan(sourceBlocks, {
    mode,
    mapDate: mode === 'template'
      ? (d) => mapNthWeekdayOfMonth(d, target_month_start)
      : (d) => mapDayOfMonth(d, target_month_start),
    isOnLeave: approvedLeaveLookup(leave),
  })
```

(c) The early return on line 157:

```js
    return NextResponse.json({ success: true, copied: 0, skipped: plan.skipped, skipped_removed: 0, skipped_on_leave: plan.skippedOnLeave, mode }, { status: 201 })
```

(d) Delete the now-duplicate `const targetEnd = …` on line 161 (keep the `// NOTIFY.1 — see copy-week.` comment and the `const before = …` line).

(e) The final response (lines 208-214): add `skipped_on_leave: plan.skippedOnLeave,` after `skipped_removed: skippedRemoved,`.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/shifts/copy-month/route.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/shifts/copy-month/route.js src/app/api/schedule/shifts/copy-month/route.test.js
git commit -m "COPYLEAVE.1 — copy-month skips coaches on approved leave"
```

---

### Task 6: the toast says "N skipped, on leave"

**Files:** Modify `src/lib/roster-copy.js:226-262`, `src/lib/roster-copy.test.js`, `src/components/ScheduleCalendar.jsx:897`, `src/components/ScheduleCalendar.errors.test.jsx`.

The toast is NOT built in the component. `runCopy` (`ScheduleCalendar.jsx:876-907`) calls the pure `copyResultToast` from `roster-copy.js` and shows what it returns:

```js
      const result = copyResultToast({ period: job.period, mode, copied: data.copied, skipped: data.skipped, skippedRemoved: data.skipped_removed })
```

- [ ] **Step 1: Write the failing tests**

(a) Inside `describe('copyResultToast'` in `src/lib/roster-copy.test.js`, add:

```js
  // COPYLEAVE.1 — a coach skipped because they are on approved leave gets that
  // reason, never the mode's ("their template is inactive").
  it('names approved leave as its own skip reason', () => {
    expect(copyResultToast({ period: 'week', mode: 'exact', copied: 9, skipped: 3, skippedOnLeave: 3 })).toEqual({
      kind: 'warning',
      message: 'Copied 9 shifts. 3 skipped, on leave.',
    })
  })

  it('lists deleted slots, leave, then the mode\'s reason, each with its own count', () => {
    const r = copyResultToast({ period: 'week', mode: 'template', copied: 1, skipped: 6, skippedRemoved: 1, skippedOnLeave: 2 })
    expect(r.message).toBe(
      'Copied 1 shift. 1 skipped because that slot was deleted in the target week. 2 skipped, on leave. 3 skipped, their template is inactive or no longer runs that weekday.',
    )
  })

  it('never claims more leave skips than there were skips', () => {
    expect(copyResultToast({ period: 'week', mode: 'exact', copied: 1, skipped: 1, skippedOnLeave: 5 }).message)
      .toBe('Copied 1 shift. 1 skipped, on leave.')
  })
```

(b) Inside `describe('copy chooser (COPYMODES.1)'` in `src/components/ScheduleCalendar.errors.test.jsx`, after the test that ends on line 552:

```js
  // COPYLEAVE.1 — the component must hand skipped_on_leave to the toast.
  it('toasts how many coaches were skipped because they are on leave', async () => {
    global.fetch = copyFetch(() => okResponse({ success: true, copied: 9, skipped: 3, skipped_removed: 0, skipped_on_leave: 3, mode: 'exact' }))
    await renderReady()
    fireEvent.click(screen.getByText('Copy Last Week'))
    fireEvent.click(await screen.findByText('Exact copy'))
    expect(await screen.findByText('Copied 9 shifts. 3 skipped, on leave.')).toBeTruthy()
  })
```

(`findByText` here waits for a thing to APPEAR, which is fine. The trap in this repo is a test that waits for a bug to STOP happening.)

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/lib/roster-copy.test.js -t copyResultToast`
Expected: 3 failed; the first receives `'Copied 9 shifts. 3 skipped, that day of the month does not exist in the target (usually 31 Jan into Feb).'`.

Run: `npx vitest run src/components/ScheduleCalendar.errors.test.jsx -t "on leave"`
Expected: FAIL, `Unable to find an element with the text: Copied 9 shifts. 3 skipped, on leave.`

- [ ] **Step 3: Minimal implementation**

(a) Replace `copyResultToast` (`src/lib/roster-copy.js:239-262`) and extend its JSDoc with `@param {number} [r.skippedOnLeave]  COPYLEAVE.1 — skipped because the coach has approved leave that day`:

```js
export function copyResultToast({ period, mode, copied = 0, skipped = 0, skippedRemoved = 0, skippedOnLeave = 0 }) {
  const n = Number(copied) || 0
  const total = Number(skipped) || 0
  const removed = Math.min(Number(skippedRemoved) || 0, total)
  const onLeave = Math.min(Number(skippedOnLeave) || 0, total - removed)
  const copiedText = `Copied ${n} ${n === 1 ? 'shift' : 'shifts'}.`
  if (total === 0) {
    return { kind: 'success', message: n === 0 ? `${copiedText} Everyone was already on the target ${period}.` : copiedText }
  }
  const parts = [copiedText]
  if (removed > 0) parts.push(`${removed} skipped because that slot was deleted in the target ${period}.`)
  if (onLeave > 0) parts.push(`${onLeave} skipped, on leave.`)
  const s = total - removed - onLeave
  if (s > 0) {
    let why
    if (mode === 'template') {
      why = period === 'month'
        ? "their template is inactive, no longer runs that weekday, or the target month has no matching weekday (a 5th Monday)."
        : 'their template is inactive or no longer runs that weekday.'
    } else {
      why = 'that day of the month does not exist in the target (usually 31 Jan into Feb).'
    }
    parts.push(`${s} skipped, ${why}`)
  }
  return { kind: 'warning', message: parts.join(' ') }
}
```

This is a rewrite, not an addition, so the four pre-existing `copyResultToast` tests are the regression guard: their expected strings are unchanged.

(b) `src/components/ScheduleCalendar.jsx:897`:

```js
      const result = copyResultToast({ period: job.period, mode, copied: data.copied, skipped: data.skipped, skippedRemoved: data.skipped_removed, skippedOnLeave: data.skipped_on_leave })
```

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/lib/roster-copy.test.js src/components/ScheduleCalendar.errors.test.jsx`
Expected: all pass, including the four older `copyResultToast` cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-copy.js src/lib/roster-copy.test.js src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.errors.test.jsx
git commit -m "COPYLEAVE.1 — the copy toast names coaches skipped for approved leave"
```

---

### Task 7: pure publish advisories

**Files:** Create `src/lib/roster-publish-advisories.js`, `src/lib/roster-publish-advisories.test.js`.

Reused, not re-written: `timeRangesOverlap(aStart, aEnd, bStart, bEnd)` and `fmtTime(t)` from `src/lib/schedule-overlap.js:11,44` (touching endpoints do NOT overlap; minute granularity), and `isLiveAssignment(a)` from `src/lib/roster.js:440` (only `cancelled` is dead).

- [ ] **Step 1: Write the failing test**

```js
// src/lib/roster-publish-advisories.test.js
// COPYLEAVE.1 — what the publish preview warns about besides staffing gaps.
// Pure, so no Supabase mock. Fixtures are invented: the repo is public.
import { describe, it, expect } from 'vitest'
import { leaveCovering, leaveClashes, doubleBookings } from './roster-publish-advisories'

const TODAY = '2026-05-01'
const PERIOD = { from: '2026-05-04', to: '2026-05-10', todayIso: TODAY }

const asg = (profileId, name, over = {}) => ({
  profile_id: profileId, status: 'scheduled', start_time_override: null, end_time_override: null,
  profiles: { full_name: name }, ...over,
})
const blk = (id, date, start, end, assignments, name = 'Morning') => ({
  id, location_id: 'loc1', block_date: date, start_time: start, end_time: end,
  shift_templates: { name }, shift_assignments: assignments,
})
// A row from ANOTHER studio, in the shape loadBudgetContext reads it.
const other = (profileId, date, start, end, over = {}) => ({
  id: `oa-${profileId}-${date}-${start}`, profile_id: profileId, status: 'scheduled',
  start_time_override: null, end_time_override: null,
  shift_blocks: { id: `ob-${date}-${start}`, location_id: 'loc2', block_date: date, start_time: start, end_time: end, shift_templates: { name: 'Open Gym' }, locations: { name: 'Studio B' } },
  ...over,
})
const leaveMap = (rows) => {
  const m = new Map()
  for (const r of rows) { if (!m.has(r.profile_id)) m.set(r.profile_id, []); m.get(r.profile_id).push(r) }
  return m
}

describe('leaveCovering', () => {
  const m = leaveMap([{ id: 'l1', profile_id: 'a', start_date: '2026-05-04', end_date: '2026-05-06' }])
  it('returns the covering row, both ends inclusive', () => {
    expect(leaveCovering(m, 'a', '2026-05-04')?.id).toBe('l1')
    expect(leaveCovering(m, 'a', '2026-05-06')?.id).toBe('l1')
  })
  it('returns null outside the range, for another coach, and for no map', () => {
    expect(leaveCovering(m, 'a', '2026-05-07')).toBeNull()
    expect(leaveCovering(m, 'b', '2026-05-05')).toBeNull()
    expect(leaveCovering(null, 'a', '2026-05-05')).toBeNull()
  })
})

describe('leaveClashes', () => {
  const leaveByProfile = leaveMap([{ id: 'l1', profile_id: 'a', start_date: '2026-05-05', end_date: '2026-05-06' }])

  it('lists a coach rostered on a day they have approved leave, with the hours they are down for', () => {
    const out = leaveClashes(
      [blk('b1', '2026-05-05', '06:00:00', '09:00:00', [asg('a', 'Coach A', { end_time_override: '08:00:00' }), asg('b', 'Coach B')])],
      { ...PERIOD, leaveByProfile },
    )
    expect(out).toEqual([{
      block_id: 'b1', block_date: '2026-05-05', start_time: '06:00:00', end_time: '08:00:00', name: 'Morning',
      profile_id: 'a', coach_name: 'Coach A', leave_start: '2026-05-05', leave_end: '2026-05-06',
    }])
  })

  it('ignores a cancelled assignment, a block outside the period, and a block before today', () => {
    const blocks = [
      blk('cancelled', '2026-05-05', '06:00', '09:00', [asg('a', 'Coach A', { status: 'cancelled' })]),
      blk('outside', '2026-05-12', '06:00', '09:00', [asg('a', 'Coach A')]),
      blk('past', '2026-05-05', '06:00', '09:00', [asg('a', 'Coach A')]),
    ]
    const wide = leaveMap([{ id: 'l1', profile_id: 'a', start_date: '2026-05-01', end_date: '2026-05-31' }])
    expect(leaveClashes(blocks.slice(0, 2), { ...PERIOD, leaveByProfile: wide })).toEqual([])
    expect(leaveClashes([blocks[2]], { ...PERIOD, todayIso: '2026-05-06', leaveByProfile: wide })).toEqual([])
  })

  it('falls back to "Coach" when the name was not embedded, and sorts by date then start', () => {
    const wide = leaveMap([{ id: 'l1', profile_id: 'a', start_date: '2026-05-01', end_date: '2026-05-31' }])
    const out = leaveClashes([
      blk('late', '2026-05-06', '17:00', '18:00', [{ profile_id: 'a', status: 'scheduled' }]),
      blk('early', '2026-05-06', '06:00', '07:00', [{ profile_id: 'a', status: 'scheduled' }]),
      blk('first', '2026-05-04', '09:00', '10:00', [{ profile_id: 'a', status: 'scheduled' }]),
    ], { ...PERIOD, leaveByProfile: wide })
    expect(out.map((c) => c.block_id)).toEqual(['first', 'early', 'late'])
    expect(out[0].coach_name).toBe('Coach')
  })
})

describe('doubleBookings', () => {
  it('pairs two overlapping shifts of one coach at THIS studio', () => {
    const out = doubleBookings([
      blk('b1', '2026-05-05', '09:00', '11:00', [asg('a', 'Coach A')], 'Morning'),
      blk('b2', '2026-05-05', '10:00', '12:00', [asg('a', 'Coach A')], 'Midday'),
    ], [], PERIOD)
    expect(out).toEqual([{
      profile_id: 'a', coach_name: 'Coach A', block_date: '2026-05-05',
      first: { block_id: 'b1', name: 'Morning', start_time: '09:00', end_time: '11:00', location_name: null },
      second: { block_id: 'b2', name: 'Midday', start_time: '10:00', end_time: '12:00', location_name: null },
    }])
  })

  it('back-to-back shifts are NOT a double booking (touching endpoints)', () => {
    expect(doubleBookings([
      blk('b1', '2026-05-05', '09:00', '10:00', [asg('a', 'Coach A')]),
      blk('b2', '2026-05-05', '10:00', '11:00', [asg('a', 'Coach A')]),
    ], [], PERIOD)).toEqual([])
  })

  it('compares the hours each coach is actually down for (their override), not the block\'s', () => {
    // The block runs 09-12 but Coach A is only on it 09-10, so 10-11 elsewhere is fine.
    expect(doubleBookings([
      blk('b1', '2026-05-05', '09:00', '12:00', [asg('a', 'Coach A', { end_time_override: '10:00:00' })]),
      blk('b2', '2026-05-05', '10:00', '11:00', [asg('a', 'Coach A')]),
    ], [], PERIOD)).toEqual([])
  })

  it('finds a clash with a shift at ANOTHER studio and names that studio', () => {
    const out = doubleBookings(
      [blk('b1', '2026-05-05', '09:00', '11:00', [asg('a', 'Coach A')])],
      [other('a', '2026-05-05', '10:30:00', '12:00:00')],
      PERIOD,
    )
    expect(out).toHaveLength(1)
    expect(out[0].first).toMatchObject({ block_id: 'b1', location_name: null })
    expect(out[0].second).toMatchObject({ name: 'Open Gym', start_time: '10:30', end_time: '12:00', location_name: 'Studio B' })
  })

  it('never reports a pair that is ENTIRELY at another studio: not this publish\'s business', () => {
    expect(doubleBookings(
      [blk('b1', '2026-05-05', '06:00', '07:00', [asg('a', 'Coach A')])],
      [other('a', '2026-05-05', '10:00', '12:00'), other('a', '2026-05-05', '11:00', '13:00')],
      PERIOD,
    )).toEqual([])
  })

  it('ignores cancelled rows on either side, other days, other coaches, and days outside the period', () => {
    expect(doubleBookings(
      [
        blk('b1', '2026-05-05', '09:00', '11:00', [asg('a', 'Coach A'), asg('c', 'Coach C', { status: 'cancelled' })]),
        blk('b2', '2026-05-05', '10:00', '12:00', [asg('b', 'Coach B'), asg('c', 'Coach C')]),
        blk('b3', '2026-05-12', '09:00', '11:00', [asg('d', 'Coach D')]),
        blk('b4', '2026-05-12', '10:00', '12:00', [asg('d', 'Coach D')]),
      ],
      [other('a', '2026-05-05', '09:30', '10:30', { status: 'cancelled' }), other('a', '2026-05-06', '09:30', '10:30')],
      PERIOD,
    )).toEqual([])
  })

  it('tolerates a null other-studio list (the cross-studio read failed)', () => {
    expect(doubleBookings([blk('b1', '2026-05-05', '09:00', '11:00', [asg('a', 'Coach A')])], null, PERIOD)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-publish-advisories.test.js`
Expected: FAIL, `Failed to resolve import "./roster-publish-advisories"`.

- [ ] **Step 3: Minimal implementation**

```js
// src/lib/roster-publish-advisories.js
// COPYLEAVE.1 — what the publish preview warns about besides staffing gaps:
//
//   leaveClashes    a coach rostered on a day they have APPROVED leave.
//   doubleBookings  one coach on two live shifts whose hours overlap, where at
//                   least one of the two is at the studio being published. The
//                   other may be at ANOTHER studio: a coach cannot be in two
//                   places, and nothing else on the web screen can see that.
//
// ADVISORY ONLY, the same posture as the staffing-gap list (ROSTERVIS.1) and
// the assign picker's clash badge (schedule-overlap.js): a coach legitimately
// floats between adjacent slots and the manager is the judge. Nothing here may
// block a publish. Names and times only: no rate, cost or contract hours.
//
// Pure. Future blocks only (block_date >= todayIso), the rule staffingGaps uses.

import { isLiveAssignment } from './roster'
import { timeRangesOverlap, fmtTime } from './schedule-overlap'

/**
 * The approved-leave row covering this coach on this date, or null.
 * `leaveByProfile` is loadBudgetContext's Map<profile_id, rows>, which only
 * ever holds APPROVED rows. Both ends inclusive (mig 011).
 */
export function leaveCovering(leaveByProfile, profileId, dateIso) {
  const rows = leaveByProfile?.get(profileId)
  if (!rows) return null
  return rows.find((r) => r.start_date <= dateIso && r.end_date >= dateIso) || null
}

function inScope(dateIso, { from, to, todayIso }) {
  if (!dateIso) return false
  if (from && dateIso < from) return false
  if (to && dateIso > to) return false
  if (todayIso && dateIso < todayIso) return false
  return true
}

const byDateThenStart = (a, b) =>
  String(a.block_date).localeCompare(String(b.block_date))
  || String(a.start_time || '').localeCompare(String(b.start_time || ''))

/**
 * @returns {Array<{ block_id, block_date, start_time, end_time, name,
 *   profile_id, coach_name, leave_start, leave_end }>}
 */
export function leaveClashes(blocks, { from = null, to = null, todayIso = null, leaveByProfile } = {}) {
  const out = []
  for (const b of blocks || []) {
    if (!inScope(b?.block_date, { from, to, todayIso })) continue
    for (const a of (b.shift_assignments || []).filter(isLiveAssignment)) {
      const leave = leaveCovering(leaveByProfile, a.profile_id, b.block_date)
      if (!leave) continue
      out.push({
        block_id: b.id,
        block_date: b.block_date,
        // The hours the coach is down for: their override, else the block's.
        start_time: a.start_time_override || b.start_time,
        end_time: a.end_time_override || b.end_time,
        name: b.shift_templates?.name || 'Shift',
        profile_id: a.profile_id,
        coach_name: a.profiles?.full_name || 'Coach',
        leave_start: leave.start_date,
        leave_end: leave.end_date,
      })
    }
  }
  return out.sort(byDateThenStart)
}

/**
 * @param {Array<object>} blocks  this studio's blocks (loadBudgetContext shape)
 * @param {Array<object>|null} otherAssignments  the same coaches' assignments
 *   at OTHER studios: { profile_id, status, start_time_override,
 *   end_time_override, shift_blocks: { id, block_date, start_time, end_time,
 *   shift_templates: { name }, locations: { name } } }. null = could not be read.
 * @returns {Array<{ profile_id, coach_name, block_date,
 *   first:  { block_id, name, start_time, end_time, location_name },
 *   second: { block_id, name, start_time, end_time, location_name } }>}
 *   `location_name` is null for a shift at the studio being published.
 */
export function doubleBookings(blocks, otherAssignments, { from = null, to = null, todayIso = null } = {}) {
  // coach|date -> every live window that coach has that day, here or elsewhere.
  const windows = new Map()
  const names = new Map()
  const add = (profileId, date, w) => {
    const key = `${profileId}|${date}`
    if (!windows.has(key)) windows.set(key, [])
    windows.get(key).push(w)
  }

  for (const b of blocks || []) {
    if (!inScope(b?.block_date, { from, to, todayIso })) continue
    for (const a of (b.shift_assignments || []).filter(isLiveAssignment)) {
      if (a.profiles?.full_name) names.set(a.profile_id, a.profiles.full_name)
      add(a.profile_id, b.block_date, {
        here: true,
        block_id: b.id,
        name: b.shift_templates?.name || 'Shift',
        start_time: fmtTime(a.start_time_override || b.start_time),
        end_time: fmtTime(a.end_time_override || b.end_time),
        location_name: null,
      })
    }
  }

  for (const a of (otherAssignments || []).filter(isLiveAssignment)) {
    const ob = a.shift_blocks
    if (!ob || !inScope(ob.block_date, { from, to, todayIso })) continue
    add(a.profile_id, ob.block_date, {
      here: false,
      block_id: ob.id,
      name: ob.shift_templates?.name || 'Shift',
      start_time: fmtTime(a.start_time_override || ob.start_time),
      end_time: fmtTime(a.end_time_override || ob.end_time),
      location_name: ob.locations?.name || 'Another studio',
    })
  }

  const out = []
  for (const [key, list] of windows) {
    const [profileId, date] = key.split('|')
    const sorted = [...list].sort((x, y) => x.start_time.localeCompare(y.start_time))
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const first = sorted[i]
        const second = sorted[j]
        if (!first.here && !second.here) continue
        if (!timeRangesOverlap(first.start_time, first.end_time, second.start_time, second.end_time)) continue
        const strip = ({ here: _here, ...rest }) => rest
        out.push({
          profile_id: profileId,
          coach_name: names.get(profileId) || 'Coach',
          block_date: date,
          first: strip(first),
          second: strip(second),
        })
      }
    }
  }
  return out.sort((a, b) =>
    a.block_date.localeCompare(b.block_date)
    || a.first.start_time.localeCompare(b.first.start_time)
    || a.coach_name.localeCompare(b.coach_name))
}
```

(`_here` honours the repo's `^_` unused-var escape hatch, CLAUDE.md "Build, test & ship".)

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-publish-advisories.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-publish-advisories.js src/lib/roster-publish-advisories.test.js
git commit -m "COPYLEAVE.1 — pure leave-clash and double-booking advisories for the publish preview"
```

---

### Task 8: `projectPublishImpact` carries the advisories

**Files:** Modify `src/lib/roster-publish.js`, `src/lib/roster-publish.test.js`.

What changes in `loadBudgetContext` (`src/lib/roster-publish.js:82-177`):
1. the block select embeds the coach's name on each assignment (the proven form, `src/app/api/schedule/blocks/route.js:64`: `profiles:profile_id(...)`);
2. the leave read's person scope widens from "members of this studio" to "members of this studio OR anyone rostered on these blocks" so a guest coach's leave is seen (LEAVE.2: leave covers the person). This also stops billing a guest contractor on leave, which is what ROSTER-FIX.4 intended;
3. one new paged read: the same coaches' assignments at OTHER studios, copying `readAssignmentsInRange` (`src/lib/time-off-leave.js:262-278`). It FAILS SOFT.

- [ ] **Step 1: Write the failing tests**

(a) Extend `mockDb` in `src/lib/roster-publish.test.js` (lines 32-129). Signature:

```js
function mockDb({ location, locationsById = null, failLocationIds = [], contractors = [], blocks = [], timeOff = [], otherAssignments = [], failOtherAssignments = false }) {
```

Add `const assignmentQueries = []` beside `leaveQueries`, return it from the object (`assignmentQueries,` after `leaveQueries,`), record the leave scope by changing the `or` line in the `time_off_requests` chain:

```js
          or: (expr) => { f.or = expr; return chain },
```

and add this branch immediately before the final `throw new Error('unexpected table: ' + table)`:

```js
      // COPYLEAVE.1 — the same coaches' live shifts at OTHER studios.
      if (table === 'shift_assignments') {
        const f = { profileIds: null, notLoc: null, gte: null, lte: null, from: 0, to: Infinity }
        assignmentQueries.push(f)
        const chain = {
          select: () => chain,
          in: (_c, v) => { f.profileIds = v; return chain },
          neq: (_c, v) => { f.notLoc = v; return chain },
          gte: (_c, v) => { f.gte = v; return chain },
          lte: (_c, v) => { f.lte = v; return chain },
          order: () => chain,
          range: (from, to) => { f.from = from; f.to = to; return chain },
          then: (onF, onR) => Promise.resolve(failOtherAssignments
            ? { data: null, error: { message: 'other studios unreadable' } }
            : {
              data: otherAssignments
                .filter((a) => f.profileIds.includes(a.profile_id))
                .filter((a) => a.shift_blocks.location_id !== f.notLoc)
                .filter((a) => a.shift_blocks.block_date >= f.gte && a.shift_blocks.block_date <= f.lte)
                .slice(f.from, f.to + 1),
              error: null,
            }).then(onF, onR),
        }
        return chain
      }
```

(b) New describe, after `describe('projectPublishImpact — per-assignment overrides and approved leave'` (ends line 413):

```js
// COPYLEAVE.1 — the preview names who is rostered on leave and who is
// double-booked. Advisory: neither changes overBudget or blocks anything.
describe('projectPublishImpact — leave clashes and double bookings', () => {
  const PERIOD = { locationId: 'loc1', periodStart: '2026-05-04', periodEnd: '2026-05-10', todayIso: '2026-05-01' }
  const named = (id, name, over = {}) => ({ profile_id: id, status: 'scheduled', profiles: { full_name: name }, ...over })
  const elsewhere = (profileId, date, start, end) => ({
    id: `oa-${profileId}`, profile_id: profileId, status: 'scheduled', start_time_override: null, end_time_override: null,
    shift_blocks: { id: 'ob1', location_id: 'loc2', block_date: date, start_time: start, end_time: end, shift_templates: { name: 'Open Gym' }, locations: { name: 'Studio B' } },
  })

  it('lists a coach rostered on approved leave, and still costs them at zero', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 500 },
      contractors: [dan],
      blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00', coaches: [named('dan', 'Coach D')] })],
      timeOff: [{ id: 't1', profile_id: 'dan', start_date: '2026-05-04', end_date: '2026-05-08' }],
    })
    const r = await projectPublishImpact(db, PERIOD)
    expect(r.leaveClashes).toEqual([{
      block_id: 'b1', block_date: '2026-05-06', start_time: '09:00', end_time: '11:00', name: 'Shift',
      profile_id: 'dan', coach_name: 'Coach D', leave_start: '2026-05-04', leave_end: '2026-05-08',
    }])
    expect(r.periodProjectedEur).toBe(0)
    expect(r.overBudget).toBe(false)
  })

  it('lists a double booking against a shift at ANOTHER studio', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: null },
      contractors: [dan],
      blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00', coaches: [named('dan', 'Coach D')] })],
      otherAssignments: [elsewhere('dan', '2026-05-06', '10:00:00', '12:00:00')],
    })
    const r = await projectPublishImpact(db, PERIOD)
    expect(r.crossLocationChecked).toBe(true)
    expect(r.doubleBookings).toHaveLength(1)
    expect(r.doubleBookings[0]).toMatchObject({
      coach_name: 'Coach D', block_date: '2026-05-06',
      second: { name: 'Open Gym', location_name: 'Studio B', start_time: '10:00', end_time: '12:00' },
    })
    // The read asked for THESE coaches, NOT this studio, over the loaded months.
    expect(db.assignmentQueries).toHaveLength(1)
    expect(db.assignmentQueries[0]).toMatchObject({ profileIds: ['dan'], notLoc: 'loc1', gte: '2026-05-01', lte: '2026-05-31' })
  })

  it('both lists are empty arrays, never undefined, on a clean week', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: null },
      contractors: [dan],
      blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00', coaches: ['dan'] })],
    })
    const r = await projectPublishImpact(db, PERIOD)
    expect(r.leaveClashes).toEqual([])
    expect(r.doubleBookings).toEqual([])
    expect(r.crossLocationChecked).toBe(true)
  })

  it('a week with nobody rostered makes no other-studio query', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: null },
      blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00' })],
    })
    await projectPublishImpact(db, PERIOD)
    expect(db.assignmentQueries).toHaveLength(0)
  })

  // The advisory must never take the budget gate down with it.
  it('an unreadable other-studio list does NOT throw: same-studio clashes still show and the gap is flagged', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 500 },
      contractors: [dan],
      failOtherAssignments: true,
      blocks: [
        block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00', coaches: [named('dan', 'Coach D')] }),
        block({ id: 'b2', date: '2026-05-06', start: '10:00', end: '12:00', coaches: [named('dan', 'Coach D')] }),
      ],
    })
    const r = await projectPublishImpact(db, PERIOD)
    expect(r.crossLocationChecked).toBe(false)
    expect(r.doubleBookings).toHaveLength(1)
    expect(r.periodProjectedEur).toBe(140) // 2 x 2h x 35: the money is untouched
  })

  it('leave is scoped to the people ON the roster as well as the studio\'s members (a guest coach\'s leave counts)', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: null },
      contractors: [dan],
      blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00', coaches: [named('guest-1', 'Coach G')] })],
    })
    await projectPublishImpact(db, PERIOD)
    expect(db.leaveQueries[0].or).toContain('guest-1')
    expect(db.leaveQueries[0].or).toContain('dan')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-publish.test.js -t "leave clashes and double bookings"`
Expected: `expected undefined to deeply equal [...]` for `leaveClashes` / `doubleBookings`, `expected [] to have a length of 1` for `assignmentQueries`, and `expected 'location_id.in.(loc1),profile_id.in.(dan)' to contain 'guest-1'`.

Then run the whole file once: `npx vitest run src/lib/roster-publish.test.js`. Every pre-existing test must still PASS at this point (the `mockDb` change is additive). If any fails, the mock edit is wrong; fix it before Step 3.

- [ ] **Step 3: Minimal implementation**

In `src/lib/roster-publish.js`:

(a) Imports (lines 20-24), add:

```js
import { logWarn } from './log'
import { leaveCovering, leaveClashes, doubleBookings } from './roster-publish-advisories'
```

(b) Block select (lines 119-124): embed the coach's name. Names only.

```js
      .select(`
        id, location_id, block_date, start_time, end_time, roster_id, min_coaches,
        shift_templates(name),
        shift_assignments(profile_id, status, start_time_override, end_time_override, profiles:profile_id(full_name)),
        rosters:roster_id(id, status)
      `)
```

(c) Directly after the block loop closes (line 134), before the ROSTER-FIX.4 leave comment:

```js
  // COPYLEAVE.1 — everyone with a live shift on these blocks. Used twice
  // below: to widen the leave scope to a guest coach (leave covers the PERSON,
  // LEAVE.2), and to look for the same people's shifts at other studios.
  const rosteredIds = [...new Set(monthBlocks.flatMap((b) => liveAssignments(b.shift_assignments).map((a) => a.profile_id)).filter(Boolean))]
```

(d) The leave read's scope (line 151):

```js
      .or(leaveScopeOrFilter([locationId], [...(links || []).map((l) => l.profile_id), ...rosteredIds]))
```

(e) After the `leaveByProfile` map is built (line 167), before `return {`:

```js
  // COPYLEAVE.1 — the same coaches' assignments at OTHER studios, for the
  // double-booking advisory. Same shape and paging as readAssignmentsInRange
  // (time-off-leave.js). FAILS SOFT: this function is also the hard budget
  // gate for a real publish, and an advisory must never be able to refuse one.
  // null = "could not check", which impactFromContext reports as
  // crossLocationChecked: false rather than as "no clashes".
  let otherAssignments = []
  if (rosteredIds.length > 0) {
    for (let from = 0; ; from += BLOCK_PAGE_SIZE) {
      const { data: page, error: otherErr } = await db
        .from('shift_assignments')
        .select('id, profile_id, status, start_time_override, end_time_override, shift_blocks!inner(id, location_id, block_date, start_time, end_time, shift_templates(name), locations(name))')
        .in('profile_id', rosteredIds)
        .neq('shift_blocks.location_id', locationId)
        .gte('shift_blocks.block_date', monthStart)
        .lte('shift_blocks.block_date', monthEnd)
        .order('id', { ascending: true })
        .range(from, from + BLOCK_PAGE_SIZE - 1)
      if (otherErr) {
        logWarn('roster-publish', 'other-studio assignments unreadable; double-booking check is this studio only', { locationId, err: otherErr.message })
        otherAssignments = null
        break
      }
      otherAssignments.push(...(page || []))
      if (!page || page.length < BLOCK_PAGE_SIZE) break
    }
  }
```

and add `otherAssignments,` to the returned context object.

(f) `isOnLeave` (lines 184-188) delegates, so there is one definition of "covered":

```js
function isOnLeave(leaveByProfile, profileId, dateIso) {
  return Boolean(leaveCovering(leaveByProfile, profileId, dateIso))
}
```

(g) In `impactFromContext` (line 343) destructure `otherAssignments`:

```js
  const { location, contractorRateById, leaveByProfile, monthBlocks, otherAssignments } = ctx
```

and extend the returned object (after `staffingGaps: staffingGapsInPeriod,`, line 431):

```js
    // COPYLEAVE.1 — advisory, like staffingGaps: nothing here gates a publish.
    leaveClashes: leaveClashes(monthBlocks, { from: periodStart, to: periodEnd, todayIso, leaveByProfile }),
    doubleBookings: doubleBookings(monthBlocks, otherAssignments, { from: periodStart, to: periodEnd, todayIso }),
    // false = the other-studio read failed, so doubleBookings covers this
    // studio only. The modal says so instead of implying an all-clear.
    crossLocationChecked: otherAssignments !== null,
```

(h) JSDoc `@returns` of `projectPublishImpact` (lines 232-249): add

```js
 *   leaveClashes: Array<{ block_id, block_date, start_time, end_time, name,
 *                         profile_id, coach_name, leave_start, leave_end }>,
 *   doubleBookings: Array<{ profile_id, coach_name, block_date, first, second }>,
 *   crossLocationChecked: boolean,
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-publish.test.js src/lib/roster-publish-advisories.test.js`
Expected: all pass, including `projectPublishImpactBatch`'s "same draft both ways" test (line 564, `expect(batch[i].impact).toEqual(single)`): both paths go through the same `impactFromContext`, and the advisories filter to the period exactly as `staffingGaps` does.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-publish.js src/lib/roster-publish.test.js
git commit -m "COPYLEAVE.1 — publish impact lists leave clashes and double bookings, other studios included"
```

---

### Task 9: render the advisories in the publish modal

**Files:** Modify `src/components/ScheduleCalendar.jsx` (line 2267 and after `PublishStaffingGaps`), `src/components/ScheduleCalendar.visibility.test.jsx`.

jsdom cannot see layout (CLAUDE.md / memory `jsdom-cannot-see-layout`): assert text, test ids and presence only. Do not assert scroll heights or visibility.

- [ ] **Step 1: Write the failing test**

Append to `src/components/ScheduleCalendar.visibility.test.jsx`:

```js
describe('publish preview clashes (COPYLEAVE.1)', () => {
  const BASE = { blockCount: 2, periodProjectedEur: 0, monthProjectedTotalEur: 0, monthlyBudgetEur: 100, overBudget: false, staffingGaps: [] }
  const LEAVE_CLASH = {
    block_id: 'short', block_date: BLOCK_DATE, start_time: '09:00', end_time: '12:00', name: 'Early',
    profile_id: 'u2', coach_name: 'Coach A', leave_start: BLOCK_DATE, leave_end: BLOCK_DATE,
  }
  const DOUBLE = {
    profile_id: 'u3', coach_name: 'Coach B', block_date: BLOCK_DATE,
    first: { block_id: 'ok', name: 'Lunch', start_time: '12:00', end_time: '13:00', location_name: null },
    second: { block_id: 'ob1', name: 'Open Gym', start_time: '12:30', end_time: '14:00', location_name: 'Studio B' },
  }

  async function openPreview(impact) {
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK], impact })
    fireEvent.click(screen.getByText('Publish'))
    await screen.findByText('Blocks in period', {}, { timeout: 5000 })
  }

  it('names the coach on leave and the double-booked coach, with times and the other studio', async () => {
    await openPreview({ ...BASE, leaveClashes: [LEAVE_CLASH], doubleBookings: [DOUBLE], crossLocationChecked: true })
    const box = screen.getByTestId('publish-roster-clashes')
    expect(box.textContent).toMatch(/1 coach rostered on approved leave/)
    expect(box.textContent).toMatch(/Coach A/)
    expect(box.textContent).toMatch(/9am Early/)
    expect(box.textContent).toMatch(/1 double booking/)
    expect(box.textContent).toMatch(/Coach B/)
    expect(box.textContent).toMatch(/12pm–1pm Lunch/)
    expect(box.textContent).toMatch(/12:30pm–2pm Open Gym \(Studio B\)/)
    // Never money.
    expect(box.textContent).not.toMatch(/€/)
    // Information only: Publish is still there and enabled.
    const publishButtons = screen.getAllByRole('button', { name: 'Publish' })
    expect(publishButtons[publishButtons.length - 1].disabled).toBe(false)
  })

  it('sits beside the staffing list, above the cost tiles', async () => {
    await openPreview({ ...BASE, leaveClashes: [LEAVE_CLASH], doubleBookings: [], crossLocationChecked: true })
    const box = screen.getByTestId('publish-roster-clashes')
    const tiles = screen.getByText('Blocks in period')
    expect(box.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders nothing when there is nothing to say', async () => {
    await openPreview({ ...BASE, leaveClashes: [], doubleBookings: [], crossLocationChecked: true })
    expect(screen.queryByTestId('publish-roster-clashes')).toBeNull()
  })

  it('renders nothing for an older server that does not send the lists', async () => {
    await openPreview(BASE)
    expect(screen.queryByTestId('publish-roster-clashes')).toBeNull()
  })

  it('says so when other studios could not be checked, rather than implying an all-clear', async () => {
    await openPreview({ ...BASE, leaveClashes: [], doubleBookings: [], crossLocationChecked: false })
    expect(screen.getByTestId('publish-roster-clashes').textContent).toMatch(/Shifts at other studios could not be checked/)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/ScheduleCalendar.visibility.test.jsx -t "publish preview clashes"`
Expected: tests 1, 2 and 5 fail with `Unable to find an element by: [data-testid="publish-roster-clashes"]`. Tests 3 and 4 PASS already (they assert absence). That is expected and is why they are not the proof; tests 1, 2 and 5 are.

- [ ] **Step 3: Minimal implementation**

(a) `src/components/ScheduleCalendar.jsx`, directly under line 2267 (`<PublishStaffingGaps gaps={impact.staffingGaps} />`):

```jsx
            {/* COPYLEAVE.1 — who is rostered on approved leave, and who is
                double-booked (another studio included). Information only. */}
            <PublishRosterClashes
              leaveClashes={impact.leaveClashes}
              doubleBookings={impact.doubleBookings}
              crossLocationChecked={impact.crossLocationChecked}
            />
```

(b) Add this component directly after `PublishStaffingGaps` (which ends around line 2386, just before `function SwapModal`). `formatTime` is already imported in this file as `formatTime12h` (line 61); `AlertTriangle` is already imported (line 25).

```jsx
// COPYLEAVE.1 — coaches rostered on approved leave, and double bookings, in
// the period about to be published. Both come from projectPublishImpact. An
// older server that sends neither renders nothing. Names and times only.
function PublishRosterClashes({ leaveClashes, doubleBookings, crossLocationChecked }) {
  if (!Array.isArray(leaveClashes) || !Array.isArray(doubleBookings)) return null
  const unchecked = crossLocationChecked === false
  if (leaveClashes.length === 0 && doubleBookings.length === 0 && !unchecked) return null
  const dayOf = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })
  const slot = (s) => `${formatTime(s.start_time)}–${formatTime(s.end_time)} ${s.name}${s.location_name ? ` (${s.location_name})` : ''}`
  return (
    <div
      data-testid="publish-roster-clashes"
      className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      {leaveClashes.length > 0 && (
        <div>
          <div className="font-medium text-amber-700 flex items-center gap-1.5">
            <AlertTriangle size={14} aria-hidden="true" />
            {leaveClashes.length} coach{leaveClashes.length === 1 ? '' : 'es'} rostered on approved leave
          </div>
          <ul className="mt-1.5 max-h-32 overflow-y-auto space-y-1">
            {leaveClashes.map((c) => (
              <li key={`${c.block_id}|${c.profile_id}`} className="text-xs text-un1t-text">
                <span className="font-medium">{c.coach_name}</span> · {dayOf(c.block_date)} · {formatTime(c.start_time)} {c.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {doubleBookings.length > 0 && (
        <div className={leaveClashes.length > 0 ? 'mt-3' : ''}>
          <div className="font-medium text-amber-700 flex items-center gap-1.5">
            <AlertTriangle size={14} aria-hidden="true" />
            {doubleBookings.length} double booking{doubleBookings.length === 1 ? '' : 's'}
          </div>
          <ul className="mt-1.5 max-h-32 overflow-y-auto space-y-1">
            {doubleBookings.map((d) => (
              <li key={`${d.profile_id}|${d.first.block_id}|${d.second.block_id}`} className="text-xs text-un1t-text">
                <span className="font-medium">{d.coach_name}</span> · {dayOf(d.block_date)} · {slot(d.first)} and {slot(d.second)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {unchecked && (
        <div className="text-xs text-un1t-subtle mt-2">Shifts at other studios could not be checked.</div>
      )}
      <div className="text-xs text-un1t-subtle mt-2">You can still publish.</div>
    </div>
  )
}
```

Chip/contrast rule: amber text on a light card uses the `-700` ramp (`check:guardrails` `no-low-contrast-chip`); the classes above mirror `PublishStaffingGaps` exactly.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.publish-confirm.test.jsx`
Expected: all pass (publish-confirm's fixtures carry no `leaveClashes`, so the component renders nothing there).

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.visibility.test.jsx
git commit -m "COPYLEAVE.1 — the publish modal lists leave clashes and double bookings"
```

---

### Task 10: OpenAPI + changelog

**Files:** Modify `src/lib/openapi.js:4335-4340`, `docs/CHANGELOG.md`.

No TDD cycle: documentation of a response already pinned by the route tests.

- [ ] **Step 1: Document `skipped_on_leave`**

In `CopyShiftsResponse`, change the `skipped` description to end `…or a slot a manager deleted in the target period, or the coach has approved leave that day). Includes skipped_removed and skipped_on_leave.` and add below `skipped_removed`:

```js
  skipped_on_leave: z.number().int().optional().openapi({ description: 'COPYLEAVE.1 — the part of skipped whose coach has APPROVED time off (any type) covering the target date. Pending leave does not skip. Leave is matched by person, wherever it was filed. In exact mode the slot itself is still created, so it shows as a staffing gap.' }),
```

Append to BOTH copy routes' `500` description: ` or approved leave could not be read; nothing was copied`.

- [ ] **Step 2: Verify**

Run: `npx vitest run src/lib/openapi` (runs whatever openapi tests exist; if none match, run `npm run lint -- src/lib/openapi.js`).
Expected: green.

- [ ] **Step 3: Commit, push, open the PR, then add the changelog row**

```bash
git add src/lib/openapi.js
git commit -m "COPYLEAVE.1 — document skipped_on_leave"
git push -u origin HEAD
gh pr create --base main --fill
```

Then add ONE new row at the top of the table in `docs/CHANGELOG.md` (directly under the `| # / PR | Item | Notes |` header rows, keyed by the PR number `gh` just printed). Never edit an existing pushed row: `merge=union` would duplicate it.

```
| #<PR> | COPYLEAVE.1 — Copy Last Week / Month no longer roster a coach onto approved leave, and the publish preview names leave clashes and double bookings (other studios included) | 2026-09-19. No migration; nothing under `mobile/` or `shared/` changed, so **no OTA**. `buildCopyPlan` takes `isOnLeave`; both copy routes read approved leave BY PERSON over the target period (a failed read stops the copy, 500) and answer `skipped_on_leave`; the toast says "N skipped, on leave". Pending leave does not skip. `projectPublishImpact` adds advisory `leaveClashes`, `doubleBookings`, `crossLocationChecked`; the other-studio read fails SOFT so it can never refuse a publish. Leave scope in the projection widened to everyone rostered on the blocks (a guest contractor on leave is no longer billed). |
```

```bash
git add docs/CHANGELOG.md
git commit -m "COPYLEAVE.1 — changelog"
git push
```

---

### PR gate

Focused tests (run these, not the whole suite, while iterating):

```bash
npx vitest run src/lib/roster-copy.test.js src/lib/roster-publish.test.js src/lib/roster-publish-advisories.test.js \
  src/app/api/schedule/shifts/copy-week/route.test.js src/app/api/schedule/shifts/copy-month/route.test.js \
  src/components/ScheduleCalendar.errors.test.jsx src/components/ScheduleCalendar.visibility.test.jsx \
  src/components/ScheduleCalendar.publish-confirm.test.jsx
for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/roster-copy.test.js; done
```

Repo checks relevant to this change:

- [ ] `npm run lint`
- [ ] `npm run check:select-columns` — three selects changed or added (`time_off_requests`, `shift_blocks` with the `profiles:profile_id(full_name)` embed, `shift_assignments` with the `shift_blocks!inner(...)` embed). A red here means a column name is wrong; fix the name, never allowlist.
- [ ] `npm run check:guardrails` — new JSX (chip contrast, `un1t-*` tokens) and no new UTC-date parsing.
- [ ] `npm run check:location-scoping` and `npm run check:route-guards` — no new route, and both copy routes keep `assertLocationAccess(`; expected unchanged green.
- [ ] `npm test` once, then `npm run build` once, immediately before pushing (one new module import: `roster-publish-advisories`).

Manual check on the Vercel PREVIEW (local dev has no database): as a manager, approve one day of "unavailable" for a test coach next week, Copy Last Week onto it, and confirm the toast reads "… 1 skipped, on leave." and the slot shows as a gap; open Publish and confirm nothing is listed. Then assign that coach to that day by hand, open Publish, and confirm they are listed under "rostered on approved leave".
