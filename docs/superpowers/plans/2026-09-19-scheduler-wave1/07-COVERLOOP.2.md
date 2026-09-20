## PR COVERLOOP.2 — the phone's swap flow: a tap that lands, cards that say when, a confirm step, warnings, a pending chip

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A coach can post, target, understand and claim a swap on the phone without guessing: the open-pool push opens the card, every swap card says "Thu 24 Sep · 06:00-07:00", a targeted request is confirmed (with an optional reason that is really sent), claim warnings are shown, a shift with an open swap carries a "Swap pending" chip, and a manager's pending rows open the approval.

**Why (verified on main @ 8231d438):**
- `POST /api/schedule/swaps` sends `data.type: 'swap_open_pool'` with "Tap to take it" (`src/app/api/schedule/swaps/route.js:350-356`); `mobile/lib/notification-nav.js` has no case for it, so `routeForNotification` returns `undefined` and the tap does nothing.
- `mobile/components/dashboard/PersonalDashboard.jsx`: a targeted swap is POSTed on ONE tap with no confirmation (`pickSwapCoach`, lines 598-613), from a sheet titled "Add coach" (`mobile/components/schedule/CoachPickerSheet.jsx:16`). Swap cards print the template name and a raw ISO date and no times (lines 711-729, 783-800, 888-892). `mutateSwap` (lines 568-582) throws away the `warnings` the claim response carries (`src/app/api/schedule/swaps/[id]/route.js:202-217`), which web shows (`src/components/dashboard/SwapActions.jsx:133-138`). `reason` is accepted by the API (`route.js:20`) and sent as `null` by every mobile caller.
- A shift with an open swap looks like any other shift on the Schedule tab (`mobile/app/(staff)/(tabs)/schedule.jsx:240-299`) and on the Dashboard roster, so the coach can post it again and get a 409.
- `mobile/components/dashboard/StudioDashboard.jsx:129,144`: both pending rows push `/(tabs)/schedule`, which has no approve UI. Approvals live at `/approvals?tab=team&focus=<id>` (`mobile/app/(staff)/approvals.jsx:55`), where the push taps already go.

**Ships:** **web deploy + OTA, from one merge.** Two small additive API changes ride in this PR (both in `src/lib`, no migration): (1) `GET /api/schedule/swaps` swap-shift embeds gain `block_start_time` / `block_end_time`; (2) `GET /api/schedule/shifts` rows gain `open_swap_status` for the caller's OWN shifts. `shared/dashboard-data.js` adds two columns to an existing embed. Everything under `mobile/` is JS-only, so merging to `main` **publishes an OTA to production phones at 100%** via `.github/workflows/eas-update.yml` (CLAUDE.md, "Web/mobile boundary"). **Deploy order does not matter and neither side waits for the other:** a new bundle against the old API shows no chip and falls back to the collapsed override / template time; an old bundle ignores the new fields. **After merging, open the "EAS Update" run in GitHub Actions and confirm it is green and which `runtimeVersion` lane it published to** (a merge is not a publish: a red run means no phone got it, and the run opens a tracking issue). Independent of COVERLOOP.1; if both are ready, merge this one the same day so the broader broadcast lands on a tap that works.

**Branch:** `git fetch origin main && git checkout -b coverloop-2-mobile-swap-flow origin/main` in a fresh worktree. One test file: `npx vitest run <path>`. **zsh:** every path containing `(staff)`, `(tabs)` or `[id]` must be single-quoted in `git add`, or staging silently empties.

**There is no React Native component test runner in this repo.** Every decision (what a card says, whether a chip shows, what the confirm sheet asks, what is POSTed) goes in `mobile/lib/*.js` with vitest tests. Component tasks below are wiring only; they have no failing-test step, and their check is `check:mobile-lint` + `check:mobile-imports`. Line numbers are valid at `8231d438`; a sibling PR in this wave (LEAVEPHONE.1) edits `schedule.jsx` lines 703-714, so find each edit by the quoted anchor text, not the number.

**Files:**

| File | Responsibility |
|---|---|
| Modify `mobile/lib/notification-nav.js` | `swap_open_pool` case; exported `teamApprovalRoute(id)` |
| Modify `mobile/lib/notification-nav.test.js` | tests for both |
| Modify `src/lib/roster-read.js` (`swapShiftShape`, lines 58-74) | swap-shift embeds carry the block's times |
| Modify `src/lib/roster-read.test.js` | test for it |
| Create `src/lib/shift-open-swaps.js` | which of the caller's shifts have an open swap |
| Create `src/lib/shift-open-swaps.test.js` | tests |
| Modify `src/app/api/schedule/shifts/route.js` (lines 1-5, 53-55) | annotate rows |
| Modify `src/app/api/schedule/shifts/route.test.js` (line 22 area) | mock + one test |
| Modify `src/lib/openapi.js` (line 4322) | document `open_swap_status` |
| Modify `shared/dashboard-data.js` (the `shift_swap_requests` select, ~line 214) | posted swaps carry the block's times |
| Modify `shared/dashboard-data.test.js` | test for it |
| Create `mobile/lib/swap-cards.js` | ALL card / confirm / chip decisions and copy |
| Create `mobile/lib/swap-cards.test.js` | tests |
| Modify `mobile/lib/swap-conflicts.js` | `swapClaimNotice(res)` |
| Modify `mobile/lib/swap-conflicts.test.js` | tests, pinned to the web wording |
| Modify `mobile/components/schedule/CoachPickerSheet.jsx` | `title` / `emptyText` props, defaults unchanged |
| Create `mobile/components/schedule/SwapConfirmSheet.jsx` | confirm step with the reason field |
| Modify `mobile/components/dashboard/PersonalDashboard.jsx` | wiring |
| Modify `mobile/app/(staff)/(tabs)/schedule.jsx` | chip + confirm copy |
| Modify `mobile/components/dashboard/StudioDashboard.jsx` (lines 129, 143-144) | rows open the approval |
| Modify `docs/CHANGELOG.md` | one row, after `gh pr create` |

**Design decisions you must not re-litigate while implementing:**

1. **Which time a swap card shows: the BLOCK's.** `swapShiftShape` collapses the requester's personal paid-window override and a block-vs-template deviation into one `start_time_override`, so a client cannot tell them apart. A shift that changes hands loses its overrides (`SWAP_MOVE_CLEARS`, `src/lib/swap-lifecycle.js:23`), so the taker works the block's hours. Hence API change (1), under the same `block_start_time` / `block_end_time` keys `toApiShiftRow` already uses (`src/lib/roster-read.js:121-122`). The mobile formatter falls back to the collapsed value when the keys are absent (old API).
2. **Where "this shift has an open swap" comes from.** Dashboard: it already holds `myPostedSwaps` (`shared/dashboard-data.js:213-216`, rows carry `requester_shift_id` and `status`, and a dashboard shift's `id` IS the assignment id, `dashboard-data.js:115`), so the chip is a pure join, no new read. Schedule tab: it reads `GET /api/schedule/shifts` and nothing else about swaps, so that route annotates rows (API change (2)). **Only the caller's own rows are annotated:** a targeted swap between two colleagues is not visible to other coaches (COACHSCOPE.1), and the Team view must not leak it. The read is `requester_id = caller`, one indexed query; if it fails the roster still loads with no chip.
3. **The confirm step is a sheet, not an `Alert`.** `Alert.prompt` is iOS-only, and the reason needs a text field on Android too. One sheet serves both the targeted request and "Post for swap", so both collect a reason.
4. **Claim warnings use the web's words.** The sentences are built server-side; the phone renders them under the same heading web uses, pinned by a test that reads the web component's source (the `SWAP_CONFLICTS_CODE` pattern, `mobile/lib/swap-conflicts.test.js:39-43`).
5. **`CoachPickerSheet` stays the manager's "Add coach" sheet by default.** New props default to today's strings, so `ManageMode.jsx:163` is untouched.

---

### Task 1: The `swap_open_pool` tap lands, and one helper for "open this approval"

**Files:**
- Modify: `mobile/lib/notification-nav.js` (header comment lines 13-16; helpers lines 37-40; cases lines 50-81, 131-133)
- Modify: `mobile/lib/notification-nav.test.js`

- [ ] **Step 1: Write the failing tests.** In `mobile/lib/notification-nav.test.js` change the import on line 8 to:

```js
import { routeForNotification, teamApprovalRoute } from './notification-nav'
```

Replace the existing test `routes staff swap-response types to the Dashboard tab (swap cards live there)` with:

```js
  it('routes staff swap types to the Dashboard tab (swap cards live there)', () => {
    for (const type of ['swap_inbound', 'swap_claimed', 'swap_accepted', 'swap_withdrawn', 'swap_declined']) {
      expect(routeForNotification({ type, swap_id: 's1' })).toBe('/(tabs)/dashboard')
    }
  })

  // COVERLOOP.2 — the server has sent this type with "Tap to take it" since
  // ROSTER-FIX.8d and the tap went nowhere (undefined = unknown type). The
  // "Open swaps you can take" card is on the Dashboard tab.
  it('routes the open-pool broadcast to the Dashboard tab, where the Claim button is', () => {
    expect(routeForNotification({ type: 'swap_open_pool', swap_id: 's1', block_date: '2026-09-24' })).toBe('/(tabs)/dashboard')
    expect(routeForNotification({ type: 'swap_open_pool' })).toBe('/(tabs)/dashboard')
  })
```

Append a new `describe` at the end of the file:

```js
// COVERLOOP.2 — the Studio tab's pending rows open the same place the pushes do.
describe('teamApprovalRoute', () => {
  it('focuses the approval when the id is safe to put in a URL', () => {
    expect(teamApprovalRoute('0a0a0a0a-0000-4000-8000-000000000000')).toBe('/approvals?tab=team&focus=0a0a0a0a-0000-4000-8000-000000000000')
  })
  it.each([[undefined], [null], [42], [''], ['a?b=c'], ['a b']])('falls back to the bare team tab for %j', (id) => {
    expect(teamApprovalRoute(id)).toBe('/approvals?tab=team')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run mobile/lib/notification-nav.test.js`
Expected: the open-pool test fails with `expected undefined to be '/(tabs)/dashboard'`; the `teamApprovalRoute` tests fail with `teamApprovalRoute is not a function`.

- [ ] **Step 3: Minimal implementation**

3a. In the header comment, replace the three lines

```js
//   swaps (staff-recipient types) — the accept/decline + "my posted swaps"
//     cards live on the personal dashboard, not /schedule. That dashboard
//     moved off Home onto its own Dashboard tab in HOME-LOC.7.
```

with

```js
//   swaps (staff-recipient types, incl. the swap_open_pool broadcast) — the
//     accept/decline, "Open swaps you can take" + "my posted swaps" cards live
//     on the personal dashboard, not /schedule. That dashboard moved off Home
//     onto its own Dashboard tab in HOME-LOC.7.
```

3b. Directly under the `isSafeId` line (line 40) add:

```js
// The team-approvals inbox, focused on one item when its id is URL-safe.
// Exported because the Studio tab's pending rows open the same place the
// manager pushes do (COVERLOOP.2): one spelling of the route, one guard.
export function teamApprovalRoute(id) {
  return isSafeId(id) ? `/approvals?tab=team&focus=${id}` : '/approvals?tab=team'
}
```

3c. In the swaps block of the `switch`, add the new case and use the helper:

```js
    // ── Shift swaps (schedule/swaps routes) ─────────────────────────
    case 'swap_inbound':   // targeted at me — respond on the dashboard
    case 'swap_open_pool': // a colleague needs cover — claim it on the dashboard
    case 'swap_claimed':   // my posted shift was claimed
    case 'swap_accepted':  // my targeted swap was accepted
    case 'swap_withdrawn': // taker withdrew — my shift is open again
    case 'swap_declined':  // my targeted swap was declined
      return '/(tabs)/dashboard'
    case 'swap_open':      // manager: open swap posted (and the T-48h/T-12h reminder)
    case 'swap_awaiting':  // manager: swap awaiting approval
      return teamApprovalRoute(data.swap_id)
```

3d. Use the helper in the three other cases that spell the same expression, so there is one spelling:

```js
    case 'time_off_inbound': // manager: new request
      return teamApprovalRoute(data.request_id)
```

```js
    case 'host_event_review': // admin: a host submitted an event for review
      return teamApprovalRoute(data.event_id)
```

```js
    case 'expense_submitted': // owner: awaiting approval
      return teamApprovalRoute(data.claim_id)
```

Leave `agent_request` alone: it goes to `tab=customers`.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run mobile/lib/notification-nav.test.js mobile/lib/widget-push-reload.test.js`
Expected: both green. (`widget-push-reload.test.js:39` already lists `swap_open_pool` as a type that must NOT reload the approvals widget; it must stay green untouched.)

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/notification-nav.js mobile/lib/notification-nav.test.js
git commit -m "COVERLOOP.2 — the swap_open_pool tap opens the Dashboard; one teamApprovalRoute helper"
```

---

### Task 2: API — swap-shift embeds carry the block's times (`GET /api/schedule/swaps`)

**Files:**
- Modify: `src/lib/roster-read.js` (`swapShiftShape`, lines 58-74)
- Modify: `src/lib/roster-read.test.js` (inside `describe('swapShiftShape', ...)`, after line 86)

The embed already selects the block's `start_time, end_time` (`SWAP_SHIFT_EMBED`, `src/app/api/schedule/swaps/route.js:28-35`), so only the shaper changes. `slimSwapForCoach` spreads the shift (`route.js:136`), so the new keys reach coaches too. Existing assertions use `toMatchObject`, so an additive key breaks nothing.

- [ ] **Step 1: Write the failing test** (add inside the `swapShiftShape` describe)

```js
  // COVERLOOP.2 — start_time_override collapses the requester's personal paid
  // window AND a block-vs-template deviation, so a client cannot tell them
  // apart. The taker works the BLOCK's hours (a moved shift loses its
  // overrides, SWAP_MOVE_CLEARS), so the block's times ride along under the
  // same keys toApiShiftRow uses.
  it('carries the block times beside the collapsed override', () => {
    const shaped = swapShiftShape({
      id: 'a3', profile_id: 'p3', status: 'scheduled', notes: null,
      start_time_override: '06:15:00', end_time_override: null,
      shift_blocks: {
        block_date: '2026-09-24', start_time: '06:00:00', end_time: '07:00:00',
        shift_templates: { name: 'Morning', start_time: '06:00:00', end_time: '07:00:00' },
      },
      profiles: null,
    })
    expect(shaped.block_start_time).toBe('06:00:00')
    expect(shaped.block_end_time).toBe('07:00:00')
    // unchanged: the requester's own window is still what the override says
    expect(shaped.start_time_override).toBe('06:15:00')
  })

  it('block times are null, never undefined, when the block embed is missing', () => {
    const shaped = swapShiftShape({ id: 'a4', profile_id: 'p4', status: 'scheduled' })
    expect(shaped.block_start_time).toBeNull()
    expect(shaped.block_end_time).toBeNull()
  })
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-read.test.js`
Expected: 2 failed, `expected undefined to be '06:00:00'` and `expected undefined to be null`.

- [ ] **Step 3: Minimal implementation.** In `swapShiftShape`, add two lines after `shift_date`:

```js
    shift_date: b.block_date ?? null,
    // COVERLOOP.2 — the block's own times, same keys as toApiShiftRow. The
    // taker works these (a moved shift loses its overrides).
    block_start_time: b.start_time ?? null,
    block_end_time: b.end_time ?? null,
    start_time_override: effectiveOverride(a.start_time_override, b.start_time, tpl.start_time),
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-read.test.js src/app/api/schedule/swaps/route.get.test.js`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-read.js src/lib/roster-read.test.js
git commit -m "COVERLOOP.2 — swap-shift embeds carry the block's times (what the taker would work)"
```

---

### Task 3: API — the caller's own shifts say whether a swap is open (`GET /api/schedule/shifts`)

**Files:**
- Create: `src/lib/shift-open-swaps.js`
- Create: `src/lib/shift-open-swaps.test.js`
- Modify: `src/app/api/schedule/shifts/route.js` (imports lines 1-5; the success return, lines 53-55)
- Modify: `src/app/api/schedule/shifts/route.test.js`
- Modify: `src/lib/openapi.js` (line 4322)

A new module, not `roster-read.js`: `route.test.js:22` mocks `@/lib/roster-read` with ONLY `fetchApiShiftRows`, so a new export imported from there would be `undefined` under that mock.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/shift-open-swaps.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn() }))
const { logWarn } = await import('./log')
const { annotateOwnOpenSwaps, fetchOwnOpenSwaps } = await import('./shift-open-swaps')

const rows = [
  { id: 'a1', profile_id: 'me' },
  { id: 'a2', profile_id: 'me' },
  { id: 'a3', profile_id: 'colleague' },
]

describe('annotateOwnOpenSwaps', () => {
  it.each([
    { name: 'a pending swap on my shift', swaps: [{ requester_shift_id: 'a1', status: 'pending' }], expected: ['pending', null, null] },
    { name: 'a claimed swap on my shift', swaps: [{ requester_shift_id: 'a2', status: 'awaiting_approval' }], expected: [null, 'awaiting_approval', null] },
    { name: 'a decided swap is not open', swaps: [{ requester_shift_id: 'a1', status: 'approved' }], expected: [null, null, null] },
    // COACHSCOPE.1 — a swap between colleagues is not the viewer's to see.
    { name: "never a colleague's row, even if a swap names it", swaps: [{ requester_shift_id: 'a3', status: 'pending' }], expected: [null, null, null] },
    { name: 'a swap whose shift was deleted (NULL id)', swaps: [{ requester_shift_id: null, status: 'pending' }], expected: [null, null, null] },
    { name: 'no swaps', swaps: [], expected: [null, null, null] },
    { name: 'an unreadable swap list', swaps: null, expected: [null, null, null] },
  ])('$name', ({ swaps, expected }) => {
    expect(annotateOwnOpenSwaps(rows, swaps, 'me').map((r) => r.open_swap_status)).toEqual(expected)
  })

  it('keeps every other field and does not mutate its input', () => {
    const out = annotateOwnOpenSwaps(rows, [{ requester_shift_id: 'a1', status: 'pending' }], 'me')
    expect(out[0]).toEqual({ id: 'a1', profile_id: 'me', open_swap_status: 'pending' })
    expect(rows[0]).toEqual({ id: 'a1', profile_id: 'me' })
  })

  it('no viewer: every row is null', () => {
    expect(annotateOwnOpenSwaps(rows, [{ requester_shift_id: 'a1', status: 'pending' }], null).map((r) => r.open_swap_status)).toEqual([null, null, null])
  })
})

function mockDb(result) {
  const q = { table: null, select: null, filters: [] }
  const b = {
    select: (c) => { q.select = c; return b },
    eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
    in: (c, v) => { q.filters.push(['in', c, v]); return b },
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  }
  return { q, from: (t) => { q.table = t; return b } }
}

describe('fetchOwnOpenSwaps', () => {
  beforeEach(() => logWarn.mockClear())

  it('reads only the caller\'s own OPEN swaps', async () => {
    const db = mockDb({ data: [{ requester_shift_id: 'a1', status: 'pending' }], error: null })
    expect(await fetchOwnOpenSwaps(db, 'me')).toEqual([{ requester_shift_id: 'a1', status: 'pending' }])
    expect(db.q.table).toBe('shift_swap_requests')
    expect(db.q.select).toBe('requester_shift_id, status')
    expect(db.q.filters).toEqual([['eq', 'requester_id', 'me'], ['in', 'status', ['pending', 'awaiting_approval']]])
  })

  it('a failed read is an empty list and a warning: the roster must still load', async () => {
    const db = mockDb({ data: null, error: { message: 'boom' } })
    expect(await fetchOwnOpenSwaps(db, 'me')).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('schedule', expect.any(String), expect.objectContaining({ err: 'boom' }))
  })

  it('no caller id: no query', async () => {
    const db = mockDb({ data: [], error: null })
    expect(await fetchOwnOpenSwaps(db, null)).toEqual([])
    expect(db.q.table).toBeNull()
  })
})
```

In `src/app/api/schedule/shifts/route.test.js`, add directly under the `vi.mock('@/lib/roster-read', ...)` line:

```js
// COVERLOOP.2 — keep the real annotate (pure); stub only the read.
vi.mock('@/lib/shift-open-swaps', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchOwnOpenSwaps: vi.fn(() => Promise.resolve([])),
}))
```

add under `const { fetchApiShiftRows } = await import('@/lib/roster-read')`:

```js
const { fetchOwnOpenSwaps } = await import('@/lib/shift-open-swaps')
```

and append a new `describe`:

```js
// COVERLOOP.2 — the Schedule tab's "Swap pending" chip reads open_swap_status.
describe('GET /api/schedule/shifts — open_swap_status', () => {
  it("marks the caller's own shift that has an open swap, and nobody else's", async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] })
    fetchApiShiftRows.mockResolvedValueOnce({ rows: [{ id: 'a1', profile_id: 'c' }, { id: 'a2', profile_id: 'other' }], error: null })
    fetchOwnOpenSwaps.mockResolvedValueOnce([
      { requester_shift_id: 'a1', status: 'pending' },
      { requester_shift_id: 'a2', status: 'pending' },
    ])

    const res = await GET(req())
    const body = await res.json()

    expect(fetchOwnOpenSwaps).toHaveBeenCalledWith(expect.anything(), 'c')
    expect(body.data).toEqual([
      { id: 'a1', profile_id: 'c', open_swap_status: 'pending' },
      { id: 'a2', profile_id: 'other', open_swap_status: null },
    ])
  })
})
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/lib/shift-open-swaps.test.js src/app/api/schedule/shifts/route.test.js`
Expected: both files fail to LOAD (0 tests run) because the module does not exist yet: `Failed to resolve import "./shift-open-swaps"` in the first, and the same complaint about `@/lib/shift-open-swaps` (raised from the `vi.mock` factory's `importOriginal()`) in the second.

- [ ] **Step 3: Minimal implementation**

```js
// src/lib/shift-open-swaps.js
//
// COVERLOOP.2 — "does this shift of MINE have an open swap?" for
// GET /api/schedule/shifts, so the phone's Schedule tab can chip the row and
// stop offering a second post (the route 409s one: mig 599's
// one-open-swap-per-shift index).
//
// Own rows only. A targeted swap between two colleagues is not visible to
// other coaches (COACHSCOPE.1), and this feed also serves the Team view.

import { logWarn } from './log'

const OPEN_SWAP_STATUSES = ['pending', 'awaiting_approval']

/**
 * @param {Array<object>} rows     toApiShiftRow() results (id = the assignment id)
 * @param {Array<{requester_shift_id:string|null,status:string}>|null} swaps
 * @param {string|null} viewerId
 * @returns {Array<object>} new rows, each with open_swap_status: 'pending' | 'awaiting_approval' | null
 */
export function annotateOwnOpenSwaps(rows, swaps, viewerId) {
  const byShift = new Map()
  for (const s of swaps || []) {
    if (s?.requester_shift_id && OPEN_SWAP_STATUSES.includes(s.status)) byShift.set(s.requester_shift_id, s.status)
  }
  return (rows || []).map((r) => ({
    ...r,
    open_swap_status: viewerId && r.profile_id === viewerId ? (byShift.get(r.id) ?? null) : null,
  }))
}

/**
 * The caller's own open swaps. Scoped by requester_id (a per-user row: the
 * owner check IS the access rule). Never throws and never fails the roster: a
 * failed read is an empty list, which only costs the chip.
 */
export async function fetchOwnOpenSwaps(db, requesterId) {
  if (!requesterId) return []
  const { data, error } = await db.from('shift_swap_requests')
    .select('requester_shift_id, status')
    .eq('requester_id', requesterId)
    .in('status', OPEN_SWAP_STATUSES)
  if (error) {
    logWarn('schedule', 'own open swaps read failed; shifts returned without open_swap_status', { err: error.message })
    return []
  }
  return data || []
}
```

In `src/app/api/schedule/shifts/route.js` add the import under the `fetchApiShiftRows` import:

```js
import { fetchOwnOpenSwaps, annotateOwnOpenSwaps } from '@/lib/shift-open-swaps'
```

and replace the last two statements of `GET` (the `if (error) ...` line stays; only the final `return` changes):

```js
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // COVERLOOP.2 — the caller's OWN rows say whether a swap is open on them
  // (the phone's "Swap pending" chip). One read, keyed on the caller.
  const ownOpenSwaps = await fetchOwnOpenSwaps(db, user.id)
  return NextResponse.json({ success: true, data: annotateOwnOpenSwaps(rows, ownOpenSwaps, user.id) })
```

In `src/lib/openapi.js` line 4322, append one sentence to the END of the `/api/schedule/shifts` description string, just before its closing `"`. The string currently ends `...(The legacy create / update / delete shift endpoints were retired — use the block-based assignment routes.)"`; make it end:

```
(The legacy create / update / delete shift endpoints were retired — use the block-based assignment routes.) Each row also carries open_swap_status: 'pending' or 'awaiting_approval' when the CALLER has an open swap request on that shift of their own, otherwise null (never set on a colleague's row)."
```

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/lib/shift-open-swaps.test.js src/app/api/schedule/shifts/route.test.js src/lib/openapi.test.js`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shift-open-swaps.js src/lib/shift-open-swaps.test.js src/app/api/schedule/shifts/route.js src/app/api/schedule/shifts/route.test.js src/lib/openapi.js
git commit -m "COVERLOOP.2 — GET /api/schedule/shifts marks the caller's own shifts that have an open swap"
```

---

### Task 4: The Dashboard's posted swaps carry the block's times

**Files:**
- Modify: `shared/dashboard-data.js` (the `shift_swap_requests` select inside `fetchPersonalDashboardData`, ~line 214)
- Modify: `shared/dashboard-data.test.js` (inside the same `describe` as `reads posted swaps only, and returns no pendingSwapsForMe`, ~line 456)

This is an existing RLS-scoped read of the coach's OWN swap (not a new mobile-direct read), and the same client already reads `shift_blocks.start_time/end_time` a few lines up (`fetchDashboardShifts`). Web's `MyRequests.jsx` reads the same rows and ignores extra keys.

- [ ] **Step 1: Write the failing test** (add directly after the `reads posted swaps only...` test)

```js
  // COVERLOOP.2 — "Swap posted" printed a raw ISO date and no time because the
  // embed never asked for the block's times.
  it('asks for the posted swap\'s block times', async () => {
    const selects = []
    const base = makePersonalDb({})
    const db = {
      from(table) {
        const b = base.from(table)
        const sel = b.select
        b.select = function (cols) { selects.push([table, cols]); return sel.call(this) }
        return b
      },
    }
    await fetchPersonalDashboardData(db, 'p1')
    const swapSelect = selects.find(([t]) => t === 'shift_swap_requests')[1]
    expect(swapSelect).toContain('shift_blocks!block_id(block_date, start_time, end_time, shift_templates(name))')
    // MOBILESCHED.2's guard still holds.
    expect(swapSelect).not.toMatch(/requester_id,/)
  })
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/dashboard-data.test.js`
Expected: 1 failed, `expected '...shift_blocks!block_id(block_date, shift_templates(name))...' to contain 'shift_blocks!block_id(block_date, start_time, end_time, shift_templates(name))'`.

- [ ] **Step 3: Minimal implementation.** In `shared/dashboard-data.js` change only the embed inside that one `.select(...)` string:

```js
        .select('id, status, reason, created_at, target_id, requester_shift_id, requester_shift:shift_assignments!requester_shift_id(shift_blocks!block_id(block_date, start_time, end_time, shift_templates(name)))')
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run shared/dashboard-data.test.js`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add shared/dashboard-data.js shared/dashboard-data.test.js
git commit -m "COVERLOOP.2 — posted swaps on the dashboard carry the block's times"
```

---

### Task 5: `mobile/lib/swap-cards.js` — every card, confirm and chip decision

**Files:**
- Create: `mobile/lib/swap-cards.js`
- Create: `mobile/lib/swap-cards.test.js`

Signatures you depend on: `effectiveShiftStart(shift)` / `effectiveShiftEnd(shift)` from `shared/roster-month` (`shared/roster-month.js:52-57`): override, then `block_start_time`, then `start_time`, then the template's. Import it as the bare package `'shared/roster-month'`, never `../../shared` (Metro will not resolve that; `check:mobile-imports` guards the names).

- [ ] **Step 1: Write the failing tests**

```js
// mobile/lib/swap-cards.test.js
// COVERLOOP.2 — what the phone's swap surfaces say and decide. Pure: there is
// no React Native component test runner, so the components only render these.
import { describe, it, expect } from 'vitest'
import {
  swapDayLabel, swapShiftWhen, postedSwapShift, swapReasonForPost, swapConfirmCopy, swapPostedCopy,
  hasOpenSwap, annotateOpenSwaps,
  SWAP_PENDING_LABEL, SWAP_PICKER_TITLE, SWAP_PICKER_EMPTY, SWAP_ALREADY_OPEN_MESSAGE, SWAP_REASON_MAX,
} from './swap-cards'

// 2026-09-24 is a Thursday.
const tpl = { name: 'Morning', start_time: '06:00:00', end_time: '07:00:00' }

describe('swapDayLabel', () => {
  it.each([
    ['2026-09-24', 'Thu 24 Sep'],
    ['2099-01-01', 'Thu 1 Jan'],
    ['2026-10-25', 'Sun 25 Oct'], // clocks-back day: a calendar date has no timezone
    ['2026-02-31', ''],
    ['next week', ''],
    [undefined, ''],
  ])('%s -> "%s"', (iso, expected) => {
    expect(swapDayLabel(iso)).toBe(expected)
  })
})

describe('swapShiftWhen', () => {
  it.each([
    {
      name: "the BLOCK's hours, not the requester's personal 06:15 paid window (the taker works the block)",
      shift: { shift_date: '2026-09-24', block_start_time: '06:00:00', block_end_time: '07:00:00', start_time_override: '06:15:00', end_time_override: null, shift_templates: tpl },
      expected: 'Thu 24 Sep · 06:00-07:00',
    },
    {
      name: 'an older API with no block_* keys: the collapsed override (a block moved off its template)',
      shift: { shift_date: '2026-09-24', start_time_override: '07:30:00', end_time_override: '08:30:00', shift_templates: { name: 'Early', start_time: '08:00:00', end_time: '09:00:00' } },
      expected: 'Thu 24 Sep · 07:30-08:30',
    },
    {
      name: 'nothing but the template',
      shift: { shift_date: '2026-09-24', start_time_override: null, end_time_override: null, shift_templates: tpl },
      expected: 'Thu 24 Sep · 06:00-07:00',
    },
    { name: 'a date and no times', shift: { shift_date: '2026-09-24' }, expected: 'Thu 24 Sep' },
    { name: 'times and no date', shift: { block_start_time: '06:00:00', block_end_time: '07:00:00' }, expected: '06:00-07:00' },
    { name: 'half a time range is no time range', shift: { shift_date: '2026-09-24', block_start_time: '06:00:00' }, expected: 'Thu 24 Sep' },
    { name: 'a detached shift (mig 603 NULLed it)', shift: null, expected: '' },
  ])('$name', ({ shift, expected }) => {
    expect(swapShiftWhen(shift)).toBe(expected)
  })

  it('never prints a raw ISO date', () => {
    expect(swapShiftWhen({ shift_date: '2026-09-24', shift_templates: tpl })).not.toContain('2026-')
  })
})

describe('postedSwapShift', () => {
  it("maps the dashboard's posted-swap row onto the shift shape swapShiftWhen reads", () => {
    const swap = { id: 's1', requester_shift: { shift_blocks: { block_date: '2026-09-24', start_time: '06:00:00', end_time: '07:00:00', shift_templates: { name: 'Morning' } } } }
    expect(postedSwapShift(swap)).toEqual({
      shift_date: '2026-09-24', block_start_time: '06:00:00', block_end_time: '07:00:00', shift_templates: { name: 'Morning' },
    })
    expect(swapShiftWhen(postedSwapShift(swap))).toBe('Thu 24 Sep · 06:00-07:00')
  })
  it('a swap whose shift is gone gives an empty label, not a crash', () => {
    expect(swapShiftWhen(postedSwapShift({ id: 's1', requester_shift: null }))).toBe('')
  })
})

describe('swapReasonForPost', () => {
  it.each([
    ['  physio appointment  ', 'physio appointment'],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
    [42, null],
  ])('%j -> %j', (input, expected) => {
    expect(swapReasonForPost(input)).toBe(expected)
  })
  it('caps at the API limit (SwapCreateSchema: max 2000) instead of earning a 400', () => {
    expect(SWAP_REASON_MAX).toBe(2000)
    expect(swapReasonForPost('x'.repeat(2500))).toHaveLength(2000)
  })
})

describe('swapConfirmCopy', () => {
  const shift = { shift_date: '2026-09-24', block_start_time: '06:00:00', block_end_time: '07:00:00', shift_templates: tpl }

  it('a targeted request names the coach, the shift and when', () => {
    expect(swapConfirmCopy({ shift, coach: { id: 'c1', full_name: 'Coach T' } })).toEqual({
      title: 'Ask a coach to cover',
      message: 'Ask Coach T to take Morning on Thu 24 Sep · 06:00-07:00? They can accept or decline, then a manager approves it.',
      reasonHint: 'Shown to the coach you ask and to your manager.',
      cta: 'Send request',
    })
  })

  it('an open post says who is told', () => {
    expect(swapConfirmCopy({ shift, coach: null })).toEqual({
      title: 'Post for swap',
      message: 'Post Morning on Thu 24 Sep · 06:00-07:00 for another coach to take? Coaches who can cover it and your managers are told, and a manager approves whoever takes it.',
      reasonHint: 'Shown to your manager only.',
      cta: 'Post shift',
    })
  })

  it('degrades without a name, a template or a date', () => {
    expect(swapConfirmCopy({ shift: {}, coach: { id: 'c1', full_name: null } }).message)
      .toBe('Ask this coach to take this shift? They can accept or decline, then a manager approves it.')
    expect(swapConfirmCopy({ shift: null, coach: null }).message)
      .toBe('Post this shift for another coach to take? Coaches who can cover it and your managers are told, and a manager approves whoever takes it.')
  })
})

describe('swapPostedCopy', () => {
  it('targeted', () => {
    expect(swapPostedCopy({ full_name: 'Coach T' })).toEqual({ title: 'Request sent', message: 'Coach T has been asked to take this shift.' })
    expect(swapPostedCopy({ full_name: '' }).message).toBe('They have been asked to take this shift.')
  })
  it('open', () => {
    expect(swapPostedCopy(null)).toEqual({ title: 'Posted', message: 'Coaches who can cover it and your managers have been notified.' })
  })
})

describe('hasOpenSwap', () => {
  it.each([
    [{ open_swap_status: 'pending' }, true],
    [{ open_swap_status: 'awaiting_approval' }, true],
    [{ open_swap_status: 'approved' }, false],
    [{ open_swap_status: null }, false],
    [{}, false],
    [null, false],
  ])('%j -> %s', (shift, expected) => {
    expect(hasOpenSwap(shift)).toBe(expected)
  })
})

describe('annotateOpenSwaps', () => {
  const shifts = [{ id: 'a1', shift_date: '2026-09-24' }, { id: 'a2', shift_date: '2026-09-25' }]

  it('joins a dashboard shift (id = assignment id) to my posted swap on it', () => {
    const out = annotateOpenSwaps(shifts, [{ id: 's1', status: 'awaiting_approval', requester_shift_id: 'a2' }])
    expect(out.map((s) => s.open_swap_status)).toEqual([null, 'awaiting_approval'])
    expect(out[0]).toEqual({ id: 'a1', shift_date: '2026-09-24', open_swap_status: null })
  })
  it('ignores decided swaps and detached ones', () => {
    const out = annotateOpenSwaps(shifts, [{ status: 'cancelled', requester_shift_id: 'a1' }, { status: 'pending', requester_shift_id: null }])
    expect(out.map((s) => s.open_swap_status)).toEqual([null, null])
  })
  it('does not mutate, and survives non-arrays', () => {
    annotateOpenSwaps(shifts, [{ status: 'pending', requester_shift_id: 'a1' }])
    expect(shifts[0]).toEqual({ id: 'a1', shift_date: '2026-09-24' })
    expect(annotateOpenSwaps(null, null)).toEqual([])
    expect(annotateOpenSwaps(shifts, undefined).map((s) => s.open_swap_status)).toEqual([null, null])
  })
})

describe('labels', () => {
  it('are the agreed strings', () => {
    expect(SWAP_PENDING_LABEL).toBe('Swap pending')
    expect(SWAP_PICKER_TITLE).toBe('Ask a coach to cover')
    expect(SWAP_PICKER_EMPTY).toBe('No other coaches at this studio to ask.')
    expect(SWAP_ALREADY_OPEN_MESSAGE).toBe('A swap request is already open for this shift. You can cancel it under My requests on the Dashboard tab.')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run mobile/lib/swap-cards.test.js`
Expected: `Failed to resolve import "./swap-cards"`.

- [ ] **Step 3: Minimal implementation**

```js
// mobile/lib/swap-cards.js
//
// COVERLOOP.2 — what the phone's swap surfaces SAY and DECIDE: the when-line on
// a swap card, the confirm step's wording, the reason that is POSTed, and
// whether a shift carries the "Swap pending" chip. Pure — no React Native — so
// it is vitest-testable (there is no RN component test runner). Callers:
// components/dashboard/PersonalDashboard.jsx, components/dashboard/
// StudioDashboard.jsx, components/schedule/SwapConfirmSheet.jsx and
// app/(staff)/(tabs)/schedule.jsx.

import { effectiveShiftStart, effectiveShiftEnd } from 'shared/roster-month'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const OPEN_SWAP_STATUSES = ['pending', 'awaiting_approval']

export const SWAP_PENDING_LABEL = 'Swap pending'
export const SWAP_PICKER_TITLE = 'Ask a coach to cover'
export const SWAP_PICKER_EMPTY = 'No other coaches at this studio to ask.'
export const SWAP_ALREADY_OPEN_MESSAGE = 'A swap request is already open for this shift. You can cancel it under My requests on the Dashboard tab.'
// SwapCreateSchema (src/app/api/schedule/swaps/route.js): reason max 2000.
export const SWAP_REASON_MAX = 2000

/**
 * 'YYYY-MM-DD' -> 'Thu 24 Sep'. shift_date is a Dublin wall-clock CALENDAR
 * date: the weekday comes from its parts in UTC, so neither the handset's
 * timezone nor Hermes's Intl support can move or break it. '' if malformed.
 */
export function swapDayLabel(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return ''
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[mo - 1]}`
}

const hhmm = (t) => String(t || '').slice(0, 5)

/**
 * The when-line of a swap card: 'Thu 24 Sep · 06:00-07:00'.
 *
 * The BLOCK's hours when the row carries them (block_start_time, since
 * COVERLOOP.2): a shift that changes hands loses the previous coach's paid-
 * window override, so the block's hours are what the taker works. An older API
 * response has no block_* keys; then the collapsed override / template applies,
 * which is what effectiveShiftStart resolves.
 */
export function swapShiftWhen(shift) {
  const day = swapDayLabel(shift?.shift_date)
  const start = hhmm(shift?.block_start_time || effectiveShiftStart(shift))
  const end = hhmm(shift?.block_end_time || effectiveShiftEnd(shift))
  const times = start && end ? `${start}-${end}` : ''
  return [day, times].filter(Boolean).join(' · ')
}

/**
 * The dashboard's posted-swap row (shared/dashboard-data.js: requester_shift.
 * shift_blocks { block_date, start_time, end_time, shift_templates }) as the
 * shift shape swapShiftWhen reads.
 */
export function postedSwapShift(swap) {
  const b = swap?.requester_shift?.shift_blocks || {}
  return {
    shift_date: b.block_date ?? null,
    block_start_time: b.start_time ?? null,
    block_end_time: b.end_time ?? null,
    shift_templates: b.shift_templates ?? null,
  }
}

/** The reason as it is POSTed: trimmed, capped, null when blank. */
export function swapReasonForPost(text) {
  if (typeof text !== 'string') return null
  const t = text.trim().slice(0, SWAP_REASON_MAX)
  return t || null
}

/**
 * The confirm step. `coach` set = a targeted request; null = an open post.
 * reasonHint is true to the API: a coach who is not party to a swap never sees
 * its reason (slimSwapForCoach), the named target and any reviewer do.
 */
export function swapConfirmCopy({ shift, coach }) {
  const name = shift?.shift_templates?.name || 'this shift'
  const when = swapShiftWhen(shift)
  const what = when ? `${name} on ${when}` : name
  if (coach) {
    return {
      title: SWAP_PICKER_TITLE,
      message: `Ask ${coach.full_name || 'this coach'} to take ${what}? They can accept or decline, then a manager approves it.`,
      reasonHint: 'Shown to the coach you ask and to your manager.',
      cta: 'Send request',
    }
  }
  return {
    title: 'Post for swap',
    message: `Post ${what} for another coach to take? Coaches who can cover it and your managers are told, and a manager approves whoever takes it.`,
    reasonHint: 'Shown to your manager only.',
    cta: 'Post shift',
  }
}

/** The alert after a successful POST. */
export function swapPostedCopy(coach) {
  if (coach) return { title: 'Request sent', message: `${coach.full_name || 'They'} ${coach.full_name ? 'has' : 'have'} been asked to take this shift.` }
  return { title: 'Posted', message: 'Coaches who can cover it and your managers have been notified.' }
}

/** Does this shift row carry an open swap? (open_swap_status: see below.) */
export function hasOpenSwap(shift) {
  return OPEN_SWAP_STATUSES.includes(shift?.open_swap_status)
}

/**
 * Dashboard shifts + my posted swaps -> the same open_swap_status field
 * GET /api/schedule/shifts puts on the Schedule tab's rows. A dashboard
 * shift's id IS the assignment id (shared/dashboard-data.js), which is what
 * a swap's requester_shift_id names.
 */
export function annotateOpenSwaps(shifts, postedSwaps) {
  const byShift = new Map()
  for (const s of Array.isArray(postedSwaps) ? postedSwaps : []) {
    if (s?.requester_shift_id && OPEN_SWAP_STATUSES.includes(s.status)) byShift.set(s.requester_shift_id, s.status)
  }
  return (Array.isArray(shifts) ? shifts : []).map((sh) => ({ ...sh, open_swap_status: byShift.get(sh.id) ?? null }))
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run mobile/lib/swap-cards.test.js`
Expected: green. Then prove the date code reads no host timezone: `TZ=America/Los_Angeles npx vitest run mobile/lib/swap-cards.test.js` must be green too.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/swap-cards.js mobile/lib/swap-cards.test.js
git commit -m "COVERLOOP.2 — swap-cards: when-line, confirm copy, posted reason, open-swap chip state"
```

---

### Task 6: Claim warnings, in the web's words

**Files:**
- Modify: `mobile/lib/swap-conflicts.js` (append)
- Modify: `mobile/lib/swap-conflicts.test.js` (import on lines 5-7; append a `describe`)

What the server sends on a claim / accept: `{ success: true, data, warnings: string[] }` (`src/app/api/schedule/swaps/[id]/route.js:202-217`), each string a finished sentence ("You have approved holiday ..."). What web renders: the heading `Sent to your manager. Heads up:` then one line per warning (`src/components/dashboard/SwapActions.jsx:133-138`). `mobile/lib/api.js` passes the JSON body through untouched, so `res.warnings` is there.

- [ ] **Step 1: Write the failing tests.** Change the import to:

```js
import {
  SWAP_CONFLICTS_CODE, isSwapConflictRefusal, swapConflictLines, swapConflictPrompt,
  SWAP_CLAIM_NOTICE_HEADING, swapClaimNotice,
} from './swap-conflicts'
```

Append:

```js
// COVERLOOP.2 — a claim/accept that SUCCEEDS can still carry advisory
// warnings (the claiming coach's own leave / same-day clash). Web shows them;
// the phone dropped them.
describe('swapClaimNotice', () => {
  const LEAVE_WARNING = 'You have approved holiday on 2026-09-24, which covers the shift on 2026-09-24.'
  const CLASH_WARNING = 'You are already on Open 09:00 to 10:30 at Stillorgan on 2026-09-24, which overlaps the shift (10:00 to 11:00).'

  it('uses the heading the web Today page uses (mobile cannot import it)', () => {
    const src = readFileSync(join(__dirname, '../../src/components/dashboard/SwapActions.jsx'), 'utf8')
    expect(src).toContain(SWAP_CLAIM_NOTICE_HEADING)
  })

  it('titles the alert with that heading and lists every sentence on its own line', () => {
    expect(swapClaimNotice({ success: true, data: {}, warnings: [LEAVE_WARNING, CLASH_WARNING] })).toEqual({
      title: 'Sent to your manager. Heads up:',
      message: `${LEAVE_WARNING}\n${CLASH_WARNING}`,
      lines: [LEAVE_WARNING, CLASH_WARNING],
    })
  })

  it.each([
    ['no warnings key', { success: true, data: {} }],
    ['an empty list', { success: true, warnings: [] }],
    ['only blanks and non-strings', { success: true, warnings: ['', '  ', null, 7] }],
    ['a FAILED response (its error is shown instead)', { success: false, error: 'nope', warnings: [LEAVE_WARNING] }],
    ['null', null],
  ])('says nothing for %s', (_name, res) => {
    expect(swapClaimNotice(res)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run mobile/lib/swap-conflicts.test.js`
Expected: the existing tests pass; the new ones fail with `swapClaimNotice is not a function` and `expected '...' to contain undefined`.

- [ ] **Step 3: Minimal implementation** (append to `mobile/lib/swap-conflicts.js`)

```js
// ─────────────────────────────────────────────────────────────────────────
// COVERLOOP.2 — the CLAIM side. A coach's claim / accept succeeds and is
// saved even when they are on approved leave or already on an overlapping
// shift that day; the response then carries `warnings`, finished sentences
// about the claiming coach only. Advisory: the manager's approval is where it
// is enforced. The web Today page (src/components/dashboard/SwapActions.jsx)
// shows them under this heading; the phone uses the same words, pinned by a
// test that reads that file.
// ─────────────────────────────────────────────────────────────────────────
export const SWAP_CLAIM_NOTICE_HEADING = 'Sent to your manager. Heads up:'

/**
 * @param {object} res  the api() result of a claim / accept
 * @returns {null | { title: string, message: string, lines: string[] }}
 */
export function swapClaimNotice(res) {
  if (!res || res.success !== true || !Array.isArray(res.warnings)) return null
  const lines = res.warnings.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim())
  if (lines.length === 0) return null
  return { title: SWAP_CLAIM_NOTICE_HEADING, message: lines.join('\n'), lines }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run mobile/lib/swap-conflicts.test.js`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/swap-conflicts.js mobile/lib/swap-conflicts.test.js
git commit -m "COVERLOOP.2 — swapClaimNotice: claim warnings in the web's wording"
```

---

### Task 7: `CoachPickerSheet` takes a title; new `SwapConfirmSheet`

**Files:**
- Modify: `mobile/components/schedule/CoachPickerSheet.jsx` (lines 8, 16, 22)
- Create: `mobile/components/schedule/SwapConfirmSheet.jsx`

No failing-test step: these are JSX, and there is no RN component test runner. The strings and decisions they render were tested in Task 5.

- [ ] **Step 1: `CoachPickerSheet` props.** Three edits; the defaults are today's strings, so `mobile/components/schedule/ManageMode.jsx:163` needs no change and the manager's sheet still reads "Add coach".

Line 8, the signature:

```jsx
export default function CoachPickerSheet({ visible, block, locationId, staff, loading, onPick, onClose, title = 'Add coach', emptyText = 'No available coaches to add.' }) {
```

Line 16, the heading:

```jsx
            <Text className="text-lg font-bold text-un1t-text">{title}{block?.shift_templates?.name ? ` · ${block.shift_templates.name}` : ''}</Text>
```

Line 22, the empty state:

```jsx
            <Text className="text-sm text-un1t-subtle py-6 text-center">{emptyText}</Text>
```

Also make the file's first comment line true: replace `// Bottom-sheet picker of coaches assignable to a block. Pure-presentational:` with `// Bottom-sheet picker of coaches: "Add coach" for a manager's block (the default), or "Ask a coach to cover" for a coach's targeted swap (title / emptyText props). Pure-presentational:`.

- [ ] **Step 2: Create `mobile/components/schedule/SwapConfirmSheet.jsx`**

```jsx
// COVERLOOP.2 — the confirm step before a swap request is sent (targeted at
// one coach, or posted to the open pool), with the optional reason the API has
// always accepted and the phone never collected.
//
// A sheet, not an Alert: Alert.prompt is iOS-only and the reason needs a text
// field on Android too. Thin on purpose. Every word it shows comes from
// swapConfirmCopy (mobile/lib/swap-cards.js), which is where the tests are:
// there is no React Native component test runner in this repo. The caller
// normalises the reason with swapReasonForPost before POSTing it.
import { useState, useEffect } from 'react'
import {
  View, Text, Pressable, Modal, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SWAP_REASON_MAX } from '../../lib/swap-cards'

export default function SwapConfirmSheet({ visible, copy, sending, onConfirm, onClose }) {
  const [reason, setReason] = useState('')

  // A freshly opened sheet never inherits the last request's reason.
  useEffect(() => { if (visible) setReason('') }, [visible])

  if (!visible || !copy) return null
  return (
    <Modal visible animationType="slide" transparent onRequestClose={sending ? undefined : onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1 justify-end bg-black/50"
      >
        <Pressable className="flex-1" onPress={sending ? undefined : onClose} />
        <View className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl p-5">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-un1t-text">{copy.title}</Text>
            <Pressable onPress={onClose} disabled={sending} hitSlop={10}>
              <Ionicons name="close" size={22} color="#94A3B8" />
            </Pressable>
          </View>

          <Text className="text-sm text-un1t-text mb-4">{copy.message}</Text>

          <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5">Reason (optional)</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. physio appointment"
            placeholderTextColor="#64748B"
            maxLength={SWAP_REASON_MAX}
            multiline
            editable={!sending}
            className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text"
            style={{ minHeight: 72, textAlignVertical: 'top' }}
          />
          <Text className="text-[11px] text-un1t-subtle mt-1 mb-4">{copy.reasonHint}</Text>

          <Pressable
            onPress={() => onConfirm(reason)}
            disabled={sending}
            className="bg-un1t-text active:opacity-80 disabled:opacity-50 px-4 py-3.5 rounded-xl items-center flex-row justify-center"
          >
            {sending ? <ActivityIndicator color="#FFFFFF" /> : null}
            <Text className="text-base font-semibold text-un1t-bg ml-2">{sending ? 'Sending…' : copy.cta}</Text>
          </Pressable>
          <Pressable
            onPress={onClose}
            disabled={sending}
            className="mt-2 active:opacity-70 px-4 py-3 rounded-xl items-center"
          >
            <Text className="text-sm font-medium text-un1t-subtle">Back</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
```

(The Modal / KeyboardAvoidingView / TextInput shape is copied from `AdjustSheet` in `mobile/app/(staff)/(tabs)/schedule.jsx:794-885`, which is the house pattern for a bottom sheet with a text field.)

- [ ] **Step 3: Lint both files**

Run: `npm run check:mobile-lint && npm run check:mobile-imports`
Expected: both exit 0 with no output about these two files. (`check:mobile-imports` is what proves `SWAP_REASON_MAX` really is exported from `mobile/lib/swap-cards.js`: a missing name would be `undefined` at runtime, not a build error.)

- [ ] **Step 4: Commit**

```bash
git add mobile/components/schedule/CoachPickerSheet.jsx mobile/components/schedule/SwapConfirmSheet.jsx
git commit -m "COVERLOOP.2 — CoachPickerSheet takes a title; SwapConfirmSheet collects the reason"
```

---

### Task 8: Wire the Dashboard (`PersonalDashboard.jsx`)

**Files:**
- Modify: `mobile/components/dashboard/PersonalDashboard.jsx`

No failing-test step (JSX). Ten small edits; each quotes the text to find. Do them in order, top of the file to the bottom.

- [ ] **Step 1: Imports.** Directly under the line `import CoachPickerSheet from '../schedule/CoachPickerSheet'` (line 32) add:

```jsx
// COVERLOOP.2 — the confirm step, and every swap-card decision (pure, tested).
import SwapConfirmSheet from '../schedule/SwapConfirmSheet'
import {
  swapShiftWhen, postedSwapShift, swapConfirmCopy, swapPostedCopy, swapReasonForPost,
  hasOpenSwap, annotateOpenSwaps,
  SWAP_PENDING_LABEL, SWAP_PICKER_TITLE, SWAP_PICKER_EMPTY, SWAP_ALREADY_OPEN_MESSAGE,
} from '../../lib/swap-cards'
import { swapClaimNotice } from '../../lib/swap-conflicts'
```

- [ ] **Step 2: The "Swap pending" chip, in BOTH roster renderers.** `WeekPanel` (lines 158-162) and `MonthAgenda` (lines 317-321) each contain this identical block:

```jsx
                        {s.status === 'swapped' && (
                          <View className="ml-2 px-1.5 py-0.5 rounded bg-blue-500/20">
                            <Text className="text-[9px] uppercase text-blue-700 font-semibold">Swapped</Text>
                          </View>
                        )}
```

Directly AFTER it, in both places (keep each place's own indentation), add:

```jsx
                        {hasOpenSwap(s) && (
                          <View className="ml-2 px-1.5 py-0.5 rounded bg-amber-500/20">
                            <Text className="text-[9px] uppercase text-amber-700 font-semibold">{SWAP_PENDING_LABEL}</Text>
                          </View>
                        )}
```

(`bg-amber-500/20` + `text-amber-700` is the pairing the "Awaiting manager" chip lower in this file already uses, so the contrast lint is satisfied.)

- [ ] **Step 3: State.** Under `const [swapStaffLoading, setSwapStaffLoading] = useState(false)` (line 405) add:

```jsx
  // COVERLOOP.2 — the request waiting on the confirm sheet: { shift, coach },
  // coach null = an open post. Nothing is POSTed until the sheet confirms.
  const [swapConfirm, setSwapConfirm] = useState(null)
  const [swapSending, setSwapSending] = useState(false)
```

These MUST sit with the other `useState` calls, above the `if (loading)` early return, or React's hook order breaks.

- [ ] **Step 4: `handleShiftPress`.** Directly under its `if (!shift.id) { ... return }` guard (lines 519-522) add:

```jsx
    // COVERLOOP.2 — one open swap per shift (mig 599). Say so instead of
    // offering a second post that the route would answer with a 409.
    if (hasOpenSwap(shift)) {
      Alert.alert(shift.shift_templates?.name || 'Shift', SWAP_ALREADY_OPEN_MESSAGE)
      return
    }
```

Then replace the two `options.push(...)` blocks that follow (the `'Post for swap'` one with its inline `createSwapRequest`, lines 526-541, and the `'Swap with a specific coach…'` one, lines 543-547) with:

```jsx
    // COVERLOOP.2 — both paths go through the confirm sheet, which collects the
    // optional reason. Nothing is sent from this menu any more.
    options.push({
      text: 'Post for swap',
      onPress: () => setSwapConfirm({ shift, coach: null }),
    })

    // CT-P3b — targeted swap: offer this shift to one chosen colleague.
    options.push({
      text: 'Ask a coach to cover…',
      onPress: () => openSwapPicker(shift),
    })
```

- [ ] **Step 5: `mutateSwap` shows the claim warnings.** Replace its `if (res.success) { ... }` branch (lines 573-575) with:

```jsx
      if (res.success) {
        // COVERLOOP.2 — a claim / accept is saved even when the coach is on
        // approved leave or already on an overlapping shift; the response says
        // so in `warnings`. Web shows them; this used to drop them.
        const notice = swapClaimNotice(res)
        await loadSwaps()
        load()
        if (notice) Alert.alert(notice.title, notice.message)
      } else {
```

- [ ] **Step 6: `pickSwapCoach` confirms instead of sending.** Replace the whole function (lines 598-613) with these two:

```jsx
  // COVERLOOP.2 — picking a colleague used to POST on that one tap. It now
  // opens the confirm sheet; submitSwap is the only place a swap is created.
  function pickSwapCoach(coach) {
    const shift = swapPickerShift
    setSwapPickerShift(null)
    if (!shift) return
    setSwapConfirm({ shift, coach })
  }

  async function submitSwap(reasonText) {
    const pending = swapConfirm
    if (!pending || swapSending) return
    setSwapSending(true)
    try {
      const res = await createSwapRequest({
        requesterShiftId: pending.shift.id,
        targetId: pending.coach?.id,
        reason: swapReasonForPost(reasonText),
        locationId: activeLocation?.id,
      })
      if (res.success) {
        setSwapConfirm(null)
        const done = swapPostedCopy(pending.coach)
        Alert.alert(done.title, done.message)
        load(); loadSwaps()
      } else {
        Alert.alert(pending.coach ? "Couldn't send request" : "Couldn't post", res.error || 'Unknown error')
      }
    } finally {
      setSwapSending(false)
    }
  }
```

(`createSwapRequest` already forwards `reason` as `reason || null`: `mobile/lib/schedule-api.js:66-77`. No change there.)

- [ ] **Step 7: The roster panels get annotated shifts.** `monthMatrix` (lines 626-628) becomes:

```jsx
  // COVERLOOP.2 — join my posted swaps onto the roster rows so a shift with an
  // open swap carries open_swap_status (the chip, and the no-second-post guard).
  const monthMatrix = (monthShifts && monthStartIso && monthEndIso)
    ? buildMonthMatrix(monthStartIso, monthEndIso, annotateOpenSwaps(monthShifts, myPostedSwaps), todayIso)
    : []
```

and in the two `<WeekPanel ...>` elements change `shifts={weekShifts}` to `shifts={annotateOpenSwaps(weekShifts, myPostedSwaps)}` and `shifts={nextWeekShifts}` to `shifts={annotateOpenSwaps(nextWeekShifts, myPostedSwaps)}`.

- [ ] **Step 8: "Swaps offered to you" and "Open swaps you can take" say when.** In the `offered.map` block (lines 707-729) replace

```jsx
              const date = s.requester_shift?.shift_date
```

with

```jsx
              const when = swapShiftWhen(s.requester_shift)
```

and replace

```jsx
                    {date ? (
                      <Text className="text-xs text-un1t-subtle" numberOfLines={1}>{date}</Text>
                    ) : null}
```

with

```jsx
                    {when ? (
                      <Text className="text-xs text-un1t-subtle" numberOfLines={1}>{when}</Text>
                    ) : null}
                    {s.reason ? (
                      <Text className="text-xs text-un1t-subtle italic" numberOfLines={2}>{`Reason: ${s.reason}`}</Text>
                    ) : null}
```

(The API returns `reason` to the named target and hides it from everyone else, `slimSwapForCoach` in `src/app/api/schedule/swaps/route.js:135-144`, so this line only ever shows a reason meant for this reader.)

In the `openPool.map` block (lines 779-800) make the same first two replacements (`const date = ...` -> `const when = swapShiftWhen(s.requester_shift)`, and the `{date ? ... : null}` block -> the `{when ? ... : null}` block). Do NOT add the reason line there: the API nulls it for the open pool.

- [ ] **Step 9: "My requests → Swap posted" says when.** In the `myPostedSwaps.map` block (lines 888-892) replace

```jsx
            const shiftName = s.requester_shift?.shift_blocks?.shift_templates?.name
            const shiftDate = s.requester_shift?.shift_blocks?.block_date
            const subtitle = shiftName && shiftDate
              ? `${shiftName} on ${shiftDate}`
              : `Posted ${new Date(s.created_at).toLocaleDateString()}`
```

with

```jsx
            const shiftName = s.requester_shift?.shift_blocks?.shift_templates?.name
            const when = swapShiftWhen(postedSwapShift(s))
            const subtitle = shiftName && when
              ? `${shiftName} · ${when}`
              : `Posted ${new Date(s.created_at).toLocaleDateString()}`
```

- [ ] **Step 10: The picker's title, and the confirm sheet.** Replace the `<CoachPickerSheet ... />` element at the bottom (lines 991-999) with:

```jsx
      <CoachPickerSheet
        visible={!!swapPickerShift}
        block={swapPickerBlock}
        locationId={activeLocation?.id}
        staff={swapStaff}
        loading={swapStaffLoading}
        onPick={pickSwapCoach}
        onClose={() => setSwapPickerShift(null)}
        title={SWAP_PICKER_TITLE}
        emptyText={SWAP_PICKER_EMPTY}
      />

      {/* COVERLOOP.2 — nothing is POSTed until this confirms. */}
      <SwapConfirmSheet
        visible={!!swapConfirm}
        copy={swapConfirm ? swapConfirmCopy(swapConfirm) : null}
        sending={swapSending}
        onConfirm={submitSwap}
        onClose={() => { if (!swapSending) setSwapConfirm(null) }}
      />
```

- [ ] **Step 11: Lint**

Run: `npm run check:mobile-lint && npm run check:mobile-imports`
Expected: exit 0. If `check:mobile-lint` reports `'X' is defined but never used` for one of the new imports, an edit above was skipped: go back and find it, do not delete the import.

- [ ] **Step 12: Commit**

```bash
git add mobile/components/dashboard/PersonalDashboard.jsx
git commit -m "COVERLOOP.2 — Dashboard swaps: confirm step with reason, when-lines, claim warnings, Swap pending chip"
```

---

### Task 9: Schedule tab chip + Studio tab rows

**Files:**
- Modify: `mobile/app/(staff)/(tabs)/schedule.jsx` (imports ~line 37; `ShiftCard` lines 126-130; `ShiftRow` lines 271-275; `requestSwapForShift` lines 509-519)
- Modify: `mobile/components/dashboard/StudioDashboard.jsx` (imports lines 12-13; rows lines 129, 143-144)

No failing-test step (JSX). `open_swap_status` reaches these rows from Task 3's API change; `teamApprovalRoute` is Task 1's.

- [ ] **Step 1: `schedule.jsx` import.** Under the `import { canAdjustShiftTimes, canCancelTimeOff, MANAGER_ROLES } from '../../../lib/schedule-manage'` line add:

```jsx
import { hasOpenSwap, swapShiftWhen, SWAP_PENDING_LABEL, SWAP_ALREADY_OPEN_MESSAGE } from '../../../lib/swap-cards'
```

- [ ] **Step 2: The chip on the phone row.** In `ShiftRow`, directly after its `{shift.status === 'swapped' && ( ... Swapped ... )}` block (lines 271-275) add:

```jsx
          {hasOpenSwap(shift) && (
            <View className="px-2 py-0.5 rounded-full bg-amber-500/20">
              <Text className="text-[10px] uppercase text-amber-700 font-medium">{SWAP_PENDING_LABEL}</Text>
            </View>
          )}
```

- [ ] **Step 3: The chip on the tablet card.** In `ShiftCard`, directly after its `{shift.status === 'swapped' && ( ... Swap ... )}` block (lines 126-130) add:

```jsx
        {hasOpenSwap(shift) && (
          <View className="px-1.5 py-0.5 rounded-full bg-amber-500/20">
            <Text className="text-[9px] uppercase text-amber-700 font-medium">{SWAP_PENDING_LABEL}</Text>
          </View>
        )}
```

- [ ] **Step 4: `requestSwapForShift` refuses a second post and says when.** Replace the start of the function, from `function requestSwapForShift(shift) {` through the `Alert.alert(` title and message lines (lines 509-518), with:

```jsx
  function requestSwapForShift(shift) {
    // RETIRE-SHIFTS-MIRROR.5c — swaps now key off the shift_assignment id
    // (stitched into the GET /shifts row), not the legacy shifts.id.
    if (!shift.shift_assignment_id) {
      Alert.alert('Can’t post', 'This shift can’t be swapped.')
      return
    }
    // COVERLOOP.2 — open_swap_status comes from GET /api/schedule/shifts (own
    // rows only). One open swap per shift: say so rather than earn the 409.
    if (hasOpenSwap(shift)) {
      Alert.alert(shift.shift_templates?.name || 'Shift', SWAP_ALREADY_OPEN_MESSAGE)
      return
    }
    const when = swapShiftWhen(shift)
    Alert.alert(
      'Request swap?',
      `Post ${shift.shift_templates?.name || 'this shift'}${when ? ` on ${when}` : ''} for someone else to take?`,
```

Everything after that (the two buttons, the `createSwapRequest` call) stays as it is.

- [ ] **Step 5: `StudioDashboard.jsx`.** Change the `dashboard-api` import line and add two imports under it:

```jsx
import { fetchStudioDashboard, swapRowTitle } from '../../lib/dashboard-api'
// COVERLOOP.2 — pending rows open the approval itself (the same place the
// manager pushes go), and a swap row says when the shift is.
import { teamApprovalRoute } from '../../lib/notification-nav'
import { swapShiftWhen } from '../../lib/swap-cards'
```

In the time-off `PendingRow` (line 129) replace `onPress={() => router.push('/(tabs)/schedule')}` with:

```jsx
            onPress={() => router.push(teamApprovalRoute(t.id))}
```

In the swaps `PendingRow` (lines 143-144) replace the `subtitle` and `onPress` props with:

```jsx
            subtitle={swapShiftWhen(s.requester_shift) || `Posted ${new Date(s.created_at).toLocaleDateString()}`}
            onPress={() => router.push(teamApprovalRoute(s.id))}
```

(These swap rows come from `GET /api/schedule/swaps`, so `s.requester_shift` is the `swapShiftShape` object with Task 2's block times. `/(tabs)/schedule` had no approve UI; `mobile/app/(staff)/approvals.jsx:55` reads `focus` and `tab` and highlights the matching card.)

- [ ] **Step 6: Lint**

Run: `npm run check:mobile-lint && npm run check:mobile-imports`
Expected: exit 0.

- [ ] **Step 7: Commit** (single quotes: zsh globs the parentheses)

```bash
git add 'mobile/app/(staff)/(tabs)/schedule.jsx' mobile/components/dashboard/StudioDashboard.jsx
git status --short   # confirm BOTH files are staged before committing
git commit -m "COVERLOOP.2 — Swap pending chip on the Schedule tab; Studio pending rows open the approval"
```

---

### Task 10: PR gate, PR, changelog, OTA check

- [ ] **Step 1: PR gate — run all of it and read the output**

```bash
npx vitest run mobile/lib/notification-nav.test.js mobile/lib/widget-push-reload.test.js \
  mobile/lib/swap-cards.test.js mobile/lib/swap-conflicts.test.js mobile/lib/dashboard-api.test.js \
  shared/dashboard-data.test.js tests/ota-trigger-paths.test.js tests/shared-pair-sync.test.js \
  src/lib/roster-read.test.js src/lib/shift-open-swaps.test.js src/lib/openapi.test.js \
  src/app/api/schedule/shifts/route.test.js src/app/api/schedule/swaps/route.get.test.js
npm run lint                    # src/ only: it ignores mobile/**
npm run check:mobile-lint       # THE linter for mobile/** (errors, --max-warnings 0)
npm run check:mobile-imports    # every name imported by mobile code really is exported
npm run check:mobile-parity     # no new permission key; must stay green
npm run check:select-columns    # the new shift_swap_requests select + the dashboard embed's start_time/end_time
npm run check:guardrails
npm run check:location-scoping  # the new read lives in src/lib and is keyed on the caller; must stay green
npm run check:ota-paths         # no new top-level entry under mobile/; must stay green
git diff --name-only origin/main | grep -E '^(mobile|shared)/'
```

Expected: all green, and the last command LISTS files (`mobile/lib/...`, `mobile/components/...`, `mobile/app/...`, `shared/dashboard-data.js`). That list is why this merge publishes an OTA. This PR adds imports under `src/`, so CLAUDE.md asks for `npm run build`; on the 8GB dev machine skip it locally and wait for the required **Next build** check on the PR.

- [ ] **Step 2: Manual check on a Vercel PREVIEW + a dev client (there is no component test runner, so this is the only look at the JSX).** Local dev has no database; use the PR's preview URL as the API base. As a coach with a published future shift: (a) tap the shift on the Dashboard → "Ask a coach to cover…" → the sheet is titled "Ask a coach to cover · <shift>" → pick a coach → the confirm sheet appears and NOTHING has been sent (check "My requests" is unchanged) → type a reason → Send request → "Request sent"; (b) the shift now shows "Swap pending" on the Dashboard roster AND on the Schedule tab row; tapping it says a swap is already open; (c) "My requests" reads "<shift> · Thu 24 Sep · 06:00-07:00" style, no ISO date; (d) as the other coach, "Swaps offered to you" shows the when-line and the reason; (e) as a manager, Schedule → Manage → add a coach: the sheet still says "Add coach"; (f) Studio tab → tap a pending swap → the approvals inbox opens on Team with that card highlighted. If you cannot run a dev client, say so in the PR body; do not claim it was checked.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "COVERLOOP.2 — the phone's swap flow: a tap that lands, cards that say when, a confirm step, warnings, a pending chip" --body "$(cat <<'EOF'
## What (phone)
- The `swap_open_pool` push ("Tap to take it") now opens the Dashboard, where the Claim button is. It used to go nowhere.
- Swap cards say "Thu 24 Sep · 06:00-07:00" instead of a template name and a raw ISO date.
- A targeted swap is no longer sent on one tap: a confirm sheet names the coach, the shift and when, and collects an optional reason that is really POSTed. "Post for swap" uses the same sheet. The picker is titled "Ask a coach to cover" (the manager's "Add coach" use is unchanged).
- Claim / accept warnings (approved leave, same-day clash) are shown, in the web's wording.
- A shift with an open swap carries a "Swap pending" chip on the Dashboard roster and the Schedule tab, and is not offered a second post.
- Studio tab pending rows (time off and swaps) open /approvals?tab=team&focus=<id> instead of the Schedule tab, which has no approve UI.

## API (additive, no migration)
- GET /api/schedule/swaps: swap-shift embeds carry block_start_time / block_end_time (what the taker would work).
- GET /api/schedule/shifts: rows carry open_swap_status for the CALLER's own shifts only.
- shared/dashboard-data.js: the posted-swaps embed also selects the block's start_time / end_time.

## Ships
Web deploy + OTA from this one merge. Either order is safe: a new bundle on the old API shows no chip and falls back to the collapsed override / template time. All decisions are in mobile/lib with vitest tests (no RN component runner); components are wiring.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Changelog row.** Add ONE row at the top of the table in `docs/CHANGELOG.md` (directly under the `|---|------|-------|` line), keyed by the PR number. Never edit a pushed row (`merge=union` duplicates it).

```
| #<PR> | COVERLOOP.2 — the phone's swap flow works end to end: the open-pool push opens the Dashboard, swap cards say when, a targeted swap is confirmed (with a reason), claim warnings are shown, a shift with an open swap is chipped, and Studio pending rows open the approval | 2026-09-19. **Web + OTA.** No migration. `mobile/lib/notification-nav.js` gains `swap_open_pool` (the type has been sent since ROSTER-FIX.8d with no case, so the tap was dead) and an exported `teamApprovalRoute`. New pure `mobile/lib/swap-cards.js` (when-line, confirm copy, posted reason, `hasOpenSwap`, `annotateOpenSwaps`) and `swapClaimNotice` in `mobile/lib/swap-conflicts.js`, heading pinned to `SwapActions.jsx` by a source-reading test. New `SwapConfirmSheet.jsx`; `CoachPickerSheet` takes `title` / `emptyText` with today's strings as defaults. API, additive: `swapShiftShape` carries `block_start_time` / `block_end_time` (the taker works the block's hours: `SWAP_MOVE_CLEARS`); `GET /api/schedule/shifts` sets `open_swap_status` on the caller's OWN rows only (`src/lib/shift-open-swaps.js`, fails to "no chip"); the dashboard's posted-swaps embed selects the block's times. No RN component runner, so JSX was checked by hand on a preview. |
```

```bash
git add docs/CHANGELOG.md
git commit -m "COVERLOOP.2 — changelog row"
git push
```

- [ ] **Step 5: After the merge, check BOTH deploys.** (1) The Vercel production deploy for the merge commit is green. (2) GitHub → Actions → **EAS Update**: the run for the merge commit is green, and its summary names the `runtimeVersion` lane it published to. A merge is not a publish: if the run is red (for example an un-ramped partial rollout on that lane blocks every new publish, `mobile/docs/ota-rollout.md`), no phone has this change, and the workflow opens a tracking issue. Report the PR URL and the EAS Update run URL. Phones pick the update up on their next cold launch.

**Deliberately out of scope:** a reciprocal-swap UI on the phone (the API supports `target_shift_id`; no mobile screen creates one); moving `fetchPersonalDashboardData` off its mobile-direct Supabase read; humanising the time-off row's ISO dates on the Studio tab; re-wording the server's warning sentences (they carry ISO dates; they are built in `swapConflictMessage` and shared with web).
