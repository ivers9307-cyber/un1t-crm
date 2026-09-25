## PR AVAIL.2 — coaches set their own availability on the phone

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone screen, "My availability", where any staff member says when they CANNOT work: weekly windows (a weekday, all day or a time window) and dated exceptions (one day or a range, all day or a same-day window, a note of up to 200 characters). It saves with ONE `PUT /api/schedule/availability`, which replaces what was stored (AVAIL.1a). On a refusal it shows the server's words against the right entry. On success it says "Saved". A save that changes nothing is never sent. It is reached from a "My availability" row on the Schedule tab (Me view), for every role. The managers' push about a change ("Availability changed", AVAIL.1a) gets a tap destination.

**Why:** AVAIL.1a built the rules, the API and the manager notice. AVAIL.1b built the web editor. Coaches live on their phones, and availability is only useful if coaches actually fill it in. CANDIDATES.1 (19), GRID.1 (21) and REPLACE.1 (20) read what coaches store here.

**Depends on 16 AVAIL.1a, MERGED and LIVE** (mig 630 applied, the route deployed). Written against the unmerged `avail-1a` branch at `53fcba21` (worktree `~/code/un1t-crm-avail1a`), which already includes its review fixes 4, 5 and 6: an ended rule sent back unchanged is dropped by the server, a new or changed dated rule may not start before today, and shortening a started rule keeps its elapsed days. Phone paths and line numbers are verified against `origin/main` `fa7fedcb` (#1759). **If main or 1a moves before the build, find each anchor by the quoted text, not the number.** AVAIL.1b does not need to be merged: the phone does not use it.

**Size / ships:** M. **No migration. No API change. OTA**: every file touched is under `mobile/app/**`, `mobile/components/**` or `mobile/lib/**`, which are bundle paths (`.github/workflows/eas-update.yml:154-156`). Merging publishes a phone update at 100% on the current runtime lane. **No native dependency**, so no store build and no `runtimeVersion` bump.

**DEPLOY ORDER:**
1. AVAIL.1a is merged, mig 630 is applied, and `GET /api/schedule/availability` answers `{ success: true, data: { weekly, dated } }` on prod. Its OTA (shared/) has published and its EAS Update run is green.
2. Merge this PR. The phone update publishes. A phone without it simply has no "My availability" row, and a manager's tap on an "Availability changed" push opens the app without navigating (today's behaviour for an unknown type).

**Worktree:** a fresh worktree off `origin/main` once AVAIL.1a is there: `git fetch origin main && git worktree add ../un1t-crm-avail2 -b avail-2 origin/main`, then `npm ci`. Never `git stash`. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the PR gate (8GB machine).

**Rules that bite in this PR (read `CLAUDE.md` Invariants first):**
- **Mobile cannot import `src/lib`.** The rules come from `shared/availability` (the `shared` file: package), imported with a bare `'shared/availability'`, never `../shared`. `check:mobile-imports` fails on a name `shared/availability.js` does not export.
- **`/api` calls go through `api()`** (`mobile/lib/api.js:92`). It adds the Bearer token and `x-impersonate-target`, so "View as user" edits the viewed person's availability (the route pins everything to `user.id`, and the master is recorded as the actor). A hand-rolled `fetch` would drop the impersonation header.
- **There is no React Native component test runner.** Every decision (form state → PUT body, dedupe, validation words, dirty check, the server's answer → what the screen says) lives in `mobile/lib/availability-form.js`, with a vitest table beside it. The `.jsx` files only render.
- **`api()` never throws.** It answers `{ success: false, transport: true }` when there was no server answer, and `status` on a non-2xx. It also answers `transport: true` for a non-JSON body **after** the request may have landed (a 504 edge page). A replace is idempotent, so "save again" is safe advice either way.
- **The PUT REPLACES.** A save made after a FAILED load would send an empty form and wipe every rule the coach has. Save is impossible until a load has succeeded.
- **Quiet hours gate the notice, never the save** (AVAIL.1a). The phone says "your managers will get a notification", never "have been notified".
- **A merge is not a publish, and one phone update at a time.** After merging, check the EAS Update run before merging another OTA PR (CANDIDATES.1 is this batch's partner and also publishes).
- **NativeWind compiles only class names it can see.** Tone classes are written out as whole literals in a map.
- **The repo is PUBLIC.** Fixtures use no real names.

---

### What AVAIL.1a gives this PR (verified at `avail-1a` `53fcba21`)

| What | Where | Used how |
|---|---|---|
| `GET /api/schedule/availability` (no query) | `src/app/api/schedule/availability/route.js:38` | The caller's own `{ weekly, dated }` in canonical form (sorted, `HH:MM`, no ids). Dated rules that ended before today (Dublin) are not returned. Cookie or Bearer. |
| `PUT /api/schedule/availability` `{ weekly, dated }` | same file, `:78` | Replaces the caller's weekly rules and their not-yet-ended dated rules. 200 `{ success: true, data: { changed, weekly, dated } }` (`:139`), where `weekly`/`dated` are what is stored after the save. 400 `{ success: false, error: 'Invalid availability', issues: [{ path: 'dated.3', message }] }`; **paths index the SORTED lists**. A Zod shape error is 400 `'Invalid request body'` with paths like `weekly.0.start_time`. An RPC refusal is 400 with its own words as `error` and no issues (`'a date that has already passed cannot be added'`, `'a new date cannot start before today'`). 401 unauthenticated. 500 `'Could not save your availability'`. |
| Server rule: an ended rule sent back | route `PUT`, `readKnownDatedKeys` (`src/lib/availability-server.js:78`), `withoutEnded` | An ended dated rule the coach already has (same content) is dropped before saving. A NEW ended rule is refused ('That date has passed'). |
| Server rule: no backdating | `ruleProblem(rule, { todayIso, knownKeys })` (`shared/availability.js:159`) | A dated rule starting before today is refused ('Start today or later') unless the coach already has it by content (`ruleKey`, window without the note). A note edit stays allowed. Judged only when `knownKeys` is given. |
| Pure rules | `shared/availability.js` | `AVAILABILITY_WEEKDAYS`, `AVAILABILITY_WEEKDAY_LABELS`, `AVAILABILITY_LIMITS` (`weekly 28, dated 60, noteChars 200, spanDays 366, aheadDays 730`), `normaliseRule`, `normaliseAvailability`, `ruleKey` (`:144`), `ruleProblem` (`:159`), `withoutEnded` (`:190`), `sameAvailability` (`:287`), `describeRule`. |
| The manager push | `src/lib/availability-notify.js:188-189` | `category: 'availability_change'`, `data: { type: 'availability_changed', profile_id, change_id }`. Sent to roster builders and masters at the coach's studios, never to the person who made the change. |
| The notification toggle | `shared/permissions.js` (1a: `:727`) | `notify_availability_change`, label "… Availability changes", `mobileOnly: true, isNotify: true`, default on for all six roles. **It renders with no change here**: the phone's staff permissions editor lists `MOBILE_PERMISSIONS.filter(p => p.isNotify)` (`mobile/app/(staff)/staff/permissions/[id].jsx:29`), and the web lists the same filter (`src/components/RolePermissions.jsx:137`, `src/components/StaffForm.jsx:1102`). Task 0 verifies it. |

---

### Decisions (made here, each justified)

**D1. Where it lives: a "My availability" row on the Schedule tab, Me view, opening a modal at `mobile/app/(staff)/schedule/availability.jsx` (route `/schedule/availability`).** The schedule modal stack (`mobile/app/(staff)/schedule/_layout.jsx`, `presentation: 'modal'`) already holds the coach's own schedule forms: `time-off-new.jsx` and `my-leave.jsx`. The Me view is where a coach looks at their own week. The row is placed directly before the tab's `</ScrollView>` (`mobile/app/(staff)/(tabs)/schedule.jsx:746`), inside `pb-32`, so the floating leave buttons never cover it. ICSFEED.1 (#22, batch 4) mounts its "Subscribe to my shifts" row at the same spot. This row goes AFTER it (Task 8 says how).
- **Every role**: the row has no gate of its own. The Schedule tab (or its More tile) is gated by the `schedule` mobile permission, which defaults on for all six roles (`DEFAULT_MOBILE_PERMISSIONS_BY_ROLE`, `shared/permissions.js:757`; `schedule: true` in every role block). It is **not** gated on `time_off`, which is about leave requests (the floating buttons, `schedule.jsx:748-756`).
- Not a More tile: one entry point, next to the week it affects. If Richard wants one in More too, it is one line (review note 5).

**D2. One screen, two sections ("Every week", "Dates"), a card per rule, Save in the header.** Same fields and the same words as the web editor (`src/components/AvailabilityEditor.jsx` in AVAIL.1b), because the words come from the same `shared/availability.js`. A card shows a one-line summary ("Mondays, all day"), a Remove button, the day (seven weekday chips) or the dates (a button that opens the month calendar inline, one card at a time), an All day switch, From/To times when not all day, and the note. Save and Cancel sit in the header, which is the leave form's pattern (`time-off-new.jsx:181-205`), so Save stays reachable above the keyboard.

**D3. Pickers: reuse, no native dependency.** Dates use `components/MonthCalendar.jsx`, the pure-JS range calendar the leave form uses. Times use a typed field, the AdjustSheet pattern on the Schedule tab (`TextInput`, `keyboardType="numbers-and-punctuation"`, `schedule.jsx` "Start (HH:MM)"), with a tolerant parser in the lib: `9`, `930`, `9:30`, `9.30`, `1730`, `5pm`, `5:30pm` all read, and the field tidies to `HH:MM` when the coach leaves it. `@react-native-community/datetimepicker` is not installed (`mobile/package.json` has no picker), and adding it is a native module, so it would need a store build and could not ship over the air. A pure-JS wheel is possible later (review note 3).

**D4. The replace is guarded four ways, all in the lib:**
- **Load first.** `saveButtonState` is disabled until a load has succeeded (`baseline !== null`), and `isDirty(null, …)` is `false`, so a failed load can never be saved over.
- **No change, no write.** Save is disabled unless `isDirty`. `isDirty` compares the canonical body, so reordering, `9` vs `09:00`, adding an exact copy, or dropping an ended row are not changes. A note-only edit IS one.
- **Canonical body.** The body is `normaliseAvailability` of the rows: sorted, exact duplicates dropped, `HH:MM`, no `kind`. The server's issue paths index the sorted lists, so `keysByPath` maps `'dated.3'` back to the row (or rows, for a merged duplicate) that made it.
- **Ended rows stay out.** A dated row that ended while the screen was open (left open over midnight) is shown greyed with "This date has passed. It is kept as history and left out when you save.", and is not sent. Since 1a review 4 the server would also drop an unchanged one, so this is belt and braces, and it means the phone never depends on that rule. "Today" for a save is `dublinTodayIso()` at the moment of saving, not when the screen opened.

**D5. Backdating: the phone judges it the server's way.** The phone passes `knownKeys` = `ruleKey`s of the LOADED dated rules that started before today (`knownStartedKeys`). The server builds the same set from what is stored. So a rule the coach already has, with any note, is fine. The same rule with a changed window says "Start today or later" before anything is sent. A started rule shows a line under its dates: "This started before today. To change its dates or times, pick new dates from today: the days already gone stay as they were. You can still change the note." (1a review 5 keeps the elapsed days on the server.) The calendar's `minDate` is today, so a new rule cannot start in the past.

**D6. Failures keep the edits, and say which kind of failure it was.** The screen replaces the rows only on success.
- No answer (`transport`): amber, "Couldn't confirm it saved: no connection, or no answer from the server. Your changes are still here, and saving again is safe."
- 401: red, "Not saved: your sign-in has expired. Sign in again, then make these changes again." (There is no retry: signing in resets the app, so the words do not promise the edits survive it.)
- 400 with issues: each issue is shown under its card; list-level issues (`weekly`, `dated`) and anything unmapped join the banner "Not saved. Fix the entries marked below."
- Anything else: red, "Not saved. <the server's words>. Your changes are still here."
- Success: green "Saved. Your managers will get a notification." (or "Saved. Nothing had changed, so nobody was notified." when the server says `changed: false`). The rows are replaced with what the server stored. If the success body cannot be read, the screen reads the rules back with a GET.
- The banner is scrolled into view and announced to VoiceOver/TalkBack.

**D7. Leaving with unsaved edits asks first.** `usePreventRemove(dirty || saving, …)` from `expo-router/react-navigation` (JS only; the vendored react-navigation core exports it in expo-router 57.0.8, the version `mobile/package-lock.json` pins) catches Cancel, the Android back button and the iOS swipe-down, and `gestureEnabled: !dirty && !saving` on the screen options is the belt for the swipe. Dirty asks "Discard your changes?" (Keep editing / Discard). Mid-save nothing leaves. This is the `composeCloseAction` rule from the mail composer (`mobile/lib/mail-compose.js:501`).

**D8. The manager's push opens Manage mode.** `availability_changed` routes to `/(tabs)/schedule?view=manage`: the roster the manager builds (`schedule.jsx` honours `?view=manage` for manager roles only; anyone else lands on their own week, RUNWAY.1). The phone has no per-coach availability view to open. CANDIDATES.1 badges the picker, and the payload carries `profile_id` for a better target later (review note 4).

**D9. A new `mobile/lib/availability-api.js`, not `schedule-api.js`.** `schedule-api.test.js:38` pins that file's export list ("exports exactly the helpers this file pins"), and CANDIDATES.1 / REPLACE.1 are likely to add to it in parallel. A new file cannot conflict. It has its own wire-contract test in the same style.

**D10. New rows default to all day** (a weekly one on Monday, a dated one today, calendar opened). The web weekly default is a time window with empty times. On a phone, typing two times is the expensive part, and "can't do Tuesdays" is the common case. The rules are the same either way.

**D11. The month calendar gets accessibility labels** (additive, `components/MonthCalendar.jsx`): the day cells read as full dates with selected/disabled state, and the arrows read "Previous month" / "Next month". Today VoiceOver reads a bare "25". The leave form benefits too, and nothing else changes.

**D12. "View as user" says whose availability it is.** When `impersonatingFrom` is set, an amber line reads "You are viewing as <name>. Saving changes their availability, and their managers are told." The server records the master as the actor and does not notify them (1a review 7).

**D13. Load once, on open.** No refetch on focus: the screen is a modal, and a refetch would overwrite edits in progress.

**Not touched, on purpose:** the API and the database (AVAIL.1a's contract is used as is), the web (AVAIL.1b), `shared/availability.js` (read only), `mobile/lib/schedule-api.js` (D9), the coach picker `mobile/components/schedule/CoachPickerSheet.jsx` (CANDIDATES.1), time off and its `unavailable` type (AVAIL.3).

---

### File map

| File | Change | OTA bundle path |
|---|---|---|
| `mobile/lib/availability-api.js` (create) | `getMyAvailability()`, `saveMyAvailability(body)` through `api()` | **yes** |
| `mobile/lib/availability-api.test.js` (create) | wire contract | **yes** (test-only over-trigger, accepted per CLAUDE.md) |
| `mobile/lib/availability-form.js` (create) | every decision and every word of the screen | **yes** |
| `mobile/lib/availability-form.test.js` (create) | the decision table | **yes** (test-only over-trigger) |
| `mobile/lib/notification-nav.js` (modify: a case after `roster_runway`, lines 97-100) | `availability_changed` → Manage mode | **yes** |
| `mobile/lib/notification-nav.test.js` (modify: after the RUNWAY.1 `it`, lines 76-82) | the route | **yes** (test-only) |
| `mobile/components/MonthCalendar.jsx` (modify: lines 98-115, 135-140) | accessibility labels and state | **yes** |
| `mobile/app/(staff)/schedule/availability.jsx` (create) | the screen | **yes** |
| `mobile/components/schedule/MyAvailabilityRow.jsx` (create) | the Schedule-tab row | **yes** |
| `mobile/app/(staff)/(tabs)/schedule.jsx` (modify: one import after line 42; one line before `</ScrollView>` at line 746) | mounts the row in the Me view | **yes** |
| `docs/CHANGELOG.md` | one row after `gh pr create` | no |

**No new top-level entry under `mobile/`.** Every new file sits under `mobile/app/`, `mobile/components/` or `mobile/lib/`, which are already in the `eas-update.yml` trigger (lines 154-156), so `check:ota-paths` needs no decision. `mobile/components/schedule/` already exists (`BlockCard.jsx`, `CoachPickerSheet.jsx`, `ManageMode.jsx`, `SwapConfirmSheet.jsx`).

---

### Task 0: Preconditions (no commit)

- [ ] **Step 1: AVAIL.1a is on main and live**

```bash
git fetch origin main && git log origin/main --oneline | grep -m3 'AVAIL.1a'
```

Expected: the AVAIL.1a squash-merge commit. Then with Supabase MCP `list_migrations` on **un1t-crm** (`iyvtbjjxdggiadzwwvdj`): `630_staff_availability` is present. Stop if either is missing.

- [ ] **Step 2: The names this PR imports exist**

```bash
grep -nE '^export (const|function) (AVAILABILITY_LIMITS|AVAILABILITY_WEEKDAYS|AVAILABILITY_WEEKDAY_LABELS|normaliseRule|normaliseAvailability|ruleKey|ruleProblem|withoutEnded|sameAvailability|describeRule)\b' shared/availability.js | wc -l
grep -n 'export function leaveDateRangeLabel' shared/time-off.js
```

Expected: `10`, and one line. If 1a renamed or reshaped any of them (in particular `ruleProblem`'s `{ todayIso, knownKeys }` options or `withoutEnded(input, todayIso)`), adjust Tasks 2-4 to the merged code before writing them.

- [ ] **Step 3: The route contract is as described above**

```bash
grep -n "success: true, data: { changed" src/app/api/schedule/availability/route.js
grep -n "Invalid availability" src/app/api/schedule/availability/route.js
grep -n "availability_past_start\|availability_past_date" supabase/migrations/630_staff_availability.sql | head -4
```

Expected: the PUT answers `data: { changed, ...splitRules(result.after) }`, 400s carry `issues`, and the two RPC refusals exist.

- [ ] **Step 4: The notification toggle already renders (nothing to build)**

```bash
grep -n "notify_availability_change" shared/permissions.js
grep -n "isNotify" 'mobile/app/(staff)/staff/permissions/[id].jsx' src/components/RolePermissions.jsx
grep -n "'availability_changed'" src/lib/push-channels.test.js
```

Expected: one `MOBILE_PERMISSIONS` entry with `isNotify: true` plus six role defaults `notify_availability_change: true`; the two renderers filter on `isNotify`; the channel test lists the type. Nothing to change. Record this in the PR body (point 5).

---

### Task 1: The API wrappers

**Files:**
- Create: `mobile/lib/availability-api.test.js`
- Create: `mobile/lib/availability-api.js`

- [ ] **Step 1: Write the failing test**

```js
// mobile/lib/availability-api.test.js
//
// AVAIL.2 — the wire contract of the phone's two availability calls. These
// wrappers are the ONLY place the phone spells the route, and nothing else
// checks them: a drifted path or body fails on a handset as an unexplained
// 400. Mocking ./api keeps this pure (no network, no Supabase, no RN).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn(() => Promise.resolve({ success: true, data: { weekly: [], dated: [] } })) }))

const { api } = await import('./api')
const availabilityApi = await import('./availability-api')
const { getMyAvailability, saveMyAvailability } = availabilityApi

beforeEach(() => { api.mockClear() })

describe('availability-api', () => {
  it('exports exactly these two helpers', () => {
    expect(Object.keys(availabilityApi).sort()).toEqual(['getMyAvailability', 'saveMyAvailability'])
  })

  it("reads the caller's own rules: no profile id, no studio, no query", async () => {
    await getMyAvailability()
    expect(api).toHaveBeenCalledTimes(1)
    // No locationId: availability is per PERSON, and the route pins it to the
    // caller (user.id, the viewed person under View as user).
    expect(api.mock.calls[0]).toEqual(['/api/schedule/availability'])
  })

  it('saves with ONE PUT whose body is { weekly, dated } exactly as given', async () => {
    const body = {
      weekly: [{ weekday: 'mon', all_day: true, start_time: null, end_time: null, note: null }],
      dated: [{ start_date: '2026-10-03', end_date: '2026-10-05', all_day: false, start_time: '17:00', end_time: '19:30', note: 'wedding' }],
    }
    await saveMyAvailability(body)
    expect(api).toHaveBeenCalledTimes(1)
    expect(api.mock.calls[0]).toEqual(['/api/schedule/availability', { method: 'PUT', body }])
  })

  it("hands back api()'s envelope untouched (the form reads transport, status and issues)", async () => {
    const envelope = { success: false, status: 400, error: 'Invalid availability', issues: [{ path: 'dated.0', message: 'That date has passed' }] }
    api.mockResolvedValueOnce(envelope)
    expect(await saveMyAvailability({ weekly: [], dated: [] })).toBe(envelope)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run mobile/lib/availability-api.test.js`
Expected: FAIL, `Failed to resolve import "./availability-api"`.

- [ ] **Step 3: Write the wrappers**

```js
// mobile/lib/availability-api.js
//
// AVAIL.2 — the phone's calls to /api/schedule/availability (AVAIL.1a). Own
// file rather than schedule-api.js, whose test pins its export list and which
// other scheduler PRs extend in parallel.
//
// Both go through api(): the Bearer token AND x-impersonate-target, so "View
// as user" reads and saves the viewed person's availability (the route pins
// every read and write to user.id and records the master as the actor). No
// locationId: availability is per person, not per studio.

import { api } from './api'

/** The caller's own { weekly, dated } (dated rules that ended are not returned). */
export function getMyAvailability() {
  return api('/api/schedule/availability')
}

/**
 * Replace the caller's weekly rules and not-yet-ended dated rules. `body` is
 * availability-form.js buildSaveBody().body: { weekly, dated } in canonical
 * order. Resolves api()'s envelope as is; read it with saveOutcome().
 */
export function saveMyAvailability(body) {
  return api('/api/schedule/availability', { method: 'PUT', body })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run mobile/lib/availability-api.test.js`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/availability-api.js mobile/lib/availability-api.test.js
git commit -m "AVAIL.2 — phone: availability API wrappers (GET own, one PUT) with a wire-contract test

Bundle paths: merging publishes an OTA at 100%.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The form lib, part 1: words, rows and typed times

**Files:**
- Create: `mobile/lib/availability-form.test.js`
- Create: `mobile/lib/availability-form.js`

- [ ] **Step 1: Write the failing tests**

```js
// mobile/lib/availability-form.test.js
//
// AVAIL.2 — the phone availability form's decisions. No RN runtime: the
// screen renders what these return. The RULES are shared/availability.js's
// (the server runs the same ones); these tests pin what the FORM adds: typed
// times, rows, the PUT body, the dirty check, and the server's answer turned
// into words. Every date is read from its own digits, so this file passes
// under any TZ (the PR gate runs it under two).

import { describe, it, expect } from 'vitest'
import {
  AVAILABILITY_COPY, WEEKDAY_CHIPS, createRowKeys, parseTimeInput, timeOnBlur, rowFromRule, rowsFromServer,
  newRow, rowToRule, datesLabel, calendarRange, rangeFromCalendar,
} from './availability-form'

const TODAY = '2026-09-25' // a Friday

// The GET's shape: canonical rules, no ids. r3 started before TODAY and has
// not ended; r4 is in the future.
const SERVER = {
  weekly: [
    { kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: true, start_time: null, end_time: null, note: null },
    { kind: 'weekly', weekday: 'tue', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:00', note: 'college' },
  ],
  dated: [
    { kind: 'dated', weekday: null, start_date: '2026-09-20', end_date: '2026-09-30', all_day: true, start_time: null, end_time: null, note: null },
    { kind: 'dated', weekday: null, start_date: '2026-10-03', end_date: '2026-10-05', all_day: false, start_time: '17:00', end_time: '19:30', note: 'wedding' },
  ],
}
// Keys r1..r4, in that order.
const loaded = () => rowsFromServer(SERVER, createRowKeys())

describe('WEEKDAY_CHIPS', () => {
  it('Monday first, the shared codes, three-letter faces and full names for screen readers', () => {
    expect(WEEKDAY_CHIPS.map((d) => d.code)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
    expect(WEEKDAY_CHIPS[0]).toEqual({ code: 'mon', label: 'Monday', short: 'Mon' })
    expect(WEEKDAY_CHIPS[6]).toEqual({ code: 'sun', label: 'Sunday', short: 'Sun' })
  })
})

describe('parseTimeInput', () => {
  it.each([
    ['9', '09:00'], ['09', '09:00'], ['930', '09:30'], ['0930', '09:30'], ['9:30', '09:30'], ['9.30', '09:30'],
    ['17', '17:00'], ['17:30', '17:30'], ['1730', '17:30'], ['5pm', '17:00'], ['5:30pm', '17:30'], ['5:30 PM', '17:30'],
    ['1230pm', '12:30'], ['12pm', '12:00'], ['12am', '00:00'], ['0', '00:00'], [' 07:05 ', '07:05'],
  ])('%j reads as %s', (typed, hhmm) => expect(parseTimeInput(typed)).toBe(hhmm))

  it.each([
    '', '   ', null, undefined, '24:00', '2400', '9:5', '9:60', '13pm', '0am', '17:30pm', 'noon', '9-30', '12345', '09:30:00',
  ])('%j does not read (no overnight, no seconds, no guessing)', (typed) => expect(parseTimeInput(typed)).toBeNull())
})

describe('timeOnBlur', () => {
  it('tidies what reads and leaves anything else for the coach to see', () => {
    expect(timeOnBlur('930')).toBe('09:30')
    expect(timeOnBlur('5:30pm')).toBe('17:30')
    expect(timeOnBlur('9:5')).toBe('9:5')
    expect(timeOnBlur('')).toBe('')
    expect(timeOnBlur(undefined)).toBe('')
  })
})

describe('rows from the server', () => {
  it('one row per rule, weekly first, keyed in order, times HH:MM, blanks as empty strings', () => {
    const rows = loaded()
    expect(rows.map((r) => r.key)).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(rows[0]).toEqual({
      key: 'r1', kind: 'weekly', weekday: 'mon', start_date: '', end_date: '', all_day: true, start_time: '', end_time: '', note: '',
    })
    expect(rows[1]).toMatchObject({ kind: 'weekly', weekday: 'tue', all_day: false, start_time: '09:00', end_time: '12:00', note: 'college' })
    expect(rows[3]).toMatchObject({
      kind: 'dated', start_date: '2026-10-03', end_date: '2026-10-05', all_day: false, start_time: '17:00', end_time: '19:30', note: 'wedding',
    })
  })

  it("reads Postgres's HH:MM:SS too", () => {
    expect(rowFromRule({ kind: 'weekly', weekday: 'thu', all_day: false, start_time: '06:00:00', end_time: '08:30:00' }, 'k'))
      .toMatchObject({ key: 'k', start_time: '06:00', end_time: '08:30' })
  })

  it('skips anything unreadable instead of inventing a rule', () => {
    expect(rowsFromServer(null, createRowKeys())).toEqual([])
    expect(rowsFromServer({ weekly: [null, 'x', 7], dated: 'nope' }, createRowKeys())).toEqual([])
    expect(rowsFromServer({ weekly: [{ weekday: 'wed', all_day: true }] }, createRowKeys()))
      .toEqual([{ key: 'r1', kind: 'weekly', weekday: 'wed', start_date: '', end_date: '', all_day: true, start_time: '', end_time: '', note: '' }])
  })
})

describe('newRow', () => {
  it('weekly: Monday, all day; dated: today, all day', () => {
    const next = createRowKeys('n')
    expect(newRow('weekly', { todayIso: TODAY, nextKey: next })).toEqual({
      key: 'n1', kind: 'weekly', weekday: 'mon', start_date: '', end_date: '', all_day: true, start_time: '', end_time: '', note: '',
    })
    expect(newRow('dated', { todayIso: TODAY, nextKey: next })).toEqual({
      key: 'n2', kind: 'dated', weekday: 'mon', start_date: TODAY, end_date: TODAY, all_day: true, start_time: '', end_time: '', note: '',
    })
  })
})

describe('rowToRule', () => {
  const rows = loaded()
  it('reads typed times; a canonical rule comes out', () => {
    expect(rowToRule({ ...rows[1], start_time: '9', end_time: '1230pm' })).toEqual({
      kind: 'weekly', weekday: 'tue', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:30', note: 'college',
    })
  })
  it('a date with no last day is one day', () => {
    expect(rowToRule({ ...rows[3], end_date: '' })).toMatchObject({ start_date: '2026-10-03', end_date: '2026-10-03' })
  })
  it('all day drops the times; a blank note is null; an unreadable time is null', () => {
    expect(rowToRule({ ...rows[1], all_day: true })).toMatchObject({ all_day: true, start_time: null, end_time: null })
    expect(rowToRule({ ...rows[0], note: '   ' }).note).toBeNull()
    expect(rowToRule({ ...rows[1], start_time: 'soon' }).start_time).toBeNull()
  })
})

describe('dates on a card', () => {
  it("reads like the leave form's dates", () => {
    expect(datesLabel(loaded()[3])).toBe('Sat 3 Oct – Mon 5 Oct')
    expect(datesLabel({ kind: 'dated', start_date: '2026-10-03', end_date: '2026-10-03' })).toBe('Sat 3 Oct')
    expect(datesLabel({ kind: 'dated', start_date: '2026-12-30', end_date: '2027-01-02' })).toBe('Wed 30 Dec 2026 – Sat 2 Jan 2027')
    expect(datesLabel({ kind: 'dated', start_date: '', end_date: '' })).toBe(AVAILABILITY_COPY.chooseDates)
  })

  it('a one-day entry hands the calendar NO end, so a second tap can make a range', () => {
    expect(calendarRange({ start_date: '2026-10-03', end_date: '2026-10-03' })).toEqual({ startDate: '2026-10-03', endDate: null })
    expect(calendarRange({ start_date: '2026-10-03', end_date: '2026-10-05' })).toEqual({ startDate: '2026-10-03', endDate: '2026-10-05' })
    expect(calendarRange({ start_date: '', end_date: '' })).toEqual({ startDate: null, endDate: null })
  })

  it("the calendar's first tap is a one-day entry; the second extends it", () => {
    expect(rangeFromCalendar({ start: '2026-10-03', end: null })).toEqual({ start_date: '2026-10-03', end_date: '2026-10-03' })
    expect(rangeFromCalendar({ start: '2026-10-03', end: '2026-10-05' })).toEqual({ start_date: '2026-10-03', end_date: '2026-10-05' })
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run mobile/lib/availability-form.test.js`
Expected: FAIL, `Failed to resolve import "./availability-form"`.

- [ ] **Step 3: Write part 1 of the lib**

```js
// mobile/lib/availability-form.js
//
// AVAIL.2 — every decision the phone's "My availability" screen
// (app/(staff)/schedule/availability.jsx) makes. There is no React Native
// component test runner, so the screen renders what these return and decides
// nothing itself.
//
// The RULES are shared/availability.js's, the same functions PUT
// /api/schedule/availability runs (AVAIL.1a), so the phone refuses in the
// server's words, only sooner. This file adds what only a form needs: typed
// text → a rule, the PUT body, the dirty check, and the server's answer →
// what the screen says.
//
// The PUT REPLACES the coach's weekly rules and their dated rules that have
// not ended (mig 630). Three consequences live here:
//   • Only a SUCCESSFUL load may be saved over (saveButtonState needs
//     `loaded`; isDirty(null) is false): saving a form whose load failed
//     would send an empty set and wipe every rule the coach has.
//   • A dated rule that ended while the screen was open (left open over
//     midnight) is left out of the body. The server keeps ended rules as
//     history and drops an unchanged one itself (AVAIL.1a review 4); leaving
//     it out means the phone never depends on that.
//   • The body is sent in CANONICAL order (normaliseAvailability: sorted,
//     exact duplicates dropped), because the server's issue paths ('dated.3')
//     index the sorted lists. keysByPath maps each path back to its rows.

import {
  AVAILABILITY_LIMITS, AVAILABILITY_WEEKDAYS, AVAILABILITY_WEEKDAY_LABELS, normaliseRule,
} from 'shared/availability'
import { leaveDateRangeLabel } from 'shared/time-off'

export const AVAILABILITY_TITLE = 'My availability'
export const AVAILABILITY_INTRO =
  'Tell your managers when you can’t work. Every other time counts as available. There is nothing to approve: ' +
  'your managers at each of your studios get a notification when you save. Your managers can see your notes.'
export const AVAILABILITY_NO_OVERNIGHT = 'A time window stays within one day: it can’t run past midnight.'

// The Schedule tab's row (components/schedule/MyAvailabilityRow.jsx).
export const AVAILABILITY_ROW = Object.freeze({
  title: 'My availability',
  subtitle: 'Tell your managers when you can’t work',
})

export const AVAILABILITY_COPY = Object.freeze({
  loading: 'Loading your availability…',
  loadFailed: 'Couldn’t load your availability.',
  loadSignedOut: 'Your sign-in has expired. Sign in again to see your availability.',
  retry: 'Try again',
  weeklyHeading: 'Every week',
  datedHeading: 'Dates',
  weeklyEmpty: 'No weekly times. Add one for a day you can never work, or part of one.',
  datedEmpty: 'No dates. Add one for a day or a run of days you can’t work.',
  addWeekly: 'Add a weekly time',
  addDated: 'Add a date',
  weeklyFull: `Up to ${AVAILABILITY_LIMITS.weekly} weekly times.`,
  datedFull: `Up to ${AVAILABILITY_LIMITS.dated} dates.`,
  chooseDates: 'Choose dates',
  calendarHint: 'Tap a day, then tap another to make it a range.',
  timeFormat: 'Use a time like 09:30, 17:30 or 5:30pm',
  started: 'This started before today. To change its dates or times, pick new dates from today: the days already gone stay as they were. You can still change the note.',
  ended: 'This date has passed. It is kept as history and left out when you save.',
  duplicate: 'Same as another entry. Only one is kept.',
  saved: 'Saved. Your managers will get a notification.',
  unchanged: 'Saved. Nothing had changed, so nobody was notified.',
  nothingToSave: 'No changes to save.',
  invalid: 'Not saved. Fix the entries marked below.',
  noAnswer: 'Couldn’t confirm it saved: no connection, or no answer from the server. Your changes are still here, and saving again is safe.',
  sessionEnded: 'Not saved: your sign-in has expired. Sign in again, then make these changes again.',
  failed: 'Not saved.',
  keptHere: 'Your changes are still here.',
  discardTitle: 'Discard your changes?',
  discardBody: 'Your availability has not been saved.',
  discardKeep: 'Keep editing',
  discardConfirm: 'Discard',
})

// The weekday picker: shared codes, Monday first (shift_templates.days_of_week).
export const WEEKDAY_CHIPS = Object.freeze(AVAILABILITY_WEEKDAYS.map((code) => Object.freeze({
  code,
  label: AVAILABILITY_WEEKDAY_LABELS[code],
  short: AVAILABILITY_WEEKDAY_LABELS[code].slice(0, 3),
})))

/**
 * Row keys. The own GET carries no ids, and an index key would move a
 * half-typed note onto the wrong card when one above it is removed.
 */
export function createRowKeys(prefix = 'r') {
  let n = 0
  return () => `${prefix}${++n}`
}

const TIME_TEXT = /^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm)?$/

/**
 * What a coach types into a time field → 'HH:MM', or null. Reads 9 · 09 ·
 * 930 · 0930 · 9:30 · 9.30 · 17:30 · 1730 · 5pm · 5:30pm · 12am. Never 24:00:
 * a window stays inside one day (shared/availability.js).
 */
export function parseTimeInput(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '')
  const m = s.match(TIME_TEXT)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  if (min > 59) return null
  if (m[3]) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0)
  }
  if (h > 23) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** Leaving a time field: tidy what reads ('930' → '09:30'); leave the rest for the coach to see. */
export function timeOnBlur(text) {
  return parseTimeInput(text) ?? String(text ?? '')
}

const BLANK = Object.freeze({
  weekday: 'mon', start_date: '', end_date: '', all_day: true, start_time: '', end_time: '', note: '',
})

/** A stored rule (the GET's or the PUT's shape) → an editable row. */
export function rowFromRule(rule, key) {
  const r = normaliseRule(rule)
  if (!r) return null
  return {
    key,
    kind: r.kind,
    weekday: r.weekday || 'mon',
    start_date: r.start_date || '',
    end_date: r.end_date || '',
    all_day: r.all_day,
    start_time: r.start_time || '',
    end_time: r.end_time || '',
    note: r.note || '',
  }
}

/** The server's { weekly, dated } → rows, weekly first, in the server's order. Anything unreadable is skipped. */
export function rowsFromServer(data, nextKey) {
  const tagged = [
    ...(Array.isArray(data?.weekly) ? data.weekly : []).map((r) => [r, 'weekly']),
    ...(Array.isArray(data?.dated) ? data.dated : []).map((r) => [r, 'dated']),
  ]
  return tagged
    .filter(([r]) => r && typeof r === 'object')
    .map(([r, kind]) => rowFromRule({ ...r, kind }, nextKey()))
}

/** A new card: all day; a weekly one on Monday, a dated one today. */
export function newRow(kind, { todayIso, nextKey }) {
  return kind === 'weekly'
    ? { key: nextKey(), kind: 'weekly', ...BLANK }
    : { key: nextKey(), kind: 'dated', ...BLANK, start_date: todayIso, end_date: todayIso }
}

/** A row as the canonical rule the server will read (typed times parsed; a one-day date ends where it starts). */
export function rowToRule(row) {
  const dated = row?.kind === 'dated'
  return normaliseRule({
    kind: dated ? 'dated' : 'weekly',
    weekday: dated ? null : row?.weekday,
    start_date: dated ? (row.start_date || null) : null,
    end_date: dated ? (row.end_date || row.start_date || null) : null,
    all_day: row?.all_day === true,
    start_time: parseTimeInput(row?.start_time),
    end_time: parseTimeInput(row?.end_time),
    note: row?.note,
  })
}

/** 'Sat 3 Oct – Mon 5 Oct' (shared/time-off's leave label, so the two forms read alike). */
export function datesLabel(row) {
  if (!row?.start_date) return AVAILABILITY_COPY.chooseDates
  return leaveDateRangeLabel(row.start_date, row.end_date || row.start_date)
}

/**
 * MonthCalendar's props for a card. A one-day entry passes NO end: the
 * calendar starts afresh on any tap while it holds both ends
 * (components/MonthCalendar.jsx tap()), so a stored one-day end would stop
 * the second tap from ever making a range.
 */
export function calendarRange(row) {
  const start = row?.start_date || null
  const end = row?.end_date && row.end_date !== start ? row.end_date : null
  return { startDate: start, endDate: end }
}

/** MonthCalendar's onChange → the card's dates (a first tap is a one-day entry). */
export function rangeFromCalendar({ start, end } = {}) {
  return { start_date: start || '', end_date: end || start || '' }
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run mobile/lib/availability-form.test.js`
Expected: all pass (the two `it.each` tables expand to 32 cases).

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/availability-form.js mobile/lib/availability-form.test.js
git commit -m "AVAIL.2 — phone availability form, part 1: words, rows, typed times, calendar range

Pure lib (no RN): the screen renders what it returns. Times are typed and
read tolerantly (9, 930, 5:30pm) so no native picker is needed.

Bundle paths: merging publishes an OTA at 100%.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The form lib, part 2: the rules, the PUT body, the dirty check

**Files:**
- Modify: `mobile/lib/availability-form.test.js` (replace the import block; append)
- Modify: `mobile/lib/availability-form.js` (replace the `shared/availability` import; append)

- [ ] **Step 1: Write the failing tests**

Replace the import block at the top of `mobile/lib/availability-form.test.js` with:

```js
import { describe, it, expect } from 'vitest'
import { AVAILABILITY_LIMITS, ruleKey } from 'shared/availability'
import {
  AVAILABILITY_COPY, WEEKDAY_CHIPS, createRowKeys, parseTimeInput, timeOnBlur, rowFromRule, rowsFromServer,
  newRow, rowToRule, datesLabel, calendarRange, rangeFromCalendar,
  hasEnded, knownStartedKeys, rowProblem, formProblems, canAdd, duplicateKeys, startedNote, rowSummary,
  buildSaveBody, isDirty,
} from './availability-form'
```

Append:

```js
// A dated row by hand (the key is 'x' unless given).
const datedRow = (start, end, extra = {}) => ({
  key: 'x', kind: 'dated', weekday: 'mon', start_date: start, end_date: end, all_day: true, start_time: '', end_time: '', note: '', ...extra,
})

describe('hasEnded', () => {
  it('a dated row whose last day is before today has ended; one ending today has not', () => {
    expect(hasEnded(datedRow('2026-09-20', '2026-09-24'), TODAY)).toBe(true)
    expect(hasEnded(datedRow('2026-09-24', ''), TODAY)).toBe(true) // one day, yesterday
    expect(hasEnded(datedRow('2026-09-20', '2026-09-25'), TODAY)).toBe(false)
  })
  it('a weekly row never ends; with no today nothing is judged ended', () => {
    expect(hasEnded(loaded()[0], TODAY)).toBe(false)
    expect(hasEnded(datedRow('2026-09-20', '2026-09-24'), null)).toBe(false)
  })
})

describe('knownStartedKeys', () => {
  it("the loaded dated rules that started before today, by content (the server's backdating set)", () => {
    const rows = loaded()
    expect([...knownStartedKeys(rows, TODAY)]).toEqual([ruleKey(rowToRule(rows[2]))])
    expect(knownStartedKeys(null, TODAY).size).toBe(0)
  })
})

describe('rowProblem', () => {
  const [mon, tue, started, future] = loaded()

  it('a typed time that does not read says how to write one, before anything else', () => {
    expect(rowProblem({ ...tue, start_time: '9:5' }, { todayIso: TODAY })).toBe(AVAILABILITY_COPY.timeFormat)
    expect(rowProblem({ ...tue, end_time: 'late' }, { todayIso: TODAY })).toBe(AVAILABILITY_COPY.timeFormat)
  })

  it("otherwise the shared rules' own words", () => {
    expect(rowProblem({ ...tue, start_time: '12:00', end_time: '09:00' }, { todayIso: TODAY })).toBe('The end time must be after the start time')
    expect(rowProblem({ ...tue, start_time: '', end_time: '' }, { todayIso: TODAY })).toBe('Give a start and an end time, or choose all day')
    expect(rowProblem({ ...future, start_date: '2026-10-10', end_date: '2026-10-01' }, { todayIso: TODAY })).toBe('The last day is before the first day')
  })

  it('all day ignores whatever is left in the time fields', () => {
    expect(rowProblem({ ...mon, start_time: 'x', end_time: 'y' }, { todayIso: TODAY })).toBeNull()
  })

  it('backdating: a started rule the coach already has is fine, note edits too; changed, it must start today or later', () => {
    const knownKeys = knownStartedKeys(loaded(), TODAY)
    expect(rowProblem(started, { todayIso: TODAY, knownKeys })).toBeNull()
    expect(rowProblem({ ...started, note: 'new words' }, { todayIso: TODAY, knownKeys })).toBeNull()
    expect(rowProblem({ ...started, all_day: false, start_time: '09:00', end_time: '10:00' }, { todayIso: TODAY, knownKeys }))
      .toBe('Start today or later')
  })
})

describe('formProblems', () => {
  it('a clean form is ok', () => {
    expect(formProblems(loaded(), { todayIso: TODAY, knownKeys: knownStartedKeys(loaded(), TODAY) }))
      .toEqual({ byKey: {}, banner: null, ok: true })
  })

  it('marks each broken row by key; an ended row is never judged (it is not sent)', () => {
    const rows = [...loaded(), datedRow('2026-09-01', '2026-09-02', { key: 'old', all_day: false, start_time: 'x' })]
    rows[1] = { ...rows[1], end_time: '08:00' }
    const out = formProblems(rows, { todayIso: TODAY })
    expect(out.byKey).toEqual({ r2: 'The end time must be after the start time' })
    expect(out.ok).toBe(false)
  })

  it('says so when a list is over its cap', () => {
    const next = createRowKeys()
    const many = Array.from({ length: AVAILABILITY_LIMITS.weekly + 1 }, () => newRow('weekly', { todayIso: TODAY, nextKey: next }))
    expect(formProblems(many, { todayIso: TODAY })).toMatchObject({ banner: AVAILABILITY_COPY.weeklyFull, ok: false })
  })
})

describe('canAdd', () => {
  it('stops at the cap for that list only', () => {
    const next = createRowKeys()
    const full = Array.from({ length: AVAILABILITY_LIMITS.weekly }, () => newRow('weekly', { todayIso: TODAY, nextKey: next }))
    expect(canAdd(full, 'weekly', { todayIso: TODAY })).toBe(false)
    expect(canAdd(full, 'dated', { todayIso: TODAY })).toBe(true)
    expect(canAdd(full.slice(1), 'weekly', { todayIso: TODAY })).toBe(true)
  })
})

describe('duplicateKeys', () => {
  const [mon, tue] = loaded()
  it('a later exact copy (same day, window and note) is flagged; the first is not', () => {
    expect([...duplicateKeys([mon, { ...mon, key: 'copy' }], { todayIso: TODAY })]).toEqual(['copy'])
    expect([...duplicateKeys([tue, { ...tue, key: 'typed', start_time: '9', end_time: '12' }], { todayIso: TODAY })]).toEqual(['typed'])
  })
  it('a different note is a different entry', () => {
    expect(duplicateKeys([mon, { ...mon, key: 'b', note: 'other' }], { todayIso: TODAY }).size).toBe(0)
  })
})

describe('startedNote / rowSummary', () => {
  const [mon, tue, started, future] = loaded()
  it('only a dated row that started before today and has not ended gets the started note', () => {
    expect(startedNote(started, { todayIso: TODAY })).toBe(AVAILABILITY_COPY.started)
    expect(startedNote(future, { todayIso: TODAY })).toBeNull()
    expect(startedNote(mon, { todayIso: TODAY })).toBeNull()
    expect(startedNote({ ...started, end_date: '2026-09-24' }, { todayIso: TODAY })).toBeNull()
  })
  it("a card's one-line name is the shared description; an unfinished card says so", () => {
    expect(rowSummary(mon, { todayIso: TODAY })).toBe('Mondays, all day')
    expect(rowSummary(tue, { todayIso: TODAY })).toBe('Tuesdays, 9am–12pm')
    expect(rowSummary(future, { todayIso: TODAY })).toBe('3 Oct – 5 Oct, 5pm–7:30pm')
    expect(rowSummary({ ...tue, start_time: '' }, { todayIso: TODAY })).toBe('Unfinished weekly time')
    expect(rowSummary({ ...future, start_date: '' }, { todayIso: TODAY })).toBe('Unfinished date')
    expect(rowSummary({ ...started, end_date: '2026-09-24' }, { todayIso: TODAY })).toBe('20 Sep – 24 Sep, all day')
  })
})

describe('buildSaveBody', () => {
  it('both lists in canonical order, without kind, whatever order the cards are in; each path names its card', () => {
    const rows = loaded()
    const { body, keysByPath, endedKeys } = buildSaveBody([rows[3], rows[1], rows[2], rows[0]], { todayIso: TODAY })
    expect(body).toEqual({
      weekly: [
        { weekday: 'mon', all_day: true, start_time: null, end_time: null, note: null },
        { weekday: 'tue', all_day: false, start_time: '09:00', end_time: '12:00', note: 'college' },
      ],
      dated: [
        { start_date: '2026-09-20', end_date: '2026-09-30', all_day: true, start_time: null, end_time: null, note: null },
        { start_date: '2026-10-03', end_date: '2026-10-05', all_day: false, start_time: '17:00', end_time: '19:30', note: 'wedding' },
      ],
    })
    expect(keysByPath).toEqual({ 'weekly.0': ['r1'], 'weekly.1': ['r2'], 'dated.0': ['r3'], 'dated.1': ['r4'] })
    expect(endedKeys).toEqual([])
  })

  it('an exact copy is sent once, and its path points at every card that made it', () => {
    const [mon] = loaded()
    const { body, keysByPath } = buildSaveBody([mon, { ...mon, key: 'copy' }], { todayIso: TODAY })
    expect(body.weekly).toHaveLength(1)
    expect(keysByPath).toEqual({ 'weekly.0': ['r1', 'copy'] })
  })

  it('a dated card that ended (a screen left open over midnight) is left out, not sent back', () => {
    const rows = loaded()
    const gone = { ...rows[2], key: 'gone', start_date: '2026-09-01', end_date: '2026-09-24' }
    const { body, endedKeys, keysByPath } = buildSaveBody([...rows, gone], { todayIso: TODAY })
    expect(body.dated.map((d) => d.start_date)).toEqual(['2026-09-20', '2026-10-03'])
    expect(endedKeys).toEqual(['gone'])
    expect(Object.values(keysByPath).flat()).not.toContain('gone')
  })

  it('typed times go out as HH:MM; a one-day date carries its end', () => {
    const next = createRowKeys('n')
    const w = { ...newRow('weekly', { todayIso: TODAY, nextKey: next }), weekday: 'fri', all_day: false, start_time: '5pm', end_time: '1930' }
    const d = { ...newRow('dated', { todayIso: TODAY, nextKey: next }), start_date: '2026-10-09', end_date: '' }
    expect(buildSaveBody([w, d], { todayIso: TODAY }).body).toEqual({
      weekly: [{ weekday: 'fri', all_day: false, start_time: '17:00', end_time: '19:30', note: null }],
      dated: [{ start_date: '2026-10-09', end_date: '2026-10-09', all_day: true, start_time: null, end_time: null, note: null }],
    })
  })
})

describe('isDirty', () => {
  it('nothing loaded is never dirty, so a failed load can never be saved over', () => {
    expect(isDirty(null, loaded(), { todayIso: TODAY })).toBe(false)
  })

  it('the same rules in another order, or typed differently, are not a change', () => {
    const base = loaded()
    expect(isDirty(base, [...base].reverse(), { todayIso: TODAY })).toBe(false)
    const retyped = base.map((r) => (r.key === 'r2' ? { ...r, start_time: '9', end_time: '12pm' } : r))
    expect(isDirty(base, retyped, { todayIso: TODAY })).toBe(false)
  })

  it('a note-only edit, a removed card or a new card IS a change', () => {
    const base = loaded()
    expect(isDirty(base, base.map((r) => (r.key === 'r1' ? { ...r, note: 'school run' } : r)), { todayIso: TODAY })).toBe(true)
    expect(isDirty(base, base.slice(1), { todayIso: TODAY })).toBe(true)
    expect(isDirty(base, [...base, newRow('dated', { todayIso: TODAY, nextKey: createRowKeys('n') })], { todayIso: TODAY })).toBe(true)
  })

  it('adding an exact copy, or dropping a card that has ended, is not a change', () => {
    const base = loaded()
    expect(isDirty(base, [...base, { ...base[0], key: 'copy' }], { todayIso: TODAY })).toBe(false)
    const withOld = [...base, { ...base[2], key: 'old', start_date: '2026-09-01', end_date: '2026-09-24' }]
    expect(isDirty(withOld, base, { todayIso: TODAY })).toBe(false)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run mobile/lib/availability-form.test.js`
Expected: FAIL, the new describes report `hasEnded is not a function` (and the rest).

- [ ] **Step 3: Write part 2 of the lib**

Replace the `shared/availability` import at the top of `mobile/lib/availability-form.js` with:

```js
import {
  AVAILABILITY_LIMITS, AVAILABILITY_WEEKDAYS, AVAILABILITY_WEEKDAY_LABELS, normaliseRule, normaliseAvailability,
  ruleProblem, ruleKey, withoutEnded, sameAvailability, describeRule,
} from 'shared/availability'
```

Append:

```js
/** A dated row whose last day is before today: history. Shown, never edited, never sent. */
export function hasEnded(row, todayIso) {
  if (row?.kind !== 'dated') return false
  return withoutEnded({ weekly: [], dated: [rowToRule(row)] }, todayIso).dated.length === 0
}

/**
 * ruleKey()s of the LOADED dated rules that started before today: the ones
 * the coach already has. The server judges backdating against the same set,
 * built from what is stored (AVAIL.1a review 6): a new or changed rule may
 * not start before today; one the coach already has (any note) may.
 */
export function knownStartedKeys(baselineRows, todayIso) {
  return new Set((baselineRows || [])
    .filter((r) => r?.kind === 'dated' && r.start_date && r.start_date < todayIso)
    .map((r) => ruleKey(rowToRule(r))))
}

/** What is wrong with one card, in the coach's words; null if nothing. */
export function rowProblem(row, { todayIso = null, knownKeys = null } = {}) {
  if (!row?.all_day) {
    for (const typed of [row?.start_time, row?.end_time]) {
      if (String(typed ?? '').trim() && parseTimeInput(typed) === null) return AVAILABILITY_COPY.timeFormat
    }
  }
  return ruleProblem(rowToRule(row), { todayIso, knownKeys })
}

const liveRows = (rows, todayIso) => (rows || []).filter((r) => !hasEnded(r, todayIso))

/** Everything that stops a save: { byKey, banner, ok }. Ended cards are never judged (they are not sent). */
export function formProblems(rows, { todayIso = null, knownKeys = null } = {}) {
  const live = liveRows(rows, todayIso)
  const byKey = {}
  for (const row of live) {
    const problem = rowProblem(row, { todayIso, knownKeys })
    if (problem) byKey[row.key] = problem
  }
  const banner = []
  if (live.filter((r) => r.kind === 'weekly').length > AVAILABILITY_LIMITS.weekly) banner.push(AVAILABILITY_COPY.weeklyFull)
  if (live.filter((r) => r.kind === 'dated').length > AVAILABILITY_LIMITS.dated) banner.push(AVAILABILITY_COPY.datedFull)
  return { byKey, banner: banner.length ? banner.join(' ') : null, ok: Object.keys(byKey).length === 0 && banner.length === 0 }
}

/** May the coach add another card of this kind? (The route caps each list.) */
export function canAdd(rows, kind, { todayIso = null } = {}) {
  return liveRows(rows, todayIso).filter((r) => r.kind === kind).length < AVAILABILITY_LIMITS[kind]
}

// normaliseRule's output has a fixed key order, so its JSON is its identity:
// equal JSON = same kind, day or dates, window AND note, which is exactly
// what normaliseAvailability treats as a duplicate.
const identity = (rule) => JSON.stringify(rule)

/** Cards that repeat an earlier card exactly: only one of them is saved. */
export function duplicateKeys(rows, { todayIso = null } = {}) {
  const seen = new Set()
  const dup = new Set()
  for (const row of liveRows(rows, todayIso)) {
    if (rowProblem(row, { todayIso })) continue
    const id = identity(rowToRule(row))
    if (seen.has(id)) dup.add(row.key)
    else seen.add(id)
  }
  return dup
}

/** The line under a dated card that started before today and has not ended; else null. */
export function startedNote(row, { todayIso = null } = {}) {
  if (row?.kind !== 'dated' || !todayIso || !row.start_date || row.start_date >= todayIso) return null
  return hasEnded(row, todayIso) ? null : AVAILABILITY_COPY.started
}

/** A card's one-line name, 'Mondays, all day'; an unfinished card says so. */
export function rowSummary(row, { todayIso = null } = {}) {
  if (!hasEnded(row, todayIso) && rowProblem(row, { todayIso })) {
    return row?.kind === 'dated' ? 'Unfinished date' : 'Unfinished weekly time'
  }
  return describeRule(rowToRule(row))
}

// The route's body schema (AvailabilityPutSchema): no `kind`, the list says it.
function toPayload(rule) {
  const span = { all_day: rule.all_day, start_time: rule.start_time, end_time: rule.end_time, note: rule.note }
  return rule.kind === 'weekly'
    ? { weekday: rule.weekday, ...span }
    : { start_date: rule.start_date, end_date: rule.end_date, ...span }
}

/**
 * The PUT body for these cards: ended dated cards left out, exact copies
 * sent once, both lists in the server's canonical order.
 *   body       { weekly, dated } for PUT /api/schedule/availability
 *   canonical  the same as canonical rules (what isDirty compares)
 *   keysByPath 'weekly.0' → the card keys that became that entry (the
 *              server's issue paths index these sorted lists)
 *   endedKeys  the cards left out because they ended
 */
export function buildSaveBody(rows, { todayIso = null } = {}) {
  const endedKeys = []
  const keysById = new Map()
  const lists = { weekly: [], dated: [] }
  for (const row of rows || []) {
    if (hasEnded(row, todayIso)) {
      endedKeys.push(row.key)
      continue
    }
    const rule = rowToRule(row)
    const id = identity(rule)
    if (!keysById.has(id)) {
      keysById.set(id, [])
      lists[rule.kind].push(rule)
    }
    keysById.get(id).push(row.key)
  }
  const canonical = normaliseAvailability(lists)
  const keysByPath = {}
  for (const kind of ['weekly', 'dated']) {
    canonical[kind].forEach((rule, i) => { keysByPath[`${kind}.${i}`] = keysById.get(identity(rule)) || [] })
  }
  return {
    body: { weekly: canonical.weekly.map(toPayload), dated: canonical.dated.map(toPayload) },
    canonical,
    keysByPath,
    endedKeys,
  }
}

/**
 * Would saving change anything? Compares what WOULD BE SENT: the same rules
 * and notes in any order, typed any way, are no change. Nothing loaded
 * (baselineRows null) is never dirty, so it can never be saved over.
 */
export function isDirty(baselineRows, rows, { todayIso = null } = {}) {
  if (!baselineRows) return false
  return !sameAvailability(buildSaveBody(baselineRows, { todayIso }).canonical, buildSaveBody(rows, { todayIso }).canonical)
}
```

- [ ] **Step 4: Run them and watch them pass, under two zones**

```bash
for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run mobile/lib/availability-form.test.js; done
```

Expected: all pass in both zones.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/availability-form.js mobile/lib/availability-form.test.js
git commit -m "AVAIL.2 — phone availability form, part 2: rules, the canonical PUT body, the dirty check

Only a successful load can be saved over; ended dated rows are left out;
exact copies are sent once and each server issue path maps back to its
card; backdating is judged against the loaded rules, as the server does.

Bundle paths: merging publishes an OTA at 100%.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The form lib, part 3: the server's answers and leaving the screen

**Files:**
- Modify: `mobile/lib/availability-form.test.js` (replace the `./availability-form` import; append)
- Modify: `mobile/lib/availability-form.js` (append)

- [ ] **Step 1: Write the failing tests**

Replace the `./availability-form` import in the test file with:

```js
import {
  AVAILABILITY_COPY, WEEKDAY_CHIPS, createRowKeys, parseTimeInput, timeOnBlur, rowFromRule, rowsFromServer,
  newRow, rowToRule, datesLabel, calendarRange, rangeFromCalendar,
  hasEnded, knownStartedKeys, rowProblem, formProblems, canAdd, duplicateKeys, startedNote, rowSummary,
  buildSaveBody, isDirty,
  loadOutcome, saveOutcome, closeAction, saveButtonState, impersonationLine,
} from './availability-form'
```

Append:

```js
describe('loadOutcome', () => {
  it('a readable { weekly, dated } is a load', () => {
    expect(loadOutcome({ success: true, data: { weekly: [], dated: [] } })).toEqual({ ok: true, data: { weekly: [], dated: [] } })
  })

  it('anything else is a failed load, which can never be saved over', () => {
    const failed = { ok: false, message: `${AVAILABILITY_COPY.loadFailed} Try again in a moment.`, canRetry: true }
    for (const res of [{ success: true, data: [] }, { success: true, data: { weekly: [] } }, { success: true }, undefined,
      { success: false, status: 500, error: 'Could not load your availability' }]) {
      expect(loadOutcome(res)).toEqual(failed)
    }
  })

  it('no answer asks for a connection; a 401 offers no retry (a dead session fails the same way)', () => {
    expect(loadOutcome({ success: false, transport: true, error: 'Network error: offline' }))
      .toEqual({ ok: false, message: `${AVAILABILITY_COPY.loadFailed} Check your connection and try again.`, canRetry: true })
    expect(loadOutcome({ success: false, status: 401, error: 'Unauthorized' }))
      .toEqual({ ok: false, message: AVAILABILITY_COPY.loadSignedOut, canRetry: false })
  })
})

describe('saveOutcome', () => {
  const PATHS = { 'weekly.0': ['r1', 'copy'], 'weekly.1': ['r2'], 'dated.0': ['r3'], 'dated.1': ['r4'] }

  it('saved: green, "Saved", and the rules the server now holds', () => {
    const data = { changed: true, weekly: [SERVER.weekly[0]], dated: [] }
    expect(saveOutcome({ success: true, data }, { keysByPath: PATHS })).toEqual({
      tone: 'ok', message: AVAILABILITY_COPY.saved, saved: { weekly: [SERVER.weekly[0]], dated: [] }, rowErrors: {},
    })
  })

  it('saved with nothing changed says nobody was notified', () => {
    expect(saveOutcome({ success: true, data: { changed: false, weekly: [], dated: [] } }).message).toBe(AVAILABILITY_COPY.unchanged)
  })

  it('saved, but an answer the phone cannot read: saved is null, so the screen reads the rules back', () => {
    expect(saveOutcome({ success: true, data: { changed: true } })).toMatchObject({ tone: 'ok', message: AVAILABILITY_COPY.saved, saved: null })
  })

  it('no answer (offline, or an edge page after the PUT may have landed) is amber: edits kept, saving again is safe', () => {
    const offline = { tone: 'warn', message: AVAILABILITY_COPY.noAnswer, saved: null, rowErrors: {} }
    expect(saveOutcome({ success: false, transport: true, error: 'Network error: x' })).toEqual(offline)
    expect(saveOutcome({ success: false, transport: true, status: 504, error: 'Non-JSON response (504)' })).toEqual(offline)
  })

  it('401: red, the sign-in has expired', () => {
    expect(saveOutcome({ success: false, status: 401, error: 'Unauthorized' }))
      .toEqual({ tone: 'error', message: AVAILABILITY_COPY.sessionEnded, saved: null, rowErrors: {} })
  })

  it("the server's issues land under the cards that made them (a merged copy: under both)", () => {
    const res = {
      success: false, status: 400, error: 'Invalid availability',
      issues: [{ path: 'dated.1', message: 'Start today or later' }, { path: 'weekly.0.note', message: 'Too long' }],
    }
    expect(saveOutcome(res, { keysByPath: PATHS })).toEqual({
      tone: 'error', message: AVAILABILITY_COPY.invalid, saved: null,
      rowErrors: { r4: 'Start today or later', r1: 'Too long', copy: 'Too long' },
    })
  })

  it('dated.10 is not dated.1; an issue with no card joins the banner', () => {
    const out = saveOutcome({ success: false, status: 400, issues: [{ path: 'dated.10', message: 'Use a real date' }] }, { keysByPath: PATHS })
    expect(out.rowErrors).toEqual({})
    expect(out.message).toBe(`${AVAILABILITY_COPY.failed} Use a real date. ${AVAILABILITY_COPY.keptHere}`)
  })

  it('list-level issues join the banner beside the marked cards', () => {
    const out = saveOutcome({
      success: false, status: 400, error: 'Invalid availability',
      issues: [{ path: 'dated.0', message: 'Use a real date' }, { path: 'weekly', message: 'Up to 28 weekly entries' }],
    }, { keysByPath: PATHS })
    expect(out.rowErrors).toEqual({ r3: 'Use a real date' })
    expect(out.message).toBe(`${AVAILABILITY_COPY.invalid} Up to 28 weekly entries.`)
  })

  it("with no issues, the server's own words", () => {
    expect(saveOutcome({ success: false, status: 400, error: 'a new date cannot start before today' }).message)
      .toBe(`${AVAILABILITY_COPY.failed} A new date cannot start before today. ${AVAILABILITY_COPY.keptHere}`)
    expect(saveOutcome({ success: false, status: 500, error: 'Could not save your availability' }).message)
      .toBe(`${AVAILABILITY_COPY.failed} Could not save your availability. ${AVAILABILITY_COPY.keptHere}`)
    expect(saveOutcome(undefined).message).toBe(`${AVAILABILITY_COPY.failed} Something went wrong. ${AVAILABILITY_COPY.keptHere}`)
  })
})

describe('leaving and saving', () => {
  it('closeAction: mid-save stays, unsaved edits ask first, otherwise go', () => {
    expect(closeAction({ saving: true, dirty: true })).toBe('block')
    expect(closeAction({ saving: true, dirty: false })).toBe('block')
    expect(closeAction({ dirty: true })).toBe('confirm')
    expect(closeAction({})).toBe('close')
  })

  it('saveButtonState: only after a successful load, only with something to save, never twice', () => {
    expect(saveButtonState({ loaded: false, dirty: true })).toEqual({ disabled: true, busy: false })
    expect(saveButtonState({ loaded: true, dirty: false })).toEqual({ disabled: true, busy: false })
    expect(saveButtonState({ loaded: true, dirty: true })).toEqual({ disabled: false, busy: false })
    expect(saveButtonState({ loaded: true, dirty: true, saving: true })).toEqual({ disabled: true, busy: true })
  })

  it('impersonationLine: says whose availability a master is editing', () => {
    expect(impersonationLine(null, { full_name: 'Coach A' })).toBeNull()
    expect(impersonationLine({ masterName: 'Master M' }, { full_name: 'Coach A' }))
      .toBe('You are viewing as Coach A. Saving changes their availability, and their managers are told.')
    expect(impersonationLine({ masterName: 'Master M' }, null))
      .toBe('You are viewing as this person. Saving changes their availability, and their managers are told.')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run mobile/lib/availability-form.test.js`
Expected: FAIL, `loadOutcome is not a function` (and the rest of the new describes).

- [ ] **Step 3: Write part 3 of the lib**

Append to `mobile/lib/availability-form.js`:

```js
// 'a new date cannot start before today' → 'A new date cannot start before today.'
function sentence(text) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  const s = t[0].toUpperCase() + t.slice(1)
  return /[.!?]$/.test(s) ? s : `${s}.`
}

// 'dated.3' (the shared rules) or 'weekly.0.note' (the route's shape check).
const ISSUE_PATH = /^(weekly|dated)\.(\d+)(?:\.|$)/

/**
 * The GET's answer → { ok: true, data } or { ok: false, message, canRetry }.
 * Anything but a readable { weekly, dated } is a failed load, and a failed
 * load can never be saved over (saveButtonState needs `loaded`).
 */
export function loadOutcome(res) {
  const d = res?.data
  if (res?.success && d && Array.isArray(d.weekly) && Array.isArray(d.dated)) {
    return { ok: true, data: { weekly: d.weekly, dated: d.dated } }
  }
  if (res?.status === 401) return { ok: false, message: AVAILABILITY_COPY.loadSignedOut, canRetry: false }
  const hint = res?.transport ? 'Check your connection and try again.' : 'Try again in a moment.'
  return { ok: false, message: `${AVAILABILITY_COPY.loadFailed} ${hint}`, canRetry: true }
}

/**
 * The PUT's answer → what the screen does and says.
 *   tone       'ok' (green) | 'warn' (amber: it may or may not have saved) | 'error' (red)
 *   saved      the server's { weekly, dated } after the save (the form becomes
 *              it), or null (on 'ok': read the rules back)
 *   rowErrors  { [cardKey]: message } from the server's issues
 * Every failure keeps the coach's edits: the screen replaces them only on 'ok'.
 */
export function saveOutcome(res, { keysByPath = {} } = {}) {
  if (res?.success) {
    const d = res.data
    const readable = !!d && Array.isArray(d.weekly) && Array.isArray(d.dated)
    return {
      tone: 'ok',
      message: d?.changed === false ? AVAILABILITY_COPY.unchanged : AVAILABILITY_COPY.saved,
      saved: readable ? { weekly: d.weekly, dated: d.dated } : null,
      rowErrors: {},
    }
  }
  // transport: api() minted it with no server answer: no connection, OR a
  // non-JSON edge page after the request may already have landed. The PUT
  // replaces, so it is idempotent: "saving again is safe" holds either way.
  if (res?.transport) return { tone: 'warn', message: AVAILABILITY_COPY.noAnswer, saved: null, rowErrors: {} }
  if (res?.status === 401) return { tone: 'error', message: AVAILABILITY_COPY.sessionEnded, saved: null, rowErrors: {} }

  const rowErrors = {}
  const loose = []
  for (const issue of Array.isArray(res?.issues) ? res.issues : []) {
    const m = String(issue?.path ?? '').match(ISSUE_PATH)
    const keys = m ? keysByPath[`${m[1]}.${m[2]}`] : null
    if (keys && keys.length) {
      for (const k of keys) {
        if (!rowErrors[k]) rowErrors[k] = String(issue.message || 'Check this entry')
      }
    } else if (issue?.message) {
      loose.push(sentence(issue.message))
    }
  }
  if (Object.keys(rowErrors).length) {
    return { tone: 'error', message: [AVAILABILITY_COPY.invalid, ...loose].join(' '), saved: null, rowErrors }
  }
  const reason = loose.length ? loose.join(' ') : sentence(res?.error || 'Something went wrong')
  return { tone: 'error', message: `${AVAILABILITY_COPY.failed} ${reason} ${AVAILABILITY_COPY.keptHere}`, saved: null, rowErrors }
}

/** Leaving the screen: mid-save stays, unsaved edits ask first, otherwise go (mail-compose's rule). */
export function closeAction({ saving = false, dirty = false } = {}) {
  if (saving) return 'block'
  return dirty ? 'confirm' : 'close'
}

/** The header Save: only after a successful load, only with something to save, never twice. */
export function saveButtonState({ loaded = false, saving = false, dirty = false } = {}) {
  return { disabled: !loaded || saving || !dirty, busy: saving }
}

/** A master under "View as user" is editing someone else's availability: say whose. */
export function impersonationLine(impersonatingFrom, profile) {
  if (!impersonatingFrom) return null
  const name = profile?.full_name || 'this person'
  return `You are viewing as ${name}. Saving changes their availability, and their managers are told.`
}
```

- [ ] **Step 4: Run them and watch them pass, under two zones**

```bash
for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run mobile/lib/availability-form.test.js mobile/lib/availability-api.test.js; done
```

Expected: all pass in both zones.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/availability-form.js mobile/lib/availability-form.test.js
git commit -m "AVAIL.2 — phone availability form, part 3: the server's answers, leaving with unsaved edits

Offline/no-answer is amber and keeps the edits (a replace is idempotent, so
saving again is safe); a 401 says the sign-in expired; server issues land
under the cards that made them; the rest shows the server's own words.

Bundle paths: merging publishes an OTA at 100%.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The manager's push opens Manage mode

**Files:**
- Modify: `mobile/lib/notification-nav.test.js` (after the RUNWAY.1 `it`, which ends at line 82)
- Modify: `mobile/lib/notification-nav.js` (after the `roster_runway` case, lines 97-100)

- [ ] **Step 1: Write the failing test**

In `mobile/lib/notification-nav.test.js`, directly after the `it('opens the unready week in Manage mode for a roster-runway alert', …)` block, add:

```js
  // AVAIL.2 — manager: a coach changed when they can't work (AVAIL.1a's
  // notice). The phone has no per-coach availability view, so the tap opens
  // the roster they build. Before this it was an unknown type: a dead tap.
  it('opens Manage mode for an availability change', () => {
    expect(routeForNotification({ type: 'availability_changed', profile_id: 'p1', change_id: 'c1' })).toBe('/(tabs)/schedule?view=manage')
    expect(routeForNotification({ type: 'availability_changed' })).toBe('/(tabs)/schedule?view=manage')
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run mobile/lib/notification-nav.test.js`
Expected: FAIL, `expected undefined to be '/(tabs)/schedule?view=manage'`.

- [ ] **Step 3: Add the case**

In `mobile/lib/notification-nav.js`, directly after the `roster_runway` case (the `return isIsoDay(data.week_start) ? … : '/(tabs)/schedule?view=manage'` lines), add:

```js
    // AVAIL.2 — a coach changed when they can't work (AVAIL.1a, sent to the
    // roster builders at their studios). No per-coach availability view on
    // the phone, so open the roster they build: Manage mode (schedule.jsx
    // honours ?view=manage for manager roles only; anyone else lands on their
    // own week). The payload's profile_id is there for a better target later.
    case 'availability_changed':
      return '/(tabs)/schedule?view=manage'
```

And in the file's header comment, after the `checklist_compliance` paragraph, add:

```js
//   availability_changed — manager-side notice that a coach changed their
//     availability; no per-coach view on mobile, so Manage mode.
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run mobile/lib/notification-nav.test.js src/lib/push-channels.test.js`
Expected: all pass (`push-channels.test.js` already lists `'availability_changed'` in `STAFF_TYPES` since AVAIL.1a).

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/notification-nav.js mobile/lib/notification-nav.test.js
git commit -m "AVAIL.2 — phone: an 'Availability changed' push opens the schedule in Manage mode

Bundle paths: merging publishes an OTA at 100%.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The month calendar reads out loud (OTA bundle path)

**Files:**
- Modify: `mobile/components/MonthCalendar.jsx` (lines 98-115, 135-140)

No test runner for components (the change is attributes only). The handset checklist covers it.

- [ ] **Step 1: Label the month arrows**

On the previous-month `Pressable` (`onPress={goPrev}`, lines 98-103), add three props:

```jsx
        <Pressable
          onPress={goPrev}
          disabled={!canGoPrev}
          hitSlop={10}
          className="p-1"
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          accessibilityState={{ disabled: !canGoPrev }}
        >
```

On the next-month `Pressable` (line 113), the same without the state:

```jsx
        <Pressable onPress={goNext} hitSlop={10} className="p-1" accessibilityRole="button" accessibilityLabel="Next month">
```

- [ ] **Step 2: Label each day**

On the day `Pressable` (lines 135-140), add:

```jsx
                <Pressable
                  key={day.iso}
                  onPress={() => tap(day.iso)}
                  disabled={disabled}
                  className="flex-1 items-center py-1"
                  accessibilityRole="button"
                  accessibilityLabel={pretty(day.iso)}
                  accessibilityState={{ disabled: !!disabled, selected: !!(selected || inRange) }}
                >
```

`pretty` is the file's own "Mon 5 May 2026" helper (it anchors on midday, so it cannot slip a day). VoiceOver reads a date instead of a bare "25". The leave form gets the same, and nothing visual changes.

- [ ] **Step 3: Lint**

Run: `npm run check:mobile-lint`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add mobile/components/MonthCalendar.jsx
git commit -m "AVAIL.2 — month calendar: days read as dates, arrows as Previous/Next month (screen readers)

Additive accessibility props only; the leave form uses the same calendar.
Bundle paths: merging publishes an OTA at 100%.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The screen (OTA bundle path)

**Files:**
- Create: `mobile/app/(staff)/schedule/availability.jsx`

- [ ] **Step 1: Write the screen**

```jsx
// Modal: My availability (AVAIL.2).
//
// When the coach CANNOT work: weekly (a day, all day or a window) and by date
// (one day or a range, all day or a window), each with an optional note their
// managers see. One PUT /api/schedule/availability saves the lot and REPLACES
// what was stored (AVAIL.1a); the managers at each of their studios are told
// once per save, inside 07:00-22:00. No approval.
//
// Every decision and every word is in lib/availability-form.js (there is no
// RN component test runner); this file renders. Dates use the pure-JS
// MonthCalendar and times a typed field (the AdjustSheet pattern on the
// Schedule tab): no native picker, so the screen ships over the air.

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useNavigation, Stack } from 'expo-router'
import { useHeaderHeight, usePreventRemove } from 'expo-router/react-navigation'
import {
  View, Text, Pressable, ScrollView, TextInput, Switch, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform, AccessibilityInfo,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { getMyAvailability, saveMyAvailability } from '../../../lib/availability-api'
import {
  AVAILABILITY_COPY as COPY, AVAILABILITY_TITLE, AVAILABILITY_INTRO, AVAILABILITY_NO_OVERNIGHT, WEEKDAY_CHIPS,
  createRowKeys, rowsFromServer, newRow, timeOnBlur, datesLabel, calendarRange, rangeFromCalendar,
  hasEnded, knownStartedKeys, formProblems, duplicateKeys, canAdd, startedNote, rowSummary,
  buildSaveBody, isDirty, loadOutcome, saveOutcome, closeAction, saveButtonState, impersonationLine,
} from '../../../lib/availability-form'
import { createInFlightGuard } from '../../../lib/in-flight-guard'
import { dublinTodayIso } from '../../../lib/dates'
import { AVAILABILITY_LIMITS } from 'shared/availability'
import MonthCalendar from '../../../components/MonthCalendar'
import TabletConstrained from '../../../components/TabletConstrained'

// Whole literal class names: NativeWind only compiles classes it can see.
const TONE_BOX = {
  ok: 'bg-green-500/10 border-green-500/30',
  warn: 'bg-amber-500/10 border-amber-500/40',
  error: 'bg-red-500/10 border-red-500/30',
}
const TONE_TEXT = { ok: 'text-green-700', warn: 'text-amber-700', error: 'text-red-700' }

export default function MyAvailability() {
  const { profile, impersonatingFrom } = useAuth()
  const router = useRouter()
  const navigation = useNavigation()
  const headerHeight = useHeaderHeight()
  const scrollRef = useRef(null)
  const nextKey = useRef(null)
  if (nextKey.current === null) nextKey.current = createRowKeys()
  // A double tap on Save must PUT once: `saving` is render state and a second
  // tap in the same frame still reads false; the latch is synchronous.
  const saveGuard = useRef(null)
  if (saveGuard.current === null) saveGuard.current = createInFlightGuard()

  // baseline: the cards as last loaded or saved; null until a load SUCCEEDS.
  // Nothing can be saved before then: a replace over a failed load would wipe
  // every rule the coach has.
  const [baseline, setBaseline] = useState(null)
  const [rows, setRows] = useState([])
  const [loadState, setLoadState] = useState({ loading: true, message: null, canRetry: false })
  const [saving, setSaving] = useState(false)
  const [showProblems, setShowProblems] = useState(false)
  const [serverErrors, setServerErrors] = useState({})
  const [message, setMessage] = useState(null) // { tone, text }
  const [openCalendar, setOpenCalendar] = useState(null) // the card whose calendar is open

  // The studio's day, not the phone's (ROSTER-FIX.7). Render-time: calendar
  // minDate and the card flags. A save reads it again at the moment of saving.
  const today = dublinTodayIso()
  const loaded = baseline !== null
  const dirty = loaded && isDirty(baseline, rows, { todayIso: today })

  const say = useCallback((next) => {
    setMessage(next)
    scrollRef.current?.scrollTo({ y: 0, animated: true })
    if (next?.text) AccessibilityInfo.announceForAccessibility(next.text)
  }, [])

  const loadRules = useCallback(async () => {
    setLoadState({ loading: true, message: null, canRetry: false })
    let res = null
    try {
      res = await getMyAvailability()
    } catch {
      // api() answers with an envelope rather than throwing; this is the belt.
    }
    const out = loadOutcome(res)
    if (!out.ok) {
      setLoadState({ loading: false, message: out.message, canRetry: out.canRetry })
      return
    }
    const fresh = rowsFromServer(out.data, nextKey.current)
    setRows(fresh)
    setBaseline(fresh)
    setServerErrors({})
    setLoadState({ loading: false, message: null, canRetry: false })
  }, [])

  // Once, on open. Never on focus: a refetch would overwrite edits in progress.
  useEffect(() => { loadRules() }, [loadRules])

  // Unsaved edits: Cancel, the Android back button and the iOS swipe-down all
  // ask first (gestureEnabled below is the belt for the swipe). Mid-save
  // nothing leaves.
  usePreventRemove(dirty || saving, ({ data }) => {
    const action = closeAction({ saving, dirty })
    if (action === 'block') return
    if (action === 'close') {
      navigation.dispatch(data.action)
      return
    }
    Alert.alert(COPY.discardTitle, COPY.discardBody, [
      { text: COPY.discardKeep, style: 'cancel' },
      { text: COPY.discardConfirm, style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ])
  })

  // Opened cold there is nothing to pop back to (time-off-new's guard).
  function leave() {
    if (router.canGoBack()) router.back()
    else router.replace('/(tabs)/schedule')
  }

  function update(key, patch) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
    setServerErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    setMessage(null)
  }

  function add(kind) {
    const row = newRow(kind, { todayIso: dublinTodayIso(), nextKey: nextKey.current })
    setRows((prev) => [...prev, row])
    if (kind === 'dated') setOpenCalendar(row.key)
    setMessage(null)
  }

  function remove(key) {
    setRows((prev) => prev.filter((r) => r.key !== key))
    setOpenCalendar((open) => (open === key ? null : open))
    setMessage(null)
  }

  function save() {
    return saveGuard.current.run(sendSave)
  }

  async function sendSave() {
    // "Today" at the moment of saving: a screen left open over midnight must
    // judge dates the way the server will.
    const todayIso = dublinTodayIso()
    const knownKeys = knownStartedKeys(baseline, todayIso)
    setShowProblems(true)
    setServerErrors({})
    const problems = formProblems(rows, { todayIso, knownKeys })
    if (!problems.ok) {
      say({ tone: 'error', text: [COPY.invalid, problems.banner].filter(Boolean).join(' ') })
      return
    }
    if (!isDirty(baseline, rows, { todayIso })) {
      say({ tone: 'ok', text: COPY.nothingToSave })
      return
    }
    const { body, keysByPath } = buildSaveBody(rows, { todayIso })
    setSaving(true)
    let res
    try {
      res = await saveMyAvailability(body)
    } catch (err) {
      res = { success: false, transport: true, error: String(err?.message || err) }
    } finally {
      setSaving(false)
    }
    const out = saveOutcome(res, { keysByPath })
    if (out.tone === 'ok') {
      setShowProblems(false)
      setOpenCalendar(null)
      if (out.saved) {
        const fresh = rowsFromServer(out.saved, nextKey.current)
        setRows(fresh)
        setBaseline(fresh)
      } else {
        // Saved, but the answer could not be read: read the rules back.
        await loadRules()
      }
    } else {
      setServerErrors(out.rowErrors)
    }
    say({ tone: out.tone, text: out.message })
  }

  const problems = formProblems(rows, { todayIso: today, knownKeys: knownStartedKeys(baseline, today) })
  const dups = duplicateKeys(rows, { todayIso: today })
  const button = saveButtonState({ loaded, saving, dirty })
  const viewingAs = impersonationLine(impersonatingFrom, profile)
  const problemFor = (row) => serverErrors[row.key] || (showProblems ? problems.byKey[row.key] : null) || null

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
      className="flex-1 bg-un1t-bg"
    >
      <Stack.Screen
        options={{
          title: AVAILABILITY_TITLE,
          gestureEnabled: !dirty && !saving,
          headerLeft: () => (
            <Pressable onPress={leave} hitSlop={10} accessibilityRole="button" accessibilityLabel="Cancel, close without saving">
              <Text className="text-base text-un1t-text">Cancel</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              onPress={save}
              disabled={button.disabled}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Save availability"
              accessibilityState={{ disabled: button.disabled, busy: button.busy }}
            >
              {button.busy ? (
                <ActivityIndicator />
              ) : (
                <Text className={`text-base font-semibold ${button.disabled ? 'text-un1t-muted' : 'text-un1t-text'}`}>Save</Text>
              )}
            </Pressable>
          ),
        }}
      />

      <TabletConstrained className="flex-1">
        <ScrollView
          ref={scrollRef}
          contentContainerClassName="p-4 pb-16"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        >
          <Text className="text-sm text-un1t-subtle mb-1">{AVAILABILITY_INTRO}</Text>
          <Text className="text-xs text-un1t-subtle mb-4">{AVAILABILITY_NO_OVERNIGHT}</Text>

          {viewingAs ? (
            <View className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-3 mb-4">
              <Text className="text-sm text-amber-700">{viewingAs}</Text>
            </View>
          ) : null}

          {message ? (
            <View accessibilityLiveRegion="polite" className={`border rounded-xl p-3 mb-4 ${TONE_BOX[message.tone]}`}>
              <Text className={`text-sm ${TONE_TEXT[message.tone]}`}>{message.text}</Text>
            </View>
          ) : null}

          {loadState.loading ? (
            <View className="py-12 items-center">
              <ActivityIndicator />
              <Text className="text-sm text-un1t-subtle mt-2">{COPY.loading}</Text>
            </View>
          ) : !loaded ? (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
              <Text className="text-sm text-red-700">{loadState.message}</Text>
              {loadState.canRetry ? (
                <Pressable
                  onPress={loadRules}
                  accessibilityRole="button"
                  className="self-start mt-3 px-4 py-2 rounded-full bg-un1t-surface border border-red-500/30 active:opacity-70"
                >
                  <Text className="text-sm font-semibold text-red-700">{COPY.retry}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            ['weekly', 'dated'].map((kind) => {
              const cards = rows.filter((r) => r.kind === kind)
              return (
                <View key={kind} className="mb-6">
                  <SectionHeader kind={kind} canAddMore={canAdd(rows, kind, { todayIso: today })} onAdd={() => add(kind)} />
                  {cards.length === 0 ? (
                    <Text className="text-sm text-un1t-subtle px-1">{kind === 'weekly' ? COPY.weeklyEmpty : COPY.datedEmpty}</Text>
                  ) : cards.map((row) => (
                    <RuleCard
                      key={row.key}
                      row={row}
                      today={today}
                      problem={problemFor(row)}
                      duplicate={dups.has(row.key)}
                      calendarOpen={openCalendar === row.key}
                      onToggleCalendar={() => setOpenCalendar((open) => (open === row.key ? null : row.key))}
                      onChange={(patch) => update(row.key, patch)}
                      onRemove={() => remove(row.key)}
                    />
                  ))}
                </View>
              )
            })
          )}
        </ScrollView>
      </TabletConstrained>
    </KeyboardAvoidingView>
  )
}

function SectionHeader({ kind, canAddMore, onAdd }) {
  const heading = kind === 'weekly' ? COPY.weeklyHeading : COPY.datedHeading
  const label = kind === 'weekly' ? COPY.addWeekly : COPY.addDated
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-2 mb-2 px-1">
      <Text accessibilityRole="header" className="text-xs uppercase tracking-wider text-un1t-subtle">{heading}</Text>
      {canAddMore ? (
        <Pressable
          onPress={onAdd}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={label}
          className="flex-row items-center px-3 py-1.5 rounded-full bg-un1t-surface border border-un1t-border active:opacity-70"
        >
          <Ionicons name="add" size={16} color="#111827" />
          <Text className="text-sm font-semibold text-un1t-text ml-1">{label}</Text>
        </Pressable>
      ) : (
        <Text className="text-xs text-un1t-subtle">{kind === 'weekly' ? COPY.weeklyFull : COPY.datedFull}</Text>
      )}
    </View>
  )
}

function RuleCard({ row, today, problem, duplicate, calendarOpen, onToggleCalendar, onChange, onRemove }) {
  const summary = rowSummary(row, { todayIso: today })

  // Ended while the screen was open: history, shown but not editable, not sent.
  if (hasEnded(row, today)) {
    return (
      <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-3 opacity-60">
        <Text className="text-sm font-semibold text-un1t-text">{summary}</Text>
        <Text className="text-xs text-un1t-subtle mt-1">{COPY.ended}</Text>
      </View>
    )
  }

  const started = startedNote(row, { todayIso: today })
  const range = calendarRange(row)
  const dates = datesLabel(row)

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-3">
      <View className="flex-row items-start justify-between mb-3">
        <Text className="text-sm font-semibold text-un1t-text flex-1 mr-3">{summary}</Text>
        <Pressable onPress={onRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove ${summary}`} className="p-1 active:opacity-60">
          <Ionicons name="trash-outline" size={20} color="#DC2626" />
        </Pressable>
      </View>

      {row.kind === 'weekly' ? (
        <View accessibilityRole="radiogroup" accessibilityLabel="Day of the week" className="flex-row gap-1 mb-3">
          {WEEKDAY_CHIPS.map((d) => {
            const on = row.weekday === d.code
            return (
              <Pressable
                key={d.code}
                onPress={() => onChange({ weekday: d.code })}
                accessibilityRole="radio"
                accessibilityLabel={d.label}
                accessibilityState={{ checked: on }}
                className={`flex-1 items-center py-2 rounded-lg border ${on ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-bg border-un1t-border'}`}
              >
                <Text numberOfLines={1} adjustsFontSizeToFit className={`text-xs font-semibold ${on ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>
                  {d.short}
                </Text>
              </Pressable>
            )
          })}
        </View>
      ) : (
        <View className="mb-3">
          <Pressable
            onPress={onToggleCalendar}
            accessibilityRole="button"
            accessibilityLabel={`Dates, ${dates}`}
            accessibilityHint={calendarOpen ? 'Closes the calendar' : 'Opens a calendar to choose the first and last day'}
            accessibilityState={{ expanded: calendarOpen }}
            className="flex-row items-center justify-between bg-un1t-bg border border-un1t-border rounded-xl px-3 py-3 active:opacity-70"
          >
            <Text className="text-base text-un1t-text flex-1 mr-2">{dates}</Text>
            <Ionicons name={calendarOpen ? 'chevron-up' : 'chevron-down'} size={18} color="#64748B" />
          </Pressable>
          {calendarOpen ? (
            <View className="mt-2">
              <MonthCalendar
                startDate={range.startDate}
                endDate={range.endDate}
                minDate={today}
                onChange={(picked) => onChange(rangeFromCalendar(picked))}
              />
              <Text className="text-xs text-un1t-subtle mt-1 px-1">{COPY.calendarHint}</Text>
            </View>
          ) : null}
          {started ? <Text className="text-xs text-un1t-subtle mt-2">{started}</Text> : null}
        </View>
      )}

      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-base text-un1t-text">All day</Text>
        <Switch value={row.all_day} onValueChange={(v) => onChange({ all_day: v })} accessibilityLabel="All day" />
      </View>
      {!row.all_day ? (
        <View className="flex-row gap-3 mb-3">
          <TimeField label="From" value={row.start_time} onChange={(t) => onChange({ start_time: t })} />
          <TimeField label="To" value={row.end_time} onChange={(t) => onChange({ end_time: t })} />
        </View>
      ) : null}

      <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5 mt-1">Note (optional)</Text>
      <TextInput
        value={row.note}
        onChangeText={(t) => onChange({ note: t })}
        maxLength={AVAILABILITY_LIMITS.noteChars}
        placeholder="e.g. college on Tuesdays"
        placeholderTextColor="#64748B"
        returnKeyType="done"
        accessibilityLabel="Note, optional. Your managers can see it."
        className="bg-un1t-bg border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text"
      />

      {duplicate && !problem ? <Text className="text-xs text-amber-700 mt-2">{COPY.duplicate}</Text> : null}
      {problem ? <Text accessibilityRole="alert" className="text-sm text-red-700 mt-2">{problem}</Text> : null}
    </View>
  )
}

// A typed time. The keyboard is numbers-and-punctuation on iOS (the default
// keyboard on Android); timeOnBlur tidies '930' to '09:30' on the way out.
function TimeField({ label, value, onChange }) {
  return (
    <View className="flex-1">
      <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        onEndEditing={(e) => {
          const tidy = timeOnBlur(e?.nativeEvent?.text ?? value)
          if (tidy !== value) onChange(tidy)
        }}
        placeholder="09:30"
        placeholderTextColor="#64748B"
        keyboardType="numbers-and-punctuation"
        maxLength={7}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="done"
        accessibilityLabel={`${label}, a time like 09:30 or 5:30pm`}
        className="bg-un1t-bg border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text font-mono"
      />
    </View>
  )
}
```

- [ ] **Step 2: Lint, imports, OTA paths**

Run: `npm run check:mobile-lint && npm run check:mobile-imports && npm run check:ota-paths`
Expected: all exit 0. `check:mobile-imports` resolves `AVAILABILITY_LIMITS` from `shared/availability` and every name from `lib/availability-form`. (`expo-router/react-navigation` is third-party and outside that check; the PR's **Mobile bundle export** job, `.github/workflows/mobile-export.yml`, runs Metro over it.) `check:ota-paths`: no new top-level entry under `mobile/`.

- [ ] **Step 3: Commit**

```bash
git add 'mobile/app/(staff)/schedule/availability.jsx'
git commit -m "AVAIL.2 — phone: My availability screen (weekly + dated, one replace, server issues per card)

Modal in the schedule stack beside the leave form. Dates: the pure-JS month
calendar; times: a typed field. No native dependency. Unsaved edits ask
before leaving; a failed load can never be saved over.

Bundle paths: merging publishes an OTA at 100%.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The Schedule-tab row (OTA bundle paths)

**Files:**
- Create: `mobile/components/schedule/MyAvailabilityRow.jsx`
- Modify: `mobile/app/(staff)/(tabs)/schedule.jsx` (one import after `import ManageMode from '../../../components/schedule/ManageMode'`, line 42; one line before `</ScrollView>`, line 746)

- [ ] **Step 1: Write the row**

```jsx
// mobile/components/schedule/MyAvailabilityRow.jsx
// AVAIL.2 — "My availability" on the Schedule tab (Me view): opens the form
// where a coach says when they can't work. Every role; no gate of its own
// (the Schedule tab is the gate). Words from lib/availability-form.js.

import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { AVAILABILITY_ROW } from '../../lib/availability-form'

export default function MyAvailabilityRow({ onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={AVAILABILITY_ROW.title}
      accessibilityHint={AVAILABILITY_ROW.subtitle}
      className="mt-3 flex-row items-center bg-un1t-surface border border-un1t-border rounded-2xl p-4 active:opacity-70"
    >
      <Ionicons name="time-outline" size={20} color="#111827" />
      <View className="flex-1 ml-3">
        <Text className="text-sm font-semibold text-un1t-text">{AVAILABILITY_ROW.title}</Text>
        <Text className="text-xs text-un1t-subtle mt-0.5">{AVAILABILITY_ROW.subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
    </Pressable>
  )
}
```

- [ ] **Step 2: Mount it in the Me view**

In `mobile/app/(staff)/(tabs)/schedule.jsx`, after `import ManageMode from '../../../components/schedule/ManageMode'` (and after ICSFEED.1's `CalendarSubscribeRow` import if it has merged), add:

```js
import MyAvailabilityRow from '../../../components/schedule/MyAvailabilityRow'
```

Directly before the `</ScrollView>` that closes the tab's scroll view (the one followed by the `LeaveFloatingButtons` block), and **after** ICSFEED.1's `{view === 'me' && <CalendarSubscribeRow />}` line if it is there, add:

```jsx
        {/* AVAIL.2 — when the coach can't work. Me view, phone and iPad, every role. */}
        {view === 'me' && <MyAvailabilityRow onPress={() => router.push('/schedule/availability')} />}
```

It sits inside the ScrollView's `pb-32`, so the floating leave buttons never cover it. `router` is already in scope (`const router = useRouter()` in `Schedule`).

- [ ] **Step 3: Lint, imports, OTA paths**

Run: `npm run check:mobile-lint && npm run check:mobile-imports && npm run check:ota-paths`
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add mobile/components/schedule/MyAvailabilityRow.jsx 'mobile/app/(staff)/(tabs)/schedule.jsx'
git commit -m "AVAIL.2 — phone: My availability row on the Schedule tab (Me view, every role)

Bundle paths: merging publishes an OTA at 100%.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine).

- [ ] **Focused tests, both zones for the date code:**

```bash
npx vitest run mobile/lib/availability-form.test.js mobile/lib/availability-api.test.js mobile/lib/notification-nav.test.js \
  mobile/lib/schedule-api.test.js shared/availability.test.js src/lib/push-channels.test.js tests/ota-trigger-paths.test.js
for tz in Europe/Dublin America/Los_Angeles; do
  TZ=$tz npx vitest run mobile/lib/availability-form.test.js
done
```

Expected: `0 failed` every time.

- [ ] **The 12-command CI mirror (CLAUDE.md "Build, test & ship"):**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0, and vitest reports `0 failed`.
- `check:mobile-imports` resolves every `shared/availability`, `shared/time-off` and `lib/availability-form` name.
- `check:mobile-lint` is clean on the five new or changed `.jsx`/`.js` files (`react-hooks/exhaustive-deps` is an error there).
- `check:ota-paths` is clean: no new top-level entry under `mobile/`.
- `check:mobile-parity`, `check:route-guards`, `check:location-scoping`, `check:rls-restrictive`, `check:select-columns`, `check:bundle-sql` and `npm run lint` are untouched by a phone-only change and must stay green.

- [ ] **The build:**

```bash
npm run build
```

Expected: `✓ Compiled successfully`. Nothing web changed; it is the standing gate.

- [ ] **On the PR:** **Test & lint** and **Next build** (required) green on the final rebase, and **Mobile bundle export** (`mobile-export.yml`, Metro over the real bundle) green. The last one is the only check that bundles `usePreventRemove` from `expo-router/react-navigation`.

- [ ] **Independent review** (standing rule). Point the reviewer at:
  - D4 (the four replace guards) against `buildSaveBody`, `isDirty` and `saveButtonState`, and whether any path can PUT without a successful load.
  - D5 against AVAIL.1a's merged `ruleProblem` and `readKnownDatedKeys`: the phone's `knownStartedKeys` must match the server's set.
  - D6: every failure keeps the edits; only `tone: 'ok'` replaces the cards.
  - The screen in the iOS Simulator (Claude Code iOS Simulator panel) on the smallest iPhone size with the keyboard up, with VoiceOver, and at the largest text size. jsdom cannot see layout, and there is no RN test runner. 🔴 The simulator talks to PROD: save only on a test staff account, or on your own account and then put it back.

### Merge steps (after review is approved and the gate is green)

1. AVAIL.1a's OTA has published and its EAS Update run is green (Deploy order, step 1).
2. Rebase on `origin/main`. If ICSFEED.1 has merged in the meantime, resolve `schedule.jsx` so both rows are there, ICSFEED's first (Task 8). Wait for the required checks on the final rebase, and merge.
3. Watch the EAS Update run (`eas-update.yml`). **One phone update at a time**: do not merge CANDIDATES.1 (this batch's partner, also OTA) until this run is green.
4. On a handset after the update lands, run the checklist below (Richard's, or with him alongside). The first real save on prod notifies real managers: do it on a quiet day, on a coach who has agreed, or on a test account.

### PR

**Title:** `AVAIL.2 — coaches set their own availability on the phone`

**Body must say, in this order:**
1. **Depends on AVAIL.1a (#<1a PR>, mig 630), merged and live.** Uses `GET/PUT /api/schedule/availability` and `shared/availability.js` as they are. No migration, no API change.
2. **🔴 This merge publishes an OTA at 100%.** Every changed file is under `mobile/app/`, `mobile/components/` or `mobile/lib/`. No native dependency, so no store build and no `runtimeVersion` bump. No new top-level `mobile/` entry.
3. What coaches get: a "My availability" row on the Schedule tab (Me view, every role) opening a form for weekly and dated unavailable windows, saved with one replace. The same rules and words as the web editor (shared). Pickers: the leave form's month calendar and a typed time field.
4. The guards (D4, D6): no save without a successful load; no write when nothing changed; the body is canonical and each server issue lands under its card; ended dates are left out; backdating is judged as the server does; failures keep the edits (offline amber, "saving again is safe"); leaving with unsaved edits asks.
5. The "… Availability changes" notification toggle already renders from `MOBILE_PERMISSIONS` (phone staff permissions editor, web staff form and role permissions). Verified, nothing changed. The manager's push now opens the schedule in Manage mode (was a dead tap).
6. The month calendar gains screen-reader labels (the leave form shares it).
7. **Handset checklist** (to run after the update lands):
   - [ ] Schedule → Me → "My availability" opens as a sheet and loads what the web editor shows.
   - [ ] Add a weekly Tuesday, not all day, type `9` and `12`: the fields tidy to 09:00 and 12:00; Save → "Saved. Your managers will get a notification."; a manager's phone gets "Availability changed" (inside 07:00–22:00) and the tap opens the schedule in Manage mode.
   - [ ] Save stays dimmed when nothing changed; a note-only edit enables it.
   - [ ] Add a date range with two taps in the calendar, turn All day off, 17:00–19:30 → saved; the web week view shades it.
   - [ ] End time before start → the card says so after Save, and nothing is sent.
   - [ ] Airplane mode → Save → amber "Couldn't confirm it saved…", edits still there; back online → Save → Saved.
   - [ ] Cancel with edits → "Discard your changes?"; the swipe-down does not dismiss while there are edits; Android back asks too.
   - [ ] Smallest iPhone with the keyboard up: the note of the last card scrolls above the keyboard; Save stays reachable.
   - [ ] VoiceOver: weekday chips read "Monday, selected"; calendar days read full dates; Save reads dimmed when there is nothing to save; the Saved message is announced.
   - [ ] Largest text size: chips, headers and buttons wrap without overlapping.
   - [ ] iPad: the form is constrained to the centre column.
   - [ ] View as user (master) on a test coach: the amber "You are viewing as…" line shows; the save is recorded with the master as actor and the master gets no notice.
   - [ ] A date that started before today: the "This started before today…" line shows; a note edit saves; a time edit says "Start today or later".
8. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit another row: `merge=union` duplicates an edited row.

```
| #<PR> | AVAIL.2 — coaches set their own availability on the phone | 2026-09-2x. Wave 2 PR 17. No migration, no API change; **OTA** (mobile/app, components, lib; no native dependency). "My availability" row on the Schedule tab (Me view, every role) → modal `mobile/app/(staff)/schedule/availability.jsx`: weekly windows (weekday chips, all day or typed From/To) and dated ones (the leave form's pure-JS month calendar, range by two taps, all day or a same-day window), note ≤200, managers see notes. One `PUT /api/schedule/availability` (AVAIL.1a replace). Decisions in `mobile/lib/availability-form.js` (vitest, both TZs): tolerant typed times (9, 930, 5:30pm); canonical body (sorted, exact copies once) with `keysByPath` mapping server issue paths back to cards; ended dated rows left out; backdating judged against the loaded rules (the server's set); Save only after a successful load and only when `isDirty`; offline = amber "saving again is safe", 401 = sign-in expired, other refusals in the server's words; unsaved edits ask before leaving (`usePreventRemove` + no swipe while dirty). `mobile/lib/availability-api.js` (own file, wire-contract test). `availability_changed` push → `/(tabs)/schedule?view=manage`. MonthCalendar gains screen-reader labels. The "… Availability changes" toggle already rendered from `MOBILE_PERMISSIONS` (verified). |
```

---

### Review notes / open questions

1. **Last save wins across devices.** The PUT has no version check: a coach with the web editor open on a laptop and this screen on the phone can overwrite one save with the other. Each save is logged and the managers' notices fold, so the history is complete, but the stored rules are the last save's. A fix is an `expected` snapshot on the PUT (409 when the stored rules differ from what the form loaded). It is small, but it is an API change, so it belongs in AVAIL.1a's route, not here.
2. **New weekly rows default to all day** (D10). The web defaults to a time window with empty times. Both reach the same rules. Say if the two should match.
3. **Typed times, not a wheel** (D3). No native picker is installed, and adding one would need a store build. A pure-JS time wheel (like MonthCalendar for dates) is possible later if coaches find typing awkward. On Android the time field opens the default keyboard, because `numbers-and-punctuation` is iOS only.
4. **The manager's tap opens Manage mode** (D8), which does not yet show availability. CANDIDATES.1 badges the phone picker; GRID.1 is web. When a phone view of one coach's availability exists, route to it with `data.profile_id`.
5. **One entry point.** The row is on the Schedule tab only. A user whose `schedule` permission is switched off has no way in (default on for every role). A More tile is one line in `more.jsx` if Richard wants it.
6. **A started rule's times cannot be changed in place.** This is AVAIL.1a review 6 (no backdating): the coach picks new dates from today, and the server keeps the days already gone (review 5). The phone says so under the card. An automatic split ("from today, 9–12") would be friendlier, but it would put two rules where the coach sees one, so it is not done.
7. **Managers mute this notice only through the owner's permission editor.** There is no self-service notification settings screen on the phone. This was already true of every `notify_*` toggle, and it is out of scope here.
8. **MonthCalendar's "today" highlight uses the device date**, not Dublin (its own `todayIso`). This screen passes `minDate` from `dublinTodayIso()`, so what can be picked is right. Only the blue "today" number can be a day off on a phone set to another zone. It is pre-existing and shared with the leave form.
9. **The ICSFEED.1 row and this row stack** in the Me view (ICSFEED first, `mt-6`, then this one, `mt-3`). If ICSFEED.1 has not merged when this builds, this row sits alone below the day's list. Either order works.
10. **Removing a started rule** keeps its elapsed days on the server (review 5). The card disappears from the form, which is correct: the GET only returns rules that have not ended. No extra confirmation is asked.
