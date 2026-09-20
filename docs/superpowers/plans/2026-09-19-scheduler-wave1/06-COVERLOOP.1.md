## PR COVERLOOP.1 — open swaps reach every coach who could cover, managers are chased, dead swaps close

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An open swap is pushed to every coach at that studio who could actually take it (off-day coaches included), managers are re-pushed at T-48h and T-12h while it is unresolved, and a swap whose shift has started is closed and the people in it are told.

**Why (verified on main @ 8231d438):**
- 2 swap requests EVER in production against 40 manager assign/unassign edits on published rosters in 30 days. Cover is being arranged outside the product.
- `notifyOpenPool` (`src/app/api/schedule/swaps/route.js:304-357`) picks recipients from `shift_assignments` at that location **on that same date** (`route.js:307-310`). The coach who is OFF that day, the likeliest cover, is never told. It also says nothing about WHEN the shift is (`route.js:352`).
- Nothing ever expires or escalates a swap. `grep -rn shift_swap_requests src/app/api/cron` returns nothing. An unclaimed swap sits `pending` forever; so does one whose assignment a manager deleted (mig 603 made `requester_shift_id` `ON DELETE SET NULL`, so the row survives with a NULL shift).

**Ships:** web deploy only (Vercel, on merge to `main`). **No migration** (`cancelled` is already in the mig 599 CHECK, `review_note` is an existing text column, the cron arm reuses the existing `checklist-sweep` heartbeat row from mig 406). **No OTA**: nothing under `mobile/` or `shared/` changes, and the PR gate proves it. **Deploy order:** independent of COVERLOOP.2. The escalation and expiry pushes deliberately reuse `data.type` values every installed build already routes (`swap_open`, `swap_awaiting`, `swap_decision`), so they work on today's phones. The `swap_open_pool` tap stays dead until COVERLOOP.2's OTA lands, exactly as it is today; merge COVERLOOP.2 the same day if you can.

**Branch:** `git fetch origin main && git checkout -b coverloop-1-broadcast-escalate-expire origin/main` in a fresh worktree. Run every command from that worktree. One test file: `npx vitest run <path>`.

**Files:**

| File | Responsibility |
|---|---|
| Create `src/lib/swap-cover.js` | PURE: who hears about an open swap, the "Thu 24 Sep, 06:00 to 07:00" label, the sweep decision (nudge / expire / nothing), the notification copy |
| Create `src/lib/swap-cover.test.js` | table-driven tests for all of it |
| Create `src/lib/swap-cover-server.js` | DB half: `notifyOpenPool`, `runSwapCoverSweep` |
| Create `src/lib/swap-cover-server.test.js` | tests for the reads, the fail-open rule, the guarded cancel |
| Modify `src/app/api/schedule/swaps/route.js` | imports (lines 1-14), the assignment select (line 168), the open-pool call (lines 287-288), delete the old `notifyOpenPool` (lines 294-357) |
| Modify `src/app/api/schedule/swaps/route.test.js` | mocks (lines 11-36), `buildDb` (lines 58-131), the two notification `describe`s (lines 255-475) |
| Modify `src/app/api/cron/checklist-sweep/route.js` | header comment (lines 1-17), imports (19-31), the arm before `stampHeartbeat` (lines 177-181) |
| Modify `src/app/api/cron/checklist-sweep/route.test.js` | two mocks (lines 28-42) + a new `describe` |
| Modify `src/lib/notifications-registry.js` | the `swap` entry's `description` + `recipients.detail` (lines 98, 100) |
| Modify `docs/CHANGELOG.md` | one row keyed by the PR number, added after `gh pr create` |

**Design decisions you must not re-litigate while implementing:**

1. **Who is "an eligible coach".** There is no coach flag in this codebase. The rule the assign routes enforce (SCHEDROLES.1, #1712, `src/app/api/schedule/blocks/[id]/assignments/route.js:98-117`) is: *a row in `profile_locations` for the block's studio*. The push layer already has that read, filtered to active profiles: `resolveLocationMemberIds(db, locationId)` (`src/lib/push.js:406-413`). Managers are `resolveRoleRecipientIds(db, locationId, MANAGER_ROLES)` (`src/lib/push.js:364-381`), the SAME resolver `notifyUsersAtRolesOnce` uses for `swap_open`, so the two sets cannot drift (ROSTER-FIX.8f).
2. **Conflicts reuse the decision, not the N+1.** `findSwapConflicts(db, moves, opts)` (`src/lib/swap-conflicts.js:27`) runs two reads PER coach. For a studio-wide fan-out that is ~30 reads after the response. Its decision is the pure `evaluateSwapMoveConflicts(move, { timeOff, assignments })` (`src/lib/swap-lifecycle.js:388`), which already filters rows by `profile_id`. So: two BULK reads (`.in('profile_id', candidates)`), then call `evaluateSwapMoveConflicts` once per candidate. Same rule as the claim warning and the approval check, two queries total.
3. **Fail OPEN.** If the leave or assignment read fails, notify everyone who passed the reads that did work, and `logWarn`. A coach on holiday getting one push is a small cost; nobody hearing about an uncovered 06:00 is the failure this PR exists to fix (CLAUDE.md: "losing the message is worse than the rare wrong value").
4. **D1 (a coach never learns about an unpublished roster) is preserved by construction.** Recipients are no longer chosen by their assignments and the body no longer says "on a day you are working", so nothing about the recipient's own roster is disclosed. A coach with an overlapping DRAFT assignment is silently skipped; silence leaks nothing. The swap's own shift is already required to be published (`route.js:186`).
5. **Cron choice: an arm on `checklist-sweep` (`*/15 * * * *`), not a new cron** (`vercel.json` has 79). It is the existing "coach-owed thing whose deadline passed" sweeper: select pending rows past a deadline, flip status with a status-guarded UPDATE, push the coach and the managers. Expiry is that exact shape. 15 minutes is the right grain: T-48h/T-12h are not minute-sensitive and a swap closing up to 15 minutes after the shift starts is fine. `send-push-reminders` (`*/5`) was rejected: 3x the ticks needed, 403 lines, and its own ledger (`push_reminder_sends`) where this needs `push_event_sends`. **Heartbeat:** no new row. The arm runs inside its own `try/catch` BEFORE the existing `stampHeartbeat('checklist-sweep')` and can never prevent it; its stats ride in the JSON response as `swap_cover`. If the checklist read itself 500s the route returns early and the arm is skipped for that tick; the heartbeat then goes stale and `/api/cron/health-check` flags it, which is the correct signal.
6. **Nudges are stage-ranged, not windowed.** "Now is inside the last 48h" (not "now is within 5 minutes of T-48h"), so a missed tick fires late instead of never. `notifyUsersAtRolesOnce` keys make each stage fire once. A swap posted INSIDE a stage's range skips that stage (managers got `swap_open` seconds ago).
7. **Expiry is a status-guarded UPDATE** (`.eq('status', <the status we read>)` + `.select('id')`): if a manager's approve RPC (migs 612/615, which lock the row and refuse `swap_not_open`) won the race, zero rows come back and we send nothing. **Do not touch the RPCs.**
8. **Scope finding folded in:** `awaiting_approval` swaps are expired by (c), so they must also be nudged by (b), otherwise a claimed swap a manager ignores silently reverts at start time with both coaches believing the other has it. Same function, different copy, `data.type: 'swap_awaiting'`. The taker is also told on expiry.

---

### Task 1: Pure recipient decision + the shift label

**Files:**
- Create: `src/lib/swap-cover.js`
- Create: `src/lib/swap-cover.test.js`

Signatures you depend on (read them): `evaluateSwapMoveConflicts(move, { timeOff = [], assignments = [] } = {})` at `src/lib/swap-lifecycle.js:388`, where `move` is `{ role, coachId, block: { id, block_date, start_time, end_time }, leavingAssignmentId }`; it returns `[]` when the coach is free. It deliberately does NOT flag an assignment on the destination block itself (`swap-lifecycle.js:403`), so "already on this block" is checked here. `fmtTime(t)` at `src/lib/schedule-overlap.js:11` turns `'06:00:00'` into `'06:00'`.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/swap-cover.test.js
// COVERLOOP.1 — the pure half of the cover loop. No DB, no clock.
import { describe, it, expect } from 'vitest'
import { shiftDayLabel, shiftWhenLabel, openPoolRecipients } from './swap-cover'

// 2026-09-24 is a Thursday.
const BLOCK = { id: 'blk-1', block_date: '2026-09-24', start_time: '06:00:00', end_time: '07:00:00' }

const leave = (profile_id, over = {}) => ({
  id: `t-${profile_id}`, profile_id, type: 'holiday', status: 'approved',
  start_date: '2026-09-24', end_date: '2026-09-24', ...over,
})
// Another shift that day, on a DIFFERENT block (any studio).
const shift = (profile_id, start, end, over = {}) => ({
  id: `a-${profile_id}`, profile_id, block_id: 'blk-other', status: 'scheduled',
  start_time_override: null, end_time_override: null,
  shift_blocks: { id: 'blk-other', block_date: '2026-09-24', start_time: start, end_time: end },
  ...over,
})

describe('shiftDayLabel', () => {
  it.each([
    ['2026-09-24', 'Thu 24 Sep'],
    ['2099-01-01', 'Thu 1 Jan'],
    // The day the clocks go back. A calendar date has no timezone, so this
    // must not slide to Saturday on a server west of Dublin.
    ['2026-10-25', 'Sun 25 Oct'],
    ['2026-02-31', ''],
    ['next week', ''],
    [null, ''],
  ])('%s -> "%s"', (input, expected) => {
    expect(shiftDayLabel(input)).toBe(expected)
  })
})

describe('shiftWhenLabel', () => {
  it.each([
    [BLOCK, 'Thu 24 Sep, 06:00 to 07:00'],
    [{ block_date: '2026-09-24' }, 'Thu 24 Sep'],
    [{ start_time: '06:00:00', end_time: '07:00:00' }, '06:00 to 07:00'],
    [null, 'an upcoming shift'],
  ])('%j -> "%s"', (block, expected) => {
    expect(shiftWhenLabel(block)).toBe(expected)
  })
})

describe('openPoolRecipients', () => {
  const base = { memberIds: ['req', 'a', 'b'], managerIds: [], requesterId: 'req', block: BLOCK, timeOff: [], assignments: [] }

  it.each([
    {
      name: 'includes a coach with NO shift that day (the likeliest cover; the old rule skipped them)',
      input: {},
      expected: ['a', 'b'],
    },
    {
      name: 'never the requester',
      input: { memberIds: ['req'] },
      expected: [],
    },
    {
      name: 'never a manager: swap_open already told them',
      input: { managerIds: ['a'] },
      expected: ['b'],
    },
    {
      name: 'not a coach on approved leave that day',
      input: { timeOff: [leave('a')] },
      expected: ['b'],
    },
    {
      name: 'not a coach whose multi-day approved leave covers the date',
      input: { timeOff: [leave('a', { start_date: '2026-09-22', end_date: '2026-09-26' })] },
      expected: ['b'],
    },
    {
      name: 'PENDING leave does not exclude',
      input: { timeOff: [leave('a', { status: 'pending' })] },
      expected: ['a', 'b'],
    },
    {
      name: 'leave that ended the day before does not exclude',
      input: { timeOff: [leave('a', { start_date: '2026-09-20', end_date: '2026-09-23' })] },
      expected: ['a', 'b'],
    },
    {
      name: 'not a coach on an overlapping live shift, at any studio',
      input: { assignments: [shift('a', '06:30:00', '08:00:00')] },
      expected: ['b'],
    },
    {
      name: 'the overlap is judged on the assignment override, not the block default',
      input: { assignments: [shift('a', '08:00:00', '09:00:00', { start_time_override: '06:30:00' })] },
      expected: ['b'],
    },
    {
      name: 'a shift that only TOUCHES (starts at 07:00) does not exclude',
      input: { assignments: [shift('a', '07:00:00', '08:00:00')] },
      expected: ['a', 'b'],
    },
    {
      name: 'a cancelled tombstone does not exclude',
      input: { assignments: [shift('a', '06:00:00', '07:00:00', { status: 'cancelled' })] },
      expected: ['a', 'b'],
    },
    {
      name: 'not a coach already on THIS block (the approve RPC would refuse them: swap_conflict)',
      input: { assignments: [shift('a', '06:00:00', '07:00:00', { block_id: 'blk-1', shift_blocks: { ...BLOCK } })] },
      expected: ['b'],
    },
    {
      name: 'an assignment on another day is ignored',
      input: { assignments: [shift('a', '06:00:00', '07:00:00', { shift_blocks: { id: 'blk-other', block_date: '2026-09-25', start_time: '06:00:00', end_time: '07:00:00' } })] },
      expected: ['a', 'b'],
    },
    {
      name: 'duplicates and blanks in the member list are dropped',
      input: { memberIds: ['a', 'a', null, 'b', 'req'] },
      expected: ['a', 'b'],
    },
    {
      name: 'no block date: nobody (nothing to describe, nothing to check)',
      input: { block: { id: 'blk-1' } },
      expected: [],
    },
  ])('$name', ({ input, expected }) => {
    expect(openPoolRecipients({ ...base, ...input })).toEqual(expected)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/swap-cover.test.js`
Expected: the file fails to load with `Failed to resolve import "./swap-cover"` (0 tests run).

- [ ] **Step 3: Minimal implementation**

```js
// src/lib/swap-cover.js
//
// COVERLOOP.1 — the PURE half of the cover loop: who is told a shift needs
// cover, how the shift is described, and what the 15-minute sweep does with an
// open swap. The DB half is src/lib/swap-cover-server.js. Same split as
// swap-lifecycle.js (pure) / swap-conflicts.js (DB).

import { evaluateSwapMoveConflicts } from './swap-lifecycle'
import { fmtTime } from './schedule-overlap'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * 'YYYY-MM-DD' -> 'Thu 24 Sep'. block_date is a Dublin wall-clock CALENDAR
 * date, so the weekday is computed in UTC from its parts: no timezone can move
 * it. '' for anything malformed or impossible (2026-02-31).
 */
export function shiftDayLabel(blockDate) {
  const m = String(blockDate ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return ''
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[mo - 1]}`
}

/**
 * A shift_blocks row -> 'Thu 24 Sep, 06:00 to 07:00'. The BLOCK's times, not
 * the requester's override: a shift that changes hands loses its overrides
 * (SWAP_MOVE_CLEARS), so the block's window is what the taker would work.
 */
export function shiftWhenLabel(block) {
  const day = shiftDayLabel(block?.block_date)
  const start = fmtTime(block?.start_time)
  const end = fmtTime(block?.end_time)
  const times = start && end ? `${start} to ${end}` : ''
  if (day && times) return `${day}, ${times}`
  return day || times || 'an upcoming shift'
}

/**
 * Who is told an open swap is up for grabs. Pure.
 *
 * Every active member of the studio, minus: the requester; managers (they were
 * told by swap_open); anyone already on this block; anyone
 * evaluateSwapMoveConflicts flags (approved leave covering the date, or a live
 * shift overlapping the block's times at ANY studio). That is the same decision
 * the claim warning and the approval check use, so a coach is never invited to
 * take a shift the approval would then question.
 *
 * @param {object} args
 * @param {string[]} args.memberIds     active profiles linked to the studio
 * @param {string[]} args.managerIds    swap_open recipients
 * @param {string} args.requesterId
 * @param {{id?:string, block_date:string, start_time?:string, end_time?:string}} args.block
 * @param {object[]} [args.timeOff]      time_off_requests rows for the candidates
 * @param {object[]} [args.assignments]  that day's shift_assignments rows (shift_blocks embed)
 * @returns {string[]} profile ids, in member order
 */
export function openPoolRecipients({ memberIds, managerIds, requesterId, block, timeOff = [], assignments = [] }) {
  if (!block?.block_date) return []
  const managers = new Set(managerIds || [])
  const onThisBlock = new Set(
    (assignments || [])
      .filter((a) => a && a.status !== 'cancelled' && block.id
        && (a.block_id === block.id || a.shift_blocks?.id === block.id))
      .map((a) => a.profile_id),
  )
  const out = []
  for (const id of new Set(memberIds || [])) {
    if (!id || id === requesterId) continue
    if (managers.has(id) || onThisBlock.has(id)) continue
    const move = { role: 'taker', coachId: id, block, leavingAssignmentId: null }
    if (evaluateSwapMoveConflicts(move, { timeOff, assignments }).length > 0) continue
    out.push(id)
  }
  return out
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/swap-cover.test.js`
Expected: `Tests  25 passed (25)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/swap-cover.js src/lib/swap-cover.test.js
git commit -m "COVERLOOP.1 — pure open-pool recipient rule and shift label"
```

---

### Task 2: `notifyOpenPool` — the DB half of the broadcast

**Files:**
- Create: `src/lib/swap-cover-server.js`
- Create: `src/lib/swap-cover-server.test.js`

Signatures you depend on: `resolveLocationMemberIds(db, locationId)` -> `Promise<string[]>` (`src/lib/push.js:406`); `resolveRoleRecipientIds(db, locationId, roles)` -> `Promise<string[]>` (`src/lib/push.js:364`); `notifyUsersOnce(db, eventKey, userIds, payload)` (`src/lib/push-dedup.js:137`), which never throws and resolves `{ sent, skipped, invalidated, failed, emailed?, deduped }`; `MANAGER_ROLES` (`src/lib/schemas.js:168`). The two selects below are the ones `findSwapConflicts` already makes (`src/lib/swap-conflicts.js:35-44`), with `.in` instead of `.eq` on `profile_id`.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/swap-cover-server.test.js
// COVERLOOP.1 — the DB half: which rows are read, what happens when a read
// fails, and (Task 5) that the sweep cancels with a status guard.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('./push', () => ({
  resolveLocationMemberIds: vi.fn(),
  resolveRoleRecipientIds: vi.fn(),
}))
vi.mock('./push-dedup', () => ({
  notifyUsersOnce: vi.fn(),
  notifyUsersAtRolesOnce: vi.fn(),
}))

const { logWarn, logError } = await import('./log')
const { resolveLocationMemberIds, resolveRoleRecipientIds } = await import('./push')
const { notifyUsersOnce, notifyUsersAtRolesOnce } = await import('./push-dedup')
const { MANAGER_ROLES } = await import('./schemas')
const { notifyOpenPool } = await import('./swap-cover-server')

// A thenable builder per from() call. Records the select, the filters and any
// update patch; resolves to results[table], which may be a function of the
// recorded query (so one table can answer a read and a write differently).
function mockDb(results = {}) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, select: null, update: null, filters: [] }
      queries.push(q)
      const b = {
        select: (cols) => { q.select = cols; return b },
        update: (patch) => { q.update = patch; return b },
        eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
        in: (c, v) => { q.filters.push(['in', c, v]); return b },
        lte: (c, v) => { q.filters.push(['lte', c, v]); return b },
        gte: (c, v) => { q.filters.push(['gte', c, v]); return b },
        order: () => b,
        limit: () => b,
        then: (res, rej) => {
          const r = typeof results[table] === 'function' ? results[table](q) : results[table]
          return Promise.resolve(r ?? { data: [], error: null }).then(res, rej)
        },
      }
      return b
    },
  }
}

const LOC = 'loc-1'
const BLOCK = { id: 'blk-1', block_date: '2026-09-24', start_time: '06:00:00', end_time: '07:00:00' }
const REQUESTER = { id: 'req', full_name: 'Coach R' }
const ARGS = { swapId: 'swap-1', locationId: LOC, block: BLOCK, requester: REQUESTER }

beforeEach(() => {
  vi.clearAllMocks()
  resolveLocationMemberIds.mockResolvedValue(['req', 'a', 'b', 'mgr'])
  resolveRoleRecipientIds.mockResolvedValue(['mgr'])
  notifyUsersOnce.mockResolvedValue({ sent: 1, emailed: 0, deduped: 0 })
  notifyUsersAtRolesOnce.mockResolvedValue({ sent: 1, emailed: 0, deduped: 0 })
})

describe('notifyOpenPool', () => {
  it('tells every free member of the studio, off-day coaches included, and says when the shift is', async () => {
    const db = mockDb()
    const out = await notifyOpenPool(db, ARGS)

    expect(resolveLocationMemberIds).toHaveBeenCalledWith(db, LOC)
    // The SAME resolver and role set notifyUsersAtRolesOnce uses for swap_open.
    expect(resolveRoleRecipientIds).toHaveBeenCalledWith(db, LOC, MANAGER_ROLES)

    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    const [dbArg, key, ids, payload] = notifyUsersOnce.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(key).toBe('swap_open_pool:swap-1')
    expect(ids).toEqual(['a', 'b'])
    expect(payload).toEqual({
      title: 'A shift needs cover',
      body: 'Coach R needs cover: Thu 24 Sep, 06:00 to 07:00. Tap to take it.',
      category: 'swap',
      emailSubject: 'A shift needs cover: Thu 24 Sep, 06:00 to 07:00',
      data: { type: 'swap_open_pool', swap_id: 'swap-1', block_date: '2026-09-24' },
    })
    expect(out).toEqual({ notified: 2 })
  })

  it('reads leave and that day\'s shifts for the CANDIDATES only, by person (no studio filter)', async () => {
    const db = mockDb()
    await notifyOpenPool(db, ARGS)

    const leave = db.queries.find((q) => q.table === 'time_off_requests')
    expect(leave.filters).toEqual([
      ['in', 'profile_id', ['a', 'b']], ['eq', 'status', 'approved'],
      ['lte', 'start_date', '2026-09-24'], ['gte', 'end_date', '2026-09-24'],
    ])
    const assigns = db.queries.find((q) => q.table === 'shift_assignments')
    expect(assigns.filters).toEqual([
      ['in', 'profile_id', ['a', 'b']], ['eq', 'shift_blocks.block_date', '2026-09-24'],
    ])
    // A coach cannot be at two studios at once: neither read is location-scoped.
    expect(JSON.stringify(db.queries.map((q) => q.filters))).not.toContain('location_id')
  })

  it('drops a coach on approved leave and a coach on an overlapping shift', async () => {
    const db = mockDb({
      time_off_requests: { data: [{ id: 't1', profile_id: 'a', type: 'holiday', status: 'approved', start_date: '2026-09-24', end_date: '2026-09-24' }], error: null },
      shift_assignments: { data: [{
        id: 'a9', profile_id: 'b', block_id: 'blk-9', status: 'scheduled', start_time_override: null, end_time_override: null,
        shift_blocks: { id: 'blk-9', block_date: '2026-09-24', start_time: '06:30:00', end_time: '08:00:00' },
      }], error: null },
    })
    const out = await notifyOpenPool(db, ARGS)
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(out).toEqual({ notified: 0 })
  })

  it('fails OPEN when the leave read fails: the coaches are still told, and it is logged', async () => {
    const db = mockDb({ time_off_requests: { data: null, error: { message: 'boom' } } })
    await notifyOpenPool(db, ARGS)
    expect(notifyUsersOnce.mock.calls[0][2]).toEqual(['a', 'b'])
    expect(logWarn).toHaveBeenCalledWith('swap-cover', expect.stringContaining('leave'), expect.objectContaining({ swapId: 'swap-1', err: 'boom' }))
  })

  it('fails OPEN when the assignments read fails', async () => {
    const db = mockDb({ shift_assignments: { data: null, error: { message: 'boom' } } })
    await notifyOpenPool(db, ARGS)
    expect(notifyUsersOnce.mock.calls[0][2]).toEqual(['a', 'b'])
    expect(logWarn).toHaveBeenCalledWith('swap-cover', expect.stringContaining('shifts'), expect.objectContaining({ swapId: 'swap-1', err: 'boom' }))
  })

  it('reads nothing more and sends nothing when the studio has no other coach', async () => {
    resolveLocationMemberIds.mockResolvedValue(['req', 'mgr'])
    const db = mockDb()
    expect(await notifyOpenPool(db, ARGS)).toEqual({ notified: 0 })
    expect(db.queries).toHaveLength(0)
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('says "A coach" when the requester has no full_name (it is nullable on profiles)', async () => {
    await notifyOpenPool(mockDb(), { ...ARGS, requester: { id: 'req', full_name: null } })
    const payload = notifyUsersOnce.mock.calls[0][3]
    expect(payload.body).toBe('A coach needs cover: Thu 24 Sep, 06:00 to 07:00. Tap to take it.')
    expect(payload.body).not.toContain('null')
  })

  it('does nothing without a block date', async () => {
    expect(await notifyOpenPool(mockDb(), { ...ARGS, block: { id: 'blk-1' } })).toEqual({ notified: 0 })
    expect(resolveLocationMemberIds).not.toHaveBeenCalled()
  })
})
```

(`logError` is destructured here and first used by the Task 5 tests in this same file. `no-unused-vars` is a warning in `eslint.config.mjs`, and lint is only run at the PR gate, after Task 5, so leave it as written.)

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/swap-cover-server.test.js`
Expected: `Failed to resolve import "./swap-cover-server"`.

- [ ] **Step 3: Minimal implementation**

```js
// src/lib/swap-cover-server.js
//
// COVERLOOP.1 — the DB half of the cover loop. The decisions are in
// ./swap-cover.js (pure); this file does the reads, the sends and the one
// guarded write.
//
// Nothing here throws to its caller on a failed READ: notifyOpenPool runs
// after the swap is committed and the 201 is decided, and the sweep runs as an
// arm of a cron whose own job must not be starved.

import { resolveLocationMemberIds, resolveRoleRecipientIds } from './push'
import { notifyUsersOnce } from './push-dedup'
import { MANAGER_ROLES } from './schemas'
import { logWarn } from './log'
import { openPoolRecipients, shiftWhenLabel } from './swap-cover'

// The shape evaluateSwapMoveConflicts reads (src/lib/swap-lifecycle.js). Same
// columns findSwapConflicts selects, minus the names it needs for sentences.
const DAY_ASSIGNMENT_SELECT = 'id, profile_id, block_id, status, start_time_override, end_time_override, shift_blocks!inner(id, block_date, start_time, end_time)'

/**
 * Tell every coach at the studio who could take this open swap.
 *
 * Recipients: active members of the studio (the SCHEDROLES.1 "belongs to the
 * block's studio" rule), minus the requester, minus managers (told by
 * swap_open, resolved with the same helper so the sets cannot drift), minus
 * approved leave covering the date, minus an overlapping live shift at any
 * studio. Two bulk reads, never one pair per coach.
 *
 * FAILS OPEN: a leave or shift read that errors is logged and treated as
 * "nothing found", so the broadcast still goes out. One push to a coach on
 * holiday is cheaper than an uncovered shift nobody heard about.
 *
 * @param {object} db  service-role supabase client
 * @param {{ swapId: string, locationId: string,
 *           block: { id?: string, block_date: string, start_time?: string, end_time?: string },
 *           requester: { id: string, full_name?: string|null } }} args
 * @returns {Promise<{ notified: number }>}
 */
export async function notifyOpenPool(db, { swapId, locationId, block, requester }) {
  if (!swapId || !locationId || !block?.block_date) return { notified: 0 }

  const [memberIds, managerIds] = await Promise.all([
    resolveLocationMemberIds(db, locationId),
    resolveRoleRecipientIds(db, locationId, MANAGER_ROLES),
  ])
  const managers = new Set(managerIds)
  const candidates = [...new Set(memberIds)].filter((id) => id && id !== requester?.id && !managers.has(id))
  if (!candidates.length) return { notified: 0 }

  const [leaveRes, assignRes] = await Promise.all([
    db.from('time_off_requests')
      .select('id, profile_id, type, start_date, end_date, status')
      .in('profile_id', candidates)
      .eq('status', 'approved')
      .lte('start_date', block.block_date)
      .gte('end_date', block.block_date),
    db.from('shift_assignments')
      .select(DAY_ASSIGNMENT_SELECT)
      .in('profile_id', candidates)
      .eq('shift_blocks.block_date', block.block_date),
  ])
  if (leaveRes.error) {
    logWarn('swap-cover', 'open-pool leave read failed; notifying without the leave filter', { swapId, err: leaveRes.error.message })
  }
  if (assignRes.error) {
    logWarn('swap-cover', 'open-pool shifts read failed; notifying without the clash filter', { swapId, err: assignRes.error.message })
  }

  const ids = openPoolRecipients({
    memberIds: candidates,
    managerIds,
    requesterId: requester?.id,
    block,
    timeOff: leaveRes.error ? [] : (leaveRes.data || []),
    assignments: assignRes.error ? [] : (assignRes.data || []),
  })
  if (!ids.length) return { notified: 0 }

  const actor = requester?.full_name || 'A coach'
  const when = shiftWhenLabel(block)
  await notifyUsersOnce(db, `swap_open_pool:${swapId}`, ids, {
    title: 'A shift needs cover',
    body: `${actor} needs cover: ${when}. Tap to take it.`,
    category: 'swap',
    emailSubject: `A shift needs cover: ${when}`,
    data: { type: 'swap_open_pool', swap_id: swapId, block_date: block.block_date },
  })
  return { notified: ids.length }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/swap-cover-server.test.js`
Expected: `Tests  8 passed (8)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/swap-cover-server.js src/lib/swap-cover-server.test.js
git commit -m "COVERLOOP.1 — notifyOpenPool: studio-wide broadcast, leave and clash filtered, fails open"
```

---

### Task 3: Wire `POST /api/schedule/swaps` to the new broadcast

**Files:**
- Modify: `src/app/api/schedule/swaps/route.js` (lines 1-14, 168, 287-288, 294-357)
- Modify: `src/app/api/schedule/swaps/route.test.js` (lines 11-36, 58-131, 133-139, 255-475)

Why `after()`: the old fan-out was one read then a send, launched as an un-awaited promise. The new one awaits four reads first. `src/app/api/schedule/swaps/[id]/route.js:211-215` already moved its notifications into `after()` from `next/server` because Vercel can freeze an un-awaited promise once the response is sent (SWAPNOTIFY.1). Do the same for this one call. Leave the two existing `notifyUsersOnce` / `notifyUsersAtRolesOnce` calls exactly as they are.

- [ ] **Step 1: Rewrite the test file's harness and the two notification `describe`s (the failing tests)**

1a. Replace lines 11-36 (the `vi.mock` block through `const { POST } = ...`) with:

```js
// SWAPNOTIFY.1 pattern — after() runs its callback straight away in tests.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, after: vi.fn((fn) => fn()) }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['loc-1']),
}))
vi.mock('@/lib/push-dedup', () => ({
  sendPushOnce: vi.fn(() => Promise.resolve()),
  sendPushToRolesAtLocationOnce: vi.fn(() => Promise.resolve()),
  notifyUsersOnce: vi.fn(() => Promise.resolve()),
  notifyUsersAtRolesOnce: vi.fn(() => Promise.resolve()),
}))
// COVERLOOP.1 — the open-pool fan-out lives in src/lib/swap-cover-server.js and
// is tested there (recipients, leave, clashes, fail-open). Here it is a spy:
// these tests pin WHEN the route calls it and WITH WHAT.
vi.mock('@/lib/swap-cover-server', () => ({
  notifyOpenPool: vi.fn(() => Promise.resolve({ notified: 0 })),
}))

const { after } = await import('next/server')
const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { notifyUsersOnce, notifyUsersAtRolesOnce } = await import('@/lib/push-dedup')
const { notifyOpenPool } = await import('@/lib/swap-cover-server')
const { POST } = await import('./route.js')
```

(The `MANAGER_ROLES` and `resolveRoleRecipientIds` imports are gone: nothing in this file uses them any more.)

1b. In `buildDb` (line 61 onward): delete the `poolRows = []`, `poolError = null` parameters, the `poolFilters` array, the `if (col.startsWith('shift_blocks.')) poolFilters.push([col, val])` line, and the whole `chain.then = ...` block (the open-pool read no longer happens in the route). Change the final `return { db, insertSpy, poolFilters }` to `return { db, insertSpy }`. In the `shift_blocks` object that `chain.single` returns, add the block's id and times, so it reads:

```js
                    shift_blocks: {
                      id: 'blk-1',
                      location_id: a.location_id,
                      block_date: a.block_date,
                      start_time: '06:00:00',
                      end_time: '07:00:00',
                      rosters: { status: a.roster_status ?? 'published' },
                    },
```

1c. Replace the `beforeEach` (lines 133-139) with:

```js
beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  notifyUsersOnce.mockClear()
  notifyUsersAtRolesOnce.mockClear()
  notifyOpenPool.mockReset()
  notifyOpenPool.mockResolvedValue({ notified: 0 })
  after.mockClear()
})
```

1d. Replace everything from the comment `// ROSTER-FIX.8d — a swap notification that only ever went out as a push` (line 255) to the end of the file with:

```js
// ROSTER-FIX.8d — a swap notification that only ever went out as a push
// reached nobody without the app installed. These pin notifyUsersOnce /
// notifyUsersAtRolesOnce (push + registry-gated email fallback).
// COVERLOOP.1 — and that an OPEN swap is handed to notifyOpenPool.
describe('POST /api/schedule/swaps — notifications', () => {
  it('notifies a named target with an email fallback, not a bare push', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ requester_shift_id: A_REQ, target_id: TGT }))
    expect(res.status).toBe(201)
    await flush()

    const [, key, ids, payload] = notifyUsersOnce.mock.calls.find(c => c[1].startsWith('swap_inbound:'))
    expect(key).toBe('swap_inbound:swap-1')
    expect(ids).toEqual([TGT])
    expect(payload.category).toBe('swap')
    expect(payload.emailSubject).toBeTruthy()
  })

  it('notifies managers of an open swap through the email-fallback sender', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(201)
    await flush()

    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
    const [, key, locationId, roles, payload] = notifyUsersAtRolesOnce.mock.calls[0]
    expect(key).toBe('swap_open:swap-1')
    expect(locationId).toBe(LOC)
    expect(roles).toContain('manager')
    expect(payload.category).toBe('swap')
    expect(payload.emailSubject).toBeTruthy()
  })

  // COVERLOOP.1 — the block (id, date AND times) and the requester ride along,
  // so the broadcast can say "Thu 24 Sep, 06:00 to 07:00" and check clashes.
  it('hands an open swap to notifyOpenPool, inside after(), with the block and the requester', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(201)
    await flush()

    expect(after).toHaveBeenCalledTimes(1)
    expect(notifyOpenPool).toHaveBeenCalledTimes(1)
    expect(notifyOpenPool).toHaveBeenCalledWith(db, {
      swapId: 'swap-1',
      locationId: LOC,
      block: expect.objectContaining({ id: 'blk-1', block_date: future, start_time: '06:00:00', end_time: '07:00:00' }),
      requester: { id: REQ, full_name: 'R' },
    })
  })

  it('still answers 201 and still tells managers when notifyOpenPool rejects', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    notifyOpenPool.mockRejectedValue(new Error('boom'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(201)
    await flush()

    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })

  it('does not run the open-pool fan-out for a targeted swap', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)

    await POST(req({ requester_shift_id: A_REQ, target_id: TGT }))
    await flush()

    expect(notifyUsersAtRolesOnce).not.toHaveBeenCalled()
    expect(notifyOpenPool).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })
})

// ROSTER-FIX.8f — full_name is nullable on profiles. The open-pool copy's own
// fallback is pinned in src/lib/swap-cover-server.test.js.
describe('POST /api/schedule/swaps — notification copy', () => {
  it('falls back to "A coach" when the requester has no full_name', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: null })
    const { db } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ requester_shift_id: A_REQ, target_id: TGT }))
    expect(res.status).toBe(201)
    await flush()

    const [, , , payload] = notifyUsersOnce.mock.calls.find(c => c[1].startsWith('swap_inbound:'))
    expect(payload.body).toBe('A coach wants to swap a shift with you. Tap to review.')
    expect(payload.emailSubject).toBe('A coach wants to swap a shift with you')
    expect(payload.body).not.toContain('null')
  })

  it('falls back to "A coach" for the manager copy too', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: '' })
    const { db } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)

    await POST(req({ requester_shift_id: A_REQ }))
    await flush()

    const [, , , , managerPayload] = notifyUsersAtRolesOnce.mock.calls[0]
    expect(managerPayload.body).toBe('A coach posted a shift for swap. Tap to review.')
  })
})
```

What was deleted and where it went, so nothing is lost: "notifies the eligible coaches on that date", "excludes a coach whose only shift that day is on a draft roster", "still answers 201 ... when the pool query fails", "excludes a head coach rostered that day", "runs no open-pool notification when every eligible coach is a manager". The requester / manager / fail-soft rules are now pinned in Tasks 1 and 2. The draft-roster test has no successor on purpose: see design decision 4.

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/swaps/route.test.js`
Expected: FAIL. The 13 target-validation tests still pass; `hands an open swap to notifyOpenPool...` fails with `expected "spy" to be called 1 times, but got 0 times` (the route does not call `after()` or the new lib yet; it still runs its own private `notifyOpenPool`, which blows up on the pared-down `buildDb` and is swallowed by its `.catch`, so expect a `[swaps] notify open pool failed` line on stderr), and `does not run the open-pool fan-out for a targeted swap` may pass by accident. If instead the whole file fails to load because the un-mocked `@/lib/push` cannot be imported in the test environment, that is the same red for the same reason: Step 3 removes that import.

- [ ] **Step 3: Minimal implementation**

3a. `src/app/api/schedule/swaps/route.js` lines 1-14 become:

```js
import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { notifyUsersOnce, notifyUsersAtRolesOnce } from '@/lib/push-dedup'
import { notifyOpenPool } from '@/lib/swap-cover-server'
import { swapShiftShape } from '@/lib/roster-read'
import { isLiveAssignment } from '@/lib/roster'
import { dublinTodayStr } from '@/lib/dublin-time'
```

(`resolveRoleRecipientIds` from `@/lib/push` and `logWarn` from `@/lib/log` are removed: their only user was the function deleted in 3d, and `npm run lint` fails on an unused import.)

3b. Line 168, the requester assignment select, gains the block's `id`, `start_time`, `end_time` (all real `shift_blocks` columns, mig 067):

```js
    .select('id, profile_id, status, shift_blocks!block_id(id, location_id, block_date, start_time, end_time, rosters:roster_id(status))')
```

Do NOT change the target-shift select at line 202.

3c. Lines 287-288 (the `notifyOpenPool(db, data.id, ...)` call and its `.catch`) become:

```js
    // COVERLOOP.1 — every coach at the studio who could take it, not only the
    // ones already working that day. Inside after(): the fan-out awaits four
    // reads before it sends, and an un-awaited promise left hanging past the
    // response is the shape Vercel can freeze mid-flight (SWAPNOTIFY.1).
    after(() => notifyOpenPool(db, {
      swapId: data.id,
      locationId: swapLocationId,
      block: assignment.shift_blocks,
      requester: { id: user.id, full_name: user.full_name },
    }).catch(err => console.error('[swaps] notify open pool failed', err)))
```

3d. Delete the whole comment + function from `// ROSTER-FIX.8d — an open swap used to be visible only to managers` (line 294) to the end of the file (line 357). The file now ends with the closing `}` of `POST`.

Also fix the comment at lines 255-257 so it stays true: change "and the coaches who could actually take it" to "and every coach at the studio who could take it (src/lib/swap-cover-server.js)".

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/swaps/route.test.js src/app/api/schedule/swaps/route.get.test.js`
Expected: both files green, `route.test.js` reports 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/swaps/route.js src/app/api/schedule/swaps/route.test.js
git commit -m "COVERLOOP.1 — POST /swaps broadcasts an open swap to every eligible coach, with the time range"
```

---

### Task 4: Pure sweep decision + the nudge / expiry copy

**Files:**
- Modify: `src/lib/swap-cover.js`
- Modify: `src/lib/swap-cover.test.js`

Signature you depend on: `wallMsInTz(dateStr, hhmm, tz = 'Europe/Dublin')` at `src/lib/tz-time.js:202`. It returns UTC ms, or `null` for a malformed date/time. **It only accepts `HH:MM`** (regex at line 203), and `shift_blocks.start_time` comes back as `'06:00:00'`, so pass it through `fmtTime` first. It is the repo's DST-exact wall-clock helper; do not hand-roll `new Date(\`${d}T${t}Z\`)` (lint-blocked by `check:guardrails`, and an hour wrong all summer).

- [ ] **Step 1: Write the failing tests** (append to `src/lib/swap-cover.test.js`; extend the import on line 3 to the one shown)

```js
import {
  shiftDayLabel, shiftWhenLabel, openPoolRecipients,
  coverSweepAction, coverNudgePayload, swapExpiryNotices, SWAP_EXPIRY_NOTES,
} from './swap-cover'
```

```js
const H = 3600 * 1000
// 2099-01-01 is winter: 06:00 Dublin IS 06:00 UTC.
const START = Date.UTC(2099, 0, 1, 6, 0)
const WINTER_BLOCK = { id: 'blk-1', block_date: '2099-01-01', start_time: '06:00:00', end_time: '07:00:00' }
const openSwap = (over = {}) => ({
  id: 's1', status: 'pending', location_id: 'loc-1', requester_id: 'req', target_id: null,
  requester_shift_id: 'a1', created_at: new Date(START - 200 * H).toISOString(),
  requester: { full_name: 'Coach R' },
  requester_shift: { id: 'a1', shift_blocks: WINTER_BLOCK },
  ...over,
})

describe('coverSweepAction', () => {
  it.each([
    { name: 'more than 48h out: nothing', swap: openSwap(), now: START - 49 * H, expected: { action: 'none' } },
    { name: 'exactly T-48h: first nudge', swap: openSwap(), now: START - 48 * H, expected: { action: 'nudge', stage: 't48' } },
    { name: 'T-30h (a missed tick fires late, not never)', swap: openSwap(), now: START - 30 * H, expected: { action: 'nudge', stage: 't48' } },
    { name: 'exactly T-12h: second nudge', swap: openSwap(), now: START - 12 * H, expected: { action: 'nudge', stage: 't12' } },
    { name: 'T-1h: still the t12 stage', swap: openSwap(), now: START - 1 * H, expected: { action: 'nudge', stage: 't12' } },
    {
      name: 'posted at T-30h: no t48 nudge, managers heard swap_open minutes ago',
      swap: openSwap({ created_at: new Date(START - 30 * H).toISOString() }), now: START - 20 * H, expected: { action: 'none' },
    },
    {
      name: 'posted at T-30h: the t12 nudge still fires',
      swap: openSwap({ created_at: new Date(START - 30 * H).toISOString() }), now: START - 11 * H, expected: { action: 'nudge', stage: 't12' },
    },
    {
      name: 'posted at T-5h: no nudge at all',
      swap: openSwap({ created_at: new Date(START - 5 * H).toISOString() }), now: START - 1 * H, expected: { action: 'none' },
    },
    { name: 'at the start: expire', swap: openSwap(), now: START, expected: { action: 'expire', reason: 'started' } },
    { name: 'a day after the start: expire', swap: openSwap(), now: START + 24 * H, expected: { action: 'expire', reason: 'started' } },
    { name: 'a CLAIMED swap is nudged too', swap: openSwap({ status: 'awaiting_approval', target_id: 'tkr' }), now: START - 12 * H, expected: { action: 'nudge', stage: 't12' } },
    { name: 'a claimed swap expires too', swap: openSwap({ status: 'awaiting_approval', target_id: 'tkr' }), now: START, expected: { action: 'expire', reason: 'started' } },
    {
      name: 'the shift was deleted (mig 603 SET NULL): expire, whatever the clock says',
      swap: openSwap({ requester_shift_id: null, requester_shift: null }), now: START - 500 * H, expected: { action: 'expire', reason: 'shift_removed' },
    },
    {
      name: 'an embed that did not come back is NOT a deleted shift: do nothing',
      swap: openSwap({ requester_shift: null }), now: START + H, expected: { action: 'none' },
    },
    {
      name: 'an unreadable start time: do nothing rather than guess',
      swap: openSwap({ requester_shift: { id: 'a1', shift_blocks: { ...WINTER_BLOCK, start_time: 'soon' } } }), now: START + H, expected: { action: 'none' },
    },
    { name: 'a decided swap is never touched', swap: openSwap({ status: 'approved' }), now: START + H, expected: { action: 'none' } },
    { name: 'null swap', swap: null, now: START, expected: { action: 'none' } },
  ])('$name', ({ swap, now, expected }) => {
    expect(coverSweepAction(swap, now)).toEqual(expected)
  })

  // Dublin wall-clock, not UTC: on 2026-07-02 (IST, UTC+1) 06:00 is 05:00Z.
  it('reads the block start as Europe/Dublin wall-clock', () => {
    const summer = openSwap({
      created_at: '2026-06-01T00:00:00.000Z',
      requester_shift: { id: 'a1', shift_blocks: { id: 'b', block_date: '2026-07-02', start_time: '06:00:00', end_time: '07:00:00' } },
    })
    expect(coverSweepAction(summer, Date.UTC(2026, 6, 2, 4, 59))).toEqual({ action: 'nudge', stage: 't12' })
    expect(coverSweepAction(summer, Date.UTC(2026, 6, 2, 5, 0))).toEqual({ action: 'expire', reason: 'started' })
  })
})

describe('coverNudgePayload', () => {
  it('an unclaimed swap: "Still uncovered", routed like swap_open (managers -> approvals)', () => {
    expect(coverNudgePayload(openSwap(), 't48')).toEqual({
      key: 'swap_cover_nudge:s1:pending:t48',
      payload: {
        title: 'Shift still uncovered',
        body: 'Still uncovered: Thu 1 Jan, 06:00 to 07:00. Coach R posted it and nobody has taken it yet. Tap to review.',
        category: 'swap',
        emailSubject: 'Still uncovered: Thu 1 Jan, 06:00 to 07:00',
        data: { type: 'swap_open', swap_id: 's1' },
      },
    })
  })

  it('a claimed swap: asks for the approval, routed like swap_awaiting', () => {
    const out = coverNudgePayload(openSwap({ status: 'awaiting_approval', target_id: 'tkr' }), 't12')
    expect(out.key).toBe('swap_cover_nudge:s1:awaiting_approval:t12')
    expect(out.payload.title).toBe('Swap still waiting for approval')
    expect(out.payload.body).toBe("Thu 1 Jan, 06:00 to 07:00: Coach R's shift has been taken by a colleague and still needs your approval. Tap to approve.")
    expect(out.payload.data).toEqual({ type: 'swap_awaiting', swap_id: 's1' })
  })

  it('never prints "null" for a requester with no name', () => {
    expect(coverNudgePayload(openSwap({ requester: { full_name: null } }), 't48').payload.body).toContain('A coach posted it')
  })
})

describe('swapExpiryNotices', () => {
  it('an unclaimed swap: the requester is told once, and it lands on that day of the schedule', () => {
    expect(swapExpiryNotices(openSwap(), 'started')).toEqual([{
      key: 'swap_expired:s1',
      to: ['req'],
      payload: {
        title: 'Swap request expired',
        body: 'Nobody took your shift on Thu 1 Jan, 06:00 to 07:00 before it started, so the swap request has closed and the shift stayed with you.',
        category: 'swap',
        emailSubject: 'Your swap request expired',
        data: { type: 'swap_decision', swap_id: 's1', status: 'cancelled', block_date: '2099-01-01' },
      },
    }])
  })

  it('a claimed swap: the requester AND the taker are told, each in their own words', () => {
    const out = swapExpiryNotices(openSwap({ status: 'awaiting_approval', target_id: 'tkr' }), 'started')
    expect(out.map((n) => [n.key, n.to])).toEqual([['swap_expired:s1', ['req']], ['swap_expired_taker:s1', ['tkr']]])
    expect(out[0].payload.body).toBe('Your swap for Thu 1 Jan, 06:00 to 07:00 was not approved before the shift started, so it has closed and the shift stayed with you.')
    expect(out[1].payload.body).toBe('The swap you took for Thu 1 Jan, 06:00 to 07:00 was not approved before the shift started, so it has closed. The shift stayed with Coach R.')
  })

  it('a removed shift tells nobody: the roster change already did, and there is no date left to describe', () => {
    expect(swapExpiryNotices(openSwap({ requester_shift_id: null, requester_shift: null }), 'shift_removed')).toEqual([])
  })

  it('has a system review_note for both reasons', () => {
    expect(SWAP_EXPIRY_NOTES.started).toMatch(/^Closed automatically/)
    expect(SWAP_EXPIRY_NOTES.shift_removed).toMatch(/^Closed automatically/)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/swap-cover.test.js`
Expected: the 25 Task 1 tests pass; the new ones fail with `coverSweepAction is not a function` (and the same for `coverNudgePayload`, `swapExpiryNotices`, and `Cannot read properties of undefined (reading 'started')`).

- [ ] **Step 3: Minimal implementation** (add the import, then append to `src/lib/swap-cover.js`)

Add below the existing imports:

```js
import { wallMsInTz } from './tz-time'
```

Append:

```js
// ─────────────────────────────────────────────────────────────────────────
// The sweep (an arm of /api/cron/checklist-sweep, every 15 minutes).
// ─────────────────────────────────────────────────────────────────────────

const HOUR_MS = 3600 * 1000
const OPEN_SWAP_STATUSES = ['pending', 'awaiting_approval']

// Nearest first: the first stage whose range covers "now" wins. A stage is a
// RANGE ("inside the last 48h"), not a window around a moment, so a missed
// cron tick fires late instead of never; the push_event_sends ledger makes
// each stage fire once.
export const COVER_NUDGE_STAGES = Object.freeze([
  Object.freeze({ key: 't12', hours: 12 }),
  Object.freeze({ key: 't48', hours: 48 }),
])

// shift_swap_requests.review_note for a swap the sweep closed. There is no
// reviewer (reviewed_by stays NULL): this text is how a reader tells a system
// close from a coach's own cancel.
export const SWAP_EXPIRY_NOTES = Object.freeze({
  started: 'Closed automatically: the shift started before this swap was taken and approved.',
  shift_removed: 'Closed automatically: the shift was removed from the roster.',
})

/** UTC ms the block starts, Europe/Dublin wall-clock. null if unreadable. */
export function swapBlockStartMs(block) {
  return wallMsInTz(block?.block_date, fmtTime(block?.start_time))
}

/**
 * What the sweep does with one open swap. Pure.
 *
 * @param {object} swap  shift_swap_requests row with
 *   requester_shift: { id, shift_blocks: { id, block_date, start_time, end_time } } | null
 * @param {number} nowMs
 * @returns {{action:'none'} | {action:'nudge', stage:'t48'|'t12'} | {action:'expire', reason:'started'|'shift_removed'}}
 */
export function coverSweepAction(swap, nowMs) {
  if (!swap || !OPEN_SWAP_STATUSES.includes(swap.status)) return { action: 'none' }
  // mig 603: deleting the assignment NULLs requester_shift_id and the swap row
  // survives. An open swap about a shift that no longer exists can never be
  // finalised, so it closes. Judged on the COLUMN, never on a missing embed.
  if (swap.requester_shift_id == null) return { action: 'expire', reason: 'shift_removed' }
  const block = swap.requester_shift?.shift_blocks
  if (!block) return { action: 'none' }
  const startMs = swapBlockStartMs(block)
  if (startMs == null) return { action: 'none' }
  if (nowMs >= startMs) return { action: 'expire', reason: 'started' }

  const createdMs = Date.parse(swap.created_at)
  for (const stage of COVER_NUDGE_STAGES) {
    const stageOpensMs = startMs - stage.hours * HOUR_MS
    if (nowMs < stageOpensMs) continue
    // Posted inside this stage's range: swap_open told the managers moments
    // ago, and the ranges nest, so no wider stage applies either.
    if (Number.isFinite(createdMs) && createdMs >= stageOpensMs) return { action: 'none' }
    return { action: 'nudge', stage: stage.key }
  }
  return { action: 'none' }
}

const requesterName = (swap) => swap?.requester?.full_name || 'A coach'

/**
 * The manager re-push for one stage. data.type reuses swap_open /
 * swap_awaiting on purpose: every installed build already routes those to
 * /approvals?tab=team&focus=<id> (mobile/lib/notification-nav.js), so this
 * needs no OTA. The status is in the key: a swap that was nudged while
 * pending and is later claimed still gets its awaiting-approval nudge.
 */
export function coverNudgePayload(swap, stage) {
  const when = shiftWhenLabel(swap?.requester_shift?.shift_blocks)
  const name = requesterName(swap)
  const key = `swap_cover_nudge:${swap.id}:${swap.status}:${stage}`
  if (swap.status === 'awaiting_approval') {
    return {
      key,
      payload: {
        title: 'Swap still waiting for approval',
        body: `${when}: ${name}'s shift has been taken by a colleague and still needs your approval. Tap to approve.`,
        category: 'swap',
        emailSubject: `A shift swap still needs your approval: ${when}`,
        data: { type: 'swap_awaiting', swap_id: swap.id },
      },
    }
  }
  return {
    key,
    payload: {
      title: 'Shift still uncovered',
      body: `Still uncovered: ${when}. ${name} posted it and nobody has taken it yet. Tap to review.`,
      category: 'swap',
      emailSubject: `Still uncovered: ${when}`,
      data: { type: 'swap_open', swap_id: swap.id },
    },
  }
}

/**
 * Who is told a swap expired, and how. data.type is swap_decision (every
 * installed build routes it to the Schedule tab on block_date).
 * shift_removed tells nobody: the roster change notification already told the
 * coach their shift went, and there is no date left to describe.
 */
export function swapExpiryNotices(swap, reason) {
  if (reason !== 'started' || !swap?.id) return []
  const block = swap.requester_shift?.shift_blocks
  const when = shiftWhenLabel(block)
  const claimed = swap.status === 'awaiting_approval'
  const common = {
    title: 'Swap request expired',
    category: 'swap',
    emailSubject: 'Your swap request expired',
    data: { type: 'swap_decision', swap_id: swap.id, status: 'cancelled', block_date: block?.block_date ?? null },
  }
  const out = [{
    key: `swap_expired:${swap.id}`,
    to: [swap.requester_id],
    payload: {
      title: common.title,
      body: claimed
        ? `Your swap for ${when} was not approved before the shift started, so it has closed and the shift stayed with you.`
        : `Nobody took your shift on ${when} before it started, so the swap request has closed and the shift stayed with you.`,
      category: common.category,
      emailSubject: common.emailSubject,
      data: common.data,
    },
  }]
  if (claimed && swap.target_id) {
    out.push({
      key: `swap_expired_taker:${swap.id}`,
      to: [swap.target_id],
      payload: {
        title: common.title,
        body: `The swap you took for ${when} was not approved before the shift started, so it has closed. The shift stayed with ${requesterName(swap)}.`,
        category: common.category,
        emailSubject: common.emailSubject,
        data: common.data,
      },
    })
  }
  return out
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/swap-cover.test.js`
Expected: `Tests  50 passed (50)`. Also run it once under a US zone to prove nothing reads the host clock's zone: `TZ=America/Los_Angeles npx vitest run src/lib/swap-cover.test.js` must give the same 50.

- [ ] **Step 5: Commit**

```bash
git add src/lib/swap-cover.js src/lib/swap-cover.test.js
git commit -m "COVERLOOP.1 — pure sweep decision: T-48h/T-12h nudges, expiry at block start, orphaned swaps"
```

---

### Task 5: `runSwapCoverSweep` — the DB half of the sweep

**Files:**
- Modify: `src/lib/swap-cover-server.js`
- Modify: `src/lib/swap-cover-server.test.js`

Signature you depend on: `notifyUsersAtRolesOnce(db, eventKey, locationId, roles, payload)` (`src/lib/push-dedup.js:157`). It resolves `{ sent, emailed?, deduped, ... }`; on a repeat tick every recipient is deduped and `sent + emailed` is 0. Trap (CLAUDE.md): a supabase builder RESOLVES with `{ error }`, it does not throw, and a zero-row UPDATE is not an error. So destructure `error`, and judge the write by the rows `.select('id')` returns.

- [ ] **Step 1: Write the failing tests** (append to `src/lib/swap-cover-server.test.js`; change the last import line to `const { notifyOpenPool, runSwapCoverSweep } = await import('./swap-cover-server')` and add `const { SWAP_EXPIRY_NOTES } = await import('./swap-cover')` under it)

```js
const H = 3600 * 1000
const START = Date.UTC(2099, 0, 1, 6, 0) // 06:00 Dublin, winter
const sweepSwap = (over = {}) => ({
  id: 's1', status: 'pending', location_id: LOC, requester_id: 'req', target_id: null,
  requester_shift_id: 'a1', created_at: new Date(START - 200 * H).toISOString(),
  requester: { full_name: 'Coach R' },
  requester_shift: { id: 'a1', shift_blocks: { id: 'blk-1', block_date: '2099-01-01', start_time: '06:00:00', end_time: '07:00:00' } },
  ...over,
})
// One table, two kinds of query: the open-swap list, and the guarded cancel.
const swapsTable = (list, updateResult = { data: [{ id: 's1' }], error: null }) =>
  (q) => (q.update ? updateResult : { data: list, error: null })

describe('runSwapCoverSweep', () => {
  it('reads only OPEN swaps', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([]) })
    const stats = await runSwapCoverSweep(db, { nowMs: START })
    expect(db.queries[0].filters).toEqual([['in', 'status', ['pending', 'awaiting_approval']]])
    expect(stats).toEqual({ open: 0, nudged: 0, expired: 0, skipped: 0, errors: 0 })
  })

  it('re-pushes the studio\'s approvers at T-48h, keyed per swap, status and stage', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()]) })
    const stats = await runSwapCoverSweep(db, { nowMs: START - 48 * H })

    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
    const [dbArg, key, locationId, roles, payload] = notifyUsersAtRolesOnce.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(key).toBe('swap_cover_nudge:s1:pending:t48')
    expect(locationId).toBe(LOC)
    expect(roles).toBe(MANAGER_ROLES)
    expect(payload.body).toContain('Still uncovered: Thu 1 Jan, 06:00 to 07:00')
    expect(payload.data).toEqual({ type: 'swap_open', swap_id: 's1' })
    expect(stats).toMatchObject({ open: 1, nudged: 1, expired: 0 })
    // a nudge writes nothing
    expect(db.queries.some((q) => q.update)).toBe(false)
  })

  it('a repeat tick is swallowed by the ledger and is not counted as a nudge', async () => {
    notifyUsersAtRolesOnce.mockResolvedValue({ sent: 0, emailed: 0, deduped: 3 })
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()]) })
    expect(await runSwapCoverSweep(db, { nowMs: START - 40 * H })).toMatchObject({ nudged: 0, skipped: 1 })
  })

  it('cancels a started swap with a STATUS-GUARDED update, then tells the requester once', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()]) })
    const stats = await runSwapCoverSweep(db, { nowMs: START })

    const write = db.queries.find((q) => q.update)
    expect(write.update).toEqual({ status: 'cancelled', review_note: SWAP_EXPIRY_NOTES.started })
    // .eq('status', <what we read>): an approve RPC that won the race leaves 0 rows.
    expect(write.filters).toEqual([['eq', 'id', 's1'], ['eq', 'status', 'pending']])
    expect(write.select).toBe('id')

    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    const [, key, ids, payload] = notifyUsersOnce.mock.calls[0]
    expect(key).toBe('swap_expired:s1')
    expect(ids).toEqual(['req'])
    expect(payload.data).toEqual({ type: 'swap_decision', swap_id: 's1', status: 'cancelled', block_date: '2099-01-01' })
    expect(notifyUsersAtRolesOnce).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ expired: 1, errors: 0 })
  })

  it('a claimed swap that expires tells the taker too', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap({ status: 'awaiting_approval', target_id: 'tkr' })]) })
    await runSwapCoverSweep(db, { nowMs: START + H })
    expect(notifyUsersOnce.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['swap_expired:s1', ['req']],
      ['swap_expired_taker:s1', ['tkr']],
    ])
  })

  it('sends NOTHING when the cancel matched no row (a manager decided it first)', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()], { data: [], error: null }) })
    const stats = await runSwapCoverSweep(db, { nowMs: START })
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ expired: 0, skipped: 1, errors: 0 })
  })

  it('a failed cancel is an error, sends nothing, and the next swap is still processed', async () => {
    const second = sweepSwap({ id: 's2', requester_id: 'req2' })
    const db = mockDb({
      shift_swap_requests: (q) => {
        if (!q.update) return { data: [sweepSwap(), second], error: null }
        const id = q.filters.find((f) => f[1] === 'id')[2]
        return id === 's1' ? { data: null, error: { message: 'boom' } } : { data: [{ id: 's2' }], error: null }
      },
    })
    const stats = await runSwapCoverSweep(db, { nowMs: START })
    expect(stats).toMatchObject({ open: 2, expired: 1, errors: 1 })
    expect(notifyUsersOnce.mock.calls.map((c) => c[1])).toEqual(['swap_expired:s2'])
    expect(logError).toHaveBeenCalledWith('swap-cover', expect.any(String), expect.objectContaining({ swapId: 's1', err: 'boom' }))
  })

  it('closes a swap whose shift was deleted, quietly', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap({ requester_shift_id: null, requester_shift: null })]) })
    const stats = await runSwapCoverSweep(db, { nowMs: START - 500 * H })
    expect(db.queries.find((q) => q.update).update).toEqual({ status: 'cancelled', review_note: SWAP_EXPIRY_NOTES.shift_removed })
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ expired: 1 })
  })

  it('an unreadable swap list is one logged error and no work', async () => {
    const db = mockDb({ shift_swap_requests: { data: null, error: { message: 'down' } } })
    expect(await runSwapCoverSweep(db, { nowMs: START })).toEqual({ open: 0, nudged: 0, expired: 0, skipped: 0, errors: 1 })
    expect(logError).toHaveBeenCalledWith('swap-cover', expect.any(String), expect.objectContaining({ err: 'down' }))
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/swap-cover-server.test.js`
Expected: the 8 `notifyOpenPool` tests pass; the 9 new ones fail with `runSwapCoverSweep is not a function`.

- [ ] **Step 3: Minimal implementation**

In `src/lib/swap-cover-server.js` change three import lines to:

```js
import { notifyUsersOnce, notifyUsersAtRolesOnce } from './push-dedup'
import { logWarn, logError } from './log'
import {
  openPoolRecipients, shiftWhenLabel,
  coverSweepAction, coverNudgePayload, swapExpiryNotices, SWAP_EXPIRY_NOTES,
} from './swap-cover'
```

Append:

```js
// ─────────────────────────────────────────────────────────────────────────
// The sweep — called by /api/cron/checklist-sweep every 15 minutes.
// ─────────────────────────────────────────────────────────────────────────

// requester:profiles!requester_id is the same disambiguated embed GET
// /api/schedule/swaps uses (two FKs to profiles on this table).
const OPEN_SWAP_SELECT = `
  id, status, location_id, requester_id, target_id, requester_shift_id, created_at,
  requester:profiles!requester_id(full_name),
  requester_shift:shift_assignments!requester_shift_id(id, shift_blocks!block_id(id, block_date, start_time, end_time))
`
// Open swaps are single digits in production. The cap is a guard, not a page
// size: if it is ever hit, the oldest 200 are processed and the rest wait a tick.
const SWEEP_LIMIT = 200

const delivered = (r) => ((r?.sent || 0) + (r?.emailed || 0)) > 0

/**
 * One pass over every open swap: nudge the studio's approvers at T-48h and
 * T-12h, and close a swap whose shift has started (or no longer exists).
 * Never throws. Returns counts for the cron's response.
 *
 * @param {object} db  service-role supabase client
 * @param {{ nowMs?: number }} [opts]
 */
export async function runSwapCoverSweep(db, { nowMs = Date.now() } = {}) {
  const stats = { open: 0, nudged: 0, expired: 0, skipped: 0, errors: 0 }

  const { data: swaps, error } = await db.from('shift_swap_requests')
    .select(OPEN_SWAP_SELECT)
    .in('status', ['pending', 'awaiting_approval'])
    .order('created_at', { ascending: true })
    .limit(SWEEP_LIMIT)
  if (error) {
    logError('swap-cover', 'sweep could not read open swaps', { err: error.message })
    stats.errors++
    return stats
  }
  stats.open = (swaps || []).length

  for (const swap of swaps || []) {
    const decision = coverSweepAction(swap, nowMs)
    if (decision.action === 'none') continue
    try {
      if (decision.action === 'nudge') {
        const { key, payload } = coverNudgePayload(swap, decision.stage)
        // The same recipients swap_open reached: MANAGER_ROLES at the swap's
        // own studio. At-most-once per (swap, status, stage) via the ledger.
        const result = await notifyUsersAtRolesOnce(db, key, swap.location_id, MANAGER_ROLES, payload)
        if (delivered(result)) stats.nudged++
        else stats.skipped++
        continue
      }
      if (await expireSwap(db, swap, decision.reason)) stats.expired++
      else stats.skipped++
    } catch (e) {
      logError('swap-cover', 'sweep failed on a swap; the next tick retries it', { swapId: swap.id, action: decision.action, err: e?.message })
      stats.errors++
    }
  }
  return stats
}

// Close one swap. The UPDATE is guarded on the status we READ: if a manager's
// approve RPC (migs 612/615 lock the row and refuse swap_not_open) or a coach's
// claim landed in between, zero rows match, nothing is sent, and the next tick
// reads the new truth. A zero-row UPDATE is not an error in PostgREST, so the
// returned rows are the verdict. The notification comes AFTER the write and is
// ledger-keyed, so a crash between the two costs one message, never a loop.
async function expireSwap(db, swap, reason) {
  const { data, error } = await db.from('shift_swap_requests')
    .update({ status: 'cancelled', review_note: SWAP_EXPIRY_NOTES[reason] })
    .eq('id', swap.id)
    .eq('status', swap.status)
    .select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) return false

  for (const notice of swapExpiryNotices(swap, reason)) {
    await notifyUsersOnce(db, notice.key, notice.to, notice.payload)
  }
  return true
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/swap-cover-server.test.js`
Expected: `Tests  17 passed (17)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/swap-cover-server.js src/lib/swap-cover-server.test.js
git commit -m "COVERLOOP.1 — runSwapCoverSweep: manager nudges and a status-guarded expiry"
```

---

### Task 6: Arm the sweep on the `checklist-sweep` cron

**Files:**
- Modify: `src/app/api/cron/checklist-sweep/route.js` (lines 1-17, 19-31, 177-181)
- Modify: `src/app/api/cron/checklist-sweep/route.test.js` (lines 28-42, and a new `describe` at the end)

No `vercel.json` change, no migration: the cron and its `cron_heartbeats` row (`checklist-sweep`, mig 406, 900s interval) already exist.

- [ ] **Step 1: Write the failing tests**

1a. In `src/app/api/cron/checklist-sweep/route.test.js`, change the log mock on line 30 and add the arm's mock directly under the `@/lib/checklist-sweep` mock:

```js
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
```

```js
// COVERLOOP.1 — the swap cover arm. Its behaviour is pinned in
// src/lib/swap-cover-server.test.js; here it is a spy.
vi.mock('@/lib/swap-cover-server', () => ({
  runSwapCoverSweep: vi.fn(async () => ({ open: 2, nudged: 1, expired: 1, skipped: 0, errors: 0 })),
}))
```

1b. Add these imports under the existing `import { logAuditEvent } from '@/lib/audit'`:

```js
import { runSwapCoverSweep } from '@/lib/swap-cover-server'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
```

1c. Append a new `describe` at the end of the file:

```js
// COVERLOOP.1 — the swap cover sweep rides this cron (see the route header for
// why). It must run every tick, report its counts, and NEVER cost the
// checklist sweep its response or its heartbeat.
describe('GET /api/cron/checklist-sweep — swap cover arm', () => {
  it('runs the swap cover sweep with the cron\'s db and reports its counts', async () => {
    const res = await GET(req())
    const body = await res.json()
    expect(runSwapCoverSweep).toHaveBeenCalledTimes(1)
    expect(runSwapCoverSweep).toHaveBeenCalledWith(fakeDb)
    expect(body.swap_cover).toEqual({ open: 2, nudged: 1, expired: 1, skipped: 0, errors: 0 })
  })

  it('runs it even when no checklist was overdue', async () => {
    tables = { checklist_instances: [] }
    await GET(req())
    expect(runSwapCoverSweep).toHaveBeenCalledTimes(1)
  })

  it('a throwing arm is logged, reported as null, and the heartbeat is still stamped', async () => {
    runSwapCoverSweep.mockRejectedValueOnce(new Error('boom'))
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, swap_cover: null })
    expect(logError).toHaveBeenCalledWith('cron-checklist-sweep', expect.any(String), expect.objectContaining({ err: 'boom' }))
    expect(stampHeartbeat).toHaveBeenCalledWith('checklist-sweep')
  })

  it('does not run for an unauthorised caller', async () => {
    await GET(req('Bearer nope'))
    expect(runSwapCoverSweep).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/cron/checklist-sweep/route.test.js`
Expected: the two existing tests pass; the first three new tests fail (`expected "spy" to be called 1 times, but got 0 times`, and `body.swap_cover` is `undefined`).

- [ ] **Step 3: Minimal implementation**

3a. Replace the route's header comment, lines 1-17, with:

```js
// CHECKLIST.3 — Vercel cron, every 15 minutes.
//
// Sweeps checklist_instances where status='pending' AND
// deadline_at < now() and:
//   1. Flips status → 'incomplete' (concurrency-safe: only flips
//      from 'pending', so a coach completing the last item between
//      our SELECT and UPDATE wins).
//   2. Sends a personal push to the coach (notify_checklist_overdue).
//   3. Sends a compliance push to head_coach + owner + master at
//      the location (notify_checklist_compliance).
//   4. Logs a 'checklist.incomplete' audit event.
//
// Per-row error isolation — a push failure on one instance never
// stops the loop. Push delivery itself is best-effort; sendPush
// returns counts and never throws.
//
// COVERLOOP.1 — SECOND ARM: the swap cover sweep (src/lib/swap-cover-server.js
// runSwapCoverSweep). It re-pushes a studio's approvers about an unresolved
// swap at T-48h and T-12h, and closes a swap whose shift has started. It lives
// here rather than on a cron of its own because it is the same job in the same
// domain at the same grain: a coach-owed thing whose deadline passed, flipped
// with a status-guarded UPDATE, coach and managers pushed. vercel.json already
// carries 79 crons. It runs AFTER the checklist loop, inside its own try/catch,
// and BEFORE the heartbeat, so it can never cost the checklist sweep anything;
// it shares the 'checklist-sweep' heartbeat row and reports its counts as
// `swap_cover` in the response. If the checklist read itself 500s the route
// returns early, this arm waits one tick, and the stale heartbeat is the alarm.
//
// Auth: CRON_SECRET header, same pattern as the other crons.
```

3b. Change the log import (line 24) and add the arm's import under the `@/lib/checklist-sweep` import block:

```js
import { logWarn, logError } from '@/lib/log'
```

```js
import { runSwapCoverSweep } from '@/lib/swap-cover-server'
```

3c. Replace the tail of `GET` (from `await stampHeartbeat('checklist-sweep')` to the final `return`) with:

```js
  // COVERLOOP.1 — the swap cover arm (see the header). runSwapCoverSweep does
  // not throw; the try/catch is for the day someone changes that.
  let swapCover = null
  try {
    swapCover = await runSwapCoverSweep(db)
  } catch (e) {
    logError('cron-checklist-sweep', 'swap cover sweep threw', { err: e?.message })
    stats.errors++
  }

  await stampHeartbeat('checklist-sweep').catch((err) =>
    logWarn('cron-checklist-sweep', 'heartbeat failed', { err }))

  return NextResponse.json({ success: true, stats, swap_cover: swapCover })
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/cron/checklist-sweep/route.test.js`
Expected: `Tests  6 passed (6)`.

Then confirm the heartbeat invariant still holds (CLAUDE.md, "Crons & webhooks"):
Run: `grep -L stampHeartbeat src/app/api/cron/*/route.js`
Expected: exactly `src/app/api/cron/ad-insights-backfill/route.js` and `src/app/api/cron/health-check/route.js`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/checklist-sweep/route.js src/app/api/cron/checklist-sweep/route.test.js
git commit -m "COVERLOOP.1 — run the swap cover sweep as an arm of the 15-minute checklist-sweep cron"
```

---

### Task 7: Registry copy, changelog, PR

**Files:**
- Modify: `src/lib/notifications-registry.js` (lines 98 and 100)
- Modify: `docs/CHANGELOG.md`

The notifications registry is what `/settings` shows operators about each category. Its `swap` entry still describes the old recipient rule.

- [ ] **Step 1: Update the registry entry.** In `src/lib/notifications-registry.js`, in the `category: 'swap'` object, replace the `description` and `recipients` lines with:

```js
    description: 'Inbound swap requests for managers, the open pool for every coach at the studio who could take the shift, reminders to managers while a swap is unresolved (48h and 12h before the shift), and the outcome for the requester and taker, including a swap that expired when its shift started.',
    trigger: { kind: 'event', source: 'POST/PUT /api/schedule/swaps + the checklist-sweep cron' },
    recipients: { kind: 'individual_or_creator', detail: 'Managers (new request, reminders), coaches at the studio who are free and not on leave (open pool), or the requester / taker (decision, expiry)' },
```

(That replaces three consecutive lines: `description`, `trigger`, `recipients`. Leave `configurable`, `fallbackEmail` and `emailSubject` alone.)

- [ ] **Step 2: Run the tests that import the registry, expect PASS**

There is no `notifications-registry.test.js`; the registry is exercised through these two files (`trigger.source` is only rendered as text by `src/app/settings/notifications/page.js:113`).

Run: `npx vitest run src/lib/push-channels.test.js src/lib/shared-permissions.test.js`
Expected: green (no test pins this prose; this proves the object still parses and the category set is unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/lib/notifications-registry.js
git commit -m "COVERLOOP.1 — notifications registry describes the new swap recipients and reminders"
```

- [ ] **Step 4: PR gate — run all of it, in this order, and read the output**

```bash
npx vitest run src/lib/swap-cover.test.js src/lib/swap-cover-server.test.js \
  src/app/api/schedule/swaps/route.test.js src/app/api/schedule/swaps/route.get.test.js \
  'src/app/api/schedule/swaps/[id]/route.test.js' \
  src/app/api/cron/checklist-sweep/route.test.js \
  src/lib/swap-lifecycle.test.js src/lib/swap-conflicts.test.js \
  src/lib/push-channels.test.js src/lib/shared-permissions.test.js
npm run lint
npm run check:guardrails        # no-unchecked-supabase-write / no-discarded-single-error on the new lib
npm run check:select-columns    # every column named in the three new .select() strings must exist in supabase/migrations
npm run check:route-guards      # no new route; must stay green
npm run check:location-scoping  # /api/cron/** is exempt by path; must stay green
npm run check:ota-paths
git diff --name-only origin/main | grep -E '^(mobile|shared)/' ; echo "exit=$?"
```

Expected: everything green, and the last command prints `exit=1` with no paths above it. That is the proof this merge publishes **no OTA**. If any path prints, stop: something under `mobile/` or `shared/` was touched by mistake.

This PR adds imports, so CLAUDE.md asks for `npm run build` before pushing. On the 8GB dev machine skip it locally and rely on the required **Next build** check on the PR; do not merge until it is green.

- [ ] **Step 5: Push, open the PR, add the changelog row**

```bash
git push -u origin HEAD
gh pr create --base main --title "COVERLOOP.1 — open swaps reach every coach who could cover; managers are chased; dead swaps close" --body "$(cat <<'EOF'
## What
- An open swap is pushed to every active coach at the studio who could take it: members of the studio, minus the requester, managers (already told by swap_open), approved leave covering the date, an overlapping live shift at any studio, and anyone already on the block. It used to reach only coaches already rostered at that studio on that date, so the coach who was off never heard. The push now says when the shift is.
- While a swap is unresolved its studio's managers are re-pushed at T-48h and T-12h, once each (push_event_sends ledger). A claimed swap waiting on approval is chased too.
- A swap whose shift has started is cancelled with a system review_note and the requester (and the taker, if it was claimed) is told once. A swap whose assignment was deleted is closed quietly.

## How
- Pure decisions in src/lib/swap-cover.js (table-driven tests), DB half in src/lib/swap-cover-server.js.
- The sweep is an arm on the existing */15 checklist-sweep cron: no new vercel.json entry, no new heartbeat row.
- No migration. No change to the approve RPCs (migs 612/615); expiry is a status-guarded UPDATE that loses cleanly to them.
- Escalation and expiry reuse data.type swap_open / swap_awaiting / swap_decision, so installed phones already route the tap.

## Ships
Web deploy only. No migration. No mobile/ or shared/ path touched, so no OTA.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then add ONE row at the top of the table in `docs/CHANGELOG.md` (directly under the `|---|------|-------|` line), keyed by the PR number `gh` just printed. Never edit a changelog row after it is pushed (`merge=union` duplicates it); get it right once:

```
| #<PR> | COVERLOOP.1 — an open swap reaches every coach who could cover it (not only those already working that day), managers are chased at T-48h and T-12h, and a swap whose shift has started closes itself | 2026-09-19. Web only: no migration, nothing under `mobile/` or `shared/`, so **no OTA**. `notifyOpenPool` moved to `src/lib/swap-cover-server.js`; recipients = `resolveLocationMemberIds` minus requester, `MANAGER_ROLES`, approved leave, overlapping live shifts (any studio, via `evaluateSwapMoveConflicts` on two bulk reads) and anyone already on the block; fails OPEN on an unreadable leave/shift read. The sweep (`runSwapCoverSweep`) is an arm of `/api/cron/checklist-sweep` (*/15), shares its heartbeat, reports `swap_cover` in the response. Expiry is `UPDATE ... WHERE status = <status read>` + `.select('id')`, so it loses cleanly to the mig 612/615 approve RPCs. Also closes open swaps orphaned by a deleted assignment (mig 603 SET NULL). |
```

```bash
git add docs/CHANGELOG.md
git commit -m "COVERLOOP.1 — changelog row"
git push
```

Report the PR URL. Pushing is not shipping: the change is live when the PR is merged and the Vercel production deploy for that commit is green.

**After merge, verify in production (read-only):** the next `checklist-sweep` tick's response carries `swap_cover` (Vercel logs for `/api/cron/checklist-sweep`), and `select name, last_ok_at from cron_heartbeats where name = 'checklist-sweep'` keeps advancing every 15 minutes.

**Deliberately out of scope:** re-broadcasting the pool when a taker withdraws (the requester is told; the pool is not re-pushed because its ledger key is per swap); moving the two older `notifyUsers*Once` calls in `POST` into `after()`; per-location timezones (every studio is Europe/Dublin; `wallMsInTz` takes a `tz` argument the day that changes).
