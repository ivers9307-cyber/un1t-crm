## PR CONTRACTVIS.1 — a colleague's contracted hours go to owners, managers and masters at their studio, and nobody else

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A colleague's `contracted_hours_per_week` leaves the server only for a **master**, or for an **owner or manager at a studio that colleague works at**. Anything calculated from it goes to the same people: the Weekly hours notice, the FTE utilisation bars and the Staff Utilisation report. Head coaches and staff stop receiving it on every path that sends it today (the API, the web roster, the reports and direct browser reads). **Everyone still sees their own.** Owners, managers and masters see everything they see today.

**Why:** Index row B2, **APPROVED by Richard on 27 Sep**: "colleagues' contracted hours to owner/manager/master only, everywhere". CANDIDATES.1 (`src/app/api/schedule/blocks/[id]/candidates/route.js:72`, `withContract`) and GRID.1 (`src/app/api/schedule/grid/route.js:68`, `showContract`) already apply this rule. The staff list, the week-cost panel, the roster's FTE bars and the utilisation report never did. `src/lib/staff.js:20-24` justified that on the grounds that contracted hours are "not pay data" and that "every role has always received them". Richard's decision overrides that reasoning.

**Architecture:** One per-row rule in the staff read service (`src/lib/staff.js`): **"the caller manages this person"**, meaning a master, or ADMIN_ROLES at a location the person is linked to (among the locations in scope). It replaces the active-role `isAdmin` check. Both slim shapes lose the column. The picker gets an opt-in, `include=contract`, which the server honours only for rows the caller manages (and for the caller's own row). Every screen judges at its own studio: `week-cost` answers `contract_visible: false` with no rows below ADMIN_ROLES at `location_id`, as `grid` already does, and the calendar requests contracts only when the viewer is an admin at the studio on screen. The utilisation report joins `staff_cost` in the admin-only report set, so the existing gates on generate, list, schedule, email and the UI tile all apply to it. One migration narrows the `generated_reports` RLS so that a head coach's browser client cannot read those two report types directly. A tripwire test lists every file that names the column, with a reviewed reason for each.

**Tech Stack:** Next.js 16 App Router route handlers and client components, Supabase (project `iyvtbjjxdggiadzwwvdj`, migrations via MCP), Vitest (+ Testing Library, jsdom for components).

**Ships:** web deploy plus **one migration** (the `generated_reports` RLS, Task 9; the next free number, 643 at the time of writing). **No OTA:** nothing under `mobile/` or `shared/` changes. The phone never renders a contract (checked below), and the phone's API responses shrink on the server alone. **Size: M.**

**Worktree:** branch `contractvis-1` off a fresh `origin/main`, in its own fresh worktree (never a shared one). If `node_modules` is absent, run `npm ci` once. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the gate (8GB machine).

---

### What was found (verified against `origin/main` at `28d02e59`, #1779)

**Every place a colleague's contracted hours reach a caller who is not an owner, manager or master at that colleague's studio:**

| # | Where (file:line) | Who receives it today | Rendered? | Change |
|---|---|---|---|---|
| L1 | `STAFF_PUBLIC_FIELDS` (`src/lib/staff.js:11-12`), used by `listStaffForUser`/`getStaffForUser` when `ADMIN_ROLES.includes(user.role)` is false (`:59`, `:81`) | **Every head coach and staff member** (judged by the ACTIVE studio's role), for every colleague at every studio they hold. Callers: `GET /api/staff` and `GET /api/staff/[id]`. On the phone: the staff directory (`mobile/app/(staff)/staff/index.jsx:39`, `staff/[id].jsx:47`) and the new-task assignee list (`mobile/app/(staff)/tasks/new.jsx:63`), all through `shared/sdk/staff.js:6-7` | No (the phone shows name, role, employment; no screen reads the column) | Column dropped (D2); own row keeps it (D4) |
| L2 | `STAFF_PICKER_FIELDS` (`src/lib/staff.js:25-26`), used for `?fields=picker` for **every role, master included** (`:29-31`) | **Everyone who opens a picker.** Web: the roster calendar (`src/components/schedule/useScheduleData.js:272`), the leave form's staff picker (`src/components/TimeOffManager.jsx:754`) and the swap colleague picker on a coach's dashboard (`src/components/dashboard/MonthRoster.jsx:153`, reached by plain staff). Phone: ManageMode's coach list (`mobile/lib/schedule-api.js:272`) | **Yes, on the web roster:** see L3 | Column dropped (D2); opt-in `include=contract` for managed rows only (D3) |
| L3 | `RosterSummaryPanel` "FTE utilisation — this week" (`src/components/RosterSummaryPanel.jsx:88-93, 139-152`), fed `staff={locationStaff}` (the L2 shape) and rendered for `isManager` = MANAGER_ROLES (`src/components/ScheduleCalendar.jsx:383, 1616-1630`) | **Head coaches** at the studio on screen: each FTE colleague's "Xh / Yh · N%" and the status (Over hours / On target / Underused) | **Yes** | Head coaches get an hours-only list; the contract, % and status go (D6) |
| L4 | `GET /api/schedule/week-cost` (`src/app/api/schedule/week-cost/route.js:66-73`; row shape `src/lib/roster-week-cost.js:138-148`), gated MANAGER_ROLES at `location_id` | **Head coaches.** Rendered as the Weekly hours notice (`ScheduleCalendar.jsx:1302-1336`, gated `canManage(user.role)`, which includes head_coach): "34.0h / 30h · +4.0h OT". `overtime_hours` and `status` give the contract away even without `contracted_hours` (allocated − overtime = contract) | **Yes** | Below ADMIN_ROLES at the studio: `contract_visible: false`, no rows, nothing computed (D5) |
| L5 | The full `*` shape in `listStaffForUser`/`getStaffForUser`, chosen by `ADMIN_ROLES.includes(user.role)`, the ACTIVE studio's role (`src/lib/staff.js:59, 81`) | **A person who is a manager at A and head coach or staff at B**, with A active: `*` (every pay column AND the contract) for people who work **only at B**. **2 such people in prod** (read-only count, 27 Sep: profiles holding an owner/manager link and a non-admin link) | No web screen; the payload only | The rule becomes per row: HR fields only for people the caller manages (D4) |
| L6 | The **Staff Utilisation** report. `report-access.js:28-30` keeps it for head coaches ("contracted hours are not pay data (staff.js ships them to every role…)"). `generateReport` stores each person's `contracted_hours` and `utilisation_pct` (`src/lib/report-generator.js:473-499`). `ScheduleReporting` renders a "Contracted" column (`src/components/ScheduleReporting.jsx:334-339`) | **Head coaches**: the tile, generating it, the history list, schedules and the emailed summary. Prod, 27 Sep: **3 stored utilisation reports, 0 schedules** | **Yes** | Admin-only, like `staff_cost` (D7) |
| L7 | RLS `generated_reports_select` = `private.auth_is_manager_at(location_id)` (`supabase/migrations/614_coach_roster_read_scope.sql:232-234`). Checked live: `auth_is_manager_at` includes `head_coach`, and `authenticated` holds table SELECT | **Head coaches, from the browser.** The anon key is public and the session JWT is theirs, so `supabase.from('generated_reports').select('*')` returns every stored report at their studio: utilisation (contracts) AND `staff_cost` (rates; the same STAFFCOST.1 gap one layer down). No app code reads the table from the browser (`git grep`: only `/api` routes and `report-generator.js`) | Not by the app | Migration: both types admin-only at the row's location, all four commands (D8) |

**Checked and clean (left alone):**
- `GET /api/schedule/grid`: ADMIN_ROLES at the studio, the column not read otherwise, stripped again in the route (`grid/route.js:65-86`, `src/lib/roster-grid-data.js:170-194`).
- Candidates: `withContract` = manager audience + ADMIN_ROLES at the block's studio (`candidates/route.js:72`). The three offer paths (`src/app/api/schedule/offers/route.js:81`, `offers/[id]/claim/route.js:73`, `src/lib/shift-offer-server.js:163`) call `loadBlockCandidates` without `withContract`, which defaults to false (`src/lib/candidates-data.js:144, 151`). The phone's candidate line (`shared/candidates.js:209-213` via `mobile/lib/candidates-view.js`) only prints what the route sent.
- `/settings/staff`: the index names its columns and holds no contract (`src/app/settings/staff/page.js:50`). The editor `/settings/staff/[id]` is owner-at-the-person's-studio or master (`[id]/page.js:14, 50-68`), which the rule allows.
- Contracts: `GET /api/contracts/[id]` is recipient (own), master or org owner (`src/app/api/contracts/[id]/route.js:61-66`). `POST /api/contracts` is master/owner.
- Assistant: `list_staff` returns id/name/role only (`src/app/api/assistant/chat/route.js:154-170`). `staff_cost` is gated to RATE_REPORT_VIEWER_ROLES (`:373-379`). The assistant is off everywhere.
- Server aggregates: `fetchTodayOps` (`shared/dashboard-data.js:661-735`) returns a euro total and hours, never a person's contract. `fetchIncompletePayProfiles` (`:367-428`) returns names. Contractor spend (`src/lib/roster-summary-server.js:53`) returns aggregates. `LabourBlock` is server-rendered and owner-only (LABOUR.1).
- The caller's OWN profile: `getCurrentUser` reads `profiles *` for the session user (`src/lib/auth.js:282`), and pages hand that `user` to client components. That is their own contract, which the rule allows. `/api/mobile/me` names its fields and carries no contract (`src/app/api/mobile/me/route.js:35-49`).
- `profiles` holds no grant for `authenticated`/`anon` (mig 153b). `profile_compensation`'s RLS allows master, or owner at a shared studio (checked live), which the rule allows.
- **The phone renders no contract anywhere.** `git grep -i "contracted\|hours_per_week" -- mobile` finds nothing outside tests. The only `shared/` reader that prints one, `candidateHoursLine`, prints the key only when the server sent it. **So: no OTA.**

**Two facts the design rests on:**
- `profiles.contracted_hours_per_week` and `profile_compensation.contracted_hours_per_week` disagree on **0** live profiles (read-only, 27 Sep). The staff service keeps reading the `profiles` copy, as the grid and the week-cost do (`src/lib/roster-grid-data.js:24-33` says why one screen must show one contract). Moving every reader together is the phase-3 drop's job.
- `hasRoleAtLocation` (`src/lib/role-at-location.js:55-61`) is pure and client-safe. Its master bypass reads `profileRole`, and it fails closed on a missing role. Synthetic org-admin owner roles are already in `rolesByLocation` (`src/lib/auth.js:444-446`).

**Rules that bite in this PR:**
- CLAUDE.md: GRANTs and RLS fence only the browser's client. Every `/api` read here is service-role, so the rule lives in code. Name columns on any read that crosses into a client component.
- A test fixture `user` must carry `profileRole` and `rolesByLocation` now. The old `staff.test.js` fixtures carry `role` only and would silently read as "manages nobody".
- The repo is PUBLIC: fixtures use `loc-a`, `Coach One`, `example.com`, and no real names.
- Keep error shapes. `week-cost` stays `{ success, data }`, and its head-coach answer is a 200, not a 403 (D5).

---

### Decisions (each pinned by a test)

1. **The rule.** A colleague's contracted hours go to a master, or to an owner or manager (ADMIN_ROLES) at a studio the colleague works at. Anyone may see their own. A screen about one studio (the roster, week-cost, grid, candidates, a report) judges at **that** studio. A directory list with no studio judges **per row**: "does the caller manage this person anywhere in scope?" *(Tasks 2, 3, 5, 8)*
2. **`STAFF_PUBLIC_FIELDS` and `STAFF_PICKER_FIELDS` never contain `contracted_hours_per_week`**, or a pay column. A pin in `staff.test.js` plus the tripwire in `tests/contract-hours-readers.test.js`. *(Tasks 1, 10)*
3. **The picker's contract is opt-in and per row.** `GET /api/staff?fields=picker&include=contract` adds the column only to rows the caller manages, plus their own row. Everyone else's rows are projected to the picker keys, so the column is removed even if it was read. When nobody in the list qualifies, the column is not read at all. `include=contract` without `fields=picker` is ignored: the full shape already carries the contract for managed rows. *(Tasks 2, 4)*
4. **The full (`*`) shape is per row, not per active role.** Rows the caller manages keep `*, profile_locations(*, locations(*))` as today. Every other row goes out in the public shape (and the caller's own row keeps its contract). The same rule applies in `getStaffForUser`, including `role_templates`. **Consequence both ways:** the manager-at-A / head-coach-at-B person loses HR fields for people only at B, whichever studio is active. With B active, they now get the HR shape for people at A (they could always switch to A to get it). *(Tasks 2, 3; open question 1)*
5. **`week-cost` below ADMIN_ROLES at `location_id`** answers `200 { weekStartIso, weekEndIso, contract_visible: false, coaches: [], totals: 0s }` and computes nothing. Owners, managers and masters get today's body plus `contract_visible: true`. A 200 and not a 403, so that a tab still open on the old bundle shows an empty panel rather than an error (the same convention as `grid`). The route's MANAGER_ROLES gate is unchanged. *(Task 5)*
6. **The calendar asks only when allowed and shows only what it got.** `canSeeContract = ADMIN_ROLES.includes(user.role)`: the calendar always shows the ACTIVE studio, and `user.role` is the role there. The flag drives `include=contract` on the staff read, `useWeekCost({ enabled })`, the Weekly hours notice gate, and a new `RosterSummaryPanel` prop `contractVisible` (default **false**, fail closed). With `contractVisible` false, the FTE half becomes **"FTE hours — this week"**: name and rostered hours, sorted by hours, with no bar, %, status or "Leave not included" pill, and a one-line note that contracted hours are shown to owners and managers. *(Tasks 6, 7)*
7. **Staff Utilisation is an admin-only report.** `RATE_REPORT_TYPES` becomes `['staff_cost', 'utilisation']`. The export names stay, so the generate, list, schedule, PATCH, cron-email and UI-tile gates all apply unchanged. The set now means "a rate, a cost or a colleague's contract". Refusal copy names the report (`adminOnlyReportRefusal`). The recipient hint names the report too. *(Task 8)*
8. **`generated_reports` RLS:** SELECT, INSERT, UPDATE and DELETE for `staff_cost` and `utilisation` require `private.auth_is_admin_at(location_id)`. The other types keep `auth_is_manager_at`. There is still one permissive policy per command. Service-role routes are unaffected. *(Task 9)*
9. **A tripwire:** every non-test file under `src/`, `shared/` and `mobile/` that names `contracted_hours` must be on a reviewed list with the reason its audience is allowed. A new reader fails CI until someone decides. It is a floor: a `select('*')` never names the column. *(Task 10)*
10. **Unchanged on purpose:** grid, candidates, offers, `/settings/staff` and its editor, contracts, the assistant, dashboard aggregates, the caller's own profile, `/api/mobile/me`, and every write path.

---

### File map

| File | Change |
|---|---|
| `src/lib/staff.js` | Both slim field lists lose the column; `STAFF_CONTRACT_FIELD`; `managesAt`; per-row `listStaffForUser` (+ `includeContract`) and `getStaffForUser`; header comment |
| `src/lib/staff.test.js` | Mock carries `location_id`; fixtures carry `profileRole`/`rolesByLocation`/`id`; the constant pins; the role matrix |
| `src/app/api/staff/route.js` | Parse `include=contract` (picker only) and pass `includeContract` |
| `src/app/api/staff/route.test.js` | The opt-in forwarding tests |
| `src/app/api/schedule/week-cost/route.js` | ADMIN_ROLES at `location_id` decides; `contract_visible` |
| `src/app/api/schedule/week-cost/route.test.js` | The head-coach test flips; the role matrix |
| `src/components/RosterSummaryPanel.jsx` | `contractVisible` prop; the hours-only half |
| `src/components/RosterSummaryPanel.contract.test.jsx` | **Create.** Both modes |
| `src/components/RosterSummaryPanel.partial-load.test.jsx` | The two leave tests pass `contractVisible` |
| `src/components/schedule/useScheduleData.js` | `canReadContract` → `include=contract` |
| `src/components/schedule/useScheduleData.test.js` | The opt-in URL tests |
| `src/components/ScheduleCalendar.jsx` | `canSeeContract`; the four wirings |
| `src/components/ScheduleCalendar.week-cost.test.jsx` | Head coach: no week-cost, no notice, no opt-in; panel prop captured |
| `src/lib/report-access.js` | `utilisation` joins the admin-only set; `adminOnlyReportRefusal`; header comment |
| `src/lib/report-access.test.js` | The set pin and the copy helper |
| `src/app/api/schedule/reports/route.js` | Refusal copy through the helper |
| `src/app/api/schedule/reports/route.test.js` | Four list expectations move; utilisation generate tests |
| `src/app/api/schedule/reports/scheduled/route.js` | `RATE_SCHEDULE_REFUSED` → helper |
| `src/app/api/schedule/reports/scheduled/route.test.js` | The IN-list pin |
| `src/components/ScheduleReporting.jsx` | The recipient hint names the report |
| `src/components/ScheduleReporting.staffcost.test.jsx` | A head coach keeps three tiles, not four |
| `supabase/migrations/643_contractvis_generated_reports_rls.sql` | **Create** (the next free number when built) |
| `tests/contract-hours-readers.test.js` | **Create.** The tripwire |
| `src/lib/openapi.js` | week-cost and reports descriptions |
| `src/lib/roster-grid-data.js` | Comment only (`:27-28` cites the old "every role" claim) |
| `docs/CHANGELOG.md` | One row |

---

### Task 1: the slim shapes lose the column (pin first)

**Files:** Modify `src/lib/staff.test.js`, `src/lib/staff.js:11-26`.

- [ ] **Step 1: Write the failing pins.** In `src/lib/staff.test.js`, change the import on line 2 and add this block at the end of the file:

```js
import { listStaffForUser, getStaffForUser, STAFF_PUBLIC_FIELDS, STAFF_PICKER_FIELDS } from './staff.js'
```

```js
// CONTRACTVIS.1 (Richard, 27 Sep) — a colleague's contracted hours go to
// owner / manager / master at their studio only. The two shapes every other
// caller receives never carry the column, or any pay column.
describe('CONTRACTVIS.1 — the slim shapes', () => {
  const BANNED = ['contracted_hours_per_week', 'annual_salary', 'hourly_rate', 'overtime_rate', 'annual_leave_entitlement']
  for (const [name, fields] of [['STAFF_PUBLIC_FIELDS', STAFF_PUBLIC_FIELDS], ['STAFF_PICKER_FIELDS', STAFF_PICKER_FIELDS]]) {
    it(`${name} carries no contract and no pay column`, () => {
      const cols = fields.split(',').map((c) => c.trim())
      for (const banned of BANNED) expect(cols).not.toContain(banned)
    })
  }
})
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/lib/staff.test.js -t "slim shapes"`
Expected: 2 FAIL (`expected [...] not to contain 'contracted_hours_per_week'`).

- [ ] **Step 3: Drop the column from both constants.** Replace `src/lib/staff.js:11-26` with:

```js
// CONTRACTVIS.1 (Richard, 27 Sep 2026) — neither shape below carries
// contracted_hours_per_week. A colleague's contract goes to a master, or to an
// owner or manager at a studio that colleague works at, and nobody else: the
// rule CANDIDATES.1 and GRID.1 already applied. ROSTER-FIX.6c had put the
// column in both lists on the grounds that hours are not pay and "every role
// has always received them"; Richard's decision replaces that reasoning.
// The column is added back per row, only for people the caller manages (and
// their own row), by listStaffForUser / getStaffForUser below.
export const STAFF_PUBLIC_FIELDS =
  'id, full_name, email, role, avatar_url, active, employment_type'

// ROSTER-FIX.2 — the roster coach picker only ever renders a name, an avatar,
// the role, the active flag and the employment type. `?fields=picker` pins this
// shape for EVERY role, master included: never `*`, never a rate.
export const STAFF_PICKER_FIELDS =
  'id, full_name, active, role, avatar_url, employment_type'

// The one contract column, named once. Added to a read only by the per-row
// rule below; never part of either shape above.
export const STAFF_CONTRACT_FIELD = 'contracted_hours_per_week'
```

- [ ] **Step 4: Run the pins, then the whole file.**

Run: `npx vitest run src/lib/staff.test.js`
Expected: the two pins PASS. `carries every column the roster screen reads off a coach` (line 108) now FAILS on `contracted_hours_per_week`. That is intended: Task 2 replaces that test. Leave it red until then.

- [ ] **Step 5: Commit** (the one red test is fixed in Task 2; commit on the branch only).

```bash
git add src/lib/staff.js src/lib/staff.test.js
git commit -m "$(cat <<'EOF'
CONTRACTVIS.1 — the public and picker staff shapes carry no contracted hours

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `listStaffForUser` decides per row who the caller manages

**Files:** Modify `src/lib/staff.js:1-67`, `src/lib/staff.test.js`. Test the cross-tenant suite too.

- [ ] **Step 1: Make the mock carry `location_id` and the fixtures carry roles.** Replace `mockDb` and the two fixtures (`src/lib/staff.test.js:4-37`) with:

```js
function mockDb({ links = [], profiles = [], detailLinks = null } = {}) {
  const calls = { profilesSelect: null, linkLocationIds: null, linkSelect: null }
  // A link with no location_id (the older fixtures) is kept by any filter.
  const inScope = (rows, ids) => rows.filter((l) => !l.location_id || ids.includes(l.location_id))
  return {
    calls,
    from(table) {
      if (table === 'profile_locations') {
        return {
          select: (clause) => {
            calls.linkSelect = clause
            return {
              in: (_col, ids) => {
                calls.linkLocationIds = ids
                return Promise.resolve({ data: inScope(links, ids), error: null })
              },
              eq: () => ({ in: (_c, ids) => Promise.resolve({ data: inScope(detailLinks ?? links, ids), error: null }) }),
            }
          },
        }
      }
      if (table === 'profiles') {
        return {
          select: (clause) => {
            calls.profilesSelect = clause
            return {
              // The fake returns WHOLE rows whatever the select says, so a
              // test also proves the projection strips what must not leave.
              in: () => ({ order: () => Promise.resolve({ data: profiles, error: null }) }),
              eq: () => ({ single: () => Promise.resolve({ data: profiles[0] ?? null, error: profiles[0] ? null : { message: 'no rows' } }) }),
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const adminUser = { id: 'me', role: 'owner', profileRole: 'owner', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'owner' } }
const staffUser = { id: 'me', role: 'staff', profileRole: 'staff', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'staff' } }
```

In the existing tests, give each link a location: `links: [{ profile_id: 'p1', location_id: 'loc-1' }]` (lines 49, 56). In the picker test (line 94), the master caller becomes `{ id: 'me', role: 'master', profileRole: 'master', locations: [{ id: 'loc-1' }], rolesByLocation: {} }`. **Replace** the test at lines 104-115 with:

```js
  // The roster screen reads name, role, active, avatar, employment type and the
  // location links off a coach. The contract is NOT in the shape (CONTRACTVIS.1):
  // it arrives only through include=contract, per row (below).
  it('carries every column the roster screen reads off a coach, and no contract', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1', location_id: 'loc-1' }], profiles: [{ id: 'p1' }] })
    await listStaffForUser({ db, user: { id: 'me', role: 'master', profileRole: 'master', locations: [{ id: 'loc-1' }], rolesByLocation: {} }, fields: 'picker' })
    for (const col of ['id', 'full_name', 'active', 'role', 'avatar_url', 'employment_type']) {
      expect(db.calls.profilesSelect).toContain(col)
    }
    expect(db.calls.profilesSelect).not.toContain('contracted_hours_per_week')
    expect(db.calls.profilesSelect).toContain('profile_locations(location_id')
  })
```

- [ ] **Step 2: Write the failing role-matrix tests.** Append to `src/lib/staff.test.js`:

```js
// CONTRACTVIS.1 — who receives a colleague's contract (and, on the full shape,
// the HR columns). Four people: pA works only at A, pB only at B, pAB at both,
// and `me` (the caller) at both. The fake returns every column on every row, so
// what comes OUT is the projection's answer.
describe('CONTRACTVIS.1 — listStaffForUser, per row', () => {
  const A = 'loc-a'
  const B = 'loc-b'
  const person = (id) => ({
    id, full_name: `Coach ${id}`, email: `${id}@example.com`, role: 'staff', avatar_url: null,
    active: true, employment_type: 'fte', contracted_hours_per_week: 39,
    annual_salary: 40000, hourly_rate: null, overtime_rate: null,
    profile_locations: [{ location_id: A, role: 'staff', permissions: {}, locations: { id: A, name: 'A', slug: 'a', address: 'x' } }],
  })
  const PROFILES = ['me', 'pA', 'pAB', 'pB'].map(person)
  const LINKS = [
    { profile_id: 'pA', location_id: A },
    { profile_id: 'pB', location_id: B },
    { profile_id: 'pAB', location_id: A }, { profile_id: 'pAB', location_id: B },
    { profile_id: 'me', location_id: A }, { profile_id: 'me', location_id: B },
  ]
  const caller = (rolesByLocation, { active = A, profileRole = 'staff' } = {}) => ({
    id: 'me', role: rolesByLocation[active] || profileRole, profileRole,
    locations: [{ id: A }, { id: B }], rolesByLocation, activeLocation: { id: active },
  })
  const CALLERS = {
    owner: caller({ [A]: 'owner', [B]: 'owner' }, { profileRole: 'owner' }),
    manager: caller({ [A]: 'manager', [B]: 'manager' }, { profileRole: 'manager' }),
    master: { id: 'me', role: 'master', profileRole: 'master', locations: [{ id: A }, { id: B }], rolesByLocation: {} },
    head_coach: caller({ [A]: 'head_coach', [B]: 'head_coach' }),
    staff: caller({ [A]: 'staff', [B]: 'staff' }),
    'manager at A, head coach at B (A active)': caller({ [A]: 'manager', [B]: 'head_coach' }, { active: A, profileRole: 'manager' }),
    'manager at A, head coach at B (B active)': caller({ [A]: 'manager', [B]: 'head_coach' }, { active: B, profileRole: 'manager' }),
  }
  const withKey = (rows, key) => rows.filter((r) => Object.prototype.hasOwnProperty.call(r, key)).map((r) => r.id).sort()
  const run = async (user, args = {}) => {
    const db = mockDb({ links: LINKS, profiles: PROFILES })
    const res = await listStaffForUser({ db, user, ...args })
    expect(res.ok).toBe(true)
    return { rows: res.data, select: db.calls.profilesSelect, linkSelect: db.calls.linkSelect }
  }

  const PICKER_CONTRACT = {
    owner: ['me', 'pA', 'pAB', 'pB'],
    manager: ['me', 'pA', 'pAB', 'pB'],
    master: ['me', 'pA', 'pAB', 'pB'],
    head_coach: ['me'],
    staff: ['me'],
    'manager at A, head coach at B (A active)': ['me', 'pA', 'pAB'],
    'manager at A, head coach at B (B active)': ['me', 'pA', 'pAB'],
  }
  for (const [label, expected] of Object.entries(PICKER_CONTRACT)) {
    it(`picker + include=contract, ${label}: contract on ${expected.join(', ')} only`, async () => {
      const { rows } = await run(CALLERS[label], { fields: 'picker', includeContract: true })
      expect(withKey(rows, 'contracted_hours_per_week')).toEqual(expected)
      expect(withKey(rows, 'annual_salary')).toEqual([])
    })
  }

  it('picker without include=contract: nobody carries it, the caller included, and it is not read', async () => {
    const { rows, select } = await run(CALLERS.owner, { fields: 'picker' })
    expect(withKey(rows, 'contracted_hours_per_week')).toEqual([])
    expect(select).not.toContain('contracted_hours_per_week')
  })

  it('a head coach asking for contracts in a list without their own row: the column is not even read', async () => {
    const db = mockDb({ links: LINKS.filter((l) => l.profile_id !== 'me'), profiles: PROFILES.filter((p) => p.id !== 'me') })
    await listStaffForUser({ db, user: CALLERS.head_coach, fields: 'picker', includeContract: true })
    expect(db.calls.profilesSelect).not.toContain('contracted_hours_per_week')
  })

  const FULL_HR = {
    owner: ['me', 'pA', 'pAB', 'pB'],
    manager: ['me', 'pA', 'pAB', 'pB'],
    master: ['me', 'pA', 'pAB', 'pB'],
    head_coach: [],
    staff: [],
    'manager at A, head coach at B (A active)': ['me', 'pA', 'pAB'],
    'manager at A, head coach at B (B active)': ['me', 'pA', 'pAB'],
  }
  for (const [label, expected] of Object.entries(FULL_HR)) {
    it(`full shape, ${label}: HR columns on ${expected.join(', ') || 'nobody'}; contract on those plus their own row`, async () => {
      const { rows } = await run(CALLERS[label])
      expect(withKey(rows, 'annual_salary')).toEqual(expected)
      expect(withKey(rows, 'contracted_hours_per_week')).toEqual([...new Set([...expected, 'me'])].sort())
    })
  }

  it('a row the caller does not manage goes out as exactly the public keys plus trimmed links', async () => {
    const { rows } = await run(CALLERS.head_coach)
    const pB = rows.find((r) => r.id === 'pB')
    expect(Object.keys(pB).sort()).toEqual(
      ['active', 'avatar_url', 'email', 'employment_type', 'full_name', 'id', 'profile_locations', 'role'].sort(),
    )
    expect(pB.profile_locations).toEqual([{ location_id: A, role: 'staff', locations: { id: A, name: 'A', slug: 'a' } }])
  })

  it('a head coach everywhere never triggers the full select', async () => {
    const { select } = await run(CALLERS.head_coach)
    expect(select).not.toContain('*')
  })

  it('reads the link locations, which the per-row rule needs', async () => {
    const { linkSelect } = await run(CALLERS.owner)
    expect(linkSelect).toBe('profile_id, location_id')
  })

  it('location_id=B narrows the judgement to B: the mixed person manages nobody there', async () => {
    const { rows } = await run(CALLERS['manager at A, head coach at B (A active)'], { fields: 'picker', includeContract: true, locationId: B })
    // pA is not at B; pAB and pB are listed, and the caller manages neither AT B.
    expect(rows.map((r) => r.id).sort()).toEqual(['me', 'pAB', 'pB'])
    expect(withKey(rows, 'contracted_hours_per_week')).toEqual(['me'])
  })
})
```

- [ ] **Step 3: Run them and watch them fail.**

Run: `npx vitest run src/lib/staff.test.js -t "CONTRACTVIS.1 — listStaffForUser"`
Expected: FAIL. `includeContract` does not exist, the contract comes back on every row, and `linkSelect` is `'profile_id'`.

- [ ] **Step 4: Implement.** In `src/lib/staff.js`, replace the header comment (lines 1-6) and imports (7-9) with the block below, and replace `selectClause` and `listStaffForUser` (lines 28-67) with the code after it:

```js
// Staff read service (Plan C1). The single source of read logic for the
// staff directory — backs GET /api/staff, GET /api/staff/[id], and the
// web staff list, consumed on mobile via the SDK. Scopes to profiles
// sharing a location with the caller.
//
// CONTRACTVIS.1 — WHAT of each row leaves is decided PER ROW, by whether the
// caller MANAGES that person: master, or ADMIN_ROLES (owner / manager) at a
// location the person is linked to, among the locations in scope. A managed
// row gets the full profile (HR fields); any other row gets the slim public
// shape. The caller's own row always keeps its contract. This replaced
// `ADMIN_ROLES.includes(user.role)` — the ACTIVE studio's role — which handed a
// manager at A who is a head coach at B the HR fields of people only at B.
// The create/update logic (the PUT monolith) is NOT here — that's C2.
import { getUserLocationIds } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { mergeTemplates } from '@shared/permissions'
```

```js
const PUBLIC_LINKS = 'profile_locations(location_id, role, locations(id, name, slug))'
const FULL_SELECT = '*, profile_locations(*, locations(*))'
const keysOf = (fields) => fields.split(',').map((k) => k.trim())
const PUBLIC_KEYS = keysOf(STAFF_PUBLIC_FIELDS)
const PICKER_KEYS = keysOf(STAFF_PICKER_FIELDS)
const has = (row, key) => Object.prototype.hasOwnProperty.call(row, key)

/** Does the caller manage people at `locationId`? Master, or owner / manager there. */
export function managesAt(user, locationId) {
  return hasRoleAtLocation(user, locationId, ADMIN_ROLES)
}

function publicLinks(links) {
  return (links || []).map((l) => ({
    location_id: l.location_id,
    role: l.role,
    locations: l.locations ? { id: l.locations.id, name: l.locations.name, slug: l.locations.slug } : null,
  }))
}

// An ALLOWLIST projection: only `keys` (+ the contract when allowed) and the
// trimmed links leave, whatever the read returned. The second lock behind the
// select: a future select change cannot widen what an unmanaged row carries.
function slimRow(row, keys, withContract) {
  const out = {}
  for (const k of keys) if (has(row, k)) out[k] = row[k]
  if (withContract && has(row, STAFF_CONTRACT_FIELD)) out[STAFF_CONTRACT_FIELD] = row[STAFF_CONTRACT_FIELD]
  out.profile_locations = publicLinks(row.profile_locations)
  return out
}

// ROSTER-FIX.6c — `locationId` narrows the read to ONE of the caller's
// locations. Absent (the default) the behaviour is exactly what it always was:
// every location the caller holds. It is applied by INTERSECTING with the
// caller's own set rather than replacing it, so this can only ever return less
// than the unscoped call — a route that forgets `assertLocationAccess` gets an
// empty list, never another tenant's staff. It also narrows WHO the caller
// manages: with location_id=B, only an admin role AT B counts.
//
// CONTRACTVIS.1 — `includeContract` (picker only): add contracted hours to the
// rows the caller manages and to their own row. Everyone else's are stripped.
export async function listStaffForUser({ db, user, fields, locationId = null, includeContract = false }) {
  const callerLocationIds = getUserLocationIds(user)
  const userLocationIds = locationId
    ? callerLocationIds.filter(id => id === locationId)
    : callerLocationIds
  if (userLocationIds.length === 0) return { ok: true, data: [] }

  const { data: links, error: linksError } = await db
    .from('profile_locations')
    .select('profile_id, location_id')
    .in('location_id', userLocationIds)
  if (linksError) return { ok: false, error: linksError.message }

  const profileIds = [...new Set((links || []).map(l => l.profile_id))]
  if (profileIds.length === 0) return { ok: true, data: [] }

  const managedLocations = new Set(userLocationIds.filter((id) => managesAt(user, id)))
  const managed = new Set(
    (links || []).filter((l) => managedLocations.has(l.location_id)).map((l) => l.profile_id),
  )
  const selfId = user?.id ?? null
  const mayContract = (id) => managed.has(id) || (selfId !== null && id === selfId)

  const picker = fields === 'picker'
  let select
  if (picker) {
    // Read the column only when some row in the list may carry it.
    const readContract = includeContract && profileIds.some(mayContract)
    select = `${STAFF_PICKER_FIELDS}${readContract ? `, ${STAFF_CONTRACT_FIELD}` : ''}, ${PUBLIC_LINKS}`
  } else if (managed.size > 0) {
    select = FULL_SELECT
  } else {
    const readContract = selfId !== null && profileIds.includes(selfId)
    select = `${STAFF_PUBLIC_FIELDS}${readContract ? `, ${STAFF_CONTRACT_FIELD}` : ''}, ${PUBLIC_LINKS}`
  }

  const { data, error } = await db
    .from('profiles')
    .select(select)
    .in('id', profileIds)
    .order('full_name', { ascending: true })
  if (error) return { ok: false, error: error.message }

  const rows = (data || []).map((row) => {
    if (!picker && managed.has(row.id)) return row
    return slimRow(row, picker ? PICKER_KEYS : PUBLIC_KEYS, (picker ? includeContract : true) && mayContract(row.id))
  })
  return { ok: true, data: rows }
}
```

- [ ] **Step 5: Run the file, then the cross-tenant suite.**

Run: `npx vitest run src/lib/staff.test.js`
Expected: every test PASSES except the `getStaffForUser` ones that Task 3 rewrites. If `non-admin gets the slim select for the detail too` fails because `selectClause` is gone, that is Task 3; leave it.

Run: `npx vitest run tests/cross-tenant/session-routes.test.js -t "staff list"`
Expected: PASS. It asserts ids only, and its fixtures already carry `rolesByLocation` (`tests/cross-tenant/fixture.js:509-515`). If its fake cannot answer `select('profile_id, location_id')`, teach the fake to return whole link rows. Never loosen the assertion.

- [ ] **Step 6: Commit** (together with Task 3 if Task 3's detail tests are red; otherwise now).

```bash
git add src/lib/staff.js src/lib/staff.test.js
git commit -m "$(cat <<'EOF'
CONTRACTVIS.1 — the staff list decides per row whom the caller manages; contracts opt-in on the picker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `getStaffForUser` applies the same rule

**Files:** Modify `src/lib/staff.js:69-131`, `src/lib/staff.test.js:64-87`.

- [ ] **Step 1: Write the failing tests.** Append to `src/lib/staff.test.js`:

```js
describe('CONTRACTVIS.1 — getStaffForUser, per person', () => {
  const A = 'loc-a'
  const B = 'loc-b'
  const target = (id) => ({ id, full_name: `Coach ${id}`, email: `${id}@example.com`, role: 'staff', avatar_url: null, active: true, employment_type: 'fte', contracted_hours_per_week: 39, annual_salary: 40000, profile_locations: [] })
  const mixed = { id: 'me', role: 'manager', profileRole: 'manager', locations: [{ id: A }, { id: B }], rolesByLocation: { [A]: 'manager', [B]: 'head_coach' } }
  const coach = { id: 'me', role: 'head_coach', profileRole: 'head_coach', locations: [{ id: A }], rolesByLocation: { [A]: 'head_coach' } }

  it('manager at A reading someone only at B (where they are head coach): public shape, no contract', async () => {
    const db = mockDb({ detailLinks: [{ location_id: B }], profiles: [target('pB')] })
    const res = await getStaffForUser({ db, user: mixed, id: 'pB' })
    expect(res.ok).toBe(true)
    expect(res.data).not.toHaveProperty('annual_salary')
    expect(res.data).not.toHaveProperty('contracted_hours_per_week')
    expect(res.data).not.toHaveProperty('role_templates')
    expect(db.calls.profilesSelect).not.toContain('*')
  })

  it('manager at A reading someone at A: the full profile with role templates', async () => {
    const db = mockDb({ detailLinks: [{ location_id: A }], profiles: [target('pA')] })
    const res = await getStaffForUser({ db, user: mixed, id: 'pA' })
    expect(db.calls.profilesSelect).toContain('*')
    expect(res.data.contracted_hours_per_week).toBe(39)
    expect(res.data).toHaveProperty('role_templates')
  })

  it('manager at A with B active still manages people at A (the studio decides, not the active role)', async () => {
    const db = mockDb({ detailLinks: [{ location_id: A }, { location_id: B }], profiles: [target('pAB')] })
    const res = await getStaffForUser({ db, user: { ...mixed, role: 'head_coach', activeLocation: { id: B } }, id: 'pAB' })
    expect(res.data.contracted_hours_per_week).toBe(39)
  })

  it('a head coach reading a colleague: no contract', async () => {
    const db = mockDb({ detailLinks: [{ location_id: A }], profiles: [target('pA')] })
    const res = await getStaffForUser({ db, user: coach, id: 'pA' })
    expect(res.data).not.toHaveProperty('contracted_hours_per_week')
  })

  it('a head coach reading THEMSELVES keeps their own contract, and no pay column', async () => {
    const db = mockDb({ detailLinks: [{ location_id: A }], profiles: [target('me')] })
    const res = await getStaffForUser({ db, user: coach, id: 'me' })
    expect(res.data.contracted_hours_per_week).toBe(39)
    expect(res.data).not.toHaveProperty('annual_salary')
  })

  it('master: the full profile', async () => {
    const db = mockDb({ detailLinks: [{ location_id: B }], profiles: [target('pB')] })
    const res = await getStaffForUser({ db, user: { id: 'me', role: 'master', profileRole: 'master', locations: [{ id: A }, { id: B }], rolesByLocation: {} }, id: 'pB' })
    expect(res.data.annual_salary).toBe(40000)
  })
})
```

In the existing `getStaffForUser` tests (lines 76-86), change `detailLinks: [{ profile_id: 'p1' }]` to `detailLinks: [{ location_id: 'loc-1' }]`.

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/lib/staff.test.js -t "getStaffForUser"`
Expected: FAIL. `selectClause` no longer exists (ReferenceError), and the mixed and self cases are wrong.

- [ ] **Step 3: Implement.** Replace `getStaffForUser` (from `export async function getStaffForUser` to the end of the file) with:

```js
export async function getStaffForUser({ db, user, id }) {
  const userLocationIds = getUserLocationIds(user)
  if (userLocationIds.length === 0) return { ok: false, status: 404, error: 'Not found' }

  // CONTRACTVIS.1 — every SHARED link, not `.limit(1)`: whether the caller
  // manages this person depends on WHICH shared studio they are an admin at.
  const { data: links } = await db
    .from('profile_locations')
    .select('location_id')
    .eq('profile_id', id)
    .in('location_id', userLocationIds)
  if (!links || links.length === 0) return { ok: false, status: 404, error: 'Not found' }

  const managed = links.some((l) => managesAt(user, l.location_id))
  const self = (user?.id ?? null) === id
  const select = managed
    ? FULL_SELECT
    : `${STAFF_PUBLIC_FIELDS}${self ? `, ${STAFF_CONTRACT_FIELD}` : ''}, ${PUBLIC_LINKS}`
  const { data, error } = await db
    .from('profiles')
    .select(select)
    .eq('id', id)
    .single()
  // The cross-tenant guard above already 404s a missing / out-of-scope
  // target, so an error here means the row exists but the fetch failed
  // (a real DB error) — surface 500 rather than masking it as 404 and
  // sending the caller into a silent retry loop.
  if (error) return { ok: false, status: 500, error: error.message }
  if (!managed) return { ok: true, data: slimRow(data, PUBLIC_KEYS, self) }
```

After that, keep the existing role-templates block exactly as it is (the lines from `// PERM-AUDIT.3 — role templates` to its `return { ok: true, data: { ...data, role_templates: roleTemplates } }`), with its `if (isAdmin) {` removed and the block body un-indented one level: `managed` is already true there. End the function with the file's closing `}`.

- [ ] **Step 4: Run the file.**

Run: `npx vitest run src/lib/staff.test.js src/app/api/staff/[id]/route.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/staff.js src/lib/staff.test.js
git commit -m "$(cat <<'EOF'
CONTRACTVIS.1 — a staff detail carries HR fields only for someone the caller manages; own contract kept

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `GET /api/staff` forwards `include=contract` (picker only)

**Files:** Modify `src/app/api/staff/route.js:43-82`, `src/app/api/staff/route.test.js`.

- [ ] **Step 1: Write the failing tests.** Append to `src/app/api/staff/route.test.js`:

```js
// CONTRACTVIS.1 — the picker's opt-in. The read service decides per row who
// may see a contract; the route only forwards the ask, and only with the picker.
describe('GET /api/staff — ?include=contract', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', locations: [{ id: LOC }] })
    createServerClient.mockReturnValue({})
  })

  it('forwards the opt-in with the picker shape', async () => {
    const { listStaffForUser } = await import('@/lib/staff')
    listStaffForUser.mockResolvedValue({ ok: true, data: [] })
    await GET({ url: 'http://x/api/staff?fields=picker&include=contract', headers: { get: () => '' } })
    expect(listStaffForUser).toHaveBeenLastCalledWith(expect.objectContaining({ fields: 'picker', includeContract: true }))
  })

  it('ignores it without fields=picker', async () => {
    const { listStaffForUser } = await import('@/lib/staff')
    listStaffForUser.mockResolvedValue({ ok: true, data: [] })
    await GET({ url: 'http://x/api/staff?include=contract', headers: { get: () => '' } })
    expect(listStaffForUser).toHaveBeenLastCalledWith(expect.objectContaining({ fields: null, includeContract: false }))
  })

  it('is off by default', async () => {
    const { listStaffForUser } = await import('@/lib/staff')
    listStaffForUser.mockResolvedValue({ ok: true, data: [] })
    await GET({ url: 'http://x/api/staff?fields=picker', headers: { get: () => '' } })
    expect(listStaffForUser).toHaveBeenLastCalledWith(expect.objectContaining({ includeContract: false }))
  })
})
```

- [ ] **Step 2: Run and watch them fail.**

Run: `npx vitest run src/app/api/staff/route.test.js -t "include=contract"`
Expected: FAIL (`includeContract` missing from the call).

- [ ] **Step 3: Implement.** In `src/app/api/staff/route.js`, replace the GET comment (lines 43-47) with:

```js
// GET /api/staff — List staff in the caller's locations.
//   - a person the caller MANAGES (master, or owner/manager at a studio that
//     person works at): full profile + HR fields
//   - everyone else: the slim public roster (no salary, no contract); the
//     caller's own row keeps their contract (CONTRACTVIS.1)
// Read logic lives in src/lib/staff.js (shared with GET /api/staff/[id]
// and consumed on mobile via the SDK).
```

After line 58 (`const fields = …`), add:

```js
  // CONTRACTVIS.1 — the picker's opt-in for contracted hours. Asking is not
  // being told: listStaffForUser adds them only to rows the caller manages
  // (and their own). Without the picker the full shape already decides.
  const includeContract = fields === 'picker' && params?.get('include') === 'contract'
```

and change line 79 to:

```js
  const result = await listStaffForUser({ db, user, fields, locationId, includeContract })
```

- [ ] **Step 4: Run the file.**

Run: `npx vitest run src/app/api/staff/route.test.js`
Expected: all PASS. The older `toHaveBeenCalledWith(expect.objectContaining(...))` assertions still hold, because objectContaining ignores the new key.

- [ ] **Step 5: Commit.**

```bash
git add src/app/api/staff/route.js src/app/api/staff/route.test.js
git commit -m "$(cat <<'EOF'
CONTRACTVIS.1 — GET /api/staff forwards the picker's include=contract opt-in

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `week-cost` answers `contract_visible: false` below owner/manager/master

**Files:** Modify `src/app/api/schedule/week-cost/route.js`, `src/app/api/schedule/week-cost/route.test.js`.

- [ ] **Step 1: Write the failing tests.** In `src/app/api/schedule/week-cost/route.test.js`, **replace** the test `'200 for a head_coach at the location'` (lines 86-93) with:

```js
  // CONTRACTVIS.1 — every figure this route returns is measured against a
  // contract (overtime = allocated − contract), so a head coach gets the week
  // with no rows, and nothing is computed.
  it('200 for a head_coach at the location, with no contract and nothing computed', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'head_coach', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'head_coach' } })
    const res = await GET(buildReq({ location_id: LOC, week_start: '2026-05-06' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      weekStartIso: '2026-05-04',
      weekEndIso: '2026-05-10',
      contract_visible: false,
      coaches: [],
      totals: { coaches: 0, allocated_hours: 0, overtime_hours: 0, over_threshold: 0 },
    })
    expect(JSON.stringify(body)).not.toContain('contracted_hours')
    expect(computeWeeklyFteHours).not.toHaveBeenCalled()
  })
```

Append:

```js
describe('GET /api/schedule/week-cost — who sees contracts (CONTRACTVIS.1)', () => {
  const at = (rolesByLocation, profileRole = 'staff') => ({
    id: 'u', role: rolesByLocation[LOC] || profileRole, profileRole,
    locations: Object.keys(rolesByLocation).map((id) => ({ id })), rolesByLocation,
  })

  for (const role of ['owner', 'manager']) {
    it(`${role}: contract_visible true and the coaches as computed`, async () => {
      getCurrentUser.mockResolvedValue(at({ [LOC]: role }))
      const body = await (await GET(buildReq(okParams))).json()
      expect(body.data.contract_visible).toBe(true)
      expect(body.data.coaches[0].contracted_hours).toBe(30)
    })
  }

  it('master: contract_visible true', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    const body = await (await GET(buildReq(okParams))).json()
    expect(body.data.contract_visible).toBe(true)
  })

  it('manager at LOC, head coach at OTHER: contracts at LOC, none at OTHER, whichever is active', async () => {
    for (const active of [LOC, OTHER]) {
      computeWeeklyFteHours.mockClear()
      getCurrentUser.mockResolvedValue({
        id: 'mix', role: active === LOC ? 'manager' : 'head_coach', profileRole: 'manager',
        activeLocation: { id: active }, locations: [{ id: LOC }, { id: OTHER }],
        rolesByLocation: { [LOC]: 'manager', [OTHER]: 'head_coach' },
      })
      const here = await (await GET(buildReq(okParams))).json()
      expect(here.data.contract_visible).toBe(true)
      const there = await (await GET(buildReq({ location_id: OTHER, week_start: '2026-05-04' }))).json()
      expect(there.data.contract_visible).toBe(false)
      expect(there.data.coaches).toEqual([])
      expect(computeWeeklyFteHours).toHaveBeenCalledTimes(1)
    }
  })
})
```

- [ ] **Step 2: Run and watch them fail.**

Run: `npx vitest run src/app/api/schedule/week-cost/route.test.js`
Expected: the new and replaced tests FAIL (the head coach gets `coaches[0]`, and no `contract_visible` exists).

- [ ] **Step 3: Implement.** In `src/app/api/schedule/week-cost/route.js`, after line 19 of the header add:

```js
//
// CONTRACTVIS.1 (Richard, 27 Sep) — every figure here is measured against a
// contract (overtime = allocated − contract; the status says which side of it
// a coach is), so only owner / manager / master AT location_id get rows. A
// head coach gets 200 with contract_visible false and no rows, and nothing is
// computed: a 200, not a 403, so a tab still on the old bundle shows an empty
// panel rather than an error (the grid's convention).
```

Change the imports (lines 31-33) to:

```js
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, realIsoDate, MANAGER_ROLES, ADMIN_ROLES } from '@/lib/schemas'
import { computeWeeklyFteHours } from '@/lib/roster-week-cost'
import { mondayOf } from '@/lib/payroll'
import { addDaysISO } from '@/lib/dublin-time'
```

Replace lines 70-79 (the `try` block) with:

```js
  if (!hasRoleAtLocation(user, location_id, ADMIN_ROLES)) {
    const weekStartIso = mondayOf(week_start)
    return NextResponse.json({
      success: true,
      data: {
        weekStartIso,
        weekEndIso: addDaysISO(weekStartIso, 6),
        contract_visible: false,
        coaches: [],
        totals: { coaches: 0, allocated_hours: 0, overtime_hours: 0, over_threshold: 0 },
      },
    })
  }

  try {
    const db = createServerClient()
    const data = await computeWeeklyFteHours({ db, locationId: location_id, weekStart: week_start })
    return NextResponse.json({ success: true, data: { ...data, contract_visible: true } })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e?.message || 'Failed to compute weekly hours' },
      { status: 500 },
    )
  }
}
```

- [ ] **Step 4: Run the file.**

Run: `npx vitest run src/app/api/schedule/week-cost/route.test.js src/lib/roster-week-cost.test.js`
Expected: all PASS (the SCHEDROLES.1 head-coach-at-LOC tests still get 200).

- [ ] **Step 5: Commit.**

```bash
git add src/app/api/schedule/week-cost/route.js src/app/api/schedule/week-cost/route.test.js
git commit -m "$(cat <<'EOF'
CONTRACTVIS.1 — week-cost gives contract-measured hours to owner/manager/master at the studio only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `RosterSummaryPanel` shows hours only unless told the viewer may see contracts

**Files:** Modify `src/components/RosterSummaryPanel.jsx:63-170`, `src/components/RosterSummaryPanel.partial-load.test.jsx`. Create `src/components/RosterSummaryPanel.contract.test.jsx`.

- [ ] **Step 1: Write the failing test.** Create `src/components/RosterSummaryPanel.contract.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// CONTRACTVIS.1 — the FTE half measures each coach against their contract, and
// a colleague's contract is owner / manager / master only. Without
// `contractVisible` (a head coach's calendar) the half lists rostered hours
// only: no contract, no percentage, no status. It defaults to hidden.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

import RosterSummaryPanel from '@/components/RosterSummaryPanel'

afterEach(cleanup)

const FTE = {
  id: 'c1', full_name: 'Coach One', role: 'staff', active: true,
  employment_type: 'fte', contracted_hours_per_week: 30,
  profile_locations: [{ location_id: 'loc1' }],
}
const FTE_TWO = { id: 'c2', full_name: 'Coach Two', role: 'staff', active: true, employment_type: 'fte', profile_locations: [{ location_id: 'loc1' }] }

// Mon 4 May 2026 onwards: Coach One 7 × 5h = 35h, Coach Two 1 × 5h.
const blk = (id, date, pid) => ({
  id, location_id: 'loc1', block_date: date, start_time: '09:00', end_time: '14:00',
  shift_templates: { start_time: '09:00', end_time: '14:00' },
  shift_assignments: [{ id: `a-${id}`, profile_id: pid }],
})
const DAYS = ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09', '2026-05-10']
const BLOCKS = [...DAYS.map((d, i) => blk(`b${i}`, d, 'c1')), blk('b9', '2026-05-05', 'c2')]

function renderPanel(props) {
  return render(
    <RosterSummaryPanel blocks={BLOCKS} staff={[FTE, FTE_TWO]} weekStart={new Date(2026, 4, 4)} timeOff={[]} contractorSpend={null} {...props} />,
  )
}

describe('RosterSummaryPanel — contract visibility', () => {
  it('contractVisible: utilisation against the contract, as before', () => {
    renderPanel({ contractVisible: true })
    expect(screen.getByText('FTE utilisation — this week')).toBeTruthy()
    expect(screen.getByText(/35h \/ 30h/)).toBeTruthy()
    expect(screen.getByText('Over hours')).toBeTruthy()
  })

  it('default (hidden): hours only, heaviest first, no contract, % or status', () => {
    renderPanel()
    expect(screen.getByText('FTE hours — this week')).toBeTruthy()
    expect(screen.queryByText(/\/ 30h/)).toBeNull()
    expect(screen.queryByText(/%/)).toBeNull()
    for (const label of ['Over hours', 'On target', 'Underused', 'No contract']) expect(screen.queryByText(label)).toBeNull()
    const names = screen.getAllByText(/^Coach (One|Two)$/).map((n) => n.textContent)
    expect(names).toEqual(['Coach One', 'Coach Two'])
    expect(screen.getByText('35h')).toBeTruthy()
    expect(screen.getByText('5h')).toBeTruthy()
    expect(screen.getByText('Contracted hours are shown to owners and managers.')).toBeTruthy()
  })

  it('hidden: no "Leave not included" pill (it qualifies a contract comparison)', () => {
    renderPanel({ leaveMissing: true })
    expect(screen.queryByText('Leave not included')).toBeNull()
  })
})
```

In `src/components/RosterSummaryPanel.partial-load.test.jsx`, change the two leave tests to pass the flag:

```jsx
  it('leave missing: says utilisation does not include leave', () => {
    renderPanel({ staff: [FTE], leaveMissing: true, contractVisible: true })
    expect(screen.getByText('Leave not included')).toBeTruthy()
  })

  it('leave loaded: no such caveat', () => {
    renderPanel({ staff: [FTE], contractVisible: true })
    expect(screen.queryByText('Leave not included')).toBeNull()
  })
```

- [ ] **Step 2: Run and watch it fail.**

Run: `npx vitest run src/components/RosterSummaryPanel.contract.test.jsx`
Expected: the default-mode tests FAIL ("FTE hours — this week" not found; "No contract" shown).

- [ ] **Step 3: Implement.** In `src/components/RosterSummaryPanel.jsx`:

Add to the header comment, after line 18:

```js
//
// CONTRACTVIS.1 — `contractVisible` (owner / manager / master at this studio;
// the calendar decides) switches the FTE half between utilisation against the
// contract and a plain list of rostered hours. It defaults to FALSE: a caller
// that forgets to say gets hours only. The staff rows a head coach's calendar
// receives carry no contract anyway; this keeps the panel from labelling every
// one of them "No contract".
```

Add the prop after `blocks, staff, weekStart, timeOff,` (line 64):

```js
  contractVisible = false,
```

After the `summarizeWeek` call (line 93) add:

```js
  // Hours-only rows: heaviest week first, then name. Nothing measured against a contract.
  const hoursRows = contractVisible
    ? null
    : [...week.fte].sort((a, b) => (b.allocated_hours - a.allocated_hours)
      || String(a.full_name || '').localeCompare(String(b.full_name || '')))
```

Change the heading text on line 103 to `{contractVisible ? 'FTE utilisation — this week' : 'FTE hours — this week'}`. Change the pill condition on line 109 to `{!staffUnavailable && leaveMissing && contractVisible && (`. Replace the body's final branch: the `) : (` at line 121 and the whole `<div className="space-y-2.5">…</div>` up to line 168 become:

```jsx
        ) : !contractVisible ? (
          <div className="space-y-1.5">
            {hoursRows.map(row => (
              <div key={row.profile_id} className="flex items-center justify-between text-xs gap-2">
                <span className="font-medium text-un1t-text truncate">{row.full_name}</span>
                <span className="flex-shrink-0 text-un1t-subtle">{row.allocated_hours}h</span>
              </div>
            ))}
            <p className="text-[11px] text-un1t-muted pt-1">Contracted hours are shown to owners and managers.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {/* …the existing week.fte.map(...) block, unchanged… */}
          </div>
        )}
```

(Keep the existing `week.fte.map(row => { … })` body verbatim inside that last `<div className="space-y-2.5">`.)

- [ ] **Step 4: Run both panel files.**

Run: `npx vitest run src/components/RosterSummaryPanel.contract.test.jsx src/components/RosterSummaryPanel.partial-load.test.jsx src/components/RosterSummaryPanel.spendmonth.test.jsx`
Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/components/RosterSummaryPanel.jsx src/components/RosterSummaryPanel.contract.test.jsx src/components/RosterSummaryPanel.partial-load.test.jsx
git commit -m "$(cat <<'EOF'
CONTRACTVIS.1 — the roster summary shows rostered hours only unless the viewer may see contracts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: the calendar asks for contracts only for an owner, manager or master

**Files:** Modify `src/components/schedule/useScheduleData.js:184-193, 272, 372`, `src/components/schedule/useScheduleData.test.js`, `src/components/ScheduleCalendar.jsx:29, 383, 435-449, 464-468, 1302, 1616-1630`, `src/components/ScheduleCalendar.week-cost.test.jsx`.

- [ ] **Step 1: Write the failing hook tests.** Append inside `describe('useScheduleData', …)` in `src/components/schedule/useScheduleData.test.js`:

```js
  // CONTRACTVIS.1 — colleagues' contracted hours are asked for only by a caller
  // who may read them (owner / manager / master at this studio). The server
  // decides per row either way; this keeps a head coach from even asking.
  it('asks /api/staff for contracted hours only with canReadContract', async () => {
    const staffUrls = () => global.fetch.mock.calls.map(([u]) => u).filter((u) => u.includes('/api/staff'))
    const first = renderHook(() => useScheduleData({ ...ARGS, canReadContract: true }))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    expect(staffUrls()).toEqual(['/api/staff?fields=picker&include=contract'])
    first.unmount()
    global.fetch.mockClear()
    const second = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(second.result.current.loading).toBe(false))
    expect(staffUrls()).toEqual(['/api/staff?fields=picker'])
  })
```

- [ ] **Step 2: Write the failing calendar tests.** In `src/components/ScheduleCalendar.week-cost.test.jsx`, replace the panel mock (line 19) with a capturing one:

```jsx
const panel = vi.hoisted(() => ({ props: null }))
vi.mock('./RosterSummaryPanel', () => ({ default: (p) => { panel.props = p; return null } }))
```

add after the `coach` fixture (line 25):

```jsx
const headCoach = { id: 'u3', role: 'head_coach', activeLocation: { id: LOC, name: 'Stillorgan' } }
```

and append inside the `describe`:

```jsx
  // CONTRACTVIS.1 — the notice is a colleague's contract; a head coach does
  // not ask for it, does not see it, and does not ask /api/staff for contracts.
  it('a head coach never asks for week-cost and never sees the notice', async () => {
    render(<ScheduleCalendar user={headCoach} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(calls.some((u) => u.includes('/schedule/week-cost'))).toBe(false)
    expect(screen.queryByText('Weekly hours notice')).toBeNull()
  })

  it('a manager asks /api/staff for contracts and the panel may show them', async () => {
    render(<ScheduleCalendar user={manager} />)
    await waitFor(() => expect(screen.getByText('Weekly hours notice')).toBeTruthy())
    const staffUrls = calls.filter((u) => u.includes('/api/staff'))
    expect(staffUrls.length).toBeGreaterThan(0)
    expect(staffUrls.every((u) => u.includes('include=contract'))).toBe(true)
    expect(panel.props?.contractVisible).toBe(true)
  })

  it('a head coach never asks /api/staff for contracts and the panel shows hours only', async () => {
    render(<ScheduleCalendar user={headCoach} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    const staffUrls = calls.filter((u) => u.includes('/api/staff'))
    expect(staffUrls.length).toBeGreaterThan(0)
    expect(staffUrls.some((u) => u.includes('include=contract'))).toBe(false)
    expect(panel.props?.contractVisible).toBe(false)
  })
```

- [ ] **Step 3: Run both and watch them fail.**

Run: `npx vitest run src/components/schedule/useScheduleData.test.js src/components/ScheduleCalendar.week-cost.test.jsx`
Expected: the new tests FAIL. The head coach still fetches week-cost, and no `include=contract` or `contractVisible` exists.

- [ ] **Step 4: Implement the hook.** In `src/components/schedule/useScheduleData.js`, add below the `canReadAvailability` doc comment (line 191-192):

```js
// `canReadContract` — CONTRACTVIS.1: owner / manager / master at this studio.
// Adds include=contract to the staff read, so the FTE bars can measure against
// the contract. The server decides per row either way.
```

change the signature (line 193) to end `canReadSpend = false, canReadAvailability = false, canReadContract = false,`, replace line 272 with:

```js
        readJson(canReadContract ? '/api/staff?fields=picker&include=contract' : '/api/staff?fields=picker'),
```

and add `canReadContract` to the dependency array on line 372: `[locationId, startDate, endDate, spendReferenceDate, canReadSpend, canReadAvailability, canReadContract]`.

- [ ] **Step 5: Implement the calendar.** In `src/components/ScheduleCalendar.jsx`:

Line 29: `import { MANAGER_ROLES, ADMIN_ROLES } from '@/lib/schemas'`.

After line 383 (`const isManager = …`) add:

```js
  // CONTRACTVIS.1 (Richard, 27 Sep) — a colleague's contracted hours are for
  // owner / manager / master at THIS studio only. The calendar always shows the
  // active studio, and user.role is the role there. It gates the staff read's
  // include=contract, the week-cost read, the Weekly hours notice and the FTE
  // bars; the servers enforce the same rule on their own.
  const canSeeContract = ADMIN_ROLES.includes(user.role)
```

In the `useScheduleData({ … })` call, after `canReadAvailability: isManager,` (line 448) add `canReadContract: canSeeContract,`. In `useWeekCost({ … })` (line 467) change `enabled: isManager,` to `enabled: canSeeContract,` and, in the comment above it (lines 459-463), replace "Manager-gated on the client too" with "Owner/manager/master-gated on the client too (CONTRACTVIS.1)". Line 1302 becomes `{!loading && canSeeContract && (() => {`. In the `<RosterSummaryPanel` props (line 1617) add `contractVisible={canSeeContract}`.

- [ ] **Step 6: Run the calendar suites.**

Run: `npx vitest run src/components/schedule/useScheduleData.test.js src/components/ScheduleCalendar.week-cost.test.jsx src/components/ScheduleCalendar.toolbar.test.jsx src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.partial-load.test.jsx src/components/ScheduleCalendar.grid.test.jsx`
Expected: all PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/components/schedule/useScheduleData.js src/components/schedule/useScheduleData.test.js src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.week-cost.test.jsx
git commit -m "$(cat <<'EOF'
CONTRACTVIS.1 — the roster asks for contracts, week-cost and the hours notice only for owner/manager/master

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Staff Utilisation becomes an owner/manager/master report

**Files:** Modify `src/lib/report-access.js`, `src/lib/report-access.test.js`, `src/app/api/schedule/reports/route.js:99-104`, `src/app/api/schedule/reports/route.test.js`, `src/app/api/schedule/reports/scheduled/route.js:66, 174, 250`, `src/app/api/schedule/reports/scheduled/route.test.js:113`, `src/components/ScheduleReporting.jsx:814-818`, `src/components/ScheduleReporting.staffcost.test.jsx:80-86`.

- [ ] **Step 1: Write the failing tests.**

`src/lib/report-access.test.js`: change the import to add `adminOnlyReportRefusal`, and replace the first test (lines 18-23) with:

```js
  it('staff_cost and utilisation are admin-only: a rate, a cost, or a colleague\'s contract (CONTRACTVIS.1)', () => {
    expect([...RATE_REPORT_TYPES]).toEqual(['staff_cost', 'utilisation'])
    expect(RATE_REPORT_TYPES_IN_LIST).toBe('(staff_cost,utilisation)')
    for (const t of RATE_REPORT_TYPES) expect(reportTypeSchema.safeParse(t).success).toBe(true)
  })

  it('names the report in its refusal', () => {
    expect(adminOnlyReportRefusal('run', 'staff_cost')).toBe('Only owners and managers can run staff cost reports.')
    expect(adminOnlyReportRefusal('schedule', 'utilisation')).toBe('Only owners and managers can schedule staff utilisation reports.')
  })
```

`src/app/api/schedule/reports/route.test.js`: the four expectations that move, each with the reason in a comment:

```js
    // (head coach test, line ~131)
    expect(db.calls).toContainEqual(['not', 'report_type', 'in', '(staff_cost,utilisation)'])
```
```js
  it('judges the REPORT location, not the active one: manager at A, head coach at B', async () => {
    getCurrentUser.mockResolvedValue(MIXED)
    const body = await (await GET(listReq(LOC_B))).json()
    // CONTRACTVIS.1 — r4 is a utilisation report at B, where they are head coach.
    expect(body.data.map(r => r.id)).toEqual([])
  })
```
```js
    // unscoped MIXED
    expect(body.data.map(r => r.id)).toEqual(['r1', 'r2'])
    expect(db.calls).toContainEqual(['or', `location_id.in.(${LOC_A}),report_type.not.in.(staff_cost,utilisation)`])
```
```js
    // unscoped head coach everywhere
    expect(body.data.map(r => r.id)).toEqual(['r2'])
```

and append:

```js
describe('POST /api/schedule/reports — utilisation (CONTRACTVIS.1)', () => {
  const body = (location_id = LOC_A) => ({ report_type: 'utilisation', period_start: '2026-09-01', period_end: '2026-09-07', location_id })

  it('403 for a head coach, named, and nothing is generated', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH_A)
    const res = await POST(postReq(body()))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only owners and managers can run staff utilisation reports.')
    expect(generateReport).not.toHaveBeenCalled()
  })

  it('a manager at the location can generate it', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await POST(postReq(body()))).status).toBe(201)
  })

  it('manager at A cannot generate it for B, where they are head coach', async () => {
    getCurrentUser.mockResolvedValue(MIXED)
    expect((await POST(postReq(body(LOC_B)))).status).toBe(403)
    expect(generateReport).not.toHaveBeenCalled()
  })
})
```

`src/app/api/schedule/reports/scheduled/route.test.js:113`: `'(staff_cost)'` → `'(staff_cost,utilisation)'`.

`src/components/ScheduleReporting.staffcost.test.jsx:80-86` becomes:

```jsx
  it('is hidden from a head coach, who keeps the three reports without a rate or a contract', async () => {
    await renderAs({ id: 'hc', role: 'head_coach', profileRole: 'head_coach', rolesByLocation: { loc1: 'head_coach' }, activeLocation: { id: 'loc1', name: 'Stillorgan' } })
    expect(screen.queryByRole('button', { name: /Staff Cost Breakdown/ })).toBeNull()
    // CONTRACTVIS.1 — utilisation carries each colleague's contracted hours.
    expect(screen.queryByRole('button', { name: /Staff Utilisation/ })).toBeNull()
    for (const label of ['Staff Hours Worked', 'Time Off Summary', 'Roster Coverage']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy()
    }
  })
```

- [ ] **Step 2: Run and watch them fail.**

Run: `npx vitest run src/lib/report-access.test.js src/app/api/schedule/reports/route.test.js src/app/api/schedule/reports/scheduled/route.test.js src/components/ScheduleReporting.staffcost.test.jsx`
Expected: FAIL on the set pin, the IN-list, the four list expectations, the utilisation 403 and the tile.

- [ ] **Step 3: Implement `report-access.js`.** Replace the `utilisation` paragraph in the header (lines 28-30) with:

```js
//   utilisation      contracted vs actual hours and a percentage, per person.
//                    CONTRACTVIS.1 (Richard, 27 Sep): a colleague's contracted
//                    hours are owner / manager / master only → admin only.
```

and add after line 34 (`// RATE_REPORT_TYPES; report-access.test.js pins the set.`):

```js
//
// CONTRACTVIS.1 — the set is now "admin-only reports": a rate, a cost, or a
// colleague's contract. The export names stay so every gate built on them
// (generate, list, schedule, PATCH, the cron's email recipients, the UI tile)
// covers utilisation with no further change.
```

Replace line 43 with `export const RATE_REPORT_TYPES = Object.freeze(['staff_cost', 'utilisation'])`, and add after `isRateReportType`:

```js
const ADMIN_REPORT_NAMES = Object.freeze({ staff_cost: 'staff cost', utilisation: 'staff utilisation' })

/** The refusal for a non-admin asking to `verb` ('run' | 'schedule') an admin-only report. */
export function adminOnlyReportRefusal(verb, reportType) {
  return `Only owners and managers can ${verb} ${ADMIN_REPORT_NAMES[reportType] || 'these'} reports.`
}
```

- [ ] **Step 4: Use it in the routes and the UI.**

`src/app/api/schedule/reports/route.js`: add `adminOnlyReportRefusal` to the `@/lib/report-access` import (line 10) and replace the error on line 101 with `{ success: false, error: adminOnlyReportRefusal('run', report_type) },`.

`src/app/api/schedule/reports/scheduled/route.js`: import `adminOnlyReportRefusal` (line 9 import list), delete line 66 (`const RATE_SCHEDULE_REFUSED = …`), and change line 174 to `return NextResponse.json({ success: false, error: adminOnlyReportRefusal('schedule', body.report_type) }, { status: 403 })` and line 250 to `return NextResponse.json({ success: false, error: adminOnlyReportRefusal('schedule', reportType) }, { status: 403 })`.

`src/components/ScheduleReporting.jsx:814-818`:

```jsx
                {rateReport && (
                  <p className="text-xs text-un1t-subtle mt-1">
                    {reportType === 'utilisation'
                      ? 'Utilisation figures go only to owners and managers at this studio, or to outside addresses you confirm.'
                      : 'Staff cost figures go only to owners and managers at this studio, or to outside addresses you confirm.'}
                  </p>
                )}
```

- [ ] **Step 5: Run the report suites.**

Run: `npx vitest run src/lib/report-access.test.js src/app/api/schedule/reports src/components/ScheduleReporting src/app/api/cron/run-scheduled-reports`
Expected: all PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/report-access.js src/lib/report-access.test.js src/app/api/schedule/reports src/components/ScheduleReporting.jsx src/components/ScheduleReporting.staffcost.test.jsx
git commit -m "$(cat <<'EOF'
CONTRACTVIS.1 — Staff Utilisation is an owner/manager/master report, like Staff Cost

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: migration: a head coach's browser cannot read those two report types

**Files:** Create `supabase/migrations/643_contractvis_generated_reports_rls.sql` (use the next free number at build time: `git ls-tree --name-only origin/main supabase/migrations | tail -1`).

- [ ] **Step 1: Measure before (read-only, Supabase MCP `execute_sql`, project `iyvtbjjxdggiadzwwvdj`).** Record the output in the PR body.

```sql
-- as a head coach, through RLS (no data values read: counts only)
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select profile_id::text from public.profile_locations where role = 'head_coach' order by profile_id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
select report_type, count(*) from public.generated_reports group by 1 order by 1;
rollback;
```

Expected: `staff_cost` and/or `utilisation` rows appear if any exist at that head coach's studio (that is the leak). Run the same query with an owner's id (`role = 'owner'`) and record it as the control.

- [ ] **Step 2: Write the migration.**

```sql
-- 643 — CONTRACTVIS.1: generated reports that carry pay rates or a colleague's
-- contracted hours are readable (and writable) from the BROWSER by owner /
-- manager / master at the report's studio only.
--
-- WHY
-- ───
-- Richard, 27 Sep: a colleague's contracted hours go to owner / manager /
-- master only, everywhere. The app layer now keeps `utilisation` (per-person
-- contracted hours and a percentage of them) from head coaches, as STAFFCOST.1
-- did for `staff_cost` (rates and cost): src/lib/report-access.js
-- RATE_REPORT_TYPES. But every route is service-role; the browser's client is
-- bound only by RLS, and mig 614 set every generated_reports policy to
-- private.auth_is_manager_at(location_id), which INCLUDES head_coach. With the
-- public anon key and their own session, a head coach could
-- `select * from generated_reports` and read both report types at their studio.
-- No app code reads or writes this table from the browser (only /api routes and
-- src/lib/report-generator.js, all service-role), so narrowing breaks nothing.
--
-- WHAT
-- ────
-- One permissive policy per command (CLAUDE.md), each:
--   auth_is_manager_at(location_id)
--   AND (report_type NOT IN ('staff_cost','utilisation') OR auth_is_admin_at(location_id))
-- auth_is_admin_at = master, or owner/manager at the location (mig 626:600-622).
-- Keep the type list equal to RATE_REPORT_TYPES; a new admin-only type needs a
-- migration like this one.
--
-- ROLLBACK: re-create the four mig-614 policies (614_coach_roster_read_scope.sql:232-244),
-- i.e. the same four with only private.auth_is_manager_at(location_id).

BEGIN;

DROP POLICY IF EXISTS "generated_reports_select" ON public.generated_reports;
DROP POLICY IF EXISTS "generated_reports_ins" ON public.generated_reports;
DROP POLICY IF EXISTS "generated_reports_upd" ON public.generated_reports;
DROP POLICY IF EXISTS "generated_reports_del" ON public.generated_reports;

CREATE POLICY "generated_reports_select" ON public.generated_reports
  FOR SELECT TO authenticated
  USING (
    private.auth_is_manager_at(location_id)
    AND (report_type NOT IN ('staff_cost', 'utilisation') OR private.auth_is_admin_at(location_id))
  );
CREATE POLICY "generated_reports_ins" ON public.generated_reports
  FOR INSERT TO authenticated
  WITH CHECK (
    private.auth_is_manager_at(location_id)
    AND (report_type NOT IN ('staff_cost', 'utilisation') OR private.auth_is_admin_at(location_id))
  );
CREATE POLICY "generated_reports_upd" ON public.generated_reports
  FOR UPDATE TO authenticated
  USING (
    private.auth_is_manager_at(location_id)
    AND (report_type NOT IN ('staff_cost', 'utilisation') OR private.auth_is_admin_at(location_id))
  )
  WITH CHECK (
    private.auth_is_manager_at(location_id)
    AND (report_type NOT IN ('staff_cost', 'utilisation') OR private.auth_is_admin_at(location_id))
  );
CREATE POLICY "generated_reports_del" ON public.generated_reports
  FOR DELETE TO authenticated
  USING (
    private.auth_is_manager_at(location_id)
    AND (report_type NOT IN ('staff_cost', 'utilisation') OR private.auth_is_admin_at(location_id))
  );

-- Self-check: all four exist and every one names auth_is_admin_at.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'generated_reports'
    AND policyname IN ('generated_reports_select', 'generated_reports_ins', 'generated_reports_upd', 'generated_reports_del')
    AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%auth_is_admin_at%';
  IF n <> 4 THEN
    RAISE EXCEPTION 'CONTRACTVIS.1: expected 4 narrowed generated_reports policies, found %', n;
  END IF;
END $$;

COMMIT;
```

- [ ] **Step 3: Run the repo checks that read migrations.**

Run: `npm run check:rls-restrictive && npm run check:select-columns`
Expected: both green (permissive policies only; no column changes).

- [ ] **Step 4: Commit** (the migration is applied after merge, Step 5 of the gate).

```bash
git add supabase/migrations/643_contractvis_generated_reports_rls.sql
git commit -m "$(cat <<'EOF'
CONTRACTVIS.1 — generated_reports RLS: staff_cost and utilisation rows are owner/manager/master only from the browser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: the tripwire: every reader of the column is reviewed

**Files:** Create `tests/contract-hours-readers.test.js`.

- [ ] **Step 1: Write the guard.**

```js
// tests/contract-hours-readers.test.js
// CONTRACTVIS.1 (Richard, 27 Sep) — a colleague's contracted hours go to a
// master, or to an owner / manager at a studio that colleague works at, and
// nobody else; a person may always see their own. Every non-test file under
// src/, shared/ and mobile/ that NAMES the column (or the `contracted_hours`
// key derived from it) is listed below with the reason its audience is allowed.
// A new reader fails here until someone decides — the same shape as
// tests/staff-tombstone-readers.test.js.
//
// A FLOOR, NOT A PROOF: a `select('*')` never names the column (that is why
// src/lib/staff.js projects every row it does not manage), and a value that
// travels under another name is invisible.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['src', 'shared', 'mobile']
const SKIP_DIRS = new Set(['node_modules', '.expo', 'ios', 'android', 'dist', 'build', 'coverage'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|jsx|mjs|ts|tsx)$/.test(name) && !/\.test\.|test-helpers/.test(name)) out.push(p)
  }
  return out
}

export function contractHoursReaders(root) {
  const hits = []
  for (const top of ROOTS) {
    for (const file of walk(join(root, top))) {
      if (readFileSync(file, 'utf8').includes('contracted_hours')) hits.push(relative(root, file).split(sep).join('/'))
    }
  }
  return hits.sort()
}

const REVIEWED = {
  'shared/candidates.js': 'pure ranking and labels; the key exists only when the candidates route sent it (withContract: ADMIN_ROLES at the block\'s studio)',
  'shared/dashboard-data.js': 'server-only aggregates: a euro labour total and names of incomplete pay profiles; never returns the column',
  'src/app/api/assistant/chat/route.js': 'staff_cost tool, RATE_REPORT_VIEWER_ROLES at the active studio only (the assistant is off everywhere)',
  'src/app/api/contracts/[id]/route.js': 'the contract\'s recipient (own), master, or an owner of its organisation',
  'src/app/api/contracts/route.js': 'issuing a contract: master or owner only',
  'src/app/api/schedule/grid/route.js': 'ADMIN_ROLES at the studio only (showContract), stripped again otherwise',
  'src/app/api/schedule/week-cost/route.js': 'ADMIN_ROLES at the studio only; contract_visible false otherwise (CONTRACTVIS.1)',
  'src/app/api/staff/[id]/route.js': 'write schema (PUT is owner/master); reads go through src/lib/staff.js',
  'src/app/api/staff/route.js': 'write schema (POST is owner/master); reads go through src/lib/staff.js',
  'src/app/settings/staff/page.js': 'comment only; the page names its columns and reads no contract',
  'src/components/ContractTemplateForm.jsx': 'a template variable name and a sample value; no person\'s data',
  'src/components/RosterSummaryPanel.jsx': 'renders a contract only with contractVisible, from rows the server sent (include=contract, managed rows)',
  'src/components/ScheduleCalendar.jsx': 'renders week-cost rows, fetched only with canSeeContract (owner/manager/master at the studio)',
  'src/components/ScheduleReporting.jsx': 'renders the utilisation report, admin-only (RATE_REPORT_TYPES)',
  'src/components/StaffForm.jsx': 'the staff editor: owner at the person\'s studio, or master',
  'src/lib/assistant-prompt.js': 'prompt text only',
  'src/lib/candidates-data.js': 'reads contracts only when withContract (ADMIN_ROLES at the block\'s studio)',
  'src/lib/contracts.js': 'contract template variables, issued by owner/master',
  'src/lib/openapi.js': 'API documentation',
  'src/lib/payroll.js': 'server-side arithmetic',
  'src/lib/profile-compensation.js': 'server reader of the canonical pay table',
  'src/lib/report-generator.js': 'writes staff_cost and utilisation, both admin-only report types',
  'src/lib/roster-grid-data.js': 'reads the column only when showContract',
  'src/lib/roster-grid-model.js': 'pure; the key exists only when the grid route sent it',
  'src/lib/roster-summary-server.js': 'server-only contractor spend aggregates',
  'src/lib/roster-summary.js': 'pure; measures only rows the caller was sent',
  'src/lib/roster-week-cost.js': 'server arithmetic behind week-cost',
  'src/lib/schemas.js': 'a comment on the column\'s range',
  'src/lib/staff-write.js': 'owner/master writes',
  'src/lib/staff.js': 'adds the column only for rows the caller manages, and their own (CONTRACTVIS.1)',
}

describe('every reader of contracted hours has been reviewed (CONTRACTVIS.1)', () => {
  it('no unreviewed file names the column', () => {
    const unreviewed = contractHoursReaders(repo).filter((f) => !REVIEWED[f])
    expect(
      unreviewed,
      'A file names contracted hours and is not in REVIEWED. Colleagues\' contracted hours go to ' +
      'master, or owner/manager at their studio, only (CONTRACTVIS.1). Check who receives it, then add the ' +
      'file with that reason.',
    ).toEqual([])
  })

  it('REVIEWED has no stale entries', () => {
    const found = new Set(contractHoursReaders(repo))
    expect(Object.keys(REVIEWED).filter((f) => !found.has(f))).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, then prove it bites.**

Run: `npx vitest run tests/contract-hours-readers.test.js`
Expected: PASS. If `no unreviewed file` lists a file, a new reader landed on `main` since this plan was written. Read it, decide who receives it, and add it with the reason, or fix it.

Then delete the `'src/lib/payroll.js'` line, re-run it and expect FAIL listing `src/lib/payroll.js`. Restore the line.

- [ ] **Step 3: Commit.**

```bash
git add tests/contract-hours-readers.test.js
git commit -m "$(cat <<'EOF'
CONTRACTVIS.1 — tripwire: every file that names contracted hours is reviewed for who receives them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: OpenAPI and the stale comments

**Files:** Modify `src/lib/openapi.js` (week-cost entry `:4567-4580`; reports POST `:5471-5477`), `src/lib/roster-grid-data.js:24-33`.

- [ ] **Step 1: week-cost.** Replace its `summary` and `description` with:

```js
  summary: 'FTE hours against contract for one week (owner/manager/master see the rows)',
  description: "Per-coach allocated hours, contracted hours and overtime for the Mon-Sun week containing week_start, plus week totals, and contract_visible: true. Gate: master, owner, manager or head_coach AT location_id, and assertLocationAccess (a location outside the caller's assignments is a 403). CONTRACTVIS.1: every figure is measured against a contract, so only owner, manager or master at location_id get rows; a head coach gets 200 with contract_visible false, coaches [] and zero totals, and nothing is computed. The response carries NO rate, salary or euro figure. week_start may be any day inside the target week; it is snapped to that week's Monday.",
```

- [ ] **Step 2: reports POST.** In its `description`, replace "staff_cost carries pay rates, so it is owner/manager/master only at that studio." with "staff_cost (pay rates) and utilisation (each colleague's contracted hours; CONTRACTVIS.1) are owner/manager/master only at that studio."

- [ ] **Step 3: `roster-grid-data.js`.** Replace the sentence "Contracted hours are hours, not pay: STAFF_PICKER_FIELDS has shipped them to every role since ROSTER-FIX.6c." (lines 26-28) with "Contracted hours go to owner, manager and master only (CONTRACTVIS.1); the staff picker no longer carries them."

- [ ] **Step 4: Run the openapi test if one exists, and the grid data test.**

Run: `npx vitest run src/lib/openapi.test.js src/lib/roster-grid-data.test.js`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/openapi.js src/lib/roster-grid-data.js
git commit -m "$(cat <<'EOF'
CONTRACTVIS.1 — OpenAPI and comments say who sees contracted hours

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### The gate (run once, at the end, in this order)

```bash
git fetch origin main && git rebase origin/main
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
npm run build
```

Expected: all twelve green, then a clean `next build`. Confirm **no OTA**: `git diff --stat origin/main -- mobile shared` is empty. `check:select-columns` cannot read the staff service's composed select strings (they are non-literal, as `selectClause` was before); that is a floor, not a pass, so the role-matrix tests are the check. After the rebase, re-run `npx vitest run tests/contract-hours-readers.test.js`: a reader merged meanwhile shows up there.

Then independent review, then:

1. `git push -u origin HEAD` and `gh pr create --base main --title "CONTRACTVIS.1 — a colleague's contracted hours go to owners, managers and masters at their studio, and nobody else" --body-file <scratchpad>/contractvis-pr.md`.
2. Add the CHANGELOG row once the PR number exists, as the first row under `| # / PR | Item | Notes |` in `docs/CHANGELOG.md`. Commit and push it on the branch; never edit it after it is on main.
3. CI green, then merge (web: the standing authority).
4. **After the deploy is live**, apply the migration with Supabase MCP `apply_migration` (name `contractvis_generated_reports_rls`). Order does not matter (no app code reads the table from the browser), but after the deploy keeps a single story.
5. **Post-check:** re-run Task 9 Step 1 as the same head coach. Expect no `staff_cost` and no `utilisation` rows, with the other types unchanged. As the owner, expect the counts unchanged. Then `select policyname, qual, with_check from pg_policies where tablename = 'generated_reports'` shows all four naming `auth_is_admin_at`. Record both in the PR and in the index status log.
6. **Eyeball (Richard, 2 minutes, on a computer):** as a head coach, open `/schedule`, week view. The Weekly hours notice is gone, the left summary card reads "FTE hours — this week" with hours only, and Reporting shows three tiles. As an owner or manager, all of it is unchanged. jsdom cannot see layout.

**PR title:** `CONTRACTVIS.1 — a colleague's contracted hours go to owners, managers and masters at their studio, and nobody else`

**PR body** (the section headed "Who loses sight of what" goes in verbatim):

- **Why:** Richard's decision on 27 Sep (follow-ups index B2). CANDIDATES.1 and GRID.1 already kept colleagues' contracted hours to owner/manager/master. The staff list, the week-cost panel, the roster's FTE bars and the utilisation report still sent them to everyone.
- **Who loses sight of what:**
  - **Head coaches** (at the studio on screen): the roster's **Weekly hours notice** ("34.0h / 30h · +4.0h OT") is gone. The **FTE utilisation** card becomes **"FTE hours — this week"**: each FTE coach's rostered hours, with no contract, %, status or "Leave not included" pill. **Staff Utilisation** reports are gone: the tile, generating, the history (3 stored utilisation reports exist in prod), schedules (none exist) and emailed summaries. They also stop receiving colleagues' `contracted_hours_per_week` in every `/api/staff` response (never displayed).
  - **Staff (coaches):** colleagues' `contracted_hours_per_week` disappears from every `/api/staff` response: the list and detail, the swap colleague picker, the phone's staff directory and ManageMode list. **Nothing they can see on screen changes**, because no screen rendered it.
  - **A manager or owner at one studio who is a head coach or coach at another (2 people today):** HR fields (pay columns and contracted hours) disappear from `/api/staff` for people who work **only** at the studio where they are not an admin, whichever studio is active. At that studio's `/schedule` they get the head-coach view above. In the other direction, with the non-admin studio active, `/api/staff` now gives them the full profile for people at the studio they manage, which switching studio always gave them.
  - **From the browser (RLS):** a head coach can no longer read `staff_cost` or `utilisation` rows from `generated_reports` with the Supabase client. For `staff_cost` this closes, at the database, the gap STAFFCOST.1 closed in the app.
  - **Everyone keeps their own contracted hours.** **Owners, managers and masters see everything they saw before** (the roster now asks for contracts explicitly).
- **How:** the staff service decides per row: HR fields and contracts only for people the caller manages (master, or owner/manager at a studio the person works at), and the caller's own row keeps its contract. The two slim shapes lose the column. The picker's contract is the opt-in `include=contract`. `week-cost` returns `contract_visible: false` and no rows below owner/manager/master at the studio (a 200, the grid's convention). Utilisation joins `RATE_REPORT_TYPES`. Migration NNN narrows the four `generated_reports` policies.
- **Guards:** a pin that the public and picker shapes carry no contract or pay column. `tests/contract-hours-readers.test.js` fails when a new file names the column without a reviewed reason (a floor: a `select('*')` is invisible to it). The role matrix covers owner, manager, master, head_coach, staff, and manager-at-A / head-coach-at-B with either studio active.
- **Unchanged (checked):** grid, candidates and offers, `/settings/staff` and its editor, contracts, the assistant, dashboard aggregates, `/api/mobile/me`, and the caller's own profile.
- **Migration NNN** applied after the deploy; pre/post counts as a head coach and an owner are recorded below. Rollback: re-create the mig-614 policies.
- **No OTA:** nothing under `mobile/` or `shared/`. The phone never rendered a contract.
- Last line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

**CHANGELOG row** (add once the PR number exists; commit on the branch; never edit it after it is on main):

```
| #<PR> | CONTRACTVIS.1 — a colleague's contracted hours go to owners, managers and masters at their studio, and nobody else | 2026-09-<dd>. **Richard's decision (27 Sep).** Web + **mig NNN** (`generated_reports` RLS, applied after the deploy); **no OTA**. `STAFF_PUBLIC_FIELDS`/`STAFF_PICKER_FIELDS` lose `contracted_hours_per_week`; `listStaffForUser`/`getStaffForUser` decide PER ROW whom the caller manages (master, or ADMIN_ROLES at a studio the person works at) instead of the ACTIVE studio's role: managed rows keep `*`, others go out slim, own row keeps its contract. Picker opt-in `include=contract` (managed rows + own only). `week-cost`: below ADMIN_ROLES at the studio → 200 `contract_visible:false`, no rows, nothing computed. Calendar: `canSeeContract` gates the opt-in, week-cost, the Weekly hours notice and `RosterSummaryPanel contractVisible` (head coaches get "FTE hours — this week", hours only). Utilisation joins `RATE_REPORT_TYPES` (admin-only: generate, list, schedule, email, tile). Mig NNN: all four `generated_reports` policies add `auth_is_admin_at` for staff_cost + utilisation (a head coach's browser could read both). Who loses what: head coaches the notice, the contract-measured bars and utilisation; staff the column in `/api/staff` payloads (never rendered); the 2 manager-here/coach-elsewhere people HR fields for people only at the other studio. Guards: shape pins, the role matrix, `tests/contract-hours-readers.test.js` (a floor). |
```

---

### Review notes / open questions (for the owner)

1. **The mixed-role widening (D4).** The per-row rule works in both directions. A manager at A whose ACTIVE studio is B (where they are a head coach) now gets the full HR shape (pay included) for people at A from `/api/staff`. Before, they got it only with A active. It is the same data they get by switching studio, and it follows the per-studio rule everywhere else. If Richard prefers "never more than before", intersect with the active role: `managed = ADMIN_ROLES.includes(user.role) && …`. That is a one-line change, and the two "(B active)" matrix rows then expect `['me']` / `[]`.
2. **A head-coach version of utilisation?** `staff_hours` already gives head coaches everyone's hours. If Richard wants utilisation's "who is under or over", it would need a contract-free measure (for example, hours against the studio's rostered average). Not built.
3. **Which copy of the contract.** `/api/staff`, the grid and week-cost read `profiles.contracted_hours_per_week`, while candidates reads `profile_compensation`. The two copies differ on 0 profiles today (read-only, 27 Sep). The phase-3 drop of the `profiles` pay columns must move every reader together.
4. **Out of scope, found:** `scheduled_reports` RLS (mig 614) lets a head coach's browser read `staff_cost` schedule rows. Those hold recipient addresses, not figures. Worth the same narrowing in a later migration.
5. **Out of scope, pre-existing:** the full shape sends `profile_locations(*, locations(*))` for every link of a managed person, including studios the caller does not hold. `getStaffForUser` still discards its link-read error (a failed read answers 404).
6. **The tripwire is a floor.** It cannot see `select('*')` (why `src/lib/staff.js` projects), a value renamed on the way out, or the mobile bundle's runtime. The role-matrix tests are the proof for the paths changed here.
7. **Stored utilisation reports** (3 in prod) stay in the table. Head coaches simply stop being able to list or read them, and owners and managers still can.
8. **Size:** M. Eleven small tasks. The staff service (Tasks 2-3) is the only part with real logic; the rest is gates, copy and tests.
