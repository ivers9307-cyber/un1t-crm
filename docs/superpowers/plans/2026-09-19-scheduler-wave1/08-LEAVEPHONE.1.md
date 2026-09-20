## PR LEAVEPHONE.1 — phone leave form shows balance, clashes and history

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Merge order: after 02-HOLIDAYLEAVE.1.** This plan is written against the tree AS 02 LEAVES IT: `countLeaveDays(type, startIso, endIso, nonWorkingDates = null)` in `src/lib/time-off-days.js`, `getNonWorkingDates(db, locationId, startIso, endIso)` in `src/lib/time-off-leave.js`, and the time-off POST charging working days only. Do not start until 02 is on `main`; branch off the `origin/main` that contains it. Line numbers below are 02-era approximations — **every edit is located by quoted text**, never by line number alone.

**Goal:** Before a coach files leave on the phone they see their remaining holiday balance, how many days the request will be charged, and which of their own published shifts it clashes with; after filing they get a confirmation and a "My leave" list with the manager's note and cancel-on-pending.

**Why (evidence, read 2026-09-19):**
- `mobile/app/(staff)/schedule/time-off-new.jsx:42-65` — `submit()` posts and calls `router.back()`. No balance, no clash preview, no success message. The only feedback is the server's 400 `Insufficient holiday balance…` (`src/app/api/schedule/time-off/route.js`, the `type === 'holiday'` balance loop).
- The allowance renders only on web (`src/components/TimeOffManager.jsx:487-510`, `AllowanceSummary`), although `GET /api/schedule/allowances` with no `profile_id` already answers for the caller (`src/app/api/schedule/allowances/route.js:44`) and returns `not_applicable: true` for contractors (`:87`).
- The phone has no list of the coach's own requests. Approved/pending leave shows only as an amber card on the day it covers (the `todaysLeave.map(…)` block in `mobile/app/(staff)/(tabs)/schedule.jsx`); a rejected request and the manager's `review_note` are never shown anywhere on the phone.
- Contractors may only file `unavailable` (the `isTimeOffTypeAllowedFor` gate in the POST, `shared/time-off.js:19-25`) and have no allowance.

**THE SERVER IS THE ONLY SOURCE OF THE DAY COUNT.** After 02 a holiday is charged Mon-Fri MINUS the studio country's bank holidays (`src/lib/bank-holidays.js`) MINUS that studio's `location_holidays` rows. The phone can read neither list, so a phone-side count would say "5 days" for a week the server charges as 4. Therefore:
- the preview branch returns `days` computed by **the same function the POST charges with** — Task 3 extracts `chargeableLeaveSegments()` (`splitAtYearEnd` + 4-arg `countLeaveDays` + 02's `getNonWorkingDates`) and points BOTH the POST and the preview at it, and a test asserts the two agree;
- the phone computes NO days. There is no local fallback: until the preview answers the form says "Counting days…", and if it cannot answer it says the days are counted on submit. The confirmation after submit reads the charged days off the POST's own response (`data_all[].total_days`);
- consequently `countLeaveDays` is NOT moved to `shared/` (an earlier draft of this plan did; dropped as YAGNI, and the `tests/shared-pair-sync.test.js` change with it). `src/lib/time-off-days.js` is not touched by this PR.

**Ships:** ONE merge = a web deploy (one additive branch in an existing GET + a behaviour-preserving refactor of the POST's day count) **and** an OTA (`mobile/app/**`, `mobile/lib/**`, `shared/**` are all publish paths — `.github/workflows/eas-update.yml`). No migration.
**Deploy order / safe-alone:** 02 first (above). Within this PR nothing is ordered by hand — Vercel deploys `main` in ~3 min and phones take the OTA on next launch. The two halves are each safe alone, by construction:
- *Route without OTA:* the branch only runs when `preview=1` is sent. No current client sends it.
- *OTA before the route is live (the 3-minute window, or a Vercel rollback):* the old GET ignores `preview=1` and returns `data: [ …requests ]` (an ARRAY). The new route returns `data: { days, clashes }` (an OBJECT). `leavePreviewFrom()` (Task 5) accepts only the object shape and otherwise reports "unknown", so the form shows no day count and no clash list rather than wrong ones. Pinned by a test.

**Worktree:** create a fresh one — `git fetch origin main && git worktree add ../un1t-crm-leavephone -b leavephone-1 origin/main` (confirm `git log origin/main --oneline | grep HOLIDAYLEAVE.1` finds 02 first). Run every command from there. Never `git stash`. Tests: `npx vitest run <file>` (one file at a time; this is an 8GB machine — do not run `npm test` until the PR gate).

**Rules that bite here (from `CLAUDE.md`):** mobile cannot import `src/lib` — `shared/` is the seam, imported as `shared/<module>` (never `../shared`). There is no React Native component test runner, so every decision lives in `mobile/lib/*.js` with a vitest test and the `.jsx` screens only render what those functions return. Mobile reads other people's data only through `/api/*`. Coaches never see unpublished shifts. The repo is PUBLIC — no real names in fixtures.

**Shared file warning:** sibling PRs 04, 05 and 07 also edit `mobile/app/(staff)/(tabs)/schedule.jsx`. This PR's one edit there (Task 9) is located by quoted text and touches only the floating-button block; rebase onto whatever has merged and re-find the quoted text rather than trusting a line number.

---

### File map

| File | Responsibility |
|---|---|
| `shared/time-off.js` (modify, append) | `leaveRangeLabel`, `leavePreviewLine` — date/shift line formatting shared by both new screens |
| `shared/time-off.test.js` (modify) | tests for them |
| `src/lib/time-off-leave.js` (modify) | `ownShiftPreviewRow`, `findOwnPublishedShifts` (after `findLeaveClashes`); `chargeableLeaveSegments` (after 02's `getNonWorkingDates`) |
| `src/lib/time-off-leave.test.js` (modify) | tests for them |
| `src/app/api/schedule/time-off/route.js` (modify) | POST counts days through `chargeableLeaveSegments`; GET gains the `?preview=1` branch + `previewOwnLeave` helper |
| `src/app/api/schedule/time-off/route.test.js` (modify, append) | preview tests + "POST and preview agree" |
| `src/lib/openapi.js` (modify, insert before the `method: 'post', path: '/api/schedule/time-off'` registration) | register the GET incl. preview |
| `mobile/lib/leave-form.js` (create) | preview parsing, balance view, day-count label, success copy — NO day arithmetic |
| `mobile/lib/leave-form.test.js` (create) | tests |
| `mobile/lib/my-leave.js` (create) | the My leave list's sections/rows |
| `mobile/lib/my-leave.test.js` (create) | tests |
| `mobile/lib/schedule-api.js` (modify, after `getMyTimeOff`) | `getMyAllowance`, `getLeavePreview` |
| `mobile/lib/schedule-api.test.js` (modify, export pin + three tests) | wire contract |
| `mobile/app/(staff)/schedule/time-off-new.jsx` (modify) | render balance, days, clashes; success confirmation |
| `mobile/app/(staff)/schedule/my-leave.jsx` (create) | My leave screen |
| `mobile/app/(staff)/(tabs)/schedule.jsx` (modify, the floating-button block only) | "My leave" entry point |
| `docs/CHANGELOG.md` (modify) | one row, keyed by the PR number, after `gh pr create` |

**Not touched (deliberately):** `src/lib/time-off-days.js`, `shared/time-off-days.js` (does not exist and is not created), `tests/shared-pair-sync.test.js`.

---

### Task 1: Shared formatting — a date range and one clash line

Both new screens print "Mon 5 Oct – Fri 9 Oct" and the form prints one line per clashing shift. `shared/time-off.js` already has a private `shortDay()` (line 99) that `leaveClashPrompt` uses; build on it rather than writing a third date formatter.

**Files:** Modify `shared/time-off.js` (append at end of file, after line 120). Modify `shared/time-off.test.js`.

- [ ] **Step 1: Write the failing tests**

In `shared/time-off.test.js` add `leaveRangeLabel, leavePreviewLine,` to the import list at the top (lines 2-6), then append:

```js
describe('leaveRangeLabel', () => {
  it('one day reads as one day, a range as a range', () => {
    expect(leaveRangeLabel('2026-10-05', '2026-10-05')).toBe('Mon 5 Oct')
    expect(leaveRangeLabel('2026-10-05', '2026-10-09')).toBe('Mon 5 Oct – Fri 9 Oct')
  })
  it('a missing end is the start; a range across a year end names both years', () => {
    expect(leaveRangeLabel('2026-10-05', null)).toBe('Mon 5 Oct')
    expect(leaveRangeLabel('2026-12-30', '2027-01-02')).toBe('Wed 30 Dec 2026 – Sat 2 Jan 2027')
  })
})

describe('leavePreviewLine', () => {
  it('date, effective start–end, template, studio', () => {
    expect(leavePreviewLine({
      block_date: '2026-10-05', start_time: '06:00:00', end_time: '09:00:00',
      template_name: 'Morning', location_name: 'Studio One',
    })).toBe('Mon 5 Oct · 06:00–09:00 · Morning · Studio One')
  })
  it('leaves out whatever is missing rather than printing "null"', () => {
    expect(leavePreviewLine({ block_date: '2026-10-05', start_time: '06:00:00' })).toBe('Mon 5 Oct · 06:00')
    expect(leavePreviewLine({ block_date: '2026-10-05' })).toBe('Mon 5 Oct')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/time-off.test.js`
Expected: the 4 new tests fail with `leaveRangeLabel is not a function` / `leavePreviewLine is not a function`.

- [ ] **Step 3: Implement**

Append to `shared/time-off.js`:

```js
// LEAVEPHONE.1 — "Mon 5 Oct – Fri 9 Oct". The year is printed only when the
// range crosses a year end, where "30 Dec – 2 Jan" alone is ambiguous.
export function leaveRangeLabel(startIso, endIso) {
  const end = endIso || startIso
  if (!startIso) return ''
  if (end === startIso) return shortDay(startIso)
  const crossesYear = String(startIso).slice(0, 4) !== String(end).slice(0, 4)
  const withYear = (iso) => `${shortDay(iso)} ${String(iso).slice(0, 4)}`
  return crossesYear ? `${withYear(startIso)} – ${withYear(end)}` : `${shortDay(startIso)} – ${shortDay(end)}`
}

// LEAVEPHONE.1 — one line per shift the leave form's clash preview lists. The
// times are the EFFECTIVE ones the server resolved (override → block →
// template), so this only trims them to HH:MM.
export function leavePreviewLine(shift) {
  const hhmm = (t) => (t ? String(t).slice(0, 5) : '')
  const start = hhmm(shift?.start_time)
  const end = hhmm(shift?.end_time)
  const time = start && end ? `${start}–${end}` : start
  return [shortDay(shift?.block_date), time, shift?.template_name, shift?.location_name]
    .filter(Boolean)
    .join(' · ')
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run shared/time-off.test.js`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add shared/time-off.js shared/time-off.test.js
git commit -m "LEAVEPHONE.1 — leaveRangeLabel + leavePreviewLine in shared/time-off

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `findOwnPublishedShifts` — the caller's own published live shifts in a range

`findLeaveClashes` (`src/lib/time-off-leave.js`) is the MANAGER's clash read: it returns draft-roster shifts too (a manager may see drafts) and block times without the per-coach override. The coach preview needs two different rules — **published only** (coaches never see unpublished shifts: the same derivation as `src/lib/roster-read.js:130`, `published: b.rosters?.status === 'published'`) and **effective times** (override → block → template, `shared/roster-month.js:46-57`). It reuses the private pager `readAssignmentsInRange` and `clashWindow` ("from today on"), both in the same file.

**Files:** Modify `src/lib/time-off-leave.js`, `src/lib/time-off-leave.test.js`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/time-off-leave.test.js` add `ownShiftPreviewRow, findOwnPublishedShifts,` to the import from `'./time-off-leave.js'` , then append:

```js
describe('own published shifts — the coach leave preview (LEAVEPHONE.1)', () => {
  const asg = (id, date, rosterStatus, extra = {}) => ({
    id, profile_id: 'me', status: 'scheduled', start_time_override: null, end_time_override: null,
    shift_blocks: {
      id: `b-${id}`, block_date: date, start_time: '06:00:00', end_time: '09:00:00', location_id: 'loc-1',
      rosters: rosterStatus ? { status: rosterStatus } : null,
      shift_templates: { name: 'Morning', start_time: '06:00:00', end_time: '07:00:00' },
      locations: { name: 'Studio One' },
    },
    ...extra,
  })

  it('ownShiftPreviewRow resolves times override → block → template and carries nothing else', () => {
    expect(ownShiftPreviewRow(asg('a', '2026-10-05', 'published'))).toEqual({
      id: 'a', block_date: '2026-10-05', start_time: '06:00:00', end_time: '09:00:00',
      template_name: 'Morning', location_name: 'Studio One',
    })
    expect(ownShiftPreviewRow(asg('a', '2026-10-05', 'published', { start_time_override: '07:30:00' })).start_time).toBe('07:30:00')
    const templateOnly = asg('a', '2026-10-05', 'published')
    templateOnly.shift_blocks.start_time = null
    templateOnly.shift_blocks.end_time = null
    expect(ownShiftPreviewRow(templateOnly)).toMatchObject({ start_time: '06:00:00', end_time: '07:00:00' })
  })

  it('returns published, live, in-window shifts of THAT profile only, sorted by date then time', async () => {
    const db = fakeDb((q) => {
      if (q.table !== 'shift_assignments') throw new Error(q.table)
      return { data: [
        asg('late', '2026-10-06', 'published', { start_time_override: '17:00:00' }),
        asg('early', '2026-10-06', 'published'),
        asg('draft', '2026-10-06', 'draft'),
        asg('noroster', '2026-10-06', null),
        asg('dropped', '2026-10-06', 'published', { status: 'cancelled' }),
        asg('other', '2026-10-06', 'published', { profile_id: 'someone-else' }),
      ], error: null }
    })
    const { shifts, error } = await findOwnPublishedShifts(db, 'me', '2026-10-05', '2026-10-09', '2026-09-19')
    expect(error).toBeNull()
    expect(shifts.map((s) => s.id)).toEqual(['early', 'late'])
    // The read itself is scoped to the one profile and the requested window.
    const q = queriesOf(db, 'shift_assignments')[0]
    expect(q.calls).toContainEqual(['in', 'profile_id', ['me']])
    expect(q.calls).toContainEqual(['gte', 'shift_blocks.block_date', '2026-10-05'])
    expect(q.calls).toContainEqual(['lte', 'shift_blocks.block_date', '2026-10-09'])
  })

  it('starts at today (past shifts are history) and makes NO read for a range wholly in the past', async () => {
    const db = fakeDb(() => ({ data: [], error: null }))
    await findOwnPublishedShifts(db, 'me', '2026-09-01', '2026-09-30', '2026-09-19')
    expect(queriesOf(db, 'shift_assignments')[0].calls).toContainEqual(['gte', 'shift_blocks.block_date', '2026-09-19'])

    const past = fakeDb(() => { throw new Error('must not query') })
    expect(await findOwnPublishedShifts(past, 'me', '2026-08-01', '2026-08-02', '2026-09-19')).toEqual({ shifts: [], error: null })
  })

  it('a failed read is an error, never an empty list that reads as "no clashes"', async () => {
    const db = fakeDb(() => ({ data: null, error: { message: 'boom' } }))
    const res = await findOwnPublishedShifts(db, 'me', '2026-10-05', '2026-10-09', '2026-09-19')
    expect(res.shifts).toEqual([])
    expect(res.error).toEqual({ message: 'boom' })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/time-off-leave.test.js`
Expected: the 4 new tests fail — `ownShiftPreviewRow is not a function`.

- [ ] **Step 3: Implement**

In `src/lib/time-off-leave.js` add one import directly below `import { isLiveAssignment } from '@/lib/roster'` (02 added an import in the same place — keep both):

```js
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'
```

Then insert directly after the `findLeaveClashes` function (before the `/** Pure. request id → number of live shifts…` comment that introduces `bucketClashCounts`):

```js
// ── Own-shift preview (LEAVEPHONE.1) ──────────────────────────────────────
//
// What a COACH is shown before filing leave: their own shifts inside the
// range. Not findLeaveClashes — that is the approver's read (drafts included,
// block times). Two rules differ here, both load-bearing:
//   • PUBLISHED ONLY. A coach never sees an unpublished shift; "published" is
//     derived from the block's roster exactly as roster-read.js toApiShiftRow
//     does. A block with no roster is not published.
//   • EFFECTIVE times: assignment override → block → template, the calendar's
//     resolution (shared/roster-month.js).
// The row is an allow-list: id, date, times, template name, studio name.
const OWN_SHIFT_PREVIEW_SELECT =
  'id, profile_id, status, start_time_override, end_time_override, shift_blocks!inner(id, block_date, start_time, end_time, location_id, rosters:roster_id(status), shift_templates(name, start_time, end_time), locations(name))'

/** Pure. One embedded shift_assignments row → the preview row. */
export function ownShiftPreviewRow(a) {
  const b = a?.shift_blocks || {}
  const tpl = b.shift_templates || {}
  const shape = {
    start_time_override: a?.start_time_override || null,
    end_time_override: a?.end_time_override || null,
    block_start_time: b.start_time || null,
    block_end_time: b.end_time || null,
    shift_templates: tpl,
  }
  return {
    id: a?.id,
    block_date: b.block_date,
    start_time: effectiveShiftStart(shape),
    end_time: effectiveShiftEnd(shape),
    template_name: tpl.name || null,
    location_name: b.locations?.name || null,
  }
}

/**
 * The profile's own PUBLISHED, live shifts inside [startIso, endIso], from
 * today on, at any studio. `profileId` must be the authenticated caller — the
 * route never takes it from the request.
 */
export async function findOwnPublishedShifts(db, profileId, startIso, endIso, todayIso) {
  const win = clashWindow({ start_date: startIso, end_date: endIso }, todayIso)
  if (!profileId || !win) return { shifts: [], error: null }
  const { rows, error } = await readAssignmentsInRange(db, [profileId], win.lo, win.hi, OWN_SHIFT_PREVIEW_SELECT)
  if (error) return { shifts: [], error }
  const shifts = rows
    .filter(isLiveAssignment)
    .filter((a) => a.profile_id === profileId)
    .filter((a) => a.shift_blocks?.rosters?.status === 'published')
    .map(ownShiftPreviewRow)
    .filter((s) => s.block_date >= win.lo && s.block_date <= win.hi)
    .sort((x, y) => (x.block_date + (x.start_time || '')).localeCompare(y.block_date + (y.start_time || '')))
  return { shifts, error: null }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/time-off-leave.test.js`
Expected: all passed.

- [ ] **Step 5: Prove every column in the new select exists**

Run: `npm run check:select-columns`
Expected: exit 0. (`shift_assignments.start_time_override`/`end_time_override` are mig 099; `shift_blocks.roster_id` mig 072; the select string is a plain literal in a const, which the checker skips in silence — so ALSO eyeball it against `API_SHIFT_SELECT` in `src/lib/roster-read.js:95-104`, which names the same columns and is live in prod.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/time-off-leave.js src/lib/time-off-leave.test.js
git commit -m "LEAVEPHONE.1 — findOwnPublishedShifts: own, published, live, effective times

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `chargeableLeaveSegments` — ONE day count for the POST and the preview

After 02 the POST counts days inline: it calls `getNonWorkingDates(db, targetLocation, start_date, end_date)` when `type === 'holiday' && targetLocation`, then maps `splitAtYearEnd(start_date, end_date)` through `countLeaveDays(type, s, e, nonWorkingDates)` (02 Task 3, the block that begins `// HOLIDAYLEAVE.1 — a holiday is charged for working days only`). If the preview re-implemented that, the two would drift the next time the rule changes — exactly what happened between the first draft of this plan and 02. So the block moves into one function, and both callers use it.

**Files:** Modify `src/lib/time-off-leave.js`, `src/lib/time-off-leave.test.js`, `src/app/api/schedule/time-off/route.js`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/time-off-leave.test.js` add `chargeableLeaveSegments,` to the import from `'./time-off-leave.js'`, then append:

```js
describe('chargeableLeaveSegments — the one day count (LEAVEPHONE.1)', () => {
  // Mon 1 Jun 2026 is the Irish June Public Holiday (src/lib/bank-holidays.js).
  function holidayDb({ country = 'IE', closures = [], locError = null, closuresError = null } = {}) {
    return fakeDb((q) => {
      if (q.table === 'locations') return { data: locError ? null : { country }, error: locError }
      if (q.table === 'location_holidays') return { data: closuresError ? null : closures, error: closuresError }
      throw new Error(`unexpected read of ${q.table}`)
    })
  }

  it('holiday: Mon-Fri minus the bank holiday minus the studio\'s own closure', async () => {
    const db = holidayDb({ closures: [{ date: '2026-06-03', name: 'Studio closed' }] })
    const res = await chargeableLeaveSegments(db, { type: 'holiday', locationId: 'loc-1', startIso: '2026-06-01', endIso: '2026-06-07' })
    expect(res).toEqual({ segments: [{ s: '2026-06-01', e: '2026-06-07', days: 3 }], total: 3, error: null })
    expect(queriesOf(db, 'location_holidays')[0].eq).toEqual({ location_id: 'loc-1' })
  })

  it('one segment per year, each counted on its own', async () => {
    const res = await chargeableLeaveSegments(holidayDb(), { type: 'holiday', locationId: 'loc-1', startIso: '2026-12-30', endIso: '2027-01-04' })
    // 30, 31 Dec are working days; Fri 1 Jan 2027 is New Year's Day; Mon 4 Jan works.
    expect(res.segments).toEqual([{ s: '2026-12-30', e: '2026-12-31', days: 2 }, { s: '2027-01-01', e: '2027-01-04', days: 1 }])
    expect(res.total).toBe(3)
  })

  it('other leave types count calendar days and read NOTHING', async () => {
    const db = fakeDb(() => { throw new Error('must not query') })
    const res = await chargeableLeaveSegments(db, { type: 'sick', locationId: 'loc-1', startIso: '2026-06-01', endIso: '2026-06-07' })
    expect(res).toMatchObject({ total: 7, error: null })
  })

  it('holiday with no studio to ask counts Mon-Fri (the POST\'s own fallback)', async () => {
    const db = fakeDb(() => { throw new Error('must not query') })
    expect((await chargeableLeaveSegments(db, { type: 'holiday', locationId: null, startIso: '2026-06-01', endIso: '2026-06-07' })).total).toBe(5)
  })

  it('fails CLOSED — an unreadable list is an error, never "no bank holidays"', async () => {
    const res = await chargeableLeaveSegments(holidayDb({ closuresError: { message: 'boom' } }), { type: 'holiday', locationId: 'loc-1', startIso: '2026-06-01', endIso: '2026-06-07' })
    expect(res).toEqual({ segments: [], total: 0, error: { message: 'boom' } })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/time-off-leave.test.js`
Expected: the 5 new tests fail — `chargeableLeaveSegments is not a function`.

- [ ] **Step 3: Implement the function**

In `src/lib/time-off-leave.js`, widen the import 02 added (`import { nonWorkingDateSet } from '@/lib/time-off-days'`) to:

```js
import { nonWorkingDateSet, countLeaveDays, splitAtYearEnd } from '@/lib/time-off-days'
```

and insert directly after 02's `getNonWorkingDates` function (before the `// ── Shift clashes` divider):

```js
/**
 * LEAVEPHONE.1 — THE day count: what a request of this type and range is
 * charged, one segment per calendar year (each year has its own allowance).
 * The time-off POST charges with it and the leave form's preview displays it,
 * so the phone can never show a number the server will not charge. Any change
 * to the rule (HOLIDAYLEAVE.1 added bank holidays + studio closures) lands in
 * both at once.
 *
 * Only `holiday` consults the non-working dates, and only when there is a
 * studio to ask. Fails CLOSED like getNonWorkingDates: an unreadable list is
 * an error, never an empty set (which would over-charge).
 *
 * @returns {Promise<{ segments: Array<{ s: string, e: string, days: number }>, total: number, error: object|null }>}
 */
export async function chargeableLeaveSegments(db, { type, locationId, startIso, endIso }) {
  let nonWorkingDates = null
  if (type === 'holiday' && locationId) {
    const { dates, error } = await getNonWorkingDates(db, locationId, startIso, endIso)
    if (error) return { segments: [], total: 0, error }
    nonWorkingDates = dates
  }
  const segments = splitAtYearEnd(startIso, endIso)
    .map(([s, e]) => ({ s, e, days: countLeaveDays(type, s, e, nonWorkingDates) }))
  return { segments, total: segments.reduce((sum, seg) => sum + seg.days, 0), error: null }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/time-off-leave.test.js`
Expected: all passed.

- [ ] **Step 5: Point the POST at it (a refactor — 02's tests are the safety net)**

In `src/app/api/schedule/time-off/route.js`:

(a) DELETE the line `import { countLeaveDays, splitAtYearEnd } from '@/lib/time-off-days'` — the route no longer counts days itself, and `npm run lint` fails on the unused import otherwise.

(b) In the `@/lib/time-off-leave` import list, replace `getNonWorkingDates` (02 added it) with `chargeableLeaveSegments`:

```js
import {
  getLocationMemberIds, getProfileLocationIds, leaveScopeOrFilter, canDecideTimeOff,
  resolveTimeOffApproverIds, getEmploymentType, getHolidayAllowance, ensureHolidayAllowanceRow,
  countLeaveClashes, findLeaveClashes, chargeableLeaveSegments,
} from '@/lib/time-off-leave'
```

(c) In `POST`, replace the whole block 02 wrote — from the comment `// HOLIDAYLEAVE.1 — a holiday is charged for working days only, so load the` down to and including the statement `.map(([s, e]) => ({ s, e, days: countLeaveDays(type, s, e, nonWorkingDates) }))` — with:

```js
  // HOLIDAYLEAVE.1 — a holiday is charged for working days only (Mon-Fri,
  // minus the studio country's bank holidays, minus the studio's closures).
  // ROSTER-FIX.2 — a range that straddles 31 December becomes one row per
  // year, so each year's allowance is charged its own days.
  // LEAVEPHONE.1 — both live in chargeableLeaveSegments, which the leave
  // form's preview (GET ?preview=1) ALSO calls: the number a coach is shown
  // before filing is this number. Fails closed: an unreadable holiday list is
  // a 500, never "no bank holidays".
  const { segments, error: segmentsError } = await chargeableLeaveSegments(db, {
    type, locationId: targetLocation, startIso: start_date, endIso: end_date,
  })
  if (segmentsError) {
    return NextResponse.json({ success: false, error: segmentsError.message }, { status: 500 })
  }
```

Nothing else in the POST changes: the "No working days" 400, the balance loop and the insert all still read `segments` / `seg.days`.

- [ ] **Step 6: Run the route tests, expect PASS with NO test edits**

Run: `npx vitest run src/app/api/schedule/time-off/route.test.js`
Expected: all passed — every one of 02's POST tests (4-not-5, own closure, fail-closed 500, year-straddling, sick leave reads no holidays) unchanged. If one fails, the refactor changed behaviour: fix the route, not the test.

- [ ] **Step 7: Commit**

```bash
git add src/lib/time-off-leave.js src/lib/time-off-leave.test.js src/app/api/schedule/time-off/route.js
git commit -m "LEAVEPHONE.1 — chargeableLeaveSegments: one day count for the time-off POST and the preview

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `GET /api/schedule/time-off?preview=1&type=&start_date=&end_date=&location_id=`

The shape that fits the existing route: the GET already takes `location_id`, `start_date` and `end_date`, so the preview reuses those names and adds `preview=1` and `type`. It answers the two things the form cannot know on its own:

- **`days`** — what the POST WOULD charge, from `chargeableLeaveSegments` (Task 3), for the studio the POST would file it at: `location_id`, else the caller's active studio — the POST's own `targetLocation` rule;
- **`clashes`** — the caller's own published shifts in the range (Task 2).

It returns an OBJECT where the list returns an ARRAY — that difference is what lets an OTA'd phone tell an old deployment from a new one (see **Ships**).

Rules, each pinned by a test below:
- the profile is ALWAYS `user.id` — a `profile_id` in the query string is ignored, for managers too;
- published rosters only (Task 2);
- an unreadable roster OR an unreadable holiday list is a 500 — never an empty clash list, never a day count that ignores bank holidays;
- an unknown `type`, bad/missing dates, `end < start` and spans over 366 days are 400s;
- the preview's `days.total` equals the sum of `total_days` the POST inserts for the same input.

**Files:** Modify `src/app/api/schedule/time-off/route.js`, `src/app/api/schedule/time-off/route.test.js`, `src/lib/openapi.js`.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/api/schedule/time-off/route.test.js`:

```js
// LEAVEPHONE.1 — before filing, the coach's leave form asks the SERVER two
// things: how many days will this be charged, and which of MY shifts does it
// hit? Own rows only, published only, and the POST's own day count.
describe('GET /api/schedule/time-off?preview=1 — charged days + own published shifts', () => {
  const getReq = (qs) => ({ url: `http://x/api/schedule/time-off${qs}`, headers: { get: () => '' } })
  const asg = (id, profile_id, date, rosterStatus) => ({
    id, profile_id, status: 'scheduled', start_time_override: null, end_time_override: null,
    shift_blocks: {
      id: `b-${id}`, block_date: date, start_time: '06:00:00', end_time: '09:00:00', location_id: 'loc-1',
      rosters: { status: rosterStatus },
      shift_templates: { name: 'Morning', start_time: '06:00:00', end_time: '07:00:00' },
      locations: { name: 'Studio One' },
    },
  })
  const MANAGER = { id: 'boss', role: 'manager', profileRole: 'staff', activeLocation: { id: 'loc-1' }, locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } }

  // Only the three tables the preview may read. Anything else — above all the
  // request list the old GET runs — throws.
  function previewDb({ shifts = [], shiftsError = null, closures = [], closuresError = null } = {}) {
    return fakeDb((q) => {
      if (q.table === 'shift_assignments') return { data: shiftsError ? null : shifts, error: shiftsError }
      if (q.table === 'locations') return { data: { country: 'IE' }, error: null }
      if (q.table === 'location_holidays') return { data: closuresError ? null : closures, error: closuresError }
      throw new Error(`preview must not read ${q.table}`)
    })
  }

  it('returns an OBJECT: the days the POST would charge (bank holiday excluded) and the published clashes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-05-20T10:00:00Z'))
    try {
      getCurrentUser.mockResolvedValue(USER)
      const db = previewDb({ shifts: [asg('a1', 'c', '2026-06-02', 'published'), asg('a2', 'c', '2026-06-03', 'draft')] })
      createServerClient.mockReturnValue(db)
      // Mon 1 Jun 2026 is the June Public Holiday: Mon-Sun is 4 days, not 5.
      const res = await GET(getReq('?preview=1&type=holiday&start_date=2026-06-01&end_date=2026-06-07'))
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(Array.isArray(json.data)).toBe(false)
      expect(json.data).toEqual({
        type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-07',
        days: { total: 4, segments: [{ year: 2026, start_date: '2026-06-01', end_date: '2026-06-07', days: 4 }] },
        clashes: [{ id: 'a1', block_date: '2026-06-02', start_time: '06:00:00', end_time: '09:00:00', template_name: 'Morning', location_name: 'Studio One' }],
      })
    } finally { vi.useRealTimers() }
  })

  it('AGREES WITH THE POST — same input, same number, closure and year split included', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const closures = [{ date: '2026-12-30', name: 'Studio closed' }]
    createServerClient.mockReturnValue(previewDb({ closures }))
    // Neither call names a studio, so both fall back to USER.activeLocation —
    // the POST's targetLocation rule and the preview's are the same rule.
    const preview = (await (await GET(getReq('?preview=1&type=holiday&start_date=2026-12-28&end_date=2027-01-05'))).json()).data.days

    const { db, insertSpy } = buildDb({ customHolidays: closures })
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ type: 'holiday', start_date: '2026-12-28', end_date: '2027-01-05' }))).status).toBe(201)
    const inserted = insertSpy.mock.calls[0][0]
    expect(preview.segments.map((s) => s.days)).toEqual(inserted.map((r) => r.total_days))
    expect(preview.total).toBe(inserted.reduce((n, r) => n + r.total_days, 0))
    // Guard against agreeing on a trivial number: 28, 29, 31 Dec (30th closed) + 4, 5 Jan (1st is New Year's Day).
    expect(preview.segments.map((s) => s.days)).toEqual([3, 2])
  })

  it('counts for the studio the POST would file at: location_id, else the active studio', async () => {
    getCurrentUser.mockResolvedValue(USER)
    let db = previewDb(); createServerClient.mockReturnValue(db)
    await GET(getReq('?preview=1&type=holiday&start_date=2099-06-01&end_date=2099-06-05'))
    expect(queriesOf(db, 'location_holidays')[0].eq).toEqual({ location_id: 'loc-1' })   // USER.activeLocation

    getCurrentUser.mockResolvedValue({ ...USER, locations: [{ id: 'loc-1' }, { id: 'loc-2' }] })
    db = previewDb(); createServerClient.mockReturnValue(db)
    await GET(getReq('?preview=1&type=holiday&start_date=2099-06-01&end_date=2099-06-05&location_id=loc-2'))
    expect(queriesOf(db, 'location_holidays')[0].eq).toEqual({ location_id: 'loc-2' })
  })

  it('a non-holiday type counts calendar days and never reads the holiday lists', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const db = previewDb(); createServerClient.mockReturnValue(db)
    const json = await (await GET(getReq('?preview=1&type=unavailable&start_date=2099-06-01&end_date=2099-06-07'))).json()
    expect(json.data.days.total).toBe(7)
    expect(queriesOf(db, 'location_holidays')).toHaveLength(0)
  })

  it('ignores profile_id — a manager previews their OWN shifts, never a colleague\'s', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const db = previewDb(); createServerClient.mockReturnValue(db)
    await GET(getReq('?preview=1&type=holiday&start_date=2099-10-05&end_date=2099-10-09&profile_id=someone-else&location_id=loc-1'))
    const q = queriesOf(db, 'shift_assignments')[0]
    expect(q.calls).toContainEqual(['in', 'profile_id', ['boss']])
    expect(JSON.stringify(q.calls)).not.toContain('someone-else')
  })

  it('400 on an unknown type, missing or malformed dates, an inverted range, and a span over a year', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(previewDb())
    expect((await GET(getReq('?preview=1&start_date=2026-10-05&end_date=2026-10-09'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=sabbatical&start_date=2026-10-05&end_date=2026-10-09'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=holiday'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=holiday&start_date=05/10/2026&end_date=2026-10-09'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2026-10-09&end_date=2026-10-05'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2026-01-01&end_date=2028-01-01'))).status).toBe(400)
  })

  it('end_date defaults to start_date (a one-tap, single-day pick)', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(previewDb())
    const json = await (await GET(getReq('?preview=1&type=sick&start_date=2099-10-05'))).json()
    expect(json.data).toMatchObject({ start_date: '2099-10-05', end_date: '2099-10-05', days: { total: 1 }, clashes: [] })
  })

  it('500 when the holiday list OR the roster cannot be read — never a guessed number, never "no clashes"', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(previewDb({ closuresError: { message: 'boom' } }))
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2099-10-05&end_date=2099-10-09'))).status).toBe(500)
    createServerClient.mockReturnValue(previewDb({ shiftsError: { message: 'boom' } }))
    const res = await GET(getReq('?preview=1&type=holiday&start_date=2099-10-05&end_date=2099-10-09'))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  it('401 without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2099-10-05'))).status).toBe(401)
  })
})
```

(`USER` — `{ id: 'c', …, activeLocation: { id: 'loc-1' } }` — `buildDb`, `req`, `fakeDb`, `queriesOf`, `getCurrentUser`, `createServerClient`, `GET` and `POST` are already in scope at the top of this file. `buildDb`'s `customHolidays` option is the one 02 added in its Task 3; if 02 named it differently on merge, use its name.)

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/time-off/route.test.js`
Expected: 8 of the 9 new tests fail, every one with `Error: preview must not read time_off_requests` (or `… profile_locations` for the manager case) thrown from `previewDb` — the old GET ignores `preview=1` and runs its list query. `401 without a session` already passes; it pins behaviour the branch must keep.

- [ ] **Step 3: Implement**

In `src/app/api/schedule/time-off/route.js`:

(a) Add `findOwnPublishedShifts` to the `@/lib/time-off-leave` import list (it now ends `countLeaveClashes, findLeaveClashes, chargeableLeaveSegments, findOwnPublishedShifts,`).

(b) Replace the one-line comment above `export async function GET` with the two lines below, and add the branch inside `GET` directly after the location guard (`if (guard) return guard`), before `const startDate = searchParams.get('start_date')`:

```js
// GET /api/schedule/time-off?location_id=xxx&start_date=xxx&end_date=xxx&status=xxx&profile_id=xxx
// GET /api/schedule/time-off?preview=1&type=xxx&start_date=xxx&end_date=xxx[&location_id=xxx]   (LEAVEPHONE.1 — see previewOwnLeave)
```

```js
  // LEAVEPHONE.1 — the leave form's preview. A different question from the
  // list below ("what will this cost me, and which of MY shifts does it hit?"),
  // answered for the caller only, so it returns before any of the list's
  // scoping runs. location_id has already cleared assertLocationAccess above.
  if (searchParams.get('preview') === '1') return previewOwnLeave(user, searchParams)
```

(c) Add the helper at the bottom of the file, after `approveRecordedLeave`:

```js
// LEAVEPHONE.1 — GET ?preview=1&type=&start_date=&end_date=[&location_id=]
//
// What the caller's leave form shows BEFORE they file:
//   • days    — what the POST would charge, from the SAME function it charges
//               with (chargeableLeaveSegments), for the studio the POST would
//               file at (location_id, else the active studio — the POST's own
//               targetLocation rule). The phone does no day arithmetic: a
//               holiday's cost depends on bank holidays and studio closures it
//               cannot see.
//   • clashes — the caller's OWN published, live shifts in the range, from
//               today on, at any studio (leave covers the person).
// The profile is ALWAYS user.id: a profile_id in the query string is ignored,
// manager or not. Every read fails closed — a 500, never a guessed number.
// `data` is an OBJECT on purpose: the list above returns an ARRAY, and the
// phone uses that difference to recognise a deployment that predates this
// branch and show nothing rather than something wrong.
async function previewOwnLeave(user, searchParams) {
  const type = timeOffTypeSchema.safeParse(searchParams.get('type'))
  if (!type.success) {
    return NextResponse.json({ success: false, error: 'type must be a valid time-off type' }, { status: 400 })
  }
  const start = searchParams.get('start_date') || ''
  const end = searchParams.get('end_date') || start
  if (!ISO_DATE.safeParse(start).success || !ISO_DATE.safeParse(end).success) {
    return NextResponse.json({ success: false, error: 'start_date and end_date must be YYYY-MM-DD' }, { status: 400 })
  }
  if (end < start) {
    return NextResponse.json({ success: false, error: 'End date must be on or after start date' }, { status: 400 })
  }
  const spanDays = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1
  if (spanDays > 366) {
    return NextResponse.json({ success: false, error: 'Time-off requests are limited to one year' }, { status: 400 })
  }

  const db = createServerClient()
  const locationId = searchParams.get('location_id') || user.activeLocation?.id || null
  const { segments, total, error: daysError } = await chargeableLeaveSegments(db, {
    type: type.data, locationId, startIso: start, endIso: end,
  })
  if (daysError) return NextResponse.json({ success: false, error: daysError.message }, { status: 500 })

  const { shifts, error: shiftsError } = await findOwnPublishedShifts(db, user.id, start, end, dublinTodayStr())
  if (shiftsError) return NextResponse.json({ success: false, error: shiftsError.message }, { status: 500 })

  return NextResponse.json({
    success: true,
    data: {
      type: type.data,
      start_date: start,
      end_date: end,
      days: {
        total,
        segments: segments.map((seg) => ({ year: Number(seg.s.slice(0, 4)), start_date: seg.s, end_date: seg.e, days: seg.days })),
      },
      clashes: shifts,
    },
  })
}
```

(`timeOffTypeSchema`, `ISO_DATE`, `dublinTodayStr` and `createServerClient` are already imported/defined at the top of the route.)

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/time-off/route.test.js`
Expected: all passed (the pre-existing GET and POST tests included — the branch only runs on `preview=1`).

- [ ] **Step 5: Register the GET in the OpenAPI spec**

In `src/lib/openapi.js`, insert directly BEFORE the `registry.registerPath({ method: 'post', path: '/api/schedule/time-off', …` block:

```js
registry.registerPath({
  method: 'get',
  path: '/api/schedule/time-off',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'List time-off requests, or preview what a request would cost the caller',
  description: "Default: time-off requests, scoped per studio role — a non-manager sees only their own; a manager sees leave filed at, or taken by members of, the studios they manage. Filters: location_id, start_date, end_date, status (pending excludes expired; expired asks for exactly those), profile_id (managers), with_clashes=1. With preview=1&type=&start_date=&end_date=[&location_id=] (LEAVEPHONE.1) it answers a different question, for the CALLER only: data.days { total, segments[{ year, start_date, end_date, days }] } is exactly what POST would charge (holiday = Mon-Fri minus the studio country's bank holidays minus that studio's closures; other types = calendar days; one segment per year), and data.clashes[{ id, block_date, start_time, end_time, template_name, location_name }] are the caller's own published, live shifts in the range from today on, with effective times. profile_id is ignored in preview mode and unpublished rosters are never included.",
  responses: {
    200: { description: 'Array of requests; or, with preview=1, { type, start_date, end_date, days, clashes }' },
    400: { description: 'preview=1 with an unknown type, missing/malformed dates, an inverted range, or a span over a year', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'location_id outside the caller’s assignments', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'preview=1 and the holiday list or the roster could not be read (fails closed)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

```

Run: `npx vitest run src/lib/openapi.test.js`
Expected: passed (the file loads the whole registry, so a syntax slip in the block above fails here rather than in `next build`).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/schedule/time-off/route.js src/app/api/schedule/time-off/route.test.js src/lib/openapi.js
git commit -m "LEAVEPHONE.1 — GET time-off?preview=1: the days the POST would charge + own published shifts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `mobile/lib/leave-form.js` — every decision the form makes (and NO day arithmetic)

Two numbers, both the server's:

- **Days** come from the preview (`data.days`, Task 4) before submit and from the POST's own response (`data_all[].total_days`) after it. This module never counts a day: the rule depends on bank holidays and studio closures the phone cannot see (02). There is deliberately no local fallback — a fallback that is sometimes wrong by one is worse than "Counting days…".
- **Available balance** must be the number the POST will judge: `remaining − pendingDays` per year, where `pendingDays` sums `total_days` of the person's `type='holiday'`, RAW `status='pending'` requests whose `start_date` falls in that year (the POST's balance loop — raw status, so an *expired* pending request still counts). `GET /api/schedule/allowances` returns `remaining` WITHOUT that deduction, so the form subtracts the same sum from the coach's own request list (each row's `total_days` is itself server-computed). No extra route.

**Files:** Create `mobile/lib/leave-form.js`, `mobile/lib/leave-form.test.js`.

- [ ] **Step 1: Write the failing tests**

```js
// mobile/lib/leave-form.test.js
// LEAVEPHONE.1 — the leave form's decisions. No RN runtime: the screen renders
// what these return. Note what is NOT here: any counting of days.
import { describe, it, expect } from 'vitest'
import {
  leavePreviewFrom, leaveDaysLabel, pendingHolidayDays, leaveBalanceView, submittedDays, leaveSubmittedMessage,
} from './leave-form'

const ALLOWANCE = { year: 2026, total_days: 20, used_days: 6, carried_over: 1, remaining: 15, not_applicable: false }
const DAYS_4 = { total: 4, segments: [{ year: 2026, start_date: '2026-06-01', end_date: '2026-06-07', days: 4 }] }

describe('leavePreviewFrom', () => {
  it('reads the server\'s days and clashes', () => {
    const clashes = [{ id: 'a1', block_date: '2026-06-02' }]
    expect(leavePreviewFrom({ success: true, data: { type: 'holiday', days: DAYS_4, clashes } }))
      .toEqual({ known: true, days: DAYS_4, clashes })
  })
  it('an ARRAY is an older deployment answering with the request list — unknown, never "0 days / no clashes"', () => {
    expect(leavePreviewFrom({ success: true, data: [{ id: 'req-1' }] })).toEqual({ known: false, days: null, clashes: [] })
  })
  it('a failure, a missing body or a malformed days block is unknown too', () => {
    expect(leavePreviewFrom({ success: false, error: 'x' })).toEqual({ known: false, days: null, clashes: [] })
    expect(leavePreviewFrom(undefined)).toEqual({ known: false, days: null, clashes: [] })
    expect(leavePreviewFrom({ success: true, data: { days: { total: 'four' }, clashes: [] } })).toEqual({ known: false, days: null, clashes: [] })
  })
})

describe('leaveDaysLabel', () => {
  it('says it is waiting, rather than guessing, until the server answers', () => {
    expect(leaveDaysLabel({ loading: true, preview: { known: false, days: null } })).toBe('Counting days…')
  })
  it('shows the server\'s number', () => {
    expect(leaveDaysLabel({ loading: false, preview: { known: true, days: DAYS_4 } })).toBe('This request uses 4 days')
    expect(leaveDaysLabel({ loading: false, preview: { known: true, days: { total: 1, segments: [] } } })).toBe('This request uses 1 day')
    expect(leaveDaysLabel({ loading: false, preview: { known: true, days: { total: 0, segments: [] } } })).toBe('No working days in that range')
  })
  it('when the server could not say, it says so — it never shows a locally computed number', () => {
    expect(leaveDaysLabel({ loading: false, preview: { known: false, days: null } })).toBe('Days are counted when you submit')
  })
})

describe('pendingHolidayDays', () => {
  it('sums RAW-pending holiday requests that START in the year — expired ones included, as the server does', () => {
    const rows = [
      { type: 'holiday', status: 'pending', start_date: '2026-11-02', total_days: 3 },
      { type: 'holiday', status: 'pending', effective_status: 'expired', start_date: '2026-03-02', total_days: 2 },
      { type: 'holiday', status: 'approved', start_date: '2026-07-06', total_days: 5 },
      { type: 'sick', status: 'pending', start_date: '2026-11-09', total_days: 1 },
      { type: 'holiday', status: 'pending', start_date: '2027-01-04', total_days: 4 },
    ]
    expect(pendingHolidayDays(rows, 2026)).toBe(5)
    expect(pendingHolidayDays(null, 2026)).toBe(0)
  })
})

describe('leaveBalanceView', () => {
  const base = { employmentType: 'fte', allowance: ALLOWANCE, requests: [], type: 'holiday', days: DAYS_4 }

  it('hidden for contractors, for a not-applicable allowance, and until the allowance has loaded', () => {
    expect(leaveBalanceView({ ...base, employmentType: 'contractor' })).toBeNull()
    expect(leaveBalanceView({ ...base, allowance: { ...ALLOWANCE, not_applicable: true } })).toBeNull()
    expect(leaveBalanceView({ ...base, allowance: null })).toBeNull()
  })

  it('available = remaining minus pending; a holiday request shows what is left after it', () => {
    const requests = [{ type: 'holiday', status: 'pending', start_date: '2026-11-02', total_days: 3 }]
    expect(leaveBalanceView({ ...base, requests })).toEqual({
      year: 2026, total: 20, used: 6, carriedOver: 1, pending: 3, available: 12,
      requestDays: 4, after: 8, short: false, otherYearDays: 0,
    })
  })

  it('short when the server\'s count is bigger than what is available', () => {
    expect(leaveBalanceView({ ...base, allowance: { ...ALLOWANCE, remaining: 3 } }))
      .toMatchObject({ available: 3, requestDays: 4, after: -1, short: true })
  })

  it('a non-holiday type never touches the balance', () => {
    expect(leaveBalanceView({ ...base, type: 'sick', days: { total: 7, segments: [{ year: 2026, days: 7 }] } }))
      .toMatchObject({ available: 15, requestDays: 0, after: 15, short: false, otherYearDays: 0 })
  })

  it('across a year end only the allowance year\'s segment is charged here; the rest is reported', () => {
    const days = { total: 3, segments: [{ year: 2026, days: 2 }, { year: 2027, days: 1 }] }
    expect(leaveBalanceView({ ...base, days })).toMatchObject({ year: 2026, requestDays: 2, otherYearDays: 1, after: 13 })
  })

  it('until the server has counted, the balance shows with no "after" — never a guess', () => {
    expect(leaveBalanceView({ ...base, days: null })).toMatchObject({ available: 15, requestDays: null, after: null, short: false, otherYearDays: 0 })
  })
})

describe('submittedDays / leaveSubmittedMessage', () => {
  it('the charged days come from the POST response, every year segment included', () => {
    expect(submittedDays({ success: true, data: { total_days: 2 }, data_all: [{ total_days: 2 }, { total_days: 1 }] })).toBe(3)
    expect(submittedDays({ success: true, data: { total_days: 4 } })).toBe(4)
    expect(submittedDays({ success: true, data: {} })).toBeNull()
  })
  it('names the type, the range and the days, and says what happens next', () => {
    expect(leaveSubmittedMessage({ type: 'holiday', startIso: '2026-06-01', endIso: '2026-06-07', days: 4, clashCount: 0 })).toEqual({
      title: 'Request sent',
      message: 'Holiday · Mon 1 Jun – Sun 7 Jun · 4 days.\nYour manager has been notified. Track it under My leave.',
    })
  })
  it('one day is singular; unknown days are left out; clashes get the cover line', () => {
    expect(leaveSubmittedMessage({ type: 'unavailable', startIso: '2026-10-05', endIso: '2026-10-05', days: 1, clashCount: 2 }).message)
      .toBe('Unavailable · Mon 5 Oct · 1 day.\nYour manager has been notified. Track it under My leave.\nYou are still rostered on 2 shifts in that time. A manager will need to cover these.')
    expect(leaveSubmittedMessage({ type: 'sick', startIso: '2026-10-05', endIso: '2026-10-05', days: null, clashCount: 0 }).message)
      .toBe('Sick · Mon 5 Oct.\nYour manager has been notified. Track it under My leave.')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run mobile/lib/leave-form.test.js`
Expected: fails to load — `Failed to resolve import "./leave-form"`.

- [ ] **Step 3: Implement**

```js
// mobile/lib/leave-form.js
// LEAVEPHONE.1 — every decision the "Request time off" form makes, kept out of
// the .jsx because there is no React Native component test runner: the screen
// renders what these return and nothing else.
//
// 🔴 THIS MODULE NEVER COUNTS DAYS. What a request costs is decided by the
// server (chargeableLeaveSegments: Mon-Fri, minus the studio country's bank
// holidays, minus that studio's closures — HOLIDAYLEAVE.1), from lists the
// phone cannot read. The number shown before submit is the preview's
// (GET /api/schedule/time-off?preview=1 → data.days); the number confirmed
// after submit is the POST's (data_all[].total_days). There is no local
// fallback on purpose: "Counting days…" is honest, an off-by-one is not.
//
//   • available — allowance.remaining MINUS pending holiday days. The
//     allowances route returns `remaining` without that deduction, while the
//     POST refuses on `remaining - pendingDays`, so the form subtracts the same
//     sum from the coach's own requests (whose total_days are the server's).

import { isRestrictedEmployment, timeOffTypeLabel, leaveRangeLabel } from 'shared/time-off'

const UNKNOWN_PREVIEW = { known: false, days: null, clashes: [] }

/**
 * The preview route answers { data: { days: { total, segments }, clashes } }.
 * A deployment that predates it ignores `preview=1` and answers with the
 * request LIST (an array), so anything but the object shape is "unknown" —
 * the form then shows no count and no clash list. Unknown must never render
 * as "0 days" or "no clashes".
 */
export function leavePreviewFrom(res) {
  const d = res?.success && !Array.isArray(res.data) ? res.data : null
  if (!d || !Array.isArray(d.clashes) || typeof d.days?.total !== 'number' || !Array.isArray(d.days.segments)) {
    return { ...UNKNOWN_PREVIEW }
  }
  return { known: true, days: d.days, clashes: d.clashes }
}

/** The days card's one line. AUTHORITATIVE when preview.known; otherwise it says it does not know. */
export function leaveDaysLabel({ loading, preview }) {
  if (loading) return 'Counting days…'
  if (!preview?.known || !preview.days) return 'Days are counted when you submit'
  const n = preview.days.total
  if (n <= 0) return 'No working days in that range'
  return `This request uses ${n} ${n === 1 ? 'day' : 'days'}`
}

/**
 * Mirrors the POST's pending read: type 'holiday', RAW status 'pending' (an
 * expired pending request still counts server-side), start_date in the year.
 */
export function pendingHolidayDays(requests, year) {
  return (requests || [])
    .filter((r) => r?.type === 'holiday' && r.status === 'pending' && String(r.start_date).slice(0, 4) === String(year))
    .reduce((n, r) => n + (Number(r.total_days) || 0), 0)
}

/**
 * What the balance card shows, or null when there is no card: contractors and
 * casual staff have no allowance (LEAVE.3), and nothing renders until the
 * allowance has loaded. `days` is the SERVER's preview block (or null while it
 * is unknown — then there is no "after", rather than a guessed one).
 */
export function leaveBalanceView({ employmentType, allowance, requests, type, days }) {
  if (isRestrictedEmployment(employmentType)) return null
  if (!allowance || allowance.not_applicable) return null
  const year = Number(allowance.year)
  const pending = pendingHolidayDays(requests, year)
  const available = Number(allowance.remaining) - pending
  const charged = type === 'holiday' && days ? days : null
  const inYear = charged ? charged.segments.filter((s) => s.year === year).reduce((n, s) => n + s.days, 0) : null
  const requestDays = type !== 'holiday' ? 0 : inYear
  return {
    year,
    total: Number(allowance.total_days),
    used: Number(allowance.used_days),
    carriedOver: Number(allowance.carried_over),
    pending,
    available,
    requestDays,
    after: requestDays === null ? null : available - requestDays,
    short: requestDays !== null && requestDays > available,
    otherYearDays: charged ? charged.total - inYear : 0,
  }
}

/** Days the POST actually charged: every year segment it inserted. null when the response does not say. */
export function submittedDays(res) {
  const rows = Array.isArray(res?.data_all) && res.data_all.length > 0 ? res.data_all : (res?.data ? [res.data] : [])
  const nums = rows.map((r) => Number(r?.total_days)).filter((n) => Number.isFinite(n))
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null
}

/** The confirmation shown after a successful submit. `days` is submittedDays(res). */
export function leaveSubmittedMessage({ type, startIso, endIso, days, clashCount }) {
  const head = [timeOffTypeLabel(type), leaveRangeLabel(startIso, endIso)]
  if (days !== null && days !== undefined) head.push(`${days} ${days === 1 ? 'day' : 'days'}`)
  const lines = [`${head.join(' · ')}.`, 'Your manager has been notified. Track it under My leave.']
  const c = Number(clashCount) || 0
  if (c > 0) lines.push(`You are still rostered on ${c} ${c === 1 ? 'shift' : 'shifts'} in that time. A manager will need to cover these.`)
  return { title: 'Request sent', message: lines.join('\n') }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run mobile/lib/leave-form.test.js`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/leave-form.js mobile/lib/leave-form.test.js
git commit -m "LEAVEPHONE.1 — mobile/lib/leave-form: server-counted days, balance, preview parsing, confirmation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `mobile/lib/my-leave.js` — the My leave list

The GET list rows already carry everything needed: `*` (so `review_note`, `total_days`, `reason`), `reviewer:profiles!reviewed_by(id, full_name)` and the derived `effective_status` (`route.js:53-57, 106-110`). Cancel keeps the existing rule — `canCancelTimeOff(row, profile)` in `mobile/lib/schedule-manage.js:117-121` (raw status `pending` AND the row is the caller's), which mirrors what `PUT /api/schedule/time-off/[id]` allows a requester (`[id]/route.js:69-71`).

**Files:** Create `mobile/lib/my-leave.js`, `mobile/lib/my-leave.test.js`.

- [ ] **Step 1: Write the failing tests**

```js
// mobile/lib/my-leave.test.js
import { describe, it, expect } from 'vitest'
import { myLeaveRow, myLeaveSections } from './my-leave'

const ME = { id: 'me' }
const row = (id, status, start, extra = {}) => ({
  id, profile_id: 'me', type: 'holiday', status, effective_status: status,
  start_date: start, end_date: start, total_days: 1, reason: null, review_note: null, reviewer: null, ...extra,
})

describe('myLeaveRow', () => {
  it('carries the label, range, days, status and the manager\'s note', () => {
    expect(myLeaveRow(row('r1', 'rejected', '2026-10-05', {
      end_date: '2026-10-09', total_days: 5, review_note: 'Two others are already off that week.', reviewer: { id: 'm', full_name: 'Manager One' },
    }), ME)).toEqual({
      id: 'r1', title: 'Holiday', range: 'Mon 5 Oct – Fri 9 Oct', days: 5,
      status: 'rejected', statusLabel: 'Declined', tone: 'red',
      reason: null, note: 'Two others are already off that week.', reviewer: 'Manager One', canCancel: false,
    })
  })
  it('cancel is offered on the caller\'s own pending request only — the existing rule', () => {
    expect(myLeaveRow(row('r1', 'pending', '2026-10-05'), ME).canCancel).toBe(true)
    expect(myLeaveRow(row('r1', 'approved', '2026-10-05'), ME).canCancel).toBe(false)
    expect(myLeaveRow(row('r1', 'pending', '2026-10-05', { profile_id: 'other' }), ME).canCancel).toBe(false)
  })
  it('an expired pending request reads Expired', () => {
    const r = myLeaveRow(row('r1', 'pending', '2026-03-02', { effective_status: 'expired' }), ME)
    expect(r).toMatchObject({ status: 'expired', statusLabel: 'Expired', tone: 'slate' })
  })
})

describe('myLeaveSections', () => {
  it('groups by status in a fixed order, drops empty groups and other people\'s rows', () => {
    const sections = myLeaveSections([
      row('c1', 'cancelled', '2026-05-04'),
      row('a2', 'approved', '2026-11-02'),
      row('p1', 'pending', '2026-10-05'),
      row('a1', 'approved', '2026-10-12'),
      row('x', 'pending', '2026-10-05', { profile_id: 'someone-else' }),
    ], ME)
    expect(sections.map((s) => [s.key, s.title, s.rows.map((r) => r.id)])).toEqual([
      ['pending', 'Pending', ['p1']],
      ['approved', 'Approved', ['a1', 'a2']],
      ['cancelled', 'Cancelled', ['c1']],
    ])
  })
  it('open groups run soonest-first; closed groups run most-recent-first', () => {
    const sections = myLeaveSections([
      row('r-old', 'rejected', '2026-02-02'), row('r-new', 'rejected', '2026-08-03'),
    ], ME)
    expect(sections[0].rows.map((r) => r.id)).toEqual(['r-new', 'r-old'])
  })
  it('tolerates null', () => {
    expect(myLeaveSections(null, ME)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run mobile/lib/my-leave.test.js`
Expected: fails to load — `Failed to resolve import "./my-leave"`.

- [ ] **Step 3: Implement**

```js
// mobile/lib/my-leave.js
// LEAVEPHONE.1 — the "My leave" list: the coach's own requests grouped by
// status, with the manager's review note. Pure; the screen only renders it.
//
// `effective_status` is the server's (GET /api/schedule/time-off annotates
// every row, LEAVE.2): a pending request whose last day has passed is
// 'expired'. Cancel is NOT re-decided here — canCancelTimeOff is the existing
// rule and the same one the Schedule tab's amber card uses.

import { timeOffLeaveLabel, leaveRangeLabel } from 'shared/time-off'
import { canCancelTimeOff } from './schedule-manage'

const STATUS = {
  pending: { title: 'Pending', label: 'Pending', tone: 'amber' },
  approved: { title: 'Approved', label: 'Approved', tone: 'green' },
  rejected: { title: 'Declined', label: 'Declined', tone: 'red' },
  cancelled: { title: 'Cancelled', label: 'Cancelled', tone: 'slate' },
  expired: { title: 'Expired', label: 'Expired', tone: 'slate' },
}
const ORDER = ['pending', 'approved', 'rejected', 'cancelled', 'expired']
// Soonest first where the leave is still ahead of you; most recent first for
// the history groups.
const ASCENDING = new Set(['pending', 'approved'])

export function myLeaveRow(r, profile) {
  const status = STATUS[r?.effective_status] ? r.effective_status : (STATUS[r?.status] ? r.status : 'pending')
  return {
    id: r.id,
    title: timeOffLeaveLabel(r.type),
    range: leaveRangeLabel(r.start_date, r.end_date),
    days: Number(r.total_days) || 0,
    status,
    statusLabel: STATUS[status].label,
    tone: STATUS[status].tone,
    reason: r.reason || null,
    note: r.review_note || null,
    reviewer: r.reviewer?.full_name || null,
    canCancel: status === 'pending' && canCancelTimeOff(r, profile),
  }
}

export function myLeaveSections(requests, profile) {
  const mine = (requests || []).filter((r) => r && r.profile_id === profile?.id)
  return ORDER.map((key) => {
    const dir = ASCENDING.has(key) ? 1 : -1
    const rows = mine
      .filter((r) => (STATUS[r.effective_status] ? r.effective_status : r.status) === key)
      .sort((a, b) => dir * String(a.start_date).localeCompare(String(b.start_date)))
      .map((r) => myLeaveRow(r, profile))
    return { key, title: STATUS[key].title, rows }
  }).filter((s) => s.rows.length > 0)
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run mobile/lib/my-leave.test.js`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/my-leave.js mobile/lib/my-leave.test.js
git commit -m "LEAVEPHONE.1 — mobile/lib/my-leave: sections, rows, cancel rule

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Wire wrappers — `getMyAllowance`, `getLeavePreview`

`mobile/lib/schedule-api.test.js` pins the module's EXACT export list (the `exports exactly the helpers this file pins` test), so a new wrapper fails that test until it is listed and given its own contract test. That is the point of the file.

`getLeavePreview` must send the SAME `location_id` that `createTimeOffRequest` will send (`locationId` → `location_id`): the day count is per studio (closures, country), and the preview is only authoritative if it asks about the studio the request will be filed at.

**Files:** Modify `mobile/lib/schedule-api.js`, `mobile/lib/schedule-api.test.js`.

- [ ] **Step 1: Write the failing tests**

In `mobile/lib/schedule-api.test.js`, add the two names to the pinned list. The list is compared `.sort()`ed, so insert exactly — replace the adjacent pair `'getLocationStaff', 'getMyShifts',` with:

```js
      'getLeavePreview',
      'getLocationStaff',
      'getMyAllowance',
      'getMyShifts',
```

then append:

```js
describe('LEAVEPHONE.1 — leave form reads', () => {
  it('getMyAllowance asks for the caller\'s own allowance: a year, and NO profile_id', async () => {
    await schedule.getMyAllowance({ year: 2026, locationId: LOC })
    expect(lastPathname()).toBe('/api/schedule/allowances')
    expect(lastQuery()).toEqual({ year: '2026' })
    expect(lastCall()[1]).toEqual({ locationId: LOC })
  })

  it('getLeavePreview sends preview=1, the type, the route\'s date names and the studio the POST will file at — and NO profile_id', async () => {
    await schedule.getLeavePreview({ type: 'holiday', startDate: '2026-06-01', endDate: '2026-06-07', locationId: LOC })
    expect(lastPathname()).toBe('/api/schedule/time-off')
    expect(lastQuery()).toEqual({ preview: '1', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-07', location_id: LOC })
    expect(lastCall()[1]).toEqual({ locationId: LOC })
  })

  it('getLeavePreview with a one-tap pick sends end_date = start_date; no studio sends no location_id', async () => {
    await schedule.getLeavePreview({ type: 'sick', startDate: '2026-10-05', endDate: null, locationId: undefined })
    expect(lastQuery()).toEqual({ preview: '1', type: 'sick', start_date: '2026-10-05', end_date: '2026-10-05' })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run mobile/lib/schedule-api.test.js`
Expected: `exports exactly the helpers this file pins` fails (the two names are missing from the module), and the three new tests fail with `schedule.getMyAllowance is not a function` / `schedule.getLeavePreview is not a function`.

- [ ] **Step 3: Implement**

In `mobile/lib/schedule-api.js`, insert directly after the `getMyTimeOff` function (before `createTimeOffRequest`):

```js
// LEAVEPHONE.1 — the caller's OWN holiday allowance. No profile_id on purpose:
// GET /api/schedule/allowances defaults it to the caller, and a coach may read
// nobody else's. The response carries `not_applicable: true` for a contractor.
export function getMyAllowance({ year, locationId }) {
  const qs = new URLSearchParams()
  if (year) qs.set('year', String(year))
  return api(`/api/schedule/allowances?${qs.toString()}`, { locationId })
}

// LEAVEPHONE.1 — ask the SERVER what this request would cost and which of MY
// published shifts it hits. The phone never counts days itself: a holiday's
// cost depends on bank holidays and studio closures only the server can see.
// location_id is the studio createTimeOffRequest will file at, so the answer
// is about the same studio. The route ignores profile_id in preview mode, so
// none is sent. Read the answer with leavePreviewFrom (lib/leave-form.js),
// which also recognises an older deployment answering with the request list.
export function getLeavePreview({ type, startDate, endDate, locationId }) {
  const qs = new URLSearchParams()
  qs.set('preview', '1')
  qs.set('type', type)
  qs.set('start_date', startDate)
  qs.set('end_date', endDate || startDate)
  if (locationId) qs.set('location_id', locationId)
  return api(`/api/schedule/time-off?${qs.toString()}`, { locationId })
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run mobile/lib/schedule-api.test.js`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/schedule-api.js mobile/lib/schedule-api.test.js
git commit -m "LEAVEPHONE.1 — schedule-api: getMyAllowance, getLeavePreview

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The form — balance, days, clashes, confirmation

No component test runner exists, so this task has no failing-test step: every decision it renders was tested in Tasks 1, 5 and 7, and the verification here is `check:mobile-lint` + `check:mobile-imports` (an import of a name that does not exist resolves to `undefined` and only crashes on a handset — that check is the guard) plus the handset checklist in the PR gate.

**Files:** Modify `mobile/app/(staff)/schedule/time-off-new.jsx`.

- [ ] **Step 1: Imports and state**

Replace `import { useState } from 'react'` with:

```js
import { useState, useEffect, useRef } from 'react'
```

Replace `import { createTimeOffRequest } from '../../../lib/schedule-api'` with:

```js
import { createTimeOffRequest, getMyAllowance, getMyTimeOff, getLeavePreview } from '../../../lib/schedule-api'
import { leavePreviewFrom, leaveDaysLabel, leaveBalanceView, submittedDays, leaveSubmittedMessage } from '../../../lib/leave-form'
import { isStaleResponse } from '../../../lib/schedule-refresh'
```

Replace `import { timeOffTypesFor, defaultTimeOffTypeFor } from 'shared/time-off'` with:

```js
import { timeOffTypesFor, defaultTimeOffTypeFor, isRestrictedEmployment, leavePreviewLine } from 'shared/time-off'
```

Directly after `const [submitting, setSubmitting] = useState(false)` add:

```js
  // LEAVEPHONE.1 — what the coach needs BEFORE they submit. All of it is
  // advisory: a failed read shows less, it never blocks the request (the
  // server still enforces balance and overlap on submit).
  const [allowance, setAllowance] = useState(null)
  const [myRequests, setMyRequests] = useState([])
  // The SERVER's answer for the current type + range: the days it would charge
  // and the coach's own published shifts inside it. The phone counts nothing.
  const [preview, setPreview] = useState({ known: false, days: null, clashes: [] })
  const [previewLoading, setPreviewLoading] = useState(true)
  const previewReq = useRef(0)
  const hasAllowance = !isRestrictedEmployment(profile?.employment_type)
  const allowanceYear = Number(String(start || today).slice(0, 4))

  // Balance: the allowance for the year the leave STARTS in, plus the coach's
  // own requests (the pending-days deduction the server applies).
  useEffect(() => {
    if (!hasAllowance || !profile?.id) return undefined
    let live = true
    Promise.all([
      getMyAllowance({ year: allowanceYear, locationId: activeLocation?.id }),
      getMyTimeOff({ profileId: profile.id }),
    ]).then(([a, t]) => {
      if (!live) return
      setAllowance(a?.success ? a.data : null)
      setMyRequests(t?.success && Array.isArray(t.data) ? t.data : [])
    })
    return () => { live = false }
  }, [hasAllowance, profile?.id, activeLocation?.id, allowanceYear])

  // Preview: refetched whenever the type or the range changes (the type
  // matters — holiday skips weekends, bank holidays and closures; the others
  // count calendar days). The stamp drops a slow answer for a choice the coach
  // has already moved on from. Same locationId the submit below files at.
  useEffect(() => {
    if (!start) return
    const mine = ++previewReq.current
    setPreviewLoading(true)
    getLeavePreview({ type, startDate: start, endDate: end || start, locationId: activeLocation?.id }).then((res) => {
      if (isStaleResponse(previewReq.current, mine)) return
      setPreview(leavePreviewFrom(res))
      setPreviewLoading(false)
    })
  }, [type, start, end, activeLocation?.id])

  const balance = leaveBalanceView({
    employmentType: profile?.employment_type, allowance, requests: myRequests, type, days: preview.days,
  })
```

- [ ] **Step 2: Success confirmation**

In `submit()`, replace:

```js
    if (!res.success) {
      Alert.alert('Couldn’t submit', res.error || 'Unknown error')
      return
    }
    router.back()
```

with:

```js
    if (!res.success) {
      Alert.alert('Couldn’t submit', res.error || 'Unknown error')
      return
    }
    // LEAVEPHONE.1 — say it worked. The form used to just close, which on a
    // slow link was indistinguishable from the tap not registering. The days
    // are the ones the POST actually charged (its own response), not a recount.
    const done = leaveSubmittedMessage({
      type, startIso: start, endIso: endDate, days: submittedDays(res), clashCount: preview.clashes.length,
    })
    Alert.alert(done.title, done.message, [{ text: 'OK', onPress: () => router.back() }])
```

- [ ] **Step 3: Render the three blocks (between the calendar and the Reason field)**

Directly after the closing `</View>` of the `<View className="mb-5">` that wraps `<MonthCalendar …>` and before the `Reason (optional)` label, insert:

```jsx
        {/* LEAVEPHONE.1 — the days this request is charged, COUNTED BY THE
            SERVER (preview=1). Never computed here: bank holidays and studio
            closures are free and only the server knows them. */}
        <View className="bg-un1t-surface border border-un1t-border rounded-xl px-4 py-3 mb-3">
          <Text className="text-base text-un1t-text">{leaveDaysLabel({ loading: previewLoading, preview })}</Text>
          {type === 'holiday' && (
            <Text className="text-xs text-un1t-subtle mt-1">
              Holiday counts working days only. Weekends, bank holidays and days the studio is closed are free.
            </Text>
          )}
        </View>

        {/* Holiday balance — employees only; null for contractors (LEAVE.3). */}
        {balance && (
          <View className={`rounded-xl px-4 py-3 mb-3 border ${balance.short ? 'bg-red-500/10 border-red-500/30' : 'bg-un1t-surface border-un1t-border'}`}>
            <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-1">Holiday balance {balance.year}</Text>
            <Text className={`text-base font-semibold ${balance.short ? 'text-red-700' : 'text-un1t-text'}`}>
              {balance.available} {balance.available === 1 ? 'day' : 'days'} available
            </Text>
            <Text className="text-xs text-un1t-subtle mt-1">
              {balance.total} allowance{balance.carriedOver ? ` + ${balance.carriedOver} carried over` : ''} · {balance.used} used{balance.pending ? ` · ${balance.pending} pending` : ''}
            </Text>
            {type === 'holiday' && balance.requestDays > 0 && (
              <Text className={`text-sm mt-2 ${balance.short ? 'text-red-700' : 'text-un1t-text'}`}>
                {balance.short
                  ? `This request needs ${balance.requestDays} days. You have ${balance.available}.`
                  : `${balance.after} ${balance.after === 1 ? 'day' : 'days'} left after this request.`}
              </Text>
            )}
            {balance.otherYearDays > 0 && (
              <Text className="text-xs text-un1t-subtle mt-1">
                {balance.otherYearDays} of these days fall in {balance.year + 1} and count against that year’s allowance.
              </Text>
            )}
          </View>
        )}

        {/* Own published shifts inside the range. Rendered only when the
            preview is KNOWN and non-empty: unknown must not read as "none". */}
        {preview.known && preview.clashes.length > 0 && (
          <View className="bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3 mb-5">
            <Text className="text-sm font-semibold text-amber-700">
              You are rostered on {preview.clashes.length} {preview.clashes.length === 1 ? 'shift' : 'shifts'} in these dates
            </Text>
            {preview.clashes.slice(0, 8).map((c) => (
              <Text key={c.id} className="text-sm text-amber-700 mt-1">{leavePreviewLine(c)}</Text>
            ))}
            {preview.clashes.length > 8 && (
              <Text className="text-sm text-amber-700 mt-1">and {preview.clashes.length - 8} more</Text>
            )}
            <Text className="text-xs text-amber-700 mt-2">A manager will need to cover these.</Text>
          </View>
        )}
```

(`balance.requestDays > 0` is false for `null`, so nothing about "after this request" renders until the server has counted.)

- [ ] **Step 4: Point the footer at My leave**

Replace the footer `<Text>` that begins `Your manager will be notified. To withdraw it while it is still pending…` with:

```jsx
        <Text className="text-xs text-un1t-subtle px-2 mt-2">
          Your manager will be notified. You can follow the request, see their reply and withdraw it
          while it is still pending under My leave on the Schedule tab.
        </Text>
```

- [ ] **Step 5: Lint + import check, expect PASS**

Run: `npm run check:mobile-lint && npm run check:mobile-imports`
Expected: both exit 0. (`check:mobile-lint` is `--max-warnings 0`: an unused import — e.g. forgetting to use `leavePreviewLine` — fails it. There must be NO import of any day-counting function in this file.)

- [ ] **Step 6: Commit**

```bash
git add 'mobile/app/(staff)/schedule/time-off-new.jsx'
git commit -m "LEAVEPHONE.1 — leave form shows server-counted days, holiday balance, own clashing shifts, and confirms

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Quote the path: `(staff)` is a zsh glob and an unquoted `git add` stages nothing, silently.)

---

### Task 9: My leave screen + its entry point on the Schedule tab

**Files:** Create `mobile/app/(staff)/schedule/my-leave.jsx`. Modify `mobile/app/(staff)/(tabs)/schedule.jsx` — the floating-button block ONLY. Sibling PRs 04, 05 and 07 edit this same file, so find the block by its text, not by line number, and touch nothing else in it. (`mobile/app/(staff)/schedule/_layout.jsx` is a bare `<Stack>` — expo-router picks the new file up with no registration.)

- [ ] **Step 1: Create the screen**

```jsx
// mobile/app/(staff)/schedule/my-leave.jsx
// Modal: My leave (LEAVEPHONE.1).
//
// The coach's own time-off requests — pending, approved, declined, cancelled,
// expired — with the manager's review note. Until this screen the phone showed
// leave only as a card on the day it covers, so a DECLINED request and the
// reason for it were invisible. Reads GET /api/schedule/time-off through
// getMyTimeOff (service-role route; mobile never embeds profiles itself).
// Every decision is in lib/my-leave.js; this file renders.

import { useState, useCallback } from 'react'
import { useRouter, Stack, useFocusEffect } from 'expo-router'
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert, RefreshControl } from 'react-native'
import { useAuth } from '../../../lib/auth-context'
import { getMyTimeOff, cancelTimeOffRequest } from '../../../lib/schedule-api'
import { myLeaveSections } from '../../../lib/my-leave'

// Status chips: the house recipe, bg-<c>-500/10 + text-<c>-700. Written out as
// whole literal class names — NativeWind only compiles classes it can see.
const TONE = {
  amber: { bg: 'bg-amber-500/10', text: 'text-amber-700' },
  green: { bg: 'bg-green-500/10', text: 'text-green-700' },
  red: { bg: 'bg-red-500/10', text: 'text-red-700' },
  slate: { bg: 'bg-slate-500/10', text: 'text-slate-700' },
}

export default function MyLeave() {
  const { activeLocation, profile } = useAuth()
  const router = useRouter()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!profile?.id) return
    // No locationId: leave covers the person, so the list is every request of
    // theirs wherever it was filed. profile_id keeps a MANAGER's list to their
    // own rows (the route would otherwise return their whole studio's).
    const res = await getMyTimeOff({ profileId: profile.id })
    setLoading(false)
    if (!res.success) { setError(res.error || 'Failed to load your leave'); return }
    setError(null)
    setRows(Array.isArray(res.data) ? res.data : [])
  }, [profile?.id])

  useFocusEffect(useCallback(() => { load() }, [load]))

  function cancel(row) {
    Alert.alert(
      'Cancel this request?',
      'Your request will be withdrawn. You can raise a new one at any time.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel request',
          style: 'destructive',
          onPress: async () => {
            const res = await cancelTimeOffRequest(row.id, activeLocation?.id)
            if (!res.success) Alert.alert('Couldn’t cancel', res.error || 'Unknown error')
            // Refetch either way: the usual failure is "no longer pending" —
            // a manager decided it while this list sat on screen.
            load()
          },
        },
      ],
    )
  }

  const sections = myLeaveSections(rows, profile)

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen
        options={{
          title: 'My leave',
          headerLeft: () => (
            <Pressable onPress={() => router.back()} hitSlop={10}>
              <Text className="text-base text-un1t-text">Close</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        contentContainerClassName="p-4"
        refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
      >
        {error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-700 text-sm">{error}</Text>
          </View>
        ) : null}

        {loading ? (
          <View className="py-10 items-center"><ActivityIndicator /></View>
        ) : sections.length === 0 && !error ? (
          <View className="py-10 items-center">
            <Text className="text-sm text-un1t-subtle">You have not requested any time off yet.</Text>
          </View>
        ) : sections.map((section) => (
          <View key={section.key} className="mb-5">
            <Text className="text-xs uppercase tracking-wider text-un1t-subtle px-2 mb-2">{section.title}</Text>
            {section.rows.map((r) => (
              <View key={r.id} className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2">
                <View className="flex-row items-center justify-between">
                  <Text className="text-base font-semibold text-un1t-text">{r.title}</Text>
                  <View className={`px-2.5 py-1 rounded-full ${TONE[r.tone].bg}`}>
                    <Text className={`text-xs font-semibold ${TONE[r.tone].text}`}>{r.statusLabel}</Text>
                  </View>
                </View>
                <Text className="text-sm text-un1t-text mt-1">
                  {r.range} · {r.days} {r.days === 1 ? 'day' : 'days'}
                </Text>
                {r.reason ? <Text className="text-xs text-un1t-subtle mt-1">{r.reason}</Text> : null}
                {r.note ? (
                  <View className="mt-3 pt-3 border-t border-un1t-border">
                    <Text className="text-xs uppercase tracking-wider text-un1t-subtle">
                      {r.reviewer ? `Note from ${r.reviewer}` : 'Manager’s note'}
                    </Text>
                    <Text className="text-sm text-un1t-text mt-1">{r.note}</Text>
                  </View>
                ) : null}
                {r.canCancel && (
                  <Pressable
                    onPress={() => cancel(r)}
                    hitSlop={8}
                    className="self-start mt-3 px-3 py-1.5 rounded-full bg-un1t-surface border border-amber-500/40 active:opacity-70"
                  >
                    <Text className="text-xs font-semibold text-amber-700">Cancel request</Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  )
}
```

- [ ] **Step 2: Entry point on the Schedule tab**

In `mobile/app/(staff)/(tabs)/schedule.jsx`, find the block that starts with the comment `{/* Floating Request Time Off button — MOBILE-PERMS: gated on the` and ends with the `)}` that closes `{canMobile(profile, 'time_off', activeLocation) && (` (it contains the one `router.push('/schedule/time-off-new')` in the file). Replace that whole block with the code below. If a sibling PR has already changed the block, keep its change and add only the `My leave` `<Pressable>` and the `<>…</>` wrapper:

```jsx
      {/* Floating Request Time Off button — MOBILE-PERMS: gated on the
          `time_off` mobile toggle (distinct from `schedule`, which only
          shows the roster). Default on for every role, so this stays
          visible unless an admin turns time-off off for the user.
          LEAVEPHONE.1 — "My leave" sits beside it under the same gate: the
          list of the coach's own requests, with the manager's reply. */}
      {canMobile(profile, 'time_off', activeLocation) && (
        <>
          <Pressable
            onPress={() => router.push('/schedule/my-leave')}
            className="absolute bottom-6 left-6 bg-un1t-surface border border-un1t-border rounded-full px-5 py-3.5 flex-row items-center shadow-lg active:opacity-80"
          >
            <Ionicons name="list-outline" size={18} color="#111827" />
            <Text className="text-un1t-text font-semibold ml-1.5">My leave</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/schedule/time-off-new')}
            className="absolute bottom-6 right-6 bg-un1t-text rounded-full px-5 py-3.5 flex-row items-center shadow-lg active:opacity-80"
          >
            <Ionicons name="add" size={20} color="#FFFFFF" />
            <Text className="text-un1t-bg font-semibold ml-1.5">Request time off</Text>
          </Pressable>
        </>
      )}
```

- [ ] **Step 3: Lint + import check, expect PASS**

Run: `npm run check:mobile-lint && npm run check:mobile-imports`
Expected: both exit 0. (`check:guardrails` does not scan `mobile/**`, so the chip-contrast rule is NOT enforced here — the chips above follow the house recipe `bg-<c>-500/10 text-<c>-700` by hand. Do not swap in a `-300/-400` text ramp.)

- [ ] **Step 4: Commit**

```bash
git add 'mobile/app/(staff)/schedule/my-leave.jsx' 'mobile/app/(staff)/(tabs)/schedule.jsx'
git commit -m "LEAVEPHONE.1 — My leave screen (status, manager's note, cancel on pending) + Schedule tab entry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### PR gate

- [ ] **Focused tests (one command; 02's day-count and `[id]` files ride along to prove the POST refactor changed nothing):**

```bash
npx vitest run shared/time-off.test.js src/lib/time-off-leave.test.js src/lib/time-off-days.test.js \
  src/app/api/schedule/time-off/route.test.js 'src/app/api/schedule/time-off/[id]/route.test.js' \
  mobile/lib/leave-form.test.js mobile/lib/my-leave.test.js mobile/lib/schedule-api.test.js
```
Expected: all passed.

- [ ] **Static gates:**

```bash
npm run lint && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:mobile-parity \
  && npm run check:select-columns && npm run check:location-scoping && npm run check:route-guards \
  && npm run check:guardrails && npm run check:ota-paths
```
Expected: all exit 0. Notes: `check:route-guards` — no new route file, the GET keeps `getCurrentUser`. `check:mobile-parity` — no new permission key. `check:ota-paths` — no new top-level directory under `mobile/`; this merge WILL publish an OTA at 100% (`mobile/app/**`, `mobile/lib/**`, `shared/**`), which is intended.

- [ ] **Merge-order check:** `git log origin/main --oneline | grep -c 'HOLIDAYLEAVE.1'` prints 1 or more, and `grep -n 'nonWorkingDates = null' src/lib/time-off-days.js` finds 02's 4-argument `countLeaveDays`. If not, STOP — this PR is built on 02.

- [ ] **No phone-side day count crept in:** `grep -rn 'countLeaveDays\|splitAtYearEnd\|time-off-days' mobile/ shared/` prints nothing.

- [ ] **Build (the route lost one import and gained two):** `npm run build`. Expected: compiles. Close other apps first (8GB machine).

- [ ] **Open the PR, then add the CHANGELOG row.** `git push -u origin HEAD && gh pr create --base main --fill`. Take the PR number, add ONE row directly under the `|---|------|-------|` line in `docs/CHANGELOG.md` (`| #<PR> | LEAVEPHONE.1 — phone leave form shows balance, clashes and history | 2026-09-19. … |`), commit, push. Never edit a row that has already been pushed (`merge=union` duplicates it).

- [ ] **Handset checklist after the OTA lands (the owner, on a real phone — jsdom/vitest cannot see layout):**
  1. As an FTE coach: open Schedule → Request time off. Balance card shows; the days line reads "Counting days…" for a moment, then a number. Pick an ordinary Mon–Sun → "uses 5 days". **Pick a week containing a bank holiday (e.g. the October bank-holiday Monday) → "uses 4 days", and after submitting, the confirmation and the My leave row both say 4** — the same number on the manager's web Time Off page. Pick a week with a published shift → the amber list names it with the right times and studio, and "A manager will need to cover these".
  2. Pick a week whose roster is still DRAFT → no shift is listed.
  3. Submit → "Request sent" alert → OK returns to Schedule → My leave shows it under Pending with Cancel request.
  4. Have a manager decline it with a note → My leave shows it under Declined with "Note from …".
  5. As a CONTRACTOR: no balance card; type is Unavailable; days count calendar days (a bank-holiday week still reads 7).
  6. Both floating buttons are visible and neither covers the last shift row on a 390pt-wide screen.
