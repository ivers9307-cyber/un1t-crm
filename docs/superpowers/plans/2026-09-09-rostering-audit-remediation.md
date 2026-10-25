# Rostering Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every finding in the 2026-09-09 staff rostering audit (memory: `rostering-platform-audit-2026-09-09`) as eight independently shippable PRs, highest-risk first.

**Architecture:** The Roster v2 model (template → block → assignment → roster) stays. Fixes are read-side truth first (one `isLiveAssignment` helper, `published` derived from the roster), then authorisation/tenancy, then governance, then publish/approval flow, then reporting + horizon cron, then UI/mobile hygiene, then schema hardening. Each PR is a branch off `origin/main` in its own worktree (`~/code/un1t-crm-<tag>`), PR-tagged `ROSTER-FIX.N`, merged serially.

**Tech Stack:** Next.js 16 route handlers, Supabase (service-role in routes; RLS fences only the browser), Zod 4, Vitest (route tests mock `@/lib/supabase` + `@/lib/auth`), Expo/RN mobile calling the same routes via `mobile/lib/api.js`. Migrations forward-only, applied by Claude via Supabase MCP after the code deploys.

---

## Decisions assumed (Richard can overrule before the relevant PR starts)

| # | Decision | Default taken in this plan | Affects |
|---|---|---|---|
| D1 | Should coaches see draft (unpublished) shifts at all? | **No — Richard's call (2026-09-09): coaches see published shifts only.** Non-manager callers of `GET /api/schedule/shifts` get published rows only; the personal Today dashboard (web + mobile, `fetchPersonalDashboardData`) returns published rows only for everyone (a manager who also coaches sees their own drafts on the Schedule calendar, not on Today); a coach cannot open a swap on an unpublished shift. Managers keep drafts in the calendar, ManageMode and the manager view of the shifts feed. | PR 1, PR 2 |
| D2 | Can a coach delete their own assignment from a published roster? | **No.** Self-delete becomes a swap "drop" request (existing flow). Managers keep DELETE. | PR 3 |
| D3 | Can a coach adjust their own shift times? | **No — Richard's call (2026-09-09): a coach is paid for a window a manager set, and only a manager changes it.** `PUT /api/schedule/assignments/[id]` becomes manager-only; every "Adjust time" affordance for coaches (web Today dashboard, mobile schedule tab, mobile PersonalDashboard, calendar row for own shift) is removed. Coaches keep swaps and time-off as their only ways to change a shift. | PR 3 |
| D4 | `approved_drop` swap: tombstone (`status='cancelled'`) or delete the assignment? | **Delete** the assignment and write a `roster_change_log` row. A tombstone blocks re-adding the coach (unique key) and every reader had to learn to ignore it. | PR 1 |
| D5 | Rejecting a draft roster | **DELETE the draft row** (blocks were never tagged, so nothing else references it). No new status, no migration. | PR 4 |

## PR map

| PR | Tag | Findings closed | Migration |
|---|---|---|---|
| 1 | ROSTER-FIX.1 read-side truth | T1-0 mobile publish gate, T1-1 cancelled/swapped everywhere, mobile sort, mobile AdjustSheet | none |
| 2 | ROSTER-FIX.2 tenancy + swap validation | T1-3 swap target, T1-4 cross-tenant leave/allowances, blocks GET gate, coach picker pay leak | 599 (swap CHECK + partial unique), 600 (RLS location scoping) |
| 3 | ROSTER-FIX.3 self-edit governance | T1-2 | none |
| 4 | ROSTER-FIX.4 publish + approvals | T1-5 approvals overrun/reject, T1-6 template edits, T2 overlap/post-publish blocks/budget overrides+leave | 601 (rosters overlap guard) |
| 5 | ROSTER-FIX.5 horizon + reports | T1-7 horizon cron, T1-8 day-of-week, June leftovers (daily, utilisation scope, staff_hours overrides, fortnightly) | none |
| 6 | ROSTER-FIX.6 web UI hygiene (6a data/errors, 6b modals/a11y, 6c dedupe) | Tier 3 web | none |
| 7 | ROSTER-FIX.7 mobile hygiene | Tier 3 mobile | none |
| 8 | ROSTER-FIX.8 schema hardening | T2 DB: overlap exclusion, indexes, replay hazards, notifications FK, swap email fallback | 602-603 |

PRs 1 and 2 are written below at full bite-sized granularity. PRs 3-8 are written at task granularity (exact files, exact change, named tests); the executing session expands each into steps when it starts that PR, using PR 1/2 as the pattern.

Worktree rule (memory `dev-workflow-worktrees`): every PR gets a fresh worktree off `origin/main`; never touch `~/code/un1t-crm` (it is 27+ behind and not on main).

Test command everywhere: `npx vitest run <path>`. Full gate before every PR: `npm run test:mirror` (or `npx vitest run` if the mirror script is absent), then `npm run build`.

---

# PR 1 — ROSTER-FIX.1: read-side truth

Branch: `roster-fix-1-read-truth`. Worktree: `~/code/un1t-crm-rfix1`.

### Task 1.1: `isLiveAssignment` helper

**Files:**
- Modify: `src/lib/roster.js` (append)
- Test: `src/lib/roster.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/roster.test.js`:

```js
import { isLiveAssignment, liveAssignments } from './roster'

describe('isLiveAssignment', () => {
  it('treats scheduled / confirmed / completed / swapped as live', () => {
    for (const status of ['scheduled', 'confirmed', 'completed', 'swapped']) {
      expect(isLiveAssignment({ status })).toBe(true)
    }
  })
  it('treats cancelled as not live', () => {
    expect(isLiveAssignment({ status: 'cancelled' })).toBe(false)
  })
  it('treats a missing status as live (legacy rows)', () => {
    expect(isLiveAssignment({})).toBe(true)
    expect(isLiveAssignment({ status: null })).toBe(true)
  })
  it('liveAssignments filters an array and tolerates null', () => {
    expect(liveAssignments(null)).toEqual([])
    expect(liveAssignments([{ status: 'cancelled' }, { status: 'scheduled', id: 'a' }])).toEqual([{ status: 'scheduled', id: 'a' }])
  })
})
```

Note: `swapped` is live — after an approved swap the row now belongs to the taker and is a real shift. Only `cancelled` is dead.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/roster.test.js`
Expected: FAIL, `isLiveAssignment is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/roster.js`:

```js
/**
 * ROSTER-FIX.1 — the one definition of "this assignment still puts a coach
 * on the block". Every reader (capacity, budget, notify, reports, copy)
 * goes through this so a dropped shift can't be counted somewhere by
 * accident. Only `cancelled` is dead; `swapped` is a real shift owned by
 * the taker; a missing status is a legacy row and counts as live.
 */
export function isLiveAssignment(a) {
  return a?.status !== 'cancelled'
}

/** Filter helper — tolerates null/undefined. */
export function liveAssignments(list) {
  return (list || []).filter(isLiveAssignment)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/roster.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster.js src/lib/roster.test.js
git commit -m "ROSTER-FIX.1a — isLiveAssignment: one definition of a live shift assignment"
```

### Task 1.2: `fetchApiShiftRows` derives `published` and drops cancelled rows

**Files:**
- Modify: `src/lib/roster-read.js:134-208`
- Test: `src/lib/roster-read.test.js:150-198`

- [ ] **Step 1: Change the existing test that pins the wrong value, and add two**

In `src/lib/roster-read.test.js`, in the `fetchApiShiftRows` describe, change the second test's fixture: add `roster_id: 'r1', rosters: { status: 'published' }` to the first row's `shift_blocks`, and `roster_id: null, rosters: null` to the second. Change the assertion `published: true` to stay `published: true` for `rows[0]` (a1 is the second fixture... careful: rows are sorted by date, `a1` = 06-08 is the second fixture object). So: give the **a1** fixture (`block_date: '2026-06-08'`) `roster_id: 'r1', rosters: { status: 'published' }` and the **a2** fixture `roster_id: null, rosters: null`. Then add after the existing `expect(rows[0].start_time).toBeUndefined()`:

```js
    // ROSTER-FIX.1 — published derives from the block's roster, never hard-coded
    expect(rows[0].published).toBe(true)
    expect(rows[1].published).toBe(false)
```

Add two new tests in the same describe:

```js
  it('marks a shift on a draft roster as unpublished', async () => {
    const db = makeDb({
      data: [{
        id: 'a3', profile_id: 'p1', status: 'scheduled',
        shift_blocks: {
          location_id: 'loc1', template_id: 't1', block_date: '2026-06-10',
          start_time: '09:00:00', end_time: '10:00:00',
          roster_id: 'r-draft', rosters: { status: 'draft' },
          shift_templates: { id: 't1', name: 'AM', start_time: '09:00:00', end_time: '10:00:00' },
        },
        profiles: null,
      }],
      error: null,
    })
    const { rows } = await fetchApiShiftRows(db, { locationIds: ['loc1'] })
    expect(rows[0].published).toBe(false)
  })

  it('drops cancelled assignments (approved swap-drop tombstones)', async () => {
    const block = {
      location_id: 'loc1', template_id: 't1', block_date: '2026-06-10',
      start_time: '09:00:00', end_time: '10:00:00', roster_id: null, rosters: null,
      shift_templates: { id: 't1', name: 'AM', start_time: '09:00:00', end_time: '10:00:00' },
    }
    const db = makeDb({
      data: [
        { id: 'live', profile_id: 'p1', status: 'scheduled', shift_blocks: block, profiles: null },
        { id: 'dead', profile_id: 'p1', status: 'cancelled', shift_blocks: block, profiles: null },
      ],
      error: null,
    })
    const { rows } = await fetchApiShiftRows(db, { locationIds: ['loc1'] })
    expect(rows.map((r) => r.id)).toEqual(['live'])
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/roster-read.test.js`
Expected: FAIL on `published` false and on the `['live']` equality.

- [ ] **Step 3: Implement**

In `src/lib/roster-read.js`:

Add the import at the top:
```js
import { isLiveAssignment } from './roster'
```

Change `API_SHIFT_SELECT` so the block embed includes the roster:
```js
const API_SHIFT_SELECT = `
  id, profile_id, status, notes, partial_reason,
  start_time_override, end_time_override, assigned_by, assigned_at, updated_at,
  shift_blocks!inner (
    location_id, template_id, block_date, start_time, end_time, notes, roster_id,
    rosters:roster_id ( status ),
    shift_templates (*)
  ),
  profiles!profile_id ( id, full_name, email, avatar_url, role )
`
```

In `toApiShiftRow`, replace `published: true,` with:
```js
    // ROSTER-FIX.1 — publishing is a roster concept: a shift is published
    // iff its block belongs to a published roster (same derivation as
    // shared/dashboard-data.js fetchDashboardShifts). Was hard-coded true,
    // which showed draft + copied shifts to every coach's phone as live.
    published: b.rosters?.status === 'published',
```

In `fetchApiShiftRows`, add a `publishedOnly = false` option to the destructured opts and change the filter line to:
```js
  const rows = (data || [])
    .filter((a) => a.shift_blocks && isLiveAssignment(a))
    .map(toApiShiftRow)
    // D1 — coaches see published shifts only; managers pass publishedOnly:false.
    .filter((r) => !publishedOnly || r.published)
```
(Keep the existing `.sort(...)` after it.) Update the JSDoc with `@param {boolean} [opts.publishedOnly=false]`.

Also update the header comment block above `API_SHIFT_SELECT` (`published = true (...)` bullet) to say `published derives from block → roster (ROSTER-FIX.1)`.

Add one more test to the `fetchApiShiftRows` describe:

```js
  it('publishedOnly drops unpublished rows', async () => {
    const mk = (id, status) => ({
      id, profile_id: 'p1', status: 'scheduled',
      shift_blocks: {
        location_id: 'loc1', template_id: 't1', block_date: '2026-06-10', start_time: '09:00:00', end_time: '10:00:00',
        roster_id: status ? 'r' : null, rosters: status ? { status } : null,
        shift_templates: { id: 't1', name: 'AM', start_time: '09:00:00', end_time: '10:00:00' },
      },
      profiles: null,
    })
    const db = makeDb({ data: [mk('pub', 'published'), mk('draft', 'draft'), mk('none', null)], error: null })
    const { rows } = await fetchApiShiftRows(db, { locationIds: ['loc1'], publishedOnly: true })
    expect(rows.map((r) => r.id)).toEqual(['pub'])
  })
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/roster-read.test.js`
Expected: PASS (all).

- [ ] **Step 5: Route — non-managers get published only**

Create `src/app/api/schedule/shifts/route.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null), getUserLocationIds: vi.fn(() => ['loc-1']) }))
vi.mock('@/lib/roster-read', () => ({ fetchApiShiftRows: vi.fn(() => Promise.resolve({ rows: [], error: null })) }))
const { getCurrentUser } = await import('@/lib/auth')
const { fetchApiShiftRows } = await import('@/lib/roster-read')
const { GET } = await import('./route.js')
const req = (url = 'http://x/api/schedule/shifts?location_id=loc-1') => ({ url })
beforeEach(() => { getCurrentUser.mockReset(); fetchApiShiftRows.mockClear() })

describe('GET /api/schedule/shifts — draft visibility (D1)', () => {
  it('a coach gets published shifts only', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', locations: [{ id: 'loc-1' }] })
    await GET(req())
    expect(fetchApiShiftRows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ publishedOnly: true }))
  })
  it('a manager sees drafts too', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', locations: [{ id: 'loc-1' }] })
    await GET(req())
    expect(fetchApiShiftRows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ publishedOnly: false }))
  })
})
```

Run it → FAIL. Then in `src/app/api/schedule/shifts/route.js` import `MANAGER_ROLES` from `@/lib/schemas` and pass `publishedOnly: !MANAGER_ROLES.includes(user.role)` into `fetchApiShiftRows`. Run → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/roster-read.js src/lib/roster-read.test.js src/app/api/schedule/shifts/
git commit -m "ROSTER-FIX.1b — GET /shifts: published derives from the roster; coaches get published rows only (D1)"
```

### Task 1.2b: personal Today dashboard shows published shifts only (D1)

**Files:**
- Modify: `shared/dashboard-data.js:86-121` (`fetchDashboardShifts`), `:155-159` (the two personal calls)
- Modify: `src/components/dashboard/MonthRoster.jsx:532-536, 604-617` (remove the now-unreachable Draft pill/border)
- Test: `shared/dashboard-data.test.js`

Both web (`src/app/dashboard/today/page.js:169`) and mobile (`mobile/lib/dashboard-api.js:21`) call `fetchPersonalDashboardData(supabase, profileId, locationId)`; neither passes a role, and `shared/` is the seam, so the rule is applied inside the reader rather than plumbed from two callers.

- [ ] **Step 1: Write the failing test**

In `shared/dashboard-data.test.js`, find how the existing tests build the Supabase mock for `fetchPersonalDashboardData` (search `fetchPersonalDashboardData`). Add a case where the `shift_assignments` query resolves two rows, one with `shift_blocks.rosters = { status: 'published' }` and one with `{ status: 'draft' }`, and assert the returned `thisWeek`/`monthShifts` (whatever keys the existing test asserts on) contain only the published one.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

`fetchDashboardShifts` gains `publishedOnly = false` in its opts and, after mapping, `return { data: publishedOnly ? rows.filter((r) => r.published) : rows, error: null }`. The two calls at `:155` and `:159` pass `publishedOnly: true` with a comment:
```js
      // D1 (ROSTER-FIX.1) — coaches see published shifts only. Personal =
      // published for everyone; a manager's own drafts live on the calendar.
```
The business-dashboard call at `:692` stays unfiltered (manager cost planning wants drafts).

`MonthRoster.jsx`: delete the `s.published === false` pill (`:532-536`) and the `isDraft` amber border (`:604-617`); nothing reaching it is unpublished any more.

- [ ] **Step 4: Run → PASS.** Also `npx vitest run mobile/lib` (mobile PersonalDashboard consumes the same data).

- [ ] **Step 5: Commit**

```bash
git add shared/dashboard-data.js shared/dashboard-data.test.js src/components/dashboard/MonthRoster.jsx
git commit -m "ROSTER-FIX.1b2 — personal Today dashboard returns published shifts only (D1)"
```

### Task 1.3: copy-week / copy-month source rows skip cancelled assignments

**Files:**
- Modify: `src/lib/roster-read.js:81-118` (`fetchSourceShiftRows`)
- Test: `src/lib/roster-read.test.js` (`fetchSourceShiftRows` describe)

- [ ] **Step 1: Write the failing test**

Add to the `fetchSourceShiftRows` describe:

```js
  it('does not copy a cancelled assignment (dropped shift must not resurrect)', async () => {
    const blk = {
      location_id: 'loc1', template_id: 't1', block_date: '2026-06-01',
      start_time: '09:00:00', end_time: '10:00:00',
      shift_templates: { start_time: '09:00:00', end_time: '10:00:00' },
    }
    const db = makeDb({
      data: [
        { profile_id: 'p1', status: 'cancelled', notes: null, start_time_override: null, end_time_override: null, shift_blocks: blk },
        { profile_id: 'p2', status: 'scheduled', notes: null, start_time_override: null, end_time_override: null, shift_blocks: blk },
      ],
      error: null,
    })
    const { rows } = await fetchSourceShiftRows(db, { locationId: 'loc1', startDate: '2026-06-01', endDate: '2026-06-07' })
    expect(rows.map((r) => r.profileId)).toEqual(['p2'])
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/roster-read.test.js`
Expected: FAIL, received `['p1', 'p2']`.

- [ ] **Step 3: Implement**

In `fetchSourceShiftRows`, add `status,` to the select list (after `profile_id,`), and change the loop:
```js
  for (const a of data || []) {
    const b = a.shift_blocks
    if (!b) continue
    if (!isLiveAssignment(a)) continue
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/roster-read.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-read.js src/lib/roster-read.test.js
git commit -m "ROSTER-FIX.1c — copy-week/month never resurrect a cancelled assignment"
```

### Task 1.4: summary panel + budget projection ignore cancelled rows

**Files:**
- Modify: `src/lib/roster-summary.js:84-101` (`blocksToShiftRows`)
- Modify: `src/lib/roster-publish.js:97-104` (`blockContractorCost`)
- Modify: `src/lib/roster-notify.js:41-45` (`publishNotifyRowsForBlocks`)
- Test: `src/lib/roster-summary.test.js`, `src/lib/roster-publish.test.js`, `src/lib/roster-notify.test.js`

- [ ] **Step 1: Write the failing tests**

`src/lib/roster-summary.test.js` — find the existing `summarizeWeek` describe and add:

```js
  it('ignores cancelled assignments when summing hours and contractor euros', () => {
    const blocks = [{
      id: 'b1', location_id: 'l', block_date: '2026-06-01', start_time: '09:00:00', end_time: '11:00:00',
      max_coaches: 15, shift_templates: { start_time: '09:00:00', end_time: '11:00:00' },
      shift_assignments: [
        { profile_id: 'c1', status: 'cancelled' },
        { profile_id: 'c2', status: 'scheduled' },
      ],
    }]
    const staff = [
      { id: 'c1', full_name: 'A', active: true, employment_type: 'contractor', hourly_rate: 50 },
      { id: 'c2', full_name: 'B', active: true, employment_type: 'contractor', hourly_rate: 50 },
    ]
    const out = summarizeWeek({ blocks, staff, weekStart: new Date('2026-06-01T00:00:00') })
    expect(out.contractorWeekCostEur).toBe(100) // 2h × €50, c1 excluded
  })
```

`src/lib/roster-publish.test.js` — look at how the existing tests build the db mock for `projectPublishImpact` (they pass `monthBlocks` with `shift_assignments`); add a case where one assignment on a block has `status: 'cancelled'` and assert `periodProjectedEur` excludes it. Use the same fixture shape as the neighbouring test; the assertion:

```js
    expect(impact.periodProjectedEur).toBe(/* hours × rate for the live coach only */)
```
(fill the number from the fixture you copied; e.g. 1h block, rate 40, one live + one cancelled → 40).

`src/lib/roster-notify.test.js` — add:

```js
  it('publishNotifyRowsForBlocks skips cancelled assignments', async () => {
    const db = {
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({
            data: [
              { id: 'a1', profile_id: 'p1', status: 'scheduled', shift_blocks: { location_id: 'l', block_date: '2026-06-01' } },
              { id: 'a2', profile_id: 'p2', status: 'cancelled', shift_blocks: { location_id: 'l', block_date: '2026-06-01' } },
            ],
            error: null,
          }),
        }),
      }),
    }
    const rows = await publishNotifyRowsForBlocks(db, ['b1'])
    expect(rows.map((r) => r.profile_id)).toEqual(['p1'])
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/roster-summary.test.js src/lib/roster-publish.test.js src/lib/roster-notify.test.js`
Expected: three FAILs.

- [ ] **Step 3: Implement**

`roster-summary.js`: import `{ addDays, formatDate, liveAssignments } from './roster'` and in `blocksToShiftRows` change `for (const a of block.shift_assignments || [])` to `for (const a of liveAssignments(block.shift_assignments))`. Also change the `unstaffedCount` filter in `summarizeWeek` to `liveAssignments(b.shift_assignments).length === 0 && b.block_date >= todayIso`.

`roster-publish.js`: import `{ liveAssignments } from './roster'`; in `loadBudgetContext` change the select embed to `shift_assignments(profile_id, status)`; in `blockContractorCost` iterate `liveAssignments(block.shift_assignments)`.

`roster-notify.js`: import `{ isLiveAssignment } from './roster'`; add `status` to the select (`'id, profile_id, status, shift_blocks!block_id(location_id, block_date)'`); filter `.filter((a) => a.shift_blocks && isLiveAssignment(a))`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/roster-summary.test.js src/lib/roster-publish.test.js src/lib/roster-notify.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-summary.js src/lib/roster-publish.js src/lib/roster-notify.js src/lib/*.test.js
git commit -m "ROSTER-FIX.1d — summary panel, budget gate and publish notify ignore cancelled assignments"
```

### Task 1.5: server contractor-spend, reports, single-assign capacity

**Files:**
- Modify: `src/lib/roster-summary-server.js:66-72` (select already includes `status`; nothing to change — `summarizeMonth` now filters via Task 1.4)
- Modify: `src/lib/report-generator.js:21-36` (`fetchScheduledShiftRows`)
- Modify: `src/app/api/schedule/blocks/[id]/assignments/route.js:60-99`
- Test: `src/app/api/schedule/blocks/[id]/assignments/route.test.js`

- [ ] **Step 1: Write the failing route test**

In `route.test.js`, the `buildDb` helper's `existingAssignedIds` maps to `{ profile_id }` rows. Extend it: accept `existingAssigned = []` of `{ profile_id, status }` objects (keep `existingAssignedIds` working by mapping to `status: 'scheduled'`). Then add:

```js
describe('POST — cancelled tombstones', () => {
  it('lets a coach whose earlier assignment was cancelled be assigned again, and does not count the tombstone toward capacity', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 1, start_time: null, end_time: null, roster_id: null, rosters: null, shift_assignments: [{ count: 1 }] },
      existingAssigned: [{ profile_id: '11111111-1111-1111-1111-111111111111', status: 'cancelled' }],
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ profile_id: '11111111-1111-1111-1111-111111111111' }), PROPS)
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run "src/app/api/schedule/blocks/[id]/assignments/route.test.js"`
Expected: FAIL with 409 (already_assigned) or at_capacity.

- [ ] **Step 3: Implement**

In the route:
- Change the block select to drop `shift_assignments(count)` and instead read live rows once: change the "Who's already on this block?" query to `.select('id, profile_id, status')`.
- Compute:
```js
  const liveExisting = liveAssignments(existingAssigns)
  const alreadyAssignedIds = new Set(liveExisting.map((a) => a.profile_id))
  const cancelledByProfile = new Map((existingAssigns || []).filter((a) => !isLiveAssignment(a)).map((a) => [a.profile_id, a.id]))
  let runningCount = liveExisting.length
```
- In the loop, before the insert: if `cancelledByProfile.has(profileId)`, delete that tombstone first so the unique key doesn't fire:
```js
    const tombstoneId = cancelledByProfile.get(profileId)
    if (tombstoneId) await db.from('shift_assignments').delete().eq('id', tombstoneId)
```
- Replace the legacy at-capacity message's `currentCount` with `liveExisting.length`.
- Import `{ isLiveAssignment, liveAssignments } from '@/lib/roster'`.
- Update `buildDb` in the test so `shift_assignments.delete()` returns `{ eq: () => Promise.resolve({ error: null }) }`.

`report-generator.js` `fetchScheduledShiftRows`: filter the mapped rows with `isLiveAssignment` (import from `./roster`). Add a test in `src/lib/report-generator.test.js` if one exists for `fetchScheduledShiftRows`; otherwise add a minimal one mirroring the `makeDb` thenable pattern from `roster-read.test.js`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run "src/app/api/schedule/blocks/[id]/assignments" src/lib/report-generator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/app/api/schedule/blocks src/lib/report-generator.js src/lib/report-generator.test.js
git commit -m "ROSTER-FIX.1e — single-assign capacity + reports use live assignments; tombstones are cleared on re-assign"
```

### Task 1.6: `approved_drop` deletes the assignment (D4)

**Files:**
- Modify: `src/lib/swap-lifecycle.js:141-144`
- Modify: `src/app/api/schedule/swaps/[id]/route.js:50-54`
- Test: `src/lib/swap-lifecycle.test.js`

- [ ] **Step 1: Write the failing test**

Find the existing `approved_drop` test in `swap-lifecycle.test.js` (search `approved_drop`). Change its `assignmentOps` assertion to:

```js
    expect(r.assignmentOps).toEqual([{ id: 'asg-req', delete: true }])
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/swap-lifecycle.test.js`
Expected: FAIL (received `set: { status: 'cancelled' }`).

- [ ] **Step 3: Implement**

`swap-lifecycle.js`:
```js
    // ROSTER-FIX.1 (D4) — a dropped shift is DELETED, not tombstoned. A
    // `cancelled` row kept the block looking staffed, billed the coach's
    // hours, and blocked re-adding them via the (block, profile) unique key.
    return { ok: true, status: 200, effect: 'approved_drop', swapUpdates,
      assignmentOps: [{ id: swap.requester_shift_id, delete: true }],
      notify: [{ kind: 'decision_for_requester', to: [swap.requester_id] }] }
```

`swaps/[id]/route.js`, replace the assignment-ops loop:
```js
  for (const op of decision.assignmentOps) {
    const q = op.delete
      ? db.from('shift_assignments').delete().eq('id', op.id)
      : db.from('shift_assignments').update(op.set).eq('id', op.id)
    const { error: opErr } = await q
    if (opErr) return NextResponse.json({ success: false, error: opErr.message }, { status: 400 })
  }
```

Note: `shift_swap_requests.requester_shift_id` FKs `shift_assignments(id) ON DELETE CASCADE` (mig 237). Deleting the assignment would cascade-delete the swap row we are about to update. So **order matters**: update the swap row first, then apply ops, and for the drop case accept that the swap row disappears. Change the route to: (1) update swap row, capture `data`; (2) apply ops; (3) return `data`. Add a comment citing mig 237. PR 8 replaces the CASCADE with `ON DELETE SET NULL` + keeps history; until then this is the correct order.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/swap-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/swap-lifecycle.js src/app/api/schedule/swaps/[id]/route.js src/lib/swap-lifecycle.test.js
git commit -m "ROSTER-FIX.1f — approved swap-drop deletes the assignment instead of tombstoning it"
```

### Task 1.7: web calendar counts live assignments only

**Files:**
- Modify: `src/components/ScheduleCalendar.jsx:106-114, 119-143, 925-926, 1064-1071`

- [ ] **Step 1: Replace the local helper**

Delete the local `isBlockUnstaffedFuture` (lines 106-114) and `import { isBlockUnstaffedFuture as libUnstaffed, liveAssignments } from '@/lib/roster'`; define:
```js
function isBlockUnstaffedFuture(block, todayStr) {
  return libUnstaffed(block, liveAssignments(block.shift_assignments).length, todayStr)
}
```
(`libUnstaffed(block, count, now)` accepts an ISO string for `now`.)

- [ ] **Step 2: Live counts**

At line ~1065 change `const assignments = block.shift_assignments || []` to `const assignments = liveAssignments(block.shift_assignments)`. In `flattenBlocksToShifts` (line ~125) iterate `liveAssignments(block.shift_assignments)`. At line ~925 (month assignment count) use `liveAssignments(b.shift_assignments).length`.

- [ ] **Step 3: Run the existing suite + build**

Run: `npx vitest run src/components/ScheduleTabs "src/app/(team)/schedule"` then `npm run build`.
Expected: PASS, build green.

- [ ] **Step 4: Commit**

```bash
git add src/components/ScheduleCalendar.jsx
git commit -m "ROSTER-FIX.1g — calendar capacity, unstaffed marker and roll-ups count live assignments only"
```

### Task 1.8: mobile day list sort + AdjustSheet block default

**Files:**
- Modify: `mobile/app/(staff)/(tabs)/schedule.jsx:397-399, 632-671`
- Modify: `src/lib/roster-read.js` (`toApiShiftRow`) — expose block times
- Test: `src/lib/roster-read.test.js`, `mobile/lib/schedule-team.test.js`

- [ ] **Step 1: Write the failing lib test**

In `roster-read.test.js` `fetchApiShiftRows` second test, replace `expect(rows[0].start_time).toBeUndefined()` with:
```js
    // ROSTER-FIX.1 — block times ride along so mobile can sort the day list
    // and show the TRUE block default in AdjustSheet (not the template's).
    expect(rows[0].block_start_time).toBe('09:00:00')
    expect(rows[0].block_end_time).toBe('10:00:00')
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/roster-read.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `toApiShiftRow` add `block_start_time: b.start_time ?? null, block_end_time: b.end_time ?? null,` after `shift_date`.

In `schedule.jsx`:
- Sort: replace `(a.start_time || '').localeCompare(b.start_time || '')` with `(effShiftStart(a) || '').localeCompare(effShiftStart(b) || '')` (already imported from `../../../lib/schedule-team`).
- AdjustSheet (around lines 632-647): change `blockStart`/`blockEnd` derivation to prefer `shift.block_start_time || shift.shift_templates?.start_time` and `shift.block_end_time || shift.shift_templates?.end_time`. Leave the `start === blockStart ? null : start` logic as is — it is now comparing against the right default.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/roster-read.test.js mobile/lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-read.js src/lib/roster-read.test.js "mobile/app/(staff)/(tabs)/schedule.jsx"
git commit -m "ROSTER-FIX.1h — mobile day list sorts on effective start; AdjustSheet compares to the block default"
```

### Task 1.9: PR 1 gate

- [ ] Run `npx vitest run` (full) — expected all green (baseline 9,7xx).
- [ ] Run `npm run build` — expected green.
- [ ] `npx expo export --platform ios` from `mobile/` — expected success (OTA-safe: JS only).
- [ ] Open PR titled `ROSTER-FIX.1 — read-side truth: published derives from the roster, cancelled assignments never count` with the audit's T1-0/T1-1 text as the body. Add a `docs/CHANGELOG.md` row (append only; never edit a pushed row).
- [ ] After merge: OTA publish at 100% (memory `mobile-ota-paused`: a partial rollout blocks the next publish).

---

# PR 2 — ROSTER-FIX.2: tenancy + swap validation

Branch: `roster-fix-2-tenancy`. Worktree: `~/code/un1t-crm-rfix2`.

### Task 2.1: swap POST validates the target side

**Files:**
- Modify: `src/app/api/schedule/swaps/route.js:96-125`
- Create: `src/app/api/schedule/swaps/route.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/schedule/swaps/route.test.js` using the mock pattern from `blocks/[id]/assignments/route.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null), getUserLocationIds: vi.fn(() => ['loc-1']) }))
vi.mock('@/lib/push-dedup', () => ({ sendPushOnce: vi.fn(() => Promise.resolve()), sendPushToRolesAtLocationOnce: vi.fn(() => Promise.resolve()) }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { POST } = await import('./route.js')

const U = (id) => `${id.padEnd(8, '0')}-0000-4000-8000-000000000000`
const REQ = U('req1'), TGT = U('tgt1'), A_REQ = U('areq'), A_TGT = U('atgt'), LOC = U('loc1')

function req(body) { return { json: () => Promise.resolve(body), headers: { get: () => '' } } }

// assignmentsById: id → { id, profile_id, status, block_date, location_id, requester? }
function buildDb({ assignmentsById, openSwaps = [], insertErr = null }) {
  const insertSpy = vi.fn()
  const db = {
    from: (table) => {
      if (table === 'shift_assignments') {
        return {
          select: () => {
            const chain = { _id: null, _profile: null }
            chain.eq = (col, val) => { if (col === 'id') chain._id = val; if (col === 'profile_id') chain._profile = val; return chain }
            chain.single = () => {
              const a = assignmentsById[chain._id]
              const ok = a && (!chain._profile || a.profile_id === chain._profile)
              return Promise.resolve({ data: ok ? { id: a.id, profile_id: a.profile_id, status: a.status, shift_blocks: { location_id: a.location_id, block_date: a.block_date, rosters: { status: a.roster_status ?? 'published' } } } : null, error: ok ? null : { message: 'no' } })
            }
            chain.maybeSingle = chain.single
            return chain
          },
        }
      }
      if (table === 'shift_swap_requests') {
        return {
          select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: openSwaps, error: null }) }) }),
          insert: (row) => { insertSpy(row); return { select: () => ({ single: () => Promise.resolve({ data: insertErr ? null : { id: 'swap-1', ...row }, error: insertErr }) }) } },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, insertSpy }
}

const future = '2099-01-01'
const base = {
  [A_REQ]: { id: A_REQ, profile_id: REQ, status: 'scheduled', location_id: LOC, block_date: future },
  [A_TGT]: { id: A_TGT, profile_id: TGT, status: 'scheduled', location_id: LOC, block_date: future },
}

beforeEach(() => { createServerClient.mockReset(); getCurrentUser.mockReset() })

describe('POST /api/schedule/swaps — target validation', () => {
  it('201 for a valid reciprocal swap', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db, insertSpy } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ, target_shift_id: A_TGT, target_id: TGT }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })

  it('400 when target_shift_id does not belong to target_id', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db, insertSpy } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ, target_shift_id: A_TGT, target_id: U('other') }))
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('400 when target_shift_id is given without target_id', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ, target_shift_id: A_TGT }))
    expect(res.status).toBe(400)
  })

  it('400 when the target shift is at another location', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: { ...base, [A_TGT]: { ...base[A_TGT], location_id: U('loc2') } } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ, target_shift_id: A_TGT, target_id: TGT }))
    expect(res.status).toBe(400)
  })

  it('400 when the requester shift is not published (D1 — coaches cannot act on drafts)', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: { ...base, [A_REQ]: { ...base[A_REQ], roster_status: 'draft' } } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(400)
  })

  it('400 when the requester shift is in the past', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: { ...base, [A_REQ]: { ...base[A_REQ], block_date: '2000-01-01' } } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(400)
  })

  it('409 when the requester shift already has an open swap', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base, openSwaps: [{ id: 'existing' }] })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(409)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/schedule/swaps/route.test.js`
Expected: the first test may pass; the four 400s and the 409 FAIL (route returns 201).

- [ ] **Step 3: Implement**

In `swaps/route.js` POST, after the requester assignment lookup (extend its select to `'id, profile_id, status, shift_blocks!block_id(location_id, block_date, rosters:roster_id(status))'`), insert:

```js
  import { dublinTodayStr } from '@/lib/dublin-time'   // add to the top imports

  // ROSTER-FIX.2 — the requester's shift must be live, published (D1: a
  // coach never acts on a draft) and in the future.
  if (!isLiveAssignment(assignment)) {
    return NextResponse.json({ success: false, error: 'That shift is no longer active' }, { status: 400 })
  }
  if (assignment.shift_blocks?.rosters?.status !== 'published') {
    return NextResponse.json({ success: false, error: 'That shift is not published yet' }, { status: 400 })
  }
  if ((assignment.shift_blocks?.block_date || '') < dublinTodayStr()) {
    return NextResponse.json({ success: false, error: 'You can only swap a future shift' }, { status: 400 })
  }

  // ROSTER-FIX.2 — a reciprocal swap must name BOTH the target coach and one
  // of their own live shifts at this location. Previously target_shift_id
  // was inserted unchecked, so any assignment in the database could be
  // named and, on approval, reassigned to the requester.
  if (body.target_shift_id && !body.target_id) {
    return NextResponse.json({ success: false, error: 'target_id is required with target_shift_id' }, { status: 400 })
  }
  if (body.target_shift_id) {
    const { data: targetShift } = await db.from('shift_assignments')
      .select('id, profile_id, status, shift_blocks!block_id(location_id, block_date)')
      .eq('id', body.target_shift_id)
      .eq('profile_id', body.target_id)
      .maybeSingle()
    if (!targetShift || !isLiveAssignment(targetShift)) {
      return NextResponse.json({ success: false, error: 'Target shift not found or not theirs' }, { status: 400 })
    }
    if (targetShift.shift_blocks?.location_id !== swapLocationId) {
      return NextResponse.json({ success: false, error: 'Target shift is at a different location' }, { status: 400 })
    }
    if ((targetShift.shift_blocks?.block_date || '') < dublinTodayStr()) {
      return NextResponse.json({ success: false, error: 'Target shift is in the past' }, { status: 400 })
    }
  }

  // ROSTER-FIX.2 — one open swap per shift (mig 599 also enforces this).
  const { data: openSwaps } = await db.from('shift_swap_requests')
    .select('id')
    .eq('requester_shift_id', body.requester_shift_id)
    .in('status', ['pending', 'awaiting_approval'])
  if ((openSwaps || []).length > 0) {
    return NextResponse.json({ success: false, error: 'This shift already has an open swap request' }, { status: 409 })
  }
```
Import `isLiveAssignment` from `@/lib/roster`. Move the `swapLocationId` computation above this block (it already is). Handle the insert `23505` code with the same 409 message.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/app/api/schedule/swaps/route.test.js`
Expected: PASS (6).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/swaps/route.js src/app/api/schedule/swaps/route.test.js
git commit -m "ROSTER-FIX.2a — swap POST validates target ownership, location, future date and single open swap"
```

### Task 2.2: migration 599 — swap status CHECK + one-open-swap index

**Files:**
- Create: `supabase/migrations/599_swap_requests_status_check.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ROSTER-FIX.2 — shift_swap_requests.status had no CHECK while the lifecycle
-- (src/lib/swap-lifecycle.js) uses five states; and nothing stopped two open
-- swaps on the same shift. Both enforced here.
ALTER TABLE public.shift_swap_requests
  DROP CONSTRAINT IF EXISTS shift_swap_requests_status_check;
ALTER TABLE public.shift_swap_requests
  ADD CONSTRAINT shift_swap_requests_status_check
  CHECK (status IN ('pending', 'awaiting_approval', 'approved', 'rejected', 'cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS shift_swap_requests_one_open_per_shift
  ON public.shift_swap_requests (requester_shift_id)
  WHERE status IN ('pending', 'awaiting_approval');
```

- [ ] **Step 2: Pre-check live data before applying** (execute_sql, read-only):
```sql
SELECT status, count(*) FROM shift_swap_requests GROUP BY 1;
SELECT requester_shift_id, count(*) FROM shift_swap_requests WHERE status IN ('pending','awaiting_approval') GROUP BY 1 HAVING count(*) > 1;
```
Expected: only the five statuses; zero duplicate rows. If either fails, fix data by hand (cancel the older duplicate) before applying.

- [ ] **Step 3: Commit** (apply after the code deploys, per memory `supabase-migrations-via-mcp`):
```bash
git add supabase/migrations/599_swap_requests_status_check.sql
git commit -m "mig 599 — swap status CHECK + one open swap per shift"
```

### Task 2.3: allowances scoped to the caller's locations

**Files:**
- Modify: `src/app/api/schedule/allowances/route.js`
- Create: `src/app/api/schedule/allowances/route.test.js`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), getUserLocationIds: vi.fn(() => ['loc-1']) }))
const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET, PUT } = await import('./route.js')

const PID = '11111111-1111-4111-8111-111111111111'
function req(body, url = 'http://x/api/schedule/allowances') {
  return { url, json: () => Promise.resolve(body), headers: { get: () => '' } }
}
// links: which locations PID belongs to. existing: current allowance row or null.
function buildDb({ links = ['loc-1'], existing = null }) {
  const upsertSpy = vi.fn()
  const db = {
    from: (t) => {
      if (t === 'profile_locations') return { select: () => ({ eq: () => Promise.resolve({ data: links.map((l) => ({ location_id: l })), error: null }) }) }
      if (t === 'staff_allowances') return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: existing, error: null }) }) }) }),
        upsert: (row) => { upsertSpy(row); return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) } },
      }
      throw new Error(t)
    },
  }
  return { db, upsertSpy }
}
beforeEach(() => { createServerClient.mockReset(); getCurrentUser.mockReset() })

describe('allowances tenancy', () => {
  it('GET 404 when the profile is not at any of the caller\'s locations', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr', role: 'manager' })
    createServerClient.mockReturnValue(buildDb({ links: ['loc-9'] }).db)
    const res = await GET(req(null, `http://x/api/schedule/allowances?profile_id=${PID}&year=2026`))
    expect(res.status).toBe(404)
  })
  it('PUT 404 for a profile outside the caller\'s locations', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr', role: 'manager' })
    const { db, upsertSpy } = buildDb({ links: ['loc-9'] })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ profile_id: PID, year: 2026, total_days: 25 }))
    expect(res.status).toBe(404)
    expect(upsertSpy).not.toHaveBeenCalled()
  })
  it('PUT lets master and head_coach set an allowance', async () => {
    for (const role of ['master', 'head_coach']) {
      getCurrentUser.mockResolvedValue({ id: 'u', role })
      createServerClient.mockReturnValue(buildDb({}).db)
      const res = await PUT(req({ profile_id: PID, year: 2026, total_days: 25 }))
      expect(res.status).toBe(200)
    }
  })
  it('PUT with only carried_over keeps the existing total_days', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr', role: 'manager' })
    const { db, upsertSpy } = buildDb({ existing: { profile_id: PID, year: 2026, total_days: 25, carried_over: 0, used_days: 3 } })
    createServerClient.mockReturnValue(db)
    await PUT(req({ profile_id: PID, year: 2026, carried_over: 2 }))
    expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({ total_days: 25, carried_over: 2 }))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/schedule/allowances/route.test.js`
Expected: FAIL (200s / 403 / total_days 20).

- [ ] **Step 3: Implement**

Rewrite `allowances/route.js`:
- Add a local helper:
```js
// ROSTER-FIX.2 — a profile is in scope when it shares a location with the
// caller (master = everywhere). Detail-style 404 on miss so a cross-tenant
// id is indistinguishable from a missing one.
async function profileInScope(db, user, profileId) {
  if (user.role === 'master') return true
  const { data } = await db.from('profile_locations').select('location_id').eq('profile_id', profileId)
  const mine = new Set(getUserLocationIds(user))
  return (data || []).some((l) => mine.has(l.location_id))
}
```
- GET: after the self/manager check, `if (profileId !== user.id && !(await profileInScope(db, user, profileId))) return 404 'Not found'`. Replace `.single()` + PGRST116 handling with `.maybeSingle()`.
- PUT: gate on `MANAGER_ROLES.includes(user.role)` (import from `@/lib/schemas`) instead of `['owner','manager']`; scope check → 404; then read the existing row with `.maybeSingle()` and upsert `{ profile_id, year, total_days: total_days ?? existing?.total_days ?? 20, carried_over: carried_over ?? existing?.carried_over ?? 0, updated_at }`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/app/api/schedule/allowances/route.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/app/api/schedule/allowances/
git commit -m "ROSTER-FIX.2b — allowances scoped to the caller's locations; MANAGER_ROLES may set; partial PUT preserves total_days"
```

### Task 2.4: time-off route gates

**Files:**
- Modify: `src/app/api/schedule/time-off/[id]/route.js:35-57`
- Modify: `src/app/api/schedule/time-off/route.js:59-64`
- Create: `src/app/api/schedule/time-off/[id]/route.test.js`

- [ ] **Step 1: Write the failing tests** (same mock style; `hasPermissionForLocation` mocked from `@/lib/permissions`):

```js
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@shared/permissions', () => ({ APPROVAL_CATEGORY_PERMISSION: { time_off: 'approvals_time_off' } }))
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn(() => Promise.resolve()) }))
```
Tests:
1. `manager at another location cannot cancel` — user `{ id:'m', role:'manager' }`, `getUserLocationIds → ['loc-1']`, existing `{ profile_id:'c', location_id:'loc-2', status:'pending' }`, body `{ status:'cancelled' }` → expect 404.
2. `a manager cannot approve their own request` — user `{ id:'c', role:'manager' }`, existing `{ profile_id:'c', location_id:'loc-1', status:'pending' }`, body `{ status:'approved' }` → expect 403 and update spy not called.
3. `a coach may cancel their own pending request` → 200.
4. `a coach may not cancel an approved request` → 403.

- [ ] **Step 2: Run to verify failure** — expected FAILs on 1 and 2.

- [ ] **Step 3: Implement** in `time-off/[id]/route.js`, replacing the authorisation block:

```js
  const isSelf = user.id === existing.profile_id
  const isManager = MANAGER_ROLES.includes(user.role)
  const atLocation = user.role === 'master' || getUserLocationIds(user).includes(existing.location_id)

  // ROSTER-FIX.2 — a manager acts only on their own locations (404 so a
  // cross-tenant id looks missing); a requester acts only on their own
  // pending request, and only to cancel; nobody decides their own leave.
  if (!isSelf && (!isManager || !atLocation)) {
    return NextResponse.json({ success: false, error: 'Request not found' }, { status: 404 })
  }
  if (isSelf && (status === 'approved' || status === 'rejected')) {
    return NextResponse.json({ success: false, error: 'You cannot decide your own time-off request' }, { status: 403 })
  }
  if (isSelf && !isManager && (status !== 'cancelled' || existing.status !== 'pending')) {
    return NextResponse.json({ success: false, error: 'You can only cancel your own pending requests' }, { status: 403 })
  }
```
Import `getUserLocationIds` from `@/lib/auth`. Keep the existing `hasPermissionForLocation` gate for approve/reject.

In `time-off/route.js` GET, replace `if (['staff'].includes(user.role))` with `if (!MANAGER_ROLES.includes(user.role))` (import from `@/lib/schemas`) so `reception` sees only its own.

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**
```bash
git add src/app/api/schedule/time-off/
git commit -m "ROSTER-FIX.2c — time-off: location-gated cancel, no self-approval, non-managers see only their own"
```

### Task 2.4b: time-off request integrity

**Files:**
- Modify: `src/app/api/schedule/time-off/route.js:79-123` (POST)
- Create: `src/lib/time-off-days.js` + `src/lib/time-off-days.test.js`
- Create: `src/app/api/schedule/time-off/route.test.js`

- [ ] **Step 1: Pure helper tests** (`time-off-days.test.js`):

```js
import { describe, it, expect } from 'vitest'
import { countLeaveDays, splitAtYearEnd, rangesOverlap } from './time-off-days'

describe('countLeaveDays', () => {
  it('counts Mon-Fri only for holiday', () => {
    // 2026-06-01 (Mon) → 2026-06-07 (Sun) = 5 working days
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-07')).toBe(5)
  })
  it('counts every calendar day for non-holiday types', () => {
    expect(countLeaveDays('sick', '2026-06-01', '2026-06-07')).toBe(7)
  })
  it('a weekend-only holiday is 0 days', () => {
    expect(countLeaveDays('holiday', '2026-06-06', '2026-06-07')).toBe(0)
  })
})
describe('splitAtYearEnd', () => {
  it('returns one range inside a year', () => {
    expect(splitAtYearEnd('2026-06-01', '2026-06-03')).toEqual([['2026-06-01', '2026-06-03']])
  })
  it('splits a range straddling 31 Dec', () => {
    expect(splitAtYearEnd('2026-12-30', '2027-01-02')).toEqual([['2026-12-30', '2026-12-31'], ['2027-01-01', '2027-01-02']])
  })
})
describe('rangesOverlap', () => {
  it('inclusive overlap', () => {
    expect(rangesOverlap('2026-06-01', '2026-06-03', '2026-06-03', '2026-06-05')).toBe(true)
    expect(rangesOverlap('2026-06-01', '2026-06-03', '2026-06-04', '2026-06-05')).toBe(false)
  })
})
```

- [ ] **Step 2: Run → FAIL (module missing).**

- [ ] **Step 3: Implement** `src/lib/time-off-days.js`:

```js
// ROSTER-FIX.2 — leave-day maths shared by the time-off POST.
// Holiday counts Mon-Fri only, matching leaveHoursInWeek's Mon-Fri
// contract convention in roster-summary.js; other types count calendar days.
function addDay(iso) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10)
}
export function countLeaveDays(type, startIso, endIso) {
  let n = 0
  for (let cur = startIso; cur <= endIso; cur = addDay(cur)) {
    const dow = new Date(cur + 'T00:00:00Z').getUTCDay()
    if (type !== 'holiday' || (dow >= 1 && dow <= 5)) n++
  }
  return n
}
export function splitAtYearEnd(startIso, endIso) {
  if (startIso.slice(0, 4) === endIso.slice(0, 4)) return [[startIso, endIso]]
  const y = startIso.slice(0, 4)
  return [[startIso, `${y}-12-31`], [`${Number(y) + 1}-01-01`, endIso]]
}
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd
}
```

- [ ] **Step 4: Route test** (`time-off/route.test.js`, same mock style): (a) POST overlapping an existing `pending` request of the same profile → 409; (b) POST holiday Mon-Sun inserts `total_days: 5`; (c) POST 30 Dec → 2 Jan inserts two rows and returns both.

- [ ] **Step 5: Implement in POST:** before the allowance check, query `time_off_requests` for `profile_id = user.id`, `status in ('pending','approved')`, `start_date <= end_date_new`, `end_date >= start_date_new`; if any → 409 `'Overlaps your existing request for <range>'`. Replace the inline `totalDays` with `countLeaveDays(type, start_date, end_date)` (reject `0` with 400 `'No working days in that range'`). Wrap the insert in `for (const [s, e] of splitAtYearEnd(start_date, end_date))`, computing days per segment; the allowance check runs per segment year. Return `{ success: true, data: rows[0], data_all: rows }` so existing clients keep `data`.

- [ ] **Step 6: Run → PASS. Commit** `ROSTER-FIX.2e — time-off: no overlapping requests, holiday counts working days, year-straddle splits`.

### Task 2.5: blocks GET role gate + coach picker pay leak

**Files:**
- Modify: `src/app/api/schedule/blocks/route.js:36-40`
- Modify: `mobile/lib/schedule-api.js:163` and `src/lib/staff.js` (see step)

- [ ] **Step 1 (revised after implementation — a 403 blanked the coach's read-only web calendar):** In `blocks/route.js` GET keep `assertLocationAccess` for everyone; embed `rosters:roster_id ( status )`; for non-`MANAGER_ROLES` callers return only blocks on a published roster (D1) in a slim shape with no `min_coaches` / `max_coaches` / block `notes`, no assignment `notes` / `partial_reason`, and no cancelled assignments. Managers get the full shape with drafts. `ScheduleCalendar.jsx` renders the `count / max` badge, the at-capacity state and the unstaffed marker only when `isManager`. Route test: staff → 200, published only, no capacity keys; manager → full.

- [ ] **Step 2:** Coach picker: read `src/lib/staff.js:1-40` to find how `/api/staff` picks the slim vs full select. Add a query flag `?fields=picker` to `GET /api/staff` that always returns `id, full_name, active, role, avatar_url, locations` regardless of role; switch `getLocationStaff` in `schedule-api.js` to call `/api/staff?fields=picker`. Add a test in the existing `src/app/api/staff/route.test.js` (if present) asserting `fields=picker` never returns `hourly_rate`/`annual_salary` for a master caller.

- [ ] **Step 3:** Run `npx vitest run src/app/api/schedule/blocks src/app/api/staff mobile/lib` → PASS. Commit:
```bash
git commit -am "ROSTER-FIX.2d — blocks GET is manager-gated; coach picker fetches a pay-free staff shape"
```

### Task 2.6: migration 600 — location-scoped RLS for leave, allowances, templates

**Files:**
- Create: `supabase/migrations/600_rostering_rls_location_scope.sql`

- [ ] **Step 1: Inspect the live policies first** (execute_sql):
```sql
SELECT tablename, policyname, cmd, permissive, qual FROM pg_policies
WHERE tablename IN ('time_off_requests','staff_allowances','shift_templates') ORDER BY 1,2;
```
Record the exact policy names; mig 320 defined them and used bare `DROP POLICY`, so names must match.

- [ ] **Step 2: Write the migration** (PERMISSIVE, per-command, never RESTRICTIVE FOR ALL — memory `rls-restrictive-for-all-kills-select`). Pattern from mig 320 / `advisor-rls-permissive-consolidation`:

```sql
-- ROSTER-FIX.2 — leave, allowances and templates were role-scoped globally:
-- a manager at one studio could read every studio's rows from the browser.
-- Routes use service-role and already fence in code (ROSTER-FIX.2b/2c);
-- this makes the browser-side fence match.

-- time_off_requests: own rows, or manager at the row's location.
DROP POLICY IF EXISTS "time_off_select" ON public.time_off_requests;      -- use the real names from step 1
CREATE POLICY time_off_select ON public.time_off_requests FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.auth_is_manager_at(location_id));
-- (repeat for UPDATE with the same qual; INSERT stays own-row)

-- staff_allowances has no location column: scope through profile_locations.
DROP POLICY IF EXISTS "Admins can view all allowances" ON public.staff_allowances;
CREATE POLICY staff_allowances_select_mgr ON public.staff_allowances FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = staff_allowances.profile_id
        AND public.auth_is_manager_at(pl.location_id)
    )
  );
-- (same qual for the manage policy)

-- shift_templates: readable only at the caller's locations.
DROP POLICY IF EXISTS "Anyone can view shift templates" ON public.shift_templates;
CREATE POLICY shift_templates_select ON public.shift_templates FOR SELECT TO authenticated
  USING (public.auth_at_location(location_id));
```
Confirm `auth_is_manager_at(uuid)` and `auth_at_location(uuid)` exist (`grep -rn 'auth_is_manager_at\|auth_at_location' supabase/migrations | head`); if the helper names differ, use the ones mig 320 uses.

- [ ] **Step 3:** After applying, run `get_advisors` (security) — expected no new WARN. Run `npm run test:cross-tenant` → PASS.

- [ ] **Step 4: Commit** `mig 600 — location-scoped RLS for time_off_requests, staff_allowances, shift_templates`.

### Task 2.7: PR 2 gate

- [ ] Full `npx vitest run`, `npm run build`, PR `ROSTER-FIX.2 — swap target validation; leave, allowances and templates scoped per location`. Deploy code first; then apply migs 599 and 600 via Supabase MCP; then advisors + cross-tenant suite.

---

# PR 3 — ROSTER-FIX.3: self-edit governance (D2, D3)

Branch `roster-fix-3-self-edit`.

- **Task 3.1 — assignment PUT and DELETE are manager-only (D2, D3).** `src/app/api/schedule/assignments/[id]/route.js`: in both handlers delete the `isSelf` branch; the gate becomes `if (!MANAGER_ROLES.includes(user.role)) return 403` with `error: 'Only a manager can change shift hours'` (PUT) / `'Ask for a swap to drop this shift'` (DELETE), then the existing per-location check (404 on a foreign location, matching the detail-route rule). Simplify the notify block: `wasManagerEdit` is always true now, so the coach is pushed on every override change. Update the header comment (`Coaches can edit/remove themselves…` is no longer true). New test file `assignments/[id]/route.test.js` (mock pattern from `blocks/[id]/assignments/route.test.js`): staff PUT own → 403, no update call; staff DELETE own → 403; manager PUT at location → 200 + coach pushed; manager elsewhere → 404; master anywhere → 200.
- **Task 3.2 — remove every coach-facing "Adjust time" affordance.** Web: `src/components/dashboard/MonthRoster.jsx` `ShiftActionMenu` (`:100-260`, `:313`, `:390+`) — delete the Adjust panel and the `handleClearOverride` path; the menu keeps "Post for swap" only. `src/components/ScheduleCalendar.jsx:1804` — `canEdit={isManager}` (both the Adjust button and the X). Mobile: `mobile/app/(staff)/(tabs)/schedule.jsx` — `canAdjust(shift)` (`:418`) returns `isManager` only (the manager can still adjust from the schedule tab; ManageMode's own adjust path at `ManageMode.jsx:86` is unchanged); the `AdjustSheet` (`:615-690`) stays for managers. `mobile/components/dashboard/PersonalDashboard.jsx:1000-1050` — delete the adjust handlers and the affordance that opens them (it is the coach's personal surface). `mobile/lib/schedule-api.js` `adjustShiftAssignment` stays (manager callers). Keep the amber "Adjusted" badge everywhere: coaches should still see when a manager changed their window. Tests: `mobile/lib/schedule-manage.test.js` or a new `schedule.canAdjust.test.js` pinning `canAdjust` false for `staff`/`reception`, true for `MANAGER_ROLES`; a `MonthRoster` render test asserting no "Adjust time" text for a coach.
- **Task 3.3 — coach-facing copy.** Anywhere the removed affordance was explained (`MonthRoster.jsx` header comment `:15-17`, `PersonalDashboard.jsx:1000`, `time-off-new.jsx:145`, the openapi entry for `PUT /api/schedule/assignments/{id}` in `src/lib/openapi.js`) now says hours are set by a manager; a coach who worked different hours tells their manager. Add a CHANGELOG row stating the policy so it is discoverable.
- **Task 3.4 — gate + PR.** OTA-safe (JS only). Note in the PR body: any existing self-set overrides in the database stay as they are (they are already in payroll history); managers can see them via the Adjusted badge and reset them.

---

# PR 4 — ROSTER-FIX.4: publish + approvals

Branch `roster-fix-4-publish`.

- **Task 4.1 — approvals page shows the real overrun and offers Reject (D5).** `src/app/(team)/schedule/approvals/page.js`: for each draft call `projectPublishImpact(db, { locationId, periodStart, periodEnd })` and render `impact.overrunEur` / `impact.monthProjectedTotalEur` (fall back to stored fields if it throws). New route `src/app/api/schedule/rosters/[id]/reject/route.js` (POST): same permission gate as approve; 409 unless `status === 'draft'`; DELETE the row; notify `created_by` via `notifyUsersOnce(db, \`roster_rejected:${id}\`, [roster.created_by], {...})`. `RosterApprovalActions.jsx`: add a Reject button with a `confirm()` and note prompt. Route test: reject a draft → 200 + delete spy; reject a published → 409; no permission → 403.
- **Task 4.2 — publish refuses an overlapping published roster.** In `rosters/route.js` POST before insert: `select id, period_start, period_end from rosters where location_id = ? and status='published' and period_start <= period_end_new and period_end >= period_start_new`. If any and the overlap is not an exact same-period re-publish, return 409 `overlapping_roster` with the rows; the modal shows "Week already published as part of <range>; re-publish that range instead". Exact same-period re-publish stays allowed (this is how re-notify works). Migration 601 adds a `btree_gist` exclusion constraint `EXCLUDE USING gist (location_id WITH =, daterange(period_start, period_end, '[]') WITH &&) WHERE (status = 'published')` **only after** a live-data check shows no existing overlaps (`SELECT a.id, b.id FROM rosters a JOIN rosters b ON a.location_id=b.location_id AND a.id<b.id AND a.status='published' AND b.status='published' AND daterange(a.period_start,a.period_end,'[]') && daterange(b.period_start,b.period_end,'[]')`). If overlaps exist, PR 4 ships the app check only and mig 601 waits for a data clean-up.
- **Task 4.3 — post-publish blocks join the roster.** In `generateBlocksForTemplate` (`roster.js`) and `bulkUpsertShiftAssignments` / `upsertShiftAssignment` (`roster-write.js`) and `POST /blocks`: after creating a block, look up a published roster covering `(location_id, block_date)` and set `roster_id` on the new block. Add `findPublishedRosterFor(db, locationId, dateIso)` in `roster.js` with a test. Then assignments to such blocks are change-logged normally.
- **Task 4.4 — template edits on published blocks are logged + notified.** In `templates/[id]/route.js`: (a) when propagating `start_time`/`end_time`, select the affected blocks with `roster_id, rosters:roster_id(status), shift_assignments(profile_id, status)` and `logRosterChange(action:'time_changed')` per live coach on published blocks; (b) when deleting blocks for removed weekdays, refuse (409, `blocks_have_assignments`) if any future block on a published roster still has live assignments, listing the dates — the operator unassigns first; (c) if `updates.active === false`, skip step 3 (regeneration) and delete future blocks with zero live assignments. Route test file exists (`templates/[id]/route.test.js`) — extend.
- **Task 4.5 — budget projection honours overrides and approved leave.** `roster-publish.js`: select `shift_assignments(profile_id, status, start_time_override, end_time_override)`; compute per-assignment hours via `shiftHours({ start_time_override, end_time_override, shift_templates: { start_time: block.start_time, end_time: block.end_time } })`; load approved `time_off_requests` for the month and skip assignments whose date falls inside a coach's approved leave. Tests in `roster-publish.test.js`.
- **Task 4.6 — gate + PR.**

---

# PR 5 — ROSTER-FIX.5: horizon cron + reports

Branch `roster-fix-5-horizon-reports`.

- **Task 5.1 — horizon cron.** Create `src/lib/roster-horizon.js` `export async function extendRosterHorizon(db, { weeks = 8 } = {})`: select `shift_templates` where `active = true` and `days_of_week <> '{}'`, call `generateBlocksForTemplate(db, tpl, getMonday(new Date()), weeks)` each, return `{ templates, inserted }`. Route `src/app/api/cron/extend-roster-horizon/route.js` modelled on `expand-hyrox-weeks/route.js` (CRON_SECRET, `stampHeartbeat('extend-roster-horizon')`). `vercel.json`: `{ "path": "/api/cron/extend-roster-horizon", "schedule": "20 3 * * *" }`. Sentinel: register the heartbeat name where the other daily crons are listed (grep `expand-hyrox-weeks` in `un1t-sentinel`). Test `roster-horizon.test.js` with the thenable mock. Remove the stale "lazy-extend" comment in `blocks/route.js:5-7`. Task 4.3's `findPublishedRosterFor` applies here too.
- **Task 5.2 — day-of-week off by one.** `ScheduleReporting.jsx`: keep `DAY_NAMES` Monday-first for display but map value with `const toJsDay = (i) => (i + 1) % 7` and `const fromJsDay = (d) => (d + 6) % 7`; `<option value={toJsDay(i)}>`, `DAY_NAMES[fromJsDay(sr.day_of_week)]`, initial state `setDayOfWeek(1)`. Add `src/lib/report-schedule-days.js` exporting the two functions + tests so the mapping is pinned.
- **Task 5.3 — `daily` + `fortnightly` next run.** `calculateNextRun`: add `if (frequency === 'daily') { target = tomorrow 07:00; return }`; fix fortnightly to `+ diff + 14 - 7`? No: next same weekday is `diff` days away; a fortnight from the *last* run is `diff + 7` only if the last run was that weekday. Simplest correct: `diff + 7` when `diff === 7` (today is the day) else `diff + 7`... Replace with: `const next = diff === 0 ? 7 : diff; target.setDate(target.getDate() + next + 7)`. Write the tests with a fixed `now` via `vi.setSystemTime`. Also `calculatePeriodForSchedule('daily')` → yesterday only.
- **Task 5.4 — reports honour overrides + location scope.** `report-generator.js` `staff_hours` and `utilisation`: use `shiftHours(shift)` from `payroll.js` (already override-aware) instead of the inline template math; `utilisation` and `staff_cost` profile queries: restrict to profiles linked to `location_id` via `profile_locations` (one extra query, `.in('id', profileIds)`). Tests in `report-generator.test.js`.
- **Task 5.5 — gate + PR.**

---

# PR 6 — ROSTER-FIX.6: web UI hygiene (three PRs)

**6a data + errors** (`roster-fix-6a-data`)
- Create `src/components/schedule/useScheduleData.js`: owns `blocks/templates/staff/timeOff/rosters/overview` state, a `generation` ref so only the latest request writes state, `try/catch` around `Promise.all` that sets `error` and always clears `loading`, and `refresh()`. `ScheduleCalendar.jsx:313-362` calls it. Every mutation handler (`:429, :467, :508, :555, :601, :628, :651, :1228, :1236`) wrapped: `try { const res = await fetch(...); const data = await res.json().catch(() => ({})); if (!res.ok || !data.success) { showToast(data.error || 'Request failed'); return } } catch { showToast('Network error') }`. Same treatment for `TimeOffManager.jsx:66-135, 340-352`, `ShiftTemplateManager.jsx:44-68, 87, 193-198`, `SwapRequestsManager.jsx:75-98`, `ScheduleReporting.jsx:53-84, 460-475`, `RosterApprovalActions.jsx:21`. Add `busy` guards on unassign/delete-block/approve/reject/cancel/template delete; move `setCopying(false)` into `finally`. Dirty flag keyed by period: `dirtyPeriods: Set<'YYYY-MM-DD..YYYY-MM-DD'>`, cleared per published period and on location change. Fix month↔week toggle: `Month` button uses `getMonthStart(addDays(weekStart, 3))` (mid-week date) and `Week` uses `getMonday(monthStart)` only when `weekStart` isn't already inside the month. `ScheduleReporting.getDefaultDates` → `formatDate` from `@/lib/roster`. Component tests with `@testing-library/react` for the hook (error path, generation guard) and the toggle.

**6b modals + a11y** (`roster-fix-6b-a11y`)
- Replace the eight bespoke overlays with `src/components/ui/Modal.jsx` (already used by `MonthRoster`). `aria-label` on week/month arrows, close buttons, swap/remove icons. Block cards: `role="button" tabIndex={0} onKeyDown={Enter/Space → onClick}`. Unstaffed month cell: add a visually-hidden "Unstaffed" text and an icon, not colour alone. Override marker `●` → `<span aria-label="Adjusted hours">`. Grids: `grid-cols-7` stays but wrap in `overflow-x-auto min-w-[840px]` on `<md`; Reporting/TimeOff summary grids `grid-cols-2 md:grid-cols-4/5`. Memory `jsdom-cannot-see-layout`: verify the overflow in a browser preview, not just tests.

**6c dedupe + server money** (`roster-fix-6c-dedupe`)
- Delete `getMonday/addDays/formatDate/formatTime/isBlockUnstaffedFuture/flattenBlocksToShifts` locals in `ScheduleCalendar.jsx`, `ShiftTemplateManager.jsx`, `SwapRequestsManager.jsx`, `MonthRoster.jsx`; import from `@/lib/roster`, `@/lib/roster-summary` (export `blocksToShiftRows`), `@/lib/payroll`, `@/lib/schedule-overlap` (`fmtTime`). `AssignCoachModal`: use `timeRangesOverlap` + `timeOff` state to badge "clashes 09:30 Hatch" / "on leave". FTE overtime panel: new `GET /api/schedule/week-cost?location_id&week_start` (MANAGER_ROLES) returning `computeWeeklyCost` per coach with **no rates in the payload** (only hours + status + cost totals); `ScheduleCalendar.jsx:841-890` consumes it; `/api/staff` slim shape stops carrying pay fields for non-admin roles (already true) and the calendar stops needing them. Split `ScheduleCalendar.jsx` at the seams listed in the audit into `src/components/schedule/{MonthGrid,WeekGrid,BulkBar,PublishModal,BlockDetailModal,AssignCoachModal,OvertimePanel}.jsx`; no behaviour change, snapshot-free tests per piece for render + one interaction.

---

# PR 7 — ROSTER-FIX.7: mobile hygiene

Branch `roster-fix-7-mobile`. All OTA-safe.

- **7.1** `schedule.jsx:341, :358-359`: honour `res.transport` — on transport failure keep the last-good `shifts`/`timeOff` and set `error` to the copy `Couldn't refresh — showing the last loaded week`; on a real API failure show `res.error`. Time-off failure sets `error` too. Manage view early-return (`:331`) clears `shifts` explicitly.
- **7.2** `ManageMode.jsx:44-50`: key the staff cache on `locationId` (`useEffect(() => { setStaff(null) }, [locationId])`) and refetch after each assign/remove.
- **7.3** Dublin today: `mobile/lib/dates.js` add `dublinTodayIso()` using `Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', ... })`; use it at `schedule.jsx:544` and `time-off-new.jsx:29`. Tests under `TZ=America/New_York` and `TZ=Europe/Dublin` (add both to `mobile/package.json` test script the way CLAUDE.md asks).
- **7.4** Copy: `ManageMode.jsx:1-2` comment, `time-off-new.jsx:145` hint → point at the Approvals screen; add a "Cancel request" affordance on the coach's own pending time-off rows in the schedule list (calls `respondToTimeOff(id, 'cancelled')`).
- **7.5** Tests: `mobile/lib/schedule-api.test.js` pinning every request path + body; `dates.test.js` for `weekStart`, `isoDate`, `dublinTodayIso`.

---

# PR 8 — ROSTER-FIX.8: schema hardening

Branch `roster-fix-8-schema`. Code-free except the swap route's 23505 handling.

- **8.1 mig 602** — indexes: `CREATE INDEX IF NOT EXISTS shift_assignments_profile_block_idx ON shift_assignments (profile_id, block_id); CREATE INDEX IF NOT EXISTS time_off_requests_profile_dates_idx ON time_off_requests (profile_id, start_date, end_date); CREATE INDEX IF NOT EXISTS time_off_requests_location_status_start_idx ON time_off_requests (location_id, status, start_date);`. Restore `schedule_notifications.shift_id` → `REFERENCES shift_assignments(id) ON DELETE SET NULL` after `UPDATE schedule_notifications SET shift_id = NULL WHERE shift_id NOT IN (SELECT id FROM shift_assignments)`. Change `shift_swap_requests.requester_shift_id` FK from `ON DELETE CASCADE` to `ON DELETE SET NULL` and make the column nullable, so an approved-drop keeps its history row (then revert the ordering note in Task 1.6 to "either order").
- **8.2 mig 603** — per-coach overlap guard: `CREATE EXTENSION IF NOT EXISTS btree_gist;` then a trigger (not an exclusion constraint — the time range lives on the block, not the assignment) `BEFORE INSERT OR UPDATE ON shift_assignments` that raises `overlapping_shift` when another live assignment for the same `profile_id` on the same `block_date` overlaps `[start_time, end_time)` **and** the session variable `app.allow_overlap` is not `'on'`. Routes keep the advisory warning and, on `overlapping_shift`, return 409 with the warning text unless `allow_overlap: true` is in the body (sets the GUC via `set_config` in the same request, or simpler: the trigger is `ENABLE ALWAYS` and routes catch the error code and retry with a `SET LOCAL` RPC). Decide the mechanism in the PR after checking how other routes pass GUCs (grep `set_config` in `src/`); if none do, ship the trigger as advisory-only (log, don't raise) and revisit. Data pre-check for existing overlaps first.
  - **Shipped as mig 604, ADVISORY-ONLY (ROSTER-FIX.8b).** Migration numbers shifted: 602 is PR 4's, so 8.1 is mig 603, 8.2 is mig 604, 8.3 is mig 605. `grep -rn "set_config\|SET LOCAL\|app\." src/lib src/app/api` returns NOTHING — there is no pattern anywhere in this codebase for a route to pass a GUC to Postgres, and over PostgREST each statement is its own implicit transaction so a `SET LOCAL` from a separate call would not reach the write. **The raise is therefore deferred until a GUC-passing pattern exists** (an RPC that sets `app.allow_overlap` and performs the write in one statement is the obvious shape). The trigger `RAISE WARNING`s instead, so nothing is refused and no route changes: arming a hard stop with no escape hatch would make a legitimate deliberate overlap (a cover handover, a 15-minute tail) un-saveable. `app.allow_overlap` is already wired, so arming it is `RAISE WARNING` → `RAISE EXCEPTION` (bare = SQLSTATE 'P0001') plus the route work. No `btree_gist`: nothing uses it. Trigger is `BEFORE INSERT OR UPDATE OF block_id, profile_id, status` — it does NOT fire on an override-only edit, which is documented in the migration header as a deliberate gap.
- **8.3** Replay hazards: new migration files must not edit old ones (forward-only), so add `604_replay_guards.sql` that is a no-op on prod but documents, for a fresh replay, `ALTER TABLE shift_blocks DROP CONSTRAINT IF EXISTS ...; ADD ... CHECK (min_coaches <= max_coaches) NOT VALID; VALIDATE` and `CREATE POLICY IF NOT EXISTS`-style guards; **and** open a `docs/migrations-replay.md` note listing mig 177 + 320 as needing hand edits on a fresh database. (Editing historical files is out; documenting the trap is in.)
- **8.4** Swap notifications get email fallback: `swaps/route.js` and `swaps/[id]/route.js` switch `sendPushOnce` → `notifyUsersOnce` with `emailSubject`, matching time-off; add `swap` to the fallback-email categories in `notifications-registry` (grep `fallbackEmail`). Open-pool swaps also notify eligible coaches on that date (`shift_assignments` at the location on `block_date`, excluding the requester) with `notifyUsersOnce(db, \`swap_open_pool:${swap.id}\`, ids, ...)`.

---

## Self-review against the audit

- T1-0 mobile publish gate → 1.2 (feed + route, coaches published-only), 1.2b (personal Today dashboard, web + mobile), 2.1 (no swap on a draft). Manager surfaces that still show drafts: `ScheduleCalendar` (`/api/schedule/blocks`, manager-gated after 2.5), mobile ManageMode (same route), the manager view of `/shifts`, and the business dashboard cost panel. T1-1 cancelled everywhere → 1.1, 1.3-1.7 (+ reports 1.5). T1-2 self-edit → PR 3 (D2 + D3 both "manager only": PUT and DELETE manager-gated, every coach Adjust affordance removed on web and mobile). T1-3 swap target → 2.1, 2.2. T1-4 tenancy → 2.3, 2.4, 2.5, 2.6. T1-5 approvals → 4.1. T1-6 template edits → 4.4. T1-7 horizon → 5.1. T1-8 reports day/daily/scope/overrides → 5.2-5.4. Tier 2: publish overlap → 4.2; post-publish blocks → 4.3; budget overrides+leave → 4.5; time-off overlap/weekends/year-straddle → 2.4b (added on self-review). Swap CHECK → 2.2; notifications FK / indexes / replay / overlap guard → PR 8; swap email fallback + open-pool → 8.4. Tier 3 web → PR 6a/6b/6c. Mobile → 1.8, PR 7, 2.5 (pay leak). Not-changing list → untouched.
- Placeholder scan: PRs 3-8 are task-level by design (stated in the header); PR 1-2 steps carry code. Task 1.4's `roster-publish.test.js` assertion asks the engineer to compute the fixture number — acceptable because the fixture is copied from the neighbouring test.
- Naming: `isLiveAssignment` / `liveAssignments` used consistently in 1.2-1.7, 2.1, 4.4; `block_start_time`/`block_end_time` in 1.8 only; `findPublishedRosterFor` in 4.3 and 5.1.
