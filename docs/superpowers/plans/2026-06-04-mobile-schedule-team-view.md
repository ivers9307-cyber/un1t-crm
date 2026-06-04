# Mobile Schedule "Me" / "Team" Toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Me` / `Team` segmented control to the mobile Schedule tab so a coach can flip between their own shifts and the studio's full roster for the selected day.

**Architecture:** Mobile-only. A new pure helper module (`mobile/lib/schedule-team.js`) owns the effective-time resolution + team-roster sort/group logic and is unit-tested under vitest. A thin `getTeamShifts` helper calls the **existing** service-role `GET /api/schedule/shifts` route *without* the `profile_id` filter — that route already embeds `profiles(full_name, role, avatar_url)` per shift, so no new route, migration, or permission is needed. `mobile/app/(tabs)/schedule.jsx` gains a `view` state that branches the fetch and the selected-day render.

**Tech Stack:** Expo / React Native, expo-router, NativeWind (Tailwind tokens), Vitest (pure helpers under `mobile/lib/**`).

**Spec:** `docs/superpowers/specs/2026-06-04-mobile-schedule-team-view-design.md`

**Branch:** `mobile-schedule-team-view` (already checked out, spec committed).

---

## File Structure

| File | Responsibility |
|---|---|
| `mobile/lib/schedule-team.js` | **new** — pure: `effShiftStart`/`effShiftEnd` (moved here, single definition), `teamRosterForDay`, `initials`. No React/Supabase imports. |
| `mobile/lib/schedule-team.test.js` | **new** — vitest unit tests for the above. |
| `mobile/lib/schedule-api.js` | add `getTeamShifts({ locationId, startDate, endDate })`. |
| `mobile/app/(tabs)/schedule.jsx` | import the helpers (drop the local `effShift*`), add `view` state + segmented control, branch the fetch, add read-only `TeamShiftRow`, thread `teamMode` into the iPad grid, add the Team empty state. |

No web, schema, permission, or API-route changes. `shared/permissions.js` is untouched, so `check:mobile-parity` is unaffected.

### Data shape reference (the row both Me and Team render)

`GET /api/schedule/shifts` returns rows from `src/lib/roster-read.js#toApiShiftRow`. Each row:

```js
{
  id,                       // = shift_assignment id (React key, swap id)
  location_id, profile_id, shift_template_id, shift_date,  // 'YYYY-MM-DD'
  start_time_override,      // collapsed EFFECTIVE override, or null (no top-level start_time!)
  end_time_override,        // collapsed EFFECTIVE override, or null
  role_label, notes, status, published,
  shift_templates: { name, start_time, end_time, role_label, ... },  // template defaults
  profiles: { id, full_name, email, avatar_url, role },              // assignee (service-role embed)
  shift_assignment_id, partial_reason,
}
```

Note there is **no top-level `start_time`/`end_time`** — only the override + the joined template. Effective time = `start_time_override || shift_templates.start_time`. (`effShiftStart` keeps the legacy `|| s.start_time ||` middle term for faithfulness; it's always `undefined` on these rows but harmless.)

---

## Task 1: Pure helper module `mobile/lib/schedule-team.js` (TDD)

**Files:**
- Create: `mobile/lib/schedule-team.js`
- Test: `mobile/lib/schedule-team.test.js`

- [ ] **Step 1: Write the failing tests**

Create `mobile/lib/schedule-team.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { effShiftStart, effShiftEnd, initials, teamRosterForDay } from './schedule-team'

describe('initials', () => {
  it('first + last initial for multi-word names', () => {
    expect(initials('Mark Doyle')).toBe('MD')
    expect(initials('mary jane watson')).toBe('MW')
  })
  it('single letter for one-word names', () => {
    expect(initials('Cher')).toBe('C')
  })
  it('returns ? for empty / missing', () => {
    expect(initials('')).toBe('?')
    expect(initials(null)).toBe('?')
    expect(initials(undefined)).toBe('?')
  })
})

describe('effShiftStart / effShiftEnd', () => {
  it('prefers the override, falls back to the template default', () => {
    const base = { shift_templates: { start_time: '09:00:00', end_time: '13:00:00' } }
    expect(effShiftStart(base)).toBe('09:00:00')
    expect(effShiftEnd(base)).toBe('13:00:00')
    expect(effShiftStart({ ...base, start_time_override: '10:00:00' })).toBe('10:00:00')
    expect(effShiftEnd({ ...base, end_time_override: '12:30:00' })).toBe('12:30:00')
  })
  it('returns null when there is no time at all', () => {
    expect(effShiftStart({})).toBeNull()
    expect(effShiftEnd(null)).toBeNull()
  })
})

describe('teamRosterForDay', () => {
  const row = (id, day, name, start, profileId) => ({
    id,
    shift_date: day,
    profile_id: profileId,
    profiles: { id: profileId, full_name: name },
    shift_templates: { name: 'Floor', start_time: start, end_time: '13:00:00' },
  })

  it('filters to the given date', () => {
    const shifts = [
      row('a', '2026-06-04', 'Anna', '09:00:00', 'p1'),
      row('b', '2026-06-05', 'Ben', '09:00:00', 'p2'),
    ]
    expect(teamRosterForDay(shifts, '2026-06-04', 'pX').map(s => s.id)).toEqual(['a'])
  })

  it('sorts by effective start time then name', () => {
    const shifts = [
      row('late', '2026-06-04', 'Zoe', '13:00:00', 'p1'),
      row('earlyB', '2026-06-04', 'Bob', '09:00:00', 'p2'),
      row('earlyA', '2026-06-04', 'Amy', '09:00:00', 'p3'),
    ]
    expect(teamRosterForDay(shifts, '2026-06-04', 'pX').map(s => s.id))
      .toEqual(['earlyA', 'earlyB', 'late'])
  })

  it('respects a per-assignment override when sorting', () => {
    const base = row('ovr', '2026-06-04', 'Overrider', '08:00:00', 'p1')
    base.start_time_override = '14:00:00' // template says 08:00 but really starts 14:00
    const other = row('fixed', '2026-06-04', 'Fixed', '09:00:00', 'p2')
    expect(teamRosterForDay([base, other], '2026-06-04', 'pX').map(s => s.id))
      .toEqual(['fixed', 'ovr'])
  })

  it('marks the signed-in user’s own rows isSelf', () => {
    const shifts = [
      row('mine', '2026-06-04', 'Me', '09:00:00', 'me'),
      row('theirs', '2026-06-04', 'Them', '10:00:00', 'them'),
    ]
    const out = teamRosterForDay(shifts, '2026-06-04', 'me')
    expect(out.find(s => s.id === 'mine').isSelf).toBe(true)
    expect(out.find(s => s.id === 'theirs').isSelf).toBe(false)
  })

  it('returns [] for a day with nobody rostered, and tolerates non-arrays', () => {
    expect(teamRosterForDay([], '2026-06-04', 'me')).toEqual([])
    expect(teamRosterForDay(null, '2026-06-04', 'me')).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run mobile/lib/schedule-team.test.js`
Expected: FAIL — `Failed to load .../schedule-team` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `mobile/lib/schedule-team.js`:

```js
// Pure helpers for the Schedule tab's Team view (the Me / Team toggle).
//
// Lives in mobile/lib so the root vitest picks it up (vitest.config.js
// includes mobile/lib/**). No React, no Supabase — pure functions over the
// shift-row shape returned by GET /api/schedule/shifts (see
// src/lib/roster-read.js#toApiShiftRow): each row carries start_time_override
// (collapsed EFFECTIVE override, or null), shift_templates { start_time,
// end_time, name, role_label }, shift_date, profile_id, and
// profiles { id, full_name, avatar_url, role }.

// Effective shift times. The API row has no top-level start_time/end_time —
// only the collapsed override + the joined template default. Resolve
// override → (legacy row) → template. Single definition shared by the Team
// sort helper AND the Schedule screen (which imports these back).
export const effShiftStart = (s) =>
  s?.start_time_override || s?.start_time || s?.shift_templates?.start_time || null
export const effShiftEnd = (s) =>
  s?.end_time_override || s?.end_time || s?.shift_templates?.end_time || null

// Up-to-2-letter initials for an avatar fallback: first letter of the first
// word + first letter of the last word, uppercased. Single word → one letter.
// Empty / missing → '?'.
export function initials(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// The selected day's team roster: every shift whose shift_date === iso,
// sorted by effective start time then assignee name, each annotated with
// isSelf (true for the signed-in user's own rows). Pure — no IO.
export function teamRosterForDay(shifts, iso, selfProfileId) {
  return (Array.isArray(shifts) ? shifts : [])
    .filter((s) => s && s.shift_date === iso)
    .map((s) => ({ ...s, isSelf: s.profile_id === selfProfileId }))
    .sort((a, b) => {
      const sa = effShiftStart(a) || ''
      const sb = effShiftStart(b) || ''
      if (sa !== sb) return sa < sb ? -1 : 1
      return (a.profiles?.full_name || '').localeCompare(b.profiles?.full_name || '')
    })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run mobile/lib/schedule-team.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/schedule-team.js mobile/lib/schedule-team.test.js
git commit -m "MOBILE-SCHED-TEAM.1 — pure schedule-team helpers (effShift*, teamRosterForDay, initials) + tests"
```

---

## Task 2: `getTeamShifts` data helper

**Files:**
- Modify: `mobile/lib/schedule-api.js` (after `getMyShifts`, ~line 13)

No unit test: this is a thin `URLSearchParams` + `api()` wrapper whose only consumer is the screen, exactly like the existing untested `getMyShifts`. It imports `./api` (which pulls in `expo-secure-store`), so it isn't a clean vitest target. It's validated by `expo export` + on-device in Task 4.

- [ ] **Step 1: Add the helper**

In `mobile/lib/schedule-api.js`, immediately after the `getMyShifts` function (the one ending `return api(\`/api/schedule/shifts?${qs.toString()}\`, { locationId })` near line 13), add:

```js
export function getTeamShifts({ locationId, startDate, endDate }) {
  // Same route as getMyShifts but WITHOUT profile_id → the whole location's
  // roster for the date range. GET /api/schedule/shifts is service-role and
  // already embeds profiles(full_name, role, avatar_url) per shift, so the
  // names come back without a mobile-direct profiles embed (the authenticated
  // client can't SELECT profiles — see CLAUDE.md "Lessons learned").
  const qs = new URLSearchParams()
  if (locationId) qs.set('location_id', locationId)
  if (startDate) qs.set('start_date', startDate)
  if (endDate) qs.set('end_date', endDate)
  return api(`/api/schedule/shifts?${qs.toString()}`, { locationId })
}
```

- [ ] **Step 2: Verify it parses (no test)**

Run: `npx eslint mobile/lib/schedule-api.js`
Expected: clean (0 errors).

- [ ] **Step 3: Commit**

```bash
git add mobile/lib/schedule-api.js
git commit -m "MOBILE-SCHED-TEAM.2 — getTeamShifts (location roster, no profile_id filter)"
```

---

## Task 3: Wire the toggle into `mobile/app/(tabs)/schedule.jsx`

**Files:**
- Modify: `mobile/app/(tabs)/schedule.jsx`

One commit at the end (the intermediate edits leave `setView` unused, which would trip eslint, so they land together).

- [ ] **Step 1: Add `Image` to the react-native import**

Replace (lines ~15-19):

```jsx
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator, Alert, Modal, TextInput, KeyboardAvoidingView,
  Platform,
} from 'react-native'
```

with:

```jsx
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator, Alert, Modal, TextInput, KeyboardAvoidingView,
  Platform, Image,
} from 'react-native'
```

- [ ] **Step 2: Add `getTeamShifts` + the schedule-team imports**

Replace (lines ~27-29):

```jsx
import {
  getMyShifts, getMyTimeOff, createSwapRequest, adjustShiftAssignment,
} from '../../lib/schedule-api'
```

with:

```jsx
import {
  getMyShifts, getTeamShifts, getMyTimeOff, createSwapRequest, adjustShiftAssignment,
} from '../../lib/schedule-api'
```

Then, immediately after the `useIsTablet` import line (`import { useIsTablet } from '../../lib/use-is-tablet'`), add:

```jsx
import { effShiftStart, effShiftEnd, teamRosterForDay, initials } from '../../lib/schedule-team'
```

- [ ] **Step 3: Remove the now-duplicated local `effShift*` definitions**

Replace (lines ~70-77 — the "Effective shift times…" comment block plus the two `const` lines):

```jsx
// Effective shift times. The base block times live on the joined
// shift_template; the legacy `shifts` row only carries per-assignment
// overrides (mig 099/100), so reading shift.start_time alone yields
// null for un-adjusted shifts and renders "— · 0h". Mirror the
// dashboard's resolution (override → row → template) so the Schedule
// tab shows the same time + duration.
const effShiftStart = (s) => s.start_time_override || s.start_time || s.shift_templates?.start_time || null
const effShiftEnd = (s) => s.end_time_override || s.end_time || s.shift_templates?.end_time || null
```

with:

```jsx
// effShiftStart / effShiftEnd now live in ../../lib/schedule-team (imported
// above) — single definition shared with the Team sort helper.
```

(Leave the `// STUDIO-IPAD.2 — compact shift card…` comment lines directly above untouched.)

- [ ] **Step 4: Add `teamMode` + `selfId` to `ShiftCard` (iPad card)**

Replace the `ShiftCard` function signature + opening (lines ~79-93):

```jsx
function ShiftCard({ shift, onPress, onLongPress }) {
  const tpl = shift.shift_templates
  const effStart = effShiftStart(shift)
  const effEnd = effShiftEnd(shift)
  const adjusted = !!(shift.start_time_override || shift.end_time_override)
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      className="bg-un1t-surface border border-un1t-border rounded-xl p-2.5 mb-2 active:opacity-70"
    >
      <Text className="text-sm font-semibold text-un1t-text" numberOfLines={1}>
        {tpl?.name || 'Shift'}
      </Text>
```

with:

```jsx
function ShiftCard({ shift, onPress, onLongPress, teamMode, selfId }) {
  const tpl = shift.shift_templates
  const effStart = effShiftStart(shift)
  const effEnd = effShiftEnd(shift)
  const adjusted = !!(shift.start_time_override || shift.end_time_override)
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      className="bg-un1t-surface border border-un1t-border rounded-xl p-2.5 mb-2 active:opacity-70"
    >
      {teamMode && (
        <Text className="text-sm font-semibold text-un1t-text" numberOfLines={1}>
          {shift.profiles?.full_name?.split(' ')[0] || 'Unknown'}
          {shift.profile_id === selfId ? ' (You)' : ''}
        </Text>
      )}
      <Text
        className={teamMode
          ? 'text-[11px] text-un1t-subtle mt-0.5'
          : 'text-sm font-semibold text-un1t-text'}
        numberOfLines={1}
      >
        {tpl?.name || 'Shift'}
      </Text>
```

(The line below this — `<Text className="text-[11px] text-un1t-subtle mt-0.5">{timeRange(effStart, effEnd)}</Text>` — stays as-is.)

- [ ] **Step 5: Thread `teamMode`/`selfId` through `WeekGridView` + read-only + effShift sort**

Replace the `WeekGridView` signature (line ~127):

```jsx
function WeekGridView({ anchor, shiftsByDate, timeOff, todayIso, canAdjust, openAdjust, requestSwap }) {
```

with:

```jsx
function WeekGridView({ anchor, shiftsByDate, timeOff, todayIso, canAdjust, openAdjust, requestSwap, teamMode, selfId }) {
```

Replace the `dayShifts` sort (lines ~133-134):

```jsx
        const dayShifts = (shiftsByDate[iso] || []).slice().sort((a, b) =>
          (a.start_time || '').localeCompare(b.start_time || ''))
```

with (sort by EFFECTIVE start so cards order by time in both modes — API rows have no top-level `start_time`, so the old sort was a no-op):

```jsx
        const dayShifts = (shiftsByDate[iso] || []).slice().sort((a, b) =>
          (effShiftStart(a) || '').localeCompare(effShiftStart(b) || ''))
```

Replace the per-card render inside `WeekGridView` (lines ~162-169):

```jsx
            {dayShifts.map(s => (
              <ShiftCard
                key={s.id}
                shift={s}
                onPress={canAdjust(s) ? () => openAdjust(s) : undefined}
                onLongPress={() => requestSwap(s)}
              />
            ))}
```

with (Team mode is read-only — no adjust / swap):

```jsx
            {dayShifts.map(s => (
              <ShiftCard
                key={s.id}
                shift={s}
                teamMode={teamMode}
                selfId={selfId}
                onPress={teamMode ? undefined : (canAdjust(s) ? () => openAdjust(s) : undefined)}
                onLongPress={teamMode ? undefined : () => requestSwap(s)}
              />
            ))}
```

- [ ] **Step 6: Add the read-only `TeamShiftRow` component (iPhone)**

Insert this function immediately **before** `function ShiftRow({ shift, onPress, onLongPress }) {` (line ~177):

```jsx
// Team mode — one rostered colleague's shift for the selected day.
// Read-only (no adjust / swap). Avatar with initials fallback, name with a
// "You" chip for the signed-in user, shift name + time, role chip.
function TeamShiftRow({ shift }) {
  const tpl = shift.shift_templates
  const p = shift.profiles || {}
  const effStart = effShiftStart(shift)
  const effEnd = effShiftEnd(shift)
  const hours = hoursBetween(effStart, effEnd)
  const role = (p.role || '').replace(/_/g, ' ')
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 flex-row items-center">
      <View className="w-10 h-10 rounded-full bg-un1t-border items-center justify-center mr-3 overflow-hidden">
        {p.avatar_url
          ? <Image source={{ uri: p.avatar_url }} style={{ width: 40, height: 40 }} />
          : <Text className="text-sm font-semibold text-un1t-text">{initials(p.full_name)}</Text>}
      </View>
      <View className="flex-1">
        <View className="flex-row items-center">
          <Text className="text-base font-semibold text-un1t-text" numberOfLines={1}>
            {p.full_name || 'Unknown'}
          </Text>
          {shift.isSelf && (
            <View className="ml-2 px-2 py-0.5 rounded-full bg-un1t-text">
              <Text className="text-[10px] uppercase font-bold text-un1t-bg">You</Text>
            </View>
          )}
        </View>
        <View className="flex-row items-center mt-0.5">
          <Ionicons name="time-outline" size={13} color="#64748B" />
          <Text className="text-sm text-un1t-subtle ml-1" numberOfLines={1}>
            {tpl?.name ? `${tpl.name} · ` : ''}{timeRange(effStart, effEnd)} · {hours}h
          </Text>
        </View>
      </View>
      {role ? (
        <View className="ml-2 px-2 py-0.5 rounded-full bg-un1t-border">
          <Text className="text-[10px] uppercase font-medium text-un1t-subtle">{role}</Text>
        </View>
      ) : null}
    </View>
  )
}
```

- [ ] **Step 7: Add the `view` state**

In `Schedule()`, immediately after `const [error, setError] = useState(null)` (line ~244), add:

```jsx
  const [view, setView] = useState('me') // 'me' | 'team'
```

- [ ] **Step 8: Branch `fetchWeek` by view**

Replace the whole `fetchWeek` callback (lines ~249-267):

```jsx
  const fetchWeek = useCallback(async () => {
    if (!profile || !activeLocation) return
    setError(null)
    const [shiftsRes, timeOffRes] = await Promise.all([
      getMyShifts({
        locationId: activeLocation.id,
        profileId: profile.id,
        startDate: start,
        endDate: end,
      }),
      getMyTimeOff({
        locationId: activeLocation.id,
        profileId: profile.id,
      }),
    ])
    if (!shiftsRes.success) setError(shiftsRes.error || 'Failed to load shifts')
    setShifts(shiftsRes.success ? shiftsRes.data || [] : [])
    setTimeOff(timeOffRes.success ? timeOffRes.data || [] : [])
  }, [profile, activeLocation, start, end])
```

with:

```jsx
  const fetchWeek = useCallback(async () => {
    if (!profile || !activeLocation) return
    setError(null)
    if (view === 'team') {
      // Team: the whole location's roster for the week (no profile_id). No
      // time-off in Team mode — it shows who's working, not who's off.
      const shiftsRes = await getTeamShifts({
        locationId: activeLocation.id,
        startDate: start,
        endDate: end,
      })
      if (!shiftsRes.success) setError(shiftsRes.error || 'Failed to load roster')
      setShifts(shiftsRes.success ? shiftsRes.data || [] : [])
      setTimeOff([])
      return
    }
    const [shiftsRes, timeOffRes] = await Promise.all([
      getMyShifts({
        locationId: activeLocation.id,
        profileId: profile.id,
        startDate: start,
        endDate: end,
      }),
      getMyTimeOff({
        locationId: activeLocation.id,
        profileId: profile.id,
      }),
    ])
    if (!shiftsRes.success) setError(shiftsRes.error || 'Failed to load shifts')
    setShifts(shiftsRes.success ? shiftsRes.data || [] : [])
    setTimeOff(timeOffRes.success ? timeOffRes.data || [] : [])
  }, [profile, activeLocation, start, end, view])
```

(`view` is now in the deps, so toggling re-runs `fetchWeek` via the existing `useEffect([fetchWeek])` with the loading spinner.)

- [ ] **Step 9: Compute the selected day's team roster**

Immediately after the `todays` declaration (lines ~297-299, the `const todays = (shiftsByDate[selectedIso] || [])...` block), add:

```jsx
  // Team mode: everyone rostered on the selected day (sorted + self-marked).
  const teamToday = useMemo(
    () => (view === 'team' ? teamRosterForDay(shifts, selectedIso, profile?.id) : []),
    [view, shifts, selectedIso, profile?.id]
  )
```

- [ ] **Step 10: Add the segmented control at the top of the ScrollView**

Immediately after the `<ScrollView ...>` opening tag and its `refreshControl=...>` (i.e. right before `{/* Week header */}` at line ~355), insert:

```jsx
        {/* Me / Team segmented control */}
        <View className="flex-row bg-un1t-surface border border-un1t-border rounded-xl p-1 mb-4">
          {[['me', 'Me'], ['team', 'Team']].map(([val, label]) => {
            const active = view === val
            return (
              <Pressable
                key={val}
                onPress={() => setView(val)}
                className={`flex-1 items-center py-2 rounded-lg ${active ? 'bg-un1t-text' : ''}`}
              >
                <Text className={`text-sm font-semibold ${active ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>
                  {label}
                </Text>
              </Pressable>
            )
          })}
        </View>
```

- [ ] **Step 11: Pass `teamMode`/`selfId` into the iPad `WeekGridView` + hide time-off in Team**

Replace the iPad branch (lines ~401-412):

```jsx
        ) : isTablet ? (
          <View className="mt-2">
            <WeekGridView
              anchor={anchor}
              shiftsByDate={shiftsByDate}
              timeOff={timeOff}
              todayIso={isoDate(new Date())}
              canAdjust={canAdjust}
              openAdjust={setAdjustingShift}
              requestSwap={requestSwapForShift}
            />
          </View>
        ) : (
```

with:

```jsx
        ) : isTablet ? (
          <View className="mt-2">
            <WeekGridView
              anchor={anchor}
              shiftsByDate={shiftsByDate}
              timeOff={view === 'team' ? [] : timeOff}
              todayIso={isoDate(new Date())}
              canAdjust={canAdjust}
              openAdjust={setAdjustingShift}
              requestSwap={requestSwapForShift}
              teamMode={view === 'team'}
              selfId={profile?.id}
            />
          </View>
        ) : view === 'team' ? (
          <>
            {teamToday.length === 0 ? (
              <View className="py-10 items-center">
                <Ionicons name="people-outline" size={28} color="#94A3B8" />
                <Text className="text-sm text-un1t-subtle mt-2">
                  No one’s rostered on {selected.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric' })}.
                </Text>
              </View>
            ) : (
              teamToday.map(s => <TeamShiftRow key={s.id} shift={s} />)
            )}
          </>
        ) : (
```

(The existing `<>…</>` Me-mode block that follows — `todaysLeave.map`, the empty state, `todays.map(<ShiftRow/>)`, the "Tap to adjust…" hint — stays exactly as-is and is now the final `: (` branch.)

- [ ] **Step 12: Verify the bundle compiles**

Run: `cd mobile && npx expo export --platform ios`
Expected: `Exported: dist` with no error (new imports — `getTeamShifts`, `schedule-team`, `Image` — all resolve). Then `rm -rf dist`.

- [ ] **Step 13: Commit**

```bash
git add mobile/app/\(tabs\)/schedule.jsx
git commit -m "MOBILE-SCHED-TEAM.3 — Me/Team toggle on the Schedule tab (read-only team roster)"
```

---

## Task 4: Verify + ship

**Files:** none (CI mirror + build + PR).

- [ ] **Step 1: Run the full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity`
Expected: vitest all green (includes the new `schedule-team.test.js`), eslint 0 errors, parity exit 0 (unchanged — no permission edits).

- [ ] **Step 2: Re-confirm the iOS bundle**

Run: `cd mobile && rm -rf dist && npx expo export --platform ios && rm -rf dist && cd ..`
Expected: `Exported: dist`, no errors.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin mobile-schedule-team-view
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --base main --head mobile-schedule-team-view \
  --title "MOBILE-SCHED-TEAM — Me/Team toggle on the mobile Schedule tab" \
  --body "Adds a Me/Team segmented control to the mobile Schedule tab. Team shows the selected day's full studio roster (read-only; avatar · name · shift · time · role, your row marked 'You'). Reuses the existing service-role GET /api/schedule/shifts route without the profile_id filter — no new route, migration, or permission. Verified: vitest green (new schedule-team tests), lint 0 errors, parity clean, expo export compiles. NOTE: merging touches mobile/** → auto-publishes a production OTA."
```

- [ ] **Step 5: STOP — ask the user before merging**

Merging touches `mobile/**`, which auto-publishes a **production OTA** to staff devices. Do **not** merge automatically. Report the PR URL and the on-device test checklist below, and wait for the user's go.

**On-device smoke test (the user, or a TestFlight/dev build):**
- Toggle Me ↔ Team; Team lists everyone rostered on the selected day with names.
- Switch days via the week strip in Team mode; counts/coverage reflect the team.
- Your own row shows the "You" chip; rows are read-only (no adjust/swap).
- A day with nobody rostered shows the empty state.
- Pull-to-refresh works in both modes; impersonation ("View as user") reflects the effective user's active location.

---

## Self-Review

**Spec coverage:** toggle (Task 3 step 10) ✓ · Me unchanged (Me branch untouched) ✓ · Team read-only roster for selected day (TeamShiftRow + teamToday) ✓ · reuse route w/o profile_id (Task 2) ✓ · include-self-marked (`isSelf` + "You" chip) ✓ · read-only v1 (no onPress/onLongPress in Team) ✓ · no time-off in Team (fetch branch sets `setTimeOff([])`; iPad passes `[]`) ✓ · avatar+initials (TeamShiftRow) ✓ · sort by effShiftStart then name (teamRosterForDay) ✓ · empty state ✓ · iPad name-on-card (ShiftCard teamMode) ✓ · pure helper unit-tested under mobile/lib (Task 1) ✓ · no permission/parity change ✓.

**Placeholder scan:** none — every code step is complete.

**Type/name consistency:** `effShiftStart`/`effShiftEnd`/`teamRosterForDay`/`initials` exported by Task 1 and imported in Task 3; `getTeamShifts({ locationId, startDate, endDate })` defined in Task 2 and called in Task 3 step 8; `view`/`setView`/`teamToday`/`teamMode`/`selfId` consistent across steps; row props (`shift_date`, `start_time_override`, `shift_templates`, `profiles.full_name/avatar_url/role`, `profile_id`) match the documented `toApiShiftRow` shape.

**Known pre-existing behaviour intentionally left alone:** the Me-mode iPhone `todays` sort uses `a.start_time` (always undefined on API rows → effectively unsorted). Not changed here to avoid any Me-mode regression; Team sorts correctly via `effShiftStart`. The iPad grid sort *is* upgraded to `effShiftStart` (strictly better ordering, applies to both modes) since that line is edited anyway.
