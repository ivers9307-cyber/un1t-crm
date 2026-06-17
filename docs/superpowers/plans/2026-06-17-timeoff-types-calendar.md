# Time-off types + mobile calendar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Gate the "Request time off" type menu by employment type — full-time employees keep the four leave types (Holiday/Sick/Unpaid/Other, now made genuinely valid), contractors + casual staff see only "Unavailable" — and replace the mobile +/− date stepper with a tappable month calendar.

**Architecture:** A single shared catalogue (`shared/time-off.js`) defines all five time-off types and the employment-gated option list, imported by both web and mobile so the gating can't drift. The DB CHECK (mig 283, already applied), the Zod schema, the manager approval screen, and the reports are all widened to the same five-type set so every layer is coherent. The mobile date picker becomes a pure-JS month calendar (reusing `shared/roster-month.js`) so it ships over-the-air with no native module.

**Tech Stack:** Next.js 16 (web), Expo/React Native (mobile), Zod, Vitest, shared JS in `shared/`.

**Migration:** `283_time_off_types_expand.sql` — already written + applied to prod. The CHECK now allows `holiday, sick, unpaid, other, unavailable`.

---

## Background (verified)
- `time_off_requests.type` CHECK is now `holiday|sick|unpaid|other|unavailable` (mig 283 applied).
- `profiles.employment_type` ∈ `fte | contractor | casual` (`employmentTypeSchema`, `src/lib/schemas.js:65`). Exposed on `getCurrentUser()` (web `user.employment_type`) and `/api/mobile/me` (mobile `profile.employment_type`).
- Gating rule (locked): **`contractor` + `casual` → `['unavailable']`; everyone else (incl. `fte`, null) → `['holiday','sick','unpaid','other']`.**
- Coach request forms today: web `src/components/dashboard/RequestTimeOffModal.jsx` (already uses native `<input type=date>` — calendar fine); mobile `mobile/app/schedule/time-off-new.jsx` (the +/− `DateRow` stepper — BOTH mobile entry points, Today + Schedule tab, navigate here).
- Manager screen `src/components/TimeOffManager.jsx`: `TYPE_CONFIG` has only holiday/sick/unavailable; a `TimeOffFormModal` create-form has a type `<select>`.
- Reports `src/lib/report-generator.js`: `byType`/`byStaff` seed `{ holiday, sick, unavailable }` (lines ~202, ~210). `report-generator.test.js` has NO bucket-shape assertions (safe to widen).

---

## Task 1: Shared time-off catalogue + gating helper (+ Zod widen)

**Files:**
- Create: `shared/time-off.js`
- Test: `shared/time-off.test.js`
- Modify: `src/lib/schemas.js:152`

- [ ] **Step 1: Write the failing test**

```js
// shared/time-off.test.js
import { describe, it, expect } from 'vitest'
import { TIME_OFF_TYPES, timeOffTypesFor, defaultTimeOffTypeFor, timeOffTypeLabel } from './time-off'

describe('time-off catalogue + gating', () => {
  it('lists all five types with labels', () => {
    expect(TIME_OFF_TYPES.map(t => t.value)).toEqual(['holiday', 'sick', 'unpaid', 'other', 'unavailable'])
    expect(TIME_OFF_TYPES.every(t => typeof t.label === 'string' && t.label.length > 0)).toBe(true)
  })

  it('gives full-time employees the four leave types', () => {
    expect(timeOffTypesFor('fte').map(t => t.value)).toEqual(['holiday', 'sick', 'unpaid', 'other'])
    expect(defaultTimeOffTypeFor('fte')).toBe('holiday')
  })

  it('restricts contractors + casual to unavailable only', () => {
    for (const et of ['contractor', 'casual']) {
      expect(timeOffTypesFor(et).map(t => t.value)).toEqual(['unavailable'])
      expect(defaultTimeOffTypeFor(et)).toBe('unavailable')
    }
  })

  it('defaults unknown/null employment to the full leave menu (does not over-restrict)', () => {
    expect(timeOffTypesFor(null).map(t => t.value)).toEqual(['holiday', 'sick', 'unpaid', 'other'])
    expect(timeOffTypesFor(undefined).map(t => t.value)).toEqual(['holiday', 'sick', 'unpaid', 'other'])
    expect(defaultTimeOffTypeFor(null)).toBe('holiday')
  })

  it('labels a type value', () => {
    expect(timeOffTypeLabel('unavailable')).toBe('Unavailable')
    expect(timeOffTypeLabel('nope')).toBe('nope') // fallback to the raw value
  })
})
```

- [ ] **Step 2: Run to verify it fails**

`cd /Users/richardivers/code/un1t-crm-ct && npx vitest run shared/time-off.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement**

```js
// shared/time-off.js
// Canonical time-off type catalogue + employment-gated option lists. Shared by
// web (RequestTimeOffModal, TimeOffManager) + mobile (time-off-new) so the
// gating can't drift. The DB CHECK (mig 283) allows all five; the manager
// approval screen + reports render/bucket them.
//
// Gating (product decision 2026-06-17): full-time employees get the four leave
// types; contractors + casual staff get 'unavailable' only. Unknown/null
// employment defaults to the full menu (don't over-restrict a mis-typed FTE).

export const TIME_OFF_TYPES = [
  { value: 'holiday', label: 'Holiday' },
  { value: 'sick', label: 'Sick' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'other', label: 'Other' },
  { value: 'unavailable', label: 'Unavailable' },
]

// employment_type values that only get 'unavailable'.
const RESTRICTED_EMPLOYMENT = ['contractor', 'casual']
const FTE_VALUES = ['holiday', 'sick', 'unpaid', 'other']
const RESTRICTED_VALUES = ['unavailable']

export function allowedTimeOffValues(employmentType) {
  return RESTRICTED_EMPLOYMENT.includes(employmentType) ? RESTRICTED_VALUES : FTE_VALUES
}

export function timeOffTypesFor(employmentType) {
  const allowed = allowedTimeOffValues(employmentType)
  return TIME_OFF_TYPES.filter(t => allowed.includes(t.value))
}

export function defaultTimeOffTypeFor(employmentType) {
  return RESTRICTED_EMPLOYMENT.includes(employmentType) ? 'unavailable' : 'holiday'
}

export function timeOffTypeLabel(value) {
  return TIME_OFF_TYPES.find(t => t.value === value)?.label || value
}
```

- [ ] **Step 4: Widen the Zod schema** — `src/lib/schemas.js:152`:

```js
// Time-off types. Full coherent set matching the DB CHECK (mig 283) + the
// shared catalogue in shared/time-off.js. The coach-facing menu is gated by
// employment type in the UI; this enum just bounds what the API will accept.
export const timeOffTypeSchema = z.enum(['holiday', 'sick', 'unpaid', 'other', 'unavailable'])
```

- [ ] **Step 5: Run tests** — `npx vitest run shared/time-off.test.js src/lib/schemas.test.js` → PASS.

- [ ] **Step 6: Commit** — `TIMEOFF — shared time-off catalogue + employment gating helper + widen Zod enum`

---

## Task 2: Web — gate RequestTimeOffModal by employment type

**Files:**
- Modify: `src/components/dashboard/RequestTimeOffModal.jsx`
- Modify: `src/components/dashboard/MonthRoster.jsx` (thread `employmentType` to the modal)
- Modify: `src/app/dashboard/today/page.js` (pass `user.employment_type` to MonthRoster)

- [ ] **Step 1: RequestTimeOffModal** — accept `employmentType` prop; replace the hard-coded `TYPE_OPTIONS` with `timeOffTypesFor(employmentType)` from `@shared/time-off`; initialise `type` via `defaultTimeOffTypeFor(employmentType)` (and reset to it). When only one type is available (contractor/casual), render a static read-only line ("Type: Unavailable") instead of a `<select>` (a one-option dropdown is pointless). Keep the date inputs (native calendar) + reason as-is.

```jsx
import { timeOffTypesFor, defaultTimeOffTypeFor } from '@shared/time-off'
// ...
export default function RequestTimeOffModal({ open, onClose, onSuccess, employmentType }) {
  const typeOptions = timeOffTypesFor(employmentType)
  const defaultType = defaultTimeOffTypeFor(employmentType)
  const [type, setType] = useState(defaultType)
  // reset(): setType(defaultType)
  // ...
  // In the form, replace the Type <select> block with:
  //   {typeOptions.length > 1 ? (<select …>{typeOptions.map(...)}</select>)
  //     : (<p className="…">Type: <span className="font-medium text-un1t-text">{typeOptions[0]?.label}</span></p>)}
}
```

- [ ] **Step 2: MonthRoster** — add `employmentType` to its props and pass it to `<RequestTimeOffModal employmentType={employmentType} … />`.

- [ ] **Step 3: today/page.js** — pass `employmentType={user.employment_type}` to `<MonthRoster … />`.

- [ ] **Step 4: Build/lint** — `npm run build 2>&1 | tail -20` (env symlink failure OK — Vercel is the gate) + `npx next lint 2>&1 | tail -10` (clean).

- [ ] **Step 5: Commit** — `TIMEOFF (web) — gate Request-time-off types by employment (contractors → Unavailable only)`

---

## Task 3: Manager screen + reports — render/bucket all five types

**Files:**
- Modify: `src/components/TimeOffManager.jsx` (`TYPE_CONFIG` + the create-form type select)
- Modify: `src/lib/report-generator.js` (byType / byStaff seeds)

- [ ] **Step 1: TYPE_CONFIG** — add `unpaid` + `other` entries so existing/new requests of every type render. Reuse lucide icons (e.g. `Wallet` for unpaid, `CalendarOff`/`MoreHorizontal` for other — import what's needed). Keep colours in the existing hex style:

```js
import { CalendarOff, Plus, Check, X, Palmtree, ThermometerSun, Ban, Wallet, CircleEllipsis } from 'lucide-react'
const TYPE_CONFIG = {
  holiday:     { label: 'Holiday',      color: '#22C55E', bg: '#22C55E20', icon: Palmtree },
  sick:        { label: 'Sick Leave',   color: '#EF4444', bg: '#EF444420', icon: ThermometerSun },
  unpaid:      { label: 'Unpaid Leave', color: '#6366F1', bg: '#6366F120', icon: Wallet },
  other:       { label: 'Other',        color: '#64748B', bg: '#64748B20', icon: CircleEllipsis },
  unavailable: { label: 'Unavailable',  color: '#F59E0B', bg: '#F59E0B20', icon: Ban },
}
```
Guard any `TYPE_CONFIG[type]` lookups against undefined (fallback to a neutral label) so an unknown legacy value never crashes the row.

- [ ] **Step 2: Manager create-form type select** — point `TimeOffFormModal`'s type `<select>` at the shared `TIME_OFF_TYPES` (all five) instead of a hard-coded list, so a manager recording on behalf can pick any valid type. (Managers aren't employment-gated.)

- [ ] **Step 3: report-generator** — seed `byType` + `byStaff[name]` with all five keys so unpaid/other/unavailable are bucketed, not dropped:

```js
const byType = { holiday: 0, sick: 0, unpaid: 0, other: 0, unavailable: 0 }
// and: byStaff[name] = { holiday: 0, sick: 0, unpaid: 0, other: 0, unavailable: 0, total: 0 }
```
The existing `byType[req.type] = (byType[req.type]||0)+…` already tolerates any key; seeding just makes the report shape stable.

- [ ] **Step 4: Tests** — `npx vitest run src/lib/report-generator.test.js src/components` (or full `npm test`) → PASS.

- [ ] **Step 5: Commit** — `TIMEOFF (manager+reports) — render + bucket all five time-off types`

---

## Task 4: Mobile — gate types + replace +/− stepper with a JS month calendar

**Files:**
- Create: `mobile/components/MonthCalendar.jsx` (pure-JS tappable month range picker)
- Modify: `mobile/app/schedule/time-off-new.jsx`

- [ ] **Step 1: MonthCalendar** — a dependency-free RN component (OTA-safe). Props: `{ startDate, endDate, minDate, onChange }` where `onChange({ start, end })` returns ISO `YYYY-MM-DD`. Behaviour:
  - Header with `‹  Month YYYY  ›` to navigate months (the whole point — jumping to far-out dates without tapping +1 fifty times). Don't allow navigating before `minDate`'s month.
  - 7-col grid (Mon-start) built by reusing `shared/roster-month.js`: `monthBounds(anchorIso)` → `buildMonthMatrix(monthStartIso, monthEndIso, [], todayIso)` (pass `[]` for shifts). Render `day.dayNum`; dim `!day.inMonth` and disable `day.iso < minDate`.
  - Range select: tapping sets `start` (and clears `end`) unless a `start` is already set with no `end` and the tapped day ≥ `start`, in which case it sets `end`. Highlight the selected day(s) + the in-between range. (Single-day off = start === end.)
  - Show a footer line "From <date> · To <date>".
  - Use NativeWind `un1t-*` classes consistent with the app (blue for selected, like `MonthRoster`/`CalCell`).

- [ ] **Step 2: time-off-new.jsx** —
  - Pull `profile` from `useAuth()` (alongside `activeLocation`). Replace the hard-coded `TYPES` with `timeOffTypesFor(profile?.employment_type)` from `../../shared/time-off` (relative path — mobile can't use the `@shared` alias), and initialise `type` via `defaultTimeOffTypeFor(...)`. When only one type, render a single static row ("Type: Unavailable") instead of the segmented control.
  - Replace the two `DateRow` steppers (and the `DateRow` component) with `<MonthCalendar startDate={start} endDate={end} minDate={today} onChange={({start,end}) => { setStart(start); setEnd(end || start) }} />`.
  - Keep the submit flow (`createTimeOffRequest`) unchanged; ensure `start`/`end` are still ISO strings.
  - Remove the now-unused `addDays`/`dateMath` if nothing else uses them (leave `isoDate`).

- [ ] **Step 3: Mobile checks** —
  - `cd /Users/richardivers/code/un1t-crm-ct && npm run check:mobile-imports 2>&1 | tail -6` (clean — verify `../../shared/time-off` + `../../shared/roster-month` resolve and export the named bindings).
  - `cd mobile && npx expo export --platform ios` (must succeed; if the worktree `mobile/` lacks node_modules, symlink the main repo's `mobile/node_modules` temporarily and use `./node_modules/.bin/expo`, then remove the symlink + `dist/` before committing — do NOT stage either).

- [ ] **Step 4: Commit** (explicit paths — NOT `git add -A`; the worktree `node_modules` symlink isn't matched by `.gitignore`):
  `git -C /Users/richardivers/code/un1t-crm-ct add mobile/components/MonthCalendar.jsx mobile/app/schedule/time-off-new.jsx && git -C … commit -m "TIMEOFF (mobile) — employment-gated types + JS month-calendar date picker"`

---

## Task 5: Review + CI mirror + PR

- [ ] **Step 1: Full CI mirror** — `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards` (all green; no new permission key → parity unaffected).
- [ ] **Step 2: Push + PR (base=main)** — title `TIMEOFF — employment-gated time-off types + mobile calendar picker`. Body: the contractor/casual→Unavailable gating; FTE keeps all 4 (now genuinely valid — mig 283 fixed the latent bug where Unpaid/Other silently failed); manager screen + reports widened; mobile +/− stepper replaced with a JS month calendar (OTA-safe). Cite mig 283 (already applied to prod). Not browser/device-verified (auth-gated).

## Self-review
- Spec coverage: contractor/casual → Unavailable only ✓; FTE → 4 working leave types ✓ (mig 283 + schema + every layer); mobile calendar ✓ (JS, OTA). Five-type set coherent across DB / Zod / web form / manager screen / reports / mobile form.
- No new permission key, no parity impact. Migration already applied + filed (283).
- `employment_type` read from `user.employment_type` (web) / `profile.employment_type` (mobile) — both already populated.
