## PR ROSTERLOOK.1 — the roster you can read: one toolbar row, status in the day headers, neutral cards, coach names in month view

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager opening `/schedule` at 1512x786 sees shifts without scrolling, can read who is on each shift at a glance, and meets colour only where it means "this shift needs a coach". The day-column card layout stays (the owner rejected a time-grid rewrite); five things change: one toolbar row, Studio Overview folded into the day headers, neutral cards, a new card content order, and coach names in month view.

**Why:** Observed in production on 19 Sep 2026: module tabs + 7 sub-tabs + a Studio Overview strip + an H2/subtitle + EIGHT toolbar buttons on two rows + the week navigator + a staffing banner add up to about 780px of chrome, so no shift is visible on load. Strip labels collide ("MONUNDERMANNED") and its "4/1" figures are cryptic. Cards truncate the template name to nothing ("Morning 8…"), wrap the time onto two lines, carry a "1/15" chip on every card, print the coach names smallest, and paint the whole card in the template's pastel, which collides with the amber/red staffing colours (evening shifts are pink-red and read as errors). Month cells list "5:45am 2/10" three times with no names and carry unexplained "!1" / "↓1" badges.

**Ships:** web deploy only. No migration. Nothing under `mobile/` or `shared/` changes, so **no OTA**.

**Merge order:** this PR merges **AFTER `01-COPYLEAVE.1` and `03-CHANGELOG.1`**. Both touch `src/components/ScheduleCalendar.jsx`. 01 edits line 897 (the copy toast) and the publish modal (2267 onward), which this PR does not touch. 03 opens a "changes since publish" drawer from the publish-state chip, which this PR MOVES (into the toolbar's left group) but does not rewrite: the chip stays `data-testid="publication-status"`, stays in `ScheduleCalendar.jsx`, and whatever element/handler 03 put on it is carried verbatim (Task 0 and Task 8 say exactly how). Edits to `ScheduleCalendar.jsx` are confined to four regions: the header + range navigation (930-1150), the month grid cell (1287-1383), the week day header (1415-1431) and the week card (1460-1631). Line numbers are from `8231d438` (the tree this plan was written against); Task 0 re-anchors them after the rebase.

**Worktree:** a fresh worktree, branch `rosterlook-1` off a fresh `origin/main` once 01 and 03 are merged. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the PR gate (8GB machine).

**Extraction decision:** the four regions become four components in `src/components/schedule/` (`RosterToolbar`, `DayHeader`, `ShiftCard`, `MonthCell`, plus the small `MoreMenu` and `StatusDot` they share). They are written NEW, test-first, from pure models, and each region is swapped in its own commit. There is deliberately NO "move verbatim first" commit for them: every region's markup is replaced wholesale, so a verbatim move would be a commit of code the next commit deletes, and it would maximise the conflict surface against 01 and 03. The one genuine move IS done verbatim-first: `StudioOverviewStrip.jsx` becomes `schedule/StudioOverviewDialog.jsx` with `git mv` in its own commit (Task 10) before it is edited (Task 11).

**Theme note (read before styling):** the web CRM has ONE theme. `tailwind.config.js` defines `un1t-*` as fixed hex, there is no `darkMode` key, no `dark:` class anywhere under `src/components`, and `src/app/globals.css` has no `prefers-color-scheme` block. "Both themes" therefore means: use `un1t-*` tokens for every surface, border and neutral text (so a future dark theme re-tints the cards for free), use the palette only for status at the -700 text ramp, and confirm in a browser with the OS in dark mode that nothing changes (Task 18).

**Rules that bite in this PR (read `CLAUDE.md` first):**
- jsdom cannot see layout (memory `jsdom-cannot-see-layout`). Tests assert structure, labels, roles, ordering and the pure helpers. Nothing here proves the toolbar is one row or that a time fits on one line; Task 18 does, in a browser.
- Do not write a test that `waitFor`s a flicker to settle (memory `test-waiting-hides-a-bug`).
- `guardrails/no-low-contrast-accent-text` is armed for `ScheduleCalendar.jsx` and (from Task 17) for `src/components/schedule/**`: no `text-<palette>-300/400/500`. Status text is `-700`. Chips are `bg-<c>-500/10 text-<c>-700`.
- No new colour literals. The card no longer uses `tmpl.color` at all; the hex strings in `TIME_OFF_CONFIG` are existing and untouched.
- The repo is PUBLIC. Fixtures use `Coach A`, `Sarah Doyle`-style invented names already in these test files. Never a real coach.
- Every `<button>` gets `type="button"`.

### What does NOT change for coaches (state this in the PR body)

A coach sees the same component in "My shifts" mode. This PR changes how data is DRAWN, never what data reaches the browser: no route, no select, no hook and no prop carrying roster data is touched. Specifically, after this PR a coach still never sees an unpublished shift (the feed is published-only, server-side), capacity (`max_coaches` / `min_coaches` are not sent to them and `shiftCardModel` never reads `max_coaches` for anyone), or manager notes (the model has no notes field). Staffing status (dot, "1 of 2", "Needs coach", dashed border) is manager-only in the model itself, not just in the JSX: `shiftCardModel(..., { isManager: false })` returns `status: null`. Task 2 pins that with a test that the coach-mode card model contains no capacity figure; Tasks 9, 12, 13, 14 and 15 pin it again at component level.

---

### File map

| File | Change |
|---|---|
| `src/lib/schedule-overlap.js` | Modify lines 27-34: `formatTime12h` gains an `amSuffix` option; new `formatTimeRange12h` directly below |
| `src/lib/schedule-overlap.test.js` | Modify: import line 3 + two new describes |
| `src/lib/roster-card-model.js` | Create: `cardTone`, `shiftCardModel`, `dayHeaderStatus`, `monthCellLines`, `rosterToolbarModel` (pure) |
| `src/lib/roster-card-model.test.js` | Create: table-driven tests |
| `src/components/schedule/MoreMenu.jsx` + `.test.jsx` | Create: keyboard-accessible menu button |
| `src/components/schedule/RosterToolbar.jsx` + `.test.jsx` | Create: the one toolbar row |
| `src/components/schedule/StatusDot.jsx` | Create: dot + label, shared by week headers and month cells |
| `src/components/schedule/DayHeader.jsx` + `.test.jsx` | Create |
| `src/components/schedule/ShiftCard.jsx` + `.test.jsx` | Create |
| `src/components/schedule/MonthCell.jsx` + `.test.jsx` | Create |
| `src/components/StudioOverviewStrip.jsx` → `src/components/schedule/StudioOverviewDialog.jsx` | `git mv`, then: strip and `DayCard` deleted, dialog becomes controlled (`openDate` / `onClose`) |
| `src/components/StudioOverviewStrip.test.jsx` → `src/components/schedule/StudioOverviewDialog.test.jsx` | `git mv`, then rewritten round an opener harness |
| `src/components/ScheduleRosterView.jsx` | Modify lines 10, 56-76: strip out, dialog in, new `onOpenDayOverview` prop to the calendar |
| `src/components/ScheduleRosterView.open-shift.test.jsx` | Modify: opens the dialog from a day header; far-week and gone cases drive `focusShift` directly |
| `src/components/ScheduleCalendar.jsx` | Modify: imports 25-26, 61; delete `blockStaffingStatus` 118-132; regions 930-1150, 1287-1383, 1415-1431, 1460-1631; new prop `onOpenDayOverview` at 148 |
| `src/components/ScheduleCalendar.toolbar.test.jsx` | Rewrite |
| `src/components/ScheduleCalendar.a11y.test.jsx` | Modify: select-mode toggle (line 171), two "Unstaffed" tests (381-399) |
| `src/components/ScheduleCalendar.visibility.test.jsx` | Modify: line 109; new card/month assertions |
| `src/components/ScheduleCalendar.errors.test.jsx` | Modify: mechanical substitution of the three moved controls |
| `src/app/(team)/schedule/page.js` + `page.test.js` | Modify: `generateMetadata` (tab title) |
| `eslint.guardrails.config.mjs` | Modify line ~120: arm `src/components/schedule/**` and `ScheduleRosterView.jsx` |
| `docs/CHANGELOG.md` | One row keyed by the PR number, added after `gh pr create` |

---

### Task 0: Rebase reconciliation (no code, 5 minutes, do not skip)

This plan quotes line numbers from `8231d438`. 01 and 03 have merged since, so re-anchor before touching anything.

- [ ] **Step 1: Confirm both predecessors are on main**

```bash
git fetch origin main
git log origin/main --oneline -30 | grep -E "COPYLEAVE\.1|CHANGELOG\.1"
```
Expected: two lines. If either is missing, STOP: this PR must not go first.

- [ ] **Step 2: Re-anchor the four regions by their comments, not by number**

```bash
grep -n '{/\* Header \*/}\|data-testid="schedule-toolbar"\|{/\* Range Navigation \*/}\|data-testid="publication-status"\|── MONTH VIEW ──\|── WEEK VIEW ──\|{dayBlocks.map(block => {\|{/\* Add ad-hoc block button' src/components/ScheduleCalendar.jsx
```
Write the eight numbers down. Every "file:line" below is the `8231d438` number; use the anchor it names to find today's line.

- [ ] **Step 3: Read what 03 did to the publish-state chip**

```bash
git log origin/main --oneline -- src/components/ScheduleCalendar.jsx | head -5
sed -n "$(grep -n 'data-testid="publication-status"' src/components/ScheduleCalendar.jsx | head -1 | cut -d: -f1),+12p" src/components/ScheduleCalendar.jsx
```
Expected (per the 03 plan): a `role="status"` wrapper `<div className="mt-1.5 flex justify-center">` holding a `<button data-testid="publication-status" aria-haspopup="dialog">` when the period is published or partly published, else a `<span data-testid="publication-status">`. Rule for Task 8: the button, the span, their `data-testid`, the `onClick` that sets `changeLog`, and the drawer are carried VERBATIM into the `publicationChip` constant. Task 8 changes only the WRAPPER (its centering classes go, its `role="status"` stays). 03's chip tests must still pass unmodified after Task 8. If what you see differs from this description, carry what is THERE, not what this plan quotes.

- [ ] **Step 4: Check whether 01 or 03 added a toolbar action or a card indicator**

```bash
git diff 8231d438 origin/main -- src/components/ScheduleCalendar.jsx | grep -n "^+" | grep -i "button\|<Link\|sr-only" | head -40
```
Per the 01 plan the answer is "no" (it touches line 897 and the publish modal only). If a NEW toolbar button did appear: it becomes one more entry in `rosterToolbarModel`'s `moreItems` (Task 5: add `{ key, label, title }`, add the key to the expected-keys test) and one more line in `RosterToolbar`'s `HANDLERS` map (Task 7). If a NEW per-coach indicator appeared on the week card: add a field beside `adjusted` on `coaches[]` in `shiftCardModel` (Task 2) and render it beside the Adjusted chip in `ShiftCard` (Task 13), with a table row in each test. Today the only indicators ON the week card are "Adjusted", the empty/short staffing states and "No coach (past)"; the leave bars are per-DAY rows above the cards (`ScheduleCalendar.jsx:1434-1454`, untouched), and clash and swap indicators live in the assign and block-detail dialogs (untouched).

- [ ] **Step 5: No commit.** Nothing changed.

---

### Task 1: One-line time range (extend the existing formatter)

**Files:**
- Modify: `src/lib/schedule-overlap.js:27-34`
- Modify: `src/lib/schedule-overlap.test.js:3` + append

`formatTime12h` is THE 12-hour schedule label (ROSTER-FIX.6c collapsed three copies into it). The range form is built on it, not beside it.

- [ ] **Step 1: Write the failing tests**

In `src/lib/schedule-overlap.test.js` change line 3 to:

```js
import { coachConflictsForBlock, fmtTime, formatTime12h, formatTimeRange12h, timeRangesOverlap } from './schedule-overlap'
```

Append at the end of the file:

```js
// ROSTERLOOK.1 — the week card prints the range on ONE line. The suffix is
// said once when both ends share it, which is what keeps "9:15–10:30am" inside
// a 118px card where "9:15am–10:30am" wrapped.
describe('formatTimeRange12h (ROSTERLOOK.1)', () => {
  it.each([
    ['09:15', '10:30', '9:15–10:30am'],
    ['09:00:00', '12:00:00', '9am–12pm'],
    ['06:00', '07:00', '6–7am'],
    ['05:45', '06:45', '5:45–6:45am'],
    ['11:30', '12:30', '11:30am–12:30pm'],
    ['17:00', '20:00', '5–8pm'],
    ['00:00', '01:15', '12–1:15am'],
  ])('%s to %s reads %s', (start, end, expected) => {
    expect(formatTimeRange12h(start, end)).toBe(expected)
  })

  it('never contains a space or a hyphen-minus, so it cannot break mid-range', () => {
    expect(formatTimeRange12h('09:15', '10:30')).not.toMatch(/[\s-]/)
  })

  it('degrades to the one end it was given, and to empty for none', () => {
    expect(formatTimeRange12h('09:00', null)).toBe('9am')
    expect(formatTimeRange12h(null, '10:00')).toBe('10am')
    expect(formatTimeRange12h(null, null)).toBe('')
  })
})

describe('formatTime12h amSuffix option (ROSTERLOOK.1)', () => {
  it('drops "am" only: a month-cell line reads "5:45", and 5:45pm still says so', () => {
    expect(formatTime12h('05:45', { amSuffix: false })).toBe('5:45')
    expect(formatTime12h('09:00', { amSuffix: false })).toBe('9')
    expect(formatTime12h('17:45', { amSuffix: false })).toBe('5:45pm')
    expect(formatTime12h('12:00', { amSuffix: false })).toBe('12pm')
  })

  it('is unchanged for every existing caller (no options)', () => {
    expect(formatTime12h('05:45')).toBe('5:45am')
    expect(formatTime12h('17:00')).toBe('5pm')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/schedule-overlap.test.js`
Expected: FAIL, `TypeError: formatTimeRange12h is not a function` on the range cases, and `expected '5:45am' to be '5:45'` on the option case.

- [ ] **Step 3: Implement**

Replace `src/lib/schedule-overlap.js:27-34`:

```js
export function formatTime12h(time) {
  if (!time) return ''
  const [h, m] = String(time).split(':')
  const hour = parseInt(h)
  const suffix = hour >= 12 ? 'pm' : 'am'
  const display = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour
  return m === '00' ? `${display}${suffix}` : `${display}:${m}${suffix}`
}
```

with:

```js
// ROSTERLOOK.1 — `amSuffix: false` is for the month cell, where a line has
// about 120px for a time AND two first names. Only "am" is dropped: a roster
// that runs 5:45am and 5:45pm classes must never print both as "5:45".
export function formatTime12h(time, { amSuffix = true } = {}) {
  if (!time) return ''
  const [h, m] = String(time).split(':')
  const hour = parseInt(h)
  const suffix = hour >= 12 ? 'pm' : amSuffix ? 'am' : ''
  const display = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour
  return m === '00' ? `${display}${suffix}` : `${display}:${m}${suffix}`
}

/**
 * ROSTERLOOK.1 — a shift's range on ONE line: '9:15–10:30am', '11:30am–12:30pm'.
 * Built on formatTime12h so there is still one 12-hour rule. The suffix is
 * printed once when both ends share it. En dash, no spaces: there is no break
 * opportunity inside it (the card adds whitespace-nowrap as well). Pure.
 */
export function formatTimeRange12h(start, end) {
  const from = formatTime12h(start)
  const to = formatTime12h(end)
  if (!from || !to) return from || to
  return from.slice(-2) === to.slice(-2) ? `${from.slice(0, -2)}–${to}` : `${from}–${to}`
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/schedule-overlap.test.js`
Expected: PASS, every test in the file including the pre-existing `formatTime12h` describe.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule-overlap.js src/lib/schedule-overlap.test.js
git commit -m "ROSTERLOOK.1 — formatTimeRange12h: a shift's time range on one line"
```

---

### Task 2: `cardTone` + `shiftCardModel` (what a card says, decided outside JSX)

**Files:**
- Create: `src/lib/roster-card-model.js`
- Create: `src/lib/roster-card-model.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/roster-card-model.test.js
// ROSTERLOOK.1 — every decision the roster's week card, day header, month cell
// and toolbar make is made HERE, in pure functions, because jsdom cannot see
// layout and a component test can only say "this text is present".
import { describe, it, expect } from 'vitest'
import { cardTone, shiftCardModel } from './roster-card-model'

const TODAY = '2026-09-21'
const block = (over = {}) => ({
  id: 'b1', block_date: TODAY, start_time: '09:15', end_time: '10:30',
  max_coaches: 17, min_coaches: 2, notes: 'manager only: cover for Coach B',
  shift_templates: { name: 'Morning 8 Week Challenge - Strength', color: '#EC4899' },
  ...over,
})
const coach = (id, name, over = {}) => ({ id: `a-${id}`, profile_id: id, status: 'confirmed', profiles: { full_name: name }, ...over })

describe('cardTone', () => {
  it("is 'neutral' for every block today; Wave 2 returns 'admin' here without touching the card", () => {
    expect(cardTone(block())).toBe('neutral')
    expect(cardTone(block({ shift_templates: { name: 'Admin', color: '#000000' } }))).toBe('neutral')
    expect(cardTone(null)).toBe('neutral')
  })
})

describe('shiftCardModel', () => {
  it('time on one line, then coaches, then the FULL template name', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A'), coach('u3', 'Coach B')], { status: 'ok', count: 2, min: 2 }, { isManager: true, viewerId: 'u9' })
    expect(m.timeLabel).toBe('9:15–10:30am')
    expect(m.coaches.map((c) => c.name)).toEqual(['Coach A', 'Coach B'])
    expect(m.templateName).toBe('Morning 8 Week Challenge - Strength')
    expect(m.shortLabel).toBe('9:15am Morning 8 Week Challenge - Strength shift')
    expect(m.tone).toBe('neutral')
    expect(m.status).toBeNull()
    expect(m.emptyText).toBeNull()
  })

  it('cancelled assignments are not coaches', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A'), coach('u3', 'Coach B', { status: 'cancelled' })], { status: 'short', count: 1, min: 2 }, { isManager: true })
    expect(m.coaches.map((c) => c.name)).toEqual(['Coach A'])
  })

  it.each([
    // staffing,                                isManager, coaches, expected status,                    expected emptyText
    [{ status: 'ok', count: 1, min: 1 },        true,      1,       null,                                null],
    [{ status: 'short', count: 1, min: 2 },     true,      1,       { kind: 'short', label: '1 of 2' },  null],
    [{ status: 'empty', count: 0, min: 1 },     true,      0,       { kind: 'empty', label: 'Needs coach' }, null],
    [null /* past block */,                     true,      0,       null,                                'No coach (past)'],
    [{ status: 'short', count: 1, min: 2 },     false,     1,       null,                                null],
    [{ status: 'empty', count: 0, min: 0 },     false,     0,       null,                                'No coach assigned'],
  ])('staffing %j, manager=%s, %i coach(es)', (staffing, isManager, n, status, emptyText) => {
    const list = n ? [coach('u2', 'Coach A')] : []
    const m = shiftCardModel(block(), list, staffing, { isManager })
    if (status) expect(m.status).toMatchObject(status)
    else expect(m.status).toBeNull()
    expect(m.emptyText).toBe(emptyText)
  })

  it('short says what the numbers mean, for a tooltip and a screen reader', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A')], { status: 'short', count: 1, min: 2 }, { isManager: true })
    expect(m.status.srPrefix).toBe('Below minimum: ')
    expect(m.status.title).toBe('Below minimum: 1 of 2 coaches')
  })

  it('marks the viewer, and an adjusted assignment with its real hours', () => {
    const m = shiftCardModel(
      block({ start_time: '09:00', end_time: '12:00' }),
      [coach('u2', 'Coach A', { start_time_override: '09:30', end_time_override: null, partial_reason: 'covered until 12' })],
      { status: 'ok', count: 1, min: 1 },
      { isManager: true, viewerId: 'u2' },
    )
    expect(m.coaches[0].isMe).toBe(true)
    expect(m.coaches[0].adjusted).toEqual({
      title: 'Adjusted: 9:30am–12pm · covered until 12',
      srLabel: 'Adjusted hours: 9:30am to 12pm. covered until 12',
    })
  })

  // 🔴 The coach boundary. The coach feed does not carry these columns; this
  // test hands them over anyway, so the guarantee is the model's, not the feed's.
  it('coach mode: the model contains no capacity figure, no minimum and no manager note', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A')], { status: 'short', count: 1, min: 2 }, { isManager: false, viewerId: 'u2' })
    expect(m.status).toBeNull()
    const flat = JSON.stringify(m)
    expect(flat).not.toMatch(/17/)            // max_coaches (17 so the 9:15 start cannot mask it)
    expect(flat).not.toMatch(/\d+ of \d+/)    // "1 of 2"
    expect(flat).not.toMatch(/\d+\/\d+/)      // the old "1/15" chip
    expect(flat).not.toMatch(/manager only/)  // shift_blocks.notes
  })

  it('manager mode: still no n/max chip anywhere in the model', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A')], { status: 'ok', count: 1, min: 1 }, { isManager: true })
    expect(JSON.stringify(m)).not.toMatch(/17|\d+\/\d+/)
  })

  it('falls back to "Shift" when the template is missing', () => {
    const m = shiftCardModel(block({ shift_templates: null }), [], null, { isManager: true })
    expect(m.templateName).toBe('Shift')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/roster-card-model.test.js`
Expected: FAIL, `Failed to resolve import "./roster-card-model"`.

- [ ] **Step 3: Implement**

```js
// src/lib/roster-card-model.js
// ROSTERLOOK.1 — what the roster DRAWS, decided outside the JSX.
//
// The week card, the day header, the month cell and the toolbar each used to
// decide inline what to show, so the only way to test a decision was to render
// 2,700 lines of calendar and look for text. jsdom cannot see layout (memory
// `jsdom-cannot-see-layout`), so the decisions live here as pure functions
// with table-driven tests, and the components only lay out what they are given.
//
// 🔴 THE COACH BOUNDARY IS IN THIS FILE, not only in the JSX. A coach's feed
// never carries max_coaches / min_coaches / notes, and these models never copy
// them: capacity is not read for ANYONE (the "1/15" chip is gone), and staffing
// status exists only when `isManager` is true. A component cannot leak what its
// model does not contain.
//
// Web-only on purpose: anything under shared/ publishes an OTA.

import { liveAssignments } from './roster'
import { formatTime12h, formatTimeRange12h } from './schedule-overlap'

/**
 * The card's surface tone. 'neutral' for every block today: the template's
 * colour is no longer a fill, because a pastel per template (nearly all blue,
 * evenings pink-red) collided with the amber/red that means "needs a coach".
 * Wave 2 returns 'admin' here for a non-class block; ShiftCard already maps a
 * tone to a surface class, so that is a change to THIS function and one line
 * of its TONE_SURFACE map, not to the card's markup.
 *
 * @returns {'neutral'}
 */
export function cardTone(_block) {
  // `_block` is Wave 2's input; the underscore is the repo's unused-arg escape.
  return 'neutral'
}

/**
 * Everything one week-view card says.
 *
 * @param {object} block        shift_blocks row (start_time, end_time, shift_templates.name)
 * @param {Array}  assignments  block.shift_assignments, cancelled rows included
 * @param {{status:'empty'|'short'|'ok',count:number,min:number}|null} staffing
 *        futureBlockStaffing(block, today); null for a past block
 * @param {{isManager?:boolean, viewerId?:string|null}} [opts]
 */
export function shiftCardModel(block, assignments, staffing, { isManager = false, viewerId = null } = {}) {
  const templateName = block?.shift_templates?.name || 'Shift'
  const coaches = liveAssignments(assignments).map((a) => {
    const hasOverride = !!(a.start_time_override || a.end_time_override)
    const from = formatTime12h(a.start_time_override || block.start_time)
    const to = formatTime12h(a.end_time_override || block.end_time)
    return {
      id: a.id,
      name: a.profiles?.full_name || 'Unknown',
      isMe: !!viewerId && a.profile_id === viewerId,
      adjusted: hasOverride
        ? {
            title: `Adjusted: ${from}–${to}${a.partial_reason ? ` · ${a.partial_reason}` : ''}`,
            srLabel: `Adjusted hours: ${from} to ${to}${a.partial_reason ? `. ${a.partial_reason}` : ''}`,
          }
        : null,
    }
  })

  // Staffing numbers ONLY when short, and only for a manager.
  let status = null
  if (isManager && staffing?.status === 'short') {
    status = {
      kind: 'short',
      label: `${staffing.count} of ${staffing.min}`,
      srPrefix: 'Below minimum: ',
      title: `Below minimum: ${staffing.count} of ${staffing.min} coaches`,
    }
  } else if (isManager && staffing?.status === 'empty') {
    status = { kind: 'empty', label: 'Needs coach', srPrefix: '', title: 'No coach is assigned to this shift' }
  }

  let emptyText = null
  if (coaches.length === 0 && !status) emptyText = isManager ? 'No coach (past)' : 'No coach assigned'

  return {
    tone: cardTone(block),
    timeLabel: formatTimeRange12h(block?.start_time, block?.end_time),
    // The card button's spoken name is built from this plus the day; it keeps
    // the ROSTER-FIX.6b-7 shape "9am Morning shift".
    shortLabel: `${formatTime12h(block?.start_time)} ${templateName} shift`,
    templateName,
    coaches,
    status,
    emptyText,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/roster-card-model.test.js`
Expected: PASS (all `cardTone` and `shiftCardModel` tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-card-model.js src/lib/roster-card-model.test.js
git commit -m "ROSTERLOOK.1 — shiftCardModel + cardTone: the card's content as a pure model; coach mode carries no capacity"
```

---

### Task 3: `dayHeaderStatus` (the status the day header and the month cell both speak)

**Files:**
- Modify: `src/lib/roster-card-model.js` (append)
- Modify: `src/lib/roster-card-model.test.js` (append)

One status language for the week headers AND the month cells: a tone (`ok` / `short` / `empty`), a short visible count only when not ok ("1 short"), and a sentence for the tooltip and the screen reader. Past days say nothing (`none`): a past shift nobody covered is history, the rule `futureBlockStaffing` has always applied.

- [ ] **Step 1: Write the failing tests**

Change the import at the top of `src/lib/roster-card-model.test.js` to:

```js
import { cardTone, shiftCardModel, dayHeaderStatus } from './roster-card-model'
```

Append:

```js
describe('dayHeaderStatus', () => {
  const live = (n) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, profile_id: `u${i}`, status: 'confirmed' }))
  const b = (id, min, n, date = TODAY) => ({ id, block_date: date, start_time: '09:00', min_coaches: min, shift_assignments: live(n) })

  it.each([
    ['no blocks at all',            [],                                        'none',  '',        ''],
    ['only past blocks',            [b('p', 1, 0, '2026-09-01')],              'none',  '',        ''],
    ['every shift at its minimum',  [b('x', 1, 1), b('y', 2, 2)],              'ok',    '',        'Fully staffed'],
    ['one below minimum',           [b('x', 2, 1), b('y', 1, 1)],              'short', '1 short', '1 shift needs coaches: 1 below the minimum'],
    ['one with no coach',           [b('x', 1, 0), b('y', 1, 1)],              'empty', '1 short', '1 shift needs coaches: 1 with no coach'],
    ['one of each: red wins',       [b('x', 1, 0), b('y', 2, 1)],              'empty', '2 short', '2 shifts need coaches: 1 with no coach, 1 below the minimum'],
    ['past gaps are not counted',   [b('p', 1, 0, '2026-09-01'), b('y', 1, 1)], 'ok',   '',        'Fully staffed'],
  ])('%s', (_name, blocks, tone, label, srLabel) => {
    const s = dayHeaderStatus(blocks, { todayIso: TODAY })
    expect(s.tone).toBe(tone)
    expect(s.label).toBe(label)
    expect(s.srLabel).toBe(srLabel)
  })

  it('a cancelled assignment is not a coach', () => {
    const blocks = [{ id: 'x', block_date: TODAY, min_coaches: 1, shift_assignments: [{ id: 'a', profile_id: 'u', status: 'cancelled' }] }]
    expect(dayHeaderStatus(blocks, { todayIso: TODAY }).tone).toBe('empty')
  })

  it('the tooltip is the sentence, so the dot is never the only explanation', () => {
    const s = dayHeaderStatus([b('x', 2, 1)], { todayIso: TODAY })
    expect(s.title).toBe(s.srLabel)
    expect(dayHeaderStatus([b('x', 1, 1)], { todayIso: TODAY }).title).toBe('Every shift has its minimum number of coaches')
  })

  it('tolerates null', () => {
    expect(dayHeaderStatus(null, { todayIso: TODAY }).tone).toBe('none')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/roster-card-model.test.js`
Expected: FAIL, `TypeError: dayHeaderStatus is not a function` (the Task 2 tests still pass).

- [ ] **Step 3: Implement**

In `src/lib/roster-card-model.js` extend the imports:

```js
import { liveAssignments } from './roster'
import { futureBlockStaffing, countStaffingGaps, staffingGapsHeadline, staffingGapsBreakdown } from './roster-staffing'
import { formatTime12h, formatTimeRange12h } from './schedule-overlap'
```

Append:

```js
const NO_STATUS = Object.freeze({ tone: 'none', label: '', srLabel: '', title: '', empty: 0, short: 0 })

/**
 * The staffing status of ONE day, for the week view's day header and the
 * month view's cell. Replaces three things that each said it differently: the
 * Studio Overview tile ("UNDERMANNED 4/1"), and the month cell's "!1" / "↓1".
 *
 *   tone   'none'  no future shift on the day: say nothing
 *          'ok'    every future shift is at or above its minimum
 *          'short' at least one below its minimum, none empty   (amber)
 *          'empty' at least one with no coach                   (red)
 *   label  visible text, ONLY when not ok: "2 short"
 *   srLabel / title  the sentence, built from the same two functions the week
 *          banner uses, so the header and the banner cannot disagree
 *
 * Answers from futureBlockStaffing, like every other staffing surface
 * (ROSTERVIS.1), so cancelled assignments never count and past days are quiet.
 * Manager-only by CALLER: a coach's blocks carry no min_coaches, and the
 * calendar passes `status={null}` for a coach.
 */
export function dayHeaderStatus(blocksForDay, { todayIso } = {}) {
  const future = (blocksForDay || []).filter((blk) => futureBlockStaffing(blk, todayIso))
  if (future.length === 0) return NO_STATUS
  const gaps = countStaffingGaps(future, { todayIso })
  if (gaps.total === 0) {
    return { tone: 'ok', label: '', srLabel: 'Fully staffed', title: 'Every shift has its minimum number of coaches', empty: 0, short: 0 }
  }
  const sentence = `${staffingGapsHeadline(gaps, '')}: ${staffingGapsBreakdown(gaps)}`
  return {
    tone: gaps.empty > 0 ? 'empty' : 'short',
    label: `${gaps.total} short`,
    srLabel: sentence,
    title: sentence,
    empty: gaps.empty,
    short: gaps.short,
  }
}
```

(`staffingGapsHeadline(gaps, '')` returns `"2 shifts need coaches"`: the function trims the empty suffix, `shared/roster-staffing.js:117-119`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/roster-card-model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-card-model.js src/lib/roster-card-model.test.js
git commit -m "ROSTERLOOK.1 — dayHeaderStatus: one staffing status language for week headers and month cells"
```

---

### Task 4: `monthCellLines` (month view shows who is on)

**Files:**
- Modify: `src/lib/roster-card-model.js` (append)
- Modify: `src/lib/roster-card-model.test.js` (append)

**Decision recorded here:** a month line reads `5:45 Coach, Coach`. The owner's example drops the suffix; this plan drops it for **am only** (`formatTime12h(t, { amSuffix: false })`), because Stillorgan runs both a 5:45am and a 5:45pm class and the two must never print the same. The line's `title` always carries the full range with both suffixes.

- [ ] **Step 1: Write the failing tests**

Change the import to:

```js
import { cardTone, shiftCardModel, dayHeaderStatus, monthCellLines } from './roster-card-model'
```

Append:

```js
describe('monthCellLines', () => {
  const on = (...names) => names.map((n, i) => ({ id: `a-${n}-${i}`, profile_id: `u-${n}-${i}`, status: 'confirmed', profiles: { full_name: n } }))
  const mb = (id, start, end, min, assignments, date = TODAY) => ({
    id, block_date: date, start_time: start, end_time: end, min_coaches: min, max_coaches: 10,
    shift_templates: { name: `Template ${id}` }, shift_assignments: assignments,
  })

  it('time + first names, in start order, three lines then "+N more"', () => {
    const blocks = [
      mb('d', '17:45', '18:45', 1, on('Dana Fourth')),
      mb('a', '05:45', '06:45', 1, on('Jonathan First', 'James Second')),
      mb('b', '06:45', '07:45', 1, on('Aoife Third')),
      mb('c', '09:00', '10:00', 1, on('Cian Fifth')),
      mb('e', '18:45', '19:45', 1, on('Eve Sixth')),
    ]
    const { lines, more } = monthCellLines(blocks, { todayIso: TODAY, isManager: true })
    expect(lines.map((l) => l.text)).toEqual(['5:45 Jonathan, James', '6:45 Aoife', '9 Cian'])
    expect(more).toBe(2)
  })

  it('pm keeps its suffix so 5:45 and 5:45pm never read the same', () => {
    const { lines } = monthCellLines([mb('d', '17:45', '18:45', 1, on('Dana Fourth'))], { todayIso: TODAY, isManager: true })
    expect(lines[0].text).toBe('5:45pm Dana')
  })

  it('two coaches sharing a first name get a last initial', () => {
    const { lines } = monthCellLines([mb('a', '05:45', '06:45', 1, on('James Byrne', 'James Kelly', 'Aoife Third'))], { todayIso: TODAY, isManager: true })
    expect(lines[0].text).toBe('5:45 James B, James K, Aoife')
  })

  it.each([
    // name,                         assignments,        min, date,          isManager, tone,    text
    ['staffed',                      on('Coach A'),      1,   TODAY,         true,      'ok',    '9 Coach'],
    ['short: numbers only here',     on('Coach A'),      2,   TODAY,         true,      'short', '9 Coach (1 of 2)'],
    ['empty future',                 [],                 1,   TODAY,         true,      'empty', '9 Needs coach'],
    ['empty past is history',        [],                 1,   '2026-09-01',  true,      'quiet', '9 No coach'],
    ['coach never sees a status',    on('Coach A'),      2,   TODAY,         false,     'ok',    '9 Coach'],
    ['coach, empty block',           [],                 1,   TODAY,         false,     'quiet', '9 No coach'],
  ])('%s', (_n, assignments, min, date, isManager, tone, text) => {
    const { lines } = monthCellLines([mb('x', '09:00', '10:00', min, assignments, date)], { todayIso: TODAY, isManager })
    expect(lines[0].tone).toBe(tone)
    expect(lines[0].text).toBe(text)
  })

  it('the title says everything the line had to cut: template, full range, full names, and the status in words', () => {
    const { lines } = monthCellLines([mb('x', '05:45', '06:45', 2, on('Jonathan First'))], { todayIso: TODAY, isManager: true })
    expect(lines[0].title).toBe('Template x · 5:45–6:45am · Jonathan First · Below minimum: 1 of 2 coaches')
  })

  it('no capacity figure for anyone: the old "2/10" is gone', () => {
    const out = monthCellLines([mb('x', '09:00', '10:00', 1, on('Coach A'))], { todayIso: TODAY, isManager: true })
    expect(JSON.stringify(out)).not.toMatch(/\d+\/\d+/)
  })

  it('cancelled assignments are not named', () => {
    const list = [...on('Coach A'), { id: 'c', profile_id: 'u9', status: 'cancelled', profiles: { full_name: 'Gone Person' } }]
    expect(monthCellLines([mb('x', '09:00', '10:00', 1, list)], { todayIso: TODAY, isManager: true }).lines[0].text).toBe('9 Coach')
  })

  it('tolerates null and honours a custom limit', () => {
    expect(monthCellLines(null, { todayIso: TODAY })).toEqual({ lines: [], more: 0 })
    const two = [mb('a', '06:00', '07:00', 1, on('A B')), mb('b', '07:00', '08:00', 1, on('C D'))]
    expect(monthCellLines(two, { todayIso: TODAY, limit: 1 }).more).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/roster-card-model.test.js`
Expected: FAIL, `TypeError: monthCellLines is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/roster-card-model.js`:

```js
// First names for a line with ~120px to spend. Two people sharing a first name
// ON THE SAME SHIFT get a last initial; across shifts the time disambiguates.
function firstNames(assignments) {
  const parts = assignments.map((a) => String(a.profiles?.full_name || 'Unknown').trim().split(/\s+/))
  return parts.map((p) => {
    const shared = parts.filter((q) => q[0] === p[0]).length > 1
    return shared && p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}` : p[0]
  })
}

/**
 * The lines of one month-view cell: "5:45 Jonathan, James".
 *
 * Replaces "5:45am 2/10": a time and a capacity ratio, three times over, with
 * nobody named. Capacity is not read for anyone now. Staffing numbers appear
 * ONLY on a short line ("(1 of 2)"), and only for a manager.
 *
 *   tone  'ok'     staffed (or: the viewer is a coach)
 *         'short'  manager, below minimum       amber
 *         'empty'  manager, future, no coach    red, "Needs coach"
 *         'quiet'  nobody on it and nothing to act on (past, or a coach's view)
 *
 * @param {Array} blocks  the day's VISIBLE blocks (the caller applies My shifts)
 * @returns {{ lines: Array<{id:string,tone:string,text:string,title:string}>, more: number }}
 */
export function monthCellLines(blocks, { todayIso, isManager = false, limit = 3 } = {}) {
  const sorted = [...(blocks || [])].sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')))
  const lines = sorted.slice(0, limit).map((blk) => {
    const live = liveAssignments(blk.shift_assignments)
    const staffing = isManager ? futureBlockStaffing(blk, todayIso) : null
    const time = formatTime12h(blk.start_time, { amSuffix: false })
    const names = firstNames(live)

    let tone = 'ok'
    let text
    let statusWords = ''
    if (names.length === 0) {
      if (staffing?.status === 'empty') {
        tone = 'empty'
        text = `${time} Needs coach`
        statusWords = 'No coach is assigned to this shift'
      } else {
        tone = 'quiet'
        text = `${time} No coach`
      }
    } else if (staffing?.status === 'short') {
      tone = 'short'
      text = `${time} ${names.join(', ')} (${staffing.count} of ${staffing.min})`
      statusWords = `Below minimum: ${staffing.count} of ${staffing.min} coaches`
    } else {
      text = `${time} ${names.join(', ')}`
    }

    const title = [
      blk.shift_templates?.name || 'Shift',
      formatTimeRange12h(blk.start_time, blk.end_time),
      live.map((a) => a.profiles?.full_name || 'Unknown').join(', '),
      statusWords,
    ].filter(Boolean).join(' · ')

    return { id: blk.id, tone, text, title }
  })
  return { lines, more: Math.max(0, sorted.length - limit) }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/roster-card-model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-card-model.js src/lib/roster-card-model.test.js
git commit -m "ROSTERLOOK.1 — monthCellLines: month cells name the coaches; capacity ratio gone"
```

---

### Task 5: `rosterToolbarModel` (what is on the row, what is in More, for whom)

**Files:**
- Modify: `src/lib/roster-card-model.js` (append)
- Modify: `src/lib/roster-card-model.test.js` (append)

Gating today (`ScheduleCalendar.jsx:953-1078`), which must survive exactly: Time Off, My Shifts/All Staff and Week/Month are for everyone; Select multiple, Copy Last Week, Copy Last Month and Manage templates are `isManager`; Publish is `isManager && viewType === 'week'`; both copy buttons are disabled while `copying`. A coach therefore has exactly ONE secondary action (Time off), and a one-item menu is a worse link, so for a coach Time off stays a plain link on the row and there is no More menu.

- [ ] **Step 1: Write the failing tests**

Change the import to:

```js
import { cardTone, shiftCardModel, dayHeaderStatus, monthCellLines, rosterToolbarModel } from './roster-card-model'
```

Append:

```js
describe('rosterToolbarModel', () => {
  const base = { isManager: true, viewType: 'week', selectMode: false, selectedCount: 0, copying: false }

  it('a manager in week view: five actions in More, in this order, and Publish on the row', () => {
    const m = rosterToolbarModel(base)
    expect(m.moreItems.map((i) => i.key)).toEqual(['time-off', 'select', 'copy-week', 'copy-month', 'templates'])
    expect(m.moreItems.map((i) => i.label)).toEqual(['Time off', 'Select multiple', 'Copy last week', 'Copy last month', 'Manage templates'])
    expect(m.showPublish).toBe(true)
    expect(m.timeOffInline).toBe(false)
  })

  it('links are links: Time off and Manage templates keep their hrefs', () => {
    const byKey = Object.fromEntries(rosterToolbarModel(base).moreItems.map((i) => [i.key, i]))
    expect(byKey['time-off'].href).toBe('/schedule/time-off')
    expect(byKey.templates.href).toBe('/settings/shifts')
    expect(byKey['copy-week'].href).toBeUndefined()
  })

  it('Publish is week-view only; everything in More stays reachable in month view', () => {
    const m = rosterToolbarModel({ ...base, viewType: 'month' })
    expect(m.showPublish).toBe(false)
    expect(m.moreItems).toHaveLength(5)
  })

  it('a coach: Time off inline, no More, no Publish', () => {
    const m = rosterToolbarModel({ ...base, isManager: false })
    expect(m.moreItems).toEqual([])
    expect(m.timeOffInline).toBe(true)
    expect(m.showPublish).toBe(false)
  })

  it('select mode is a checked item that says how to leave it, and marks the menu button', () => {
    const m = rosterToolbarModel({ ...base, selectMode: true, selectedCount: 3 })
    const item = m.moreItems.find((i) => i.key === 'select')
    expect(item.checked).toBe(true)
    expect(item.label).toBe('Exit multi-select (3)')
    expect(m.moreActive).toBe(true)
    expect(rosterToolbarModel(base).moreItems.find((i) => i.key === 'select').checked).toBe(false)
  })

  it('both copies are disabled while a copy runs, and the menu button says so', () => {
    const m = rosterToolbarModel({ ...base, copying: true })
    expect(m.moreItems.filter((i) => i.disabled).map((i) => i.key)).toEqual(['copy-week', 'copy-month'])
    expect(m.moreLabel).toBe('Copying…')
    expect(rosterToolbarModel(base).moreLabel).toBe('More')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/roster-card-model.test.js`
Expected: FAIL, `TypeError: rosterToolbarModel is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/roster-card-model.js`:

```js
/**
 * What the one toolbar row shows, and what the More menu holds.
 *
 * The gating is the gating ScheduleCalendar has always had, written down once:
 *   everyone   Time off, My shifts | All staff, Week | Month
 *   manager    Select multiple, Copy last week, Copy last month, Manage templates
 *   manager + week view   Publish
 * Icons are attached by RosterToolbar (by key); this stays a pure data shape.
 * `checked` present = a menuitemcheckbox. `href` present = a link, not a button.
 */
export function rosterToolbarModel({ isManager = false, viewType = 'week', selectMode = false, selectedCount = 0, copying = false } = {}) {
  if (!isManager) {
    return { timeOffInline: true, moreItems: [], moreLabel: 'More', moreActive: false, showPublish: false }
  }
  return {
    timeOffInline: false,
    moreLabel: copying ? 'Copying…' : 'More',
    moreActive: selectMode,
    showPublish: viewType === 'week',
    moreItems: [
      { key: 'time-off', label: 'Time off', href: '/schedule/time-off' },
      {
        key: 'select',
        label: selectMode ? `Exit multi-select (${selectedCount})` : 'Select multiple',
        checked: selectMode,
        title: selectMode ? 'Exit multi-select' : 'Select multiple shifts to assign a coach in bulk',
      },
      { key: 'copy-week', label: 'Copy last week', disabled: copying, title: "Duplicate last week's shifts into this week" },
      { key: 'copy-month', label: 'Copy last month', disabled: copying, title: "Duplicate last month's shifts into this month" },
      { key: 'templates', label: 'Manage templates', href: '/settings/shifts', title: 'Add, edit, or retire the shift templates that build this roster' },
    ],
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/roster-card-model.test.js`
Expected: PASS (whole file).

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-card-model.js src/lib/roster-card-model.test.js
git commit -m "ROSTERLOOK.1 — rosterToolbarModel: the toolbar's gating as a pure model"
```

---

### Task 6: `MoreMenu` (a menu button that works from the keyboard)

**Files:**
- Create: `src/components/schedule/MoreMenu.jsx`
- Create: `src/components/schedule/MoreMenu.test.jsx`

There is no Menu primitive in `src/components/ui/` (checked: Button, Card, EmptyState, Field, Loading, Modal, Table). The two existing hand-rolled menus (`PersonActionBar.jsx:154-193`, `WAInbox.jsx`) have `role="menu"` but no arrow keys and no focus return, so neither is a pattern to copy. This one is local to the schedule; promoting it to `ui/` is a separate PR (see "Not in this PR").

Contract (WAI-ARIA menu button): the button carries `aria-haspopup="menu"`, `aria-expanded`, `aria-controls`. Opening moves focus to the first enabled item. ArrowDown / ArrowUp move and wrap, Home / End jump, disabled items are skipped. Escape closes and returns focus to the button. Tab closes and lets focus move on. A click outside closes. Choosing an item closes, returns focus to the button, THEN runs the action (so a dialog the action opens captures the button as its opener and gives focus back to it on close).

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/schedule/MoreMenu.test.jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 — five toolbar actions moved into this menu, so "reachable from
// the keyboard" is now this component's job. Focus and roles are things jsdom
// answers honestly. Where the menu is DRAWN is not (memory
// `jsdom-cannot-see-layout`): the phone-width placement is a browser check.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import MoreMenu from '@/components/schedule/MoreMenu'

const ITEMS = [
  { key: 'time-off', label: 'Time off', href: '/schedule/time-off' },
  { key: 'select', label: 'Select multiple', checked: false, title: 'Select multiple shifts' },
  { key: 'copy-week', label: 'Copy last week', disabled: true },
  { key: 'copy-month', label: 'Copy last month' },
]

afterEach(() => cleanup())

function open(onSelect = vi.fn(), props = {}) {
  render(<MoreMenu items={ITEMS} onSelect={onSelect} {...props} />)
  const button = screen.getByRole('button', { name: 'More' })
  fireEvent.click(button)
  return { button, onSelect }
}

describe('MoreMenu', () => {
  it('is a real menu button, closed by default', () => {
    render(<MoreMenu items={ITEMS} onSelect={() => {}} />)
    const button = screen.getByRole('button', { name: 'More' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens, points aria-controls at the menu, and focuses the first item', () => {
    const { button } = open()
    const menu = screen.getByRole('menu')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(menu.id)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Time off' }))
  })

  it('links are links, toggles are menuitemcheckboxes, buttons are typed', () => {
    open()
    const link = screen.getByRole('menuitem', { name: 'Time off' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/schedule/time-off')
    const toggle = screen.getByRole('menuitemcheckbox', { name: 'Select multiple' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('type')).toBe('button')
    expect(toggle.getAttribute('title')).toBe('Select multiple shifts')
  })

  it('arrow keys move and wrap, skipping the disabled item; Home and End jump', () => {
    open()
    const menu = screen.getByRole('menu')
    const focused = () => document.activeElement.textContent.trim()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focused()).toBe('Select multiple')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focused()).toBe('Copy last month')       // Copy last week is disabled
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focused()).toBe('Time off')              // wrapped
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(focused()).toBe('Copy last month')       // wrapped the other way
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(focused()).toBe('Time off')
    fireEvent.keyDown(menu, { key: 'End' })
    expect(focused()).toBe('Copy last month')
  })

  it('Escape closes and returns focus to the button', () => {
    const { button } = open()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('choosing an item closes, returns focus to the button, then reports the key', () => {
    const { button, onSelect } = open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy last month' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('copy-month')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('a disabled item does nothing', () => {
    const { onSelect } = open()
    const item = screen.getByRole('menuitem', { name: 'Copy last week' })
    expect(item.disabled).toBe(true)
    fireEvent.click(item)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('a click outside closes it; Tab closes it without stealing focus back', () => {
    open()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('ArrowDown on the closed button opens it', () => {
    render(<MoreMenu items={ITEMS} onSelect={() => {}} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'More' }), { key: 'ArrowDown' })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('takes a label and an active state from its caller', () => {
    render(<MoreMenu items={ITEMS} onSelect={() => {}} label="Copying…" active />)
    const button = screen.getByRole('button', { name: 'Copying…' })
    expect(button.getAttribute('data-active')).toBe('true')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/schedule/MoreMenu.test.jsx`
Expected: FAIL, `Failed to resolve import "@/components/schedule/MoreMenu"`.

- [ ] **Step 3: Implement**

```jsx
// src/components/schedule/MoreMenu.jsx
'use client'

// ROSTERLOOK.1 — the roster toolbar's "More" menu.
//
// Eight buttons on two rows became one row by moving five secondary actions in
// here, which makes "every action stays reachable from the keyboard" THIS
// component's contract (WAI-ARIA menu button): focus moves into the menu on
// open, arrows move and wrap, Home/End jump, Escape closes and hands focus back
// to the button, Tab closes and moves on, a click outside closes.
//
// Choosing an item closes the menu and returns focus to the button BEFORE the
// action runs. Order matters: Copy last week opens a Modal, and the Modal
// primitive remembers document.activeElement as the place to return focus to.
// Run the action first and that element is a menu item that no longer exists.
//
// PLACEMENT. From `sm` up the menu hangs off the button's right edge. Below
// `sm` the wrapper is NOT the positioning context: the menu positions against
// the toolbar's actions group (which is `relative`) and spans its full width,
// because on a 390px phone the button can sit at either end of a wrapped row
// and a 220px menu anchored to it would leave the screen on one side or the
// other. jsdom cannot check any of this; the plan's browser task does.

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, MoreHorizontal } from 'lucide-react'

const ITEM_CLS =
  'w-full text-left px-3 py-2 text-xs text-un1t-text flex items-center gap-2 whitespace-nowrap ' +
  'hover:bg-un1t-border/40 focus-visible:outline-none focus-visible:bg-un1t-border/60 disabled:opacity-50 disabled:cursor-not-allowed'

export default function MoreMenu({ items, onSelect, label = 'More', active = false, icons = {} }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef(null)
  const menuRef = useRef(null)
  const menuId = useId()

  const enabledItems = () =>
    Array.from(menuRef.current?.querySelectorAll('[role^="menuitem"]:not([disabled])') || [])

  function close(returnFocus) {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }

  // Focus the first enabled item once the menu exists.
  useEffect(() => {
    if (open) enabledItems()[0]?.focus()
  }, [open])

  // A click anywhere else closes it. mousedown, so it closes before the click
  // lands on whatever the operator was reaching for.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || buttonRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function onMenuKeyDown(e) {
    const list = enabledItems()
    const at = list.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
    else if (e.key === 'Tab') close(false)
  }

  return (
    <div className="sm:relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={open ? menuId : undefined}
        data-active={active ? 'true' : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
        }}
        className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent ${
          active
            ? 'bg-amber-500/20 border-amber-500/50 text-amber-700'
            : 'border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30'
        }`}
      >
        <MoreHorizontal size={14} aria-hidden="true" /> {label}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="More roster actions"
          onKeyDown={onMenuKeyDown}
          className="absolute z-30 top-full mt-1 left-0 right-0 sm:left-auto sm:right-0 sm:min-w-[220px] bg-un1t-bg border border-un1t-border rounded-lg shadow-lg py-1"
        >
          {items.map((item) => {
            const Icon = icons[item.key]
            const body = (
              <>
                {Icon && <Icon size={14} className="text-un1t-subtle shrink-0" aria-hidden="true" />}
                <span className="flex-1">{item.label}</span>
                {item.checked === true && <Check size={14} className="text-amber-700 shrink-0" aria-hidden="true" />}
              </>
            )
            if (item.href) {
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  role="menuitem"
                  tabIndex={-1}
                  title={item.title}
                  onClick={() => close(false)}
                  className={ITEM_CLS}
                >
                  {body}
                </Link>
              )
            }
            return (
              <button
                key={item.key}
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked === undefined ? undefined : item.checked ? 'true' : 'false'}
                tabIndex={-1}
                disabled={!!item.disabled}
                title={item.title}
                onClick={() => { close(true); onSelect(item.key) }}
                className={ITEM_CLS}
              >
                {body}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/schedule/MoreMenu.test.jsx`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/MoreMenu.jsx src/components/schedule/MoreMenu.test.jsx
git commit -m "ROSTERLOOK.1 — MoreMenu: a menu button with arrow keys, Escape and focus return"
```

---

### Task 7: `RosterToolbar` (the one row)

**Files:**
- Create: `src/components/schedule/RosterToolbar.jsx`
- Create: `src/components/schedule/RosterToolbar.test.jsx`

Left group: prev / period label / next / Today / the publish-state chip (a SLOT: the chip's JSX stays in `ScheduleCalendar.jsx`, where 03-CHANGELOG.1 attached its drawer). Right group: My shifts | All staff, Week | Month, (Time off link for a coach), More, Publish. Both groups and the row wrap, every control is `whitespace-nowrap`, the toggle icons hide below `sm` so both toggles plus More fit one 358px line, and Publish is the LAST child so when the row wraps it lands on a line of its own rather than off the right edge.

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/schedule/RosterToolbar.test.jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 — structure, order, names and wiring of the one toolbar row.
// 🔴 NOT proof that it IS one row, or that it wraps sanely at 390px: jsdom has
// no layout engine (memory `jsdom-cannot-see-layout`). The class pins below
// stop the wrapping classes being dropped; the browser task proves the layout.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import RosterToolbar from '@/components/schedule/RosterToolbar'
import { rosterToolbarModel } from '@/lib/roster-card-model'

afterEach(() => cleanup())

function setup(over = {}, modelOver = {}) {
  const handlers = {
    onPrev: vi.fn(), onNext: vi.fn(), onToday: vi.fn(),
    onViewMode: vi.fn(), onViewType: vi.fn(),
    onSelectToggle: vi.fn(), onCopyWeek: vi.fn(), onCopyMonth: vi.fn(), onPublish: vi.fn(),
  }
  const model = rosterToolbarModel({ isManager: true, viewType: 'week', ...modelOver })
  render(
    <RosterToolbar
      viewType="week"
      periodLabel="21 Sep – 27 Sep 2026"
      viewMode="all"
      model={model}
      publishing={false}
      statusChip={<span data-testid="publication-status">Published</span>}
      {...handlers}
      {...over}
    />,
  )
  return handlers
}

describe('RosterToolbar', () => {
  it('two wrapping groups in one wrapping row: navigation first, actions second', () => {
    setup()
    const row = screen.getByTestId('schedule-toolbar')
    const nav = screen.getByTestId('schedule-toolbar-nav')
    const actions = screen.getByTestId('schedule-toolbar-actions')
    expect(Array.from(row.children)).toEqual([nav, actions])
    for (const el of [row, nav, actions]) expect(el.className).toMatch(/\bflex-wrap\b/)
    // The phone menu positions against the actions group.
    expect(actions.className).toMatch(/\brelative\b/)
  })

  it('left group, in order: previous, the period, next, Today, the publish-state chip', () => {
    setup()
    const nav = screen.getByTestId('schedule-toolbar-nav')
    const prev = within(nav).getByRole('button', { name: 'Previous week' })
    const label = within(nav).getByText('21 Sep – 27 Sep 2026')
    const next = within(nav).getByRole('button', { name: 'Next week' })
    const today = within(nav).getByRole('button', { name: 'Today' })
    const chip = within(nav).getByTestId('publication-status')
    const order = [prev, label, next, today, chip]
    for (let i = 0; i < order.length - 1; i++) {
      expect(order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(label.className).toMatch(/whitespace-nowrap/)
  })

  it('month view renames the arrows', () => {
    setup({ viewType: 'month', periodLabel: 'September 2026' })
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next month' })).toBeTruthy()
  })

  it('the arrows and Today call straight through', () => {
    const h = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(h.onPrev).toHaveBeenCalledTimes(1)
    expect(h.onNext).toHaveBeenCalledTimes(1)
    expect(h.onToday).toHaveBeenCalledTimes(1)
  })

  it('both toggles say which side is on (aria-pressed), and report the other side', () => {
    const h = setup()
    expect(screen.getByRole('button', { name: 'All staff' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'My shifts' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Week' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'My shifts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    expect(h.onViewMode).toHaveBeenCalledWith('my')
    expect(h.onViewType).toHaveBeenCalledWith('month')
  })

  it('exactly ONE primary button, Publish, and it is the last control in the row', () => {
    const h = setup()
    const actions = screen.getByTestId('schedule-toolbar-actions')
    const publish = screen.getByRole('button', { name: 'Publish' })
    expect(actions.lastElementChild).toBe(publish)
    expect(publish.className).toMatch(/whitespace-nowrap/)
    expect(actions.querySelectorAll('.bg-blue-600')).toHaveLength(1)
    fireEvent.click(publish)
    expect(h.onPublish).toHaveBeenCalledTimes(1)
  })

  it('Publish is disabled and says so while publishing; absent in month view', () => {
    setup({ publishing: true })
    expect(screen.getByRole('button', { name: 'Publishing...' }).disabled).toBe(true)
    cleanup()
    setup({ viewType: 'month' }, { viewType: 'month' })
    expect(screen.queryByRole('button', { name: /^Publish/ })).toBeNull()
  })

  it('the five secondary actions are in More, not on the row, and each reaches its handler', () => {
    const h = setup()
    expect(screen.queryByText('Copy last week')).toBeNull()
    const pick = (role, name) => {
      fireEvent.click(screen.getByRole('button', { name: 'More' }))
      fireEvent.click(screen.getByRole(role, { name }))
    }
    pick('menuitemcheckbox', 'Select multiple')
    pick('menuitem', 'Copy last week')
    pick('menuitem', 'Copy last month')
    expect(h.onSelectToggle).toHaveBeenCalledTimes(1)
    expect(h.onCopyWeek).toHaveBeenCalledTimes(1)
    expect(h.onCopyMonth).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menuitem', { name: 'Time off' }).getAttribute('href')).toBe('/schedule/time-off')
    expect(screen.getByRole('menuitem', { name: 'Manage templates' }).getAttribute('href')).toBe('/settings/shifts')
  })

  it('a coach: Time off is a plain link on the row; no More, no Publish', () => {
    setup({}, { isManager: false })
    expect(screen.getByRole('link', { name: 'Time off' }).getAttribute('href')).toBe('/schedule/time-off')
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Publish/ })).toBeNull()
  })

  it('renders without a chip (a coach, or a period with nothing to say)', () => {
    setup({ statusChip: null })
    expect(screen.queryByTestId('publication-status')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/schedule/RosterToolbar.test.jsx`
Expected: FAIL, `Failed to resolve import "@/components/schedule/RosterToolbar"`.

- [ ] **Step 3: Implement**

```jsx
// src/components/schedule/RosterToolbar.jsx
'use client'

// ROSTERLOOK.1 — the roster's ONE toolbar row.
//
// Was: an H2 + subtitle, EIGHT buttons wrapping onto two rows, then a separate
// week navigator with the publish chip under it: about 200px before the first
// banner. Now: [prev  period  next  Today  chip]   [My|All  Week|Month  More  Publish].
//
// Everything is still here and still gated as before; rosterToolbarModel
// (src/lib/roster-card-model.js) is where the gating is written down and
// tested. This component lays the model out and calls the handlers it is given.
// It owns NO roster state.
//
// The publish-state chip is a SLOT (`statusChip`). Its JSX stays in
// ScheduleCalendar.jsx because CHANGELOG.1 opens its "changes since publish"
// drawer from it; this row only gives it a stable place to sit.
//
// WRAPPING (CAL-UI-LOW.1 still applies): the row and both groups are
// flex-wrap, every control is whitespace-nowrap so a wrap falls BETWEEN
// controls, and Publish is the last child so on a phone it drops to its own
// line instead of leaving the screen. Toggle icons hide below `sm` to let both
// toggles and More share one 358px line. None of that is provable in jsdom.

import Link from 'next/link'
import { ChevronLeft, ChevronRight, Send, Users, User, CalendarDays, CalendarRange, CalendarOff, Check, Copy, Settings } from 'lucide-react'
import MoreMenu from './MoreMenu'

const MORE_ICONS = { 'time-off': CalendarOff, select: Check, 'copy-week': Copy, 'copy-month': Copy, templates: Settings }

const NAV_BTN =
  'p-2 rounded-lg hover:bg-un1t-border/50 text-un1t-subtle hover:text-un1t-text transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent'
const SEGMENTED = 'flex shrink-0 bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden text-xs'
const segment = (on) =>
  `flex items-center gap-1.5 px-3 py-2 whitespace-nowrap transition-colors ${
    on ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'
  }`

export default function RosterToolbar({
  viewType, periodLabel, onPrev, onNext, onToday, statusChip,
  viewMode, onViewMode, onViewType,
  model, onSelectToggle, onCopyWeek, onCopyMonth, onPublish, publishing,
}) {
  const period = viewType === 'month' ? 'month' : 'week'
  // Menu key → the handler ScheduleCalendar has always had for that action.
  const HANDLERS = { select: onSelectToggle, 'copy-week': onCopyWeek, 'copy-month': onCopyMonth }

  return (
    <div data-testid="schedule-toolbar" className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div data-testid="schedule-toolbar-nav" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5">
        <button type="button" onClick={onPrev} aria-label={`Previous ${period}`} className={NAV_BTN}>
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <span className="px-1 text-sm sm:text-base font-semibold text-un1t-text whitespace-nowrap">{periodLabel}</span>
        <button type="button" onClick={onNext} aria-label={`Next ${period}`} className={NAV_BTN}>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onToday}
          className="ml-1 text-xs px-2 py-1 rounded-md text-blue-700 hover:text-blue-800 hover:bg-un1t-border/40 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
        >
          Today
        </button>
        {statusChip && <span className="ml-1 inline-flex">{statusChip}</span>}
      </div>

      <div data-testid="schedule-toolbar-actions" className="relative flex flex-wrap items-center gap-2">
        <div className={SEGMENTED}>
          <button type="button" aria-pressed={viewMode === 'my'} onClick={() => onViewMode('my')} className={segment(viewMode === 'my')}>
            <User size={14} className="hidden sm:inline" aria-hidden="true" /> My shifts
          </button>
          <button type="button" aria-pressed={viewMode === 'all'} onClick={() => onViewMode('all')} className={segment(viewMode === 'all')}>
            <Users size={14} className="hidden sm:inline" aria-hidden="true" /> All staff
          </button>
        </div>

        <div className={SEGMENTED}>
          <button type="button" aria-pressed={viewType === 'week'} onClick={() => onViewType('week')} className={segment(viewType === 'week')}>
            <CalendarDays size={14} className="hidden sm:inline" aria-hidden="true" /> Week
          </button>
          <button type="button" aria-pressed={viewType === 'month'} onClick={() => onViewType('month')} className={segment(viewType === 'month')}>
            <CalendarRange size={14} className="hidden sm:inline" aria-hidden="true" /> Month
          </button>
        </div>

        {model.timeOffInline && (
          <Link
            href="/schedule/time-off"
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30 transition-colors whitespace-nowrap"
          >
            <CalendarOff size={14} aria-hidden="true" /> Time off
          </Link>
        )}

        {model.moreItems.length > 0 && (
          <MoreMenu
            items={model.moreItems}
            icons={MORE_ICONS}
            label={model.moreLabel}
            active={model.moreActive}
            onSelect={(key) => HANDLERS[key]?.()}
          />
        )}

        {model.showPublish && (
          <button
            type="button"
            onClick={onPublish}
            disabled={publishing}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            <Send size={14} aria-hidden="true" /> {publishing ? 'Publishing...' : 'Publish'}
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/schedule/RosterToolbar.test.jsx`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/RosterToolbar.jsx src/components/schedule/RosterToolbar.test.jsx
git commit -m "ROSTERLOOK.1 — RosterToolbar: navigation, toggles, More and one primary Publish on a single wrapping row"
```

---

### Task 8: Swap the toolbar into `ScheduleCalendar.jsx`; remove the H2 block

**Files:**
- Modify: `src/components/ScheduleCalendar.jsx` — imports (25-26), region 930-1150 (anchors: `{/* Header */}` through the closing `</div>` of `{/* Range Navigation */}`)
- Rewrite: `src/components/ScheduleCalendar.toolbar.test.jsx`
- Modify: `src/components/ScheduleCalendar.a11y.test.jsx:171`
- Modify: `src/components/ScheduleCalendar.errors.test.jsx` (mechanical substitution)

**Why the H2 block can go:** `Sidebar.jsx:351-357` prints `user.activeLocation.name` on every page, the (team) hub strip and `ScheduleTabs` both have "Schedule" selected, and Task 16 puts the studio in the tab title. "Schedule / UN1T Stillorgan — Staff roster" is a third statement of both facts, 70px tall. A visually hidden `<h2>` stays so heading navigation still has a landmark for the roster.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `src/components/ScheduleCalendar.toolbar.test.jsx` with:

```jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 (was CAL-UI-LOW.1) — the roster's chrome is ONE toolbar row.
//
// 🔴 THIS FILE IS NOT PROOF OF LAYOUT. jsdom has no layout engine (memory
// `jsdom-cannot-see-layout`): it cannot tell one row from two, or a wrapped
// row from one overflowing off a phone. It pins the WIRING: what is on the
// row, what is in More, what each control is called, that every action still
// reaches its handler, and that the week-view-only rule survived. The row
// itself is pinned in schedule/RosterToolbar.test.jsx; the layout was checked
// in a browser at 1280 and 390.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act, waitFor, fireEvent, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace() {} }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(),
}))

import ScheduleCalendar from '@/components/ScheduleCalendar'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const COACH = { id: 'u2', role: 'coach', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const TEMPLATE = { id: 't1', name: 'Morning', start_time: '09:00', end_time: '12:00', color: '#3B82F6', active: true, max_coaches: 3 }
// One unpublished block today, so the publication chip has something to say.
const BLOCK = {
  id: 'b1', location_id: 'loc1', block_date: iso(new Date()), template_id: 't1',
  start_time: '09:00', end_time: '12:00', max_coaches: 3, min_coaches: 1,
  shift_templates: TEMPLATE, shift_assignments: [], rosters: null,
}

function mockFetch() {
  return vi.fn((url) => {
    const u = String(url)
    const body = u.includes('/api/schedule/blocks') ? { success: true, data: [BLOCK] }
      : u.includes('contractor-spend') || u.includes('week-cost') ? { success: true, data: null }
        : { success: true, data: [] }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  })
}

async function renderCalendar(user = MANAGER) {
  global.fetch = mockFetch()
  await act(async () => { render(<ScheduleCalendar user={user} />) })
  await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('roster toolbar wiring (ROSTERLOOK.1)', () => {
  it('there is one toolbar, and no second navigation row under it', async () => {
    await renderCalendar()
    expect(screen.getAllByTestId('schedule-toolbar')).toHaveLength(1)
    const nav = screen.getByTestId('schedule-toolbar-nav')
    // The arrows, Today and the chip all live in the toolbar's left group now.
    expect(within(nav).getByRole('button', { name: 'Previous week' })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: 'Next week' })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: 'Today' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Previous week' })).toHaveLength(1)
  })

  it('the publish-state chip keeps its test id and its words, inside the left group', async () => {
    await renderCalendar()
    const chip = screen.getByTestId('publication-status')
    expect(screen.getByTestId('schedule-toolbar-nav').contains(chip)).toBe(true)
    expect(chip.textContent).toMatch(/Week status: Not published/)
  })

  it('drops the visible "Schedule / studio — Staff roster" block but keeps a heading for the roster', async () => {
    await renderCalendar()
    expect(screen.queryByText(/— Staff roster/)).toBeNull()
    const heading = screen.getByRole('heading', { level: 2, name: 'Stillorgan staff roster' })
    expect(heading.className).toMatch(/\bsr-only\b/)
  })

  it('Publish is on the row in week view only; More keeps all five actions in month view', async () => {
    await renderCalendar()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menu').querySelectorAll('[role^="menuitem"]')).toHaveLength(5)
  })

  it('Copy last week, reached through More, still opens the copy chooser', async () => {
    await renderCalendar()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy last week' }))
    expect(await screen.findByText('Exact copy')).toBeTruthy()
  })

  it('Select multiple, reached through More, turns select mode on and marks the menu button', async () => {
    await renderCalendar()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Select multiple' }))
    expect(screen.getByText('Click shifts on the calendar to select')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'More' }).getAttribute('data-active')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Exit multi-select (0)' }).getAttribute('aria-checked')).toBe('true')
  })

  it('a coach gets Time off as a link, and no More, Publish or chip', async () => {
    await renderCalendar(COACH)
    expect(screen.getByRole('link', { name: 'Time off' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
    expect(screen.queryByTestId('publication-status')).toBeNull()
  })
})
```

In `src/components/ScheduleCalendar.a11y.test.jsx` replace line 171:

```jsx
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Select multiple/ })) })
```

with:

```jsx
    // ROSTERLOOK.1 — Select multiple moved into the toolbar's More menu.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'More' })) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Select multiple/ })) })
```

In `src/components/ScheduleCalendar.errors.test.jsx` add this helper directly under the `const user = {` block's closing brace (the block starts at line 52):

```jsx
// ROSTERLOOK.1 — Time off, Copy last week and Copy last month moved into the
// toolbar's More menu. This opens it (if it is not already open) and hands
// back the item, so every call site stays a one-line click. The Time off item
// is itself the <a>, so the exit-guard tests need no .closest('a').
function moreItem(label) {
  if (!screen.queryByRole('menu')) fireEvent.click(screen.getByRole('button', { name: /^(More|Copying…)$/ }))
  return screen.getByRole('menuitem', { name: label })
}
```

then apply these three substitutions to the WHOLE file (every occurrence, including any test 01-COPYLEAVE.1 added to the `copy chooser (COPYMODES.1)` describe):

```bash
sed -i '' \
  -e "s/screen\.getByText('Copy Last Week')/moreItem('Copy last week')/g" \
  -e "s/screen\.getByText('Copy Last Month')/moreItem('Copy last month')/g" \
  -e "s/screen\.getByText('Time Off')\.closest('a')/moreItem('Time off')/g" \
  src/components/ScheduleCalendar.errors.test.jsx
grep -n "Copy Last\|'Time Off'" src/components/ScheduleCalendar.errors.test.jsx
```
Expected from the `grep`: only comment lines and `it('Copy Last Month targets…')` titles. No `getByText`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/ScheduleCalendar.toolbar.test.jsx src/components/ScheduleCalendar.errors.test.jsx src/components/ScheduleCalendar.a11y.test.jsx`
Expected: FAIL. toolbar: `Unable to find an element by: [data-testid="schedule-toolbar-nav"]`. errors + a11y: `Unable to find an accessible element with the role "button" and name "More"` (or `/^(More|Copying…)$/`).

- [ ] **Step 3: Implement**

(a) `src/components/ScheduleCalendar.jsx:25-26`. Replace:

```jsx
import { ChevronLeft, ChevronRight, Copy, Send, Plus, Users, User, Clock, X, ArrowLeftRight, CalendarOff, Palmtree, ThermometerSun, Ban, Wallet, CircleEllipsis, AlertTriangle, AlertCircle, CalendarDays, CalendarRange, Pencil, Check, Settings } from 'lucide-react'
import Link from 'next/link'
```

with (nine icons and `Link` moved to `RosterToolbar`; `CalendarOff`, `Clock` and `Check` stay, they are used by `TIME_OFF_FALLBACK` / `PUBLICATION_CHIP` / the dialogs):

```jsx
import { Plus, Clock, X, ArrowLeftRight, CalendarOff, Palmtree, ThermometerSun, Ban, Wallet, CircleEllipsis, AlertTriangle, AlertCircle, Pencil, Check } from 'lucide-react'
```

and add beside the other `./schedule/` imports (after line 71):

```jsx
// ROSTERLOOK.1 — the toolbar row, and the pure model that says what is on it.
import RosterToolbar from './schedule/RosterToolbar'
import { rosterToolbarModel } from '@/lib/roster-card-model'
```

(b) Directly above `return (` (line 928), add the handlers. The two view switches are the toggle's inline `onClick` bodies (`:981-987`, `:994-998`) moved verbatim with their comments; the three navigation functions are the arrows' and Today's inline bodies (`:1085-1088`, `:1098-1102`, `:1141-1144`); `toggleSelectMode` is `:1014-1017`:

```jsx
  // ROSTERLOOK.1 — the toolbar's handlers. Each is the inline onClick the old
  // header carried, given a name so RosterToolbar can call it. No behaviour
  // changed in the move.
  function showWeekView() {
    // ROSTER-FIX.6a — see weekStartForMonth: getMonday(monthStart)
    // used to land on the previous month whenever the 1st fell on
    // a weekend, and the next Month click then kept that month.
    if (viewType === 'month') setWeekStart(weekStartForMonth(monthStart, weekStart))
    setViewType('week')
  }
  function showMonthView() {
    // Midweek decides which month a straddling week belongs to.
    if (viewType === 'week') setMonthStart(monthStartForWeek(weekStart))
    setViewType('month')
  }
  function goPrevious() {
    if (viewType === 'month') setMonthStart(addMonths(monthStart, -1))
    else setWeekStart(addDays(weekStart, -7))
  }
  function goNext() {
    if (viewType === 'month') setMonthStart(addMonths(monthStart, 1))
    else setWeekStart(addDays(weekStart, 7))
  }
  function goToday() {
    const now = new Date()
    if (viewType === 'month') setMonthStart(getMonthStart(now))
    else setWeekStart(getMonday(now))
  }
  function toggleSelectMode() {
    if (selectMode) exitSelectMode()
    else setSelectMode(true)
  }

  const toolbarModel = rosterToolbarModel({
    isManager,
    viewType,
    selectMode,
    selectedCount: selectedBlockIds.size,
    copying,
  })

  // ROSTERVIS.1 — whether the period on screen is published. Manager only (a
  // coach's feed is published-only), and hidden while loading so a stale
  // week's answer never sits under new dates.
  // ROSTERLOOK.1 — the chip is built HERE and handed to the toolbar as a slot,
  // so it stays a stable anchor: CHANGELOG.1's "changes since publish" drawer
  // opens from this element. Only its old centering wrapper is gone.
  const publicationChip = isManager && !loading && publication.status !== 'none' ? (() => {
    const chip = PUBLICATION_CHIP[publication.status]
    const Icon = chip.Icon
    const periodWord = viewType === 'month' ? 'Month' : 'Week'
    const label = PUBLICATION_LABELS[publication.status]
    const extra = publication.status === 'published' && publication.draftPending
      ? ', changes awaiting approval'
      : publication.status === 'partial'
        ? ` (${publication.publishedCount} of ${publication.blockCount} shifts)`
        : ''
    return (
      <span
        role="status"
        data-testid="publication-status"
        className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${chip.cls}`}
      >
        <Icon size={12} aria-hidden="true" />
        <span className="sr-only">{periodWord} status: </span>
        {label}{extra}
      </span>
    )
  })() : null
```

🔴 **Rebase rule (this is the version you will actually write).** The `return (…)` above is the chip as it stood at `8231d438` (`:1126-1134`) plus `whitespace-nowrap`. 03-CHANGELOG.1 (Task "chip", its plan lines 1235-1300) replaces that `return` with a `role="status"` wrapper holding EITHER a `<button data-testid="publication-status" aria-haspopup="dialog" onClick={() => setChangeLog(…)}>` (published / partly published) OR a `<span data-testid="publication-status">`. Carry 03's `canOpenLog`, `chipCls`, `chipBody`, the button and the span VERBATIM into this constant. Exactly two edits to 03's markup, both on the wrapper and the class string, never on the button:

```jsx
    // was: <div className="mt-1.5 flex justify-center" role="status">
    // The centering wrapper goes (the chip sits inline in the toolbar now); the
    // live region stays, because 03 moved role="status" here on purpose so the
    // button does not carry a conflicting role.
    return (
      <span role="status" className="inline-flex">
        {canOpenLog ? ( /* 03's <button …> verbatim */ ) : ( /* 03's <span …> verbatim */ )}
      </span>
    )
```

and append ` whitespace-nowrap` inside 03's `chipCls` template string. 03's `changeLog` state, its `RosterChangeLogDrawer` import and its render block after `PublishRosterModal` are outside this region: do not touch them. 03's four chip tests in `ScheduleCalendar.visibility.test.jsx` (`tagName` is `BUTTON` / `SPAN`, click opens the drawer, text unchanged) must pass UNMODIFIED after this task; they are in the Step 4 run.

(c) Replace the region from `{/* Header */}` (`:930`) through the `</div>` that closes `{/* Range Navigation */}` (`:1150`). That is: the CAL-UI-LOW.1 comment, the `flex flex-wrap items-center justify-between gap-x-4 gap-y-3 mb-6` row with the `<h2>Schedule</h2>` block and the eight-control `data-testid="schedule-toolbar"` group, and the whole `flex items-center justify-between mb-4` navigator. The replacement:

```jsx
      {/* ROSTERLOOK.1 — the visible "Schedule / <studio> — Staff roster" block
          is gone: the sidebar names the studio, two tab strips say "Schedule",
          and the tab title says both. Heading navigation keeps a landmark. */}
      <h2 className="sr-only">
        {user.activeLocation?.name ? `${user.activeLocation.name} staff roster` : 'Staff roster'}
      </h2>

      {/* ROSTERLOOK.1 — ONE toolbar row (was: eight buttons on two rows, then
          a separate week navigator). Gating lives in rosterToolbarModel; the
          handlers are the ones this file has always had. CAL-UI-LOW.1's
          wrapping rules moved into RosterToolbar with the markup. */}
      <RosterToolbar
        viewType={viewType}
        periodLabel={viewType === 'month' ? monthLabel : weekLabel}
        onPrev={goPrevious}
        onNext={goNext}
        onToday={goToday}
        statusChip={publicationChip}
        viewMode={viewMode}
        onViewMode={setViewMode}
        onViewType={(next) => (next === 'month' ? showMonthView() : showWeekView())}
        model={toolbarModel}
        onSelectToggle={toggleSelectMode}
        onCopyWeek={handleCopyWeek}
        onCopyMonth={handleCopyMonth}
        onPublish={handlePublishClick}
        publishing={publishing}
      />
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/ScheduleCalendar.toolbar.test.jsx src/components/ScheduleCalendar.errors.test.jsx src/components/ScheduleCalendar.a11y.test.jsx src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.publish-confirm.test.jsx`
Expected: PASS for all five files. (`visibility` and `publish-confirm` are run here because they click `Month`, `Publish` and read the chip; none of their assertions change in this task.)

Then: `npx eslint src/components/ScheduleCalendar.jsx src/components/schedule/`
Expected: clean. If it reports an unused import, it will be one of the ten named in (a); remove exactly what it names.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.toolbar.test.jsx src/components/ScheduleCalendar.a11y.test.jsx src/components/ScheduleCalendar.errors.test.jsx
git commit -m "ROSTERLOOK.1 — one toolbar row: navigator + chip left, toggles + More + Publish right; H2 block removed"
```

---

### Task 9: `StatusDot` + `DayHeader`

**Files:**
- Create: `src/components/schedule/StatusDot.jsx`
- Create: `src/components/schedule/DayHeader.jsx`
- Create: `src/components/schedule/DayHeader.test.jsx`

The header keeps today's three looks (today = `bg-blue-600 text-white`, holiday = amber, otherwise surface; `ScheduleCalendar.jsx:1415-1419`). The status sits in a small `bg-un1t-bg` pill so the same `text-amber-700` / `text-red-700` is readable on the blue "today" header as well as the grey one. For a manager the whole header is a `<button>` that opens the Studio Overview for that day; for a coach it is the same `<div>` as today, with no status and nothing to click.

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/schedule/DayHeader.test.jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 — the Studio Overview strip folded into the week's day headers.
// Roles, names and presence only; nothing here says the pill FITS the header
// (memory `jsdom-cannot-see-layout`).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import DayHeader from '@/components/schedule/DayHeader'

afterEach(() => cleanup())

const OK = { tone: 'ok', label: '', srLabel: 'Fully staffed', title: 'Every shift has its minimum number of coaches' }
const SHORT = { tone: 'short', label: '1 short', srLabel: '1 shift needs coaches: 1 below the minimum', title: '1 shift needs coaches: 1 below the minimum' }
const EMPTY = { tone: 'empty', label: '2 short', srLabel: '2 shifts need coaches: 1 with no coach, 1 below the minimum', title: '2 shifts need coaches: 1 with no coach, 1 below the minimum' }
const NONE = { tone: 'none', label: '', srLabel: '', title: '' }
const base = { label: 'Mon', dayNumber: 21, fullDate: 'Monday 21 September', isToday: false, holiday: null }

describe('DayHeader', () => {
  it('manager: the header is a button named by its date, its status and what it opens', () => {
    const onOpen = vi.fn()
    render(<DayHeader {...base} status={SHORT} onOpen={onOpen} />)
    const btn = screen.getByRole('button', { name: 'Monday 21 September. 1 shift needs coaches: 1 below the minimum. Open studio overview' })
    expect(btn.getAttribute('type')).toBe('button')
    fireEvent.click(btn)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['ok: a dot and words for a screen reader, NO visible count', OK, 'ok', null, 'Fully staffed'],
    ['short: amber, "1 short"', SHORT, 'short', '1 short', SHORT.srLabel],
    ['empty: red, the total', EMPTY, 'empty', '2 short', EMPTY.srLabel],
  ])('%s', (_n, status, tone, visible, sr) => {
    render(<DayHeader {...base} status={status} onOpen={() => {}} />)
    const dot = screen.getByTestId('status-dot')
    expect(dot.getAttribute('data-tone')).toBe(tone)
    expect(dot.getAttribute('title')).toBe(status.title)
    expect(dot.querySelector('.sr-only').textContent).toBe(sr)
    const shown = dot.querySelector('[data-visible-label]')
    if (visible) expect(shown.textContent).toBe(visible)
    else expect(shown).toBeNull()
  })

  it('says nothing for a day with no future shifts', () => {
    render(<DayHeader {...base} status={NONE} onOpen={() => {}} />)
    expect(screen.queryByTestId('status-dot')).toBeNull()
  })

  it('coach: a plain header, no status, nothing to click', () => {
    render(<DayHeader {...base} status={null} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('status-dot')).toBeNull()
    expect(screen.getByTestId('day-header').textContent).toBe('Mon21')
  })

  it('keeps the holiday line and names it in the button', () => {
    render(<DayHeader {...base} holiday={{ name: 'October Bank Holiday', source: 'national' }} status={OK} onOpen={() => {}} />)
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Monday 21 September. October Bank Holiday. Fully staffed. Open studio overview')
    expect(screen.getByTestId('day-header').textContent).toContain('October Bank Holiday')
  })

  it('today keeps its solid header; the status rides in its own light pill', () => {
    render(<DayHeader {...base} isToday status={SHORT} onOpen={() => {}} />)
    expect(screen.getByTestId('day-header').className).toMatch(/\bbg-blue-600\b/)
    expect(screen.getByTestId('status-dot').className).toMatch(/\bbg-un1t-bg\b/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/schedule/DayHeader.test.jsx`
Expected: FAIL, `Failed to resolve import "@/components/schedule/DayHeader"`.

- [ ] **Step 3: Implement**

```jsx
// src/components/schedule/StatusDot.jsx
// ROSTERLOOK.1 — the roster's ONE way of saying "this day is / is not staffed":
// a dot, a short count only when something is wrong ("2 short"), and the
// sentence behind it as both a tooltip and visually hidden text. Used by the
// week view's day headers and the month view's cells, so the two cannot drift
// the way the Studio Overview tile ("UNDERMANNED 4/1") and the month badges
// ("!1", "↓1") did. Takes a dayHeaderStatus() result.
//
// The pill carries its own bg-un1t-bg so -700 text is readable on ANY header,
// including today's solid blue one. No 'use client': it has no state.

const DOT = { ok: 'bg-emerald-600', short: 'bg-amber-500', empty: 'bg-red-600' }
const TEXT = { ok: 'text-emerald-700', short: 'text-amber-700', empty: 'text-red-700' }

export default function StatusDot({ status }) {
  if (!status || status.tone === 'none') return null
  return (
    <span
      data-testid="status-dot"
      data-tone={status.tone}
      title={status.title}
      className={`inline-flex items-center gap-1 rounded-full bg-un1t-bg px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap ${TEXT[status.tone]}`}
    >
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[status.tone]}`} />
      {status.label && <span aria-hidden="true" data-visible-label>{status.label}</span>}
      <span className="sr-only">{status.srLabel}</span>
    </span>
  )
}
```

```jsx
// src/components/schedule/DayHeader.jsx
'use client'

// ROSTERLOOK.1 — a week-view day header that also carries the day's staffing
// status and, for a manager, opens the Studio Overview for that day.
//
// This is where the Studio Overview strip went. The strip was a second row of
// seven tiles saying, in colliding capitals and an unexplained "4/1", roughly
// what the column under it already showed. The header says it with a dot and
// "1 short", and the full breakdown (events, bookable types, who is on leave,
// the undermanned shifts) is one click away in the SAME dialog the strip
// opened.
//
// A coach gets the plain header: `status` is null and there is no `onOpen`,
// because both the staffing status and the overview are manager surfaces.

import StatusDot from './StatusDot'

export default function DayHeader({ label, dayNumber, fullDate, isToday, holiday, status, onOpen }) {
  const headerCls = isToday
    ? 'bg-blue-600 text-white'
    : holiday
      ? 'bg-amber-500/15 text-amber-700 border border-amber-500/30'
      : 'bg-un1t-surface text-un1t-subtle'
  const cls = `block w-full text-center py-2 rounded-t-lg text-xs font-semibold ${headerCls}`

  const body = (
    <>
      <div>{label}</div>
      <div className={`text-lg font-bold ${isToday ? 'text-white' : 'text-un1t-text'}`}>{dayNumber}</div>
      {holiday && (
        <div className={`mt-0.5 text-[10px] font-medium leading-tight px-1 truncate ${isToday ? 'text-white/80' : 'text-amber-700'}`}>
          {holiday.source === 'national' ? '🇮🇪 ' : '🏷 '}{holiday.name}
        </div>
      )}
      {status && status.tone !== 'none' && (
        <div className="mt-1 flex justify-center">
          <StatusDot status={status} />
        </div>
      )}
    </>
  )

  if (!onOpen) {
    return <div data-testid="day-header" className={cls} title={holiday?.name || undefined}>{body}</div>
  }
  return (
    <button
      type="button"
      data-testid="day-header"
      onClick={onOpen}
      aria-label={[fullDate, holiday?.name, status?.srLabel, 'Open studio overview'].filter(Boolean).join('. ')}
      title={holiday?.name || 'Open studio overview'}
      className={`${cls} cursor-pointer hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent`}
    >
      {body}
    </button>
  )
}
```

(The holiday line, flag glyphs included, is `ScheduleCalendar.jsx:1426-1430` verbatim.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/schedule/DayHeader.test.jsx`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/StatusDot.jsx src/components/schedule/DayHeader.jsx src/components/schedule/DayHeader.test.jsx
git commit -m "ROSTERLOOK.1 — DayHeader + StatusDot: a day's staffing status in its header"
```

---

### Task 10: Move the Studio Overview file (verbatim, its own commit)

**Files:**
- `git mv src/components/StudioOverviewStrip.jsx src/components/schedule/StudioOverviewDialog.jsx`
- `git mv src/components/StudioOverviewStrip.test.jsx src/components/schedule/StudioOverviewDialog.test.jsx`
- Modify: `src/components/ScheduleRosterView.jsx:10` (import path only)

No behaviour changes in this commit. It exists so the NEXT commit's diff shows what changed in the dialog rather than a 403-line delete and a 300-line add.

- [ ] **Step 1: The "failing test" is the move itself**

```bash
git mv src/components/StudioOverviewStrip.jsx src/components/schedule/StudioOverviewDialog.jsx
git mv src/components/StudioOverviewStrip.test.jsx src/components/schedule/StudioOverviewDialog.test.jsx
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/schedule/StudioOverviewDialog.test.jsx src/components/ScheduleRosterView.open-shift.test.jsx`
Expected: FAIL, `Failed to resolve import "@/components/StudioOverviewStrip"` (the moved test) and `Failed to resolve import "./StudioOverviewStrip"` (from `ScheduleRosterView.jsx`).

- [ ] **Step 3: Fix the two import paths, nothing else**

`src/components/schedule/StudioOverviewDialog.test.jsx`, replace:

```jsx
import StudioOverviewStrip from '@/components/StudioOverviewStrip'
```
with:
```jsx
import StudioOverviewStrip from '@/components/schedule/StudioOverviewDialog'
```

`src/components/ScheduleRosterView.jsx:10`, replace:

```jsx
import StudioOverviewStrip from './StudioOverviewStrip'
```
with:
```jsx
import StudioOverviewStrip from './schedule/StudioOverviewDialog'
```

Then confirm nothing else imports the old path:

```bash
grep -rn "StudioOverviewStrip'" src mobile shared tests e2e --include='*.js' --include='*.jsx' | grep -v "schedule/StudioOverviewDialog"
```
Expected: no output.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/schedule/StudioOverviewDialog.test.jsx src/components/ScheduleRosterView.open-shift.test.jsx`
Expected: PASS, unchanged counts (the strip still renders; only its address moved).

- [ ] **Step 5: Commit**

```bash
git add -A src/components/StudioOverviewStrip.jsx src/components/StudioOverviewStrip.test.jsx src/components/schedule/StudioOverviewDialog.jsx src/components/schedule/StudioOverviewDialog.test.jsx src/components/ScheduleRosterView.jsx
git commit -m "ROSTERLOOK.1 — move StudioOverviewStrip to schedule/StudioOverviewDialog (verbatim, no behaviour change)"
```

---

### Task 11: The strip goes; the dialog becomes controlled (`openDate` / `onClose`)

**Files:**
- Modify: `src/components/schedule/StudioOverviewDialog.jsx` (line numbers below are the moved file's, identical to the old `StudioOverviewStrip.jsx`)
- Rewrite: `src/components/schedule/StudioOverviewDialog.test.jsx`
- Modify: `src/components/ScheduleRosterView.jsx` (keep it compiling; the real wiring is Task 12)

What is kept, untouched: the fetch effect and its `dataVersion` refetch (`:62-83`), the whole day-detail body with its demand data (supply/demand headline, undermanned shifts, Events, Bookable today, Staffing, on leave: `:229-340`), `UnderMinRow`, `DetailSection`, `Muted`, `STATUS_STYLES`, `KIND_LABELS`, `fmtTime`, and the Modal primitive with its focus handling (CAL-UI-LOW.2). What goes: the `<section>` strip with its "Studio overview" heading and "7 days, 2 flagged" pill (`:104-135`), `DayCard` (`:139-206`), the internal `openDate` state (`:60`), and the two out-of-dialog status lines (`:86-99`), which now render INSIDE the dialog because there is no strip left to hold them.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `src/components/schedule/StudioOverviewDialog.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 — the Studio Overview is a DIALOG now, opened from a day header
// in the calendar; the strip of seven tiles above the calendar is gone.
// CAL-UI-LOW.2's two guarantees carry over and are re-proved here against an
// opener the test owns: (1) it is on the Modal primitive (focus in, Tab
// trapped, Escape/close return focus to the opener), (2) an undermanned row is
// a control that reports (date, block id) upward.
//
// 🔴 Focus and activation are things jsdom answers honestly. LAYOUT is not
// (memory `jsdom-cannot-see-layout`): nothing here says the dialog fits a phone.

import { useState } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, within } from '@testing-library/react'

import StudioOverviewDialog from '@/components/schedule/StudioOverviewDialog'

const RANGE = { from: '2026-09-21', to: '2026-09-27' }
const LOCATION = 'a0000000-0000-0000-0000-000000000001'

const DAY = {
  date: '2026-09-22',
  events: [{ id: 'e1', name: 'Hyrox Simulation', kind: 'race', start_time: '10:00:00', staff_required: 3 }],
  event_types: [{ id: 'et1', name: 'Consultation', window_start: '12:00:00', window_end: '14:00:00', staff_required: 1 }],
  time_off: ['Coach C'],
  staff_scheduled: 1,
  staff_on_leave: 1,
  demand: 4,
  classification: 'amber',
  under_min_blocks: [
    { id: 'blk-early', label: 'Early', time: '06:30–09:00', assigned: 1, min: 2 },
    { id: 'blk-late', label: 'Evening', time: '17:00–20:00', assigned: 0, min: 1 },
  ],
}

function mockOverview(response) {
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(response) }))
}
const okResponse = { success: true, data: { from: RANGE.from, to: RANGE.to, days: [DAY] } }

// The opener stands in for the calendar's day header: focus has to come BACK
// to it, so the test has to own it.
function Harness({ date = DAY.date, ...props }) {
  const [openDate, setOpenDate] = useState(null)
  return (
    <>
      <button type="button" onClick={() => setOpenDate(date)}>open day</button>
      <StudioOverviewDialog range={RANGE} locationId={LOCATION} openDate={openDate} onClose={() => setOpenDate(null)} {...props} />
    </>
  )
}

async function renderHarness(props = {}, response = okResponse) {
  mockOverview(response)
  await act(async () => { render(<Harness {...props} />) })
  return screen.getByRole('button', { name: 'open day' })
}
function openFrom(opener) {
  opener.focus()
  fireEvent.click(opener)
  return screen.getByRole('dialog')
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => { vi.restoreAllMocks() })

describe('the strip is gone (ROSTERLOOK.1)', () => {
  it('renders nothing at all while closed, but has already fetched the range', async () => {
    await renderHarness()
    expect(screen.queryByText(/Studio overview/i)).toBeNull()
    expect(screen.queryByText(/flagged/)).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1) // only the test's opener
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(String(global.fetch.mock.calls[0][0])).toContain(`from=${RANGE.from}&to=${RANGE.to}&location_id=${LOCATION}`)
  })
})

describe('day dialog focus handling (CAL-UI-LOW.2, carried over)', () => {
  it('moves focus into the dialog when it opens', async () => {
    const dialog = openFrom(await renderHarness())
    expect(document.activeElement).toBe(dialog)
  })

  it('traps Tab inside the dialog', async () => {
    const dialog = openFrom(await renderHarness({ onOpenShift: () => {} }))
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
    const controls = within(dialog).getAllByRole('button')
    controls[controls.length - 1].focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('Escape closes it and focus returns to the opener', async () => {
    const opener = await renderHarness()
    openFrom(opener)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('the close button closes it and focus returns to the opener', async () => {
    const opener = await renderHarness()
    openFrom(opener)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})

describe('the demand data the strip showed lives in the dialog', () => {
  it('names the day, the supply-vs-demand headline, events, bookable types and who is on leave', async () => {
    const dialog = openFrom(await renderHarness())
    expect(dialog.textContent).toMatch(/Tuesday,? 22 September 2026/)
    expect(dialog.textContent).toMatch(/Undermanned/)
    expect(dialog.textContent).toMatch(/Supply 0 \/ Demand 4/)
    expect(within(dialog).getByText('Hyrox Simulation')).toBeTruthy()
    expect(dialog.textContent).toMatch(/needs 3/)
    expect(within(dialog).getByText('Consultation')).toBeTruthy()
    expect(dialog.textContent).toMatch(/12:00–14:00/)
    expect(within(dialog).getByText('Coach C')).toBeTruthy()
  })
})

describe('undermanned rows open the shift they name (CAL-UI-LOW.2, carried over)', () => {
  it('reports the date and block id upward, and closes the summary', async () => {
    const onOpenShift = vi.fn()
    openFrom(await renderHarness({ onOpenShift }))
    const rows = screen.getAllByTestId('under-min-shift')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toMatch(/Early/)
    expect(rows[0].textContent).toMatch(/1 of 2 assigned/)
    fireEvent.click(rows[1])
    expect(onOpenShift).toHaveBeenCalledTimes(1)
    expect(onOpenShift).toHaveBeenCalledWith('2026-09-22', 'blk-late')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the rows as plain text when there is nowhere to send the request', async () => {
    const dialog = openFrom(await renderHarness({ onOpenShift: undefined }))
    expect(screen.queryAllByTestId('under-min-shift')).toHaveLength(0)
    expect(within(dialog).getByText('Early')).toBeTruthy()
  })
})

describe('states the strip used to show above the calendar now show in the dialog', () => {
  it('a failed overview says so inside the dialog, not nowhere', async () => {
    const opener = await renderHarness({}, { success: false, error: 'Forbidden' })
    const dialog = openFrom(opener)
    expect(dialog.textContent).toMatch(/Overview: Forbidden/)
  })

  it('a day the overview did not return says so', async () => {
    const dialog = openFrom(await renderHarness({ date: '2026-09-25' }))
    expect(dialog.textContent).toMatch(/No overview for this day/)
  })

  it('opened before the overview has answered: a loading line, then nothing to wait for', async () => {
    // A fetch that never resolves: the state under test IS "still loading".
    global.fetch = vi.fn(() => new Promise(() => {}))
    await act(async () => { render(<Harness />) })
    const dialog = openFrom(screen.getByRole('button', { name: 'open day' }))
    expect(dialog.textContent).toMatch(/Loading overview/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/schedule/StudioOverviewDialog.test.jsx`
Expected: FAIL. First failure: `renders nothing at all while closed`, `expected <h3>Studio overview</h3> to be null` (the strip still renders); the focus tests fail with `Unable to find role="dialog"` because the component ignores `openDate`.

- [ ] **Step 3: Implement**

In `src/components/schedule/StudioOverviewDialog.jsx`:

(a) Replace the header comment (`:3-16`) with:

```jsx
// StudioOverviewDialog — the per-day demand-vs-supply breakdown (mig 125),
// opened from a day header in the roster calendar.
//
// ROSTERLOOK.1 — this file was StudioOverviewStrip: a row of seven day tiles
// ABOVE the calendar, each opening this dialog. The tiles are gone (their
// status moved into the calendar's own day headers, see schedule/DayHeader);
// the dialog, its data and its focus handling are what they were. It is
// CONTROLLED now: the parent says which day is open (`openDate`) because the
// thing that opens it lives in a sibling component.
//
// It still fetches /api/schedule/overview whenever the calendar's range or
// `dataVersion` changes, open or not, so a click on a header opens onto data
// that is already there. Same request count as the strip.
//
// Almost all of it is informational (edit events at /events, booking types at
// /bookings/event-types). The ONE exception is the undermanned-shift rows:
// since CAL-UI-LOW.2 each opens that shift in the calendar, via `onOpenShift`.
```

(b) The lucide import (`:19`) is UNCHANGED: all eight icons are still used, by the dialog body (`Calendar`, `Flag`, `Palmtree`, `Users`, `Clock`, `UserX`) or by the two status lines that moved inside the dialog (`AlertCircle`, `Loader2`). The `Modal` import (`:20`) is unchanged too.

(c) Replace the default export (`:56-137`, from `export default function StudioOverviewStrip(` through its closing `}`) with:

```jsx
export default function StudioOverviewDialog({ range, locationId, dataVersion = 0, openDate, onClose, onOpenShift }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!range?.from || !range?.to || !locationId) return
    let cancelled = false
    setError(null)
    const url = `/api/schedule/overview?from=${range.from}&to=${range.to}&location_id=${locationId}`
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (!j.success) {
          setError(j.error || 'Failed to load overview')
          setData(null)
        } else {
          setData(j.data)
        }
      })
      .catch((e) => { if (!cancelled) setError(e.message || 'Network error') })
    return () => { cancelled = true }
  }, [range?.from, range?.to, locationId, dataVersion])

  if (!openDate) return null

  const day = (data?.days || []).find((d) => d.date === openDate) || null
  const longDate = new Date(openDate + 'T00:00:00').toLocaleDateString('en-IE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  return (
    <Modal open onClose={onClose} title={longDate} size="md">
      {error ? (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle size={12} aria-hidden="true" /> Overview: {error}
        </div>
      ) : !data ? (
        <div className="text-xs text-un1t-subtle inline-flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Loading overview…
        </div>
      ) : !day ? (
        <Muted>No overview for this day.</Muted>
      ) : (
        <DayDetailBody
          day={day}
          onOpenShift={onOpenShift && ((blockId) => {
            // Close the summary first: the operator asked for the shift, and
            // leaving this dialog stacked over the calendar's own block dialog
            // would bury the thing they came for.
            onClose()
            onOpenShift(day.date, blockId)
          })}
        />
      )}
    </Modal>
  )
}
```

(The `loading` state is gone with the strip's spinner: `!data` is the loading state now, and a refetch keeps the previous `data` on screen exactly as it did before.)

(d) Delete `DayCard` entirely (`:139-206`, from `function DayCard({ day, onClick }) {` through its closing `}`).

(e) Turn `DayDetailModal` (`:217-343`) into the body only. Replace its first lines:

```jsx
function DayDetailModal({ day, onClose, onOpenShift }) {
  const dt = new Date(day.date + 'T00:00:00')
  const longDate = dt.toLocaleDateString('en-IE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
  const status = STATUS_STYLES[day.classification] || STATUS_STYLES.green
  const supply = Math.max(0, day.staff_scheduled - day.staff_on_leave)

  return (
    <Modal open onClose={onClose} title={longDate} size="md">
      <div>
```

with:

```jsx
function DayDetailBody({ day, onOpenShift }) {
  const status = STATUS_STYLES[day.classification] || STATUS_STYLES.green
  const supply = Math.max(0, day.staff_scheduled - day.staff_on_leave)

  return (
      <div>
```

and its last lines:

```jsx
      </div>
    </Modal>
  )
}
```

with:

```jsx
      </div>
  )
}
```

Everything between (the headline, the five `DetailSection`s, the footer note) is untouched. Update the comment above it (`:208-216`) by replacing "focus returns to the day card that opened it" with "focus returns to the day header that opened it".

(f) Keep `ScheduleRosterView.jsx` compiling until Task 12 rewires it: the import is a default import, so only the JSX tag's props matter. In `src/components/ScheduleRosterView.jsx:59-66` add two props so nothing opens yet:

```jsx
        <StudioOverviewStrip
          range={scheduleRange}
          locationId={user.activeLocation.id}
          dataVersion={scheduleDataVersion}
          onOpenShift={openShift}
          openDate={null}
          onClose={() => {}}
        />
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/schedule/StudioOverviewDialog.test.jsx`
Expected: PASS, 12 tests.

Run: `npx eslint src/components/schedule/StudioOverviewDialog.jsx`
Expected: clean (an unused-import report here means an icon the strip alone used; remove exactly what it names).

`src/components/ScheduleRosterView.open-shift.test.jsx` is EXPECTED to fail between this commit and the next (it clicks a strip tile that no longer exists). Do not push between Task 11 and Task 12.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/StudioOverviewDialog.jsx src/components/schedule/StudioOverviewDialog.test.jsx src/components/ScheduleRosterView.jsx
git commit -m "ROSTERLOOK.1 — Studio Overview strip deleted; the day dialog is controlled and keeps every demand figure"
```

---

### Task 12: Day headers carry the status and open the dialog

**Files:**
- Modify: `src/components/ScheduleCalendar.jsx` — signature (`:148`), week day header (`:1415-1431`, anchor: `const headerCls = isToday`)
- Modify: `src/components/ScheduleRosterView.jsx` (`:8-10`, `:56-76`)
- Modify: `src/components/ScheduleRosterView.open-shift.test.jsx`
- Modify: `src/components/ScheduleCalendar.visibility.test.jsx` (append one describe)

**Where the state lives, and why there:** `ScheduleRosterView` already owns the overview's inputs (`scheduleRange`, `scheduleDataVersion`) and the `openShift` relay to the calendar (CAL-UI-LOW.2). It gains one more piece of state, `overviewDate`, renders the dialog, and hands the calendar ONE new optional prop, `onOpenDayOverview(dateStr)`. `onRangeChange`, `onDataChange`, `focusShift` and the deferred-open machinery in the calendar (`:642-705`) are untouched, which keeps this PR out of the mutation code 01 and 03 edit.

**The header's status uses ALL of the day's blocks, not the "My shifts" filter** (`blocks.filter(...)`, not `blocksByDay[i]`): it is the studio's day, the same population the week banner counts (`countStaffingGaps(blocks, …)`, `:545`).

- [ ] **Step 1: Write the failing tests**

(a) `src/components/ScheduleRosterView.open-shift.test.jsx`. Add `ScheduleCalendar` to the imports (under the `ScheduleRosterView` import):

```jsx
import ScheduleCalendar from '@/components/ScheduleCalendar'
```

Add this helper above `afterEach`:

```jsx
// ROSTERLOOK.1 — the overview opens from the calendar's own day header now.
// The header is named by the same en-IE long date the calendar prints.
function dayHeader(dateIso) {
  const label = new Date(`${dateIso}T00:00:00`).toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })
  return screen.getByRole('button', { name: new RegExp(`^${label}\\..*Open studio overview$`) })
}
```

In `renderView`, delete the line that waits for the strip's spinner (there is no strip):

```jsx
  await waitFor(() => expect(screen.queryByText(/Loading overview/)).toBeNull())
```

Replace the three tests inside `describe('Studio Overview → the shift it names (CAL-UI-LOW.2)', …)` with:

```jsx
  it('a day header opens the overview, and a row in it opens that shift', async () => {
    // The only case an operator can reach: the header IS a day on screen, so
    // the block is already in the calendar's rows.
    await renderView({ near: true })

    const header = dayHeader(NEAR_DATE)
    header.focus()
    fireEvent.click(header)
    const summary = screen.getByRole('dialog')
    expect(summary.textContent).toMatch(/0 of 2 assigned/)

    await act(async () => {
      fireEvent.click(screen.getByTestId('under-min-shift'))
    })

    await waitFor(() => {
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toMatch(/Morning/)
      expect(dialog.textContent).toMatch(/6:30am\s*–\s*9am/)
    })
    // The day summary is gone rather than stacked behind it.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('the header says the day is short before anyone opens anything', async () => {
    await renderView({ near: true })
    expect(dayHeader(NEAR_DATE).getAttribute('aria-label')).toMatch(/1 shift needs coaches: 1 with no coach/)
  })

  // The two cases below drive the calendar's `focusShift` prop directly. No
  // day header can ask for a shift in a week that is not on screen, so the UI
  // no longer reaches this path; the machinery is kept (see "Not in this PR")
  // and these keep it honest while it exists.
  it('focusShift for a far week: navigates the calendar and opens that shift once it has loaded', async () => {
    global.fetch = mockFetch()
    const view = render(<ScheduleCalendar user={MANAGER} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())

    await act(async () => {
      view.rerender(<ScheduleCalendar user={MANAGER} focusShift={{ date: FAR_DATE, blockId: BLOCK.id, seq: 1 }} />)
    })

    await waitFor(() => {
      expect(replace.mock.calls.some(([href]) => String(href).includes(`week=${FAR_MONDAY}`))).toBe(true)
    })
    await waitFor(() => {
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toMatch(/Evening/)
      expect(dialog.textContent).toMatch(/5pm\s*–\s*8pm/)
    })
  })

  it('focusShift for a shift that has gone: says so instead of doing nothing', async () => {
    global.fetch = mockFetch({ blocksGone: true })
    const view = render(<ScheduleCalendar user={MANAGER} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())

    await act(async () => {
      view.rerender(<ScheduleCalendar user={MANAGER} focusShift={{ date: FAR_DATE, blockId: BLOCK.id, seq: 1 }} />)
    })

    await waitFor(() => {
      expect(screen.getByText(/no longer on the roster/i)).toBeTruthy()
    })
  })
```

Rename the describe to `'Studio Overview, from a day header → the shift it names (CAL-UI-LOW.2 / ROSTERLOOK.1)'` and update the file's header comment: replace "a row in the Studio Overview day dialog opens THAT shift in the calendar below it" with "a day header opens the Studio Overview dialog, and a row in it opens THAT shift", and "strip → ScheduleRosterView → calendar" with "calendar header → ScheduleRosterView → dialog → ScheduleRosterView → calendar".

(b) Append to `src/components/ScheduleCalendar.visibility.test.jsx`:

```jsx
describe('day headers carry the staffing status (ROSTERLOOK.1)', () => {
  const longDay = new Date(`${BLOCK_DATE}T00:00:00`).toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })

  it('a manager sees one status per day with future shifts, in words as well as colour', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    const dots = screen.getAllByTestId('status-dot')
    expect(dots).toHaveLength(1) // every fixture sits on BLOCK_DATE
    expect(dots[0].getAttribute('data-tone')).toBe('empty')
    expect(dots[0].textContent).toMatch(/2 short/)
    expect(dots[0].textContent).toMatch(/2 shifts need coaches: 1 with no coach, 1 below the minimum/)
  })

  it('without somewhere to open, the header is not a button (the calendar rendered alone)', async () => {
    await renderCalendar({ blocks: [OK_BLOCK] })
    expect(screen.queryByRole('button', { name: /Open studio overview/ })).toBeNull()
    expect(screen.getAllByTestId('day-header')).toHaveLength(7)
  })

  it('given onOpenDayOverview, the header reports its own date', async () => {
    const onOpenDayOverview = vi.fn()
    global.fetch = mockFetch({ blocks: [OK_BLOCK] })
    await act(async () => { render(<ScheduleCalendar user={MANAGER} onOpenDayOverview={onOpenDayOverview} />) })
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${longDay}\\.`) }))
    expect(onOpenDayOverview).toHaveBeenCalledWith(BLOCK_DATE)
  })

  it('a coach sees no status and no clickable header, even when handed the prop', async () => {
    global.fetch = mockFetch({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    await act(async () => { render(<ScheduleCalendar user={COACH} onOpenDayOverview={() => {}} />) })
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(screen.queryByTestId('status-dot')).toBeNull()
    expect(screen.queryByRole('button', { name: /Open studio overview/ })).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/ScheduleRosterView.open-shift.test.jsx src/components/ScheduleCalendar.visibility.test.jsx`
Expected: FAIL. open-shift: `Unable to find an accessible element with the role "button" and name /^… Open studio overview$/`. visibility: `Unable to find an element by: [data-testid="status-dot"]`.

- [ ] **Step 3: Implement**

(a) `src/components/ScheduleCalendar.jsx:148`. Replace:

```jsx
export default function ScheduleCalendar({ user, onRangeChange, onDataChange, focusShift }) {
```
with:
```jsx
// ROSTERLOOK.1 — `onOpenDayOverview(dateStr)`: a manager's day header asks the
// parent to open the Studio Overview for that day. Optional: rendered alone
// (every test but one) the headers are plain, not dead buttons.
export default function ScheduleCalendar({ user, onRangeChange, onDataChange, focusShift, onOpenDayOverview }) {
```

Add to the `./schedule/` imports and extend the Task 8 model import:

```jsx
import DayHeader from './schedule/DayHeader'
import { rosterToolbarModel, dayHeaderStatus } from '@/lib/roster-card-model'
```

(b) In the week view, replace `:1415-1431` (from `const headerCls = isToday` through the header `</div>` that closes after the `{holiday && (…)}` block). Existing:

```jsx
              const headerCls = isToday
                ? 'bg-blue-600 text-white'
                : holiday
                  ? 'bg-amber-500/15 text-amber-700 border border-amber-500/30'
                  : 'bg-un1t-surface text-un1t-subtle'

              return (
                <div key={i} className="min-h-[200px]">
                  <div className={`text-center py-2 rounded-t-lg text-xs font-semibold ${headerCls}`} title={holiday?.name || undefined}>
                    <div>{label}</div>
                    <div className={`text-lg font-bold ${isToday ? 'text-white' : 'text-un1t-text'}`}>{date.getDate()}</div>
                    {holiday && (
                      <div className={`mt-0.5 text-[10px] font-medium leading-tight px-1 truncate ${isToday ? 'text-white/80' : 'text-amber-700'}`}>
                        {holiday.source === 'national' ? '🇮🇪 ' : '🏷 '}{holiday.name}
                      </div>
                    )}
                  </div>
```

Replacement:

```jsx
              // ROSTERLOOK.1 — the Studio Overview strip, folded into the
              // header. The status is the STUDIO's day (all blocks, whatever
              // the My shifts filter shows), manager-only, and answers from the
              // same futureBlockStaffing the cards and the banner use.
              const dayStatus = isManager
                ? dayHeaderStatus(blocks.filter((b) => b.block_date === dateStr), { todayIso: todayStr })
                : null

              return (
                <div key={i} className="min-h-[200px]">
                  <DayHeader
                    label={label}
                    dayNumber={date.getDate()}
                    fullDate={cardDayLabel}
                    isToday={isToday}
                    holiday={holiday}
                    status={dayStatus}
                    onOpen={isManager && onOpenDayOverview ? () => onOpenDayOverview(dateStr) : undefined}
                  />
```

(`cardDayLabel` is already computed just above, `:1413`. The header's three looks moved into `DayHeader` unchanged.)

(c) `src/components/ScheduleRosterView.jsx`. Replace `:8-10`:

```jsx
import { useState, useCallback, useRef } from 'react'
import ScheduleCalendar from './ScheduleCalendar'
import StudioOverviewStrip from './schedule/StudioOverviewDialog'
```
with:
```jsx
import { useState, useCallback, useRef } from 'react'
import ScheduleCalendar from './ScheduleCalendar'
import StudioOverviewDialog from './schedule/StudioOverviewDialog'
```

Replace the `return (…)` (`:56-76`, including the Task 11 stop-gap props) with:

```jsx
  // ROSTERLOOK.1 — which day's Studio Overview is open. The strip of tiles
  // that used to open it is gone; the calendar's day headers ask for it
  // through onOpenDayOverview, and the dialog is rendered here because this
  // component already owns everything it needs (the range, the data version,
  // and the openShift relay back into the calendar).
  const [overviewDate, setOverviewDate] = useState(null)
  const showOverview = isManager && !!user.activeLocation?.id

  return (
    <>
      <ScheduleCalendar
        user={user}
        onRangeChange={setScheduleRange}
        onDataChange={bumpDataVersion}
        focusShift={shiftFocus}
        onOpenDayOverview={showOverview ? setOverviewDate : undefined}
      />
      {/* Studio overview — demand-vs-supply for one day (mig 125), opened
          from that day's header. Manager only, as the strip was. */}
      {showOverview && (
        <StudioOverviewDialog
          range={scheduleRange}
          locationId={user.activeLocation.id}
          dataVersion={scheduleDataVersion}
          openDate={overviewDate}
          onClose={() => setOverviewDate(null)}
          onOpenShift={openShift}
        />
      )}
    </>
  )
```

Also update the two comments above that still say "strip": at `:19-22` replace "so the strip above can re-fetch its per-day demand summary in sync" with "so the Studio Overview dialog can fetch its per-day demand summary for the same range"; at `:41-45` replace "a shift the overview strip names" with "a shift the overview dialog names" and "The strip knows the block id" with "The dialog knows the block id".

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/ScheduleRosterView.open-shift.test.jsx src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.a11y.test.jsx`
Expected: PASS. (`a11y` is here for its "no button whose only name is its markup" sweep: the calendar is rendered alone there, so the headers are `<div>`s and add no buttons.)

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleCalendar.jsx src/components/ScheduleRosterView.jsx src/components/ScheduleRosterView.open-shift.test.jsx src/components/ScheduleCalendar.visibility.test.jsx
git commit -m "ROSTERLOOK.1 — Studio Overview folded into the day headers: status dot + count, click opens the day dialog"
```

---

### Task 13: `ShiftCard` (neutral surface; time, coaches, template)

**Files:**
- Create: `src/components/schedule/ShiftCard.jsx`
- Create: `src/components/schedule/ShiftCard.test.jsx`

Card anatomy, top to bottom: the time range on one line (`whitespace-nowrap`, `tabular-nums`); coach names at body size (`text-sm`, the app's body size; the card itself stays `text-xs`), one per line, each truncating with a `title`; OR "Needs coach" / the neutral empty text; the "1 of 2" badge ONLY when short; the full template name as a small muted label with a `title`. The muted label is `text-un1t-subtle` (#64748B, 4.8:1 on white), NOT `text-un1t-muted` (#94A3B8, 2.6:1): it is small text and must still be readable. Surface: `bg-un1t-bg` with a `border-un1t-border` hairline on the column's `bg-un1t-surface/50`. Colour appears only as status: amber border + "1 of 2"; red DASHED border + "Needs coach" (dashed so the two survive greyscale and red/green deficiency, the ROSTER-FIX.6b rule).

The ROSTER-FIX.6b-7 structure is kept exactly: the card is a plain container, the click target is a real `<button>` stretched over it with a short name of its own ("Manage 9am Morning shift, Monday 4 May"), `aria-pressed` only in select mode, and the hover hint is `aria-hidden`.

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/schedule/ShiftCard.test.jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 — the week card's structure: what it says, in what order, and
// what it never says. 🔴 Not its layout: whether "11:30am–12:30pm" FITS on one
// line is a browser check (memory `jsdom-cannot-see-layout`); this file can
// only pin the class that asks for it.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import ShiftCard from '@/components/schedule/ShiftCard'
import { shiftCardModel } from '@/lib/roster-card-model'

afterEach(() => cleanup())

const BLOCK = {
  id: 'b1', block_date: '2026-09-21', start_time: '09:15', end_time: '10:30', max_coaches: 17, min_coaches: 2,
  shift_templates: { name: 'Morning 8 Week Challenge - Strength', color: '#EC4899' },
}
const on = (id, name, over = {}) => ({ id: `a-${id}`, profile_id: id, status: 'confirmed', profiles: { full_name: name }, ...over })
const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

function renderCard({ assignments = [on('u2', 'Coach A'), on('u3', 'Coach B')], staffing = { status: 'ok', count: 2, min: 2 }, isManager = true, viewerId = 'u9', ...props } = {}) {
  const model = shiftCardModel(BLOCK, assignments, staffing, { isManager, viewerId })
  const onActivate = vi.fn()
  render(<ShiftCard model={model} dayLabel="Monday 21 September" onActivate={onActivate} {...props} />)
  return { onActivate, card: screen.getByTestId('shift-card') }
}

describe('ShiftCard', () => {
  it('reads time, then coaches, then the template name', () => {
    renderCard()
    const time = screen.getByTestId('shift-time')
    const coaches = screen.getByTestId('shift-coaches')
    const template = screen.getByTestId('shift-template')
    expect(follows(time, coaches)).toBe(true)
    expect(follows(coaches, template)).toBe(true)
    expect(time.textContent).toBe('9:15–10:30am')
    expect(time.className).toMatch(/whitespace-nowrap/)
  })

  it('coach names are body size, one per line, and the template label is the small one', () => {
    renderCard()
    const items = screen.getByTestId('shift-coaches').querySelectorAll('li')
    expect(Array.from(items).map((li) => li.textContent)).toEqual(['Coach A', 'Coach B'])
    for (const li of items) expect(li.className).toMatch(/\btext-sm\b/)
    expect(screen.getByTestId('shift-template').className).toMatch(/text-\[11px\]/)
  })

  it('shows the FULL template name and repeats it as a title for when it truncates', () => {
    renderCard()
    const template = screen.getByTestId('shift-template')
    expect(template.textContent).toBe('Morning 8 Week Challenge - Strength')
    expect(template.getAttribute('title')).toBe('Morning 8 Week Challenge - Strength')
  })

  it('is neutral: no inline colour, no template tint, the tone is data', () => {
    const { card } = renderCard()
    expect(card.getAttribute('style')).toBeNull()
    expect(card.innerHTML).not.toMatch(/#EC4899|background-color/i)
    expect(card.getAttribute('data-tone')).toBe('neutral')
    expect(card.className).toMatch(/\bbg-un1t-bg\b/)
    expect(card.className).toMatch(/\bborder-un1t-border\b/)
  })

  it('an unknown tone falls back to the neutral surface rather than none', () => {
    const model = { ...shiftCardModel(BLOCK, [], null, { isManager: true }), tone: 'not-a-tone' }
    render(<ShiftCard model={model} dayLabel="Monday 21 September" onActivate={() => {}} />)
    expect(screen.getByTestId('shift-card').className).toMatch(/\bbg-un1t-bg\b/)
  })

  it('never prints a capacity chip', () => {
    const { card } = renderCard()
    expect(card.textContent).not.toMatch(/\d+\s*\/\s*\d+/)
    expect(card.textContent).not.toMatch(/17/)
  })

  it('short: amber border and "1 of 2", said in words too', () => {
    const { card } = renderCard({ assignments: [on('u2', 'Coach A')], staffing: { status: 'short', count: 1, min: 2 } })
    expect(card.getAttribute('data-status')).toBe('short')
    expect(card.className).toMatch(/border-amber-500\/60/)
    const badge = screen.getByTestId('short-staffed-badge')
    expect(badge.textContent).toBe('Below minimum: 1 of 2')
    expect(badge.getAttribute('title')).toBe('Below minimum: 1 of 2 coaches')
  })

  it('empty: red DASHED border and "Needs coach" as real text', () => {
    const { card } = renderCard({ assignments: [], staffing: { status: 'empty', count: 0, min: 1 } })
    expect(card.getAttribute('data-status')).toBe('empty')
    expect(card.className).toMatch(/border-dashed/)
    expect(card.className).toMatch(/border-red-500\/60/)
    expect(screen.getByTestId('needs-coach-badge').textContent).toBe('Needs coach')
    expect(screen.queryByTestId('shift-coaches')).toBeNull()
  })

  it('a past empty shift is history, not an alarm', () => {
    const { card } = renderCard({ assignments: [], staffing: null })
    expect(card.getAttribute('data-status')).toBe('ok')
    expect(card.className).not.toMatch(/border-red|border-amber/)
    expect(screen.getByText('No coach (past)')).toBeTruthy()
  })

  it('keeps the Adjusted marker: a visible word, and the hours for a screen reader', () => {
    renderCard({ assignments: [on('u2', 'Coach A', { start_time_override: '09:30', partial_reason: 'late start' })] })
    const marker = screen.getByTestId('adjusted-marker')
    expect(marker.getAttribute('title')).toBe('Adjusted: 9:30am–10:30am · late start')
    expect(marker.querySelector('[aria-hidden="true"]').textContent).toBe('Adjusted')
    expect(screen.getByText(/Adjusted hours: 9:30am to 10:30am\. late start/)).toBeTruthy()
  })

  it('the click target is a real button over a plain container, named by shift and day', () => {
    const { onActivate, card } = renderCard()
    const button = screen.getByRole('button', { name: 'Manage 9:15am Morning 8 Week Challenge - Strength shift, Monday 21 September' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.parentElement).toBe(card)
    expect(card.getAttribute('role')).toBeNull()
    expect(card.getAttribute('tabindex')).toBeNull()
    expect(button.getAttribute('aria-pressed')).toBeNull()
    fireEvent.click(button)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('select mode: the button becomes a toggle and says Select', () => {
    renderCard({ selectMode: true, isSelected: true })
    const button = screen.getByRole('button', { name: /^Select 9:15am/ })
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('the hover hint is out of the accessibility tree, and only offered when there is something to manage', () => {
    renderCard({ showHint: true })
    expect(screen.getByText('Click to manage').getAttribute('aria-hidden')).toBe('true')
    cleanup()
    renderCard({ showHint: false })
    expect(screen.queryByText('Click to manage')).toBeNull()
  })

  // 🔴 The coach boundary, at component level.
  it('coach mode: no staffing badge, no status border, no numbers, even for a short block', () => {
    const { card } = renderCard({ isManager: false, viewerId: 'u2', assignments: [on('u2', 'Coach A')], staffing: { status: 'short', count: 1, min: 2 }, isMine: true })
    expect(screen.queryByTestId('short-staffed-badge')).toBeNull()
    expect(screen.queryByTestId('needs-coach-badge')).toBeNull()
    expect(card.getAttribute('data-status')).toBe('ok')
    expect(card.className).not.toMatch(/border-amber|border-red/)
    expect(card.textContent).not.toMatch(/\d+ of \d+|\d+\s*\/\s*\d+|17/)
    // Their own shift is still marked as theirs.
    expect(card.className).toMatch(/ring-blue-400\/50/)
    expect(screen.getByText('Coach A').className).toMatch(/text-blue-700/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/schedule/ShiftCard.test.jsx`
Expected: FAIL, `Failed to resolve import "@/components/schedule/ShiftCard"`.

- [ ] **Step 3: Implement**

```jsx
// src/components/schedule/ShiftCard.jsx
'use client'

// ROSTERLOOK.1 — one shift on the week view, drawn from shiftCardModel.
//
// NEUTRAL SURFACE. The card used to be filled with its template's colour at
// 12% alpha. Nearly every template is blue and the evening ones are pink-red,
// so the roster read as a wall of pastel with some cards apparently in error,
// and the amber/red that really does mean "needs a coach" had nothing to stand
// out against. Colour on this card now means staffing status and nothing else:
//   amber border + "1 of 2"            below the minimum
//   red DASHED border + "Needs coach"  nobody on it
// Dashed as well as red, so the two states differ in greyscale and for a
// red/green deficiency (ROSTER-FIX.6b). Both are manager-only, and that is
// enforced in the MODEL: a coach's model has `status: null`.
//
// TONE. `model.tone` comes from cardTone(), 'neutral' for every block today.
// Wave 2 adds 'admin' by returning it there and adding ONE line to
// TONE_SURFACE. The markup below does not change.
//
// CONTENT ORDER: time (one line) → who (body size) → what (small, muted, full
// name, with a title for when the column truncates it). The old order led with
// a template name truncated to "Morning 8…" and printed the coaches smallest.
//
// STRUCTURE (ROSTER-FIX.6b-7, kept): the card is a plain container; the click
// target is a real <button> stretched over it with a short name of its own, so
// the card's text stays separately browsable by a screen reader.

const TONE_SURFACE = {
  neutral: 'bg-un1t-bg',
}
const STATUS_BORDER = {
  short: 'border-amber-500/60',
  empty: 'border-dashed border-red-500/60',
}

export default function ShiftCard({ model, dayLabel, isMine = false, showHint = false, selectMode = false, isSelected = false, onActivate }) {
  const surface = TONE_SURFACE[model.tone] || TONE_SURFACE.neutral
  const border = model.status ? STATUS_BORDER[model.status.kind] : 'border-un1t-border'
  const cardLabel = `${model.shortLabel}, ${dayLabel}`

  return (
    <div
      data-testid="shift-card"
      data-tone={model.tone}
      data-status={model.status ? model.status.kind : 'ok'}
      className={`relative group rounded-md border p-2 text-xs ${surface} ${border} hover:ring-1 hover:ring-un1t-subtle/40 ${isMine ? 'ring-1 ring-blue-400/50' : ''} ${isSelected ? 'ring-2 ring-amber-400 ring-offset-1 ring-offset-un1t-bg' : ''}`}
    >
      <button
        type="button"
        aria-pressed={selectMode ? isSelected : undefined}
        onClick={onActivate}
        className="absolute inset-0 z-10 w-full rounded-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
      >
        <span className="sr-only">{selectMode ? `Select ${cardLabel}` : `Manage ${cardLabel}`}</span>
      </button>

      {/* Line 1 — the time, never wrapping. */}
      <div data-testid="shift-time" className="whitespace-nowrap font-semibold tabular-nums text-un1t-text">
        {model.timeLabel}
      </div>

      {/* Who — body size, one per line. */}
      {model.coaches.length > 0 && (
        <ul data-testid="shift-coaches" className="mt-1 space-y-0.5">
          {model.coaches.map((c) => (
            <li key={c.id} className="flex items-center gap-1 text-sm leading-snug">
              <span className={`truncate ${c.isMe ? 'text-blue-700 font-medium' : 'text-un1t-text'}`} title={c.name}>{c.name}</span>
              {c.adjusted && (
                <span
                  data-testid="adjusted-marker"
                  className="shrink-0 rounded bg-amber-500/10 px-1 text-[10px] font-medium text-amber-700"
                  title={c.adjusted.title}
                >
                  <span aria-hidden="true">Adjusted</span>
                  <span className="sr-only"> {c.adjusted.srLabel}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {model.emptyText && (
        <div className="mt-1 text-sm italic text-un1t-subtle">{model.emptyText}</div>
      )}

      {/* Staffing — only when something is wrong, only for a manager (the
          model decides both). */}
      {model.status?.kind === 'empty' && (
        <div
          data-testid="needs-coach-badge"
          className="mt-1 inline-flex items-center rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-700"
          title={model.status.title}
        >
          {model.status.label}
        </div>
      )}
      {model.status?.kind === 'short' && (
        <div
          data-testid="short-staffed-badge"
          className="mt-1 inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
          title={model.status.title}
        >
          <span className="sr-only">{model.status.srPrefix}</span>
          {model.status.label}
        </div>
      )}

      {/* What — small and muted, but the FULL name, with a title for when the
          column still truncates it. un1t-subtle, not un1t-muted: this is small
          text and #94A3B8 on white is 2.6:1. */}
      <div data-testid="shift-template" className="mt-1 truncate text-[11px] text-un1t-subtle" title={model.templateName}>
        {model.templateName}
      </div>

      {showHint && (
        <div aria-hidden="true" className="mt-1 text-[10px] text-un1t-muted italic text-right opacity-0 group-hover:opacity-100 transition-opacity">
          Click to manage
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/schedule/ShiftCard.test.jsx`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/ShiftCard.jsx src/components/schedule/ShiftCard.test.jsx
git commit -m "ROSTERLOOK.1 — ShiftCard: neutral surface; time, coaches, full template name; colour means staffing only"
```

---

### Task 14: Swap `ShiftCard` into the week view

**Files:**
- Modify: `src/components/ScheduleCalendar.jsx` — imports; week card `:1460-1631` (anchor: `{dayBlocks.map(block => {` through its closing `})}` just above `{/* Add ad-hoc block button (manager only) */}`)
- Modify: `src/components/ScheduleCalendar.visibility.test.jsx:101-110`
- Modify: `src/components/ScheduleCalendar.a11y.test.jsx:381-390`

- [ ] **Step 1: Write the failing tests**

(a) `src/components/ScheduleCalendar.visibility.test.jsx`. In `'a manager sees "1 of 2" on a short card, counting live coaches only'` replace the last two lines:

```jsx
    // The empty card keeps its own red treatment.
    expect(screen.getByText('Unstaffed — assign a coach')).toBeTruthy()
```
with:
```jsx
    // ROSTERLOOK.1 — the empty card says "Needs coach" and is the only one
    // flagged empty; the staffed card is flagged nothing.
    expect(screen.getAllByTestId('needs-coach-badge')).toHaveLength(1)
    const statuses = screen.getAllByTestId('shift-card').map((c) => c.getAttribute('data-status')).sort()
    expect(statuses).toEqual(['empty', 'ok', 'short'])
```

and add these tests to the same describe:

```jsx
  it('no card carries a capacity chip, and every card is neutral (ROSTERLOOK.1)', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    for (const card of screen.getAllByTestId('shift-card')) {
      expect(card.textContent).not.toMatch(/\d+\s*\/\s*\d+/)   // was "1/3" on every card
      expect(card.getAttribute('data-tone')).toBe('neutral')
      expect(card.getAttribute('style')).toBeNull()             // was the template colour at 12%
    }
  })

  it('a card reads time, then coach, then template (ROSTERLOOK.1)', async () => {
    await renderCalendar({ blocks: [OK_BLOCK] })
    const card = screen.getByTestId('shift-card')
    expect(within(card).getByTestId('shift-time').textContent).toBe('12–1pm')
    expect(within(card).getByText('Mike Byrne')).toBeTruthy()
    expect(within(card).getByTestId('shift-template').textContent).toBe('Lunch')
  })

  it('a coach sees the same cards with no status on them (ROSTERLOOK.1)', async () => {
    await renderCalendar({ user: COACH, blocks: [SHORT_BLOCK, OK_BLOCK] })
    const cards = screen.getAllByTestId('shift-card')
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(card.getAttribute('data-status')).toBe('ok')
      expect(card.textContent).not.toMatch(/\d+ of \d+|\d+\s*\/\s*\d+/)
    }
  })
```

(b) `src/components/ScheduleCalendar.a11y.test.jsx:381-390`. Replace the test `'says "Unstaffed" in text on the week card, not only in red'` with:

```jsx
  it('says an empty shift needs a coach in TEXT on the week card, not only in red', async () => {
    await renderCalendar()
    const eveningCard = cardButton('Evening').parentElement
    // ROSTERLOOK.1 — was a visually-hidden "Unstaffed." beside a glyph, because
    // the visible signal was a red wash. The visible signal is now the words
    // themselves, so there is nothing left for greyscale to lose.
    const badge = within(eveningCard).getByTestId('needs-coach-badge')
    expect(badge.textContent).toBe('Needs coach')
    expect(badge.className).not.toMatch(/sr-only/)
    expect(eveningCard.className).toMatch(/border-dashed/)
  })
```

and add `within` to that file's `@testing-library/react` import if it is not already there.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.a11y.test.jsx`
Expected: FAIL, `Unable to find an element by: [data-testid="needs-coach-badge"]` and `[data-testid="shift-card"]`.

- [ ] **Step 3: Implement**

(a) Imports in `src/components/ScheduleCalendar.jsx`:

```jsx
import ShiftCard from './schedule/ShiftCard'
import { rosterToolbarModel, dayHeaderStatus, shiftCardModel } from '@/lib/roster-card-model'
```

(b) Replace the whole `{dayBlocks.map(block => { … })}` expression (`:1460-1631`). It begins:

```jsx
                    {dayBlocks.map(block => {
                      const tmpl = block.shift_templates || {}
                      const assignments = liveAssignments(block.shift_assignments)
                      const count = assignments.length
                      const max = block.max_coaches || 15
```

and ends:

```jsx
                              Click to manage
                            </div>
                          )}
                        </div>
                      )
                    })}
```

Replacement (the whole thing):

```jsx
                    {/* ROSTERLOOK.1 — one ShiftCard per block. WHAT the card
                        says is shiftCardModel's decision (pure, tested in
                        src/lib/roster-card-model.test.js), including the coach
                        boundary: for a non-manager the model carries no
                        staffing status, and it reads max_coaches for nobody.
                        The historical notes on this card (ROSTER-FIX.2, .6b,
                        .6b-7, ROSTERVIS.1) moved into ShiftCard.jsx with the
                        markup they explain. */}
                    {dayBlocks.map((block) => {
                      const model = shiftCardModel(
                        block,
                        block.shift_assignments,
                        futureBlockStaffing(block, todayStr),
                        { isManager, viewerId: user.id },
                      )
                      const isMine = model.coaches.some((c) => c.isMe)
                      return (
                        <ShiftCard
                          key={block.id}
                          model={model}
                          dayLabel={cardDayLabel}
                          isMine={isMine}
                          showHint={isManager || isMine}
                          selectMode={selectMode}
                          isSelected={selectedBlockIds.has(block.id)}
                          onActivate={() => {
                            // BULK-ASSIGN.1 — in select mode, clicks toggle
                            // selection instead of opening the detail modal.
                            if (selectMode) toggleBlockSelection(block.id)
                            else setBlockDetail(block)
                          }}
                        />
                      )
                    })}
```

(c) Update the file's header comment, `:5-8`. Replace:

```jsx
// legacy flat /api/schedule/shifts. Each block renders as a single
// card showing template + time + capacity badge + assigned coaches.
// Empty future blocks get a red unstaffed flag; below-minimum ones an amber
// "1 of 2" (ROSTERVIS.1). The header says whether the period is published.
```
with:
```jsx
// legacy flat /api/schedule/shifts. Each block renders as a single
// NEUTRAL card: time, assigned coaches, template name (ROSTERLOOK.1; see
// schedule/ShiftCard). Colour means staffing only: empty future blocks get a
// red dashed "Needs coach", below-minimum ones an amber "1 of 2"
// (ROSTERVIS.1). The toolbar says whether the period is published.
```

and the `// ── WEEK VIEW ──` comment (`:1391-1396`), replacing "Each card shows the template colour + name + time + capacity badge + a list of assigned coaches (or an empty-state with a red flag for future unstaffed demand windows). Click opens the assign popover." with "Each card is a schedule/ShiftCard. Click opens the block-detail dialog."

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.a11y.test.jsx src/components/ScheduleCalendar.assign-conflicts.test.jsx src/components/ScheduleCalendar.week-cost.test.jsx src/components/ScheduleCalendar.publish-confirm.test.jsx src/components/ScheduleRosterView.open-shift.test.jsx`
Expected: PASS for all six. The a11y file's four `week-view block card (ROSTER-FIX.6b)` tests pass UNCHANGED: the button is still `Manage 9am Morning shift, <day>`, its parent is still a role-less container holding "Sarah Doyle" and "Adjusted hours", and the hint is still an `aria-hidden` div reading "Click to manage".

Then: `npx eslint src/components/ScheduleCalendar.jsx`
Expected: clean. `liveAssignments` is still used (`blocksByDay`, the month grid) and so is `formatTime` (the dialogs); if eslint names an unused local, delete exactly that.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.a11y.test.jsx
git commit -m "ROSTERLOOK.1 — week cards are ShiftCards: neutral, names first-class, no n/max chip"
```

---

### Task 15: `MonthCell` with coach names, swapped into the month grid

**Files:**
- Create: `src/components/schedule/MonthCell.jsx`
- Create: `src/components/schedule/MonthCell.test.jsx`
- Modify: `src/components/ScheduleCalendar.jsx` — delete `blockStaffingStatus` (`:118-132`), month cell (`:1270-1383`, anchor: `for (let i = 0; i < 42; i++) {` through `cells.push(…)`)
- Modify: `src/components/ScheduleCalendar.a11y.test.jsx:392-399`

The cell stays ONE `<button>` that drills into that week (so nothing interactive may sit inside it, and "+N more" stays text: the drill-down IS the expander, as today). The "!1" / "↓1" badges become the same `StatusDot` the week headers use.

- [ ] **Step 1: Write the failing tests**

```jsx
// src/components/schedule/MonthCell.test.jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 — a month cell names the coaches and speaks the same status
// language as the week headers. Text, titles and presence only (memory
// `jsdom-cannot-see-layout`).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import MonthCell from '@/components/schedule/MonthCell'

afterEach(() => cleanup())

const LINES = [
  { id: 'a', tone: 'ok', text: '5:45 Jonathan, James', title: 'HIIT · 5:45–6:45am · Jonathan First, James Second' },
  { id: 'b', tone: 'short', text: '6:45 Aoife (1 of 2)', title: 'HIIT · 6:45–7:45am · Aoife Third · Below minimum: 1 of 2 coaches' },
  { id: 'c', tone: 'empty', text: '5:45pm Needs coach', title: 'Evening · 5:45–6:45pm · No coach is assigned to this shift' },
]
const STATUS = { tone: 'empty', label: '2 short', srLabel: '2 shifts need coaches: 1 with no coach, 1 below the minimum', title: '2 shifts need coaches: 1 with no coach, 1 below the minimum' }
const base = { dayNumber: 22, inFocusedMonth: true, isToday: false, holiday: null, lines: LINES, more: 4, status: STATUS, assignmentCount: 3, timeOffEntry: null }

describe('MonthCell', () => {
  it('is one button that drills into its week', () => {
    const onOpen = vi.fn()
    render(<MonthCell {...base} onOpen={onOpen} />)
    const cell = screen.getByRole('button')
    expect(cell.getAttribute('type')).toBe('button')
    expect(cell.querySelector('button, a')).toBeNull() // nothing interactive nested inside it
    fireEvent.click(cell)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('each line reads time + first names, with the full story in its title', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    const lines = screen.getAllByTestId('month-line')
    expect(lines.map((l) => l.textContent)).toEqual(LINES.map((l) => l.text))
    expect(lines.map((l) => l.getAttribute('title'))).toEqual(LINES.map((l) => l.title))
  })

  it('status colour is on the unstaffed and short lines only, and the empty one is dashed', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    const [ok, short, empty] = screen.getAllByTestId('month-line')
    expect(ok.getAttribute('data-tone')).toBe('ok')
    expect(ok.className).not.toMatch(/amber|red/)
    expect(short.className).toMatch(/text-amber-700/)
    expect(empty.className).toMatch(/text-red-700/)
    expect(empty.className).toMatch(/border-dashed/)
  })

  it('no line is tinted by a template colour', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    for (const l of screen.getAllByTestId('month-line')) expect(l.getAttribute('style')).toBeNull()
  })

  it('"+N more" stays', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    expect(screen.getByText('+4 more')).toBeTruthy()
    cleanup()
    render(<MonthCell {...base} more={0} onOpen={() => {}} />)
    expect(screen.queryByText(/more$/)).toBeNull()
  })

  it('"!1" and "↓1" are gone: the status is the week headers\' dot, with words and a title', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    const cell = screen.getByRole('button')
    expect(cell.textContent).not.toMatch(/[!↓]\d/)
    const dot = screen.getByTestId('status-dot')
    expect(dot.getAttribute('data-tone')).toBe('empty')
    expect(dot.getAttribute('title')).toBe(STATUS.title)
    expect(dot.textContent).toContain('2 short')
    expect(dot.querySelector('.sr-only').textContent).toBe(STATUS.srLabel)
  })

  it('the bare assignment count says what it counts', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    const count = screen.getByTestId('month-assignment-count')
    expect(count.getAttribute('title')).toBe('3 coach assignments')
    expect(count.querySelector('.sr-only').textContent).toBe(' coach assignments')
  })

  it('coach: no status at all', () => {
    render(<MonthCell {...base} status={null} lines={[LINES[0]]} onOpen={() => {}} />)
    expect(screen.queryByTestId('status-dot')).toBeNull()
  })

  it('keeps the holiday name and the first time-off entry', () => {
    render(<MonthCell {...base} holiday={{ name: 'October Bank Holiday' }} timeOffEntry={{ text: 'Sarah Holiday', color: '#22C55E' }} onOpen={() => {}} />)
    expect(screen.getByText('October Bank Holiday').getAttribute('title')).toBe('October Bank Holiday')
    expect(screen.getByText('Sarah Holiday')).toBeTruthy()
  })
})
```

In `src/components/ScheduleCalendar.a11y.test.jsx` replace the test at `:392-399` (`'says "Unstaffed" on the month grid bar, where the only signal was a red hairline'`) with:

```jsx
  it('says it in text on the month grid too: the line, and the day\'s status', async () => {
    await renderCalendar()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Month' })) })

    // ROSTERLOOK.1 — the evening block's line. Was a red hairline plus a
    // visually-hidden "Unstaffed."; now the visible words carry it.
    const lines = screen.getAllByTestId('month-line').map((n) => n.textContent)
    expect(lines).toContain('5pm Needs coach')
    // The staffed block names its coach instead of printing "9am 1/3".
    expect(lines).toContain('9 Sarah')
    // And the cell's "!1" is a status with words behind it.
    const spoken = screen.getAllByTestId('status-dot').map((n) => n.querySelector('.sr-only').textContent)
    expect(spoken).toContain('1 shift needs coaches: 1 with no coach')
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/schedule/MonthCell.test.jsx src/components/ScheduleCalendar.a11y.test.jsx`
Expected: FAIL, `Failed to resolve import "@/components/schedule/MonthCell"`; a11y: `Unable to find an element by: [data-testid="month-line"]`.

- [ ] **Step 3: Implement**

```jsx
// src/components/schedule/MonthCell.jsx
'use client'

// ROSTERLOOK.1 — one day in the month grid.
//
// Was: "5:45am 2/10" three times and "+4 more", nobody named, under two
// badges ("!1", "↓1") that only made sense if you already knew. Now each line
// is a time and first names ("5:45 Jonathan, James"; monthCellLines decides
// the words), an unstaffed or short line takes the status colour, and the
// day's status is the SAME StatusDot the week headers use, with its sentence
// as a title and as visually hidden text.
//
// Lines are neutral (bg-un1t-bg on the cell's bg-un1t-surface): the template
// colour is no longer a tint here either.
//
// The cell is ONE <button> that drills into that week, so nothing interactive
// may be nested in it. "+N more" is therefore text: the drill-down is the
// expander, as it always was.

import StatusDot from './StatusDot'

const LINE_TONE = {
  ok: 'text-un1t-text',
  quiet: 'text-un1t-subtle italic',
  short: 'text-amber-700 border border-amber-500/50',
  empty: 'text-red-700 border border-dashed border-red-500/50',
}

export default function MonthCell({ dayNumber, inFocusedMonth, isToday, holiday, lines, more, status, assignmentCount, timeOffEntry, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`text-left bg-un1t-surface border rounded-md p-1.5 min-h-[88px] transition-colors hover:border-un1t-text/30 ${
        inFocusedMonth ? 'border-un1t-border' : 'border-un1t-border/50 opacity-60'
      } ${isToday ? 'ring-1 ring-blue-400/50' : ''} ${holiday ? 'bg-amber-500/[0.06]' : ''}`}
    >
      <div className="flex items-center justify-between gap-1 mb-1">
        <span className={`text-xs font-semibold ${isToday ? 'text-blue-700' : inFocusedMonth ? 'text-un1t-text' : 'text-un1t-muted'}`}>
          {dayNumber}
        </span>
        <div className="flex items-center gap-1">
          <StatusDot status={status} />
          {assignmentCount > 0 && (
            <span
              data-testid="month-assignment-count"
              className="text-[10px] px-1.5 py-0.5 rounded bg-un1t-border/60 text-un1t-subtle"
              title={`${assignmentCount} coach assignment${assignmentCount === 1 ? '' : 's'}`}
            >
              {assignmentCount}
              <span className="sr-only"> coach assignment{assignmentCount === 1 ? '' : 's'}</span>
            </span>
          )}
        </div>
      </div>
      {holiday && (
        <div className="text-[9px] text-amber-700 mb-1 truncate" title={holiday.name}>
          {holiday.name}
        </div>
      )}
      <div className="space-y-0.5">
        {lines.map((line) => (
          <div
            key={line.id}
            data-testid="month-line"
            data-tone={line.tone}
            title={line.title}
            className={`text-[10px] truncate rounded px-1 py-0.5 bg-un1t-bg ${LINE_TONE[line.tone] || LINE_TONE.ok}`}
          >
            {line.text}
          </div>
        ))}
        {more > 0 && <div className="text-[10px] text-un1t-subtle">+{more} more</div>}
        {timeOffEntry && (
          <div
            className="text-[10px] truncate rounded px-1 py-0.5"
            style={{ backgroundColor: timeOffEntry.color + '18', color: timeOffEntry.color }}
          >
            {timeOffEntry.text}
          </div>
        )}
      </div>
    </button>
  )
}
```

(The time-off bar's inline colours are `ScheduleCalendar.jsx:1372-1378` verbatim: leave colours are out of this PR's scope. The test's count fixture is plural, so its sr-only text is `' coach assignments'`.)

In `src/components/ScheduleCalendar.jsx`:

(a) Imports:

```jsx
import MonthCell from './schedule/MonthCell'
import { rosterToolbarModel, dayHeaderStatus, shiftCardModel, monthCellLines } from '@/lib/roster-card-model'
```

(b) Delete `blockStaffingStatus` and its comment (`:118-132`, from `// Roster v2: a block is "unstaffed" when it has zero assignments` through the function's closing `}`). The month grid was its last caller; the note it carried lives on `futureBlockStaffing` in `shared/roster-staffing.js`.

(c) Inside the month grid's `for (let i = 0; i < 42; i++) {` loop, replace from `const totalAssignmentCount = …` (`:1280`) through the end of `cells.push( … )` (`:1383`) with:

```jsx
                const totalAssignmentCount = visibleBlocks.reduce((sum, b) => sum + liveAssignments(b.shift_assignments).length, 0)
                // ROSTERLOOK.1 — the lines name the coaches (monthCellLines),
                // and the day's status is the week headers' status, from the
                // same function. Manager-only, as "!1" / "↓1" were
                // (ROSTER-FIX.2: a coach gets no staffing cues).
                const { lines, more } = monthCellLines(visibleBlocks, { todayIso: todayStr, isManager })
                const firstTimeOff = dayTimeOff[0]
                const timeOffConf = firstTimeOff ? (TIME_OFF_CONFIG[firstTimeOff.type] || TIME_OFF_FALLBACK) : null

                cells.push(
                  <MonthCell
                    key={dateStr}
                    dayNumber={date.getDate()}
                    inFocusedMonth={inFocusedMonth}
                    isToday={isToday}
                    holiday={holiday}
                    lines={lines}
                    more={more}
                    status={isManager ? dayHeaderStatus(visibleBlocks, { todayIso: todayStr }) : null}
                    assignmentCount={totalAssignmentCount}
                    timeOffEntry={firstTimeOff
                      ? { text: `${firstTimeOff.profiles?.full_name?.split(' ')[0]} ${timeOffConf.label}`, color: timeOffConf.color }
                      : null}
                    onOpen={() => {
                      setWeekStart(getMonday(date))
                      setViewType('week')
                    }}
                  />
                )
```

This deletes the `dayGaps` / `unstaffedCount` / `shortCount` locals (`:1281-1285`) with the badges they fed. `visibleBlocks`, `dayTimeOff`, `inFocusedMonth`, `isToday` and `holiday` (`:1272-1279`) stay as they are. Update the `// ── MONTH VIEW ──` comment (`:1244-1248`): replace "each cell shows the date + count of assignments + count of unstaffed blocks. Clicking drills into the week view. Roster v2: separately surfaces empty blocks as a red badge." with "each cell is a schedule/MonthCell: the date, the day's staffing status, and up to three lines of time + coach first names. Clicking drills into the week view."

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/schedule/MonthCell.test.jsx src/components/ScheduleCalendar.a11y.test.jsx src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.errors.test.jsx`
Expected: PASS.

Then: `npx eslint src/components/ScheduleCalendar.jsx src/components/schedule/`
Expected: clean. `countStaffingGaps` is still used by the week banner (`:545`); `AlertTriangle` by `PUBLICATION_CHIP` and the hours notice. If `formatTime` or another name is reported unused, delete exactly what is named.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/MonthCell.jsx src/components/schedule/MonthCell.test.jsx src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.a11y.test.jsx
git commit -m "ROSTERLOOK.1 — month view names the coaches; !1 / ↓1 replaced by the week headers' status dot"
```

---

### Task 16: The tab title says the studio you are looking at

**Files:**
- Modify: `src/app/(team)/schedule/page.js`
- Modify: `src/app/(team)/schedule/page.test.js`

**Cause (verified, read-only, against prod on 19 Sep 2026).** No schedule page sets a title, so the tab shows the ROOT layout's default: `src/app/layout.js:71-77` → `resolveDefaultSiteName()` → `readConfiguredCompanyName()` (`src/lib/default-site-name.js:84-99`), which reads

```js
.from('company_settings').select('company_name').not('company_name', 'is', null).order('location_id').limit(1)
```

That is "the first configured row by `location_id`", for every user, cached per lambda for 5 minutes. It knows nothing about the viewer's active location, and the location switcher (`LocationSwitcher.jsx:32`, `router.refresh()`) cannot change it. Prod has two rows: `28c78d6b-…` = "UN1T Hatch Street" and `a0000000-…0001` = "UN1T stillorgan". `2…` sorts before `a…`, so EVERY staff tab in the estate reads "UN1T Hatch Street", whichever studio is on screen. When CHROME.1 wrote that resolver `company_name` was NULL everywhere and the floor ("Repset") was what rendered; the bug arrived when both studios filled the field in.

**The fix that is small and local:** the schedule page declares its own title from the user it already loads. `getCurrentUser` is `React.cache()`-wrapped (`src/lib/auth.js:235`), so `generateMetadata` and the page share one read per request. The estate-wide cause is NOT fixed here; see "Not in this PR".

- [ ] **Step 1: Write the failing test**

In `src/app/(team)/schedule/page.test.js` change the import (`:26`):

```js
import SchedulePage, { generateMetadata } from './page.js'
```

and append:

```js
// ROSTERLOOK.1 — the tab read "UN1T Hatch Street" with the Stillorgan roster on
// screen: the root layout's title is the first company_settings row by
// location_id, for everyone. This page names the studio it is showing.
describe('/schedule root — tab title', () => {
  it('names the ACTIVE studio, not the deployment default', async () => {
    getCurrentUser.mockResolvedValue({ ...user(), activeLocation: { id: 'loc1', name: 'UN1T Stillorgan', features: {} } })
    expect(await generateMetadata()).toEqual({ title: 'Schedule · UN1T Stillorgan' })
  })

  it('degrades to the page name with no session or no named location, and never throws', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect(await generateMetadata()).toEqual({ title: 'Schedule' })
    getCurrentUser.mockResolvedValue(user()) // activeLocation has no name
    expect(await generateMetadata()).toEqual({ title: 'Schedule' })
    getCurrentUser.mockRejectedValue(new Error('auth down'))
    expect(await generateMetadata()).toEqual({ title: 'Schedule' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run 'src/app/(team)/schedule/page.test.js'`
Expected: FAIL, `TypeError: generateMetadata is not a function`.

- [ ] **Step 3: Implement**

In `src/app/(team)/schedule/page.js`, directly under `export const dynamic = 'force-dynamic'` (`:9`):

```js
// ROSTERLOOK.1 — without this the tab shows the root layout's default, which is
// the FIRST company_settings.company_name by location_id for every user
// (src/lib/default-site-name.js): "UN1T Hatch Street" on the Stillorgan roster.
// getCurrentUser is React.cache()'d, so this shares the page's own read. A
// title is never worth a 500: any failure falls back to the page name.
export async function generateMetadata() {
  try {
    const user = await getCurrentUser()
    const studio = user?.activeLocation?.name
    return { title: studio ? `Schedule · ${studio}` : 'Schedule' }
  } catch {
    return { title: 'Schedule' }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run 'src/app/(team)/schedule/page.test.js'`
Expected: PASS (the five existing tests and the two new ones).

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(team)/schedule/page.js' 'src/app/(team)/schedule/page.test.js'
git commit -m "ROSTERLOOK.1 — /schedule's tab title names the active studio (was the first company_settings row for everyone)"
```

---

### Task 17: Arm the contrast rule for the new files; CHANGELOG

**Files:**
- Modify: `eslint.guardrails.config.mjs` (the `no-low-contrast-accent-text` `files` list, after `'src/components/ScheduleCalendar.jsx',` at `:117`)
- Modify: `docs/CHANGELOG.md` (after `gh pr create`)

`ScheduleCalendar.jsx` is armed, but the markup this PR moved OUT of it now lives in `src/components/schedule/`, which is not. Left like that, the rule's coverage of the roster silently shrinks. `src/components/schedule/` was scanned clean at `8231d438` (`ScheduleErrorBanner.jsx` uses `-600` / `-700` only), so arming it is the one-line ratchet the config's own comment describes. `RosterSummaryPanel.jsx` is deliberately NOT armed here: it carries three `text-*-400` icons (`:92`, `:163`, `:171`) and is out of this PR's scope.

- [ ] **Step 1: The failing check is the rule itself.** Add to the `files` array, directly under `'src/components/ScheduleCalendar.jsx',`:

```js
      // ROSTERLOOK.1 — the roster's toolbar, day header, card and month cell
      // moved out of ScheduleCalendar.jsx into this directory; without this
      // line the move would have quietly un-armed them.
      'src/components/schedule/**',
      'src/components/ScheduleRosterView.jsx',
```

- [ ] **Step 2: Run it**

Run: `npm run check:guardrails`
Expected: PASS, no `guardrails/no-low-contrast-accent-text` report. If it DOES report a site under `src/components/schedule/`, that is a real finding in this PR's code: change the ramp to `-700` (keep the hue), do not disable.

- [ ] **Step 3: Prove the rule is really reading the new files** (a gate that cannot fail is not a gate). Temporarily change `text-amber-700` to `text-amber-400` in `src/components/schedule/StatusDot.jsx`, run `npm run check:guardrails`, expect ONE `lowRamp` error naming `StatusDot.jsx`, then revert:

```bash
git checkout -- src/components/schedule/StatusDot.jsx
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run check:guardrails`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eslint.guardrails.config.mjs
git commit -m "ROSTERLOOK.1 — arm no-low-contrast-accent-text for src/components/schedule/** (the roster markup moved there)"
```

After `gh pr create`, add ONE row under the table header in `docs/CHANGELOG.md`, keyed `#<PR>` (never edit a pushed row: `merge=union` duplicates it):

```
| #<PR> | ROSTERLOOK.1 — the roster you can read: one toolbar row, day-header status, neutral cards, coach names in month view | 2026-09-<DD>. No migration; nothing under `mobile/` or `shared/`, so **no OTA**. Owner's call: keep the day-column cards, polish them. (1) ONE toolbar row (`schedule/RosterToolbar`): prev / period / next / Today / publish chip left; My shifts \| All staff, Week \| Month, a keyboard-accessible **More** menu (Time off, Select multiple, Copy last week, Copy last month, Manage templates) and one primary Publish right. Same handlers, same gating (`rosterToolbarModel`), Publish still week-view only; the H2/subtitle block is gone. (2) The Studio Overview STRIP is deleted; each day header shows a status dot + "2 short" and opens the same day dialog (`schedule/StudioOverviewDialog`, demand data intact). (3) Cards are neutral: the template colour is no longer a fill; colour means staffing only (amber "1 of 2", red dashed "Needs coach"); `cardTone()` returns `'neutral'` and is Wave 2's hook for `'admin'`. (4) Card order: one-line time (`formatTimeRange12h`, "9:15–10:30am"), coach names at body size, full template name small with a `title`; the "n/max" chip is gone for everyone. (5) Month cells read "5:45 Jonathan, James"; "!1" / "↓1" became the same status dot with words. Coaches receive exactly the data they did; the coach-mode card model is pinned to contain no capacity figure. Also: `/schedule`'s tab title names the ACTIVE studio (the root default is the first `company_settings` row by `location_id`, which is why every staff tab said "UN1T Hatch Street"; estate-wide fix still open). `no-low-contrast-accent-text` armed for `src/components/schedule/**`. Browser-verified at 1280 and 390. |
```

```bash
git add docs/CHANGELOG.md
git commit -m "ROSTERLOOK.1 — changelog row"
```

---

### Task 18: Browser verification (no automated test can prove any of this)

jsdom has no layout engine. Everything below is a claim this PR makes that only a real browser can confirm. Do it on the PR's **Vercel preview** (local dev has no database; memory `local-dev-login`). The preview reads PROD data: **GET-only. Do not confirm a copy, do not click Publish's confirm, do not assign or remove anyone.** Opening the copy chooser, the publish preview and a block dialog, then cancelling, is fine.

Sign in as a manager at Stillorgan. Use the roster week that showed the problems (week of 21 Sep 2026) and one week in the past.

- [ ] **A. 1280x800, manager, week view**
  1. The toolbar is ONE row: `‹  21 Sep – 27 Sep 2026  ›  Today  [Published]` on the left, `My shifts|All staff  Week|Month  More  Publish` on the right. Nothing wraps.
  2. At least the first card of every day column is visible WITHOUT scrolling at 1512x786 (the owner's screen) and at 1280x800. If the staffing banner + weekly-hours notice still push cards below the fold, note the measured offset of the first card in the PR body; do not restyle the banners in this PR.
  3. No "Schedule / UN1T Stillorgan — Staff roster" heading block; no Studio Overview strip.
  4. Every card's time is on ONE line. Find the longest range on the roster (an `11:30am–12:30pm`-shaped one; if none exists, use devtools to edit a card's time text to `11:30am–12:30pm`) and confirm it neither wraps nor overflows the card. Then narrow the window until the grid hits its 840px floor and scrolls sideways, and check again. If it overflows THERE, change `ShiftCard`'s time line from `font-semibold` at the card's `text-xs` to `text-[11px] font-semibold` and re-check; record which you shipped.
  5. Coach names are visibly larger than the template label; long names truncate with an ellipsis and the full name shows on hover.
  6. The template label shows the full name where it fits ("Morning 8 Week Challenge"), truncates where it does not, and hover shows the full name.
  7. No card is tinted. A short shift has an amber border and "1 of 2"; an empty future shift has a red DASHED border and "Needs coach"; a past empty shift is neutral with "No coach (past)". Your own shifts keep the thin blue ring.
  8. No "1/15"-style chip anywhere on the page.
  9. Day headers: a green dot on a fully staffed day; amber/red dot + "N short" otherwise; nothing on past days. On TODAY's blue header the status pill is readable (white pill, coloured text). Hover shows the sentence.
  10. Click a flagged day's header: the Studio Overview dialog opens with the long date, the supply/demand headline, Undermanned shifts, Events, Bookable today and Staffing. Click an undermanned row: the summary closes and that shift's dialog opens. Close it: focus is back on the day header (a visible focus ring).
- [ ] **B. 1280x800, keyboard only**
  1. Tab reaches, in order: previous, next, Today, (chip if 03 made it a button), My shifts, All staff, Week, Month, More, Publish, then the first day header.
  2. On More: Enter opens it with focus on "Time off"; ArrowDown walks Time off → Select multiple → Copy last week → Copy last month → Manage templates → wraps; ArrowUp reverses; Home/End jump; Escape closes and focus is back on More; Tab closes it and moves on.
  3. More → Copy last week → Enter: the chooser opens; Escape: focus returns to More.
  4. More → Select multiple: the bottom action bar appears and More turns amber; More now lists "Exit multi-select (0)" with a tick; choosing it leaves select mode.
- [ ] **C. 1280x800, month view**
  1. Publish is gone from the row; More still holds all five.
  2. Cells read like `5:45 Jonathan, James`; an evening line keeps `pm`; short lines are amber with "(1 of 2)", empty future lines red dashed "Needs coach"; "+N more" still appears; no "!1" / "↓1".
  3. Hovering a line shows template · full range · full names. Hovering the dot shows the sentence. Clicking a cell drills into that week.
- [ ] **D. 390x844 (phone emulation), manager**
  1. The page still has 16px side gutters and NO horizontal page scroll; the sub-tab strip still scrolls sideways (TABWRAP.1); the week grid still scrolls inside its own container.
  2. The toolbar wraps BETWEEN controls, never inside a label. Expected shape: line 1 `‹ 21 Sep – 27 Sep 2026 › Today`, the chip on line 1 or 2, then `My shifts|All staff  Week|Month  More` (icons hidden), then Publish. **Publish is fully on screen.** Repeat at 360 and 768.
  3. Open More at 390: the menu spans the actions group's width, sits fully on screen, and nothing is cut off on either side. Repeat with the window at 640 (the `sm` switch to the right-anchored 220px menu).
  4. Open a day header's dialog at 390: it fits and scrolls inside itself.
- [ ] **E. Coach (use "View as user" on a coach, or a coach login), 1280 and 390**
  1. Toolbar: navigator, My shifts|All staff, Week|Month, a "Time off" link. No More, no Publish, no publish chip.
  2. Day headers are not clickable and carry no dot. Cards carry no amber/red border, no "1 of 2", no "Needs coach", no numbers. Month lines carry no status colour.
  3. Devtools → Network → the `/api/schedule/blocks` response is byte-for-byte the shape it was before this PR (no `max_coaches`, no `min_coaches`, published blocks only). This PR did not touch the route; this step is to SEE that, not to assume it.
- [ ] **F. "Both themes"**: set the OS to dark mode and reload at 1280 and 390. Expected: identical to light (the CRM has one theme; see the Theme note). Any element that changes is a bug in THAT element's use of a non-token colour.
- [ ] **G. Tab title**: on `/schedule` the tab reads "Schedule · UN1T Stillorgan" (with Sidebar's unread prefix, e.g. "(3) Schedule · …", if there is one). Switch to Hatch Street with the location switcher: it becomes "Schedule · UN1T Hatch Street" without a manual reload. If it only changes after a hard reload, say so in the PR body (Next re-resolves metadata on `router.refresh()`; this was not verifiable outside a browser). Note that `/schedule/time-off` and every other staff page still show the old default: that is the open estate-wide item below.
- [ ] **Record** in the PR body: the viewport sizes checked, the first-card offset from A.2, which time-line size shipped (A.4), and anything in D.2 that did not match the expected shape.

---

## PR gate

Run in this order; stop at the first failure.

```bash
# 1. Every test file this PR created or changed, plus the ones that render the calendar
npx vitest run \
  src/lib/schedule-overlap.test.js \
  src/lib/roster-card-model.test.js \
  src/lib/roster-staffing.test.js \
  src/components/schedule/MoreMenu.test.jsx \
  src/components/schedule/RosterToolbar.test.jsx \
  src/components/schedule/DayHeader.test.jsx \
  src/components/schedule/ShiftCard.test.jsx \
  src/components/schedule/MonthCell.test.jsx \
  src/components/schedule/StudioOverviewDialog.test.jsx \
  src/components/ScheduleRosterView.open-shift.test.jsx \
  src/components/ScheduleCalendar.toolbar.test.jsx \
  src/components/ScheduleCalendar.a11y.test.jsx \
  src/components/ScheduleCalendar.visibility.test.jsx \
  src/components/ScheduleCalendar.errors.test.jsx \
  src/components/ScheduleCalendar.assign-conflicts.test.jsx \
  src/components/ScheduleCalendar.publish-confirm.test.jsx \
  src/components/ScheduleCalendar.week-cost.test.jsx \
  src/components/ScheduleTabs.test.jsx \
  'src/app/(team)/schedule/page.test.js' \
  src/components/ui/Modal.a11y.test.jsx

# 2. Repo-level tests that read the files this PR moved or added
npx vitest run tests/test-timeout-budgets.test.js tests/shared-pair-sync.test.js

# 3. Lint (covers the unused imports left behind by the four swaps)
npm run lint

# 4. The guardrails gate: no-low-contrast-accent-text (now armed for schedule/**),
#    no-low-contrast-chip, no-dead-un1t-token, no-untyped-button-in-form
npm run check:guardrails

# 5. Unchanged by this PR but cheap, and they read src/: confirm still green
npm run check:location-scoping && npm run check:route-guards && npm run check:select-columns

# 6. New files + new imports + a new generateMetadata export: the only check that
#    catches an unresolvable import is the build (CLAUDE.md). Close the browser first (8GB).
npm run build

# 7. Then, once, the whole suite
npm test
```

`check:mobile-parity`, `check:mobile-imports`, `check:mobile-lint` and `check:ota-paths` are not relevant (nothing under `mobile/` or `shared/` changed, no permission key added); CI runs them regardless.

Then Task 18 in a browser, THEN `gh pr create`. The PR body states: merge order (after 01 and 03), the coach-boundary paragraph from the top of this plan, and the Task 18 record.

---

## Not in this PR

- **The estate-wide tab-title cause.** `resolveDefaultSiteName()` returns the first `company_settings.company_name` by `location_id` for every user, so every staff page without its own `generateMetadata` (about 160 of them, including the six `/schedule/*` siblings) reads "UN1T Hatch Street". The real fix is in `src/app/layout.js` / `src/lib/default-site-name.js`: either resolve from the signed-in user's active location for staff routes, or stop treating a per-LOCATION `company_name` as a deployment-wide name. It touches the root layout every public page renders through and a module-level cache keyed on nothing, so it gets its own PR and its own review (`src/lib/brand-chrome.test.js` pins the current behaviour).
- **Day-level demand vs supply is no longer visible at a glance.** The strip's tile classified a day from EVENT demand as well as shift minimums (`classifyDayLoad`: an event needing 4 staff with 2 rostered was amber even when every shift met its minimum). The header dot answers from shift staffing only, per the owner's spec; the demand headline is still the first thing in the dialog. If that is missed in use, `dayHeaderStatus` can take the overview day as a second input without touching `DayHeader`.
- **The Studio Overview is not reachable from month view.** The strip used to show 42 tiles there. A month cell still drills into its week, whose headers open the dialog.
- **`focusShift`'s navigate-to-another-week path is now unreachable from the UI** (a day header is always a day on screen). `ScheduleCalendar.jsx:642-705` is left in place, and still tested, to keep this PR out of the code 01 and 03 edit. Delete it, `pendingShift` and the two tests in a later tidy-up.
- **The staffing-gaps banner and the weekly-hours notice** still sit between the toolbar and the grid. The day headers now say most of what the banner says; whether to shrink it to one line is the owner's call after seeing Task 18 A.2's number.
- **The `admin` card tone** (Wave 2). Only the hook exists: `cardTone()` and `TONE_SURFACE`.
- **`MoreMenu` as a `src/components/ui/` primitive**, and retrofitting `PersonActionBar` / `WAInbox`, whose menus have no arrow keys or focus return.
- **`RosterSummaryPanel.jsx`'s three `text-*-400` icons** and arming that file.
- **Leave-bar colours** (`TIME_OFF_CONFIG` hex literals) and the mobile roster.
