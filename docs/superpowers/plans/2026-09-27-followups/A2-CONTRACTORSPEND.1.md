## PR CONTRACTORSPEND.1: contractor spend prices every published shift at this studio in the Dublin month, whoever holds it, active or not

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The roster calendar's "Contractor spend" panel (and the publish budget gate beside it) prices every live assignment on a block at this studio in the month, by the person who HOLDS it. That covers a contractor deactivated mid-month, a contractor from the sibling studio covering a class here, and a permanently deleted contractor's past shifts. The headline figure is published shifts. Drafts and shifts no roster owns yet are shown on their own line. The month is worked out from the Dublin calendar date string, never from a local `Date`.

**Why:** Row A2 of `00-INDEX.md` (Batch A, money people act on). The panel's figure drives the over-budget colouring managers read, and the same pricing rule sits behind the publish gate's confirmation. Today worked shifts drop out of it silently. There is also a latent month bug that turns into a €0 on any host west of UTC.

**Architecture:** One new IO helper, `src/lib/shift-holder-pay.js`. It reads pay for a list of shift HOLDERS: the type from `profiles` (named columns) and the pay from `profile_compensation`. Both the spend read (`roster-summary-server.js`) and the publish gate (`roster-publish.js` `loadBudgetContext`) use it, so the two price the same people. `summarizeMonth` stays pure. It takes a `pay` Map keyed by holder instead of a membership staff list, derives the month with `monthBounds` from `@shared/roster-month` (string arithmetic), and splits published from unpublished. The panel relabels "Spent" as "Published" and adds one line for the unpublished figure.

**Tech Stack:** Next.js 16 App Router, Supabase PostgREST through the service-role client, Vitest (node env for libs; jsdom + Testing Library for the panel test, as `RosterSummaryPanel.spendmonth.test.jsx` already does).

**Size / ships:** M. **No migration. No OTA**: nothing under `mobile/` or `shared/` changes (the new code only IMPORTS `@shared/roster-month`). No new route and no new permission key. The one route touched (`/api/schedule/contractor-spend`) only changes its header comment; its response gains three aggregate keys (D8).

**Depends on:** **A1 PAYROLL24.1 merged first** (00-INDEX conflict hotspots: `src/lib/payroll.js` is read here through `shiftHours`). This PR changes no line of `payroll.js`. It does adapt the `summarizeMonth` case that A1 appends to `src/lib/roster-summary.test.js` (Task 2 (d)), because that case calls the signature this PR replaces. Task 0 checks both.

**Pairs with:** A3 INVOICEHOURS.1 in Wave 2. No shared file except `docs/CHANGELOG.md` (`merge=union`). See "Conflicts with A1 and A3" at the end.

---

### What was found (verified against `origin/main` at `28d02e59`, #1779)

**The path.** `useScheduleData.js:278` calls `GET /api/schedule/contractor-spend?location_id=…&reference_date=…`. `reference_date` is always the 1st of the month (`ScheduleCalendar.jsx:441`, `formatDate(spendMonth.monthStart)`). The route (`src/app/api/schedule/contractor-spend/route.js`) gates on MANAGER_ROLES at `location_id` and calls `computeMonthlyContractorSpend` (`src/lib/roster-summary-server.js:53`). That function calls `summarizeMonth` (`src/lib/roster-summary.js:321`). `RosterSummaryPanel.jsx:172-243` renders the result. Nothing else calls `summarizeMonth` (`git grep` on `src shared mobile tests`).

**(a) A contractor deactivated mid-month is dropped.** `summarizeMonth` loops over `staff` and does `if (!s.active) continue` (`roster-summary.js:336`), so every hour they worked that month costs €0. The same skip hides an inactive employee's hours from the "FTE labour (sunk cost)" line (`:343-344`).

**(b) A sibling-studio contractor who works here is dropped.** The server builds `staff` from `profile_locations` at THIS studio (`roster-summary-server.js:86-104`). A holder who is not a member here is never looked up and costs €0. The publish gate has the same hole: `loadBudgetContext` builds `contractorRateById` from this studio's `profile_locations` only (`src/lib/roster-publish.js:103-116`).

**(c) The month is parsed from a local `Date`, twice.**
- `monthBoundsIso` parses `referenceDate + 'T00:00:00'` as a LOCAL date (`roster-summary-server.js:26-31`), which is right in every zone.
- `summarizeMonth` then parses the bare string again with `new Date(referenceDate)` (`roster-summary.js:322`). That is UTC midnight, and it reads local getters (`:323-324`).
- West of UTC, `'2026-10-01'` becomes 30 Sep 17:00. The server fetches October's blocks, the sum then filters to September, and the answer is **€0**.
- The calendar ALWAYS sends the 1st, so the bug fires on every call on such a host. It is latent on Vercel (UTC) and in Dublin (UTC+0/+1).

**Also found on the same path:**
- **Drafts are priced as spend.** Neither the server select (`:69-80`, no `rosters` embed) nor `summarizeMonth` looks at roster status, so a block no roster owns, a draft, or a stood-down `superseded` roster all count as "Spent". The publish gate, by contrast, counts only published blocks outside the period being published (`roster-publish.js:520`). LABOUR.1 costs only published shifts too.
- **Rates come from the deprecated copy.** Both the spend read (`roster-summary-server.js:97-100`) and the gate (`roster-publish.js:106`) read `profiles.hourly_rate` / `annual_salary` / `contracted_hours_per_week`. Mig 152 made `profile_compensation` the canonical copy, and mig 153 comments the `profiles` columns "DEPRECATED … to be dropped". The two are dual-written today (`staff-write.js:217-240`, `api/staff/route.js:210-262`) and agree on prod (below). LABOUR.1 reads `profile_compensation` through `getCompensationForProfiles` (`profile-compensation.js:78-102`, which throws on a failed read).
- **The block read does not page** (`roster-summary-server.js:69-80`). One studio-month is about 150 blocks today, so it is not at risk, but CLAUDE.md's 1,000-row rule says to page anyway.
- **Index anchor correction.** The index cites `roster-summary.js` "~60-80, 216-221". On inspection those are `leaveHoursInWeek` and `summarizeWeek`. Both run in the BROWSER on the calendar's own local `Date`s (the ROSTERTZ.1 convention) and feed only the FTE hours bars, never the spend. They are left alone. The spend's local parse is `summarizeMonth` at `:321-326`.

**Measured on prod (27 Sep, read-only SQL, counts only; no pay figures in this public repo):**
- 6 contractors, none inactive. 0 contractors without a rate in `profile_compensation`. 0 profiles whose `profiles.hourly_rate` differs from `profile_compensation.hourly_rate`.
- Since 1 June: **0** assignments held by someone who is not a member of the block's studio. **123** assignments (June 74, July 49, all published) are held by **one inactive employee**, so the sunk-cost line under-reads June and July today.
- Blocks exist only at Stillorgan (Hatch Street has none; one Test Studio block in July). June to September: every block is on a published roster. **October: 14 published, 131 with no roster. November: 70 with no roster.**
- `rosters.status` values in use: `published`, `superseded`. 0 admin templates. 1 studio has a budget set.

**So the live effect is:**
- contractor figures for September and earlier: unchanged;
- October and November: the headline drops to published shifts only, and the rest moves to the new "not yet published" line, with the two summing to today's figure;
- June and July: the sunk-cost line rises;
- (a) and (b): no live change today; they are guards for the next deactivation and for Hatch coming onto the roster.

---

### Decisions (made here, each pinned by a test)

**D1. Who is priced: every holder of a LIVE assignment on a block at THIS studio in the month.**
- Membership, `active` and `deleted_at` do not matter.
- The holder set comes from the blocks (`liveHolderIds`), never from `profile_locations`.
- A contractor from the sibling studio (or from another organisation) who covers a class here is paid for that shift, and this studio's budget is what they were rostered against. Their shifts at the OTHER studio are that studio's spend, because each block has one `location_id`.
- A tombstoned contractor's past shifts stay priced: mig 622 keeps `full_name` and pay and removes only shifts that had not started.
- "Live" is `isLiveAssignment` (`src/lib/roster.js:440`, status ≠ `cancelled`), through `liveAssignments` in `blocksToShiftRows`. That is the LABOUR.1 rule, and `swapped` rows count.
- Tests: Task 2 (deactivated, tombstoned, unknown holder), Task 3 (sibling holder, no `profile_locations` read), Task 5 (the gate).

**D2. Which shifts: the headline is PUBLISHED. The rest is shown, not hidden.**
- `contractorCostEur`, `overBudget`, `remainingEur` and `utilisationPct` count blocks whose roster status is `published` (LABOUR.1 and the gate's rule for money already committed).
- Everything else (no roster, `draft`, `superseded`) is summed into a new `unpublishedContractorCostEur`, with `projectedContractorCostEur` = published + unpublished and `projectedOverBudget` beside it.
- Why not published-only with nothing else: on prod, October is being drafted (131 of 145 blocks have no roster). A published-only panel would read almost €0 while a manager builds a month that may run over. Today's panel does show that number, so nothing is taken away. It is now labelled as what it is.
- The panel's "Spent" label becomes **"Published"**, and one line under it reads "€X more in shifts not yet published." (plus ": €Y over budget once published" when only the projection is over).
- The FTE sunk-cost line counts published shifts only (the same headline rule; there is no unpublished FTE figure, YAGNI).
- Tests: Task 2, Task 6.

**D3. The month comes from the Dublin calendar string.**
- `summarizeMonth` takes `referenceDate` as `'YYYY-MM-DD'` and uses `monthBounds` (`shared/roster-month.js:14-19`: `T00:00:00Z` plus UTC getters, pure string arithmetic). The server uses the same call to scope its read.
- A `Date` (or any other shape) throws `TypeError`, so a future caller cannot bring the local-parse bug back. The only caller passes the route's `realIsoDate`-validated string.
- Tests: October 2026 (the clocks go back on Sunday 25 Oct) under `TZ=Europe/Dublin` and `TZ=America/Los_Angeles`, for reference dates 1, 25 and 31 Oct. 30 Sep and 1 Nov are out, the 1st and the 31st are in. Task 4.

**D4. Pay is read by holder from `profile_compensation`, and the type from `profiles` by named columns, in ONE helper shared with the gate.**
- `loadHolderPay(db, ids)` is chunked at 200 ids and throws on either read failing.
- `profiles` is selected as exactly `'id, employment_type'` (CLAUDE.md "name your columns"; `.in('id', …)` satisfies `tests/staff-tombstone-readers.test.js`).
- Tests: Task 1, and Task 3's "takes rates from profile_compensation" (the fake `profiles` rows carry a decoy `hourly_rate: 999` that must never be priced).

**D5. A mid-month change of employment type: the CURRENT type prices every shift of the month.**
- `profiles.employment_type` is one column with no history (migs 012, 070; no audit or effective-dated table), and `profile_compensation` keeps no rate history either.
- So someone who switched from contractor to employee on the 15th has the whole month's shifts priced as an employee (sunk cost, not contractor spend), and the reverse switch prices the whole month as contractor.
- The gate, LABOUR.1 and the invoice review share this limit. Fixing it needs an effective-dated employment record, which is a feature. Open question 2.
- Test: Task 2.

**D6. Admin shifts stay at €0 in contractor spend and in the gate (SHIFTTYPE.1, Richard 25 Sep; unchanged).**
- They are €0 in the unpublished figure too.
- An employee's admin hours still carry sunk cost.
- This is the deliberate difference from LABOUR.1, which pays contractors for admin shifts.
- Tests: the existing SHIFTTYPE.1 month tests are kept (adapted to the new signature), plus one new case for an unpublished admin shift.

**D7. Hours are `shiftHours`: rostered wall-clock hours, not elapsed time.**
- The publish gate (`blockContractorCost`), the invoice review (`computeScheduledForPeriod`) and payroll all price this way, and so do contractors' invoices.
- A shift ending `24:00` counts once A1 lands.
- A 01:00-03:00 shift on 25 Oct 2026 is priced at 2 hours, although 3 real hours pass. LABOUR.1 measures elapsed time with `workingWindow`, so the two disagree on that shift only. No shift that early exists.
- Tests: Task 2 (A1's `24:00` month case, adapted in (d); the clocks-back case).

**D8. What leaves the server is totals only. The route's response is pinned to an exact key list.**
- The response today: `monthStartIso, monthEndIso, contractorCostEur, fteImplicitCostEur, monthlyBudgetEur, remainingEur, overBudget, utilisationPct`.
- Added: `unpublishedContractorCostEur`, `projectedContractorCostEur`, `projectedOverBudget`. All are studio aggregates.
- No per-person figure, name, rate or hours are added. The test stringifies the result and refuses any `rate`, `salary`, `profile` or holder id.
- The existing residual (head coaches see totals, and a studio with a single contractor in a month exposes hours × rate) is unchanged. Open question 4.
- Test: Task 3.

**D9. The publish gate prices the same people as the panel, and reads every holder's leave in both modes.**
- `loadBudgetContext` builds `contractorRateById` from `loadHolderPay(liveHolderIds(monthBlocks))` instead of this studio's `profile_locations` embed.
- The leave read scopes to this studio's members plus every holder in BOTH modes. Before, the scope covered members plus holders only with `advisories: true` (`roster-publish.js:150-152, 169`). A guest contractor is now billed, so their approved leave must also be seen, or the gate would charge them while they are off, and only on the `advisories: false` path (the approvals queue and the batch).
- The existing test that pinned "the leave scope as it was" for `advisories: false` (`roster-publish.test.js:700-717`) is changed on purpose: it now expects the holder in the scope, and still the same money both ways.
- Who is priced changes only when a non-member holds a contractor shift, and rates change only if the two pay copies drift. Prod has 0 of either (above).
- Tests: Task 5.

**D10. A failed read is an error, never €0.**
- `loadHolderPay` throws. The block read goes through `selectAll`, which throws, and the location read keeps its `LOCATION_NOT_FOUND`.
- The route answers 500, and the calendar already shows "Could not be loaded" for a failed spend read (ROSTERLOAD.1, `RosterSummaryPanel.jsx:181`).
- In the gate, a pay failure throws `Pay lookup failed: …` like its other budget inputs; the POST route answers 500, and the batch fails that location's drafts only (ROSTERTIDY.1).
- Tests: Tasks 1, 3, 5.

**D11. The block read pages** (`selectAll`, ordered by `id`). Test: Task 3 (1,001 blocks, two pages, the second one priced).

**D12. Leave is NOT applied to the panel (unchanged).** The gate skips a contractor on approved leave (`roster-publish.js:310`), but the panel does not, and never has; the index row does not ask for it. The two can therefore differ on a shift rostered during approved leave, which the FTE bars already flag as a roster bug ("Rostered on leave"). Open question 3.

---

### Files

| File | Responsibility |
|---|---|
| `src/lib/shift-holder-pay.js` (create) | `liveHolderIds(blocks)`, `loadHolderPay(db, ids)` |
| `src/lib/shift-holder-pay.test.js` (create) | ids, named columns, chunking, both reads throw |
| `src/lib/roster-summary.js` (modify: header 16-24; `blocksToShiftRows` 129-166; `summarizeMonth` 316-365; imports 26-29) | rows carry `published`; `summarizeMonth({ blocks, pay, referenceDate, monthlyBudgetEur })` |
| `src/lib/roster-summary.test.js` (modify: `summarizeMonth` describe 414-489; SHIFTTYPE.1 month cases 593-610; `blocksToShiftRows` describe 495-586 gains one case; a new describe after 489; A1's appended PAYROLL24.1 month case) | the new signature and every D1-D7 rule |
| `src/lib/roster-summary.test-helpers.js` (create) | `spendBlock`, `fakeSpendDb`, the October 2026 fixture (not a test file: vitest only collects `*.test.js`) |
| `src/lib/roster-summary-server.js` (rewrite; 112 lines today) | Dublin month, paged block read with roster status, pay by holder |
| `src/lib/roster-summary-server.test.js` (rewrite; 46 lines today) | D1, D4, D8, D10, D11, and the SHIFTTYPE.1 case kept |
| `src/lib/roster-summary.month.tz.test.js` (create) | October 2026 under `Europe/Dublin` |
| `src/lib/roster-summary.month.tz-us.test.js` (create) | October 2026 under `America/Los_Angeles` |
| `src/lib/roster-publish.js` (modify: imports 20-29; `loadBudgetContext` 103-116, 145-152, 164-169) | D9 |
| `src/lib/roster-publish.test.js` (modify: `mockDb` 60-190; new describe after the `projectPublishImpact` describe that ends at line 351; the case at 700-717; the batch case at 905-913) | D9 |
| `src/components/RosterSummaryPanel.jsx` (modify: header 15-18; after line 94; label at 200; a line between 230 and 232) | "Published" + the unpublished line |
| `src/components/RosterSummaryPanel.spendmonth.test.jsx` (modify) | the label and the line |
| `src/app/api/schedule/contractor-spend/route.js` (modify: header 13-22 only) | document the response keys |
| `docs/CHANGELOG.md` (modify) | one row, after `gh pr create` |

**Naming traps.** `tests/shared-pair-sync.test.js` fails when the same export name appears in both `shared/` and `src/lib/`. Checked while planning (no hits). Re-run before Task 1:

```bash
git grep -nE "loadHolderPay|liveHolderIds|shift-holder-pay|unpublishedContractorCostEur|projectedContractorCostEur|projectedOverBudget|spendBlock|fakeSpendDb" -- shared src mobile tests
```

Expected: no output.

---

### Task 0: Setup and the A1 precondition

- [ ] **Step 1: Fresh worktree off `origin/main`** (standing rule: never a shared worktree; 8GB machine, so no dev server).

```bash
cd ~/code/un1t-crm && git fetch origin main && git worktree add ../un1t-crm-contractorspend1 -b contractorspend-1 origin/main && cd ../un1t-crm-contractorspend1 && npm ci
```

- [ ] **Step 2: Confirm A1 PAYROLL24.1 has merged.**

```bash
git log origin/main --oneline --grep 'PAYROLL24.1' | head -1
git show origin/main:src/lib/payroll.js | sed -n '/export function timeToHours/,/^}/p'
```

```bash
git show origin/main:src/lib/roster-summary.test.js | grep -n "a shift ending at 24:00 (PAYROLL24.1)"
```

Expected: one commit line, a `timeToHours` that accepts exactly `24:00` / `24:00:00`, and one grep hit (A1's appended describe, which Task 2 (d) adapts). If there is no commit, **stop**: build Tasks 1-6 anyway (skipping 2(d)), but do not open the PR until A1 is on `main`, then rebase and do 2(d).

---

### Task 1: `loadHolderPay`, pay for the people who hold the shifts

**Files:**
- Create: `src/lib/shift-holder-pay.js`
- Test: `src/lib/shift-holder-pay.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/shift-holder-pay.test.js
// CONTRACTORSPEND.1 — pay is read for the people who HOLD shifts, never for a
// studio's member list: type from profiles by named columns, pay from
// profile_compensation (mig 152's canonical copy). A failed read throws.
import { describe, it, expect } from 'vitest'
import { loadHolderPay, liveHolderIds } from './shift-holder-pay'

function fakeDb({ profiles = [], comp = [], fail = {} } = {}) {
  const reads = []
  return {
    reads,
    from(table) {
      const q = { table, select: null, col: null, ids: null }
      reads.push(q)
      const chain = {
        select(s) { q.select = s; return chain },
        in(col, ids) { q.col = col; q.ids = ids; return chain },
        then(res, rej) {
          let out
          if (fail[table]) out = { data: null, error: { message: `${table} unreadable` } }
          else if (table === 'profiles') out = { data: profiles.filter((p) => q.ids.includes(p.id)), error: null }
          else if (table === 'profile_compensation') out = { data: comp.filter((c) => q.ids.includes(c.profile_id)), error: null }
          else out = { data: null, error: { message: `unexpected table ${table}` } }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return chain
    },
  }
}

describe('liveHolderIds', () => {
  it('lists each live holder once, skipping cancelled rows and missing ids', () => {
    const blocks = [
      { shift_assignments: [{ profile_id: 'a', status: 'scheduled' }, { profile_id: 'b', status: 'cancelled' }] },
      { shift_assignments: [{ profile_id: 'a', status: 'swapped' }, { profile_id: null }, { profile_id: 'c' }] },
      { shift_assignments: null },
    ]
    expect(liveHolderIds(blocks)).toEqual(['a', 'c'])
    expect(liveHolderIds(null)).toEqual([])
  })
})

describe('loadHolderPay', () => {
  it('takes the type from profiles and the pay from profile_compensation', async () => {
    const db = fakeDb({
      // hourly_rate on profiles is the DEPRECATED copy: it must never be used.
      profiles: [{ id: 'dan', employment_type: 'contractor', hourly_rate: 999 }, { id: 'sam', employment_type: 'fte' }],
      comp: [
        { profile_id: 'dan', hourly_rate: '35.00', annual_salary: null, contracted_hours_per_week: null },
        { profile_id: 'sam', hourly_rate: null, annual_salary: '39000', contracted_hours_per_week: '30' },
      ],
    })
    const pay = await loadHolderPay(db, ['dan', 'sam', 'dan'])
    expect(pay.get('dan')).toEqual({ employment_type: 'contractor', hourly_rate: 35, annual_salary: null, contracted_hours_per_week: null })
    expect(pay.get('sam')).toEqual({ employment_type: 'fte', hourly_rate: null, annual_salary: 39000, contracted_hours_per_week: 30 })
    expect(db.reads.find((q) => q.table === 'profiles').select).toBe('id, employment_type')
  })

  it('a holder with no compensation row has null pay; a holder with no profile row is absent', async () => {
    const db = fakeDb({ profiles: [{ id: 'new', employment_type: 'contractor' }] })
    const pay = await loadHolderPay(db, ['new', 'ghost'])
    expect(pay.get('new')).toEqual({ employment_type: 'contractor', hourly_rate: null, annual_salary: null, contracted_hours_per_week: null })
    expect(pay.has('ghost')).toBe(false)
  })

  it('no ids = no reads', async () => {
    const db = fakeDb()
    expect((await loadHolderPay(db, [])).size).toBe(0)
    expect((await loadHolderPay(db, null)).size).toBe(0)
    expect(db.reads).toEqual([])
  })

  it('chunks the id list at 200 (URL length)', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `p${i}`)
    const db = fakeDb({ profiles: ids.map((id) => ({ id, employment_type: 'contractor' })) })
    const pay = await loadHolderPay(db, ids)
    expect(pay.size).toBe(201)
    expect(db.reads.filter((q) => q.table === 'profiles').map((q) => q.ids.length)).toEqual([200, 1])
  })

  for (const table of ['profiles', 'profile_compensation']) {
    it(`a failed ${table} read throws (never "nobody is paid")`, async () => {
      const db = fakeDb({ profiles: [{ id: 'dan', employment_type: 'contractor' }], fail: { [table]: true } })
      await expect(loadHolderPay(db, ['dan'])).rejects.toThrow(/unreadable/)
    })
  }
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/shift-holder-pay.test.js`
Expected: FAIL, `Failed to resolve import "./shift-holder-pay"`.

- [ ] **Step 3: Write the helper**

```js
// src/lib/shift-holder-pay.js
//
// CONTRACTORSPEND.1 — pay for the people who HOLD shifts.
//
// Contractor spend and the publish budget gate used to look pay up for THIS
// studio's members (profile_locations), so a contractor from the sibling
// studio who covered a class here was priced at €0, and the spend panel also
// skipped anyone deactivated. Pricing belongs to whoever holds the shift, so
// both now read pay for the holders of the blocks they are pricing, through
// this one helper — the two figures cannot disagree about who is paid.
//
// Pay comes from profile_compensation (mig 152, the canonical copy; the
// profiles columns are deprecated, mig 153), through getCompensationForProfiles,
// which throws on a failed read. The type comes from profiles by NAMED columns
// (CLAUDE.md: profiles still carries pay columns, so never select '*').
//
// Server-only (service-role client). Nothing here may reach a browser: callers
// turn it into studio totals.

import { liveAssignments } from './roster'
import { getCompensationForProfiles } from './profile-compensation'

const ID_CHUNK = 200

/** Every profile id holding a LIVE assignment on these blocks, once each. */
export function liveHolderIds(blocks) {
  const ids = new Set()
  for (const b of blocks || []) {
    for (const a of liveAssignments(b?.shift_assignments)) {
      if (a?.profile_id) ids.add(a.profile_id)
    }
  }
  return [...ids]
}

/**
 * @param {object} db  service-role client
 * @param {string[]} profileIds
 * @returns {Promise<Map<string, {
 *   employment_type: string|null, hourly_rate: number|null,
 *   annual_salary: number|null, contracted_hours_per_week: number|null,
 * }>>}  a holder with no profiles row is absent; THROWS on a failed read
 */
export async function loadHolderPay(db, profileIds) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  const out = new Map()
  if (ids.length === 0) return out
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const slice = ids.slice(i, i + ID_CHUNK)
    const { data, error } = await db.from('profiles').select('id, employment_type').in('id', slice)
    if (error) throw new Error(`profiles read failed: ${error.message || error}`)
    for (const p of data || []) {
      out.set(p.id, { employment_type: p.employment_type ?? null, hourly_rate: null, annual_salary: null, contracted_hours_per_week: null })
    }
  }
  const comp = await getCompensationForProfiles(db, ids)
  for (const [id, c] of comp) {
    const p = out.get(id)
    if (!p) continue
    p.hourly_rate = c.hourly_rate
    p.annual_salary = c.annual_salary
    p.contracted_hours_per_week = c.contracted_hours_per_week
  }
  return out
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/shift-holder-pay.test.js`
Expected: PASS, 8 tests. (`getCompensationForProfiles` turns `'35.00'` into `35`, and on a failed read it throws `profile_compensation read failed: profile_compensation unreadable`, which matches `/unreadable/`.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/shift-holder-pay.js src/lib/shift-holder-pay.test.js
git commit -m "CONTRACTORSPEND.1 — loadHolderPay: pay for the people who hold the shifts

Type from profiles by named columns, pay from profile_compensation (mig 152's
canonical copy), chunked at 200 ids, throws on a failed read. Shared by the
contractor-spend read and the publish gate in the next commits.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `summarizeMonth` prices by holder, published first, from a Dublin date string

**Files:**
- Modify: `src/lib/roster-summary.js` (imports 26-29, header 16-24, `blocksToShiftRows` 129-166, `summarizeMonth` 316-365)
- Test: `src/lib/roster-summary.test.js`

- [ ] **Step 1: Write the failing tests**

(a) Replace the whole `describe('summarizeMonth', …)` block (lines 414-489) with the block below. It keeps every old case under the new signature, and adds the CONTRACTORSPEND.1 cases after it:

```js
// CONTRACTORSPEND.1 — summarizeMonth prices by HOLDER (a Map id → pay, built by
// loadHolderPay), takes a 'YYYY-MM-DD' Dublin calendar date, and counts a shift
// as spend only when its block is on a PUBLISHED roster.
const pub = (b) => ({ ...b, rosters: { status: 'published' } })
const payOf = (...people) => new Map(people.map((p) => [p.id, p]))

describe('summarizeMonth', () => {
  const refMay = '2026-05-15'

  it('zero spend with no blocks', () => {
    const r = summarizeMonth({ blocks: [], pay: payOf(contractorDan), referenceDate: refMay, monthlyBudgetEur: 1000 })
    expect(r.contractorCostEur).toBe(0)
    expect(r.remainingEur).toBe(1000)
    expect(r.overBudget).toBe(false)
    expect(r.utilisationPct).toBe(0)
  })

  it('sums contractor cost across the month, ignores other months', () => {
    const blocks = [
      pub(block({ id: 'in-may', date: '2026-05-04', start: '09:00', end: '12:00', coaches: ['dan'] })), // 3h × 35 = 105
      pub(block({ id: 'in-may-2', date: '2026-05-30', start: '09:00', end: '11:00', coaches: ['dan'] })), // 2h × 35 = 70
      pub(block({ id: 'in-jun', date: '2026-06-01', start: '09:00', end: '12:00', coaches: ['dan'] })), // ignored
      pub(block({ id: 'in-apr', date: '2026-04-30', start: '09:00', end: '12:00', coaches: ['dan'] })), // ignored
    ]
    const r = summarizeMonth({ blocks, pay: payOf(contractorDan), referenceDate: refMay, monthlyBudgetEur: 200 })
    expect(r.monthStartIso).toBe('2026-05-01')
    expect(r.monthEndIso).toBe('2026-05-31')
    expect(r.contractorCostEur).toBe(175)
    expect(r.remainingEur).toBe(25)
    expect(r.overBudget).toBe(false)
    expect(r.utilisationPct).toBe(88)
  })

  it('flags overBudget when spend > budget', () => {
    const blocks = [pub(block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '13:00', coaches: ['dan'] }))] // 4h × 35 = 140
    const r = summarizeMonth({ blocks, pay: payOf(contractorDan), referenceDate: refMay, monthlyBudgetEur: 100 })
    expect(r.overBudget).toBe(true)
    expect(r.remainingEur).toBe(-40)
    expect(r.utilisationPct).toBe(140)
  })

  it('handles null budget — returns spend total only, no over/under', () => {
    const blocks = [pub(block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '12:00', coaches: ['dan'] }))]
    const r = summarizeMonth({ blocks, pay: payOf(contractorDan), referenceDate: refMay, monthlyBudgetEur: null })
    expect(r.contractorCostEur).toBe(105)
    expect(r.monthlyBudgetEur).toBeNull()
    expect(r.remainingEur).toBeNull()
    expect(r.overBudget).toBe(false)
    expect(r.projectedOverBudget).toBe(false)
    expect(r.utilisationPct).toBeNull()
  })

  // ROSTER-HOURS.1 — contractor euros follow the per-assignment window too.
  it("bills a contractor's per-assignment window, not the whole block", () => {
    const blocks = [
      // 8h block; Dan is on it 09:00-12:00 → 3h x EUR 35 = EUR 105, not 8h x 35 = EUR 280.
      pub(block({
        id: 'b1', date: '2026-05-04', start: '09:00', end: '17:00',
        coaches: [{ profile_id: 'dan', start_time_override: '09:00', end_time_override: '12:00' }],
      })),
    ]
    const r = summarizeMonth({ blocks, pay: payOf(contractorDan), referenceDate: refMay, monthlyBudgetEur: 200 })
    expect(r.contractorCostEur).toBe(105)
    expect(r.overBudget).toBe(false)
    expect(r.remainingEur).toBe(95)
  })

  it('exposes FTE implicit cost separately (context, not budget input)', () => {
    const blocks = [pub(block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '13:00', coaches: ['sarah'] }))]
    const r = summarizeMonth({ blocks, pay: payOf(fteSarah), referenceDate: refMay, monthlyBudgetEur: 1000 })
    // 4h × (39000/52/30 = €25/h) = €100
    expect(r.fteImplicitCostEur).toBe(100)
    // FTE doesn't hit the contractor budget
    expect(r.contractorCostEur).toBe(0)
  })
})

describe('CONTRACTORSPEND.1 — who and what summarizeMonth prices', () => {
  const ref = '2026-05-15'
  const may4 = (coaches) => pub(block({ id: 'b-may4', date: '2026-05-04', start: '09:00', end: '11:00', coaches }))
  const admin = (b) => ({ ...b, shift_templates: { ...b.shift_templates, kind: 'admin' } })

  it('prices a contractor deactivated mid-month for the shifts they worked', () => {
    const r = summarizeMonth({ blocks: [may4(['dan'])], pay: payOf({ ...contractorDan, active: false }), referenceDate: ref, monthlyBudgetEur: 100 })
    expect(r.contractorCostEur).toBe(70)
  })

  it('prices a permanently deleted (tombstoned) contractor for the shifts they worked', () => {
    const tomb = { ...contractorDan, active: false, deleted_at: '2026-05-20T10:00:00Z' }
    const r = summarizeMonth({ blocks: [may4(['dan'])], pay: payOf(tomb), referenceDate: ref, monthlyBudgetEur: 100 })
    expect(r.contractorCostEur).toBe(70)
  })

  it('a holder with no pay entry costs nothing and does not throw', () => {
    const r = summarizeMonth({ blocks: [may4(['ghost'])], pay: payOf(contractorDan), referenceDate: ref, monthlyBudgetEur: 100 })
    expect(r.contractorCostEur).toBe(0)
    expect(r.unpublishedContractorCostEur).toBe(0)
  })

  it('counts published shifts as spend and the rest (no roster, draft, superseded) as not yet published', () => {
    const blocks = [
      pub(block({ id: 'p', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['dan'] })), // 70 published
      block({ id: 'none', date: '2026-05-05', start: '09:00', end: '12:00', coaches: ['dan'] }), // 105, no roster
      { ...block({ id: 'draft', date: '2026-05-06', start: '09:00', end: '10:00', coaches: ['dan'] }), rosters: { status: 'draft' } }, // 35
      { ...block({ id: 'sup', date: '2026-05-07', start: '09:00', end: '10:00', coaches: ['dan'] }), rosters: { status: 'superseded' } }, // 35
    ]
    const r = summarizeMonth({ blocks, pay: payOf(contractorDan), referenceDate: ref, monthlyBudgetEur: 200 })
    expect(r.contractorCostEur).toBe(70)
    expect(r.unpublishedContractorCostEur).toBe(175)
    expect(r.projectedContractorCostEur).toBe(245)
    expect(r.overBudget).toBe(false)
    expect(r.remainingEur).toBe(130)
    expect(r.utilisationPct).toBe(35)
    expect(r.projectedOverBudget).toBe(true)
  })

  it('a cancelled assignment costs nothing, published or not', () => {
    const cancelled = { profile_id: 'dan', status: 'cancelled' }
    const blocks = [
      pub(block({ id: 'p', date: '2026-05-04', start: '09:00', end: '11:00', coaches: [cancelled] })),
      block({ id: 'u', date: '2026-05-05', start: '09:00', end: '11:00', coaches: [cancelled] }),
    ]
    const r = summarizeMonth({ blocks, pay: payOf(contractorDan), referenceDate: ref, monthlyBudgetEur: 100 })
    expect(r.contractorCostEur).toBe(0)
    expect(r.unpublishedContractorCostEur).toBe(0)
  })

  it('an admin shift stays out of both contractor figures (SHIFTTYPE.1)', () => {
    const blocks = [
      admin(pub(block({ id: 'ap', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['dan'] }))),
      admin(block({ id: 'au', date: '2026-05-05', start: '09:00', end: '11:00', coaches: ['dan'] })),
    ]
    const r = summarizeMonth({ blocks, pay: payOf(contractorDan), referenceDate: ref, monthlyBudgetEur: 100 })
    expect(r.contractorCostEur).toBe(0)
    expect(r.unpublishedContractorCostEur).toBe(0)
  })

  it('FTE implicit cost counts published shifts, whoever holds them, active or not', () => {
    const blocks = [
      pub(block({ id: 'p', date: '2026-05-04', start: '09:00', end: '13:00', coaches: ['sarah'] })), // 4h × 25 = 100
      block({ id: 'u', date: '2026-05-05', start: '09:00', end: '13:00', coaches: ['sarah'] }), // unpublished: not costed
    ]
    const r = summarizeMonth({ blocks, pay: payOf({ ...fteSarah, active: false }), referenceDate: ref, monthlyBudgetEur: 1000 })
    expect(r.fteImplicitCostEur).toBe(100)
    expect(r.contractorCostEur).toBe(0)
  })

  it("prices every shift of the month by the holder's CURRENT employment type (no history exists)", () => {
    // Dan was a contractor until the 10th and an employee after. profiles keeps
    // ONE employment_type, so the whole month reads as an employee (D5).
    const blocks = [
      pub(block({ id: 'early', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['dan'] })),
      pub(block({ id: 'late', date: '2026-05-20', start: '09:00', end: '11:00', coaches: ['dan'] })),
    ]
    const nowEmployee = { ...contractorDan, employment_type: 'fte', hourly_rate: null, annual_salary: 39000, contracted_hours_per_week: 30 }
    const r = summarizeMonth({ blocks, pay: payOf(nowEmployee), referenceDate: ref, monthlyBudgetEur: 100 })
    expect(r.contractorCostEur).toBe(0)
    expect(r.fteImplicitCostEur).toBe(100) // 4h × 25
  })

  it('refuses a Date reference: the month comes from the Dublin calendar string', () => {
    expect(() => summarizeMonth({ blocks: [], pay: new Map(), referenceDate: new Date('2026-05-15T12:00:00'), monthlyBudgetEur: null }))
      .toThrow(TypeError)
    expect(() => summarizeMonth({ blocks: [], pay: new Map(), referenceDate: '15/05/2026', monthlyBudgetEur: null }))
      .toThrow(TypeError)
  })

  it('a shift across the clocks-back hour is priced at its ROSTERED hours (D7)', () => {
    // 25 Oct 2026, Dublin: 02:00 IST becomes 01:00 GMT, so 01:00-03:00 is three
    // real hours. Contractor spend prices rostered hours (payroll's shiftHours),
    // as the publish gate and the invoice review do: 2h.
    const blocks = [pub(block({ id: 'dst', date: '2026-10-25', start: '01:00', end: '03:00', coaches: ['dan'] }))]
    const r = summarizeMonth({ blocks, pay: payOf(contractorDan), referenceDate: '2026-10-25', monthlyBudgetEur: null })
    expect(r.monthStartIso).toBe('2026-10-01')
    expect(r.monthEndIso).toBe('2026-10-31')
    expect(r.contractorCostEur).toBe(70)
  })
})
```

(b) In the `describe('SHIFTTYPE.1 — admin shifts in the week and month summaries', …)` block, replace line 593 (`const refMay = new Date('2026-05-15T12:00:00')`) and the two `summarizeMonth:` cases (lines 595-610) with:

```js
  const refMay = '2026-05-15'
  const published = (b) => ({ ...b, rosters: { status: 'published' } })
  const payOfMonth = (...people) => new Map(people.map((p) => [p.id, p]))

  it('summarizeMonth: a contractor on an admin shift costs the budget nothing', () => {
    const blocks = [
      published(block({ id: 'class', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['dan'] })), // 2h x 35 = 70
      published(asAdmin(block({ id: 'admin', date: '2026-05-05', start: '09:00', end: '13:00', coaches: ['dan'] }))), // not priced
    ]
    const r = summarizeMonth({ blocks, pay: payOfMonth(contractorDan), referenceDate: refMay, monthlyBudgetEur: 100 })
    expect(r.contractorCostEur).toBe(70)
    expect(r.remainingEur).toBe(30)
    expect(r.overBudget).toBe(false)
  })

  it('summarizeMonth: an FTE on an admin shift still carries implicit cost (hours are hours)', () => {
    const blocks = [published(asAdmin(block({ id: 'admin', date: '2026-05-04', start: '09:00', end: '13:00', coaches: ['sarah'] })))]
    const r = summarizeMonth({ blocks, pay: payOfMonth(fteSarah), referenceDate: refMay, monthlyBudgetEur: 1000 })
    expect(r.fteImplicitCostEur).toBe(100) // 4h x EUR 25
  })
```

(`pub`/`payOf` are module-level consts from (a); the SHIFTTYPE block uses its own names so the edit does not depend on where (a) sits. `weekStart` and `today` stay; they are used by the `summarizeWeek` cases below them.)

(c) In `describe('blocksToShiftRows', …)` (495-586), add this case after the first `it(...)`:

```js
  it("CONTRACTORSPEND.1 — marks each row published or not, from its block's roster", () => {
    const rows = blocksToShiftRows([
      { ...b, rosters: { status: 'published' } },
      { ...b, id: 'b2', rosters: { status: 'draft' } },
      { ...b, id: 'b3', rosters: { status: 'superseded' } },
      { ...b, id: 'b4' },
    ])
    expect(rows.map((r) => r.published)).toEqual([true, false, false, false])
  })
```

(d) **A1's appended case.** A1 PAYROLL24.1 appends `describe('a shift ending at 24:00 (PAYROLL24.1)', …)` at the end of this file (A1 plan, Task 2 Step 2). Its `summarizeMonth prices its 2 contractor hours` case calls the OLD signature (`staff: [contractorDan]`, `referenceDate: new Date(…)`, a block with no roster). Under this PR it would throw `TypeError`, and it would price €0 even without the throw, because the block is not published. It is A2's to adapt; A1's intent is unchanged. In that describe, delete the line `const refMay = new Date('2026-05-15T12:00:00')` (its only user is this case, and `lint` refuses an unused const), and replace the case with:

```js
  it('summarizeMonth prices its 2 contractor hours', () => {
    // CONTRACTORSPEND.1 — pay keyed by holder, a Dublin date string, and a
    // PUBLISHED block (only published shifts are spend).
    const blocks = [{ ...block({ id: 'late', date: '2026-05-04', start: '22:00:00', end: '24:00:00', coaches: ['dan'] }), rosters: { status: 'published' } }]
    const r = summarizeMonth({ blocks, pay: new Map([['dan', contractorDan]]), referenceDate: '2026-05-15', monthlyBudgetEur: 100 })
    expect(r.contractorCostEur).toBe(70) // 2h × €35
    expect(r.remainingEur).toBe(30)
  })
```

Leave that describe's `summarizeWeek` case exactly as A1 wrote it. This case stays the only `24:00` pin for contractor spend, so A2 adds no second one.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/roster-summary.test.js`
Expected: FAIL.
- Most new and rewritten `summarizeMonth` cases get `contractorCostEur` 0 (the old code loops over `staff`, which is undefined now).
- The `TypeError` case does not throw.
- The `published` case gets `undefined`s.
- A1's adapted 24:00 month case gets 0.

`summarizeWeek`, `leaveHoursInWeek`, A1's week case and the other `blocksToShiftRows` cases still pass.

- [ ] **Step 3: Implement**

In `src/lib/roster-summary.js`:

Imports (lines 26-29) become:

```js
import { shiftHours, implicitHourlyRate } from './payroll'
import { addDays, formatDate, liveAssignments } from './roster'
import { effectiveOverride } from './roster-read'
import { shiftKindOf, isAdminShift } from '@shared/shift-kind'
import { monthBounds } from '@shared/roster-month'
```

Append to the header's budget-model comment (after line 24):

```js
//   - CONTRACTORSPEND.1 (27 Sep 2026): the MONTH figure prices every live
//     assignment at this studio by whoever HOLDS it (active, deactivated,
//     deleted, or a member of another studio: pay comes in keyed by holder),
//     counts only PUBLISHED shifts as spend and reports the rest beside it,
//     and takes its month from the Dublin calendar string, never a Date.
```

In `blocksToShiftRows`, add one field right after `location_id: block.location_id,` (line 138):

```js
        // CONTRACTORSPEND.1 — contractor spend counts a shift as spend only on a
        // PUBLISHED roster (no roster, a draft or a stood-down 'superseded' one
        // is not yet spend). Nothing that counts HOURS looks at it.
        published: block.rosters?.status === 'published',
```

Replace `summarizeMonth` and its doc comment (lines 316-365) with:

```js
/**
 * Contractor cost for the calendar month containing `referenceDate`, against
 * the location's monthly_contractor_budget_eur (null = not configured).
 *
 * CONTRACTORSPEND.1 — three rules changed, each of which dropped worked shifts:
 *   - WHO: every live assignment on these blocks is priced by its HOLDER, found
 *     in `pay` (loadHolderPay, keyed by profile id). It used to loop over this
 *     studio's ACTIVE members, so a contractor deactivated mid-month, one from
 *     the sibling studio covering a class, and a deleted one all cost €0.
 *   - WHICH: `contractorCostEur` (and overBudget / remainingEur /
 *     utilisationPct) counts PUBLISHED shifts; everything else is
 *     `unpublishedContractorCostEur`, with the projection beside it, so a month
 *     still being drafted shows where it is heading without calling it spent.
 *   - WHEN: `referenceDate` is a 'YYYY-MM-DD' Dublin calendar date and the
 *     month is string arithmetic (monthBounds). It was `new Date(referenceDate)`
 *     read with local getters: UTC midnight, so west of UTC the 1st was the
 *     month before and the sum came back €0. A Date is refused.
 * SHIFTTYPE.1 unchanged: an admin shift costs the contractor budget nothing.
 * Employment type is the holder's CURRENT one for the whole month (no history).
 *
 * @param {object} args
 * @param {object[]} args.blocks  shift_blocks with rosters(status), shift_templates, shift_assignments
 * @param {Map<string, {employment_type, hourly_rate, annual_salary, contracted_hours_per_week}>} args.pay
 * @param {string} args.referenceDate  YYYY-MM-DD inside the month
 * @param {number|string|null} args.monthlyBudgetEur
 */
export function summarizeMonth({ blocks, pay, referenceDate, monthlyBudgetEur }) {
  if (typeof referenceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
    throw new TypeError('summarizeMonth: referenceDate must be a YYYY-MM-DD string (a Dublin calendar date)')
  }
  const { monthStartIso, monthEndIso } = monthBounds(referenceDate)

  const monthBlocks = (blocks || []).filter(
    b => b.block_date >= monthStartIso && b.block_date <= monthEndIso
  )

  let contractorCostEur = 0
  let unpublishedContractorCostEur = 0
  let fteImplicitCostEur = 0  // FTE doesn't hit the budget but we expose it for context
  for (const r of blocksToShiftRows(monthBlocks)) {
    const person = pay?.get(r.profile_id)
    if (!person) continue
    const hours = shiftHours(r)
    if (person.employment_type === 'contractor') {
      // SHIFTTYPE.1 — admin shifts are out of the contractor budget.
      if (r.kind === 'admin') continue
      const cost = hours * (Number(person.hourly_rate) || 0)
      if (r.published) contractorCostEur += cost
      else unpublishedContractorCostEur += cost
    } else if (person.employment_type === 'fte' && r.published) {
      fteImplicitCostEur += hours * implicitHourlyRate(person)
    }
  }

  const projected = contractorCostEur + unpublishedContractorCostEur
  const budget = monthlyBudgetEur != null ? Number(monthlyBudgetEur) : null
  const remaining = budget != null ? budget - contractorCostEur : null
  const overBudget = budget != null && contractorCostEur > budget
  const utilisationPct = budget != null && budget > 0
    ? Math.round((contractorCostEur / budget) * 100)
    : null

  return {
    monthStartIso,
    monthEndIso,
    contractorCostEur: round2(contractorCostEur),
    unpublishedContractorCostEur: round2(unpublishedContractorCostEur),
    projectedContractorCostEur: round2(projected),
    fteImplicitCostEur: round2(fteImplicitCostEur),
    monthlyBudgetEur: budget,
    remainingEur: remaining != null ? round2(remaining) : null,
    overBudget,
    projectedOverBudget: budget != null && projected > budget,
    utilisationPct,
  }
}
```

(`sumHoursForProfile` stays; `summarizeWeek` still uses it. `implicitHourlyRate` reads `employment_type`, `annual_salary` and `contracted_hours_per_week`, which are exactly the fields `loadHolderPay` returns.)

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/lib/roster-summary.test.js`
Expected: PASS, whole file. If A1's describe is missing, A1 is not on this branch (Task 0 Step 2): skip (d) and rebase before the PR gate.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-summary.js src/lib/roster-summary.test.js
git commit -m "CONTRACTORSPEND.1 — summarizeMonth prices by holder, published first, from a Dublin date

Pay arrives keyed by the shift's holder, so a deactivated, deleted or
sibling-studio contractor is no longer priced at EUR 0. Published shifts are
the spend; drafts and rosterless shifts are reported beside it. The month is
monthBounds() string arithmetic; a Date reference now throws (it read the
previous month west of UTC). blocksToShiftRows rows carry published.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: the spend read: Dublin month, paged, priced by holder

**Files:**
- Create: `src/lib/roster-summary.test-helpers.js`
- Rewrite: `src/lib/roster-summary-server.js`
- Rewrite: `src/lib/roster-summary-server.test.js`

- [ ] **Step 1: Write the shared fixtures** (the Task 4 timezone files reuse them)

```js
// src/lib/roster-summary.test-helpers.js
//
// CONTRACTORSPEND.1 — fixtures for the contractor-spend tests. Not a test file
// (vitest collects *.test.js only). Holder ids are 'dan' (a member here) and
// 'gus' (a member of the sibling studio only).

/** A shift_blocks row as the spend read selects it. */
export function spendBlock(id, date, start, end, holders = ['dan'], { kind = 'class', roster = { status: 'published' }, location = 'loc1' } = {}) {
  return {
    id,
    location_id: location,
    template_id: 't',
    block_date: date,
    start_time: start,
    end_time: end,
    rosters: roster,
    shift_templates: { start_time: start, end_time: end, kind },
    shift_assignments: holders.map((h, i) => (typeof h === 'string'
      ? { id: `a-${id}-${i}`, profile_id: h, status: 'scheduled' }
      : { id: `a-${id}-${i}`, status: 'scheduled', ...h })),
  }
}

/**
 * The service-role client, as far as computeMonthlyContractorSpend uses it.
 * `profiles` rows are returned WHOLE, decoy pay columns included, so a reader
 * that priced from profiles instead of profile_compensation would show.
 * Any other table answers an error (a membership read must not happen).
 */
export function fakeSpendDb({ location = { id: 'loc1', monthly_contractor_budget_eur: 100 }, blocks = [], profiles = [], comp = [], fail = {} } = {}) {
  const queries = []
  const from = (name) => {
    const q = { table: name, select: null, eq: {}, gte: {}, lte: {}, in: {}, order: [], range: null }
    queries.push(q)
    const result = () => {
      if (fail[name]) return { data: null, error: { message: `${name} unreadable` } }
      if (name === 'shift_blocks') {
        const rows = blocks
          .filter((b) => q.eq.location_id == null || b.location_id === q.eq.location_id)
          .filter((b) => b.block_date >= q.gte.block_date && b.block_date <= q.lte.block_date)
        return { data: q.range ? rows.slice(q.range[0], q.range[1] + 1) : rows, error: null }
      }
      if (name === 'profiles') return { data: profiles.filter((p) => q.in.id.includes(p.id)), error: null }
      if (name === 'profile_compensation') return { data: comp.filter((c) => q.in.profile_id.includes(c.profile_id)), error: null }
      return { data: null, error: { message: `unexpected table ${name}` } }
    }
    const chain = {
      select(s) { q.select = s; return chain },
      eq(c, v) { q.eq[c] = v; return chain },
      gte(c, v) { q.gte[c] = v; return chain },
      lte(c, v) { q.lte[c] = v; return chain },
      in(c, v) { q.in[c] = v; return chain },
      order(c, o) { q.order.push([c, o?.ascending !== false]); return chain },
      range(a, b) { q.range = [a, b]; return chain },
      single() {
        if (name !== 'locations') throw new Error(`single() on ${name}`)
        return Promise.resolve(fail.locations
          ? { data: null, error: { message: 'locations unreadable' } }
          : { data: location, error: null })
      },
      then(res, rej) { return Promise.resolve(result()).then(res, rej) },
    }
    return chain
  }
  return {
    from,
    queries,
    tables: () => queries.map((q) => q.table),
    selectOf: (table) => queries.find((q) => q.table === table)?.select ?? null,
    blockQueries: () => queries.filter((q) => q.table === 'shift_blocks'),
  }
}

// ── October 2026: the clocks go back on Sunday 25 Oct ────────────────────────
// Dan, EUR 35/h: 1 Oct 2h + 25 Oct 3h + 31 Oct 2h = 7h = EUR 245.
// 30 Sep and 1 Nov must never count.
export const OCT_BLOCKS = [
  spendBlock('sep30', '2026-09-30', '09:00', '11:00'),
  spendBlock('oct01', '2026-10-01', '09:00', '11:00'),
  spendBlock('oct25', '2026-10-25', '09:00', '12:00'),
  spendBlock('oct31', '2026-10-31', '18:00', '20:00'),
  spendBlock('nov01', '2026-11-01', '09:00', '11:00'),
]
export const OCT_PROFILES = [{ id: 'dan', employment_type: 'contractor' }]
export const OCT_COMP = [{ profile_id: 'dan', hourly_rate: 35 }]
export const OCT_PAY = new Map([['dan', { employment_type: 'contractor', hourly_rate: 35, annual_salary: null, contracted_hours_per_week: null }]])
export const OCT_REFERENCE_DATES = ['2026-10-01', '2026-10-25', '2026-10-31']
export const OCT_EXPECTED = { monthStartIso: '2026-10-01', monthEndIso: '2026-10-31', contractorCostEur: 245 }
```

- [ ] **Step 2: Write the failing tests** (replace the whole of `src/lib/roster-summary-server.test.js`)

```js
// CONTRACTORSPEND.1 — the contractor-spend read prices every live assignment at
// this studio in the Dublin month, by HOLDER (never by membership here), with
// pay from profile_compensation, pages the block read, fails loudly, and
// returns studio totals only.
// SHIFTTYPE.1 (kept) — the read carries each block's template kind, so the
// panel and the publish gate price the same shifts.
import { describe, it, expect } from 'vitest'
import { computeMonthlyContractorSpend } from './roster-summary-server'
import { fakeSpendDb, spendBlock } from './roster-summary.test-helpers'

// hourly_rate 999 on profiles = the DEPRECATED copy; it must never be priced.
const DAN = { id: 'dan', full_name: 'Dan', active: true, employment_type: 'contractor', hourly_rate: 999 }
const GUS = { id: 'gus', full_name: 'Gus', active: true, employment_type: 'contractor', hourly_rate: 999 }
const COMP = [{ profile_id: 'dan', hourly_rate: 35 }, { profile_id: 'gus', hourly_rate: 40 }]
const MAY = { locationId: 'loc1', referenceDate: '2026-05-15' }

describe('computeMonthlyContractorSpend', () => {
  it('SHIFTTYPE.1: selects the template kind and leaves admin shifts out of the spend', async () => {
    const db = fakeSpendDb({
      blocks: [spendBlock('c', '2026-05-04', '09:00', '11:00'), spendBlock('a', '2026-05-05', '09:00', '13:00', ['dan'], { kind: 'admin' })],
      profiles: [DAN], comp: COMP,
    })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(db.selectOf('shift_blocks')).toMatch(/shift_templates\(start_time, end_time, kind\)/)
    expect(r.contractorCostEur).toBe(70)
    expect(r.remainingEur).toBe(30)
  })

  it('prices a contractor from the sibling studio who worked here, and never reads memberships', async () => {
    const db = fakeSpendDb({ blocks: [spendBlock('g', '2026-05-06', '09:00', '11:00', ['gus'])], profiles: [GUS], comp: COMP })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(r.contractorCostEur).toBe(80) // 2h × 40
    expect(db.tables()).not.toContain('profile_locations')
  })

  it('prices a contractor deactivated mid-month', async () => {
    const db = fakeSpendDb({ blocks: [spendBlock('c', '2026-05-04', '09:00', '11:00')], profiles: [{ ...DAN, active: false }], comp: COMP })
    expect((await computeMonthlyContractorSpend({ db, ...MAY })).contractorCostEur).toBe(70)
  })

  it('takes rates from profile_compensation, never from profiles', async () => {
    const db = fakeSpendDb({ blocks: [spendBlock('c', '2026-05-04', '09:00', '11:00')], profiles: [DAN], comp: COMP })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(r.contractorCostEur).toBe(70) // not 2h × 999
    expect(db.selectOf('profiles')).toBe('id, employment_type')
  })

  it('reads the month from the reference string and scopes the block read to this studio', async () => {
    const db = fakeSpendDb({ blocks: [], profiles: [DAN], comp: COMP })
    const r = await computeMonthlyContractorSpend({ db, locationId: 'loc1', referenceDate: '2026-10-01' })
    expect(db.blockQueries()[0]).toMatchObject({
      eq: { location_id: 'loc1' }, gte: { block_date: '2026-10-01' }, lte: { block_date: '2026-10-31' },
    })
    expect(r).toMatchObject({ monthStartIso: '2026-10-01', monthEndIso: '2026-10-31' })
  })

  it('counts published shifts as spend and reports the rest beside it', async () => {
    const db = fakeSpendDb({
      blocks: [
        spendBlock('p', '2026-05-04', '09:00', '11:00'), // 70 published
        spendBlock('u', '2026-05-05', '09:00', '11:00', ['dan'], { roster: null }), // 70, no roster
      ],
      profiles: [DAN], comp: COMP,
    })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(db.selectOf('shift_blocks')).toMatch(/rosters:roster_id \( status \)/)
    expect(r).toMatchObject({ contractorCostEur: 70, unpublishedContractorCostEur: 70, projectedContractorCostEur: 140, overBudget: false, projectedOverBudget: true })
  })

  it('pages the block read past 1,000 rows, ordered by id, and prices the second page', async () => {
    const blocks = Array.from({ length: 1001 }, (_, i) => spendBlock(`b${String(i).padStart(4, '0')}`, '2026-05-04', '09:00', '10:00'))
    const db = fakeSpendDb({ location: { id: 'loc1', monthly_contractor_budget_eur: null }, blocks, profiles: [DAN], comp: COMP })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(db.blockQueries().map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
    for (const q of db.blockQueries()) expect(q.order).toEqual([['id', true]])
    expect(r.contractorCostEur).toBe(35035) // 1,001 × 1h × 35
  })

  for (const table of ['shift_blocks', 'profiles', 'profile_compensation']) {
    it(`a failed ${table} read throws: never a EUR 0 spend`, async () => {
      const db = fakeSpendDb({ blocks: [spendBlock('c', '2026-05-04', '09:00', '11:00')], profiles: [DAN], comp: COMP, fail: { [table]: true } })
      await expect(computeMonthlyContractorSpend({ db, ...MAY })).rejects.toThrow(/unreadable/)
    })
  }

  it('an unreadable location is LOCATION_NOT_FOUND (the route answers 404)', async () => {
    const db = fakeSpendDb({ fail: { locations: true } })
    await expect(computeMonthlyContractorSpend({ db, ...MAY })).rejects.toMatchObject({ code: 'LOCATION_NOT_FOUND' })
  })

  it('returns studio totals only: no per-person figure, name, rate or id', async () => {
    const db = fakeSpendDb({
      blocks: [spendBlock('c', '2026-05-04', '09:00', '11:00', ['dan', 'gus'])],
      profiles: [DAN, GUS], comp: COMP,
    })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(Object.keys(r).sort()).toEqual([
      'contractorCostEur', 'fteImplicitCostEur', 'monthEndIso', 'monthStartIso', 'monthlyBudgetEur',
      'overBudget', 'projectedContractorCostEur', 'projectedOverBudget', 'remainingEur',
      'unpublishedContractorCostEur', 'utilisationPct',
    ])
    expect(JSON.stringify(r)).not.toMatch(/\bdan\b|\bgus\b|rate|salary|profile/i)
  })
})
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run src/lib/roster-summary-server.test.js`
Expected: FAIL. The old code reads `profile_locations`, which the fake answers with an error, so almost every case rejects with `unexpected table profile_locations`. The paging case sees one query with no range.

- [ ] **Step 4: Rewrite `src/lib/roster-summary-server.js`**

```js
// SCHEDULE-SPEND-AGG.1 — server-side contractor-spend aggregation.
//
// summarizeMonth (roster-summary.js) needs every holder's pay to compute
// contractor euro spend, which is HR-sensitive — `/api/staff` withholds rates
// from non-admin roles like head_coach. So the transform runs HERE with the
// service-role client and returns AGGREGATE figures only — no per-coach value
// crosses the wire. Drives /api/schedule/contractor-spend (MANAGER_ROLES at
// the location), so a head coach sees totals and over-budget signals without
// ever being granted anyone's rate.
//
// CONTRACTORSPEND.1 (27 Sep 2026):
//   - the month is monthBounds(referenceDate): string arithmetic on the Dublin
//     calendar date the route validated. It was parsed into a Date here AND in
//     summarizeMonth, and west of UTC the two disagreed (EUR 0);
//   - pay is read for the HOLDERS of the month's shifts (loadHolderPay:
//     profiles by named columns + profile_compensation), not for this studio's
//     members from the deprecated profiles pay columns — a contractor from the
//     sibling studio who covered a class here was priced at EUR 0;
//   - the block read carries roster status (published vs not) and pages.
// Every read failure throws; the route answers 500 and the panel says
// "Could not be loaded" rather than showing EUR 0.

import { summarizeMonth } from './roster-summary'
import { monthBounds } from '@shared/roster-month'
import { selectAll } from './select-all'
import { loadHolderPay, liveHolderIds } from './shift-holder-pay'

/**
 * Monthly contractor spend totals for `locationId` in the month holding
 * `referenceDate`. Returns summarizeMonth's shape — aggregate only.
 *
 * Auth is the caller's responsibility (MANAGER_ROLES at the location).
 *
 * @param {object} args
 * @param {object} args.db            service-role Supabase client
 * @param {string} args.locationId    uuid
 * @param {string} args.referenceDate YYYY-MM-DD inside the target month
 */
export async function computeMonthlyContractorSpend({ db, locationId, referenceDate }) {
  const { monthStartIso, monthEndIso } = monthBounds(referenceDate)

  // Location budget (null = not configured).
  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('id, monthly_contractor_budget_eur')
    .eq('id', locationId)
    .single()
  if (locErr || !loc) {
    const err = new Error('Location not found')
    err.code = 'LOCATION_NOT_FOUND'
    throw err
  }

  // Every block at this studio in the month, with its roster status, template
  // times + kind, and assignments. Paged: PostgREST caps a select at 1,000 rows.
  const blocks = await selectAll((from, to) => db
    .from('shift_blocks')
    .select('id, location_id, block_date, start_time, end_time, template_id, rosters:roster_id ( status ), shift_assignments(id, profile_id, start_time_override, end_time_override, status), shift_templates(start_time, end_time, kind)')
    .eq('location_id', locationId)
    .gte('block_date', monthStartIso)
    .lte('block_date', monthEndIso)
    .order('id', { ascending: true })
    .range(from, to))

  // Pay for whoever holds those shifts — consumed in-memory, never returned.
  const pay = await loadHolderPay(db, liveHolderIds(blocks))

  return summarizeMonth({
    blocks,
    pay,
    referenceDate,
    monthlyBudgetEur: loc.monthly_contractor_budget_eur,
  })
}
```

- [ ] **Step 5: Run the focused suites and watch them pass**

Run: `npx vitest run src/lib/roster-summary-server.test.js src/lib/roster-summary.test.js src/app/api/schedule/contractor-spend/route.test.js`
Expected: PASS. (The route test mocks this helper, so it is unaffected.)

- [ ] **Step 6: `check:select-columns` on the new select**

Run: `npm run check:select-columns`
Expected: exit 0. `shift_blocks.template_id` and `shift_assignments.{id, profile_id, start_time_override, end_time_override, status}` resolve. The aliased `rosters:roster_id ( … )` embed is skipped by the checker's known blind spot (D3 SELCOLS2.1 in the index). `profiles (id, employment_type)` resolves.

- [ ] **Step 7: Commit**

```bash
git add src/lib/roster-summary.test-helpers.js src/lib/roster-summary-server.js src/lib/roster-summary-server.test.js
git commit -m "CONTRACTORSPEND.1 — the spend read prices every holder in the Dublin month

monthBounds() string arithmetic replaces two local Date parses that disagreed
west of UTC. Pay is loaded for the holders of the month's shifts from
profile_compensation, not for this studio's members from the deprecated
profiles columns. The block read carries roster status and pages. Failed
reads throw; the result stays totals only (key list pinned).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: October 2026 under Dublin and Los Angeles

**Files:**
- Create: `src/lib/roster-summary.month.tz.test.js`
- Create: `src/lib/roster-summary.month.tz-us.test.js`

Pattern from `src/lib/report-generator.period.tz-us.test.js`: vitest runs each file in its own worker, so `process.env.TZ` set at the top pins only that file, and the imports are dynamic and awaited after the assignment (a static import would be hoisted above it).

- [ ] **Step 1: Write both files**

```js
// src/lib/roster-summary.month.tz-us.test.js
// CONTRACTORSPEND.1 — the contractor-spend month on a host WEST of UTC. The
// calendar always sends the 1st; summarizeMonth used to parse it as UTC
// midnight and read local getters, which here is 30 Sep 17:00: the read fetched
// October, the sum kept September's blocks (none), and the panel said EUR 0.
process.env.TZ = 'America/Los_Angeles'

import { describe, it, expect } from 'vitest'

const { summarizeMonth } = await import('./roster-summary.js')
const { computeMonthlyContractorSpend } = await import('./roster-summary-server.js')
const H = await import('./roster-summary.test-helpers.js')

describe('contractor spend month — America/Los_Angeles (PDT, UTC-7)', () => {
  it('the host really is on Pacific time', () => {
    expect(new Date('2026-10-01T12:00:00Z').getHours()).toBe(5)
  })

  for (const ref of H.OCT_REFERENCE_DATES) {
    it(`summarizeMonth(${ref}) is October 2026: the 1st and 31st in, 30 Sep and 1 Nov out`, () => {
      const r = summarizeMonth({ blocks: H.OCT_BLOCKS, pay: H.OCT_PAY, referenceDate: ref, monthlyBudgetEur: 300 })
      expect(r).toMatchObject({ ...H.OCT_EXPECTED, remainingEur: 55, overBudget: false })
    })

    it(`the server read for ${ref} asks for 1-31 October and prices it`, async () => {
      const db = H.fakeSpendDb({ location: { id: 'loc1', monthly_contractor_budget_eur: 300 }, blocks: H.OCT_BLOCKS, profiles: H.OCT_PROFILES, comp: H.OCT_COMP })
      const r = await computeMonthlyContractorSpend({ db, locationId: 'loc1', referenceDate: ref })
      expect(db.blockQueries()[0]).toMatchObject({ gte: { block_date: '2026-10-01' }, lte: { block_date: '2026-10-31' } })
      expect(r).toMatchObject({ ...H.OCT_EXPECTED, remainingEur: 55 })
    })
  }
})
```

```js
// src/lib/roster-summary.month.tz.test.js
// CONTRACTORSPEND.1 — the same October 2026 month on a Dublin host. October is
// the clocks-back month (Sunday 25 Oct: 02:00 IST becomes 01:00 GMT); the month
// is calendar strings, so neither end moves and the 25th is an ordinary day.
process.env.TZ = 'Europe/Dublin'

import { describe, it, expect } from 'vitest'

const { summarizeMonth } = await import('./roster-summary.js')
const { computeMonthlyContractorSpend } = await import('./roster-summary-server.js')
const H = await import('./roster-summary.test-helpers.js')

describe('contractor spend month — Europe/Dublin (IST, UTC+1 until 25 Oct)', () => {
  it('the host really is on Dublin time', () => {
    expect(new Date('2026-10-01T12:00:00Z').getHours()).toBe(13)
    expect(new Date('2026-10-26T12:00:00Z').getHours()).toBe(12)
  })

  for (const ref of H.OCT_REFERENCE_DATES) {
    it(`summarizeMonth(${ref}) is October 2026: the 1st and 31st in, 30 Sep and 1 Nov out`, () => {
      const r = summarizeMonth({ blocks: H.OCT_BLOCKS, pay: H.OCT_PAY, referenceDate: ref, monthlyBudgetEur: 300 })
      expect(r).toMatchObject({ ...H.OCT_EXPECTED, remainingEur: 55, overBudget: false })
    })

    it(`the server read for ${ref} asks for 1-31 October and prices it`, async () => {
      const db = H.fakeSpendDb({ location: { id: 'loc1', monthly_contractor_budget_eur: 300 }, blocks: H.OCT_BLOCKS, profiles: H.OCT_PROFILES, comp: H.OCT_COMP })
      const r = await computeMonthlyContractorSpend({ db, locationId: 'loc1', referenceDate: ref })
      expect(db.blockQueries()[0]).toMatchObject({ gte: { block_date: '2026-10-01' }, lte: { block_date: '2026-10-31' } })
      expect(r).toMatchObject({ ...H.OCT_EXPECTED, remainingEur: 55 })
    })
  }
})
```

- [ ] **Step 2: Run both files, then confirm the LA file pins the old bug** (Tasks 2-3 already changed the code, so both files pass. Do not use `git stash` to re-run them against the old code: memory "no git stash in worktrees". Reproduce the old parse directly instead.)

```bash
npx vitest run src/lib/roster-summary.month.tz.test.js src/lib/roster-summary.month.tz-us.test.js
TZ=America/Los_Angeles node -e "const d=new Date('2026-10-01'); console.log(d.getFullYear(), d.getMonth()+1)"
```

Expected: the vitest run is green (both files, 7 tests each), and the node line prints `2026 9`. `2026 9` is the month the old `summarizeMonth` derived (`roster-summary.js:322-324` on `28d02e59`) from the reference the calendar always sends: September, not October. That is exactly what the LA file's `summarizeMonth(2026-10-01)` case now pins against.

- [ ] **Step 3: Commit**

```bash
git add src/lib/roster-summary.month.tz.test.js src/lib/roster-summary.month.tz-us.test.js
git commit -m "CONTRACTORSPEND.1 — pin the October 2026 month under Dublin and Los Angeles

Reference dates 1, 25 (clocks back) and 31 Oct: the 1st and 31st in, 30 Sep and
1 Nov out, for summarizeMonth and the server read, on both sides of UTC.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: the publish gate prices the same people

**Files:**
- Modify: `src/lib/roster-publish.js` (imports 20-29; `loadBudgetContext` 103-116, 145-152, 164-169)
- Test: `src/lib/roster-publish.test.js`

- [ ] **Step 1: Teach the test's `mockDb` to answer the pay reads**

In `src/lib/roster-publish.test.js`:

1. Line 60: add `guests = [], failPay = false` to `mockDb`'s destructured options.
2. Beside `const siblingQueries = []`, add `const payQueries = []` and return it on the object (next to `siblingQueries,`).
3. Add this handler just before `throw new Error('unexpected table: ' + table)` at line 188:

```js
      // CONTRACTORSPEND.1 — pay is read by HOLDER: the type from profiles, the
      // rate from profile_compensation. `contractors` are this studio's members
      // (profile_locations, above); `guests` hold shifts here without being one.
      if (table === 'profiles' || table === 'profile_compensation') {
        const f = { table, select: null, col: null, ids: [] }
        payQueries.push(f)
        const people = [...contractors, ...guests]
        const chain = {
          select: (s) => { f.select = s; return chain },
          in: (c, ids) => { f.col = c; f.ids = ids; return chain },
          then: (onF, onR) => Promise.resolve(failPay
            ? { data: null, error: { message: `${table} unreadable` } }
            : {
              data: people.filter((p) => f.ids.includes(p.id)).map((p) => (table === 'profiles'
                ? { id: p.id, employment_type: p.employment_type }
                : { profile_id: p.id, hourly_rate: p.hourly_rate ?? null, annual_salary: null, contracted_hours_per_week: null, annual_leave_entitlement: null, overtime_rate: null })),
              error: null,
            }).then(onF, onR),
        }
        return chain
      }
```

4. After `const sarah = …` (line 195), add:

```js
const gus = { id: 'gus', employment_type: 'contractor', hourly_rate: 40, active: true } // a member of the SIBLING studio only
```

- [ ] **Step 2: Write the failing tests**

(a) Add a new describe right after the `describe('projectPublishImpact', …)` block (it ends at line 351, just before `// ROSTERVIS.1 — the preview lists empty …`):

```js
// CONTRACTORSPEND.1 — the gate prices whoever HOLDS a shift here (the same
// loader as the contractor-spend panel), and sees every holder's leave in both
// modes, or a guest contractor would be billed while on approved leave.
describe('CONTRACTORSPEND.1 — the gate prices every holder', () => {
  const PERIOD = { locationId: 'loc1', periodStart: '2026-05-04', periodEnd: '2026-05-10', todayIso: '2026-05-01' }

  it('prices a contractor from the sibling studio who holds a shift here', async () => {
    const published = { id: 'r-pub', status: 'published' }
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 100 },
      contractors: [dan],
      guests: [gus],
      blocks: [
        block({ id: 'in', date: '2026-05-06', start: '09:00', end: '11:00', coaches: ['gus'] }), // 2h × 40 = 80
        block({ id: 'out', date: '2026-05-20', start: '09:00', end: '10:00', coaches: ['gus'], roster: published }), // 1h × 40 = 40
      ],
    })
    const r = await projectPublishImpact(db, PERIOD)
    expect(r.periodProjectedEur).toBe(80)
    expect(r.alreadyPublishedEur).toBe(40)
    expect(r.overBudget).toBe(true)
  })

  for (const advisories of [true, false]) {
    it(`a guest contractor on approved leave is not billed (advisories: ${advisories})`, async () => {
      const db = mockDb({
        location: { id: 'loc1', monthly_contractor_budget_eur: null },
        contractors: [dan],
        guests: [gus],
        blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00', coaches: ['gus'] })],
        timeOff: [{ id: 't1', profile_id: 'gus', start_date: '2026-05-06', end_date: '2026-05-06' }],
      })
      const r = await projectPublishImpact(db, { ...PERIOD, advisories })
      expect(db.leaveQueries[0].or).toContain('gus')
      expect(r.periodProjectedEur).toBe(0)
    })
  }

  it('reads pay by holder from profile_compensation, and profiles by named columns only', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: null },
      contractors: [dan, eve],
      blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00', coaches: ['dan'] })],
    })
    await projectPublishImpact(db, PERIOD)
    const profiles = db.payQueries.find((q) => q.table === 'profiles')
    expect(profiles.select).toBe('id, employment_type')
    expect(profiles.ids).toEqual(['dan']) // holders only; eve holds nothing
    expect(db.calls).toContain('profile_compensation')
  })

  it('a failed pay read fails the projection (a budget input), never a EUR 0 price', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 100 },
      contractors: [dan],
      failPay: true,
      blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00', coaches: ['dan'] })],
    })
    await expect(projectPublishImpact(db, PERIOD)).rejects.toThrow(/Pay lookup failed/)
  })

  it('no live holder in the months = no pay read', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 100 },
      contractors: [dan],
      blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00', coaches: [{ profile_id: 'dan', status: 'cancelled' }] })],
    })
    const r = await projectPublishImpact(db, PERIOD)
    expect(db.payQueries).toEqual([])
    expect(r.periodProjectedEur).toBe(0)
  })
})
```

(b) Change the case at lines 700-717 on purpose (D9). Its title and one assertion become:

```js
  it('advisories: false does none of the advisory work: no other-studio query, no lists, the leave scope still covers every holder, the same money', async () => {
```

and, at line 717:

```js
    // CONTRACTORSPEND.1 — guests are PRICED now, so their leave is read in
    // both modes (it used to be members-only here).
    expect(db.leaveQueries[0].or).toContain('guest-1')
```

The rest of that case (no other-studio query, no lists, the same `periodProjectedEur` and `staffingGaps` both ways) stays as it is.

(c) In `it('loads the location ONCE, spanning every month its drafts touch', …)` (905-913), add after the `profile_locations` line:

```js
    expect(db.calls.filter((t) => t === 'profile_compensation')).toHaveLength(1)
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run src/lib/roster-publish.test.js`
Expected: FAIL, 6 tests:
- sibling: `periodProjectedEur` 0, not 80;
- both leave cases: the scope lacks `gus` with advisories off (`toContain('gus')`);
- the named-columns case: no `profiles` pay query;
- the failed-pay case: resolves instead of rejecting;
- the changed `advisories: false` case: the scope lacks `guest-1`;
- the batch case: 0 `profile_compensation` calls.

Every other case passes, because the mock answers the pay reads from the same `contractors` fixture.

- [ ] **Step 4: Implement in `src/lib/roster-publish.js`**

Add to the imports (after line 28, `import { loadWorkingTimeShifts } …`):

```js
import { loadHolderPay, liveHolderIds } from './shift-holder-pay'
```

Replace lines 103-116 (the `profile_locations` read and the `contractorRateById` loop) with:

```js
  // This studio's members. Only their LEAVE is read from this list (a coach on
  // approved leave is not working the shift, LEAVE.2); who is PRICED is decided
  // by who holds the shifts, below (CONTRACTORSPEND.1).
  const { data: links, error: linksErr } = await db
    .from('profile_locations')
    .select('profile_id')
    .eq('location_id', locationId)
  if (linksErr) throw new Error(`Profile lookup failed: ${linksErr.message}`)
```

Replace lines 145-152 (the COPYLEAVE.1 `rosteredIds` comment and declaration) with:

```js
  // CONTRACTORSPEND.1 — price every HOLDER of a live shift here, not only this
  // studio's members: a contractor from the sibling studio covering a class was
  // priced at EUR 0, so their hours never reached the budget. Pay comes from
  // profile_compensation (mig 152's canonical copy; the profiles columns are
  // deprecated) and the type from profiles by named columns, through the SAME
  // loader as the contractor-spend panel, so the two price the same people.
  // A failed read is a budget input: it throws, as the reads above do.
  const holderIds = liveHolderIds(monthBlocks)
  let pay
  try {
    pay = await loadHolderPay(db, holderIds)
  } catch (e) {
    throw new Error(`Pay lookup failed: ${e?.message || e}`)
  }
  const contractorRateById = {}
  for (const [id, p] of pay) {
    if (p.employment_type !== 'contractor') continue
    contractorRateById[id] = Number(p.hourly_rate) || 0
  }

  // COPYLEAVE.1 — everyone with a live shift on these blocks, for the advisory
  // lists only: to look for the same people's shifts at other studios.
  const rosteredIds = advisories ? holderIds : []
```

In the leave read, change line 169 to scope to members AND every holder, in both modes:

```js
      .or(leaveScopeOrFilter([locationId], [...(links || []).map((l) => l.profile_id), ...holderIds]))
```

and add one line to the comment block above the leave read (after the `LEAVE.2 — …` lines):

```js
  // CONTRACTORSPEND.1 — every HOLDER's leave, in both modes: a guest contractor
  // is priced now, so their leave must be seen or the gate bills them while off.
```

(`contractorRateById` keeps its name and shape, so `blockContractorCost` (296) and the returned context are untouched.)

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run src/lib/roster-publish.test.js src/app/api/schedule/rosters/route.test.js "src/app/api/schedule/rosters/[id]/approve/route.test.js" src/lib/approvals/providers/rosters.test.js`
Expected: PASS. (The route and provider tests stub `projectPublishImpact` / `projectPublishImpactBatch`.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/roster-publish.js src/lib/roster-publish.test.js
git commit -m "CONTRACTORSPEND.1 — the publish gate prices every holder, with their leave

loadBudgetContext rated only this studio's members (from the deprecated
profiles pay columns), so a sibling-studio contractor on a shift here cost
EUR 0. It now prices holders through loadHolderPay, like the spend panel, and
the leave read covers every holder in both modes (advisories: false included),
so a priced guest on approved leave is not billed. The case that pinned the
old members-only scope is changed on purpose.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: the panel says "Published" and shows what is not yet published

**Files:**
- Modify: `src/components/RosterSummaryPanel.jsx` (header 15-18; after 94; label at 200; a new line before 232)
- Modify: `src/app/api/schedule/contractor-spend/route.js` (header 13-22 only)
- Test: `src/components/RosterSummaryPanel.spendmonth.test.jsx`

- [ ] **Step 1: Write the failing tests** (append to `RosterSummaryPanel.spendmonth.test.jsx`)

```jsx
// CONTRACTORSPEND.1 — the headline is PUBLISHED shifts; anything not yet
// published is one line beside it, so a month being drafted still shows where
// it is heading.
describe('RosterSummaryPanel contractor spend: published and not yet published', () => {
  it('labels the headline Published', () => {
    renderPanel()
    expect(screen.getByText('Published')).toBeTruthy()
    expect(screen.queryByText('Spent')).toBeNull()
  })

  it('says nothing about unpublished shifts when there are none (or an older server sent no figure)', () => {
    const { container } = renderPanel({ contractorSpend: { ...SPEND, unpublishedContractorCostEur: 0 } })
    expect(container.textContent).not.toMatch(/not yet published/)
    cleanup()
    const { container: old } = renderPanel()
    expect(old.textContent).not.toMatch(/not yet published/)
  })

  it('shows the unpublished amount when the month stays within budget', () => {
    const { container } = renderPanel({
      contractorSpend: { ...SPEND, unpublishedContractorCostEur: 300, projectedContractorCostEur: 1500, projectedOverBudget: false },
    })
    expect(container.textContent).toContain('€300 more in shifts not yet published.')
    expect(container.textContent).not.toMatch(/over budget once published/)
  })

  it('says how far over budget the month goes once published, when only the projection is over', () => {
    const { container } = renderPanel({
      contractorSpend: { ...SPEND, unpublishedContractorCostEur: 1300, projectedContractorCostEur: 2500, projectedOverBudget: true },
    })
    expect(container.textContent).toContain('€1,300 more in shifts not yet published: €500 over budget once published.')
  })

  it('does not repeat "over budget" when the published figure is already over', () => {
    const { container } = renderPanel({
      contractorSpend: {
        ...SPEND, contractorCostEur: 2100, remainingEur: -100, overBudget: true, utilisationPct: 105,
        unpublishedContractorCostEur: 200, projectedContractorCostEur: 2300, projectedOverBudget: true,
      },
    })
    expect(container.textContent).toContain('€200 more in shifts not yet published.')
    expect(container.textContent).not.toMatch(/over budget once published/)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/components/RosterSummaryPanel.spendmonth.test.jsx`
Expected: FAIL on "labels the headline Published" and the two "shows …" / "says how far …" cases. The two REPORTS.2 cases, the "nothing" case and the "does not repeat" case's negative still pass.

- [ ] **Step 3: Implement**

In `src/components/RosterSummaryPanel.jsx`:

Header lines 15-18 become:

```js
// Two halves:
//   - Per-coach FTE utilisation bars (allocated / contracted)
//   - Contractor euro spend for the focused month vs the
//     location's monthly_contractor_budget_eur: PUBLISHED shifts as the
//     headline, anything not yet published on one line beside it
//     (CONTRACTORSPEND.1)
```

After line 94 (`const month = contractorSpend`):

```js
  // CONTRACTORSPEND.1 — the server counts PUBLISHED shifts as spend and sends
  // the rest (drafts, shifts no roster owns yet) as its own total. `|| 0`: a
  // response from before this change has no such field.
  const unpublishedEur = Number(month?.unpublishedContractorCostEur) || 0
  const overOncePublishedEur = month?.projectedOverBudget && !month?.overBudget && month?.monthlyBudgetEur != null
    ? Number(month.projectedContractorCostEur) - Number(month.monthlyBudgetEur)
    : null
```

Line 200: change the label text `Spent` to `Published`:

```jsx
                <div className="text-[10px] uppercase tracking-wider text-un1t-subtle">Published</div>
```

Insert just before `{spendOtherMonthStart && (` (line 232):

```jsx
            {unpublishedEur > 0 && (
              <p className="text-[11px] text-un1t-subtle mt-2">
                {formatEur(unpublishedEur)} more in shifts not yet published
                {overOncePublishedEur != null
                  ? <>: <span className="text-amber-700 font-medium">{formatEur(overOncePublishedEur)} over budget once published</span>.</>
                  : '.'}
              </p>
            )}
```

In `src/app/api/schedule/contractor-spend/route.js`, replace the `Returns:` block (lines 17-22) with:

```js
// Returns (studio TOTALS only — CONTRACTORSPEND.1 pins the key list in
// src/lib/roster-summary-server.test.js):
//   { success, data: {
//       monthStartIso, monthEndIso,
//       contractorCostEur,              // PUBLISHED shifts, every holder
//       unpublishedContractorCostEur,   // drafts + shifts no roster owns yet
//       projectedContractorCostEur,     // the two together
//       fteImplicitCostEur,             // published, context only
//       monthlyBudgetEur, remainingEur, overBudget, projectedOverBudget, utilisationPct
//   }}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/components/RosterSummaryPanel.spendmonth.test.jsx src/components/ScheduleCalendar.partial-load.test.jsx src/components/ScheduleCalendar.a11y.test.jsx src/components/schedule/useScheduleData.test.js src/app/api/schedule/contractor-spend/route.test.js`
Expected: PASS. The calendar tests stub the spend with `{}` or `null`, and `{}` gives `unpublishedEur` 0 and no new line.

- [ ] **Step 5: Commit**

```bash
git add src/components/RosterSummaryPanel.jsx src/components/RosterSummaryPanel.spendmonth.test.jsx src/app/api/schedule/contractor-spend/route.js
git commit -m "CONTRACTORSPEND.1 — the spend panel says Published and shows what is not yet published

The headline is published shifts; one line gives the unpublished total and,
when only the projection is over, how far over budget the month goes once
published. The route header documents the three new aggregate keys.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine). Rebase and re-run the focused suites:

```bash
git fetch origin main && git rebase origin/main
npx vitest run src/lib/shift-holder-pay.test.js src/lib/roster-summary.test.js src/lib/roster-summary-server.test.js src/lib/roster-summary.month.tz.test.js src/lib/roster-summary.month.tz-us.test.js src/lib/roster-publish.test.js src/components/RosterSummaryPanel.spendmonth.test.jsx src/app/api/schedule/contractor-spend/route.test.js tests/staff-tombstone-readers.test.js tests/shared-pair-sync.test.js
TZ=America/Los_Angeles npx vitest run src/lib/roster-summary.test.js src/lib/roster-summary-server.test.js src/lib/roster-publish.test.js
TZ=Europe/Dublin npx vitest run src/lib/roster-summary.test.js src/lib/roster-summary-server.test.js src/lib/roster-publish.test.js
```

Expected: all green.

- [ ] **The 12-command CI mirror (CLAUDE.md "Build, test & ship"):**

```bash
set -o pipefail
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0 and vitest reports `0 failed`.
- `check:route-guards`: no route added.
- `check:location-scoping`: the route makes no query of its own; the helper's block read is `.eq('location_id', locationId)`, and the `profiles` / `profile_compensation` reads are by id.
- `check:select-columns`: Task 3 Step 6.
- `check:guardrails`: no `new Date(\`…Z\`)` or UTC-today form added (the month is `monthBounds`); no discarded `.single()` error (the one `.single()` pins `id`); no write.
- `check:ota-paths`: nothing under `mobile/` or `shared/`.
- `tests/staff-tombstone-readers.test.js`: the new `from('profiles')` read carries `.in('id', …)`.

- [ ] **The build:**

```bash
npm run build
```

Expected: `✓ Compiled successfully`. This proves `@shared/roster-month` resolves into `src/lib/roster-summary.js`, which `RosterSummaryPanel.jsx` (a client bundle) also imports for `summarizeWeek`. `monthBounds` is pure, so it is safe on the client.

- [ ] **Independent review** (standing rule). Point the reviewer at:
  - D1: holders, not members, and tombstones priced;
  - D2: published headline + the unpublished line, and why not published-only;
  - D3: a `Date` reference throws;
  - D5: the current employment type prices the whole month;
  - D6 / D7: admin at €0 kept; rostered hours, not elapsed;
  - D8: the pinned key list;
  - D9: the gate change, including the deliberately changed `advisories: false` case;
  - D10: every failed read throws.

- [ ] **Browser checks** on the Vercel preview (memory `jsdom-cannot-see-layout`). The preview reads prod, and this PR only reads. Use `/schedule` at Stillorgan as Richard. Record figures in the PR only as "matches" or "differs", never as euros: the repo is public.
  1. **Month view, September 2026.** "Published" equals prod's current "Spent" (every September block is published), and there is no "not yet published" line.
  2. **Month view, October 2026.** "Published" is lower than prod's "Spent". Published plus the "not yet published" amount equals prod's "Spent" to the euro (no contractor is inactive or a guest today, so only the published split moves it).
  3. **Month view, June 2026.** The contractor figure equals prod's. "FTE labour (sunk cost)" is higher than prod's (the inactive employee's 74 published shifts are now counted).
  4. **Week view straddling 28 Sep to 4 Oct.** The REPORTS.2 line still names the month it chose.
  5. **"View as" a head coach.** The panel renders totals, and in DevTools → Network the `contractor-spend` response carries exactly the eleven keys in D8 and no rate.
  6. **At 390px wide.** The new line wraps inside the card, with no horizontal scroll.

---

### PR

**Title:** `CONTRACTORSPEND.1 — contractor spend prices every published shift here, whoever holds it, in the Dublin month`

**Body must say, in this order:**
1. **No migration. No OTA** (nothing under `mobile/` or `shared/`). No new route, no permission key. Depends on A1 PAYROLL24.1 (merged).
2. What was wrong. The spend panel skipped contractors deactivated mid-month and anyone not a member of this studio (the sibling studio's contractors covering here). The publish gate skipped the latter too. The month was read from a local `Date`, so on a host west of UTC the panel said €0 for every month. Drafts and rosterless shifts were counted as "Spent".
3. The rule now:
   - every live assignment at this studio in the month, priced by its holder (active or not, deleted or not, member or not);
   - published shifts are the headline ("Published"), and the rest is one line beside it;
   - admin shifts stay at €0 (SHIFTTYPE.1), and hours are rostered hours;
   - the month is `monthBounds` on the Dublin date string.
4. The same holder-pay loader feeds the publish gate, so the panel and the gate price the same people. The gate also reads every holder's leave in both modes, and one test that pinned the old members-only scope was changed on purpose.
5. Pay never leaves the server: `profile_compensation` via `loadHolderPay`, `profiles` by named columns, and the route's response pinned to eleven aggregate keys.
6. Measured on prod (counts only):
   - no contractor is inactive or a guest today;
   - October 14/145 blocks published, November 0/70, June to September all published;
   - 123 June/July shifts of one inactive employee now reach the sunk-cost line;
   - 0 drift between the two pay copies.
7. Browser-check results (the six above, as matches/differs).
8. Open questions and follow-ups (below).
9. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit another row (`merge=union`).

```
| #<PR> | CONTRACTORSPEND.1 — contractor spend prices every published shift here, whoever holds it, in the Dublin month | 2026-09-2x. Follow-ups A2. **Web only; no mig, no OTA.** The roster calendar's contractor-spend panel skipped contractors deactivated mid-month (`!s.active`) and anyone not a member of the studio (the sibling studio's contractors covering here), and `summarizeMonth` re-parsed the reference date with `new Date('YYYY-MM-DD')` + local getters, so west of UTC the calendar's 1st-of-month reference read the month before and the panel said €0. Now: new `src/lib/shift-holder-pay.js` (`liveHolderIds`, `loadHolderPay`: type from `profiles` by named columns, pay from `profile_compensation`, chunked, throws); `summarizeMonth({ blocks, pay, referenceDate: 'YYYY-MM-DD', … })` prices every live assignment by holder, counts PUBLISHED shifts as spend and returns `unpublishedContractorCostEur` / `projectedContractorCostEur` / `projectedOverBudget` beside it, month via `monthBounds` (a Date throws); admin stays €0 (SHIFTTYPE.1); FTE sunk cost published-only, inactive included. The spend read pages its block read and embeds roster status. The publish gate (`loadBudgetContext`) prices holders through the same loader and reads every holder's leave in both advisory modes. Panel: "Spent" → "Published" + one "not yet published" line. October 2026 pinned under Dublin and LA; response key list pinned (totals only). |
```

---

### Open questions for the owner (Richard)

1. **The panel's headline is now published shifts** (D2). Drafts and shifts no roster owns yet show as "€X more in shifts not yet published", plus "€Y over budget once published" when only the projection is over. Today the panel adds them into "Spent". Happy with the relabel and the extra line, or would you rather the panel show only what is published?
2. **Changing someone's employment type mid-month** (D5). Their whole month is priced by the type they have NOW, because nothing records when it changed. The same is true of a rate change. The gate, the labour block and the invoice review all share this. Worth an effective-dated employment record later?
3. **Leave** (D12). The publish gate does not bill a contractor for a shift they are rostered on while on approved leave, but the panel does (as it always has). Should the panel follow the gate? It would read slightly lower whenever someone is rostered during leave, which the FTE bars already flag as a mistake.
4. **Head coaches see these totals** (unchanged). In a month where one contractor works alone at a studio, total ÷ rostered hours is that person's rate. Keep the panel for head coaches, or limit the euro figures to owner/manager/master (the CONTRACTVIS.1 question, for money)?
5. **A contractor with no rate on file** is priced at €0 by both the panel and the gate, silently. No one is in that state today. Add a "N shifts not priced: no rate on file" line?
6. **Clocks-change nights** (D7). A shift across 01:00-02:00 on the last Sunday of March or October is priced at its rostered length, while the labour block measures real elapsed time. No such shift exists; noted so the two figures are not mistaken for a bug.

### Conflicts with A1 and A3

- **A1 PAYROLL24.1:**
  - **`payroll.js`:** A2 reads `shiftHours` and changes nothing in it.
  - **One shared test file, `src/lib/roster-summary.test.js`.** A1 appends `describe('a shift ending at 24:00 (PAYROLL24.1)')`. Its `summarizeMonth` case uses the signature A2 replaces (`staff`, a `Date` reference, an unpublished block), so after A2 it would throw. A1's plan calls the rebase "trivial". Textually it is, but the case must be adapted, and Task 2 (d) does it, keeping A1's intent (2h × €35 = €70).
  - **Order:** A2 branches (or rebases) after A1 merges, and every `24:00` shift's price moves with A1 (the intended fix).
- **A3 INVOICEHOURS.1** (checked against `A3-INVOICEHOURS.1.md`):
  - **Shared file:** none except `docs/CHANGELOG.md` (`merge=union`).
  - **Same hours function.** Both price hours with payroll's `shiftHours`, which A1 fixes for `24:00` (A2 D7, A3 D5). Neither uses `workingWindow`. So contractor spend and the invoice review agree on every shift, a clock-change-night shift included, and both disagree with LABOUR.1's elapsed time on that one shift only.
  - **Same rule, no new predicate.** "Live" is `isLiveAssignment` (A2 through `liveAssignments` in `blocksToShiftRows`) and "published" is the inline `rosters?.status === 'published'` that the rest of the repo, LABOUR.1 and A3 all use. A2 deliberately **exports no combined predicate**, so A3's Task 0 Step 3 finds nothing to swap in and builds as written. Neither PR waits on the other.
  - **One visible difference: the rate source.** A2 reads rates from `profile_compensation` (through `loadHolderPay`, D4) because the publish gate shares the loader. A3 keeps `profiles.hourly_rate` on purpose (its D12). The two copies are dual-written and measured equal (0 drift, 27 Sep), so the figures agree today. Moving the invoice review to `loadHolderPay` is the follow-up A3 already names. If A2 merges first, A3 can take it in one line.
- **New hotspot for the index:** `src/lib/roster-publish.js` (A2 Task 5). No other row in `00-INDEX.md` touches it today.

### Follow-ups found while planning (not in this PR)

- **`summarizeWeek` skips inactive staff too** (`roster-summary.js:233`), so a deactivated employee's hours vanish from the week's FTE bars. Its `contractorWeekCostEur` has **no reader** (`git grep`), and in the browser it is computed from the pay-free picker list, so it is always 0. That makes it a candidate for D1 DEADCODE.1.
- **The FTE week-cost panel** (`src/lib/roster-week-cost.js:74-93`) has the same membership + `active` shape and reads the deprecated `profiles` pay columns. It is hours-only output, so no money is wrong, but a deactivated or guest employee's overtime is invisible there.
- **The deprecated `profiles` pay columns** (mig 152 "phase 3", never done) still have readers: `contractor-invoices.js:103`, `api/contracts/route.js:146`, `api/contracts/[id]/route.js:49`, `api/invoices/*` contractor embeds, `api/assistant/chat/route.js:391`, `shared/dashboard-data.js:97,380`. Dual-writes keep them equal today (0 drift). Dropping the columns needs every reader moved first.
- **The spend route returns a raw `e.message` on a 500** (`contractor-spend/route.js:83-86`), which can now name a table ("profile_compensation read failed: …"). It is harmless for managers, but `logError` + a generic message would match newer routes.

---

### Self-review (done while writing)

- **Spec coverage:**
  - (a) deactivated mid-month: D1, Task 2 (deactivated, tombstoned), Task 3 (server).
  - (b) sibling studio's contractors: D1, Task 3 (guest priced, no `profile_locations` read), Task 5 (the gate, D9).
  - (c) the month from a local `Date`: D3, Task 2 (`TypeError`), Task 4 (October 2026, Dublin + LA, both the model and the server bounds).
  - "Live published": D2, Tasks 2/3.
  - "Whoever holds it, active or not": D1.
  - The LABOUR.1 rule reused: live via `isLiveAssignment`, published via roster status, pay from `profile_compensation`, never to the browser (D4, D8); the two deliberate differences (admin, rostered hours) are D6/D7.
  - SHIFTTYPE.1 admin at €0 kept: D6 and the adapted tests.
  - Employment type mid-month: D5.
  - Pay exposure: D8.
  - A US TZ and the October DST month: Task 4.
  - Gate, PR, CHANGELOG, open questions, conflicts: above.
- **Placeholders:** none. Every code step carries its code. `<PR>` and the `x` in the CHANGELOG date are filled at PR time.
- **Names:**
  - `liveHolderIds(blocks)` and `loadHolderPay(db, ids)` → `Map<id, { employment_type, hourly_rate, annual_salary, contracted_hours_per_week }>`, used the same way in Tasks 1, 3 and 5.
  - `summarizeMonth({ blocks, pay, referenceDate, monthlyBudgetEur })` returns `monthStartIso, monthEndIso, contractorCostEur, unpublishedContractorCostEur, projectedContractorCostEur, fteImplicitCostEur, monthlyBudgetEur, remainingEur, overBudget, projectedOverBudget, utilisationPct`. These are the eleven keys pinned in Task 3 and read by the panel in Task 6.
  - Rows carry `published`.
  - Test helpers: `spendBlock`, `fakeSpendDb` (`queries`, `tables()`, `selectOf()`, `blockQueries()`), `OCT_*`.
- **Arithmetic re-checked:**
  - May: 3h + 2h at €35 = €175 of €200 → 88%, €25 left.
  - The mixed-status case: 70 published; 105 + 35 + 35 = 175 unpublished; 245 projected against €200 → projected over; €130 remaining; 35%.
  - October: 2 + 3 + 2 = 7h × €35 = €245 against €300 → €55 left.
  - Paging: 1,001 × €35 = €35,035.
  - Sibling guest: 2h × €40 = €80 in the period, plus 1h × €40 = €40 published outside it; €120 against €100 → over.
  - Panel: €1,200 + €1,300 = €2,500 against €2,000 → €500 over once published; €2,100 + €200 = €2,300 with the published figure already over, so no second "over" phrase.
