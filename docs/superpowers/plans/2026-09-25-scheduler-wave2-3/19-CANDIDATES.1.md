## PR CANDIDATES.1 — ranked candidates wherever a coach is picked: free, leave, availability, on site, week hours, rest (web and phone)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everywhere a coach is picked, the list is ranked and each row says why. There are three such pickers: the web assign picker (`AssignCoachModal`), the phone's Manage-mode "Add coach" sheet and the phone's "Ask a coach to cover" sheet (targeted swap). One server endpoint, `GET /api/schedule/blocks/[id]/candidates`, answers for one block. It lists every eligible coach at the block's studio: active, a member there, and not already live on the block. For each one it returns:

- `free`: no live shift overlapping this one at ANY studio of the organisation.
- `on_leave`: approved leave covering the day, with its type.
- `unavailable`: an AVAIL.1 rule touching the shift, with a short summary.
- `on_site`: already rostered at this studio that day, with the nearest shift.
- `week_minutes`: rostered time Mon–Sun across the organisation's studios, using effective windows.
- `contracted_hours`: employees only.
- `rest_gap` and `week_over`: WORKTIME.1's advisories.
- a `rank` and a one-line `reason`.

Nothing blocks: the picker still lets a manager pick anyone eligible. It only sorts and badges.

**Why:** This comes from the 19 Sep product review, "plan with inputs". Today the web picker lists the studio A–Z and badges from what the calendar happens to hold. That is this studio's visible range only, so a clash at the other studio is invisible. WORKTIME.1's per-open GET adds rest and week badges, and AVAIL.1b adds an "Unavailable" badge. The phone lists everyone A–Z with nothing. A manager filling a gap holds four facts per coach in their head. The coach asking a colleague to cover has none.

**Ships:** a web deploy **and an OTA**. **No migration.** Every column read already exists (see "Where contracted hours live").

These bundle paths change:

- `shared/candidates.js` (new)
- `shared/dashboard-data.js`
- `mobile/lib/candidates-view.js` (new)
- `mobile/lib/schedule-api.js`
- `mobile/components/schedule/CoachPickerSheet.jsx`
- `mobile/components/schedule/ManageMode.jsx`
- `mobile/components/dashboard/PersonalDashboard.jsx`

Test files under `shared/` and `mobile/lib/` also change; those are accepted over-triggers (`tests/ota-trigger-paths.test.js`). **So the merge publishes a phone update.** The program rule is one phone update at a time. AVAIL.2 (17) is this batch's pair and also publishes, so whichever merges second waits for the first's EAS Update run to go green.

**Depends on:**

- WORKTIME.1 (#1758, merged): `shared/working-time.js`, `src/lib/working-time-data.js`.
- SHIFTTYPE.1 (#1759, merged).
- **AVAIL.1a**: `shared/availability.js`, `src/lib/availability-server.js` `readStudioAvailability`, mig 630.
- **AVAIL.1b**: the picker's client-side "Unavailable" badge, which this PR folds into the ranked list.

Task 0 says what to do when 1a or 1b is unmerged.

---

### Decisions this plan makes (each flagged again in Review notes)

1. **Two audiences, one endpoint.** The phone's targeted-swap picker is used by a COACH, not a manager. A coach must never see a colleague's leave type, availability note, week hours or contract. So the route answers two audiences:
   - **`manager`** = `MANAGER_ROLES` AT the block's studio (master bypasses, as in every schedule route). A manager gets every field.
   - **`colleague`** = a caller holding a LIVE assignment on the block, i.e. the coach asking for cover. A colleague gets `profile_id, full_name, role, free, rank, tier, reason` and nothing else. Ranking is computed on that projection, so the order leaks only free or working: a colleague on leave sorts alphabetically among the free ones. Their reason line is "Free then" or "Working then".

   Anyone else at the studio gets 403. An outsider gets 404 (`assertLocationAccessOr404`), so the block id is never confirmed. The brief said "manager-only", but a manager-only endpoint cannot serve the swap picker, whose user is the coach. The colleague projection is the smallest thing that can. Review note 1.
2. **The ranking rule** (pure, `shared/candidates.js` `compareCandidates`, tested):
   1. Tier: `ready`; then `advisory` (short rest or a week over 48 hours); then `unavailable` (an AVAIL rule); then `blocked` (approved leave, or already working then at any studio). `blocked` is the hard bottom.
   2. On site that day first.
   3. An EMPLOYEE still under their contracted hours first, lowest share of the contract first. Then everyone else (contractors, employees at or over contract, unknown contract), fewest hours this week first.
   4. Name (`localeCompare`, base sensitivity), then id.

   Step 3 is how "fewer week hours relative to contract" becomes a total order when contractors have no contract. An employee's contracted hours are already paid for, so filling them first is the cheaper roster. The rule never reads a rate to decide that. Review note 3.
3. **Unknown is neutral, never an all-clear.** A fact the server could not read is `null`, not `false`, and `data.checked` names what was not checked. Both pickers then print "Could not check leave and availability, so the order may be off." A failed MEMBER read fails the request (500): there is no list to rank. In that case the pickers fall back to their old A–Z list and say so.
4. **Effective windows and real instants.** Every window, the target block included, goes through WORKTIME.1's `workingWindow` (override → block → template, Dublin wall clock → UTC instant). "Overlapping" is strict: a shift that ends as this one starts is `on_site` with `gap_minutes: 0`, not busy. The old badge (`coachConflictsForBlock`) compares block times only and sees this studio's visible range only. So an override that runs a coach late now counts, and so does the other studio.
5. **`week_minutes` excludes this shift.** It is the load BEFORE assigning, the fair thing to sort by. `week_over` is WORKTIME's with-this-shift total, shown only when it is over 48 hours.
6. **Rest and 48 hours stay employees-only** (`isWorkingTimeCovered`, `employment_type = 'fte'`), exactly as in WORKTIME.1. `free`, `on_site`, `week_minutes`, leave and availability apply to everyone.
7. **The web picker replaces WORKTIME.1's per-open GET with this endpoint.** The candidates answer runs the same rule (`candidateWorkingTime`) on the same read: the block's Mon–Sun week, one day either side, `siblingLocationIds` scope, `COUNT_UNPUBLISHED_ELSEWHERE`. It also covers more people (contractors too). Two asks per open would read the same week of shifts twice, and the badges could disagree when one ask fails and the other does not. The badge TEXT and TITLES are kept byte-for-byte ("9h 30m rest", "48h 30m this week", "on approved leave", "Unavailable: …"), so a manager sees the same words. `GET /api/schedule/working-time` itself **stays for this deploy**, because a tab left open across the deploy still calls it. Deleting it is a follow-up.
8. **AVAIL.1b's client-side badge becomes the FALLBACK.** With a ranked answer, the server's `unavailable` fact is the badge, judged against the effective window (1b judged the block's own times). The picker renders exactly what main renders today — the studio's staff A–Z with the local clash, leave and availability badges — in three cases: while the answer is in flight, when it fails, or when it is not understood (an older server, or the existing component tests' mocks). So every existing picker test keeps passing untouched.
9. **Where contracted hours live.** They live in `profile_compensation.contracted_hours_per_week`; mig 152 moved them there, and that table has owner/master-only RLS. `profiles.contracted_hours_per_week` is DEPRECATED (mig 152:153-154), and its read is revoked (mig 153b). A read-only aggregate on 25 Sep found 8 active employees, all 8 with contracted hours in `profile_compensation`, and 0 disagreeing with the old column. The column IS in the pay table, so:
   - it is selected **by name only**: `.select('profile_id, contracted_hours_per_week')`. Never use `getCompensationForProfiles` (`src/lib/profile-compensation.js:76`), which reads all five columns and discards its error;
   - it is read for employees only;
   - it appears in the `manager` projection only.

   Program default 4 already shows contracted hours to managers ("hours only, never rates, reach anyone but owners"). Head coaches are in `MANAGER_ROLES`, so they see colleagues' contracted hours too. Review note 2.
10. **Pay never enters.** No rate, salary, overtime or cost column is selected anywhere. Tests assert that no key or select string in this feature matches `/rate|salary|overtime|cost/`. `profiles` is read through the member embed, for `id, full_name, active, deleted_at, employment_type` only.
11. **The swap picker needs the block id.** Today's dashboard shift rows (`shared/dashboard-data.js` `fetchDashboardShifts`, lines 95-122) carry the assignment id as `id` and no block id. This PR adds `shift_blocks.id` to that embed and `block_id` to the row. The row is the coach's own shift, so nothing new is revealed. `shared/` publishes either way.

### Query budget (per call)

| # | Read | Manager | Colleague | Paged / bounded |
|---|---|---|---|---|
| 1 | `shift_blocks` by id (+ template times, `shift_assignments(profile_id, status)`) | ✓ | ✓ | one row |
| 2 | `profile_locations` at the block's studio, embedding `profiles!inner(id, full_name, active, deleted_at, employment_type)` | ✓ | ✓ | `.range()` pages of 1,000, ordered by `profile_id` |
| 3-4 | `siblingLocationIds`: `locations` ×2 | ✓ | ✓ | an organisation has a handful of studios |
| 5 | `shift_assignments` of every candidate, org scope, `[Mon−1, Sun+1]` (`readOrgShiftRows`) | ✓ | ✓ | pages of 1,000, ordered by `id` |
| 6 | approved `time_off_requests` covering the date | ✓ | — | pages of 1,000, ordered by `id` |
| 7-8 | `readStudioAvailability` (AVAIL.1a): its member read, then `staff_unavailability` | ✓ | — | rules paged at 1,000 |
| 9 | `profile_compensation(profile_id, contracted_hours_per_week)` for employees | ✓ | — | `.in()` chunks of 200 |

The manager path makes **9 fixed queries**, plus one more per extra 1,000 rows or 200 employees; reads 5-9 run in parallel. The colleague path makes **5**. Neither grows with the number of blocks on screen, because it is one call per picker open. Today's largest studio has 13 members (live count, 25 Sep).

**Prerequisite:** a fresh worktree (Task 0). Run tests with `npx vitest run <file>`. Run date-touching tests twice, under `TZ=Europe/Dublin` and `TZ=America/Los_Angeles`. zsh treats `[id]` as a glob, so single-quote every path that contains it.

**Files:**

| File | Responsibility | OTA |
|---|---|---|
| `src/lib/working-time-data.js` (modify: extract lines 123-159 into exported `readOrgShiftRows`) | one org-scoped, paged shift reader for both features | |
| `src/lib/working-time-data.test.js` (modify: import line 11; append a describe) | the extraction | |
| `shared/candidates.js` (create) | facts, tiers, ranking, copy, answer parsing (pure) | **yes** |
| `shared/candidates.test.js` (create) | tests | yes (test file) |
| `src/lib/candidates-data.js` (create) | the reads: members, leave, contracted hours; `loadBlockCandidates` | |
| `src/lib/candidates-data.test.js` (create) | tests | |
| `src/app/api/schedule/blocks/[id]/candidates/route.js` (create) | the gate and the two audiences | |
| `src/app/api/schedule/blocks/[id]/candidates/route.test.js` (create) | tests | |
| `src/lib/openapi.js` (modify: after the WORKTIME.1 registration, main lines 4577-4593) | register the route | |
| `src/lib/openapi.test.js` (modify: before `it('declares webhook + bridge auth schemes'`) | pin it | |
| `src/components/ScheduleCalendar.jsx` (modify: imports near lines 60-66, a constant, `AssignCoachModal`) | ranked list, badges, hours line, fallback | |
| `src/components/ScheduleCalendar.candidates.test.jsx` (create) | the web wiring | |
| `src/components/ScheduleCalendar.working-time.test.jsx` (modify: drop the picker tests) | its picker half moves to the new file | |
| `shared/dashboard-data.js` (modify: lines 100 and 108) | dashboard shift rows carry `block_id` | **yes** |
| `shared/dashboard-data.test.js` (modify: the D1 describe) | pin it | yes (test file) |
| `mobile/lib/schedule-api.js` (modify: after `assignCoachToBlock`, line 188) | `getBlockCandidates` through `api()` | **yes** |
| `mobile/lib/schedule-api.test.js` (modify: export list lines 41-62; a test) | wire contract | yes (test file) |
| `mobile/lib/candidates-view.js` (create) | request lifecycle and the sheet's view model (pure) | **yes** |
| `mobile/lib/candidates-view.test.js` (create) | tests | yes (test file) |
| `mobile/components/schedule/CoachPickerSheet.jsx` (modify: whole file, 58 lines) | renders ranked rows + reason + note | **yes** |
| `mobile/components/schedule/ManageMode.jsx` (modify: imports 14-18, state, `openPicker` 159-162, location effect 147-151, sheet 241-243) | asks per open | **yes** |
| `mobile/components/dashboard/PersonalDashboard.jsx` (modify: imports 25-33, state near 422, `openSwapPicker` 641-652, sheet 1090-1101) | asks per open (colleague) | **yes** |
| `docs/CHANGELOG.md` (modify) | one row, after `gh pr create` | |

**Naming traps, already checked** (25 Sep, `git grep` over `src/`, `shared/` and `mobile/` on `origin/main`):

- None of these names exists yet: `rankCandidates`, `candidateTier`, `candidateReason`, `CANDIDATE_TIERS`, `compareCandidates`, `candidateBadges`, `loadBlockCandidates`, `candidatePickerRows`, `readOrgShiftRows`, `readContractedHours`, `buildCandidates`, `candidateFacts`.
- There is no `src/lib/candidates.js`, so `tests/shared-pair-sync.test.js` has nothing to classify. That is why the server file is `candidates-data.js`.
- The date and time helpers in `shared/candidates.js` stay private, because `src/lib` already exports `addDaysISO`, `mondayOf` and `formatTime12h`.
- Regex matching in the shared file uses `String#match`, not `RegExp#exec`. (The workspace's security hook flags any `exec(` in a plan or source file.)

**Conflict hotspots:** `src/components/ScheduleCalendar.jsx` (AVAIL.1b, BLOCKEDIT.1 and REPLACE.1 touch it), `mobile/lib/schedule-api.js` and its test's export list (AVAIL.2 may add wrappers; keep both names, sorted), `shared/dashboard-data.js` and `docs/CHANGELOG.md`. Rebase before merge, and merge in batch order.

---

### Task 0: Preflight — what has merged, and where to branch

- [ ] **Step 1: Read the state**

```bash
cd /Users/richardivers/code/un1t-crm-wave23plan
git fetch origin main
git log origin/main --oneline -30 | grep -E 'AVAIL\.1a|AVAIL\.1b|WORKTIME\.1|SHIFTTYPE\.1'
git show origin/main:shared/availability.js > /dev/null 2>&1 && echo "1a: shared/availability.js on main"
git show origin/main:src/lib/availability-server.js 2>/dev/null | grep -n 'export async function readStudioAvailability'
git grep -n 'unavailableFor' origin/main -- src/components/ScheduleCalendar.jsx && echo "1b: picker badge on main"
```

Also run Supabase MCP `list_migrations` (project `iyvtbjjxdggiadzwwvdj`) and confirm `630` is applied.

- [ ] **Step 2: Choose the base**

| Case | State | What to do |
|---|---|---|
| **A** (expected) | 1a and 1b merged, mig 630 applied | Branch off `origin/main`. Do every task in order. |
| **B** | 1a merged, 1b not yet | Branch off `origin/main` and do Tasks 1–6 and 8–11; none of them touches a 1b file. **Hold Task 7** until 1b merges. Then run `git fetch origin main && git rebase origin/main` on your own branch (nothing else checked out; never `git stash`) and do Task 7. **Never stack on the local `avail-1b` branch.** 1a squash-merges, so a stack on 1b's pre-merge commits rebases into conflicts in files this PR never touched. If 1b is dropped rather than delayed, do Task 7 as written but leave out the four 1b-only pieces it marks `(AVAIL.1b)`; the ranked path does not need them. |
| **C** | 1a not merged | **Do not start.** `shared/candidates.js` imports `shared/availability.js`, and the reader imports `readStudioAvailability`. Neither exists without 1a. |

In every case there is one defence: a failed availability read (including a missing `staff_unavailability` table) only sets `checked.availability = false`. It never fails the request.

- [ ] **Step 3: Worktree**

```bash
cd /Users/richardivers/code/un1t-crm-wave23plan
git worktree add ../un1t-crm-candidates1 -b candidates-1 origin/main
cd ../un1t-crm-candidates1 && npm ci
```

Every later command runs in `/Users/richardivers/code/un1t-crm-candidates1`.

- [ ] **Step 4: Re-verify the anchors this plan cites.** The line numbers are from `origin/main` at `fa7fedcb`. AVAIL.1b shifts the ScheduleCalendar ones, so find those by text.

```bash
grep -n "function AssignCoachModal" src/components/ScheduleCalendar.jsx
grep -n "export async function loadWorkingTimeShifts\|const shifts = \[\]" src/lib/working-time-data.js
grep -n "shift_blocks!inner ( block_date" shared/dashboard-data.js
grep -n "export function assignCoachToBlock" mobile/lib/schedule-api.js
grep -n "readStudioAvailability" src/lib/availability-server.js
```

Expected: one hit each. `readStudioAvailability`'s signature should still be `(db, { locationId, startDate, endDate }) → { data, error }`. If it has changed, adapt Task 4's call and mock to it first.

---

### Task 1: `readOrgShiftRows` — one org-scoped shift reader for both features

**Files:**
- Modify: `src/lib/working-time-data.js` (lines 123-159 become a call; a new export above `loadWorkingTimeShifts`)
- Modify: `src/lib/working-time-data.test.js` (import line 11; append a describe)

WORKTIME.1's reader reads EMPLOYEES only: it filters to `coveredIds` before the assignments read. Candidates need everyone's shifts, because a contractor can be busy. They also need the same org boundary, paging, live filter, row shape and `COUNT_UNPUBLISHED_ELSEWHERE` switch. So extract the loop as-is and call it from both places. The behaviour of `loadWorkingTimeShifts` does not change, and its existing nine tests are the proof.

- [ ] **Step 1: Write the failing test**

In `src/lib/working-time-data.test.js`, change line 11 to:

```js
import { loadWorkingTimeShifts, readOrgShiftRows, COUNT_UNPUBLISHED_ELSEWHERE, SUBTRACT_APPROVED_LEAVE } from './working-time-data'
```

Append at the end of the file:

```js
// CANDIDATES.1 — the assignments loop, extracted so the candidate list reads
// the same rows (same boundary, same shape) for EVERYONE, contractors too.
describe('readOrgShiftRows (CANDIDATES.1)', () => {
  const SCOPE = { locationId: 'loc1', scopeIds: ['loc1', 'loc2'], from: '2026-09-20', to: '2026-09-28' }

  it('reads whoever it is given, contractors included, and reads no profiles', async () => {
    const db = mockDb({ assignments: [
      row('a1', 'con', 'loc1', '2026-09-22', '09:00:00', '12:00:00'),
      row('a2', 'emp', 'loc2', '2026-09-22', '20:00:00', '22:00:00'),
    ] })
    const out = await readOrgShiftRows(db, { ...SCOPE, profileIds: ['emp', 'con'] })
    expect(db.log.profiles).toHaveLength(0)
    expect(db.log.assignments[0].profileIds).toEqual(['emp', 'con'])
    expect(out.error).toBeNull()
    expect(out.shifts.map((s) => [s.profile_id, s.location_id])).toEqual([['con', 'loc1'], ['emp', 'loc2']])
  })

  it('keeps this studio first in the scope and drops a row from outside it even if it comes back', async () => {
    const db = mockDb({ assignments: [
      row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00'),
      row('a9', 'emp', 'loc9', '2026-09-23', '06:00:00', '08:00:00'),
    ] })
    const out = await readOrgShiftRows(db, { ...SCOPE, scopeIds: ['loc2', 'loc1'], profileIds: ['emp'] })
    expect(db.log.assignments[0].locIds).toEqual(['loc1', 'loc2'])
    expect(out.shifts.map((s) => s.block_id)).toEqual(['b-a1'])
  })

  it('skip() drops the rows it names; cancelled rows never come back', async () => {
    const db = mockDb({ assignments: [
      row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00'),
      row('a2', 'emp', 'loc1', '2026-09-23', '09:00:00', '12:00:00'),
      row('a3', 'emp', 'loc1', '2026-09-24', '09:00:00', '12:00:00', { status: 'cancelled' }),
    ] })
    const out = await readOrgShiftRows(db, { ...SCOPE, profileIds: ['emp'], skip: (_id, date) => date === '2026-09-22' })
    expect(out.shifts.map((s) => s.block_date)).toEqual(['2026-09-23'])
  })

  it('nobody to read: no query at all', async () => {
    const db = mockDb()
    const out = await readOrgShiftRows(db, { ...SCOPE, profileIds: [] })
    expect(db.log.assignments).toHaveLength(0)
    expect(out).toEqual({ shifts: [], error: null })
  })

  it('a failed or throwing read is an error with NO shifts, never an empty all-clear', async () => {
    const failed = await readOrgShiftRows(mockDb({ failAssignments: true, assignments: [row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00')] }), { ...SCOPE, profileIds: ['emp'] })
    expect(failed).toEqual({ shifts: [], error: { message: 'assignments unreadable' } })
    const thrown = await readOrgShiftRows(mockDb({ throwOn: 'shift_assignments' }), { ...SCOPE, profileIds: ['emp'] })
    expect(thrown).toEqual({ shifts: [], error: { message: 'shift_assignments: client exploded' } })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/working-time-data.test.js`
Expected: FAIL. The new describe errors with `readOrgShiftRows is not a function`; the nine existing tests pass.

- [ ] **Step 3: Implement**

In `src/lib/working-time-data.js`, add this export directly above the `/**` doc comment of `loadWorkingTimeShifts` (main line 71):

```js
/**
 * Every LIVE assignment of `profileIds` on block dates [from, to] at the
 * studios in `scopeIds` (this studio first), flattened to the shape the
 * shared rules read. WORKTIME.1's loop, extracted for CANDIDATES.1, which
 * needs everyone's shifts (a contractor can be busy), not employees only.
 *
 * The embedded `.in('shift_blocks.location_id', …)` is the boundary; every row
 * is re-checked against it afterwards. `countUnpublishedElsewhere` false drops
 * rows on an unpublished roster at a studio other than `locationId`.
 * `skip(profileId, blockDate)` true drops a row (approved leave, for WORKTIME's
 * switch). Paged at 1,000, ordered by id. Never throws: a failed read returns
 * `error` with NO shifts.
 *
 * @returns {Promise<{ shifts: object[], error: { message: string } | null }>}
 */
export async function readOrgShiftRows(db, {
  locationId, scopeIds, profileIds, from, to,
  countUnpublishedElsewhere = COUNT_UNPUBLISHED_ELSEWHERE,
  skip = null,
} = {}) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  const scope = [...new Set([locationId, ...(scopeIds || [])].filter(Boolean))]
  if (ids.length === 0 || scope.length === 0) return { shifts: [], error: null }
  try {
    const shifts = []
    for (let offset = 0; ; offset += PAGE) {
      const { data: page, error } = await db
        .from('shift_assignments')
        // One literal string, so check:select-columns can resolve every column.
        .select('id, profile_id, status, start_time_override, end_time_override, shift_blocks!inner(id, location_id, block_date, start_time, end_time, roster_id, shift_templates(name, start_time, end_time), locations(name), rosters:roster_id(status))')
        .in('profile_id', ids)
        .in('shift_blocks.location_id', scope)
        .gte('shift_blocks.block_date', from)
        .lte('shift_blocks.block_date', to)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) return { shifts: [], error }
      for (const a of page || []) {
        const b = a?.shift_blocks
        // The filter above is the boundary; this re-check does not depend on
        // how PostgREST applies an embedded filter.
        if (!b || !scope.includes(b.location_id) || !isLiveAssignment(a)) continue
        if (!countUnpublishedElsewhere && b.location_id !== locationId && b.rosters?.status !== 'published') continue
        if (skip && skip(a.profile_id, b.block_date)) continue
        shifts.push({
          profile_id: a.profile_id,
          block_id: b.id,
          block_date: b.block_date,
          location_id: b.location_id,
          location_name: b.locations?.name ?? null,
          name: b.shift_templates?.name || 'Shift',
          status: a.status ?? null,
          start_time_override: a.start_time_override ?? null,
          end_time_override: a.end_time_override ?? null,
          start_time: b.start_time ?? null,
          end_time: b.end_time ?? null,
          shift_templates: { start_time: b.shift_templates?.start_time ?? null, end_time: b.shift_templates?.end_time ?? null },
        })
      }
      if (!page || page.length < PAGE) break
    }
    return { shifts, error: null }
  } catch (e) {
    return { shifts: [], error: { message: e?.message || 'shift read threw' } }
  }
}
```

Then, in `loadWorkingTimeShifts`, replace everything from `    const shifts = []` (main line 123) through `    return { shifts, people, crossStudioChecked, error: null }` (main line 160) with:

```js
    const read = await readOrgShiftRows(db, {
      locationId, scopeIds, profileIds: coveredIds, from, to, countUnpublishedElsewhere, skip: onLeave,
    })
    if (read.error) return failed(read.error)
    return { shifts: read.shifts, people, crossStudioChecked, error: null }
```

Update the file header's cost line (main lines 17-19) by adding: `The assignments read is readOrgShiftRows, shared with CANDIDATES.1.`

- [ ] **Step 4: Run it, expect PASS (old and new)**

Run: `npx vitest run src/lib/working-time-data.test.js src/app/api/schedule/working-time/route.test.js src/lib/roster-publish.test.js`
Expected: all pass. The nine original `loadWorkingTimeShifts` tests pass unchanged. That includes "never throws", which now reaches `failed()` through `readOrgShiftRows`'s catch with the same message.

- [ ] **Step 5: Commit**

```bash
git add src/lib/working-time-data.js src/lib/working-time-data.test.js
git commit -m "CANDIDATES.1 — extract readOrgShiftRows from the working-time reader, for everyone's shifts

WORKTIME.1's assignments loop, unchanged: org scope re-checked per row, live
rows only, paged at 1,000, never throws. loadWorkingTimeShifts calls it with
its employees and its leave skip; its nine tests pass untouched.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `shared/candidates.js` — tiers, ranking and words (pure)

**Files:**
- Create: `shared/candidates.js`
- Create: `shared/candidates.test.js`

This task builds everything that works on a candidate's FACTS, once those facts exist. Task 3 computes the facts from raw rows.

- [ ] **Step 1: Write the failing test**

Create `shared/candidates.test.js`:

```js
// CANDIDATES.1 — ranked candidates. Pure: no clock, no database. Run under
// TZ=Europe/Dublin AND a US zone; nothing here may move with the host.

import { describe, it, expect } from 'vitest'
import {
  CANDIDATE_TIERS, CANDIDATES_RANKING_NOTE, CANDIDATES_UNRANKED_NOTE,
  candidateTier, compareCandidates, rankCandidates, candidateTone,
  candidateBadges, candidateHoursLine, candidateMeta, candidateReason,
  candidatesUncheckedNote, parseCandidatesAnswer,
  candidateFacts, buildCandidates,
} from './candidates.js'

describe('candidateTier', () => {
  it('ready, advisory, unavailable, blocked — in that order of badness', () => {
    expect(CANDIDATE_TIERS).toEqual(['ready', 'advisory', 'unavailable', 'blocked'])
    expect(candidateTier({})).toBe('ready')
    expect(candidateTier({ free: null })).toBe('ready') // unknown is neutral
    expect(candidateTier({ rest_gap: { rest_minutes: 600 } })).toBe('advisory')
    expect(candidateTier({ week_over: { minutes: 2940 } })).toBe('advisory')
    expect(candidateTier({ unavailable: { summary: 'all day' }, rest_gap: { rest_minutes: 1 } })).toBe('unavailable')
    expect(candidateTier({ free: false, unavailable: { summary: 'all day' } })).toBe('blocked')
    expect(candidateTier({ on_leave: { type: 'holiday' } })).toBe('blocked')
  })
})

describe('rankCandidates', () => {
  it('tier, then on site, then under-contract share, then fewest hours, then name', () => {
    const list = [
      { profile_id: 'z', full_name: 'Zoe', free: false },
      { profile_id: 'y', full_name: 'Yan', unavailable: { summary: 'all day' } },
      { profile_id: 'x', full_name: 'Xia', rest_gap: { rest_minutes: 600 } },
      { profile_id: 'c', full_name: 'Cal', free: true, week_minutes: 0 },
      { profile_id: 'b', full_name: 'Bea', free: true, week_minutes: 1200, contracted_hours: 39 },
      { profile_id: 'a', full_name: 'Abe', free: true, week_minutes: 600, contracted_hours: 20 },
      { profile_id: 'o', full_name: 'Ola', free: true, week_minutes: 2400, contracted_hours: 20 },
      { profile_id: 's', full_name: 'Sam', free: true, week_minutes: 900, on_site: { start: '07:00', end: '09:00' } },
      { profile_id: 'd', full_name: 'Dee', free: true, week_minutes: 0 },
    ]
    const ranked = rankCandidates(list)
    // s on site; a (10h of 20h = 0.50) before b (20h of 39h = 0.51); then the
    // no-contract / over-contract group by hours: c 0h, d 0h (name), o 40h.
    expect(ranked.map((c) => c.profile_id)).toEqual(['s', 'a', 'b', 'c', 'd', 'o', 'x', 'y', 'z'])
    expect(ranked.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(ranked.map((c) => c.tier)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'advisory', 'unavailable', 'blocked'])
    expect(list[0]).not.toHaveProperty('rank') // a copy, never mutates
  })

  it('an unknown week is neutral: those rows fall back to name, then id', () => {
    const ranked = rankCandidates([
      { profile_id: '2', full_name: 'ann', week_minutes: null },
      { profile_id: '1', full_name: 'Ann', week_minutes: null },
      { profile_id: '3', full_name: 'Aaron' },
    ])
    expect(ranked.map((c) => c.profile_id)).toEqual(['3', '1', '2'])
    expect(compareCandidates(ranked[1], ranked[2])).toBeLessThan(0)
  })

  it('tone follows the tier', () => {
    expect(['ready', 'advisory', 'unavailable', 'blocked'].map((tier) => candidateTone({ tier }))).toEqual(['good', 'warn', 'muted', 'bad'])
    expect(candidateTone(null)).toBe('muted')
  })
})

describe('words', () => {
  const FACTS = {
    profile_id: 'p', full_name: 'P', role: 'staff', free: false,
    busy: { block_id: 'b', date: '2026-05-06', start: '09:30', end: '10:30', name: 'Morning HIIT', location_name: 'Studio South' },
    on_leave: { type: 'sick', label: 'Sick leave', start_date: '2026-05-06', end_date: '2026-05-06' },
    unavailable: { summary: 'all day', detail: '6 May, all day' },
    rest_gap: { rest_minutes: 570, side: 'before', other: { block_id: 'x', date: '2026-05-05', start: '20:00', end: '21:30', name: 'Evening', location_name: 'Studio South' } },
    week_over: { week_start: '2026-05-04', minutes: 2910 },
    on_site: null, week_minutes: 2790, contracted_hours: 37.5,
  }

  it('badges keep the picker\'s existing words and titles', () => {
    expect(candidateBadges(FACTS)).toEqual([
      { key: 'leave', tone: 'bad', text: 'on approved leave', title: 'Sick leave, Wed 6 May' },
      { key: 'busy', tone: 'warn', text: 'clashes with 9:30am Morning HIIT', title: 'Already on Morning HIIT 9:30am–10:30am at Studio South' },
      { key: 'unavailable', tone: 'muted', text: 'Unavailable: all day', title: '6 May, all day' },
      { key: 'rest', tone: 'warn', text: '9h 30m rest', title: 'Only 9h 30m between this shift and Evening 8pm–9:30pm at Studio South on Tue 5 May. Employees need 11 hours between working days.' },
      { key: 'week', tone: 'warn', text: '48h 30m this week', title: 'Assigning this shift brings their week to 48h 30m across every studio, over the 48-hour limit.' },
    ])
    expect(candidateBadges({ free: true })).toEqual([])
    expect(candidateBadges({ on_leave: { label: 'Holiday', start_date: '2026-05-05', end_date: '2026-05-07' } })[0].title)
      .toBe('Holiday, Tue 5 May to Thu 7 May')
  })

  it('the hours line: share of a contract, plain hours, or none', () => {
    expect(candidateHoursLine(FACTS)).toBe('46h 30m of 37.5h this week')
    expect(candidateHoursLine({ week_minutes: 0, contracted_hours: 30 })).toBe('0h of 30h this week')
    expect(candidateHoursLine({ week_minutes: 120 })).toBe('2h this week')
    expect(candidateHoursLine({ week_minutes: 0 })).toBe('No shifts this week')
    expect(candidateHoursLine({ week_minutes: null, contracted_hours: 39 })).toBeNull()
  })

  it('meta line: on site, then hours', () => {
    expect(candidateMeta({ on_site: { start: '07:00', end: '09:00' }, week_minutes: 120 })).toBe('Here 7am–9am · 2h this week')
    expect(candidateMeta({ week_minutes: 0 })).toBe('No shifts this week')
    expect(candidateMeta({})).toBeNull()
  })

  it('reason: the worst thing first, then the hours; a colleague sees free or working only', () => {
    expect(candidateReason(FACTS)).toBe('On leave (Sick leave) · 46h 30m of 37.5h this week')
    expect(candidateReason({ ...FACTS, on_leave: null })).toBe('Working 9:30am–10:30am Morning HIIT at Studio South · 46h 30m of 37.5h this week')
    expect(candidateReason({ ...FACTS, on_leave: null, busy: null, free: true })).toBe('Unavailable all day · 46h 30m of 37.5h this week')
    expect(candidateReason({ rest_gap: FACTS.rest_gap, week_minutes: 90, contracted_hours: 39 })).toBe('Only 9h 30m rest · 1h 30m of 39h this week')
    expect(candidateReason({ week_over: { minutes: 2940 }, week_minutes: 2820, contracted_hours: 39 })).toBe('49h with this shift · 47h of 39h this week')
    expect(candidateReason({ free: true, on_site: { start: '12:00', end: '13:00' }, week_minutes: 60 })).toBe('Here 12pm–1pm · 1h this week')
    expect(candidateReason({ free: true, week_minutes: 240, contracted_hours: 39 })).toBe('Free · 4h of 39h this week')
    expect(candidateReason({})).toBeNull()
    expect(candidateReason({ free: true }, 'colleague')).toBe('Free then')
    expect(candidateReason({ free: false }, 'colleague')).toBe('Working then')
    expect(candidateReason({ free: null }, 'colleague')).toBeNull()
  })

  it('what could not be checked, in words', () => {
    expect(candidatesUncheckedNote({ shifts: true, leave: false })).toBe('Could not check leave, so the order may be off.')
    expect(candidatesUncheckedNote({ leave: false, availability: false })).toBe('Could not check leave and availability, so the order may be off.')
    expect(candidatesUncheckedNote({ shifts: false, cross_studio: false, contract: false }))
      .toBe('Could not check other shifts, the other studios and contracted hours, so the order may be off.')
    expect(candidatesUncheckedNote({ shifts: true })).toBeNull()
    expect(candidatesUncheckedNote(undefined)).toBeNull()
    expect(CANDIDATES_RANKING_NOTE).toBe('Ranking coaches…')
    expect(CANDIDATES_UNRANKED_NOTE).toBe('Coaches could not be ranked, so they are listed A–Z.')
  })
})

describe('parseCandidatesAnswer', () => {
  it('a failed or missing answer is failed; a success of another shape is unrecognised', () => {
    expect(parseCandidatesAnswer(null)).toEqual({ ok: false, reason: 'failed' })
    expect(parseCandidatesAnswer({ success: false, error: 'boom' })).toEqual({ ok: false, reason: 'failed' })
    expect(parseCandidatesAnswer({ success: true, data: [] })).toEqual({ ok: false, reason: 'unrecognised' })
    expect(parseCandidatesAnswer({ success: true, data: { byProfile: {} } })).toEqual({ ok: false, reason: 'unrecognised' })
  })

  it('orders by rank, drops junk rows, defaults the rest', () => {
    const out = parseCandidatesAnswer({ success: true, data: { candidates: [
      { profile_id: 'b', rank: 2 }, null, { rank: 3 }, { profile_id: 'a', rank: 1 }, { profile_id: 'c' },
    ] } })
    expect(out).toEqual({
      ok: true, audience: 'manager', checked: {}, untimed: 0,
      candidates: [{ profile_id: 'a', rank: 1 }, { profile_id: 'b', rank: 2 }, { profile_id: 'c' }],
    })
    expect(parseCandidatesAnswer({ success: true, data: { audience: 'colleague', candidates: [], checked: { shifts: false }, untimed: 2 } }))
      .toEqual({ ok: true, audience: 'colleague', candidates: [], checked: { shifts: false }, untimed: 2 })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/candidates.test.js`
Expected: FAIL, `Failed to resolve import "./candidates.js"`.

- [ ] **Step 3: Implement**

Create `shared/candidates.js`:

```js
// shared/candidates.js
//
// CANDIDATES.1 — ranked candidates wherever a coach is picked: the web assign
// picker, the phone's Manage "Add coach" sheet and the phone's "Ask a coach to
// cover" sheet. PURE: no IO, no clock, no host timezone. The server reads
// (src/lib/candidates-data.js); this module judges, ranks and words, so the
// web and the phone can never disagree.
//
// Per candidate (an active member of the block's studio, not live on it):
//   free              no live shift overlapping this one at ANY studio of the
//                     organisation (effective windows as real instants; ends
//                     that only touch are not an overlap)
//   busy              the earliest such overlapping shift, or null
//   on_leave          approved leave covering the day { type, label, start_date, end_date }
//   unavailable       an AVAIL.1 rule touching the shift { summary, detail }
//   on_site           the nearest other live shift at THIS studio that day
//                     { block_id, start, end, name, gap_minutes }
//   week_minutes      rostered minutes Mon–Sun of the block's week, every
//                     studio of the organisation, THIS shift excluded
//   contracted_hours  employees only, only when it could be read
//   rest_gap / week_over  WORKTIME.1's candidateWorkingTime, employees only
//
// Ranking (compareCandidates), the order in the Wave 2 index:
//   1. tier: ready → advisory (short rest, over 48h) → unavailable → blocked
//      (on leave, or already working then). NOTHING blocks: tiers sort and
//      badge, and the pickers keep every row tickable.
//   2. on site that day first
//   3. an employee still under their contracted hours first, lowest share of
//      the contract first; then everyone else, fewest hours this week first
//      (OWNER REVIEW: salaried hours are already paid for)
//   4. name, then id
// A facet the server could not read is null, never false: unknown is
// neutral, and the pickers say what was not checked.
//
// Hours only: nothing here reads or returns a rate, a cost or a salary.

import {
  workingWindow, candidateWorkingTime, isWorkingTimeCovered, untimedShiftCount,
  hoursMinutesLabel, MIN_REST_HOURS, MAX_WEEK_HOURS, REST_BETWEEN_LABEL,
} from './working-time.js'
import { unavailableFor, unavailableSummary, describeRule } from './availability.js'
import { timeOffLeaveLabel } from './time-off.js'

export const CANDIDATE_TIERS = Object.freeze(['ready', 'advisory', 'unavailable', 'blocked'])
const CANDIDATE_TONES = Object.freeze({ ready: 'good', advisory: 'warn', unavailable: 'muted', blocked: 'bad' })

export const CANDIDATES_RANKING_NOTE = 'Ranking coaches…'
export const CANDIDATES_UNRANKED_NOTE = 'Coaches could not be ranked, so they are listed A–Z.'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^(\d{1,2}):(\d{2})/

// ── Private helpers (src/lib exports its own date helpers; tests/shared-pair-
// sync.test.js makes a shared export NAME a pair someone must classify) ─────

// '20:00' → '8pm', '21:30' → '9:30pm': the same output as the web's
// formatTime12h, so a badge reads the same whichever side built it.
function time12(t) {
  const m = String(t ?? '').match(TIME)
  if (!m) return ''
  const h = Number(m[1]) % 24
  const suffix = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m[2] === '00' ? `${h12}${suffix}` : `${h12}:${m[2]}${suffix}`
}

// '2026-05-05' → 'Tue 5 May'. Date.UTC only: no host timezone moves a day.
function dayLabel(iso) {
  const m = String(iso ?? '').match(ISO_DAY)
  if (!m) return ''
  const wd = WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()]
  return `${wd} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`
}

// The Monday of the Mon–Sun week containing `iso` (WORKTIME.1's bucket).
function weekStartOf(iso) {
  const m = String(iso ?? '').match(ISO_DAY)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7
  return new Date(ms - sinceMonday * DAY_MS).toISOString().slice(0, 10)
}

function joinList(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// 0 → '0h' (for "0h of 30h"); otherwise WORKTIME's label.
const hoursOnly = (minutes) => (minutes === 0 ? '0h' : hoursMinutesLabel(minutes))

// ── Tiers and ranking ───────────────────────────────────────────────────────

/** 'ready' | 'advisory' | 'unavailable' | 'blocked'. Unknown facets are neutral. */
export function candidateTier(c) {
  if (!c) return 'ready'
  if (c.on_leave || c.free === false) return 'blocked'
  if (c.unavailable) return 'unavailable'
  if (c.rest_gap || c.week_over) return 'advisory'
  return 'ready'
}

/** 'good' | 'warn' | 'muted' | 'bad', from the tier. */
export function candidateTone(c) {
  return CANDIDATE_TONES[c?.tier ?? (c ? candidateTier(c) : null)] || 'muted'
}

const tierIndex = (c) => CANDIDATE_TIERS.indexOf(c?.tier ?? candidateTier(c))

// [group, value]: group 0 = an employee under their contract, by share of it;
// group 1 = everyone else, by minutes this week. Unknown hours sort last in
// group 1 and tie with each other, so they fall through to the name.
function loadKey(c) {
  const week = Number.isFinite(c?.week_minutes) ? c.week_minutes : null
  const contract = Number(c?.contracted_hours) > 0 ? Number(c.contracted_hours) * 60 : null
  if (contract !== null && week !== null && week < contract) return [0, week / contract]
  return [1, week === null ? Number.POSITIVE_INFINITY : week]
}

export function compareCandidates(a, b) {
  const byTier = tierIndex(a) - tierIndex(b)
  if (byTier) return byTier
  const bySite = (b?.on_site ? 1 : 0) - (a?.on_site ? 1 : 0)
  if (bySite) return bySite
  const [ga, va] = loadKey(a)
  const [gb, vb] = loadKey(b)
  if (ga !== gb) return ga - gb
  if (va !== vb) return va < vb ? -1 : 1
  const byName = String(a?.full_name ?? '').localeCompare(String(b?.full_name ?? ''), 'en', { sensitivity: 'base' })
  if (byName) return byName
  return String(a?.profile_id ?? '').localeCompare(String(b?.profile_id ?? ''))
}

/**
 * Copies of `list`, sorted, each with `tier`, `rank` (1-based) and `reason`.
 * Rank the PROJECTED facts: a colleague's list must be ranked on what a
 * colleague may see, or the order itself leaks the rest.
 */
export function rankCandidates(list, audience = 'manager') {
  return (list || [])
    .filter(Boolean)
    .map((c) => ({ ...c, tier: candidateTier(c) }))
    .sort(compareCandidates)
    .map((c, i) => ({ ...c, rank: i + 1, reason: candidateReason(c, audience) }))
}

// ── Words ───────────────────────────────────────────────────────────────────

/**
 * The web picker's badges, worst first: [{ key, tone, text, title }]. Texts
 * and titles are the ones the picker already showed (ROSTER-FIX.6c clash and
 * leave, WORKTIME.1 rest and week, AVAIL.1b unavailable), so a manager sees
 * the same words from the ranked answer.
 */
export function candidateBadges(c) {
  if (!c) return []
  const out = []
  if (c.on_leave) {
    const { label, start_date: s, end_date: e } = c.on_leave
    out.push({ key: 'leave', tone: 'bad', text: 'on approved leave', title: `${label || 'Leave'}, ${dayLabel(s)}${e && e !== s ? ` to ${dayLabel(e)}` : ''}` })
  }
  if (c.busy) {
    const b = c.busy
    out.push({
      key: 'busy', tone: 'warn',
      text: `clashes with ${time12(b.start)} ${b.name || 'another shift'}`,
      title: `Already on ${b.name || 'another shift'} ${time12(b.start)}–${time12(b.end)}${b.location_name ? ` at ${b.location_name}` : ''}`,
    })
  }
  if (c.unavailable) {
    out.push({ key: 'unavailable', tone: 'muted', text: `Unavailable: ${c.unavailable.summary}`, title: c.unavailable.detail || '' })
  }
  if (c.rest_gap) {
    const g = c.rest_gap
    const o = g.other || {}
    const where = o.location_name ? ` at ${o.location_name}` : ''
    out.push({
      key: 'rest', tone: 'warn',
      text: `${hoursMinutesLabel(g.rest_minutes)} rest`,
      title: `Only ${hoursMinutesLabel(g.rest_minutes)} between this shift and ${o.name || 'another shift'} ${time12(o.start)}–${time12(o.end)}${where} on ${dayLabel(o.date)}. Employees need ${MIN_REST_HOURS} hours ${REST_BETWEEN_LABEL}.`,
    })
  }
  if (c.week_over) {
    const hm = hoursMinutesLabel(c.week_over.minutes)
    out.push({
      key: 'week', tone: 'warn',
      text: `${hm} this week`,
      title: `Assigning this shift brings their week to ${hm} across every studio, over the ${MAX_WEEK_HOURS}-hour limit.`,
    })
  }
  return out
}

/** '12h of 39h this week' · '2h this week' · 'No shifts this week' · null (unknown). */
export function candidateHoursLine(c) {
  if (!Number.isFinite(c?.week_minutes)) return null
  if (Number(c.contracted_hours) > 0) return `${hoursOnly(c.week_minutes)} of ${Number(c.contracted_hours)}h this week`
  return c.week_minutes === 0 ? 'No shifts this week' : `${hoursMinutesLabel(c.week_minutes)} this week`
}

/** The web row's second line: 'Here 7am–9am · 2h this week'. */
export function candidateMeta(c) {
  if (!c) return null
  const parts = []
  if (c.on_site) parts.push(`Here ${time12(c.on_site.start)}–${time12(c.on_site.end)}`)
  const hours = candidateHoursLine(c)
  if (hours) parts.push(hours)
  return parts.length ? parts.join(' · ') : null
}

/**
 * The phone row's one line (and `reason` in the API). The worst thing first,
 * then the hours. A colleague (the coach asking for cover) is told free or
 * working, nothing else.
 */
export function candidateReason(c, audience = 'manager') {
  if (!c) return null
  if (audience === 'colleague') {
    if (c.free === true) return 'Free then'
    if (c.free === false) return 'Working then'
    return null
  }
  let lead = null
  if (c.on_leave) lead = `On leave (${c.on_leave.label || 'Leave'})`
  else if (c.busy) lead = `Working ${time12(c.busy.start)}–${time12(c.busy.end)} ${c.busy.name || 'another shift'}${c.busy.location_name ? ` at ${c.busy.location_name}` : ''}`
  else if (c.unavailable) lead = `Unavailable ${c.unavailable.summary}`
  else if (c.rest_gap) lead = `Only ${hoursMinutesLabel(c.rest_gap.rest_minutes)} rest`
  else if (c.week_over) lead = `${hoursMinutesLabel(c.week_over.minutes)} with this shift`
  else if (c.on_site) lead = `Here ${time12(c.on_site.start)}–${time12(c.on_site.end)}`
  else if (c.free === true) lead = 'Free'
  const line = [lead, candidateHoursLine(c)].filter(Boolean).join(' · ')
  return line || null
}

const UNCHECKED_LABELS = [
  ['shifts', 'other shifts'],
  ['cross_studio', 'the other studios'],
  ['leave', 'leave'],
  ['availability', 'availability'],
  ['contract', 'contracted hours'],
]

/** 'Could not check leave and availability, so the order may be off.' or null. */
export function candidatesUncheckedNote(checked) {
  const missing = UNCHECKED_LABELS.filter(([key]) => checked?.[key] === false).map(([, label]) => label)
  return missing.length ? `Could not check ${joinList(missing)}, so the order may be off.` : null
}

/**
 * The client's reading of a GET /api/schedule/blocks/[id]/candidates body.
 *   { ok: true, audience, candidates (by rank), checked, untimed }
 *   { ok: false, reason: 'failed' }        no answer, or success !== true
 *   { ok: false, reason: 'unrecognised' }  a success of another shape (an
 *                                          older server): say nothing, fall back
 */
export function parseCandidatesAnswer(json) {
  if (!json || json.success !== true) return { ok: false, reason: 'failed' }
  const d = json.data
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.candidates)) return { ok: false, reason: 'unrecognised' }
  const rankOf = (c) => (Number.isFinite(c.rank) ? c.rank : Number.POSITIVE_INFINITY)
  const candidates = d.candidates
    .filter((c) => c && typeof c === 'object' && c.profile_id)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (rankOf(a.c) === rankOf(b.c) ? a.i - b.i : rankOf(a.c) < rankOf(b.c) ? -1 : 1))
    .map(({ c }) => c)
  return {
    ok: true,
    audience: d.audience === 'colleague' ? 'colleague' : 'manager',
    candidates,
    checked: d.checked && typeof d.checked === 'object' ? d.checked : {},
    untimed: Number(d.untimed) > 0 ? Number(d.untimed) : 0,
  }
}
```

The test file already imports `candidateFacts` and `buildCandidates`, which Task 3 adds. Until then they are `undefined`, which is harmless because nothing in this task calls them.

- [ ] **Step 4: Run it, expect PASS, both timezones**

Run: `for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run shared/candidates.test.js || break; done`
Expected: every test passes in both runs.

- [ ] **Step 5: Commit**

```bash
git add shared/candidates.js shared/candidates.test.js
git commit -m "CANDIDATES.1 — shared/candidates.js: tiers, ranking and the words (pure)

Tier ready → advisory → unavailable → blocked; then on site; then an
employee under contract by share, then everyone else by fewest hours; then
name. Badge texts and titles are the picker's existing ones. Unknown facets
are neutral. Hours only.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `candidateFacts` and `buildCandidates` — from rows to a ranked list

**Files:**
- Modify: `shared/candidates.js` (append)
- Modify: `shared/candidates.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `shared/candidates.test.js`:

```js
// One Wednesday shift, 10:00–12:00 at Studio North, and eight people around it.
const HERE = 'loc-here'
const THERE = 'loc-there'
const BLOCK = {
  id: 'blk', location_id: HERE, block_date: '2026-09-23', start_time: '10:00:00', end_time: '12:00:00',
  shift_templates: { name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00', kind: 'class' },
}
// A live assignment in the flat shape src/lib/working-time-data.js returns.
const S = (profile_id, block_date, start_time, end_time, over = {}) => ({
  profile_id, block_id: `${profile_id}-${block_date}-${start_time}`, block_date, start_time, end_time,
  location_id: HERE, location_name: 'Studio North', name: 'Class', status: 'scheduled',
  start_time_override: null, end_time_override: null, shift_templates: { start_time, end_time }, ...over,
})
const M = (profile_id, full_name, employment_type = 'fte') => ({ profile_id, full_name, role: 'staff', employment_type })
const MEMBERS = [
  M('ann', 'Ann Free'), M('bob', 'Bob Here', 'contractor'), M('cat', 'Cat Busy'), M('dan', 'Dan Away', 'contractor'),
  M('eve', 'Eve Unavail'), M('fay', 'Fay Late'), M('gus', 'Gus Steady'), M('hal', 'Hal Contract', 'contractor'),
]
const SHIFTS = [
  S('ann', '2026-09-21', '09:00:00', '13:00:00'),
  S('bob', '2026-09-23', '07:00:00', '09:00:00', { name: 'Early' }),
  S('cat', '2026-09-23', '11:00:00', '13:00:00', { location_id: THERE, location_name: 'Studio South', name: 'Lunch Pilates' }),
  S('fay', '2026-09-22', '21:00:00', '23:30:00', { location_id: THERE, location_name: 'Studio South', name: 'Late' }),
  S('gus', '2026-09-21', '09:00:00', '17:00:00'),
  S('gus', '2026-09-22', '09:00:00', '17:00:00'),
  S('hal', '2026-09-28', '09:00:00', '10:00:00'), // next Monday: read, but not this week
]
const LEAVE = [{ profile_id: 'dan', type: 'holiday', start_date: '2026-09-22', end_date: '2026-09-24' }]
const RULES = [{ profile_id: 'eve', kind: 'weekly', weekday: 'wed', all_day: false, start_time: '09:00', end_time: '11:00', note: 'School run' }]
// bob is a contractor with a stray row: contractors never show one.
const CONTRACTS = new Map([['ann', 39], ['cat', 20], ['eve', 30], ['fay', 39], ['gus', 39], ['bob', 25]])
const ALL_CHECKED = { shifts: true, cross_studio: true, leave: true, availability: true, contract: true }
const build = (over = {}) => buildCandidates({
  block: BLOCK, members: MEMBERS, shifts: SHIFTS, leave: LEAVE, rules: RULES, contracts: CONTRACTS, checked: ALL_CHECKED, ...over,
})

describe('buildCandidates — manager', () => {
  it('ranks: on site, under contract, the rest, short rest, unavailable, then working or on leave', () => {
    const { candidates } = build()
    expect(candidates.map((c) => c.profile_id)).toEqual(['bob', 'ann', 'gus', 'hal', 'fay', 'eve', 'cat', 'dan'])
    expect(Object.fromEntries(candidates.map((c) => [c.profile_id, c.reason]))).toEqual({
      bob: 'Here 7am–9am · 2h this week',
      ann: 'Free · 4h of 39h this week',
      gus: 'Free · 16h of 39h this week',
      hal: 'Free · No shifts this week',
      fay: 'Only 10h 30m rest · 2h 30m of 39h this week',
      eve: 'Unavailable 9am–11am · 0h of 30h this week',
      cat: 'Working 11am–1pm Lunch Pilates at Studio South · 2h of 20h this week',
      dan: 'On leave (Holiday) · No shifts this week',
    })
  })

  it('carries each fact, the other studio named, this one not', () => {
    const by = Object.fromEntries(build().candidates.map((c) => [c.profile_id, c]))
    expect(by.bob).toMatchObject({ free: true, busy: null, on_site: { start: '07:00', end: '09:00', name: 'Early', gap_minutes: 60 }, week_minutes: 120, contracted_hours: null, rest_gap: null })
    expect(by.cat).toMatchObject({ free: false, busy: { date: '2026-09-23', start: '11:00', end: '13:00', name: 'Lunch Pilates', location_name: 'Studio South' }, tier: 'blocked' })
    expect(by.dan.on_leave).toEqual({ type: 'holiday', label: 'Holiday', start_date: '2026-09-22', end_date: '2026-09-24' })
    expect(by.eve.unavailable).toEqual({ summary: '9am–11am', detail: 'Wednesdays, 9am–11am (School run)' })
    expect(by.fay.rest_gap).toMatchObject({ rest_minutes: 630, side: 'before', other: { date: '2026-09-22', start: '21:00', end: '23:30', name: 'Late', location_name: 'Studio South' } })
    expect(by.hal.week_minutes).toBe(0)
    expect(by.ann).toMatchObject({ contracted_hours: 39, week_minutes: 240, on_site: null, rank: 2, tier: 'ready' })
  })

  it('an override counts (effective window); an end that only touches is on site, not busy', () => {
    const { candidates } = buildCandidates({
      block: BLOCK, checked: ALL_CHECKED,
      members: [M('jay', 'Jay Late', 'contractor'), M('kim', 'Kim Next', 'contractor')],
      shifts: [
        S('jay', '2026-09-23', '07:00:00', '09:00:00', { end_time_override: '10:30:00' }),
        S('kim', '2026-09-23', '12:00:00', '13:00:00'),
      ],
    })
    const [kim, jay] = candidates
    expect(kim).toMatchObject({ profile_id: 'kim', free: true, on_site: { start: '12:00', end: '13:00', gap_minutes: 0 }, reason: 'Here 12pm–1pm · 1h this week' })
    expect(jay).toMatchObject({ profile_id: 'jay', free: false, busy: { start: '07:00', end: '10:30', location_name: null }, tier: 'blocked' })
  })

  it('48 hours: an employee this shift takes over the week is advisory; a contractor never is', () => {
    const ivy = [
      S('ivy', '2026-09-21', '06:00:00', '18:00:00'), S('ivy', '2026-09-22', '06:00:00', '18:00:00'),
      S('ivy', '2026-09-24', '06:00:00', '18:00:00'), S('ivy', '2026-09-25', '06:00:00', '17:00:00'),
    ]
    const lee = ivy.map((s) => ({ ...s, profile_id: 'lee', block_id: `lee-${s.block_date}` }))
    const { candidates } = buildCandidates({
      block: BLOCK, checked: ALL_CHECKED, contracts: new Map([['ivy', 39]]),
      members: [M('ivy', 'Ivy Long'), M('lee', 'Lee Long', 'contractor')], shifts: [...ivy, ...lee],
    })
    const by = Object.fromEntries(candidates.map((c) => [c.profile_id, c]))
    expect(by.ivy).toMatchObject({ week_minutes: 2820, week_over: { week_start: '2026-09-21', minutes: 2940 }, tier: 'advisory', reason: '49h with this shift · 47h of 39h this week' })
    expect(by.lee).toMatchObject({ week_minutes: 2820, week_over: null, rest_gap: null, tier: 'ready' })
  })

  it('what was not read is null, never false: everyone ready, ranked by name, no reason', () => {
    const { candidates } = build({ checked: { shifts: false, cross_studio: true, leave: false, availability: false, contract: false } })
    expect(candidates.map((c) => c.profile_id)).toEqual(['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal'])
    for (const c of candidates) {
      expect(c).toMatchObject({ free: null, busy: null, on_site: null, week_minutes: null, on_leave: null, unavailable: null, contracted_hours: null, tier: 'ready', reason: null })
    }
  })

  it('counts shifts without usable times, and never returns a pay field', () => {
    const { candidates, untimed } = build({ shifts: [...SHIFTS, S('ann', '2026-09-24', null, null, { shift_templates: { start_time: null, end_time: null } })] })
    expect(untimed).toBe(1)
    expect(JSON.stringify(candidates)).not.toMatch(/rate|salary|overtime|cost/)
  })
})

describe('buildCandidates — colleague (the coach asking for cover)', () => {
  it('free or working only, ranked on that alone: leave and availability cannot leak through the order', () => {
    const { candidates, untimed } = build({ audience: 'colleague' })
    expect(candidates.map((c) => c.profile_id)).toEqual(['ann', 'bob', 'dan', 'eve', 'fay', 'gus', 'hal', 'cat'])
    for (const c of candidates) {
      expect(Object.keys(c).sort()).toEqual(['free', 'full_name', 'profile_id', 'rank', 'reason', 'role', 'tier'])
    }
    expect(candidates[0].reason).toBe('Free then')
    expect(candidates[7]).toMatchObject({ profile_id: 'cat', free: false, reason: 'Working then', tier: 'blocked' })
    expect(untimed).toBe(0)
  })
})

describe('candidateFacts', () => {
  it('no target window (a block without times): shift facts unknown, leave and availability judged on the day', () => {
    const f = candidateFacts({
      target: null, candidateRow: { profile_id: 'x', block_date: '2026-09-23' },
      leave: [{ type: 'sick', start_date: '2026-09-23', end_date: '2026-09-23' }],
      rules: [{ kind: 'weekly', weekday: 'wed', all_day: false, start_time: '18:00', end_time: '19:00' }],
      checked: ALL_CHECKED,
    })
    expect(f).toMatchObject({ free: null, week_minutes: null, on_leave: { type: 'sick', label: 'Sick leave' }, unavailable: { summary: '6pm–7pm' } })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/candidates.test.js`
Expected: FAIL. The new tests throw `buildCandidates is not a function` or `candidateFacts is not a function`; Task 2's tests still pass.

- [ ] **Step 3: Implement**

Append to `shared/candidates.js`:

```js
// ── Facts ───────────────────────────────────────────────────────────────────

// A window as a slot a badge names. The studio is named only when it is
// ANOTHER one (the manager is assigning here).
function slotOf(w, hereLocationId) {
  return {
    block_id: w.block_id ?? null,
    date: w.date,
    start: w.start,
    end: w.end,
    name: w.name,
    location_name: hereLocationId && w.location_id === hereLocationId ? null : (w.location_name ?? null),
  }
}

/**
 * One person's facts about one shift. `target` is workingWindow() of the
 * shift (null when it has no usable times); `candidateRow` is the shift as
 * this person's row (for WORKTIME.1's rule); `own` is this person's live
 * assignments from the reader, any studio of the organisation. `checked`
 * false for a facet = the reader could not read it: that facet stays null.
 */
export function candidateFacts({
  target, candidateRow, own = [], leave = [], rules = [], contractedHours = null,
  covered = false, hereLocationId = null, checked = {},
} = {}) {
  const date = candidateRow?.block_date ?? target?.date ?? null
  const facts = {
    free: null, busy: null, on_site: null, week_minutes: null, rest_gap: null, week_over: null,
    on_leave: null, unavailable: null, contracted_hours: null,
  }

  if (checked.shifts !== false && target) {
    const seen = new Set()
    const windows = []
    for (const row of own) {
      const w = workingWindow(row)
      if (!w || w.block_id === target.block_id) continue
      const key = w.block_id ?? `${w.date}|${w.start}|${w.end}|${w.location_id}`
      if (seen.has(key)) continue
      seen.add(key)
      windows.push(w)
    }
    const overlaps = (w) => w.startMs < target.endMs && target.startMs < w.endMs
    const busy = windows.filter(overlaps).sort((a, b) => a.startMs - b.startMs)[0] || null
    facts.free = !busy
    facts.busy = busy ? slotOf(busy, hereLocationId) : null
    const near = windows
      .filter((w) => !overlaps(w) && hereLocationId && w.location_id === hereLocationId && w.date === target.date)
      .map((w) => ({ w, gap: Math.round((w.endMs <= target.startMs ? target.startMs - w.endMs : w.startMs - target.endMs) / MINUTE_MS) }))
      .sort((a, b) => a.gap - b.gap || a.w.startMs - b.w.startMs)[0]
    facts.on_site = near
      ? { block_id: near.w.block_id ?? null, start: near.w.start, end: near.w.end, name: near.w.name, gap_minutes: near.gap }
      : null
    const week = weekStartOf(target.date)
    facts.week_minutes = Math.round(windows
      .filter((w) => weekStartOf(w.date) === week)
      .reduce((sum, w) => sum + (w.endMs - w.startMs), 0) / MINUTE_MS)
    if (covered && candidateRow) {
      const wt = candidateWorkingTime(own, candidateRow, { hereLocationId })
      facts.rest_gap = wt.restGap
      facts.week_over = wt.weekHours
    }
  }

  if (checked.leave !== false && date) {
    const hit = (leave || [])
      .filter((l) => l?.start_date && l.end_date && l.start_date <= date && l.end_date >= date)
      .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))[0]
    facts.on_leave = hit
      ? { type: hit.type ?? null, label: timeOffLeaveLabel(hit.type), start_date: hit.start_date, end_date: hit.end_date }
      : null
  }

  if (checked.availability !== false && date) {
    const matches = unavailableFor(rules, date, target?.start ?? null, target?.end ?? null)
    facts.unavailable = matches
      ? {
        summary: unavailableSummary(matches),
        detail: matches.map((r) => (r.note ? `${describeRule(r)} (${r.note})` : describeRule(r))).join('; '),
      }
      : null
  }

  if (checked.contract !== false && covered && Number(contractedHours) > 0) facts.contracted_hours = Number(contractedHours)
  return facts
}

function groupByProfile(rows) {
  const out = new Map()
  for (const r of rows || []) {
    if (!r?.profile_id) continue
    if (!out.has(r.profile_id)) out.set(r.profile_id, [])
    out.get(r.profile_id).push(r)
  }
  return out
}

const valueOf = (mapOrObject, key) => {
  if (!mapOrObject) return null
  return (typeof mapOrObject.get === 'function' ? mapOrObject.get(key) : mapOrObject[key]) ?? null
}

/**
 * The ranked candidate list for one block.
 *
 * @param {{
 *   block: { id, location_id, block_date, start_time, end_time, shift_templates },
 *   members: Array<{ profile_id, full_name, role, employment_type }>,  eligible, not on the block
 *   shifts: object[],   readOrgShiftRows rows (every studio of the organisation)
 *   leave: Array<{ profile_id, type, start_date, end_date }>,  approved
 *   rules: Array<{ profile_id, ...AVAIL rule }>,
 *   contracts: Map|object  profile_id → contracted hours per week (employees)
 *   checked: { shifts, cross_studio, leave, availability, contract },
 *   audience: 'manager' | 'colleague',
 * }} args
 * @returns {{ candidates: object[], untimed: number }}
 *   manager:   every fact + tier, rank, reason
 *   colleague: { profile_id, full_name, role, free, tier, rank, reason } only
 */
export function buildCandidates({
  block, members = [], shifts = [], leave = [], rules = [], contracts = null, checked = {}, audience = 'manager',
} = {}) {
  if (!block?.id) return { candidates: [], untimed: 0 }
  const colleague = audience === 'colleague'
  const here = block.location_id ?? null
  const rowFor = (profileId) => ({
    profile_id: profileId,
    block_id: block.id,
    block_date: block.block_date,
    location_id: here,
    location_name: null,
    name: block.shift_templates?.name || 'Shift',
    status: 'scheduled',
    start_time: block.start_time ?? null,
    end_time: block.end_time ?? null,
    shift_templates: { start_time: block.shift_templates?.start_time ?? null, end_time: block.shift_templates?.end_time ?? null },
  })
  const target = workingWindow(rowFor('target'))
  const shiftsBy = groupByProfile(shifts)
  const leaveBy = groupByProfile(leave)
  const rulesBy = groupByProfile(rules)
  const people = (members || []).filter((m) => m?.profile_id)

  const facts = people.map((m) => {
    const f = candidateFacts({
      target,
      candidateRow: rowFor(m.profile_id),
      own: shiftsBy.get(m.profile_id) || [],
      leave: colleague ? [] : leaveBy.get(m.profile_id) || [],
      rules: colleague ? [] : rulesBy.get(m.profile_id) || [],
      contractedHours: colleague ? null : valueOf(contracts, m.profile_id),
      covered: !colleague && isWorkingTimeCovered(m.employment_type),
      hereLocationId: here,
      checked,
    })
    const base = { profile_id: m.profile_id, full_name: m.full_name ?? null, role: m.role ?? null }
    // Project BEFORE ranking: a colleague's order must not encode the rest.
    return colleague ? { ...base, free: f.free } : { ...base, ...f }
  })

  const ids = new Set(people.map((m) => m.profile_id))
  const untimed = colleague || people.length === 0
    ? 0
    : untimedShiftCount((shifts || []).filter((s) => ids.has(s?.profile_id))) + (target ? 0 : 1)
  return { candidates: rankCandidates(facts, colleague ? 'colleague' : 'manager'), untimed }
}
```

- [ ] **Step 4: Run it, expect PASS, both timezones**

Run: `for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run shared/candidates.test.js shared/working-time.test.js shared/availability.test.js || break; done`
Expected: all pass in both runs.

- [ ] **Step 5: Commit**

```bash
git add shared/candidates.js shared/candidates.test.js
git commit -m "CANDIDATES.1 — candidateFacts and buildCandidates: free, busy, on site, week, leave, availability, rest

Effective windows as real instants (WORKTIME.1's workingWindow): an override
counts, a touching end is on site not busy, the other studio counts. Rest and
48h stay employees-only. The colleague projection is ranked on free/working
alone. Unread facets stay null.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `src/lib/candidates-data.js` — the reads

**Files:**
- Create: `src/lib/candidates-data.js`
- Create: `src/lib/candidates-data.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/candidates-data.test.js`:

```js
// CANDIDATES.1 — the reads behind GET /api/schedule/blocks/[id]/candidates.
// The rules are pinned in shared/candidates.test.js; this pins WHICH rows are
// read, which columns (never pay), which audience reads what, and that a
// failed read is "not checked", never an all-clear.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./sibling-locations', () => ({ siblingLocationIds: vi.fn() }))
vi.mock('./working-time-data', () => ({ readOrgShiftRows: vi.fn() }))
vi.mock('./availability-server', () => ({ readStudioAvailability: vi.fn() }))
vi.mock('./log', async () => ({ ...(await vi.importActual('./log')), logWarn: vi.fn() }))

import { siblingLocationIds } from './sibling-locations'
import { readOrgShiftRows } from './working-time-data'
import { readStudioAvailability } from './availability-server'
import { loadBlockCandidates, readEligibleMembers, readContractedHours } from './candidates-data'

const NAMES = { ann: 'Ann Free', con: 'Con Tractor', off: 'Off Duty', gone: 'Gone Away', onblk: 'On Block', nul: 'Nul Active' }
const link = (profile_id, over = {}) => ({
  profile_id, role: 'staff',
  profiles: { id: profile_id, full_name: NAMES[profile_id], active: true, deleted_at: null, employment_type: 'fte', ...over },
})
const LINKS = [
  link('ann'),
  link('con', { employment_type: 'contractor' }),
  link('off', { active: false }),
  link('gone', { active: false, deleted_at: '2026-09-01T00:00:00Z' }),
  link('onblk'),
  link('nul', { active: null }), // mig 626: a NULL active still counts
]
const BLOCK = {
  id: 'blk', location_id: 'loc1', block_date: '2026-09-23', start_time: '10:00:00', end_time: '12:00:00',
  shift_templates: { name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  // con's cancelled tombstone does not hold the seat (ROSTER-FIX.1 D4).
  shift_assignments: [{ profile_id: 'onblk', status: 'scheduled' }, { profile_id: 'con', status: 'cancelled' }],
}
const SHIFTS = [{
  profile_id: 'ann', block_id: 'x1', block_date: '2026-09-21', location_id: 'loc2', location_name: 'Studio South', name: 'Class',
  status: 'scheduled', start_time_override: null, end_time_override: null, start_time: '09:00:00', end_time: '13:00:00',
  shift_templates: { start_time: '09:00:00', end_time: '13:00:00' },
}]
const LEAVE = [{ id: 'l1', profile_id: 'con', type: 'holiday', start_date: '2026-09-22', end_date: '2026-09-24' }]
const RULES = [
  { id: 'r1', profile_id: 'onblk', kind: 'weekly', weekday: 'wed', start_date: null, end_date: null, all_day: false, start_time: '10:00', end_time: '11:00', note: null },
  { id: 'r2', profile_id: 'nul', kind: 'weekly', weekday: 'wed', start_date: null, end_date: null, all_day: true, start_time: null, end_time: null, note: null },
]
const COMP = [
  { profile_id: 'ann', contracted_hours_per_week: '39.0' },
  { profile_id: 'nul', contracted_hours_per_week: null },
]

function mockDb({ links = LINKS, leave = LEAVE, comp = COMP, fail = {} } = {}) {
  const log = []
  return {
    log,
    from(table) {
      const q = { table, select: null, eqs: [], ins: [], lte: null, gte: null, orders: [], range: null }
      log.push(q)
      const ids = () => q.ins.find(([c]) => c === 'profile_id')?.[1] || []
      const answer = () => {
        if (fail[table]) return { data: null, error: { message: `${table} unreadable` } }
        if (table === 'profile_locations') {
          const [from, to] = q.range || [0, Infinity]
          return { data: links.slice(from, to + 1), error: null }
        }
        if (table === 'time_off_requests') return { data: leave.filter((l) => ids().includes(l.profile_id)), error: null }
        if (table === 'profile_compensation') return { data: comp.filter((c) => ids().includes(c.profile_id)), error: null }
        throw new Error(`unexpected table ${table}`)
      }
      const chain = {
        select: (s) => { q.select = s; return chain },
        eq: (c, v) => { q.eqs.push([c, v]); return chain },
        in: (c, v) => { q.ins.push([c, v]); return chain },
        lte: (c, v) => { q.lte = [c, v]; return chain },
        gte: (c, v) => { q.gte = [c, v]; return chain },
        order: (c) => { q.orders.push(c); return chain },
        range: (f, t) => { q.range = [f, t]; return chain },
        then: (onF, onR) => Promise.resolve().then(answer).then(onF, onR),
      }
      return chain
    },
  }
}
const read = (db, table) => db.log.find((q) => q.table === table)

beforeEach(() => {
  siblingLocationIds.mockReset().mockResolvedValue({ ids: ['loc2'], error: null })
  readOrgShiftRows.mockReset().mockResolvedValue({ shifts: SHIFTS, error: null })
  readStudioAvailability.mockReset().mockResolvedValue({ data: RULES, error: null })
})

describe('readEligibleMembers', () => {
  it('active members of the studio only, minus the live people on the block; names and employment type, no pay', async () => {
    const db = mockDb()
    const out = await readEligibleMembers(db, { locationId: 'loc1', excludeIds: ['onblk'] })
    expect(out.error).toBeNull()
    expect(out.members).toEqual([
      { profile_id: 'ann', full_name: 'Ann Free', role: 'staff', employment_type: 'fte' },
      { profile_id: 'con', full_name: 'Con Tractor', role: 'staff', employment_type: 'contractor' },
      { profile_id: 'nul', full_name: 'Nul Active', role: 'staff', employment_type: 'fte' },
    ])
    const q = read(db, 'profile_locations')
    expect(q.select).toBe('profile_id, role, profiles!inner(id, full_name, active, deleted_at, employment_type)')
    expect(q.eqs).toEqual([['location_id', 'loc1']])
    expect(q.orders).toEqual(['profile_id'])
    expect(q.range).toEqual([0, 999])
  })

  it('pages past 1,000 members', async () => {
    const links = Array.from({ length: 1001 }, (_, i) => ({ profile_id: `p${i}`, role: 'staff', profiles: { id: `p${i}`, full_name: `P ${i}`, active: true, deleted_at: null, employment_type: 'fte' } }))
    const db = mockDb({ links })
    const out = await readEligibleMembers(db, { locationId: 'loc1' })
    expect(db.log.filter((q) => q.table === 'profile_locations')).toHaveLength(2)
    expect(out.members).toHaveLength(1001)
  })
})

describe('readContractedHours', () => {
  it('names its one column, chunks at 200, keeps positive numbers only', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `p${i}`)
    const db = mockDb({ comp: [{ profile_id: 'p0', contracted_hours_per_week: '37.5' }, { profile_id: 'p1', contracted_hours_per_week: 0 }] })
    const out = await readContractedHours(db, ids)
    const reads = db.log.filter((q) => q.table === 'profile_compensation')
    expect(reads.map((q) => q.ins[0][1].length)).toEqual([200, 200, 50])
    expect(reads[0].select).toBe('profile_id, contracted_hours_per_week')
    expect([...out.byProfile]).toEqual([['p0', 37.5]])
  })

  it('nobody: no read', async () => {
    const db = mockDb()
    expect(await readContractedHours(db, [])).toEqual({ byProfile: new Map(), error: null })
    expect(db.log).toHaveLength(0)
  })
})

describe('loadBlockCandidates — manager', () => {
  it('reads the week at every studio of the organisation, leave on the day, availability, and employees\' contracts', async () => {
    const db = mockDb()
    const out = await loadBlockCandidates(db, { block: BLOCK, audience: 'manager' })
    expect(siblingLocationIds).toHaveBeenCalledWith(db, 'loc1')
    expect(readOrgShiftRows).toHaveBeenCalledWith(db, {
      locationId: 'loc1', scopeIds: ['loc1', 'loc2'], profileIds: ['ann', 'con', 'nul'], from: '2026-09-20', to: '2026-09-28',
    })
    const leave = read(db, 'time_off_requests')
    expect(leave.select).toBe('id, profile_id, type, start_date, end_date')
    expect(leave.eqs).toEqual([['status', 'approved']])
    expect(leave.lte).toEqual(['start_date', '2026-09-23'])
    expect(leave.gte).toEqual(['end_date', '2026-09-23'])
    expect(readStudioAvailability).toHaveBeenCalledWith(db, { locationId: 'loc1', startDate: '2026-09-23', endDate: '2026-09-23' })
    expect(read(db, 'profile_compensation').ins).toEqual([['profile_id', ['ann', 'nul']]]) // employees only
    expect(out.error).toBeNull()
    expect(out.checked).toEqual({ shifts: true, cross_studio: true, leave: true, availability: true, contract: true })
    expect(out.candidates.map((c) => [c.profile_id, c.tier])).toEqual([['ann', 'ready'], ['nul', 'unavailable'], ['con', 'blocked']])
    expect(out.candidates[0]).toMatchObject({ contracted_hours: 39, week_minutes: 240, reason: 'Free · 4h of 39h this week' })
    expect(out.candidates[2].on_leave).toMatchObject({ type: 'holiday' })
  })

  it('never selects or returns a pay column', async () => {
    const db = mockDb()
    const out = await loadBlockCandidates(db, { block: BLOCK, audience: 'manager' })
    expect(db.log.map((q) => q.select).join(' ')).not.toMatch(/salary|hourly_rate|overtime|annual_leave/)
    expect(JSON.stringify(out)).not.toMatch(/salary|hourly_rate|overtime|rate"/)
  })

  it('a failed side read is "not checked" and the list still comes back; a failed member read is an error', async () => {
    readOrgShiftRows.mockResolvedValue({ shifts: [], error: { message: 'assignments unreadable' } })
    readStudioAvailability.mockResolvedValue({ data: null, error: { message: 'relation "staff_unavailability" does not exist' } })
    siblingLocationIds.mockResolvedValue({ ids: [], error: { message: 'siblings unreadable' } })
    const db = mockDb({ fail: { time_off_requests: true, profile_compensation: true } })
    const out = await loadBlockCandidates(db, { block: BLOCK, audience: 'manager' })
    expect(out.checked).toEqual({ shifts: false, cross_studio: false, leave: false, availability: false, contract: false })
    expect(readOrgShiftRows.mock.calls[0][1].scopeIds).toEqual(['loc1'])
    expect(out.candidates.map((c) => c.profile_id)).toEqual(['ann', 'con', 'nul'])
    expect(out.candidates.every((c) => c.free === null && c.on_leave === null && c.contracted_hours === null)).toBe(true)

    const broken = await loadBlockCandidates(mockDb({ fail: { profile_locations: true } }), { block: BLOCK, audience: 'manager' })
    expect(broken.error).toEqual({ message: 'profile_locations unreadable' })
  })

  it('nobody eligible: no further reads', async () => {
    const db = mockDb({ links: [link('onblk')] })
    const out = await loadBlockCandidates(db, { block: BLOCK, audience: 'manager' })
    expect(out).toMatchObject({ candidates: [], untimed: 0, error: null })
    expect(siblingLocationIds).not.toHaveBeenCalled()
    expect(readOrgShiftRows).not.toHaveBeenCalled()
  })
})

describe('loadBlockCandidates — colleague', () => {
  it('reads shifts only: no leave, no availability, no contracts; free or working only', async () => {
    const db = mockDb()
    const out = await loadBlockCandidates(db, { block: BLOCK, audience: 'colleague' })
    expect(db.log.map((q) => q.table)).toEqual(['profile_locations'])
    expect(readStudioAvailability).not.toHaveBeenCalled()
    expect(readOrgShiftRows).toHaveBeenCalledTimes(1)
    expect(out.checked).toEqual({ shifts: true, cross_studio: true })
    expect(out.candidates.map((c) => c.profile_id)).toEqual(['ann', 'con', 'nul'])
    expect(Object.keys(out.candidates[0]).sort()).toEqual(['free', 'full_name', 'profile_id', 'rank', 'reason', 'role', 'tier'])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/candidates-data.test.js`
Expected: FAIL, `Failed to resolve import "./candidates-data"`.

- [ ] **Step 3: Implement**

Create `src/lib/candidates-data.js`:

```js
// src/lib/candidates-data.js
//
// CANDIDATES.1 — the reads behind GET /api/schedule/blocks/[id]/candidates.
// Service-role client passed in: the ROUTE is the access boundary (CLAUDE.md,
// "Service-role routes get NO RLS"). It has already checked the caller
// belongs to the block's studio and decided the audience.
//
// Who is a candidate: an ACTIVE member of the block's studio (active IS NOT
// FALSE, mig 626; never a tombstone, mig 622) who is not live on the block.
// Same rule as the assign route (isRosterableProfile + membership), so the
// list never offers someone the POST would refuse.
//
// Reads (manager): members (paged) → sibling studios → in parallel: the
// block's Mon–Sun week of shifts, one day either side, at every studio of
// the organisation (readOrgShiftRows, WORKTIME.1's reader); approved leave on
// the day; availability rules (AVAIL.1a readStudioAvailability); contracted
// hours of the EMPLOYEES. Colleague: members, siblings, shifts. Nothing else.
//
// Pay never enters: profiles is read for id, full_name, active, deleted_at,
// employment_type; profile_compensation for profile_id and
// contracted_hours_per_week BY NAME (the table's other four columns are pay).
//
// Never throws. A failed member read is { error } (nothing to rank). Any
// other failed read sets its `checked` flag false and leaves that fact null,
// so the picker can say what it did not check.

import { siblingLocationIds } from './sibling-locations'
import { readOrgShiftRows } from './working-time-data'
import { readStudioAvailability } from './availability-server'
import { isRosterableProfile } from './roster-write'
import { liveAssignments } from './roster'
import { mondayOf } from './payroll'
import { addDaysISO } from './dublin-time'
import { logWarn } from './log'
import { buildCandidates } from '@shared/candidates'
import { isWorkingTimeCovered } from '@shared/working-time'

const PAGE = 1000
const CHUNK = 200

/**
 * Rosterable members of one studio, minus `excludeIds`, in profile_id order.
 * @returns {Promise<{ members: Array<{ profile_id, full_name, role, employment_type }>|null, error }>}
 */
export async function readEligibleMembers(db, { locationId, excludeIds = [] } = {}) {
  const skip = new Set(excludeIds || [])
  const members = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('profile_locations')
      .select('profile_id, role, profiles!inner(id, full_name, active, deleted_at, employment_type)')
      .eq('location_id', locationId)
      .order('profile_id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { members: null, error }
    for (const l of data || []) {
      if (!l?.profile_id || skip.has(l.profile_id) || !isRosterableProfile(l.profiles)) continue
      members.push({
        profile_id: l.profile_id,
        full_name: l.profiles.full_name ?? null,
        role: l.role ?? null,
        employment_type: l.profiles.employment_type ?? null,
      })
    }
    if (!data || data.length < PAGE) break
  }
  return { members, error: null }
}

/** Approved leave covering `dateIso` for these people (both ends inclusive, mig 011). */
export async function readApprovedLeaveOn(db, profileIds, dateIso) {
  const leave = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('time_off_requests')
      .select('id, profile_id, type, start_date, end_date')
      .in('profile_id', profileIds)
      .eq('status', 'approved')
      .lte('start_date', dateIso)
      .gte('end_date', dateIso)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { leave: null, error }
    leave.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { leave, error: null }
}

/**
 * profile_id → contracted hours per week (> 0 only), from profile_compensation
 * (mig 152; profiles.contracted_hours_per_week is DEPRECATED). ONE column by
 * name: never getCompensationForProfiles, which reads all five pay columns
 * and discards its error. Chunked at 200 like that helper, for .in() URL length.
 */
export async function readContractedHours(db, profileIds) {
  const byProfile = new Map()
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await db
      .from('profile_compensation')
      .select('profile_id, contracted_hours_per_week')
      .in('profile_id', ids.slice(i, i + CHUNK))
    if (error) return { byProfile: null, error }
    for (const row of data || []) {
      const hours = Number(row?.contracted_hours_per_week)
      if (row?.profile_id && Number.isFinite(hours) && hours > 0) byProfile.set(row.profile_id, hours)
    }
  }
  return { byProfile, error: null }
}

/**
 * @param {{ block: { id, location_id, block_date, start_time, end_time, shift_templates, shift_assignments },
 *   audience: 'manager'|'colleague' }} opts
 * @returns {Promise<{ candidates?: object[], untimed?: number, checked?: object, error: object|null }>}
 */
export async function loadBlockCandidates(db, { block, audience = 'manager' } = {}) {
  const manager = audience !== 'colleague'
  const who = manager ? 'manager' : 'colleague'
  const checked = manager
    ? { shifts: true, cross_studio: true, leave: true, availability: true, contract: true }
    : { shifts: true, cross_studio: true }
  try {
    const onBlock = liveAssignments(block?.shift_assignments).map((a) => a.profile_id)
    const { members, error } = await readEligibleMembers(db, { locationId: block.location_id, excludeIds: onBlock })
    if (error) return { error }
    const ids = members.map((m) => m.profile_id)
    if (ids.length === 0) return { ...buildCandidates({ block, members, checked, audience: who }), checked, error: null }

    const { ids: siblingIds, error: sibErr } = await siblingLocationIds(db, block.location_id)
    if (sibErr) {
      checked.cross_studio = false
      logWarn('candidates', 'sibling studios unreadable; candidates check this studio only', { blockId: block.id, err: sibErr.message })
    }
    const scopeIds = [block.location_id, ...(siblingIds || []).filter((id) => id && id !== block.location_id)]
    const monday = mondayOf(block.block_date)
    const employees = members.filter((m) => isWorkingTimeCovered(m.employment_type)).map((m) => m.profile_id)
    const memberIds = new Set(ids)

    const [shiftRead, leaveRead, availRead, contractRead] = await Promise.all([
      readOrgShiftRows(db, { locationId: block.location_id, scopeIds, profileIds: ids, from: addDaysISO(monday, -1), to: addDaysISO(monday, 7) }),
      manager ? readApprovedLeaveOn(db, ids, block.block_date) : null,
      manager ? readStudioAvailability(db, { locationId: block.location_id, startDate: block.block_date, endDate: block.block_date }) : null,
      manager ? readContractedHours(db, employees) : null,
    ])

    const note = (facet, err) => {
      checked[facet] = false
      logWarn('candidates', `${facet} unreadable; candidates say so`, { blockId: block.id, err: err?.message })
    }
    if (shiftRead.error) note('shifts', shiftRead.error)
    let leave = []
    let rules = []
    let contracts = null
    if (manager) {
      if (leaveRead.error) note('leave', leaveRead.error)
      else leave = leaveRead.leave
      if (availRead.error) note('availability', availRead.error)
      else rules = (availRead.data || []).filter((r) => memberIds.has(r.profile_id))
      if (contractRead.error) note('contract', contractRead.error)
      else contracts = contractRead.byProfile
    }

    const built = buildCandidates({
      block, members, shifts: shiftRead.error ? [] : shiftRead.shifts, leave, rules, contracts, checked, audience: who,
    })
    return { ...built, checked, error: null }
  } catch (e) {
    return { error: { message: e?.message || 'candidates read threw' } }
  }
}
```

- [ ] **Step 4: Run it, expect PASS, both timezones**

Run: `for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/candidates-data.test.js || break; done`
Expected: all pass. Then run `npx vitest run tests/staff-tombstone-readers.test.js`. It passes because the new file never calls `from('profiles')`: members come through the `profile_locations` embed, and tombstones have no `profile_locations` (mig 622).

- [ ] **Step 5: Commit**

```bash
git add src/lib/candidates-data.js src/lib/candidates-data.test.js
git commit -m "CANDIDATES.1 — candidate reads: members, the week's shifts org-wide, leave, availability, contracted hours

Members = rosterable at the studio, not live on the block (the assign
route's rule). Contracted hours from profile_compensation by name, employees
only, manager only. A colleague reads shifts only. Failed side reads are
'not checked', never an all-clear.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The route — `GET /api/schedule/blocks/[id]/candidates`

**Files:**
- Create: `src/app/api/schedule/blocks/[id]/candidates/route.js`
- Create: `src/app/api/schedule/blocks/[id]/candidates/route.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/schedule/blocks/[id]/candidates/route.test.js`:

```js
// CANDIDATES.1 — GET /api/schedule/blocks/[id]/candidates. The rules are in
// shared/candidates.test.js and the reads in src/lib/candidates-data.test.js.
// Locked here: the gate, the two audiences, and the response shape.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccessOr404: vi.fn(() => null),
    // REAL: the role AT the block's studio is what is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
  }
})
vi.mock('@/lib/candidates-data', () => ({ loadBlockCandidates: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser, assertLocationAccessOr404 } = await import('@/lib/auth')
const { loadBlockCandidates } = await import('@/lib/candidates-data')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BLOCK_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const BLOCK = {
  id: BLOCK_ID, location_id: LOC, block_date: '2026-09-23', start_time: '10:00:00', end_time: '12:00:00',
  shift_templates: { name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [{ profile_id: 'coach-on', status: 'scheduled' }, { profile_id: 'coach-dropped', status: 'cancelled' }],
}
const LOADED = {
  candidates: [{ profile_id: 'p1', full_name: 'Ann Free', role: 'staff', rank: 1, tier: 'ready', reason: 'Free · 4h of 39h this week', free: true }],
  checked: { shifts: true, cross_studio: true, leave: true, availability: true, contract: true },
  untimed: 0,
  error: null,
}

function dbWith({ block = BLOCK, blockError = null } = {}) {
  const log = { select: null, eq: null }
  return {
    log,
    from(table) {
      if (table !== 'shift_blocks') throw new Error(`unexpected table ${table}`)
      const chain = {
        select: (s) => { log.select = s; return chain },
        eq: (c, v) => { log.eq = [c, v]; return chain },
        maybeSingle: async () => ({ data: blockError ? null : block, error: blockError }),
      }
      return chain
    },
  }
}
const call = (id = BLOCK_ID) => GET(new Request(`http://test/api/schedule/blocks/${id}/candidates`), { params: Promise.resolve({ id }) })
const userWith = (id, rolesByLocation, profileRole = 'staff') => ({
  id, profileRole, rolesByLocation, locations: Object.keys(rolesByLocation).map((l) => ({ id: l })),
})

let db
beforeEach(() => {
  db = dbWith()
  createServerClient.mockReset().mockImplementation(() => db)
  getCurrentUser.mockReset()
  assertLocationAccessOr404.mockReset().mockReturnValue(null)
  loadBlockCandidates.mockReset().mockResolvedValue(LOADED)
})

describe('GET /api/schedule/blocks/[id]/candidates', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
    expect(loadBlockCandidates).not.toHaveBeenCalled()
  })

  it('400 on a malformed id', async () => {
    getCurrentUser.mockResolvedValue(userWith('m1', { [LOC]: 'manager' }))
    expect((await call('nope')).status).toBe(400)
  })

  it('404 when the block does not exist; 500 when it cannot be read', async () => {
    getCurrentUser.mockResolvedValue(userWith('m1', { [LOC]: 'manager' }))
    db = dbWith({ block: null })
    expect((await call()).status).toBe(404)
    db = dbWith({ blockError: { message: 'db down' } })
    expect((await call()).status).toBe(500)
  })

  it('404, not 403, for someone outside the block\'s studio: the id is not confirmed', async () => {
    getCurrentUser.mockResolvedValue(userWith('m2', { [OTHER]: 'manager' }))
    assertLocationAccessOr404.mockReturnValue(NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }))
    expect((await call()).status).toBe(404)
    expect(loadBlockCandidates).not.toHaveBeenCalled()
  })

  it('403 for a coach at the studio who is not on the block (a cancelled row does not count), even one who manages elsewhere', async () => {
    for (const id of ['coach-off', 'coach-dropped']) {
      getCurrentUser.mockResolvedValue(userWith(id, { [LOC]: 'staff', [OTHER]: 'manager' }))
      expect((await call()).status).toBe(403)
    }
    expect(loadBlockCandidates).not.toHaveBeenCalled()
  })

  it('200 manager: the full list, read once for this block', async () => {
    getCurrentUser.mockResolvedValue(userWith('m1', { [LOC]: 'head_coach' }))
    const res = await call()
    expect(res.status).toBe(200)
    expect(db.log.eq).toEqual(['id', BLOCK_ID])
    expect(db.log.select).toBe('id, location_id, block_date, start_time, end_time, shift_templates(name, start_time, end_time), shift_assignments(profile_id, status)')
    expect(loadBlockCandidates).toHaveBeenCalledTimes(1)
    expect(loadBlockCandidates).toHaveBeenCalledWith(db, { block: BLOCK, audience: 'manager' })
    expect(await res.json()).toEqual({
      success: true,
      data: { audience: 'manager', block_id: BLOCK_ID, candidates: LOADED.candidates, checked: LOADED.checked, untimed: 0 },
    })
  })

  it('200 master anywhere: manager audience', async () => {
    getCurrentUser.mockResolvedValue(userWith('boss', {}, 'master'))
    await call()
    expect(loadBlockCandidates.mock.calls[0][1].audience).toBe('manager')
  })

  it('200 colleague: the coach live on the block (asking for cover)', async () => {
    getCurrentUser.mockResolvedValue(userWith('coach-on', { [LOC]: 'staff' }))
    const res = await call()
    expect(res.status).toBe(200)
    expect(loadBlockCandidates).toHaveBeenCalledWith(db, { block: BLOCK, audience: 'colleague' })
    expect((await res.json()).data.audience).toBe('colleague')
  })

  it('500 when the member list cannot be read: there is nothing to rank', async () => {
    getCurrentUser.mockResolvedValue(userWith('m1', { [LOC]: 'manager' }))
    loadBlockCandidates.mockResolvedValue({ error: { message: 'profile_locations unreadable' } })
    const res = await call()
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run 'src/app/api/schedule/blocks/[id]/candidates/route.test.js'`
Expected: FAIL, `Failed to resolve import "./route.js"`.

- [ ] **Step 3: Implement**

Create `src/app/api/schedule/blocks/[id]/candidates/route.js`:

```js
// CANDIDATES.1 — GET /api/schedule/blocks/[id]/candidates
//
// The coaches who could take this shift, RANKED, each with the reason. Used
// by the web assign picker, the phone's Manage "Add coach" sheet and the
// phone's "Ask a coach to cover" sheet. ADVISORY ONLY: POST
// /api/schedule/blocks/[id]/assignments and POST /api/schedule/swaps never
// consult it, and every picker keeps every row pickable.
//
// Two audiences (decided here, never by the client):
//   manager    MANAGER_ROLES AT the block's studio (master bypasses): every
//              fact — free/busy at any studio of the organisation, leave with
//              its type, availability with its note, on site, week minutes,
//              employees' contracted hours, rest and 48h advisories.
//   colleague  a coach LIVE on the block (the one asking for cover): free or
//              working only, ranked on that alone. A coach never sees a
//              colleague's leave, availability, hours or contract.
// Anyone else at the studio: 403. Outside the studio: 404, so the block id is
// never confirmed (SCHEDROLES.1's rule, as the assign route).
//
// Hours only: no rate, salary, overtime or cost is read or returned
// (src/lib/candidates-data.js names every column).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { liveAssignments } from '@/lib/roster'
import { loadBlockCandidates } from '@/lib/candidates-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const parsed = uuidLike.safeParse(params?.id)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid block id' }, { status: 400 })

  const db = createServerClient()

  // Block lookup: also the studio-ownership gate.
  const { data: block, error: blockErr } = await db
    .from('shift_blocks')
    .select('id, location_id, block_date, start_time, end_time, shift_templates(name, start_time, end_time), shift_assignments(profile_id, status)')
    .eq('id', parsed.data)
    .maybeSingle()
  if (blockErr) return NextResponse.json({ success: false, error: blockErr.message }, { status: 500 })
  if (!block) return NextResponse.json({ success: false, error: 'Block not found' }, { status: 404 })

  const notHere = assertLocationAccessOr404(user, block.location_id)
  if (notHere) return notHere

  const isManager = hasRoleAtLocation(user, block.location_id, MANAGER_ROLES)
  const onBlock = liveAssignments(block.shift_assignments).some((a) => a.profile_id === user.id)
  if (!isManager && !onBlock) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const audience = isManager ? 'manager' : 'colleague'

  const out = await loadBlockCandidates(db, { block, audience })
  if (out.error) {
    return NextResponse.json({ success: false, error: out.error.message || 'Candidates could not be read' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: { audience, block_id: block.id, candidates: out.candidates, checked: out.checked, untimed: out.untimed },
  })
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run 'src/app/api/schedule/blocks/[id]/candidates/route.test.js' && npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns`
Expected: all pass.

- `check:location-scoping` accepts the route the same way it accepts `working-time/route.js`: a block read by id, then `assertLocationAccessOr404`.
- `check:select-columns` resolves every column of the new selects: `profile_compensation.contracted_hours_per_week` (mig 152) and `profile_locations.role` (mig 051). `staff_unavailability` is read only inside `readStudioAvailability`.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/schedule/blocks/[id]/candidates/route.js' 'src/app/api/schedule/blocks/[id]/candidates/route.test.js'
git commit -m "CANDIDATES.1 — GET /api/schedule/blocks/[id]/candidates: manager list, or free/working for the coach on the block

404 outside the studio, 403 for a member neither managing there nor live on
the block, 500 only when the member list is unreadable.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: OpenAPI

**Files:**
- Modify: `src/lib/openapi.js` (insert after the WORKTIME.1 `registry.registerPath({ … '/api/schedule/working-time' … })` block, which ends at main line 4593)
- Modify: `src/lib/openapi.test.js` (insert before `it('declares webhook + bridge auth schemes'`)

- [ ] **Step 1: Write the failing test**

In `src/lib/openapi.test.js`, directly before `  it('declares webhook + bridge auth schemes', () => {`, add:

```js
  // CANDIDATES.1 — the ranked picker list. Its two audiences and its
  // hours-only promise are the contract, so they are pinned in the document.
  it('documents the block candidates route', () => {
    const op = spec.paths['/api/schedule/blocks/{id}/candidates']?.get
    expect(op).toBeDefined()
    expect(op.tags).toContain('Schedule')
    expect(op.security).toContainEqual({ CookieAuth: [] })
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '400', '401', '403', '404', '500']))
    expect(op.description).toMatch(/colleague/)
    expect(op.description).toMatch(/never a rate/i)
  })
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: FAIL, `expected undefined not to be undefined`.

- [ ] **Step 3: Implement**

In `src/lib/openapi.js`, find the closing `})` of the WORKTIME.1 registration (`path: '/api/schedule/working-time'`). The next `registry.registerPath({` after it is `GET /api/schedule/time-off`. Insert this between the two:

```js
// CANDIDATES.1 — ranked candidates for one block (every coach picker).
registry.registerPath({
  method: 'get',
  path: '/api/schedule/blocks/{id}/candidates',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Ranked coaches who could take one shift (advisory)',
  description: "CANDIDATES.1. Every rosterable member of the block's studio (active, a member there, not live on the block), ranked: tier (ready, advisory = under 11h rest or over 48h in the week for an employee, unavailable = an AVAIL.1 rule touching the shift, blocked = approved leave or already working then at ANY studio of the organisation), then on site that day, then an employee under their contracted hours by share of it, then everyone else by fewest rostered hours Mon-Sun, then name. Advisory only: POST /api/schedule/blocks/{id}/assignments and POST /api/schedule/swaps never consult it. Two audiences, decided by the server: `manager` (MANAGER_ROLES at the block's studio, or master) gets each candidate's { profile_id, full_name, role, rank, tier, reason, free, busy, on_leave { type, label, start_date, end_date }, unavailable { summary, detail }, on_site { start, end, name, gap_minutes }, week_minutes, contracted_hours (employees only), rest_gap, week_over }; `colleague` (a coach live on the block, asking for cover) gets { profile_id, full_name, role, rank, tier, reason, free } only, ranked on free alone. Times are Dublin wall clock; windows are effective (override, then block, then template). A fact that could not be read is null and `checked.<facet>` is false (shifts, cross_studio, leave, availability, contract). Hours only: never a rate, salary or cost.",
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: '{ audience, block_id, candidates (by rank), checked, untimed } (untimed = shifts with no usable times, not counted)' },
    400: { description: 'Malformed block id', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'No session', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: "A member of the block's studio who neither manages there nor is live on the block", content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Block not found (or not at a studio the caller belongs to)', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: "The block or the studio's member list could not be read", content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js
git commit -m "CANDIDATES.1 — register GET /api/schedule/blocks/{id}/candidates in the API docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The web assign picker uses the ranked list

**Precondition (Task 0):** AVAIL.1b has merged. The four pieces marked `(AVAIL.1b)` below exist only after it. In the Case B "dropped" variant, leave them out.

**Files:**
- Create: `src/components/ScheduleCalendar.candidates.test.jsx`
- Modify: `src/components/ScheduleCalendar.jsx`
- Modify: `src/components/ScheduleCalendar.working-time.test.jsx` (its picker tests move to the new file)

- [ ] **Step 1: Write the failing test**

Create `src/components/ScheduleCalendar.candidates.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// CANDIDATES.1 — the web assign picker lists the server's RANKED candidates
// (GET /api/schedule/blocks/[id]/candidates), with the badges and an hours
// line, and stays advisory: every row can be ticked. Until the answer lands,
// or if it fails or is not understood, it is the pre-CANDIDATES list (this
// studio's staff A–Z with the local badges). The rules are pinned in
// shared/candidates.test.js; this is the wiring. jsdom has no layout: text,
// roles and presence only. No fake timers.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'

// See ScheduleCalendar.errors.test.jsx: the budget exceeds the waits below.
vi.setConfig({ testTimeout: 20000 })

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'
import { CANDIDATES_RANKING_NOTE, CANDIDATES_UNRANKED_NOTE } from '@shared/candidates'

const LOC = 'loc1'
const user = {
  id: 'u1', role: 'manager', profileRole: 'manager', rolesByLocation: { [LOC]: 'manager' },
  activeLocation: { id: LOC, name: 'Studio North' },
}

// Wednesday of the week the URL pins.
const targetBlock = {
  id: 'b-target', location_id: LOC, template_id: 't2', block_date: '2026-05-06',
  start_time: '10:00:00', end_time: '12:00:00', max_coaches: 3, min_coaches: 1,
  shift_templates: { id: 't2', name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [],
}

const coach = (id, full_name) => ({ id, full_name, role: 'staff', active: true, profile_locations: [{ location_id: LOC }] })
const staff = [
  coach('c-unav', 'Away Coach'), coach('c-busy', 'Busy Coach'), coach('c-here', 'Here Coach'),
  coach('c-leave', 'Leave Coach'), coach('c-rest', 'Rest Coach'), coach('c-week', 'Week Coach'),
]

const none = { free: true, busy: null, on_leave: null, unavailable: null, on_site: null, rest_gap: null, week_over: null, contracted_hours: null }
const ANSWER = {
  success: true,
  data: {
    audience: 'manager', block_id: 'b-target', untimed: 0,
    checked: { shifts: true, cross_studio: true, leave: true, availability: true, contract: true },
    candidates: [
      { ...none, profile_id: 'c-here', full_name: 'Here Coach', role: 'staff', rank: 1, tier: 'ready', on_site: { block_id: 'x1', start: '07:00', end: '09:00', name: 'Early', gap_minutes: 60 }, week_minutes: 120 },
      { ...none, profile_id: 'c-rest', full_name: 'Rest Coach', role: 'staff', rank: 2, tier: 'advisory', week_minutes: 90, contracted_hours: 39,
        rest_gap: { rest_minutes: 570, side: 'before', other: { block_id: 'x', date: '2026-05-05', start: '20:00', end: '21:30', name: 'Evening', location_name: 'Studio South' } } },
      { ...none, profile_id: 'c-week', full_name: 'Week Coach', role: 'staff', rank: 3, tier: 'advisory', week_minutes: 2790, contracted_hours: 39,
        week_over: { week_start: '2026-05-04', minutes: 2910 } },
      { ...none, profile_id: 'c-unav', full_name: 'Away Coach', role: 'staff', rank: 4, tier: 'unavailable', week_minutes: 0, contracted_hours: 30,
        unavailable: { summary: '10am–11am', detail: 'Wednesdays, 10am–11am (School run)' } },
      { ...none, profile_id: 'c-busy', full_name: 'Busy Coach', role: 'staff', rank: 5, tier: 'blocked', free: false, week_minutes: 60,
        busy: { block_id: 'b-busy', date: '2026-05-06', start: '09:30', end: '10:30', name: 'Morning HIIT', location_name: null } },
      { ...none, profile_id: 'c-leave', full_name: 'Leave Coach', role: 'staff', rank: 6, tier: 'blocked', week_minutes: 0,
        on_leave: { type: 'holiday', label: 'Holiday', start_date: '2026-05-05', end_date: '2026-05-07' } },
    ],
  },
}

function okResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

function mockFetch({ answer = ANSWER, status = 200 } = {}) {
  return vi.fn(async (url) => {
    const u = String(url)
    // Before '/schedule/blocks': the candidates URL contains it too.
    if (u.includes('/candidates')) return okResponse(answer, status)
    if (u.includes('/schedule/blocks')) return okResponse({ success: true, data: [targetBlock] })
    if (u.includes('/api/staff')) return okResponse({ success: true, data: staff })
    return okResponse({ success: true, data: [] })
  })
}

async function openAssignPicker() {
  render(<ScheduleCalendar user={user} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Manage 10am Midday Strength shift/ }))
  await waitFor(() => expect(screen.getByText('Add coach')).toBeTruthy())
  fireEvent.click(screen.getByText('Add coach'))
  await waitFor(() => expect(screen.getByText('Pick one or more coaches')).toBeTruthy())
}

const items = () => within(screen.getByRole('dialog')).getAllByRole('listitem')
const rowNames = () => items().map((li) => li.querySelector('.flex-1').firstChild.textContent)

beforeEach(() => { global.fetch = mockFetch() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('assign picker: ranked candidates (CANDIDATES.1)', () => {
  it("lists coaches in the server's order, each with its hours line, and no pay", async () => {
    await openAssignPicker()
    await waitFor(() => expect(rowNames()[0]).toBe('Here Coach'))
    expect(rowNames()).toEqual(['Here Coach', 'Rest Coach', 'Week Coach', 'Away Coach', 'Busy Coach', 'Leave Coach'])
    expect(items()[0].textContent).toContain('Here 7am–9am · 2h this week')
    expect(items()[1].textContent).toContain('1h 30m of 39h this week')
    expect(items()[3].textContent).toContain('0h of 30h this week')
    expect(items()[5].textContent).toContain('No shifts this week')
    expect(screen.getByRole('dialog').textContent).not.toMatch(/€|salary|hourly/i)
  })

  it('badges leave, a clash, unavailability, short rest and a long week, with titles', async () => {
    await openAssignPicker()
    const rest = await screen.findByText('9h 30m rest')
    expect(rest.closest('li').textContent).toMatch(/Rest Coach/)
    expect(rest.getAttribute('title')).toMatch(/Evening 8pm–9:30pm at Studio South on Tue 5 May/)
    expect(rest.getAttribute('title')).toMatch(/11 hours between working days/)
    expect(screen.getByText('48h 30m this week').getAttribute('title')).toMatch(/over the 48-hour limit/)
    expect(screen.getByText('Unavailable: 10am–11am').getAttribute('title')).toBe('Wednesdays, 10am–11am (School run)')
    expect(screen.getByText('clashes with 9:30am Morning HIIT').closest('li').textContent).toMatch(/Busy Coach/)
    expect(screen.getByText('on approved leave').getAttribute('title')).toBe('Holiday, Tue 5 May to Thu 7 May')
  })

  it('asks once, for this block, and no longer asks the working-time route', async () => {
    await openAssignPicker()
    await screen.findByText('9h 30m rest')
    const urls = global.fetch.mock.calls.map(([u]) => String(u))
    expect(urls.filter((u) => u.includes('/candidates'))).toEqual(['/api/schedule/blocks/b-target/candidates'])
    expect(urls.some((u) => u.includes('/api/schedule/working-time'))).toBe(false)
  })

  it('is advisory: the coach at the bottom can still be ticked', async () => {
    await openAssignPicker()
    const badge = await screen.findByText('on approved leave')
    const checkbox = badge.closest('label').querySelector('input[type="checkbox"]')
    expect(checkbox.disabled).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    expect(screen.getByText('Assign 1 coach')).toBeTruthy()
  })

  it('says what it could not check, and how many shifts had no times', async () => {
    global.fetch = mockFetch({ answer: { ...ANSWER, data: { ...ANSWER.data, checked: { ...ANSWER.data.checked, leave: false }, untimed: 1 } } })
    await openAssignPicker()
    expect(await screen.findByText('Could not check leave, so the order may be off.')).toBeTruthy()
    expect(screen.getByText('1 shift without times was not counted.')).toBeTruthy()
  })
})

describe('assign picker: before, or without, a ranked answer (CANDIDATES.1)', () => {
  it('shows the studio A–Z while ranking, then the ranked order', async () => {
    let answer
    const base = mockFetch()
    global.fetch = vi.fn((url, opts) => (String(url).includes('/candidates')
      ? new Promise((resolve) => { answer = resolve })
      : base(url, opts)))
    await openAssignPicker()
    expect(await screen.findByText(CANDIDATES_RANKING_NOTE)).toBeTruthy()
    expect(rowNames()).toEqual(['Away Coach', 'Busy Coach', 'Here Coach', 'Leave Coach', 'Rest Coach', 'Week Coach'])
    answer(okResponse(ANSWER))
    await waitFor(() => expect(rowNames()[0]).toBe('Here Coach'))
    expect(screen.queryByText(CANDIDATES_RANKING_NOTE)).toBeNull()
  })

  it('a failed ask says so and keeps the A–Z list, with no server badge', async () => {
    global.fetch = mockFetch({ answer: { success: false, error: 'boom' }, status: 500 })
    await openAssignPicker()
    expect(await screen.findByText(CANDIDATES_UNRANKED_NOTE)).toBeTruthy()
    expect(rowNames()[0]).toBe('Away Coach')
    expect(screen.queryByText('9h 30m rest')).toBeNull()
  })

  it('an answer it does not recognise (an older server) falls back without a word', async () => {
    global.fetch = mockFetch({ answer: { success: true, data: [] } })
    await openAssignPicker()
    await waitFor(() => expect(screen.queryByText(CANDIDATES_RANKING_NOTE)).toBeNull())
    expect(screen.queryByText(CANDIDATES_UNRANKED_NOTE)).toBeNull()
    expect(rowNames()[0]).toBe('Away Coach')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/ScheduleCalendar.candidates.test.jsx`
Expected: FAIL. The first test times out waiting for `Here Coach` to come first: the picker never asks `/candidates`, and its A–Z list starts with `Away Coach`.

- [ ] **Step 3: Implement**

In `src/components/ScheduleCalendar.jsx`:

1. After the WORKTIME.1 import (`import { hoursMinutesLabel, … } from '@shared/working-time'`, main line 66), add:

```js
// CANDIDATES.1 — the ranked picker list: words, badges and parsing (pure, unit-tested in shared/).
import {
  parseCandidatesAnswer, candidateBadges, candidateMeta, candidatesUncheckedNote,
  CANDIDATES_RANKING_NOTE, CANDIDATES_UNRANKED_NOTE,
} from '@shared/candidates'
```

2. After `const TOAST_TTL_MS = 6000` (main line 105), add:

```js
// CANDIDATES.1 — badge tones from shared/candidates candidateBadges(); the
// recipes the picker's badges already used (light cards need the -700 ramp).
const CANDIDATE_BADGE_CLASS = {
  bad: 'bg-red-500/15 text-red-700',
  warn: 'bg-amber-500/15 text-amber-700',
  muted: 'bg-slate-500/15 text-slate-700',
}
```

3. Replace the whole `AssignCoachModal` function and the comment block above it. The block to replace starts at the line `// ROSTERLOAD.1 — \`unavailableReason\`: the coach list failed to load, so the`, directly above `function AssignCoachModal(`. It ends at the function's closing `}`, directly above `// ROSTERLOAD.1 — \`unavailableReason\`: the template list failed to load, so`. Replace it with:

```jsx
// ROSTERLOAD.1 — `unavailableReason`: the coach list failed to load, so the
// picker says so and cannot submit, instead of showing an empty list that reads
// as "everyone is already assigned". `leaveMissing`: leave failed to load, so
// the on-leave badge cannot fire and the picker says that too.
// AVAIL.1 — `availability`: the studio's unavailability rules (flat, with
// profile_id), for the fallback badge. `availabilityMissing`: they failed to
// load, so the fallback says nobody can be flagged.
//
// CANDIDATES.1 — the list comes from GET /api/schedule/blocks/[id]/candidates:
// every rosterable coach of the block's studio, RANKED (free, on site and a
// lighter week first; on leave or already working then, at ANY studio of the
// organisation, last), with the badges and an hours line. One ask per open;
// it replaces WORKTIME.1's working-time ask, which read the same week of
// shifts for the same rule. Advisory everywhere: every row stays tickable.
// Until the answer lands, or when it fails or is not understood (an older
// server), the picker is the pre-CANDIDATES list: this studio's staff A–Z
// with the local clash, leave and availability badges.
function AssignCoachModal({
  block, staff, blocks, timeOff, unavailableReason = null, leaveMissing = false,
  availability = [], availabilityMissing = false, // (AVAIL.1b)
  onAssign, onClose, restoreFocusRef,
}) {
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const tmpl = block.shift_templates || {}
  const assignedIds = new Set(liveAssignments(block.shift_assignments).map((a) => a.profile_id))
  const available = staff.filter((s) => !assignedIds.has(s.id))
  const dayLabel = new Date(block.block_date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })
  const currentCount = liveAssignments(block.shift_assignments).length
  const slotsLeft = Math.max(0, (block.max_coaches || 0) - currentCount)

  // `pending` until the answer lands, so the A–Z list is labelled "Ranking
  // coaches…" rather than read as the ranking. No list (the coach list
  // failed) = nothing to ask, as before.
  const [ranking, setRanking] = useState({ answer: null, pending: true })
  useEffect(() => {
    if (unavailableReason) return undefined
    let cancelled = false
    async function loadCandidates() {
      let json = null
      try {
        const res = await fetch(`/api/schedule/blocks/${encodeURIComponent(block.id)}/candidates`)
        json = res.ok ? await res.json() : null
      } catch {
        json = null
      }
      if (cancelled) return
      setRanking({ answer: parseCandidatesAnswer(json), pending: false })
    }
    loadCandidates()
    return () => { cancelled = true }
  }, [block.id, unavailableReason])
  const ranked = ranking.answer?.ok ? ranking.answer : null
  const rankNote = ranked
    ? candidatesUncheckedNote(ranked.checked)
    : ranking.pending
      ? CANDIDATES_RANKING_NOTE
      : ranking.answer?.reason === 'failed' ? CANDIDATES_UNRANKED_NOTE : null

  function toggle(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleClick() {
    if (selectedIds.size === 0) return
    setSaving(true)
    await onAssign(Array.from(selectedIds))
    setSaving(false)
  }

  // (AVAIL.1b) — the fallback's per-coach rules, once per render. Not a hook.
  const rulesByProfile = new Map()
  for (const rule of availability || []) {
    if (!rule?.profile_id) continue
    if (!rulesByProfile.has(rule.profile_id)) rulesByProfile.set(rule.profile_id, [])
    rulesByProfile.get(rule.profile_id).push(rule)
  }

  // The server's list when it answered; otherwise the studio's staff A–Z.
  const rows = ranked
    ? ranked.candidates.map((c) => ({ id: c.profile_id, full_name: c.full_name || 'Coach', role: c.role, candidate: c }))
    : available.map((s) => ({ id: s.id, full_name: s.full_name, role: s.role, candidate: null }))

  const overCapacity = selectedIds.size > slotsLeft
  const submitLabel = saving
    ? 'Assigning…'
    : selectedIds.size === 0
      ? 'Assign coaches'
      : `Assign ${selectedIds.size} coach${selectedIds.size === 1 ? '' : 'es'}`

  return (
    // ROSTER-FIX.6b — dismissOnBackdrop goes false the moment a coach is
    // ticked: the operator has made a selection they would have to redo.
    <Modal open onClose={onClose} title="Assign coaches" dismissOnBackdrop={selectedIds.size === 0} restoreFocusRef={restoreFocusRef}>
      <div>
        {/* ROSTER-FIX.6b-8 — the light card recipe (surface + hairline); see
            the history of this block in git for why it is not bg-black/30. */}
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-3 mb-4 text-sm text-un1t-text">
          <div className="font-medium">{tmpl.name || 'Shift'} — {dayLabel}</div>
          <div className="text-un1t-subtle text-xs mt-1">
            {formatTime(block.start_time)}–{formatTime(block.end_time)} · {currentCount}/{block.max_coaches} assigned · {slotsLeft} slot{slotsLeft === 1 ? '' : 's'} open
          </div>
        </div>
        <div>
          <label className="block text-xs text-un1t-subtle mb-2">Pick one or more coaches</label>
          {/* The two load notes are about the LOCAL badges: a ranked answer
              carries its own leave and availability (and says if it could not). */}
          {!unavailableReason && !ranked && availabilityMissing && ( /* (AVAIL.1b) */
            <p className="mb-2 text-[11px] px-2 py-1.5 rounded bg-amber-500/10 text-amber-700">{AVAILABILITY_NOT_FLAGGED_MESSAGE}</p>
          )}
          {!unavailableReason && !ranked && leaveMissing && (
            <p className="mb-2 text-[11px] px-2 py-1.5 rounded bg-amber-500/10 text-amber-700">{LEAVE_NOT_FLAGGED_MESSAGE}</p>
          )}
          {!unavailableReason && rankNote && (
            <p className="mb-2 text-[11px] text-un1t-subtle" role="status">{rankNote}</p>
          )}
          {!unavailableReason && ranked?.untimed > 0 && (
            <p className="mb-2 text-[11px] text-un1t-subtle">{untimedShiftsLabel(ranked.untimed)}</p>
          )}
          {unavailableReason ? (
            <p className="text-[11px] px-2 py-1.5 rounded bg-amber-500/10 text-amber-700">{unavailableReason}</p>
          ) : rows.length === 0 ? (
            <p className="text-[11px] text-un1t-subtle">All staff already assigned to this slot.</p>
          ) : (
            <ul className="max-h-72 overflow-y-auto border border-un1t-border rounded-md divide-y divide-un1t-border/50">
              {rows.map((row) => {
                const checked = selectedIds.has(row.id)
                const c = row.candidate
                // ROSTER-FIX.6c — advisory, never a block: the row stays
                // tickable. The local badges only when there is no ranking.
                const local = c ? null : {
                  ...coachConflictsForBlock({ coachId: row.id, block, blocks, timeOff }),
                  unavailable: unavailableFor(rulesByProfile.get(row.id), block.block_date, block.start_time, block.end_time), // (AVAIL.1b)
                }
                const meta = c ? candidateMeta(c) : null
                return (
                  <li key={row.id}>
                    <label className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-un1t-border/30">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(row.id)}
                        className="accent-un1t-text"
                      />
                      <span className="text-sm text-un1t-text flex-1">
                        {row.full_name}
                        {c && candidateBadges(c).map((b) => (
                          <span
                            key={b.key}
                            className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${CANDIDATE_BADGE_CLASS[b.tone] || CANDIDATE_BADGE_CLASS.muted}`}
                            title={b.title}
                          >
                            {b.text}
                          </span>
                        ))}
                        {local?.onLeave && (
                          <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-700 whitespace-nowrap">
                            on approved leave
                          </span>
                        )}
                        {local?.unavailable && ( /* (AVAIL.1b) */
                          <span
                            className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-700 whitespace-nowrap"
                            title={local.unavailable.map((r) => (r.note ? `${describeRule(r)} (${r.note})` : describeRule(r))).join('; ')}
                          >
                            Unavailable: {unavailableSummary(local.unavailable)}
                          </span>
                        )}
                        {local?.clash && (
                          <span
                            className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 whitespace-nowrap"
                            title={`Already on ${local.clash.name}, ${local.clash.startTime}–${local.clash.endTime}`}
                          >
                            clashes with {local.clash.startTime} {local.clash.name}
                          </span>
                        )}
                        {meta && <span className="block text-[11px] text-un1t-subtle mt-0.5">{meta}</span>}
                      </span>
                      <span className="text-[10px] text-un1t-subtle">{row.role}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {overCapacity && (
          <p className="mt-2 text-[11px] text-amber-700">
            {selectedIds.size} selected but only {slotsLeft} slot{slotsLeft === 1 ? '' : 's'} left — the extras will be skipped.
          </p>
        )}
        <button
          type="button"
          onClick={handleClick}
          disabled={selectedIds.size === 0 || saving || rows.length === 0 || Boolean(unavailableReason)}
          className="w-full mt-4 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </Modal>
  )
}
```

AVAIL.1b already imports the `(AVAIL.1b)` names (`unavailableFor`, `unavailableSummary`, `describeRule`, `AVAILABILITY_NOT_FLAGGED_MESSAGE`); keep those imports. The ROSTER-FIX.6b-8 comment is shortened here, and its full reasoning stays in git history; keep main's full wording if review prefers it. The call site (`<AssignCoachModal … />`, main line 1404) does not change, because 1b already passes `availability` and `availabilityMissing`.

4. In `src/components/ScheduleCalendar.working-time.test.jsx`, the picker tests move to the new file. Remove, bottom-up so the line numbers stay valid:
   - Lines 220-225: the test `it('the picker says so too', …)`. Keep its describe's closing `})` at line 226.
   - Lines 140-211: from `async function openAssignPicker()` through the end of the `describe('assign picker: working time while the check is in flight (WORKTIME.1 review)', …)` block.
   - Line 84: the `if (u.includes('/api/schedule/working-time')) …` line.
   - Line 81: change it to `function mockFetch({ impact = { ...BASE_IMPACT, workingTime: WORKING_TIME } } = {}) {`.
   - Lines 48-60: `const PICKER_ANSWER = { … }`.
   - Lines 3-9, the header comment: replace them with:

```jsx
// WORKTIME.1 — the working-time advisory reaches the publish preview's list.
// (The assign picker's rest and week badges come from CANDIDATES.1's ranked
// answer now: src/components/ScheduleCalendar.candidates.test.jsx.) The rules
// are pinned in shared/working-time.test.js and the read in
// src/lib/working-time-data.test.js. This file is the wiring, and that it stays
// ADVISORY: Publish stays enabled. jsdom has no layout, so only text, roles and
// presence are asserted.
```

- [ ] **Step 4: Run it, expect PASS, plus every calendar test that opens the picker**

Run: `npx vitest run src/components/ScheduleCalendar.candidates.test.jsx src/components/ScheduleCalendar.working-time.test.jsx src/components/ScheduleCalendar.assign-conflicts.test.jsx src/components/ScheduleCalendar.availability.test.jsx src/components/ScheduleCalendar.partial-load.test.jsx src/components/ScheduleCalendar.a11y.test.jsx src/components/ScheduleCalendar.errors.test.jsx`
Expected: all pass, 8 of them in the new file.

- The older files' mocks answer the candidates URL with their block list, `{ success: true, data: [ …blocks ] }`. That is an array, not `{ candidates }`, so `parseCandidatesAnswer` reads it as unrecognised. They therefore get exactly the fallback they asserted before: local clash, leave and availability badges, and no note.
- `errors.test.jsx`'s block-read counters never open the picker, so the new URL (which contains `/schedule/blocks`) is never counted.

Then run `npm run lint` and `npm run check:guardrails`. No import becomes unused: `hoursMinutesLabel`, `MIN_REST_HOURS`, `MAX_WEEK_HOURS` and `REST_BETWEEN_LABEL` are still used by `PublishWorkingTime` (main lines 2289-2343).

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.candidates.test.jsx src/components/ScheduleCalendar.working-time.test.jsx
git commit -m "CANDIDATES.1 — web assign picker lists the ranked candidates, with badges and an hours line

One ask per open replaces WORKTIME.1's working-time ask (same rule, same
read). Badge words and titles unchanged. Until the answer lands, or if it
fails or is not understood, the pre-CANDIDATES A–Z list with the local
badges. Every row stays tickable.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Dashboard shift rows carry their block id (for the swap picker)

**Files:**
- Modify: `shared/dashboard-data.js` (lines 100 and 108) — **OTA path**
- Modify: `shared/dashboard-data.test.js` (the `fetchPersonalDashboardData — draft shifts (D1)` describe, main line 374)

- [ ] **Step 1: Write the failing test**

In `shared/dashboard-data.test.js`, inside `describe('fetchPersonalDashboardData — draft shifts (D1)', …)`, add this after the test `it('carries the block times and totals hours at them, not the template', …)`:

```js
  // CANDIDATES.1 — the "Ask a coach to cover" picker ranks colleagues for the
  // shift's BLOCK; the row's `id` is the assignment id, so the block id rides
  // along too, and the select asks for it.
  it('carries the block id, and asks for it', async () => {
    const selects = []
    const withId = { ...block('published'), id: 'blk-1' }
    const base = makePersonalDb({
      shift_assignments: {
        data: [{ id: 'a1', profile_id: 'p1', start_time_override: null, end_time_override: null, status: 'scheduled', shift_blocks: withId }],
        error: null,
      },
    })
    const db = {
      from(table) {
        const b = base.from(table)
        const sel = b.select
        b.select = function (cols) { selects.push([table, cols]); return sel.call(this) }
        return b
      },
    }
    const res = await fetchPersonalDashboardData(db, 'p1')
    expect(res.data.monthShifts[0]).toMatchObject({ id: 'a1', block_id: 'blk-1' })
    expect(selects.find(([t]) => t === 'shift_assignments')[1]).toMatch(/shift_blocks!inner \( id, block_date/)
  })
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/dashboard-data.test.js`
Expected: FAIL. The row has no `block_id`, and the select has no `id`.

- [ ] **Step 3: Implement**

In `shared/dashboard-data.js` `fetchDashboardShifts`:
- line 100: `shift_blocks!inner ( block_date, start_time, …` becomes `shift_blocks!inner ( id, block_date, start_time, …` (the rest of the line unchanged).
- after `      id: r.id,` (line 108), add:

```js
      // CANDIDATES.1 — the swap picker ranks colleagues for this BLOCK.
      block_id: block.id ?? null,
```

Also correct the doc comment above the function (lines 85-94). Its sentence "`id` is the assignment id — used only as a display key here (the swap flow reads shift ids from the schedule screen, not the dashboard)" is wrong today, because PersonalDashboard's swap flow posts `shift.id`. Replace it with: "`id` is the assignment id (the Today swap flow posts it as requester_shift_id); `block_id` is its block (CANDIDATES.1's colleague ranking)."

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run shared/dashboard-data.test.js mobile/lib/dashboard-api.test.js && npm run check:select-columns`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add shared/dashboard-data.js shared/dashboard-data.test.js
git commit -m "CANDIDATES.1 — dashboard shift rows carry block_id, for the swap picker's ranking

The coach's own shift, so nothing new is revealed. shared/: publishes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `getBlockCandidates` — the phone's wire

**Files:**
- Modify: `mobile/lib/schedule-api.js` (after `assignCoachToBlock`, main lines 188-196) — **OTA path**
- Modify: `mobile/lib/schedule-api.test.js` (export list lines 41-62; a test after `getLocationStaff`'s, line 248)

- [ ] **Step 1: Write the failing test**

In `mobile/lib/schedule-api.test.js`:
- in the sorted export list, insert `'getBlockCandidates',` between `'createTimeOffRequest',` and `'getLeavePreview',`.
- after the test `it('getLocationStaff pins the pay-free picker shape (ROSTER-FIX.2)', …)`, add:

```js
  it('getBlockCandidates GETs the ranked list for one block through api(), escaping the id (CANDIDATES.1)', () => {
    schedule.getBlockCandidates('b1', { locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/blocks/b1/candidates', { locationId: LOC }])
    api.mockClear()
    schedule.getBlockCandidates('a/b', { locationId: LOC })
    expect(lastCall()[0]).toBe('/api/schedule/blocks/a%2Fb/candidates')
  })
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run mobile/lib/schedule-api.test.js`
Expected: FAIL, from the export list mismatch and `getBlockCandidates is not a function`.

- [ ] **Step 3: Implement**

In `mobile/lib/schedule-api.js`, after the closing `}` of `assignCoachToBlock`, add:

```js
// CANDIDATES.1 — the ranked coaches for one block. A manager at the block's
// studio gets every fact; a coach live on the block (asking for cover) gets
// free/working only. The server decides; see
// src/app/api/schedule/blocks/[id]/candidates/route.js.
export function getBlockCandidates(blockId, { locationId } = {}) {
  return api(`/api/schedule/blocks/${encodeURIComponent(blockId)}/candidates`, { locationId })
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run mobile/lib/schedule-api.test.js && npm run check:mobile-lint`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/schedule-api.js mobile/lib/schedule-api.test.js
git commit -m "CANDIDATES.1 — getBlockCandidates: the phone asks through api()

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `mobile/lib/candidates-view.js` — the sheet's decisions (pure)

**Files:**
- Create: `mobile/lib/candidates-view.js` — **OTA path**
- Create: `mobile/lib/candidates-view.test.js`

There is no React Native component runner, so every decision the sheet makes lives here (the `mobile/lib` rule from memory `phone-mail-reader`).

- [ ] **Step 1: Write the failing test**

Create `mobile/lib/candidates-view.test.js`:

```js
// CANDIDATES.1 — what the phone's coach pickers show. No RN runner: every
// decision the sheet makes is here.

import { describe, it, expect } from 'vitest'
import {
  NO_CANDIDATES, candidatesStarted, candidatesSettled, candidatesFor, candidatePickerView, CANDIDATE_TONE_CLASS,
} from './candidates-view'
import { CANDIDATES_RANKING_NOTE, CANDIDATES_UNRANKED_NOTE } from 'shared/candidates'

const LOC = 'loc1'
const block = { id: 'b1', shift_assignments: [{ profile_id: 'on', status: 'scheduled' }] }
const staff = [
  { id: 'zed', full_name: 'Zed', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'amy', full_name: 'Amy', role: 'manager', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'on', full_name: 'On Already', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
]
const RANKED = { success: true, data: { audience: 'manager', checked: { shifts: true, leave: false }, untimed: 0, candidates: [
  { profile_id: 'amy', full_name: 'Amy', role: 'manager', rank: 2, tier: 'blocked', reason: 'Working 9am–11am Class' },
  { profile_id: 'zed', full_name: 'Zed', role: 'staff', rank: 1, tier: 'ready', reason: 'Free · 4h of 39h this week' },
] } }

describe('the request lifecycle', () => {
  it('only the answer to the CURRENT request for the CURRENT block lands', () => {
    const started = candidatesStarted('b1', 1)
    expect(started).toEqual({ blockId: 'b1', requestId: 1, answer: null, pending: true })
    expect(candidatesFor(started, 'b1')).toEqual({ candidates: null, candidatesPending: true })

    const settled = candidatesSettled(started, { blockId: 'b1', requestId: 1, res: RANKED })
    expect(settled.pending).toBe(false)
    expect(settled.answer).toMatchObject({ ok: true, audience: 'manager' })
    expect(candidatesFor(settled, 'b1').candidates.candidates.map((c) => c.profile_id)).toEqual(['zed', 'amy'])

    // A slower, older answer (request 1) after the sheet re-opened (request 2).
    const reopened = candidatesStarted('b1', 2)
    expect(candidatesSettled(reopened, { blockId: 'b1', requestId: 1, res: RANKED })).toBe(reopened)
    // An answer for another block.
    expect(candidatesSettled(started, { blockId: 'b9', requestId: 1, res: RANKED })).toBe(started)
    // Asked about another block, or with nothing open.
    expect(candidatesFor(settled, 'b9')).toEqual({ candidates: null, candidatesPending: false })
    expect(candidatesFor(NO_CANDIDATES, null)).toEqual({ candidates: null, candidatesPending: false })
  })

  it('a transport envelope or a server error settles as failed', () => {
    const s = candidatesSettled(candidatesStarted('b1', 1), { blockId: 'b1', requestId: 1, res: { success: false, transport: true, error: 'Network error' } })
    expect(s.answer).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('candidatePickerView', () => {
  const answerOf = (res) => candidatesSettled(candidatesStarted('b1', 1), { blockId: 'b1', requestId: 1, res }).answer

  it('ranked: the server order, the reason line and its tone; what was not checked', () => {
    const view = candidatePickerView({ answer: answerOf(RANKED), staff: null, block, locationId: LOC, error: 'The coach list could not be loaded.' })
    expect(view.ranked).toBe(true)
    expect(view.rows).toEqual([
      { id: 'zed', full_name: 'Zed', role: 'staff', reason: 'Free · 4h of 39h this week', tone: 'good' },
      { id: 'amy', full_name: 'Amy', role: 'manager', reason: 'Working 9am–11am Class', tone: 'bad' },
    ])
    expect(view.note).toBe('Could not check leave, so the order may be off.')
    // A ranked answer rescues a failed staff list.
    expect(view.error).toBeNull()
    expect(view.waiting).toBe(false)
  })

  it('a colleague sees free or working', () => {
    const res = { success: true, data: { audience: 'colleague', checked: { shifts: true }, candidates: [
      { profile_id: 'zed', full_name: 'Zed', role: 'staff', rank: 1, tier: 'ready', reason: 'Free then', free: true },
    ] } }
    expect(candidatePickerView({ answer: answerOf(res), staff, block, locationId: LOC }).rows[0])
      .toEqual({ id: 'zed', full_name: 'Zed', role: 'staff', reason: 'Free then', tone: 'good' })
  })

  it('while ranking: the studio A–Z (never the coach already on it), labelled', () => {
    const view = candidatePickerView({ answer: null, pending: true, staff, block, locationId: LOC })
    expect(view.rows.map((r) => r.id)).toEqual(['amy', 'zed'])
    expect(view.rows[0]).toEqual({ id: 'amy', full_name: 'Amy', role: 'manager', reason: null, tone: null })
    expect(view.note).toBe(CANDIDATES_RANKING_NOTE)
    expect(view.waiting).toBe(false)
  })

  it('failed: A–Z with the note; unrecognised: A–Z in silence', () => {
    expect(candidatePickerView({ answer: answerOf({ success: false }), staff, block, locationId: LOC }).note).toBe(CANDIDATES_UNRANKED_NOTE)
    expect(candidatePickerView({ answer: answerOf({ success: true, data: [] }), staff, block, locationId: LOC }).note).toBeNull()
    expect(candidatePickerView({ answer: null, staff, block, locationId: LOC }).note).toBeNull()
  })

  it('waits (spinner) while nothing can be shown yet, and passes a staff error through only without a ranking', () => {
    expect(candidatePickerView({ answer: null, pending: true, staff: null, block, locationId: LOC }).waiting).toBe(true)
    expect(candidatePickerView({ answer: null, loading: true, staff: null, block, locationId: LOC }).waiting).toBe(true)
    const failed = candidatePickerView({ answer: answerOf({ success: false }), staff: null, block, locationId: LOC, error: 'boom' })
    expect(failed).toMatchObject({ waiting: false, error: 'boom', rows: [] })
  })

  it('tones map to readable -700 text on the light theme', () => {
    expect(CANDIDATE_TONE_CLASS).toEqual({ good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-700', muted: 'text-un1t-subtle' })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run mobile/lib/candidates-view.test.js`
Expected: FAIL, `Failed to resolve import "./candidates-view"`.

- [ ] **Step 3: Implement**

Create `mobile/lib/candidates-view.js`:

```js
// CANDIDATES.1 — what the phone's coach pickers show: Manage mode's "Add
// coach" sheet and Today's "Ask a coach to cover" sheet (both
// CoachPickerSheet). Pure, tested in candidates-view.test.js: there is no
// React Native component runner, so every decision the sheet makes is here.
//
// The ranked answer is GET /api/schedule/blocks/[id]/candidates (via
// getBlockCandidates). Until it lands, or when it fails or is not understood,
// the sheet shows what it showed before CANDIDATES.1: the studio's staff A–Z
// (filterAssignableCoaches), labelled so it is not read as a ranking. Every
// row stays pickable; nothing here blocks.

import {
  parseCandidatesAnswer, candidateTone, candidatesUncheckedNote,
  CANDIDATES_RANKING_NOTE, CANDIDATES_UNRANKED_NOTE,
} from 'shared/candidates'
import { filterAssignableCoaches } from './schedule-manage'

export const CANDIDATE_TONE_CLASS = Object.freeze({
  good: 'text-emerald-700',
  warn: 'text-amber-700',
  bad: 'text-red-700',
  muted: 'text-un1t-subtle',
})

export const NO_CANDIDATES = Object.freeze({ blockId: null, requestId: 0, answer: null, pending: false })

/** A new ask for `blockId`; `requestId` is the caller's counter. */
export function candidatesStarted(blockId, requestId) {
  return { blockId: blockId ?? null, requestId, answer: null, pending: Boolean(blockId) }
}

/**
 * Land an api() result, but only for the request still current: a slow older
 * answer (the sheet re-opened) or one for another block leaves state alone.
 */
export function candidatesSettled(state, { blockId, requestId, res }) {
  if (!state || state.blockId !== blockId || state.requestId !== requestId) return state
  return { ...state, answer: parseCandidatesAnswer(res), pending: false }
}

/** The sheet's props for the block it is open on. */
export function candidatesFor(state, blockId) {
  if (!blockId || state?.blockId !== blockId) return { candidates: null, candidatesPending: false }
  return { candidates: state.answer, candidatesPending: Boolean(state.pending) }
}

/**
 * @returns {{ ranked: boolean, note: string|null, waiting: boolean, error: string|null,
 *   rows: Array<{ id, full_name, role, reason: string|null, tone: string|null }> }}
 */
export function candidatePickerView({ answer = null, pending = false, staff, block, locationId, loading = false, error = null }) {
  if (answer?.ok) {
    return {
      ranked: true,
      note: candidatesUncheckedNote(answer.checked),
      waiting: false,
      error: null,
      rows: answer.candidates.map((c) => ({
        id: c.profile_id,
        full_name: c.full_name || 'Coach',
        role: c.role ?? null,
        reason: c.reason ?? null,
        tone: candidateTone(c),
      })),
    }
  }
  const rows = filterAssignableCoaches(staff || [], block, locationId)
    .map((s) => ({ id: s.id, full_name: s.full_name, role: s.role ?? null, reason: null, tone: null }))
  return {
    ranked: false,
    note: pending ? CANDIDATES_RANKING_NOTE : answer?.reason === 'failed' ? CANDIDATES_UNRANKED_NOTE : null,
    waiting: (loading && staff == null) || (pending && rows.length === 0),
    error: error || null,
    rows,
  }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run mobile/lib/candidates-view.test.js mobile/lib/schedule-manage.test.js && npm run check:mobile-imports && npm run check:mobile-lint`
Expected: all pass. `check:mobile-imports` resolves every name imported from `shared/candidates`.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/candidates-view.js mobile/lib/candidates-view.test.js
git commit -m "CANDIDATES.1 — mobile/lib/candidates-view.js: the picker's request lifecycle and view model

Only the current request for the current block lands. Ranked rows carry a
reason and a tone; without a ranking, the old A–Z list, labelled.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Wire the two phone pickers

**Files (all OTA paths):**
- Modify: `mobile/components/schedule/CoachPickerSheet.jsx` (whole file)
- Modify: `mobile/components/schedule/ManageMode.jsx`
- Modify: `mobile/components/dashboard/PersonalDashboard.jsx`

No component runner exists; Task 10 pins the decisions. This task is wiring. It is checked by `check:mobile-lint`, `check:mobile-imports` and the handset pass in the PR.

- [ ] **Step 1: Replace `mobile/components/schedule/CoachPickerSheet.jsx`**

```jsx
// Bottom-sheet picker of coaches: "Add coach" for a manager's block (the default), or "Ask a coach to cover" for a coach's targeted swap (title / emptyText props). Pure-presentational:
// receives the already-fetched staff array and, CANDIDATES.1, the ranked
// answer for the block; every decision is candidatePickerView's
// (mobile/lib/candidates-view.js, tested). Every row stays pickable.
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { initials } from '../../lib/schedule-team'
import { candidatePickerView, CANDIDATE_TONE_CLASS } from '../../lib/candidates-view'

const EMPTY_VIEW = { ranked: false, note: null, waiting: false, error: null, rows: [] }

// onDismiss (optional, iOS only — Android never fires it): called once the
// sheet has FINISHED animating out. A caller that opens another Modal after a
// pick must wait for it; iOS refuses a present while this one is dismissing.
//
// error / onRetry (optional) — MANAGEMODE.1: the coach list failed to load.
// Shown instead of emptyText, which would tell the manager there are no
// coaches when the truth is the list never arrived. A ranked answer
// (CANDIDATES.1) replaces the list, so it also replaces that error.
//
// candidates / candidatesPending (optional) — CANDIDATES.1: the parsed
// answer of GET /api/schedule/blocks/[id]/candidates for THIS block, and
// whether it is still in flight (candidatesFor in lib/candidates-view.js).
export default function CoachPickerSheet({
  visible, block, locationId, staff, loading, error, onRetry, candidates = null, candidatesPending = false,
  onPick, onClose, onDismiss, title = 'Add coach', emptyText = 'No available coaches to add.',
}) {
  const view = block
    ? candidatePickerView({ answer: candidates, pending: candidatesPending, staff, block, locationId, loading, error })
    : EMPTY_VIEW
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} onDismiss={onDismiss}>
      <View className="flex-1 justify-end bg-black/50">
        <Pressable className="flex-1" onPress={onClose} />
        <View className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl p-5" style={{ maxHeight: '70%' }}>
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-un1t-text">{title}{block?.shift_templates?.name ? ` · ${block.shift_templates.name}` : ''}</Text>
            <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color="#94A3B8" /></Pressable>
          </View>
          {view.waiting ? (
            <View className="py-8 items-center"><ActivityIndicator /></View>
          ) : view.error ? (
            <View className="py-6 items-center">
              <Text className="text-sm text-red-500 text-center">{view.error}</Text>
              {onRetry ? (
                <Pressable onPress={onRetry} hitSlop={8} className="mt-3 active:opacity-60">
                  <Text className="text-sm font-semibold text-un1t-text">Try again</Text>
                </Pressable>
              ) : null}
            </View>
          ) : view.rows.length === 0 ? (
            <Text className="text-sm text-un1t-subtle py-6 text-center">{emptyText}</Text>
          ) : (
            <>
              {view.note ? <Text className="text-[11px] text-un1t-subtle mb-2">{view.note}</Text> : null}
              <ScrollView>
                {view.rows.map((c) => (
                  <Pressable key={c.id} onPress={() => onPick(c)}
                    className="flex-row items-center py-3 border-b border-un1t-border active:opacity-60">
                    <View className="w-9 h-9 rounded-full bg-un1t-border items-center justify-center mr-3">
                      <Text className="text-sm font-semibold text-un1t-text">{initials(c.full_name)}</Text>
                    </View>
                    <View className="flex-1 mr-2">
                      <Text className="text-base text-un1t-text" numberOfLines={1}>{c.full_name}</Text>
                      {c.reason ? (
                        <Text className={`text-xs mt-0.5 ${CANDIDATE_TONE_CLASS[c.tone] || CANDIDATE_TONE_CLASS.muted}`} numberOfLines={2}>{c.reason}</Text>
                      ) : null}
                    </View>
                    {c.role ? <Text className="text-[11px] uppercase text-un1t-subtle">{String(c.role).replace(/_/g, ' ')}</Text> : null}
                  </Pressable>
                ))}
              </ScrollView>
            </>
          )}
        </View>
      </View>
    </Modal>
  )
}
```

`onPick(c)` now receives a row, `{ id, full_name, role, reason, tone }`. Both callers read only `coach.id` and `coach.full_name`: `ManageMode.jsx` `pickCoach` (lines 164-188), and `PersonalDashboard.jsx` `pickSwapCoach` → `swapConfirmCopy` / `createSwapRequest` (lines 656-690). Before merging, check `mobile/lib/swap-cards.js` `swapConfirmCopy` / `swapPostedCopy` for any other coach key: `grep -n "coach\." mobile/lib/swap-cards.js`.

- [ ] **Step 2: Wire `mobile/components/schedule/ManageMode.jsx`**

1. Imports (lines 14-18): add `getBlockCandidates` to the `../../lib/schedule-api` import, and add:

```js
import { NO_CANDIDATES, candidatesStarted, candidatesSettled, candidatesFor } from '../../lib/candidates-view'
```

2. After `const [pickerBlock, setPickerBlock] = useState(null)` (line 35), add:

```js
  // CANDIDATES.1 — the ranked list for the block the picker is open on. One
  // ask per open; only the newest ask for the open block lands.
  const [candidates, setCandidates] = useState(NO_CANDIDATES)
  const candidatesSeq = useRef(0)
```

3. In the location-change effect (lines 147-151), add these as its first two lines:

```js
    candidatesSeq.current += 1
    setCandidates(NO_CANDIDATES)
```

4. Replace `openPicker` (lines 159-162) with:

```js
  async function loadCandidates(block) {
    const requestId = ++candidatesSeq.current
    setCandidates(candidatesStarted(block.id, requestId))
    let res
    try {
      res = await getBlockCandidates(block.id, { locationId })
    } catch (e) {
      res = { success: false, error: e?.message }
    }
    // A studio the manager has since left: its answer is not for this screen.
    if (locationId !== currentLocation.current) return
    setCandidates((prev) => candidatesSettled(prev, { blockId: block.id, requestId, res }))
  }

  async function openPicker(block) {
    setPickerBlock(block)
    loadCandidates(block) // not awaited: the staff list below is the fallback
    if (staff === null && !staffLoading) await loadStaff()
  }
```

5. The sheet (lines 241-243) becomes:

```jsx
      <CoachPickerSheet visible={!!pickerBlock} block={pickerBlock} locationId={locationId}
        staff={staff} loading={staffLoading} error={staff === null ? staffError : null} onRetry={loadStaff}
        {...candidatesFor(candidates, pickerBlock?.id)}
        onPick={pickCoach} onClose={() => setPickerBlock(null)} />
```

- [ ] **Step 3: Wire `mobile/components/dashboard/PersonalDashboard.jsx`**

1. Imports: add `getBlockCandidates,` to the `../../lib/schedule-api` import (lines 25-30). After the `CoachPickerSheet` import (line 33), add:

```js
// CANDIDATES.1 — colleagues ranked free-first for the shift being covered.
import { NO_CANDIDATES, candidatesStarted, candidatesSettled, candidatesFor } from '../../lib/candidates-view'
```

2. After `const [swapStaffLoading, setSwapStaffLoading] = useState(false)` (line 425), add:

```js
  // CANDIDATES.1 — the ranked colleagues for the shift the picker is open on
  // (the server gives a coach free/working only).
  const [swapCandidates, setSwapCandidates] = useState(NO_CANDIDATES)
  const swapCandidatesSeq = useRef(0)
```

3. Above `async function openSwapPicker(shift) {` (line 641), add:

```js
  async function loadSwapCandidates(shift) {
    const blockId = shift?.block_id
    const requestId = ++swapCandidatesSeq.current
    if (!blockId) { setSwapCandidates(NO_CANDIDATES); return } // an older row: the A–Z list
    setSwapCandidates(candidatesStarted(blockId, requestId))
    let res
    try {
      res = await getBlockCandidates(blockId, { locationId: shift.location_id || activeLocation?.id })
    } catch (e) {
      res = { success: false, error: e?.message }
    }
    setSwapCandidates((prev) => candidatesSettled(prev, { blockId, requestId, res }))
  }
```

   Then, in `openSwapPicker`, add `loadSwapCandidates(shift)` directly after `setSwapPickerShift(shift)` (line 645).

4. The sheet (lines 1090-1101): add one prop line after `loading={swapStaffLoading}`:

```jsx
        {...candidatesFor(swapCandidates, swapPickerShift?.block_id)}
```

- [ ] **Step 4: Verify**

Run: `npm run check:mobile-lint && npm run check:mobile-imports && npm run check:ota-paths && npx vitest run mobile/lib tests/ota-trigger-paths.test.js`
Expected: all pass. `check:ota-paths` is clean because there is no new top-level entry under `mobile/`. All three components sit inside `mobile/components/**`, which **is a publish trigger**.

- [ ] **Step 5: Commit**

```bash
git add mobile/components/schedule/CoachPickerSheet.jsx mobile/components/schedule/ManageMode.jsx mobile/components/dashboard/PersonalDashboard.jsx
git commit -m "CANDIDATES.1 — phone pickers show the ranked list and a reason line

Manage mode's Add coach (manager: every fact) and Today's Ask a coach to
cover (the coach: free/working only). One ask per open; the A–Z staff list
is the fallback, labelled. Phone update on merge.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

- [ ] **Focused tests, both timezones:**

```bash
for tz in Europe/Dublin America/Los_Angeles; do
  TZ=$tz npx vitest run shared/candidates.test.js src/lib/candidates-data.test.js 'src/app/api/schedule/blocks/[id]/candidates/route.test.js' src/lib/working-time-data.test.js src/components/ScheduleCalendar.candidates.test.jsx mobile/lib/candidates-view.test.js || break
done
npx vitest run tests/shared-pair-sync.test.js tests/ota-trigger-paths.test.js tests/staff-tombstone-readers.test.js tests/rtl-cleanup-after-each.test.js tests/test-timeout-budgets.test.js tests/fake-timer-act.test.js src/lib/openapi.test.js shared/dashboard-data.test.js mobile/lib/schedule-api.test.js src/app/api/schedule/working-time/route.test.js
```

Expected: all pass, in both timezones.

- [ ] **CI mirror (all twelve), then the build:**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
npm run build
```

Expected: every command exits 0. `npm run build` is the only check that proves two things: `@shared/candidates` resolves from the route, the lib and the client component, and the shared file's relative imports (`./working-time.js`, `./availability.js`, `./time-off.js`) resolve under Turbopack. On the 8GB machine, run the build with nothing else running. If it is too slow, push and let the required **Next build** check be the gate. Never skip both.

- [ ] **Rebase** onto `origin/main` right before opening, because AVAIL.2 and BLOCKEDIT.1 touch the same files. Re-run the focused tests after any conflict. A conflict in `mobile/lib/schedule-api.test.js`'s export list: keep both names, sorted.

- [ ] **Open the PR.** Title: `CANDIDATES.1 — ranked coaches wherever a coach is picked: free, leave, availability, on site, week hours, rest (web and phone)`. The body must state:
  - **No migration.** It depends on mig 630 (AVAIL.1a) being applied, which happened before AVAIL.1a merged.
  - **The merge publishes a phone update.** The paths: `shared/candidates.js`, `shared/dashboard-data.js`, `mobile/lib/candidates-view.js`, `mobile/lib/schedule-api.js`, `mobile/components/schedule/CoachPickerSheet.jsx`, `mobile/components/schedule/ManageMode.jsx`, `mobile/components/dashboard/PersonalDashboard.jsx`. If AVAIL.2 or any other OTA merged just before, its EAS Update run must be green first.
  - One endpoint, `GET /api/schedule/blocks/[id]/candidates`, with two audiences:
    - a manager at the block's studio gets every fact;
    - a coach live on the block gets free/working only, ranked on that alone.

    An outsider gets 404; anyone else gets 403.
  - The ranking rule, one line each: tier; on site; under-contract share, then fewest hours; name. Nothing blocks and every row stays pickable. Tests pin that on the web, and every phone row is a Pressable.
  - Hours only. Contracted hours come from `profile_compensation.contracted_hours_per_week`, selected BY NAME, for employees only, and returned to managers only. No rate, salary or cost is selected anywhere, and tests assert it.
  - Query budget: 9 fixed reads for a manager, 5 for a colleague, paged wherever rows can pass 1,000.
  - The web picker's WORKTIME.1 ask is replaced by this answer, with the same badge words. `GET /api/schedule/working-time` stays one deploy for open tabs; deleting it is a follow-up.
  - AVAIL.1b's client-side badge now lives only in the fallback path.
  - **Handset checks owed (Richard), after the EAS run is green:**
    1. As a manager: Schedule → Manage → a day with a shift → **Add coach**. Expect "Ranking coaches…" briefly, then the ranked list with a coloured reason line. Pick a coach; the capacity "Add anyway" alert still works.
    2. The same, switching to airplane mode after the sheet opens. Expect "Coaches could not be ranked, so they are listed A–Z." and the A–Z list; picking works once back online.
    3. As a coach: Today → tap an upcoming published shift → **Ask a coach to cover…**. Colleagues say "Free then" or "Working then", with no leave, hours or availability wording. Pick one; the confirm sheet opens (on iOS, after the picker finishes closing).
    4. A coach at both studios with a shift at the other one at the same time shows "Working … at <other studio>" to a manager, and sorts to the bottom.
  - Web checks on the Vercel PREVIEW. These are GET-only against prod data (local dev has no database). **Assign nobody.**
    - As a Stillorgan manager, open a shift → **Add coach**: the ranked list, badges and hours lines.
    - `GET /api/schedule/blocks/<a Hatch Street block id>/candidates` as a Stillorgan-only manager: 404.
    - The same URL for a Stillorgan block, as a coach not on it: 403.
    - As the coach on it: `audience: 'colleague'` and no other fields.
  - End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **CHANGELOG.** After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md` (never edit another row), then commit and push:

```
| #<PR> | CANDIDATES.1 — ranked coaches wherever a coach is picked: free, leave, availability, on site, week hours, rest (web and phone) | 2026-09-2x. Wave 2 PR 19. No migration (needs mig 630); **OTA** (`shared/candidates.js`, `shared/dashboard-data.js`, `mobile/lib/candidates-view.js`, `mobile/lib/schedule-api.js`, `CoachPickerSheet`, `ManageMode`, `PersonalDashboard`). New `GET /api/schedule/blocks/[id]/candidates`: every rosterable member of the block's studio not live on it, ranked by tier (ready → advisory: <11h rest / >48h, employees → unavailable: AVAIL rule → blocked: approved leave or already working then at ANY studio of the organisation), then on site that day, then an employee under contract by share, then fewest hours Mon–Sun, then name. Effective windows as real Dublin instants (overrides count; touching ends are on site). Manager at the studio gets every fact incl. employees' contracted hours (`profile_compensation.contracted_hours_per_week` by name only); a coach live on the block (swap) gets free/working only, ranked on that alone; 404 outsider, 403 otherwise. 9 reads (manager) / 5 (colleague), paged. Unread facets null + `checked` flags, said in the picker. Pure rules `shared/candidates.js`; reads `src/lib/candidates-data.js` + `readOrgShiftRows` extracted from WORKTIME's reader. Web picker: ranked list + badges (same words) + hours line, replaces WORKTIME's per-open ask; A–Z local-badge fallback while pending/failed/older server (AVAIL.1b's badge lives there now). Phone: Manage "Add coach" and Today "Ask a coach to cover" show rank order + a reason line; dashboard shift rows gain `block_id`. Advisory only. Hours only, never pay. |
```

- [ ] **After merge:** check that the EAS Update run for the merge went green before the next phone update merges. Then do the handset checks above, or hand them to Richard.

---

### Review notes / open questions

1. **A coach sees colleagues ranked "free then / working then" (REVIEW).** The brief said "manager-only". The targeted-swap picker is a coach's screen, though, so a manager-only endpoint could never rank it. The colleague projection reveals one bit per colleague: working or not at that time, at any studio of the organisation. That includes the other studio, whose roster a coach cannot otherwise see. The alternatives:
   - (a) Keep the swap picker A–Z: drop Task 11 step 3 and Task 8.
   - (b) Also say "Off" for leave or unavailability. This reveals more.
   - (c) Report free/working at THIS studio only.

   Recommended: ship as planned.
2. **Head coaches see colleagues' contracted hours (REVIEW).** `MANAGER_ROLES` includes `head_coach`. Mig 152 put contracted hours in the owner/master-only pay table, and program default 4 shows hours (not pay) to managers. If contracted hours should go to owners and managers only, the route can pass a narrower role check for `contract` (one condition in `loadBlockCandidates`). The ranking still works without contracted hours: it falls back to fewest hours.
3. **"Fewer hours relative to contract" puts employees under contract before contractors (REVIEW).** An employee's contracted hours are paid whether they are rostered or not, so filling them first is the cheaper roster. The rule never reads a rate to decide that. The literal alternative, one ratio for everyone, would need a notional contract for contractors, which does not exist. If Richard prefers plain "fewest hours this week", change `loadKey` to always return `[1, week]` (one line; the tests adjust).
4. **On site outranks a lighter week.** This follows the brief ("prefer on-site, then fewer week hours"). A coach already at the studio for a 07:00 class is preferred for 10:00 even with more hours, which lengthens their day. The rest and 48h advisories still catch the extreme cases.
5. **Pending leave is ignored.** Only approved leave ranks someone down, the same as every other schedule surface, so a coach with a pending holiday request ranks as free. Adding it as an advisory is cheap once someone asks.
6. **Drafts at the other studio count as "working then".** This is WORKTIME's `COUNT_UNPUBLISHED_ELSEWHERE`, shared through `readOrgShiftRows`, and it is consistent with `doubleBookings` and the 48h check.
7. **The web list can reorder under the cursor.** The A–Z fallback shows while ranking (typically a few hundred ms), then the ranked order replaces it. Ticks are keyed by id, so a ticked coach stays ticked, but a click landing exactly as the list reorders could hit a different row. The alternative, a spinner until the answer lands, was rejected: a failed or slow answer would then hide the list.
8. **`GET /api/schedule/working-time` has no caller after this merges.** The web picker was its only caller. It stays for tabs open across the deploy. **Follow-up:** delete the route, its test and its OpenAPI entry one release later.
9. **The availability read costs one extra query.** `readStudioAvailability` re-reads the studio's members. It is reused anyway so that one function owns `staff_unavailability`'s shape (AVAIL.1a). A direct read would save that one query.
10. **The web fallback and the server disagree on `active: null`.** The web's `locationStaff` needs `s.active` to be truthy; the server uses `active IS NOT FALSE` (mig 626). So a NULL-active coach appears in the ranked list but not in the A–Z fallback. This is harmless, and the server's rule is the right one.
11. **Surfaces not covered:** the web bulk-assign bar (select mode), copy week/month, and REPLACE.1's "Replace coach" (PR 20 reuses this endpoint). QUALS.1 (33) adds a qualification advisory as another tier input.
12. **Past blocks** are ranked like any other. The picker already opens on them, and nothing here makes that worse.
13. **`/api/staff?fields=picker` is still fetched** on both platforms as the fallback list. Dropping it when the ranked answer succeeds would save a request per mount, but the fallback would then have nothing to show on a failed ranking.
