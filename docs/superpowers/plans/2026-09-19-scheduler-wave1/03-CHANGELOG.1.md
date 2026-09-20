## PR CHANGELOG.1 — "Changes since publish" drawer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager clicks the "Published" chip on the schedule and reads, in plain sentences, every edit made to that published week or month: who changed what, for which coach, and whether that coach has been told.

**Why:** `roster_change_log` (mig 236: `id, location_id, block_id, block_date, actor_id, coach_id, action, details, notified_at, created_at`) is written by `logRosterChange` (`src/lib/roster-change-log.js:29`) from eleven call sites and stamped by the notifier, but NOTHING reads it for a human: its only reader is `collectUnnotifiedChanges`, which feeds the re-notify. Mig 236's own comment calls its first index the "Audit-view lookup", for a view that was never built. After a publish a manager cannot answer "what changed, and does the coach know?".

**Ships:** web deploy only. **No migration** (mig 236 already has the table, the `(location_id, block_date, created_at DESC)` index this read uses, and a manager-only SELECT policy). Nothing under `mobile/` or `shared/` changes, so **no OTA**. No new permission key, so `check:mobile-parity` is untouched.

**Worktree:** branch `changelog-1` off a fresh `origin/main`. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the PR gate (8GB machine).

**Rules that bite in this PR (read `CLAUDE.md` first):**
- **An `/api` route gets NO RLS.** `createServerClient()` is the service role. Mig 236's policy protects the browser client only. The route must do its own gate. Copy the sibling `GET /api/schedule/week-cost` (`src/app/api/schedule/week-cost/route.js:42-66`) exactly: `hasRoleAtAnyLocation(user, MANAGER_ROLES)` coarse check, then `assertLocationAccess(user, location_id)`, then `hasRoleAtLocation(user, location_id, MANAGER_ROLES)`. The decision is the role AT `location_id` (SCHEDROLES.1), never `user.role` (that is the ACTIVE studio's role).
- **1,000-row select cap.** A month of edits on a busy studio can pass it. The read pages with a total order and `.range()`.
- **`roster_change_log` has TWO foreign keys to `profiles`** (`actor_id`, `coach_id`). A bare `profiles(...)` embed is a PostgREST 300 (`PGRST201`). Disambiguate: `actor:profiles!actor_id(...)`, `coach:profiles!coach_id(...)`. The form is proven in `src/app/api/schedule/time-off/route.js:55-56`.
- **`check:select-columns`** resolves every literal column against `supabase/migrations/`. Verified: every `roster_change_log` column above (mig 236); `profiles.full_name`; `shift_blocks(start_time, end_time)`; `shift_templates(name)`.
- **A failed read must not read as "no changes".** The other helpers in `roster-change-log.js` are best-effort and return `[]` on error because they sit on write paths. This one answers a person's question, so it returns the error and the route 500s.
- **Timestamps are Dublin wall-clock for display.** `notified_at` / `created_at` are `timestamptz`. Use `dublinTimeLabel` and `dublinDayStr` from `src/lib/dublin-time.js:25,91`. `block_date` is a bare calendar date: never UTC-parse it (the BST off-by-one in CLAUDE.md).
- **jsdom cannot see layout.** Component tests assert text, roles and presence only.
- **A test that waits for a bug to stop happening hides it.** Every `findBy…` below waits for something to APPEAR. None waits for an error to go away.
- The repo is PUBLIC: fixtures use `Coach A`, `Manager B`. Names and times only in the payload: no rate, cost or hours-against-contract field is selected.

**Registration — what the two guard scripts actually require (both were read):**
- `scripts/check-route-guards.mjs` classifies by TOKEN PRESENCE in the route file: a non-public, non-webhook, non-cron route passes when its source contains one of `SESSION_GUARDS` (lines 47-79), the first of which is `'getCurrentUser('`. The new route calls `getCurrentUser()`, so **nothing is added to `SESSION_GUARDS` or `EXEMPT`**. Adding an entry would be wrong: `EXEMPT` is for routes that deliberately have no guard.
- `scripts/check-location-scoping.mjs` flags a route file that contains `.from('<tenant table>')` with no scoping evidence. The new route file contains NO `.from(` (the query lives in `src/lib/roster-change-log.js`, filtered `.eq('location_id', …)`), and it calls `assertLocationAccess(`, which is in `SCOPING_HELPERS` (line 96). **Nothing is added to `SCOPING_HELPERS`, `TABLE_EXCLUDE` or `EXEMPT`.**
- The one real registration is `src/lib/openapi.js` (CLAUDE.md "New API route"): Task 3 shows it.

Task 3 runs both scripts and states the expected output, so this is verified rather than assumed.

---

### File map

| File | Change |
|---|---|
| `src/lib/roster-change-format.js` | Create: pure sentence / "told" / byline formatters |
| `src/lib/roster-change-format.test.js` | Create |
| `src/lib/roster-change-log.js` | Modify: append `shapeRosterChange`, `listRosterChanges` after line 98 |
| `src/lib/roster-change-log.test.js` | Modify (the file EXISTS, 147 lines): import list lines 7-13, two new describes at the end |
| `src/app/api/schedule/change-log/route.js` | Create |
| `src/app/api/schedule/change-log/route.test.js` | Create |
| `src/lib/openapi.js` | Modify: new `registerPath` after the `week-cost` block (ends line 4451) |
| `src/components/schedule/RosterChangeLogDrawer.jsx` | Create |
| `src/components/schedule/RosterChangeLogDrawer.test.jsx` | Create |
| `src/components/ScheduleCalendar.jsx` | Modify: import (after line 65), state (after line 216), chip (lines 1113-1135), render (after line 1793) |
| `src/components/ScheduleCalendar.visibility.test.jsx` | Modify: `mockFetch` (lines 74-90), new describe |
| `docs/CHANGELOG.md` | Modify: one new row, after `gh pr create` |

**What the `details` column really holds** (surveyed from every `logRosterChange` caller, so the formatter covers real data and invents nothing):

| Writer | `action` | `details` |
|---|---|---|
| assign / bulk-assign / unassign routes | `assigned` / `unassigned` | `{}` |
| `roster-change-notify.js:240` (copies) | `assigned` | `{ via: 'copy_week' }` or `{ via: 'copy_month' }` |
| `blocks/[id]/route.js:112` | `unassigned` | `{ via: 'slot_deleted' }` |
| `swaps/[id]/route.js:163` | `unassigned` | `{ via: 'swap_drop', swap_id, roster_status }` |
| `swaps/[id]/route.js:254` | `assigned` + `unassigned` | `{ via: 'swap', swap_id, effect }` |
| `assignments/[id]/route.js:224` | `time_changed` | `{ start_time_override, end_time_override }` (either may be null; both null = reset) |
| `templates/[id]/route.js:269` | `time_changed` | `{ source: 'template_edit', template_id, from: { start_time, end_time }, to: { start_time, end_time } }` |

---

### Task 1: the pure formatter

**Files:** Create `src/lib/roster-change-format.js`, `src/lib/roster-change-format.test.js`.

Input is the API row shape Task 2 produces:

```
{ id, action, block_date, start_time, end_time, shift_name,
  coach_name, actor_name, details, notified_at, created_at }
```

- [ ] **Step 1: Write the failing test**

```js
// src/lib/roster-change-format.test.js
// CHANGELOG.1 — one roster_change_log row as a sentence a manager can read.
// Pure. Host-TZ independent; run under both:
//   for tz in Europe/Dublin America/Los_Angeles; do
//     TZ=$tz npx vitest run src/lib/roster-change-format.test.js
//   done
import { describe, it, expect } from 'vitest'
import {
  rosterChangeSentence, rosterChangeTold, rosterChangeByline, formatRosterChange,
} from './roster-change-format'

// Tue 15 Sep 2026. 13:02Z is 14:02 in Dublin (summer time, UTC+1).
const row = (over = {}) => ({
  id: 'c1', action: 'assigned', block_date: '2026-09-15', start_time: '06:00:00', end_time: '07:00:00',
  shift_name: 'Morning', coach_name: 'Coach A', actor_name: 'Manager B', details: {},
  notified_at: '2026-09-15T13:02:00Z', created_at: '2026-09-15T12:58:00Z', ...over,
})

describe('rosterChangeSentence', () => {
  it('assigned', () => {
    expect(rosterChangeSentence(row())).toBe('Assigned Coach A to Tue 15 Sep 06:00')
  })

  it('unassigned', () => {
    expect(rosterChangeSentence(row({ action: 'unassigned' }))).toBe('Removed Coach A from Tue 15 Sep 06:00')
  })

  it('says how it happened when the writer recorded it', () => {
    expect(rosterChangeSentence(row({ details: { via: 'copy_week' } }))).toBe('Assigned Coach A to Tue 15 Sep 06:00 (copied from another week)')
    expect(rosterChangeSentence(row({ details: { via: 'copy_month' } }))).toBe('Assigned Coach A to Tue 15 Sep 06:00 (copied from another month)')
    expect(rosterChangeSentence(row({ action: 'unassigned', details: { via: 'swap', swap_id: 's1', effect: 'approved_reassign' } })))
      .toBe('Removed Coach A from Tue 15 Sep 06:00 (shift swap)')
    expect(rosterChangeSentence(row({ action: 'unassigned', details: { via: 'swap_drop', swap_id: 's1' } })))
      .toBe('Removed Coach A from Tue 15 Sep 06:00 (dropped shift approved)')
  })

  it('a deleted slot has no block left to read a time from: the date alone', () => {
    expect(rosterChangeSentence(row({ action: 'unassigned', start_time: null, end_time: null, details: { via: 'slot_deleted' } })))
      .toBe('Removed Coach A from Tue 15 Sep (slot deleted)')
  })

  it('time_changed from the assignment editor: the hours the coach now has', () => {
    expect(rosterChangeSentence(row({ action: 'time_changed', details: { start_time_override: '06:30:00', end_time_override: null } })))
      .toBe("Changed Coach A's hours on Tue 15 Sep 06:00 to 06:30–07:00")
  })

  it('time_changed with both overrides cleared is a reset', () => {
    expect(rosterChangeSentence(row({ action: 'time_changed', details: { start_time_override: null, end_time_override: null } })))
      .toBe("Reset Coach A's hours on Tue 15 Sep 06:00 to the shift's own")
  })

  it('time_changed from a template edit names the OLD time, because the block now holds the new one', () => {
    expect(rosterChangeSentence(row({
      action: 'time_changed', start_time: '06:30:00', end_time: '07:30:00',
      details: { source: 'template_edit', template_id: 't1', from: { start_time: '06:00:00', end_time: '07:00:00' }, to: { start_time: '06:30:00', end_time: '07:30:00' } },
    }))).toBe("Moved Coach A's Tue 15 Sep 06:00 shift to 06:30–07:30 (template edited)")
  })

  it('time_changed with details it does not recognise still says something true', () => {
    expect(rosterChangeSentence(row({ action: 'time_changed', details: {} }))).toBe("Changed Coach A's hours on Tue 15 Sep 06:00")
  })

  it('never invents a name, a date or an action', () => {
    expect(rosterChangeSentence(row({ coach_name: null }))).toBe('Assigned a coach to Tue 15 Sep 06:00')
    expect(rosterChangeSentence(row({ block_date: null, start_time: null }))).toBe('Assigned Coach A to a shift')
    expect(rosterChangeSentence(row({ action: 'mystery' }))).toBe("Changed Coach A's shift on Tue 15 Sep 06:00")
    expect(rosterChangeSentence(row({ details: { via: 'something_new' } }))).toBe('Assigned Coach A to Tue 15 Sep 06:00')
    expect(rosterChangeSentence(row({ details: null }))).toBe('Assigned Coach A to Tue 15 Sep 06:00')
  })

  it('reads the weekday off the calendar date, whatever the host timezone', () => {
    expect(rosterChangeSentence(row({ block_date: '2026-03-29' }))).toMatch(/Sun 29 Mar/) // spring DST day
    expect(rosterChangeSentence(row({ block_date: '2026-10-25' }))).toMatch(/Sun 25 Oct/) // autumn DST day
    expect(rosterChangeSentence(row({ block_date: '2026-12-14' }))).toMatch(/Mon 14 Dec/)
  })
})

describe('rosterChangeTold', () => {
  it('told, with the Dublin wall-clock time', () => {
    expect(rosterChangeTold(row())).toBe('told 14:02')
  })
  it('winter: Dublin is UTC, no shift', () => {
    expect(rosterChangeTold(row({ notified_at: '2026-12-01T14:02:00Z', created_at: '2026-12-01T09:00:00Z' }))).toBe('told 14:02')
  })
  it('names the day when the coach was told on a later day than the change', () => {
    expect(rosterChangeTold(row({ notified_at: '2026-09-17T08:05:00Z' }))).toBe('told 17 Sep 09:05')
  })
  it('a change at 23:30 Dublin told at 00:10 Dublin is a later DAY, even though UTC calls it the same day', () => {
    // 22:30Z = 23:30 Dublin on the 15th; 23:10Z = 00:10 Dublin on the 16th.
    expect(rosterChangeTold(row({ created_at: '2026-09-15T22:30:00Z', notified_at: '2026-09-15T23:10:00Z' }))).toBe('told 16 Sep 00:10')
  })
  it('not told yet', () => {
    expect(rosterChangeTold(row({ notified_at: null }))).toBe('not told yet')
  })
  it('an unreadable stamp is "told", never a crash or a made-up time', () => {
    expect(rosterChangeTold(row({ notified_at: 'garbage' }))).toBe('told')
  })
})

describe('rosterChangeByline', () => {
  it('who and when, in Dublin time', () => {
    expect(rosterChangeByline(row())).toBe('Manager B · 15 Sep 13:58')
  })
  it('a change with no actor (a deleted profile, or a system path) says so', () => {
    expect(rosterChangeByline(row({ actor_name: null }))).toBe('System · 15 Sep 13:58')
  })
  it('an unreadable created_at leaves the name alone', () => {
    expect(rosterChangeByline(row({ created_at: null }))).toBe('Manager B')
  })
})

describe('formatRosterChange', () => {
  it('is the sentence and the told state in one line', () => {
    expect(formatRosterChange(row())).toBe('Assigned Coach A to Tue 15 Sep 06:00 · told 14:02')
    expect(formatRosterChange(row({ notified_at: null }))).toBe('Assigned Coach A to Tue 15 Sep 06:00 · not told yet')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-change-format.test.js`
Expected: FAIL, `Failed to resolve import "./roster-change-format"`.

- [ ] **Step 3: Minimal implementation**

```js
// src/lib/roster-change-format.js
// CHANGELOG.1 — turn one roster_change_log row (the shape
// GET /api/schedule/change-log returns) into words a manager can read:
//
//   "Assigned Coach A to Tue 15 Sep 06:00 · told 14:02"
//
// Pure. It lives in src/lib, not shared/, because anything under shared/
// publishes an OTA and the phone does not show this.
//
// Two kinds of time are in play and they are handled differently on purpose:
//   block_date / start_time  bare Dublin wall-clock values. Never parsed as
//                            UTC (the BST off-by-one in CLAUDE.md): the
//                            weekday is read from LOCAL date components.
//   notified_at / created_at timestamptz instants, shown as Dublin wall-clock
//                            via dublin-time.js.
//
// `details` is whatever the writer recorded (surveyed in the CHANGELOG.1 plan).
// An unknown shape degrades to the plain sentence; nothing is guessed.

import { fmtTime } from './schedule-overlap'
import { dublinDayStr, dublinTimeLabel } from './dublin-time'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const VIA_NOTE = {
  copy_week: 'copied from another week',
  copy_month: 'copied from another month',
  slot_deleted: 'slot deleted',
  swap: 'shift swap',
  swap_drop: 'dropped shift approved',
}

function dateParts(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null
}

/** '2026-09-15' -> '15 Sep'. '' when unreadable. */
function shortDate(iso) {
  const p = dateParts(iso)
  return p ? `${p.d} ${MONTHS[p.mo - 1]}` : ''
}

/** '2026-09-15' -> 'Tue 15 Sep'. Built AND read in local components, so the host TZ cannot move it. */
function dayLabel(iso) {
  const p = dateParts(iso)
  if (!p) return ''
  return `${DAYS[new Date(p.y, p.mo - 1, p.d).getDay()]} ${shortDate(iso)}`
}

function whenLabel(blockDate, startTime) {
  const day = dayLabel(blockDate)
  if (!day) return 'a shift'
  const t = fmtTime(startTime)
  return t ? `${day} ${t}` : day
}

function howNote(details) {
  if (details?.source === 'template_edit') return ' (template edited)'
  const text = VIA_NOTE[details?.via]
  return text ? ` (${text})` : ''
}

/** What happened, for whom. */
export function rosterChangeSentence(change) {
  const c = change || {}
  const d = c.details || {}
  const coach = c.coach_name || 'a coach'
  const when = whenLabel(c.block_date, c.start_time)

  if (c.action === 'assigned') return `Assigned ${coach} to ${when}${howNote(d)}`
  if (c.action === 'unassigned') return `Removed ${coach} from ${when}${howNote(d)}`

  if (c.action === 'time_changed') {
    // A template edit moved the BLOCK, so the row's start_time is already the
    // new one. Name the shift by the time it USED to be.
    if (d.to?.start_time) {
      const was = whenLabel(c.block_date, d.from?.start_time || c.start_time)
      return `Moved ${coach}'s ${was} shift to ${fmtTime(d.to.start_time)}–${fmtTime(d.to.end_time)}${howNote(d)}`
    }
    const hasOverrideKeys = 'start_time_override' in d || 'end_time_override' in d
    if (hasOverrideKeys && !d.start_time_override && !d.end_time_override) {
      return `Reset ${coach}'s hours on ${when} to the shift's own`
    }
    if (hasOverrideKeys) {
      const start = fmtTime(d.start_time_override || c.start_time)
      const end = fmtTime(d.end_time_override || c.end_time)
      return `Changed ${coach}'s hours on ${when} to ${start}–${end}`
    }
    return `Changed ${coach}'s hours on ${when}`
  }

  return `Changed ${coach}'s shift on ${when}`
}

function isInstant(v) {
  return Boolean(v) && Number.isFinite(Date.parse(v))
}

/** Has the coach been told, and when (Dublin wall-clock). */
export function rosterChangeTold(change) {
  const c = change || {}
  if (!c.notified_at) return 'not told yet'
  if (!isInstant(c.notified_at)) return 'told'
  const time = dublinTimeLabel(c.notified_at)
  const toldDay = dublinDayStr(c.notified_at)
  // The day is only worth naming when it is not the day of the change.
  const sameDay = isInstant(c.created_at) && dublinDayStr(c.created_at) === toldDay
  return sameDay ? `told ${time}` : `told ${shortDate(toldDay)} ${time}`
}

/** Who made the change, and when. */
export function rosterChangeByline(change) {
  const c = change || {}
  const who = c.actor_name || 'System'
  if (!isInstant(c.created_at)) return who
  return `${who} · ${shortDate(dublinDayStr(c.created_at))} ${dublinTimeLabel(c.created_at)}`
}

/** "Assigned Coach A to Tue 15 Sep 06:00 · told 14:02" */
export function formatRosterChange(change) {
  return `${rosterChangeSentence(change)} · ${rosterChangeTold(change)}`
}
```

- [ ] **Step 4: Run it, expect PASS**

```bash
npx vitest run src/lib/roster-change-format.test.js
for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/roster-change-format.test.js; done
```

Expected: green all three times. A failure ONLY under `America/Los_Angeles` means a date is being UTC-parsed somewhere: fix the code, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-change-format.js src/lib/roster-change-format.test.js
git commit -m "CHANGELOG.1 — pure formatter: a roster change as a sentence, with whether the coach was told"
```

---

### Task 2: `listRosterChanges`, the paged read

**Files:** Modify `src/lib/roster-change-log.js` (append after line 98), `src/lib/roster-change-log.test.js` (exists).

- [ ] **Step 1: Write the failing test**

In `src/lib/roster-change-log.test.js` extend the import list (lines 7-13):

```js
import {
  logRosterChange,
  distinctCoachIds,
  ROSTER_CHANGE_ACTIONS,
  collectUnnotifiedChanges,
  markChangesNotified,
  listRosterChanges,
  shapeRosterChange,
  ROSTER_CHANGE_LOG_MAX_ROWS,
} from './roster-change-log'
```

and append at the end of the file (the names `raw` and `pagedDb` do not collide with the file's existing `mockDb`):

```js
// CHANGELOG.1 — the human-facing read.

// A raw row as PostgREST returns it for the select in listRosterChanges.
const raw = (i, over = {}) => ({
  id: `c${String(i).padStart(5, '0')}`, block_id: 'b1', block_date: '2026-09-15', coach_id: 'p1',
  action: 'assigned', details: { via: 'copy_week' },
  notified_at: null, created_at: '2026-09-15T12:58:00Z',
  actor: { id: 'm1', full_name: 'Manager B' },
  coach: { id: 'p1', full_name: 'Coach A' },
  shift_blocks: { start_time: '06:00:00', end_time: '07:00:00', shift_templates: { name: 'Morning' } },
  ...over,
})

function pagedDb(total, { failOnPage = null } = {}) {
  const calls = []
  const all = Array.from({ length: total }, (_, i) => raw(i))
  return {
    calls,
    from(table) {
      expect(table).toBe('roster_change_log')
      const q = { filters: [], orders: [] }
      const chain = {
        select: (s) => { q.select = s; return chain },
        eq: (c, v) => { q.filters.push(['eq', c, v]); return chain },
        gte: (c, v) => { q.filters.push(['gte', c, v]); return chain },
        lte: (c, v) => { q.filters.push(['lte', c, v]); return chain },
        order: (c, o) => { q.orders.push([c, o?.ascending]); return chain },
        range: (from, to) => {
          q.range = [from, to]
          calls.push(q)
          if (failOnPage !== null && calls.length - 1 === failOnPage) return Promise.resolve({ data: null, error: { message: 'boom' } })
          return Promise.resolve({ data: all.slice(from, to + 1), error: null })
        },
      }
      return chain
    },
  }
}

describe('shapeRosterChange', () => {
  it('flattens the embeds to exactly the fields the drawer needs, and nothing else', () => {
    expect(shapeRosterChange(raw(1))).toEqual({
      id: 'c00001', action: 'assigned', block_id: 'b1', block_date: '2026-09-15',
      start_time: '06:00:00', end_time: '07:00:00', shift_name: 'Morning',
      coach_id: 'p1', coach_name: 'Coach A', actor_name: 'Manager B',
      details: { via: 'copy_week' }, notified_at: null, created_at: '2026-09-15T12:58:00Z',
    })
  })

  it('a deleted slot (block_id SET NULL) and deleted profiles become nulls, not a crash', () => {
    expect(shapeRosterChange(raw(1, { block_id: null, shift_blocks: null, actor: null, coach: null, coach_id: null, details: null })))
      .toMatchObject({ block_id: null, start_time: null, end_time: null, shift_name: null, coach_id: null, coach_name: null, actor_name: null, details: {} })
  })
})

describe('listRosterChanges', () => {
  it('reads ONE studio\'s changes whose shift date is in the range, newest first', async () => {
    const db = pagedDb(3)
    const { changes, truncated, error } = await listRosterChanges(db, { locationId: 'loc1', from: '2026-09-14', to: '2026-09-20' })
    expect(error).toBeNull()
    expect(truncated).toBe(false)
    expect(changes).toHaveLength(3)
    expect(changes[0]).toMatchObject({ coach_name: 'Coach A', actor_name: 'Manager B', shift_name: 'Morning' })
    expect(db.calls[0].filters).toEqual([
      ['eq', 'location_id', 'loc1'], ['gte', 'block_date', '2026-09-14'], ['lte', 'block_date', '2026-09-20'],
    ])
    // A TOTAL order, or pages can repeat or skip rows that share a created_at.
    expect(db.calls[0].orders).toEqual([['created_at', false], ['id', false]])
  })

  it('names both profile foreign keys, or PostgREST answers 300 PGRST201', async () => {
    const db = pagedDb(1)
    await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' })
    expect(db.calls[0].select).toContain('actor:profiles!actor_id(')
    expect(db.calls[0].select).toContain('coach:profiles!coach_id(')
  })

  it('selects no pay field', async () => {
    const db = pagedDb(1)
    await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' })
    expect(db.calls[0].select).not.toMatch(/hourly_rate|annual_salary|overtime_rate|contracted_hours/)
  })

  it('pages past the 1,000-row cap', async () => {
    const db = pagedDb(2300)
    const { changes, truncated } = await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' })
    expect(changes).toHaveLength(2300)
    expect(truncated).toBe(false)
    expect(db.calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('stops at the ceiling and SAYS it stopped', async () => {
    const db = pagedDb(ROSTER_CHANGE_LOG_MAX_ROWS + 2500)
    const { changes, truncated } = await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' })
    expect(changes).toHaveLength(ROSTER_CHANGE_LOG_MAX_ROWS)
    expect(truncated).toBe(true)
    // One page past the ceiling is read to learn that, and no more.
    expect(db.calls).toHaveLength(ROSTER_CHANGE_LOG_MAX_ROWS / 1000 + 1)
  })

  it('exactly the ceiling is NOT truncated', async () => {
    const db = pagedDb(ROSTER_CHANGE_LOG_MAX_ROWS)
    const { changes, truncated } = await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' })
    expect(changes).toHaveLength(ROSTER_CHANGE_LOG_MAX_ROWS)
    expect(truncated).toBe(false)
  })

  it('returns the error and NO partial rows: a failed read must not look like a quiet week', async () => {
    const db = pagedDb(1500, { failOnPage: 1 })
    expect(await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' }))
      .toEqual({ changes: [], truncated: false, error: { message: 'boom' } })
  })

  it('refuses to run unscoped', async () => {
    const db = pagedDb(5)
    const res = await listRosterChanges(db, { locationId: '', from: 'a', to: 'b' })
    expect(res.error?.message).toMatch(/locationId, from and to are required/)
    expect(db.calls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-change-log.test.js`
Expected: the two new describes fail with `shapeRosterChange is not a function` / `listRosterChanges is not a function`; the five older describes still pass.

- [ ] **Step 3: Minimal implementation**

Append to `src/lib/roster-change-log.js`:

```js
// ── CHANGELOG.1 — the human-facing read ────────────────────────────────────
//
// Everything above is best-effort because it sits on a write path. This is
// different: a manager asked "what changed since I published?", and answering
// "nothing" when the read failed is a lie. So it returns the error.

const CHANGE_LOG_PAGE = 1000
/** Ceiling on one drawer's rows (a multiple of the page). Past it the answer is flagged `truncated`. */
export const ROSTER_CHANGE_LOG_MAX_ROWS = 5000

/**
 * Pure. One PostgREST row (listRosterChanges' select) -> the API shape. Names
 * and times only. block_id / actor_id / coach_id are ON DELETE SET NULL (mig
 * 236), so every embed may be null.
 */
export function shapeRosterChange(r) {
  return {
    id: r.id,
    action: r.action,
    block_id: r.block_id ?? null,
    block_date: r.block_date ?? null,
    start_time: r.shift_blocks?.start_time ?? null,
    end_time: r.shift_blocks?.end_time ?? null,
    shift_name: r.shift_blocks?.shift_templates?.name ?? null,
    coach_id: r.coach_id ?? null,
    coach_name: r.coach?.full_name ?? null,
    actor_name: r.actor?.full_name ?? null,
    details: r.details || {},
    notified_at: r.notified_at ?? null,
    created_at: r.created_at ?? null,
  }
}

/**
 * Edits to published rosters at ONE studio whose shift date is in [from, to],
 * newest first. Paged past the 1,000-row select cap over a total order.
 * Service-role callers get no RLS: the location filter here IS the tenant
 * boundary, and the route must have authorised `locationId` first.
 *
 * Reads at most one page beyond ROSTER_CHANGE_LOG_MAX_ROWS, which is how it
 * tells "exactly the ceiling" from "more than the ceiling".
 *
 * @returns {Promise<{ changes: Array<object>, truncated: boolean, error: object|null }>}
 */
export async function listRosterChanges(db, { locationId, from, to } = {}) {
  if (!locationId || !from || !to) {
    return { changes: [], truncated: false, error: { message: 'locationId, from and to are required' } }
  }
  const rows = []
  for (let start = 0; rows.length <= ROSTER_CHANGE_LOG_MAX_ROWS; start += CHANGE_LOG_PAGE) {
    const { data, error } = await db
      .from('roster_change_log')
      // Literal on purpose: check:select-columns only resolves literal selects.
      // Two FKs to profiles, so each embed names its column (PGRST201 otherwise).
      .select(`
        id, block_id, block_date, coach_id, action, details, notified_at, created_at,
        actor:profiles!actor_id(id, full_name),
        coach:profiles!coach_id(id, full_name),
        shift_blocks!block_id(start_time, end_time, shift_templates(name))
      `)
      .eq('location_id', locationId)
      .gte('block_date', from)
      .lte('block_date', to)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(start, start + CHANGE_LOG_PAGE - 1)
    if (error) return { changes: [], truncated: false, error }
    const page = data || []
    rows.push(...page)
    if (page.length < CHANGE_LOG_PAGE) break
  }
  return {
    changes: rows.slice(0, ROSTER_CHANGE_LOG_MAX_ROWS).map(shapeRosterChange),
    truncated: rows.length > ROSTER_CHANGE_LOG_MAX_ROWS,
    error: null,
  }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-change-log.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-change-log.js src/lib/roster-change-log.test.js
git commit -m "CHANGELOG.1 — paged, location-scoped read of roster_change_log with names and shift times"
```

---

### Task 3: `GET /api/schedule/change-log`

**Files:** Create `src/app/api/schedule/change-log/route.js`, `src/app/api/schedule/change-log/route.test.js`. Modify `src/lib/openapi.js`.

- [ ] **Step 1: Write the failing test**

Conventions copied from `src/app/api/schedule/week-cost/route.test.js`: `@/lib/auth` is mocked with the REAL `hasRoleAtLocation` / `hasRoleAtAnyLocation`, because the role at `location_id` is what is under test.

```js
// src/app/api/schedule/change-log/route.test.js
// CHANGELOG.1 — route-level contract for GET /api/schedule/change-log.
// The read is pinned in roster-change-log.test.js. Locked here: the gate
// (manager role AT location_id + assertLocationAccess), the query contract,
// and that a failed read is a 500, never an empty list.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    // SCHEDROLES.1 — REAL: the role at location_id is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/roster-change-log', async (importOriginal) => ({
  ...(await importOriginal()),
  listRosterChanges: vi.fn(),
}))

const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { listRosterChanges } = await import('@/lib/roster-change-log')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const CHANGE = {
  id: 'c1', action: 'assigned', block_id: 'b1', block_date: '2026-09-15', start_time: '06:00:00', end_time: '07:00:00',
  shift_name: 'Morning', coach_id: 'p1', coach_name: 'Coach A', actor_name: 'Manager B',
  details: {}, notified_at: null, created_at: '2026-09-15T12:58:00Z',
}

function buildReq(params = {}) {
  const url = new URL('http://test/api/schedule/change-log')
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const ok = { location_id: LOC, from: '2026-09-14', to: '2026-09-20' }
const userAt = (loc, role) => ({ id: 'u1', role, profileRole: 'staff', locations: [{ id: loc }], rolesByLocation: { [loc]: role } })

beforeEach(() => {
  getCurrentUser.mockReset()
  assertLocationAccess.mockReset()
  assertLocationAccess.mockReturnValue(null)
  listRosterChanges.mockReset()
  listRosterChanges.mockResolvedValue({ changes: [CHANGE], truncated: false, error: null })
})

describe('GET /api/schedule/change-log — auth', () => {
  it('403 with no session, and reads nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(buildReq(ok))).status).toBe(403)
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('403 for a coach: the audit trail is manager information', async () => {
    getCurrentUser.mockResolvedValue(userAt(LOC, 'staff'))
    expect((await GET(buildReq(ok))).status).toBe(403)
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('403 for a manager of ANOTHER studio, via assertLocationAccess', async () => {
    getCurrentUser.mockResolvedValue(userAt(OTHER, 'manager'))
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false, error: 'Forbidden — location not in your assignments' }, { status: 403 }))
    const res = await GET(buildReq(ok))
    expect(res.status).toBe(403)
    expect(assertLocationAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), LOC)
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('200 for a head coach at the studio', async () => {
    getCurrentUser.mockResolvedValue(userAt(LOC, 'head_coach'))
    expect((await GET(buildReq(ok))).status).toBe(200)
  })

  // SCHEDROLES.1 — head coach at LOC, plain staff at OTHER, member of both.
  const mixed = (active) => ({
    id: 'mix', role: active === LOC ? 'head_coach' : 'staff', profileRole: 'staff',
    activeLocation: { id: active },
    locations: [{ id: LOC }, { id: OTHER }],
    rolesByLocation: { [LOC]: 'head_coach', [OTHER]: 'staff' },
  })

  it('refuses the studio where the caller is only staff, even though they manage another', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC))
    expect((await GET(buildReq({ ...ok, location_id: OTHER }))).status).toBe(403)
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('allows the studio they manage even when the ACTIVE studio is the one where they are staff', async () => {
    getCurrentUser.mockResolvedValue(mixed(OTHER))
    expect((await GET(buildReq(ok))).status).toBe(200)
  })

  it('a master is allowed', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    expect((await GET(buildReq(ok))).status).toBe(200)
  })
})

describe('GET /api/schedule/change-log — contract', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue(userAt(LOC, 'manager')))

  it('200: the changes and the truncated flag, read for exactly that studio and range', async () => {
    const res = await GET(buildReq(ok))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { changes: [CHANGE], truncated: false } })
    expect(listRosterChanges).toHaveBeenCalledWith(expect.anything(), { locationId: LOC, from: '2026-09-14', to: '2026-09-20' })
  })

  it('400 on a missing or malformed param, before any read', async () => {
    for (const bad of [{ ...ok, location_id: undefined }, { ...ok, from: undefined }, { ...ok, to: '20-09-2026' }, { ...ok, location_id: 'not-a-uuid' }]) {
      expect((await GET(buildReq(bad))).status).toBe(400)
    }
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('400 when to is before from', async () => {
    const res = await GET(buildReq({ ...ok, from: '2026-09-20', to: '2026-09-14' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/on or after/)
  })

  it('400 for a range longer than 92 days: the drawer asks for a week or a month', async () => {
    const res = await GET(buildReq({ ...ok, from: '2026-01-01', to: '2026-12-31' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/92 days/)
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('a 31-day month is fine', async () => {
    expect((await GET(buildReq({ ...ok, from: '2026-10-01', to: '2026-10-31' }))).status).toBe(200)
  })

  it('500 when the read fails: never an empty list that reads as "no changes"', async () => {
    listRosterChanges.mockResolvedValue({ changes: [], truncated: false, error: { message: 'boom' } })
    const res = await GET(buildReq(ok))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'boom' })
  })

  it('carries no pay field', async () => {
    const wire = JSON.stringify(await (await GET(buildReq(ok))).json())
    expect(wire).not.toMatch(/hourly_rate|annual_salary|overtime_rate|contracted_hours/)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/change-log/route.test.js`
Expected: FAIL, `Failed to resolve import "./route.js"`.

- [ ] **Step 3: Minimal implementation**

```js
// src/app/api/schedule/change-log/route.js
// CHANGELOG.1 — GET /api/schedule/change-log
//
// Edits made to ALREADY-PUBLISHED rosters at one studio, for shifts dated in
// [from, to]: who changed what, for which coach, and whether the coach has
// been told (notified_at). Drives the "Changes since publish" drawer behind
// the schedule's Published chip. roster_change_log (mig 236) had writers and a
// re-notify reader, and no reader for a person.
//
// Gate: identical to the sibling GET /api/schedule/week-cost. MANAGER_ROLES,
// then assertLocationAccess on the caller-supplied location_id (a query-param
// route, so a foreign studio is a 403; the 404 rule is for ids in the path),
// then the role AT location_id (SCHEDROLES.1), never `user.role`, which is the
// ACTIVE studio's. This route is service-role: mig 236's RLS policy does
// nothing here, so this gate and the location filter in listRosterChanges are
// the whole tenant boundary.
//
// Query params:
//   location_id  uuid (required)
//   from, to     YYYY-MM-DD, inclusive, by SHIFT date (block_date); at most 92 days
//
// Returns:
//   { success, data: { changes: [...], truncated } }   newest first
//   Names and times only. No rate, cost or contract-hours field is selected.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, isoDate, MANAGER_ROLES } from '@/lib/schemas'
import { listRosterChanges } from '@/lib/roster-change-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_SPAN_DAYS = 92

const QuerySchema = z.object({
  location_id: uuidLike,
  from: isoDate,
  to: isoDate,
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    location_id: url.searchParams.get('location_id'),
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }
  const { location_id, from, to } = parsed.data

  if (to < from) {
    return NextResponse.json({ success: false, error: 'to must be on or after from' }, { status: 400 })
  }
  // Whole days between two calendar dates, both anchored at UTC midnight so
  // DST cannot skew the count (the form the time-off POST uses for its cap).
  const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1
  if (spanDays > MAX_SPAN_DAYS) {
    return NextResponse.json({ success: false, error: `The range is limited to ${MAX_SPAN_DAYS} days` }, { status: 400 })
  }

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()
  const { changes, truncated, error } = await listRosterChanges(db, { locationId: location_id, from, to })
  // A failed read is a 500, never `changes: []`: an empty drawer says "nothing
  // changed", and that would be a lie.
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data: { changes, truncated } })
}
```

Register it in `src/lib/openapi.js`, directly after the `week-cost` `registerPath` block (ends line 4451):

```js
// CHANGELOG.1 — the human-facing read of roster_change_log (mig 236).
registry.registerPath({
  method: 'get',
  path: '/api/schedule/change-log',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Edits made to published rosters in a period (manager-only)',
  description: "Query: location_id (uuid), from and to (YYYY-MM-DD, inclusive, matched on the SHIFT date, at most 92 days). Returns the roster_change_log rows for that studio, newest first: action (assigned | unassigned | time_changed), the coach's name, who made the change, the shift's date, times and name, the writer's `details`, created_at, and notified_at (null = the coach has not been told yet; the next re-publish tells them). Only edits to an ALREADY-PUBLISHED roster are logged, so a draft week is empty by design. Manager-only (master, owner, manager, head_coach) at location_id, scoped by assertLocationAccess: a studio outside the caller's assignments is a 403. Names and times only, never pay. `truncated` is true when more than 5,000 rows matched.",
  responses: {
    200: { description: '{ success, data: { changes, truncated } }' },
    400: { description: 'Missing or malformed location_id / from / to, to before from, or a range over 92 days', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — needs a manager role at that location', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'The change log could not be read', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 4: Run it, expect PASS, then PROVE the guard scripts need no registration**

```bash
npx vitest run src/app/api/schedule/change-log/route.test.js src/lib/openapi.test.js
npm run check:route-guards
npm run check:location-scoping
```

Expected:
- vitest green.
- `check:route-guards` prints `✓ route guards: N routes — M session-guarded, …` with N and M each ONE higher than on `origin/main` (813 and 662 when this plan was written). It passes because the file contains `getCurrentUser(`. If it FAILS naming `src/app/api/schedule/change-log/route.js`, the guard call was removed or renamed: restore it. Do not add the route to `EXEMPT`.
- `check:location-scoping` passes unchanged: the route has no `.from(` and calls `assertLocationAccess(`. If it flags the route, a `.from('roster_change_log')` has crept into the route file: move it back into `listRosterChanges`. Do not add an `EXEMPT` entry.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/change-log/route.js src/app/api/schedule/change-log/route.test.js src/lib/openapi.js
git commit -m "CHANGELOG.1 — GET /api/schedule/change-log, manager-only at the studio asked for"
```

---

### Task 4: the drawer component

**Files:** Create `src/components/schedule/RosterChangeLogDrawer.jsx`, `src/components/schedule/RosterChangeLogDrawer.test.jsx`.

It is its own file (not a fifth modal inside the 2,761-line `ScheduleCalendar.jsx`) so it can be tested without rendering the calendar. It uses the `Modal` primitive (`src/components/ui/Modal.jsx`: `open`, `onClose`, `title`, `size`), as every other dialog on this screen does.

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/schedule/RosterChangeLogDrawer.test.jsx
// @vitest-environment jsdom
//
// CHANGELOG.1 — the "Changes since publish" drawer. The sentences are pinned
// in src/lib/roster-change-format.test.js; this is the wiring: what it asks
// for, and what it shows for each answer. jsdom has no layout, so only text,
// roles and presence are asserted. Every findBy waits for something to APPEAR.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import RosterChangeLogDrawer from './RosterChangeLogDrawer.jsx'

const change = (over = {}) => ({
  id: 'c1', action: 'assigned', block_id: 'b1', block_date: '2026-09-15', start_time: '06:00:00', end_time: '07:00:00',
  shift_name: 'Morning', coach_id: 'p1', coach_name: 'Coach A', actor_name: 'Manager B',
  details: {}, notified_at: '2026-09-15T13:02:00Z', created_at: '2026-09-15T12:58:00Z', ...over,
})

const answer = (status, body) => vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))
const props = { locationId: 'loc1', periodStart: '2026-09-14', periodEnd: '2026-09-20', periodLabel: '14 Sep – 20 Sep 2026', onClose: () => {} }

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('RosterChangeLogDrawer', () => {
  it('asks for exactly the studio and period on screen, once', async () => {
    global.fetch = answer(200, { success: true, data: { changes: [], truncated: false } })
    render(<RosterChangeLogDrawer {...props} />)
    await screen.findByText(/No changes since this was published/)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(String(global.fetch.mock.calls[0][0])).toBe('/api/schedule/change-log?location_id=loc1&from=2026-09-14&to=2026-09-20')
  })

  it('is a dialog titled with the period', async () => {
    global.fetch = answer(200, { success: true, data: { changes: [], truncated: false } })
    render(<RosterChangeLogDrawer {...props} />)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Changes since publish')).toBeTruthy()
    expect(within(dialog).getByText('14 Sep – 20 Sep 2026')).toBeTruthy()
  })

  it('lists each change as a sentence, with who made it and whether the coach was told', async () => {
    global.fetch = answer(200, { success: true, data: { truncated: false, changes: [
      change(),
      change({ id: 'c2', action: 'unassigned', coach_name: 'Coach C', notified_at: null }),
    ] } })
    render(<RosterChangeLogDrawer {...props} />)
    const list = await screen.findByTestId('roster-change-list')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toMatch(/Assigned Coach A to Tue 15 Sep 06:00/)
    expect(items[0].textContent).toMatch(/told 14:02/)
    expect(items[0].textContent).toMatch(/Manager B · 15 Sep 13:58/)
    expect(items[1].textContent).toMatch(/Removed Coach C from Tue 15 Sep 06:00/)
    expect(items[1].textContent).toMatch(/not told yet/)
  })

  it('counts who has not been told, and says how they will be', async () => {
    global.fetch = answer(200, { success: true, data: { truncated: false, changes: [
      change(), change({ id: 'c2', notified_at: null }), change({ id: 'c3', notified_at: null }),
    ] } })
    render(<RosterChangeLogDrawer {...props} />)
    const summary = await screen.findByTestId('roster-change-summary')
    expect(summary.textContent).toMatch(/3 changes/)
    expect(summary.textContent).toMatch(/2 not told yet/)
    expect(summary.textContent).toMatch(/Publish again to tell them/)
  })

  it('everyone told: no nag', async () => {
    global.fetch = answer(200, { success: true, data: { truncated: false, changes: [change()] } })
    render(<RosterChangeLogDrawer {...props} />)
    const summary = await screen.findByTestId('roster-change-summary')
    expect(summary.textContent).toMatch(/1 change$/)
  })

  it('an empty period says so, and shows no list', async () => {
    global.fetch = answer(200, { success: true, data: { changes: [], truncated: false } })
    render(<RosterChangeLogDrawer {...props} />)
    expect(await screen.findByText(/No changes since this was published/)).toBeTruthy()
    expect(screen.queryByTestId('roster-change-list')).toBeNull()
  })

  it('a refused or failed read shows the ERROR, never the empty state', async () => {
    global.fetch = answer(500, { success: false, error: 'boom' })
    render(<RosterChangeLogDrawer {...props} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/boom/)
    expect(screen.queryByText(/No changes since this was published/)).toBeNull()
  })

  it('a dropped connection is an error too, in words an operator can read', async () => {
    global.fetch = vi.fn(async () => { throw new Error('Failed to fetch') })
    render(<RosterChangeLogDrawer {...props} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Network error/)
    expect(alert.textContent).not.toMatch(/Failed to fetch/)
  })

  it('says when the list was cut short', async () => {
    global.fetch = answer(200, { success: true, data: { changes: [change()], truncated: true } })
    render(<RosterChangeLogDrawer {...props} />)
    expect(await screen.findByText(/Showing the most recent 5,000/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/schedule/RosterChangeLogDrawer.test.jsx`
Expected: FAIL, `Failed to resolve import "./RosterChangeLogDrawer.jsx"`.

- [ ] **Step 3: Minimal implementation**

```jsx
// src/components/schedule/RosterChangeLogDrawer.jsx
'use client'

// CHANGELOG.1 — "Changes since publish". Opened from the schedule's Published
// chip. Reads GET /api/schedule/change-log for the period on screen and prints
// each edit as a sentence (src/lib/roster-change-format.js).
//
// Three states that must never be confused: loading, an ERROR, and a genuinely
// empty period. An error is rendered as an error; "No changes" is only ever
// said about a read that succeeded.

import { useEffect, useState } from 'react'
import Modal from '@/components/ui/Modal'
import { rosterChangeSentence, rosterChangeTold, rosterChangeByline } from '@/lib/roster-change-format'

export default function RosterChangeLogDrawer({ locationId, periodStart, periodEnd, periodLabel, onClose }) {
  // Starts in `loading`, so the effect below never sets state synchronously.
  const [state, setState] = useState({ loading: true, error: null, changes: [], truncated: false })

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/schedule/change-log?location_id=${locationId}&from=${periodStart}&to=${periodEnd}`)
        const body = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || !body?.success) {
          setState({ loading: false, error: body?.error || `Could not load the changes (${res.status})`, changes: [], truncated: false })
          return
        }
        setState({ loading: false, error: null, changes: body.data?.changes || [], truncated: Boolean(body.data?.truncated) })
      } catch {
        // ROSTER-FIX.6a — never print e.message: a dropped connection reaches
        // the operator as "Failed to fetch".
        if (!cancelled) setState({ loading: false, error: 'Network error, could not load the changes.', changes: [], truncated: false })
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId, periodStart, periodEnd])

  const { loading, error, changes, truncated } = state
  const untold = changes.filter((c) => !c.notified_at).length

  return (
    <Modal open onClose={onClose} title="Changes since publish" size="lg">
      <div>
        <div className="text-xs text-un1t-subtle mb-3">{periodLabel}</div>

        {loading && (
          <div className="text-center py-6 text-sm text-un1t-subtle">Loading changes…</div>
        )}

        {!loading && error && (
          <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && changes.length === 0 && (
          <div className="py-6 text-center">
            <div className="text-sm text-un1t-text">No changes since this was published.</div>
            <p className="text-xs text-un1t-subtle mt-1">
              Only edits to shifts on a published roster are recorded here. Edits to a week that is not published yet are part of its first publish.
            </p>
          </div>
        )}

        {!loading && !error && changes.length > 0 && (
          <>
            <div data-testid="roster-change-summary" className="text-xs text-un1t-subtle mb-2">
              {changes.length} change{changes.length === 1 ? '' : 's'}
              {untold > 0 && (
                <span className="text-amber-700"> · {untold} not told yet. Publish again to tell them.</span>
              )}
            </div>
            <ul data-testid="roster-change-list" className="divide-y divide-un1t-border max-h-[60vh] overflow-y-auto">
              {changes.map((c) => (
                <li key={c.id} className="py-2">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm text-un1t-text">
                      {rosterChangeSentence(c)}
                      {c.shift_name ? <span className="text-un1t-subtle"> · {c.shift_name}</span> : null}
                    </span>
                    <span
                      className={`flex-shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded ${c.notified_at ? 'bg-green-500/10 text-green-700' : 'bg-amber-500/10 text-amber-700'}`}
                    >
                      {rosterChangeTold(c)}
                    </span>
                  </div>
                  <div className="text-[11px] text-un1t-subtle mt-0.5">{rosterChangeByline(c)}</div>
                </li>
              ))}
            </ul>
            {truncated && (
              <p className="text-xs text-un1t-subtle mt-2">Showing the most recent 5,000. Pick a shorter period to see older ones.</p>
            )}
          </>
        )}

        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-md text-sm border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
```

Chip contrast rule (`check:guardrails`, `no-low-contrast-chip`): status chips are `bg-<c>-500/10 text-<c>-700`. Both chips above follow it. Colour tokens are the current `un1t-*` intent names (`un1t-text`, `un1t-subtle`, `un1t-border`); an old name emits no CSS and is lint-refused.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/components/schedule/RosterChangeLogDrawer.test.jsx`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/RosterChangeLogDrawer.jsx src/components/schedule/RosterChangeLogDrawer.test.jsx
git commit -m "CHANGELOG.1 — Changes since publish drawer"
```

---

### Task 5: open it from the Published chip

**Files:** Modify `src/components/ScheduleCalendar.jsx`, `src/components/ScheduleCalendar.visibility.test.jsx`.

The chip today (`ScheduleCalendar.jsx:1113-1135`) is a `<span role="status" data-testid="publication-status">`. Existing tests read its `textContent`, and one is `$`-anchored (`/Week status: Published$/`, visibility test line 132). So: **the chip's text does not change.** When the period is `published` or `partial` (the only states in which a change log can exist) the same content renders inside a `<button>`; otherwise it stays a `<span>`. The `role="status"` live region moves to the wrapper `<div>`, so a status change is still announced and the button does not carry a conflicting role.

- [ ] **Step 1: Write the failing test**

(a) In `src/components/ScheduleCalendar.visibility.test.jsx`, declare above `mockFetch` (line 74):

```js
// CHANGELOG.1 — what the drawer's read answers. Reassigned per test.
let CHANGES = []
```

and add a branch inside `mockFetch`, BEFORE the final `else`, so the drawer's read gets a proper answer instead of the generic `{ success, impact }`:

```js
    else if (u.includes('/api/schedule/change-log')) body = { success: true, data: { changes: CHANGES, truncated: false } }
```

(b) New describe at the end of the file:

```js
describe('changes since publish (CHANGELOG.1)', () => {
  const changeLogCalls = () => global.fetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/api/schedule/change-log'))

  beforeEach(() => { CHANGES = [] })

  it('the Published chip is a button that opens the drawer for the week on screen', async () => {
    CHANGES = [{
      id: 'c1', action: 'assigned', block_id: 'ok', block_date: BLOCK_DATE, start_time: '12:00:00', end_time: '13:00:00',
      shift_name: 'Lunch', coach_id: 'u3', coach_name: 'Coach A', actor_name: 'Manager B',
      details: {}, notified_at: null, created_at: `${BLOCK_DATE}T10:00:00.000+00:00`,
    }]
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    const chip = screen.getByTestId('publication-status')
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.getAttribute('type')).toBe('button')
    // Nothing is fetched until it is asked for.
    expect(changeLogCalls()).toHaveLength(0)

    fireEvent.click(chip)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Changes since publish')).toBeTruthy()
    expect(await within(dialog).findByText(/Assigned Coach A to/)).toBeTruthy()

    const sunday = new Date(`${isoMonday()}T00:00:00`)
    sunday.setDate(sunday.getDate() + 6)
    expect(changeLogCalls()).toEqual([`/api/schedule/change-log?location_id=loc1&from=${isoMonday()}&to=${iso(sunday)}`])
  })

  it('a partly published week opens it too', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    expect(screen.getByTestId('publication-status').tagName).toBe('BUTTON')
  })

  it('an unpublished week has nothing to show: the chip stays plain text', async () => {
    await renderCalendar({ blocks: [EMPTY_BLOCK] })
    expect(screen.getByTestId('publication-status').tagName).toBe('SPAN')
  })

  it('closing the drawer returns to the calendar', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    fireEvent.click(screen.getByTestId('publication-status'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('Close'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
```

The last `waitFor` waits for the dialog the TEST just closed to unmount. That is a user action completing, not a bug being waited out.

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/ScheduleCalendar.visibility.test.jsx -t "changes since publish"`
Expected: tests 1 and 2 fail with `expected 'SPAN' to be 'BUTTON'`; test 4 fails with `Unable to find role="dialog"`. Test 3 passes already; it is the guard that the unpublished case is untouched.

- [ ] **Step 3: Minimal implementation**

In `src/components/ScheduleCalendar.jsx`:

(a) Import, after line 65 (`import ScheduleErrorBanner from './schedule/ScheduleErrorBanner'`):

```js
import RosterChangeLogDrawer from './schedule/RosterChangeLogDrawer'
```

(b) State, after line 216 (`const [publishModal, setPublishModal] = useState(null) …`):

```js
  // CHANGELOG.1 — { start, end, label } while the "Changes since publish"
  // drawer is open. The period is captured at click time so the drawer keeps
  // describing the period it was opened for.
  const [changeLog, setChangeLog] = useState(null)
```

(c) Replace the chip's `return ( … )` (lines 1123-1135, inside the IIFE that starts on line 1113; keep the `chip`, `Icon`, `periodWord`, `label` and `extra` consts above it) with:

```jsx
            // CHANGELOG.1 — a published (or partly published) period can have
            // post-publish edits, so its chip opens the change log. The TEXT is
            // identical either way; only the element differs.
            const canOpenLog = publication.status === 'published' || publication.status === 'partial'
            const chipCls = `inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${chip.cls}`
            const chipBody = (
              <>
                <Icon size={12} aria-hidden="true" />
                <span className="sr-only">{periodWord} status: </span>
                {label}{extra}
              </>
            )
            return (
              <div className="mt-1.5 flex justify-center" role="status">
                {canOpenLog ? (
                  <button
                    type="button"
                    data-testid="publication-status"
                    aria-haspopup="dialog"
                    title="See changes since publish"
                    onClick={() => setChangeLog({
                      start: visiblePeriodStart,
                      end: visiblePeriodEnd,
                      label: viewType === 'month' ? monthLabel : weekLabel,
                    })}
                    className={`${chipCls} cursor-pointer hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600`}
                  >
                    {chipBody}
                  </button>
                ) : (
                  <span data-testid="publication-status" className={chipCls}>
                    {chipBody}
                  </span>
                )}
              </div>
            )
```

`visiblePeriodStart` / `visiblePeriodEnd` (lines 554-555) and `weekLabel` / `monthLabel` (lines 345, 347) already exist in this component.

(d) Render, directly after the `PublishRosterModal` block (ends line 1793):

```jsx
      {/* CHANGELOG.1 — Changes since publish */}
      {changeLog && (
        <RosterChangeLogDrawer
          locationId={locationId}
          periodStart={changeLog.start}
          periodEnd={changeLog.end}
          periodLabel={changeLog.label}
          onClose={() => setChangeLog(null)}
        />
      )}
```

- [ ] **Step 4: Run it, expect PASS**

```bash
npx vitest run src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.a11y.test.jsx
```

Expected: all pass, including the five pre-existing `publication status chip (ROSTERVIS.1)` tests: their text assertions (one `$`-anchored) still hold because the chip's text is unchanged, and `getByTestId('publication-status')` finds either element.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.visibility.test.jsx
git commit -m "CHANGELOG.1 — the Published chip opens Changes since publish"
```

---

### Task 6: push, PR, changelog

- [ ] **Step 1: Run the PR gate below. Then:**

```bash
git push -u origin HEAD
gh pr create --base main --fill
```

- [ ] **Step 2: Changelog row** (a NEW row at the top of the table in `docs/CHANGELOG.md`, keyed by the PR number `gh` printed; never edit a pushed row, `merge=union` duplicates it)

```
| #<PR> | CHANGELOG.1 — the schedule's Published chip opens "Changes since publish": every edit to that published week or month as a sentence, who made it, and whether the coach has been told | 2026-09-19. No migration (mig 236 already had the table and an audit-view index nothing used); nothing under `mobile/` or `shared/` changed, so **no OTA**. `GET /api/schedule/change-log?location_id&from&to`: manager role AT location_id + `assertLocationAccess`, the same gate as `week-cost`; range capped at 92 days; a failed read is a 500, never an empty list. `listRosterChanges` pages past the 1,000-row cap over a total order (`created_at desc, id desc`), names both `profiles` FKs, ceiling 5,000 with a `truncated` flag. `roster-change-format.js` is pure and covers every `details` shape the writers produce. The chip's text is unchanged; it is a `<button>` only when the period is published or partly published. Names and times only. |
```

```bash
git add docs/CHANGELOG.md
git commit -m "CHANGELOG.1 — changelog"
git push
```

---

### PR gate

Focused tests:

```bash
npx vitest run src/lib/roster-change-format.test.js src/lib/roster-change-log.test.js \
  src/app/api/schedule/change-log/route.test.js src/lib/openapi.test.js \
  src/components/schedule/RosterChangeLogDrawer.test.jsx \
  src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.a11y.test.jsx
for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/roster-change-format.test.js; done
```

Repo checks relevant to this change:

- [ ] `npm run lint`
- [ ] `npm run check:route-guards` — a NEW route. Passes on `getCurrentUser(`; the route count rises by one. No `EXEMPT` / `SESSION_GUARDS` entry.
- [ ] `npm run check:location-scoping` — `roster_change_log` carries `location_id`, so it is a tenant table. The route has no `.from(` and calls `assertLocationAccess(`. No `EXEMPT` / `SCOPING_HELPERS` entry.
- [ ] `npm run check:select-columns` — one new literal select with three embeds. A red here means a column or an FK hint is misspelt; fix it, never allowlist.
- [ ] `npm run check:guardrails` — chip contrast, `un1t-*` tokens, typed buttons, and the UTC-date rules (the route's span maths uses `Date.parse`, the same form as `src/app/api/schedule/time-off/route.js:161`).
- [ ] `npm run check:mobile-parity` — expected unchanged (no new `WEB_PERMISSIONS` key).
- [ ] `npm test` once, then **`npm run build`** once before pushing. This PR adds a route, a component and three imports; vitest runs on mocked imports and cannot see a bad import path, the build can.

Manual check on the Vercel PREVIEW (local dev has no database; the preview reads prod data, and this feature is GET-only): open a published week as a manager, click the green "Published" chip, and confirm real edits read as sentences with sensible "told" times. Log in as a coach and confirm the chip is absent (it was manager-only already).
