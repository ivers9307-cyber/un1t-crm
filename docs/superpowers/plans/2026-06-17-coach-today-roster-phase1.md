# Coach Today roster — Phase 1 (month view) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. **Work from the worktree `/Users/richardivers/code/un1t-crm-ct` on branch `feat/coach-today-roster`** — every task's first step is the branch guard (`git -C /Users/richardivers/code/un1t-crm-ct branch --show-current` → `feat/coach-today-roster`, else STOP).

**Goal:** Replace the personal roster's two-week view ("This week" + "Next week") on the Today dashboard with a **month** view — web = calendar grid, mobile = agenda list — plus a Week|Month toggle (Month default). **Visual + data reshape only; no behaviour/permission/migration change.** Ships safely while the Schedule tab stays in place (later phases add self-service actions + the gating cutover).

**Spec:** `docs/superpowers/specs/2026-06-17-coach-today-roster-design.md`. **Approved mockup:** calendar grid (web) + agenda (mobile), shown + approved in the design dialogue 2026-06-17.

**Tech:** Next.js 16 (web), Expo/React Native + NativeWind (mobile), shared pure helpers in `shared/`, Vitest.

---

## Verified facts (from recon — don't re-derive)
- Both web (`src/app/dashboard/today/page.js`) and mobile (`mobile/components/dashboard/PersonalDashboard.jsx`) render the same two-week roster via a local `WeekPanel` + `buildWeek`/`shiftTime`/`shiftHours`/`isoDate`/`rangeLabelFor` helpers (duplicated in each file).
- **Both consume the same shared data source**: `fetchPersonalDashboardData(supabase, profileId, locationId)` in `shared/dashboard-data.js` (mobile via `mobile/lib/dashboard-api.js → fetchPersonalDashboard`). So a data-shape change in T1 flows to both.
- `fetchPersonalDashboardData` returns `weekShifts, weekStartIso, weekEndIso, nextWeekShifts, nextWeekStartIso, nextWeekEndIso, shiftsThisWeek, hoursThisWeek, pendingSwapsForMe, myPendingTimeOff, unreadInbox` (+ `assignedConversations`). Internal `fetchDashboardShifts(supabase, profileId, startIso, endIso)` runs ONE `shift_assignments`→`shift_blocks` join over a date range; each shift has `shift_date`, `shift_templates{name,start_time,end_time}`, `start_time_override`/`end_time_override`, `status`, `published` (derived from `rosters.status==='published'`), `locations{id,name}`.
- A shift's display time uses `start_time_override || shift_templates.start_time` (same for end); duration = end−start (wrap past midnight). `published===false` → "Draft" badge; `status==='swapped'` → "Swapped" badge; location chip only when the user has 2+ locations.
- No `shared/dashboard-data` test file exists today; the new pure helpers get their own test.

---

## Task 1: Month data — pure helpers + widen the fetch

**Files:**
- Create: `shared/roster-month.js` (pure, no supabase import)
- Create: `shared/roster-month.test.js`
- Modify: `shared/dashboard-data.js` (call the new month fetch; return month fields)

- [ ] **Step 1: Branch guard** — `git -C /Users/richardivers/code/un1t-crm-ct branch --show-current` must print `feat/coach-today-roster`.

- [ ] **Step 2: Write the failing tests** — `shared/roster-month.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { monthBounds, shiftDurationHours, summariseShifts, buildMonthMatrix } from './roster-month.js'

describe('monthBounds', () => {
  it('returns the calendar month containing the anchor (Mon-start unaffected)', () => {
    expect(monthBounds('2026-06-17')).toEqual({ monthStartIso: '2026-06-01', monthEndIso: '2026-06-30' })
  })
  it('handles February + year edges', () => {
    expect(monthBounds('2026-02-15')).toEqual({ monthStartIso: '2026-02-01', monthEndIso: '2026-02-28' })
    expect(monthBounds('2026-12-31')).toEqual({ monthStartIso: '2026-12-01', monthEndIso: '2026-12-31' })
  })
})

describe('shiftDurationHours', () => {
  it('computes from template times', () => {
    expect(shiftDurationHours({ shift_templates: { start_time: '06:30', end_time: '09:30' } })).toBe(3)
  })
  it('honours overrides and wraps past midnight', () => {
    expect(shiftDurationHours({ start_time_override: '22:00', end_time_override: '01:00', shift_templates: {} })).toBe(3)
  })
  it('0 when times missing', () => {
    expect(shiftDurationHours({ shift_templates: {} })).toBe(0)
  })
})

describe('summariseShifts', () => {
  it('counts + sums hours (rounded 1dp)', () => {
    const s = [
      { shift_templates: { start_time: '06:30', end_time: '09:30' } },
      { shift_templates: { start_time: '17:00', end_time: '20:00' } },
    ]
    expect(summariseShifts(s)).toEqual({ count: 2, hours: 6 })
  })
})

describe('buildMonthMatrix', () => {
  // June 2026: 1st = Monday, 30 days.
  const matrix = buildMonthMatrix('2026-06-01', '2026-06-30', [
    { shift_date: '2026-06-17', shift_templates: { name: 'Strength' } },
  ], '2026-06-17')

  it('returns full Mon-start weeks padded to 7', () => {
    expect(matrix.every(w => w.length === 7)).toBe(true)
    expect(matrix[0][0].iso).toBe('2026-06-01') // Mon 1 Jun, no leading pad
  })
  it('flags inMonth / isToday / isPast and attaches shifts by date', () => {
    const all = matrix.flat()
    const today = all.find(d => d.iso === '2026-06-17')
    expect(today.isToday).toBe(true)
    expect(today.shifts).toHaveLength(1)
    expect(all.find(d => d.iso === '2026-06-01').isPast).toBe(true)
    // trailing pad days into July are inMonth:false
    expect(all.some(d => !d.inMonth)).toBe(true)
  })
  it('pads a mid-week month start with leading days', () => {
    // Feb 2026 starts on a Sunday → 6 leading pad days (Mon 26 Jan … Sat 31 Jan)
    const m = buildMonthMatrix('2026-02-01', '2026-02-28', [], '2026-02-10')
    expect(m[0][0].inMonth).toBe(false)
    expect(m[0][6].iso).toBe('2026-02-01') // Sunday 1 Feb is the last cell of row 0
  })
})
```
(Verify the real weekday anchors — 2026-06-01 is Monday, 2026-02-01 is Sunday — and correct expectations to truth if a date is off; don't distort the implementation.)

- [ ] **Step 3: Run → FAIL.** `cd /Users/richardivers/code/un1t-crm-ct && npx vitest run shared/roster-month.test.js`

- [ ] **Step 4: Implement `shared/roster-month.js`** (pure; mirror the existing date/time conventions from `today/page.js`):
```js
// Pure helpers for the personal-roster MONTH view (Today dashboard).
// No IO — fetch happens in dashboard-data.js; these shape the rows for
// the web calendar grid + mobile agenda. Dates are ISO YYYY-MM-DD.
// Calendar month is Mon-start to match the existing week panels.

function isoOf(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Calendar month containing the anchor ISO date.
export function monthBounds(anchorIso) {
  const d = new Date(anchorIso + 'T00:00:00Z')
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  return { monthStartIso: isoOf(start), monthEndIso: isoOf(end) }
}

// Effective minutes for a shift, honouring overrides; wraps past midnight.
function durationMins(shift) {
  const start = shift.start_time_override || shift.shift_templates?.start_time
  const end = shift.end_time_override || shift.shift_templates?.end_time
  if (!start || !end) return 0
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = eh * 60 + em - (sh * 60 + sm)
  if (mins < 0) mins += 24 * 60
  return mins
}
export function shiftDurationHours(shift) {
  return Math.round((durationMins(shift) / 60) * 10) / 10
}
export function summariseShifts(shifts) {
  const list = shifts || []
  const hours = Math.round(list.reduce((t, s) => t + durationMins(s), 0) / 60 * 10) / 10
  return { count: list.length, hours }
}

// Mon-start weeks covering the whole month, padded with leading/trailing
// days from adjacent months (inMonth:false). Each cell:
// { iso, dayNum, inMonth, isToday, isPast, weekday(0=Mon), shifts[] }.
export function buildMonthMatrix(monthStartIso, monthEndIso, shifts, todayIso) {
  const byDate = {}
  for (const s of shifts || []) {
    if (!s.shift_date) continue
    ;(byDate[s.shift_date] ||= []).push(s)
  }
  const start = new Date(monthStartIso + 'T00:00:00Z')
  const end = new Date(monthEndIso + 'T00:00:00Z')
  // Back up to the Monday on/just before the 1st (getUTCDay: 0=Sun..6=Sat).
  const lead = (start.getUTCDay() + 6) % 7
  const gridStart = new Date(start); gridStart.setUTCDate(start.getUTCDate() - lead)
  // Forward to the Sunday on/just after the last day.
  const trail = (7 - ((end.getUTCDay() + 6) % 7) - 1)
  const gridEnd = new Date(end); gridEnd.setUTCDate(end.getUTCDate() + trail)

  const weeks = []
  let cur = new Date(gridStart)
  while (cur <= gridEnd) {
    const row = []
    for (let i = 0; i < 7; i++) {
      const iso = isoOf(cur)
      row.push({
        iso,
        dayNum: cur.getUTCDate(),
        weekday: (cur.getUTCDay() + 6) % 7,
        inMonth: iso >= monthStartIso && iso <= monthEndIso,
        isToday: iso === todayIso,
        isPast: iso < todayIso,
        shifts: byDate[iso] || [],
      })
      cur.setUTCDate(cur.getUTCDate() + 1)
    }
    weeks.push(row)
  }
  return weeks
}
```

- [ ] **Step 5: Run → PASS.** Fix any real weekday-anchor expectations to truth, not the impl.

- [ ] **Step 6: Widen `fetchPersonalDashboardData`** in `shared/dashboard-data.js` — keep every existing field; ADD month data. Read the file first; near where `weekShifts`/`nextWeekShifts` are assembled:
  - Import `monthBounds`, `summariseShifts` from `./roster-month.js`.
  - Compute `const { monthStartIso, monthEndIso } = monthBounds(<today ISO already computed in the fn>)`.
  - Fetch the month's shifts via the SAME internal `fetchDashboardShifts(supabase, profileId, monthStartIso, monthEndIso)` (it's already range-parameterised — reuse it; a second call is fine, personal data is small).
  - Add to the returned `data`: `monthShifts` (the fetched array), `monthStartIso`, `monthEndIso`, and `summariseShifts(monthShifts)` spread as `shiftsThisMonth`/`hoursThisMonth` (map `{count,hours}` → those names).
  - Do NOT remove `weekShifts`/`nextWeekShifts`/`hoursThisWeek` — the Week toggle mode + KPI still use them.

- [ ] **Step 7: Commit**
```bash
cd /Users/richardivers/code/un1t-crm-ct
git add shared/roster-month.js shared/roster-month.test.js shared/dashboard-data.js
git commit -m "feat(today): month roster data — pure helpers (monthBounds/buildMonthMatrix/summarise) + widen fetchPersonalDashboardData"
```

---

## Task 2: Web — month calendar grid + Week|Month toggle

**Files:**
- Create: `src/components/dashboard/MonthRoster.jsx` (client component)
- Modify: `src/app/dashboard/today/page.js` (replace the two `<WeekPanel>` block with `<MonthRoster>`)

- [ ] **Step 1: Branch guard.**

- [ ] **Step 2: Build `src/components/dashboard/MonthRoster.jsx`** — `'use client'`. Props: `{ weeks, monthLabel, monthSummary, weekPanels, showLocation }` where `weeks` = output of `buildMonthMatrix`, `weekPanels` = `[{title,startIso,endIso,shifts}]` for "This week"/"Next week" (Week mode). `useState('month')` toggle (Month default).
  - **Month mode:** the calendar grid from the approved mockup — a `Your roster` header row with month label (no nav arrows needed in Phase 1 — current month only; arrows are a later enhancement), the Week|Month toggle, and `monthSummary` ("17 shifts · 94h"); a 7-col weekday header (Mon…Sun); a 7-col grid of cells. Cell: date number (muted; blue+ring when `isToday`; `opacity` ~0.4 when `!inMonth`), then up to 2 shift chips (`time` + short `shift_templates.name`, left-accent blue, amber when `published===false`) + "+N more"; empty when no shifts. Import `shiftDurationHours` from `@shared/roster-month` only if you show hours (chips show time only). Use `un1t-*` tokens + the light-card ramp (`text-*-700`), match the mock. Build the grid with the matrix (no date math in the component).
  - **Week mode:** render the existing two `WeekPanel`s. Move the `WeekPanel` + `buildWeek`/`shiftTime`/`rangeLabelFor` helpers out of `today/page.js` into this client component (or a small shared `RosterPanels.jsx`) so both modes live together. Keep their markup/styling identical to today.
  - Location chip per shift only when `showLocation` (uses `pickLocationColor` from `@shared/location-colors`, as today).

- [ ] **Step 3: Wire into `src/app/dashboard/today/page.js`** — replace the `<div className="grid ... md:grid-cols-2 ...">` containing the two `<WeekPanel>`s with:
```jsx
<div className="mb-4 max-w-5xl">
  <MonthRoster
    weeks={buildMonthMatrix(monthStartIso, monthEndIso, monthShifts, isoDate(new Date()))}
    monthLabel={new Date(monthStartIso + 'T00:00:00').toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })}
    monthSummary={`${shiftsThisMonth} shift${shiftsThisMonth === 1 ? '' : 's'} · ${hoursThisMonth}h`}
    weekPanels={[
      { title: 'This week', startIso: weekStartIso, endIso: weekEndIso, shifts: weekShifts },
      { title: 'Next week', startIso: nextWeekStartIso, endIso: nextWeekEndIso, shifts: nextWeekShifts },
    ]}
    showLocation={showLocation}
  />
</div>
```
  - Destructure the new `monthShifts, monthStartIso, monthEndIso, shiftsThisMonth, hoursThisMonth` from `res.data`. Import `buildMonthMatrix` from `@shared/roster-month` + `MonthRoster` from `@/components/dashboard/MonthRoster`. Remove the now-unused inline `WeekPanel` (moved into MonthRoster) but keep `isoDate` (used above) — or compute the today ISO inside MonthRoster instead and drop the prop. Leave the KPI row, feed, swaps + time-off sections UNCHANGED (Phase 2 touches those).
  - Note: a client component under a server page is fine; pass only serialisable props (plain arrays/strings) — `weeks` is plain objects, OK.

- [ ] **Step 4: Verify + commit**
```bash
cd /Users/richardivers/code/un1t-crm-ct
npx eslint src/components/dashboard/MonthRoster.jsx src/app/dashboard/'today'/page.js
git add -A && git commit -m "feat(today): web month calendar roster + Week|Month toggle (MonthRoster)"
```

---

## Task 3: Mobile — month agenda + Week|Month toggle

**Files:**
- Modify: `mobile/components/dashboard/PersonalDashboard.jsx`

- [ ] **Step 1: Branch guard.**

- [ ] **Step 2: Replace the two `<WeekPanel>` calls** (lines ~269–282) with a month agenda + a small Week|Month segmented toggle (Month default, `useState`). Keep `WeekPanel` (+ its helpers) in the file for Week mode.
  - **Agenda (Month mode):** consume the new `monthShifts` + `monthStartIso`/`monthEndIso` from `data` (already returned by the shared fetch via T1). Build week groups with `buildMonthMatrix` from `../../shared/roster-month` (relative import — mobile can't use the `@shared` alias; verify the path resolves), then **per week show only days that have shifts** (hide days off — agreed), with a week header ("This week" for the week containing today, else the range label + "· N shifts") and day rows in the existing `ShiftRow` style (weekday+date left; name + `time · {shiftDurationHours}h` + Draft/Swapped/location badges right; today row highlighted). Reuse `shiftDurationHours` from the shared helper (drop the local `shiftHours` if you switch, or keep — either is fine).
  - **Week mode:** the existing two `WeekPanel`s unchanged.
  - Match the approved mobile mock (agenda grouped by week, working-days-only). NativeWind `un1t-*` classes as in the current file.

- [ ] **Step 3: Verify + commit** — mobile isn't covered by root eslint; rely on `check:mobile-imports` in T4. Sanity-check the relative import path to `shared/roster-month.js` resolves from `mobile/components/dashboard/`.
```bash
cd /Users/richardivers/code/un1t-crm-ct
git add mobile/components/dashboard/PersonalDashboard.jsx && git commit -m "feat(today): mobile month agenda roster + Week|Month toggle"
```

---

## Task 4: Review + CI + PR

- [ ] **Step 1: Branch guard.**
- [ ] **Step 2: Full CI mirror** (fix small failures on the diff):
```bash
cd /Users/richardivers/code/un1t-crm-ct
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards
```
Report each. (No new permission key → parity unaffected. `check:mobile-imports` validates the `shared/roster-month` import from mobile — the key mobile risk.)
- [ ] **Step 3: Spec-compliance + quality review** (subagent): month roster matches the approved mock (web calendar / mobile agenda), Week|Month toggle (Month default), days-off hidden in agenda, no behaviour/permission/migration change, existing week fields untouched, pure helpers tested.
- [ ] **Step 4: Commit any fixes; push; open PR** (base main). Body: Phase 1 of the coach-Today spec; visual + data reshape only; Vercel build = gate (worktree symlink note); link the spec.

---

## Definition of done
Month roster live on web (calendar) + mobile (agenda) with a Week|Month toggle, fed by the widened shared helper; pure helpers unit-tested; full CI mirror green; **no migration, no permission change, no behaviour change** (swap/time-off lists + feed + KPIs untouched — those are Phase 2). Vercel PR check is the build gate.

## Self-review
- **Spec coverage:** month roster (web calendar + mobile agenda), Week|Month toggle Month-default, calendar-month boundary, hide days off (agenda), grid caps 2 + "more" — all in T2/T3; data reshape in T1. ✓
- **Reuse/DRY:** one shared pure module (`roster-month.js`) feeds web + mobile; one widened fetch feeds both; existing `WeekPanel` kept for Week mode. ✓
- **No placeholders:** T1 is complete + tested; T2/T3 name exact files + the prop contract + the approved mock as the visual spec (deliberately not 200 lines of verbatim JSX — the implementer matches the mock).
- **Risk:** mobile relative import of `shared/roster-month` (guarded by `check:mobile-imports`); client-under-server-page prop serialisation (plain objects — fine). Phasing keeps Phase 1 reversible + behaviour-neutral.
