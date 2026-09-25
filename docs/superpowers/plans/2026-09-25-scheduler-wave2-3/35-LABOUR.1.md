## PR LABOUR.1 — owners see this month's labour against revenue, forecast (published roster) against actual (worked so far), per studio and for all their studios

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner opening `/dashboard/business` sees a new block, **Labour against revenue · <month>**. For each studio of the active organisation where they are an owner (and a total when there are two or more), it shows the month's **forecast** labour cost (the published roster for the whole month) and the **actual** labour cost so far (shifts that have ended, salaries pro-rated to today), each as a percentage of the studio's recurring revenue. It also shows hours, draft hours left out, and the names of anyone who worked but has no pay on file. Everything is computed on the server; the page receives totals, ratios, hours and names, never a rate or a salary.

**Why:** 00-INDEX Wave 3 PR 35 ("Owner-only labour against revenue, and the month's forecast against actual. Server-computed ratios; rates never reach the browser"), from the 19 Sep product review ("labour % of revenue"). Program default 8: "Labour against revenue uses whatever revenue source the studio scorecard already trusts; the LABOUR.1 plan names it before any code." It is named in D1 below.

**Architecture:** One pure model (`src/lib/labour-month-model.js`: the Dublin month window, who may see it, flattening the roster, and all the money arithmetic), one IO module (`src/lib/labour-month-data.js`: five scoped reads plus the scorecard's own MRR fetcher, never throws), one fix to an unused pay helper so it can no longer answer "nobody has pay" on a failed read, one presentational component and one async server block on the existing Business dashboard. No API route and no client component: the block renders to HTML on the server, so no pay value ever enters a JSON payload.

**Tech Stack:** Next.js 16 App Router (async server components under `Suspense`), Supabase PostgREST via the service-role client, Vitest (node environment; components rendered with `react-dom/server`'s `renderToStaticMarkup`, as `src/components/dashboard/RosterRunwayChip.test.jsx` does).

**Size / ships:** M. **No migration. No OTA**: nothing under `mobile/` or `shared/` changes (the new modules only IMPORT from `shared/`). **No new permission key** (D9), so `check:mobile-parity` is unaffected. **No new route**, so nothing is registered in `src/lib/openapi.js`.

**Depends on:** 13 SHIFTTYPE.1 (#1759, merged; `shift_templates.kind` exists). This PR deliberately does NOT use kind to price: contractor admin shifts cost money here (D6). Batch 8 pairing: rides beside 34 ARRIVALSHOW.1, which touches the phone schedule tab only; the two share no file except `docs/CHANGELOG.md`.

---

### What was found (verified against `origin/main` at `27500a90`, #1764)

**The revenue source the Studio scorecard trusts is MRR, and only MRR.**
- `/dashboard/studio` (`src/app/dashboard/studio/page.js`) calls `fetchMrr` at line 71 and renders it as the "MRR" card at line 129. Its other revenue-flavoured card, "Revenue churn", prices cancels, not income. The scorecard has no collected-revenue figure.
- `fetchMrr(supabase, locationId)` (`shared/studio-kpis.js:71-92`): contacts at the studio with `glofox_membership_status` in (`member`, `credit_member`), `glofox_membership_type = 'time'`, `glofox_membership_state = 'active'`, paged past 1,000; `computeMrr` (`shared/studio-kpi-math.js:85-100`) divides each `glofox_membership_price_cents` by its billing interval in months (`intervalMonths`, line 69) and returns `{ mrrCents, recurringMembers, yieldCents }`. It returns `{ success: false, error }` on a failed read and never throws. It is a **point-in-time run-rate**: there is no MRR history, so a past month cannot be priced this way.
- Memory `studio-kpi-scorecard`: MRR is Richard's own definition of the recurring base ("168 billing now"); the scorecard is reviewed weekly at the management meeting, on a computer, and **Richard said no mobile scorecard** (4 Aug).
- The other revenue figure owners see is the Business dashboard's **"Revenue MTD"**: `fetchRevenueMTD` (`shared/dashboard-data.js:532-558`), a paged sum of `glofox_invoices.amount_cents` with `status = 'PAID'` since the start of the month. Not chosen (D1). Its month start is `startOfMonth(now)` in the server's zone, i.e. UTC on Vercel (line 541), one hour off Dublin in summer (follow-up).
- **Hatch Street has no revenue in the CRM.** Read-only aggregate on prod, 25 Sep: every `glofox_invoices` row since May is Stillorgan's; Hatch is not on Glofox (CLAUDE.md "Only Stillorgan is Glofox-connected"), so its MRR is 0 members. All PAID rows are EUR (`eur` 2,125, `EUR` 312).

**Pay data, and where the canonical copy lives.**
- `profile_compensation` (mig 152, `supabase/migrations/152_profile_compensation.sql:31`) holds `annual_salary`, `hourly_rate`, `contracted_hours_per_week`, `annual_leave_entitlement`, `overtime_rate`; RLS master/owner only. The `profiles` copies are "DEPRECATED … to be dropped in phase 3" and still dual-written (`src/app/api/staff/route.js:211-259`, `src/lib/staff-write.js:217-240`).
- CLAUDE.md: `profiles` still carries the pay columns and `select('*')` on it leaks them to any client component; name columns.
- Read-only aggregate on prod, 25 Sep (**counts only; no pay value was read into this plan**): 6 active contractors, all 6 with an hourly rate; 8 active employees (`employment_type = 'fte'`): **4 with a salary** (2 head coaches, 1 owner, 1 master-role profile), **4 without** (1 owner, 3 staff; none of the 4 has a live shift since 1 Aug). **0** employees paid by the hour, **0** overtime rates set. **0** rows where the `profiles` copy and `profile_compensation` disagree on any of the four pay columns.
- `getCompensationForProfiles` (`src/lib/profile-compensation.js:76-100`) is the bulk reader for the canonical table and has **no caller** on `main` (`git grep` finds only its definition). It **discards its read error** (`const { data } = await db`, line 84): a failed read returns an empty Map, which a labour sum would read as "nobody is paid anything". Task 1 fixes it before this PR relies on it.

**How existing code prices labour (what this PR agrees and disagrees with).**
- `payroll.js`: `timeToHours` (`src/lib/payroll.js:25-34`) refuses hour 24 (line 32), so `shiftHours` (44) counts a shift ending `'24:00'` as **0 hours**; `implicitHourlyRate` (67) prices an FTE only from `annual_salary / 52 / contracted_hours_per_week` and ignores an FTE's `hourly_rate`.
- Contractor spend (`GET /api/schedule/contractor-spend` → `computeMonthlyContractorSpend`, `src/lib/roster-summary-server.js:53-112` → `summarizeMonth`, `src/lib/roster-summary.js:321-365`): contractor hours × rate, **admin shifts at €0** (`classOnly`, line 342, SHIFTTYPE.1), drafts included, and only staff who are **active** (line 336) **and linked to this studio** (`profile_locations` read, `roster-summary-server.js:86-102`). So a contractor deactivated mid-month, or one from the sibling studio covering a class here, has their worked shifts dropped from spend (follow-up).
- `fetchTodayOps` (`shared/dashboard-data.js:659-724`), the Business dashboard's "labour this week" (also on the phone, `mobile/components/dashboard/BusinessDashboard.jsx:148`): rostered hours × `hourlyRateFor` (salary/52/contract for employees), drafts included, and **cancelled assignments counted** (`fetchDashboardShifts`, lines 95-134, never filters `status`; the loop at 708-712 sums every row). Follow-up.
- Contractor invoices (mig 101): one row per contractor per month, `UNIQUE (contractor_id, period_start) WHERE status <> 'declined'` (`supabase/migrations/101_contractor_invoices.sql:66`), so a contractor who works at both studios can submit **one** invoice a month, filed against **one** studio. Invoices arrive after the month ends. `computeScheduledForPeriod` (`src/lib/contractor-invoices.js:97-159`), the reviewer's "scheduled hours" figure, reads `shift_assignments` with no `status` filter (115-131), so cancelled shifts count (follow-up).

**Time and roster facts the model rests on.**
- `workingWindow(row)` (`shared/working-time.js:162-186`, WORKTIME.1): the effective window (override, then the block's own time, then the template, via `effectiveShiftStart/End`, `shared/roster-month.js:52-57`), `null` for a cancelled row or a row with no usable times, `'24:00'` as the next midnight, and `startMs`/`endMs` as real Dublin instants (DST-exact).
- Published = `block.rosters.status === 'published'` (the one test used by `shared/dashboard-data.js:126`, `src/lib/roster-read.js:137`, `shared/roster-staffing.js:177`); superseded is not published. A block added to a published period is tagged at creation (`src/app/api/schedule/blocks/route.js:241-256`). Live = `isLiveAssignment` (`src/lib/roster.js:440`, only `cancelled` is dead).
- `siblingLocationIds(db, locationId)` (`src/lib/sibling-locations.js:19`): the other studios of the SAME organisation, never throws, errors come back with no ids (ORGSCOPE.1).
- Dublin calendar: `dublinDayStr` (`src/lib/dublin-time.js:25`), `dublinDayRangeMs(start, end)` (181), half-open real-ms window.
- `selectAll` (`src/lib/select-all.js`): pages at 1,000, throws on a page error.

**Who is an owner, and where.**
- Roles are per studio: `hasRoleAtLocation(user, locationId, roles)` (`src/lib/role-at-location.js:55`), master bypass on `profileRole`, fails closed; client-safe module. The schedule's publish route already gates an owner-only action this way (`OWNER_ROLES = ['owner']`, `src/app/api/schedule/rosters/route.js:65`).
- `ADMIN_ROLES` (`src/lib/schemas.js:192`) is master, owner, **manager**: the set that may see rate-bearing reports (`src/lib/report-access.js`, STAFFCOST.1). The program rule for this wave is stricter: "hours only, never rates, reach anyone but owners" (00-INDEX standing rules). So LABOUR.1 does not reuse `ADMIN_ROLES`.
- `/dashboard/business` is gated by the `dashboard_business` permission (`src/app/dashboard/business/page.js:137`), hinted "Owner-level — pipeline, won deals, payroll" (`shared/permissions.js:45`), default on for owner and off for manager, but an owner can grant it to a manager per studio.
- `getCurrentUser()` returns `activeLocation` (a full `locations` row, so it carries `organization_id` and `name`) and `locations` (full rows; for a master, every active location) (`src/lib/auth.js:379`, `588`).

---

### Decisions (made here, each pinned by a test)

**D1. Revenue = the Studio scorecard's MRR, for the current Dublin month.** Default 8 says "whatever revenue source the studio scorecard already trusts", and the scorecard's only revenue figure is `fetchMrr`. Reuse it as is (same function, same filters, same number the managers' meeting reviews), per studio. "Forecast %" divides the month's forecast labour by MRR. "So far %" divides labour so far by MRR × the elapsed fraction of the month (real ms, Dublin boundaries), so the two percentages are like for like. Because MRR has no history, **the view is the current month only** (no month picker). Paid Glofox invoices (the Business card "Revenue MTD") were the alternative: cash rather than run-rate, and they include class packs and one-off charges, but they are gross of VAT, carry no refunds, and a new month starts near zero. That makes an early-month "labour %" look alarming. Open question 1. *Pinned:* model "Stillorgan row" (33.4% forecast, 33.7% so far) and data test "asks the scorecard's fetchMrr per studio shown".

**D2. A studio without tracked revenue shows its labour and no ratio.** `recurringMembers = 0` or `mrrCents = 0` → `revenue_status: 'none'` ("Not tracked here", Hatch Street today). A failed MRR read → `'unavailable'` ("Could not be read"), logged with `logWarn`, and the rest of the block still renders. A ratio is never computed against zero revenue, so the page never shows `0%` or `∞`. The total's ratios cover only studios with tracked revenue and name the ones left out. *Pinned:* model "Hatch row", "total", "unavailable revenue"; data test "fetchMrr failing for one studio".

**D3. Employees cost their salary, not their rostered hours.** A salaried employee costs `annual_salary / 12` for the month whatever the roster says (mig 071's budget model already treats employee shifts as sunk cost, `src/lib/roster-summary.js:16-21`). "So far" is that × the elapsed fraction. Rostered-hours × implicit-rate would make an under-rostered week look cheap and an over-rostered week look dear, when the payroll is identical. Overtime is not modelled: no employee has an overtime rate on file (0 of 8, measured). Employer costs (PRSI, pension) are not added. Open questions 2 and 5. *Pinned:* model "Stillorgan row" (Alex's €3,000/month forecast, half of it so far on the 16th).

**D4. An employee's salary is split between studios by their published hours this month.** Alex with 3h at Stillorgan and 1h at Hatch costs 75% / 25%. An employee with a salary and **no** published hours this month is split equally across the studios they belong to in the organisation (`COUNT_UNROSTERED_SALARIES = true`, an OWNER REVIEW one-line switch like WORKTIME's). Measured today: one salaried master-role profile has no shifts since 1 Aug and would be counted. Open question 3. The organisation total is the same whichever split is used; only the per-studio figures move. *Pinned:* model "Stillorgan row" + "Hatch row" (Alex 75/25, Max 50/50), "countUnrostered false".

**D5. Only active employees with a salary are costed; anyone who WORKED but cannot be costed is named.** An `fte` profile needs `annual_salary > 0` (an employee's `hourly_rate` is ignored, as `payroll.implicitHourlyRate` ignores it; 0 such people today). A deactivated or permanently deleted employee is not salaried (no end date exists to pro-rate to). Anyone with published hours at a studio shown who could not be costed goes on the "No pay on file, so not counted" line with their hours and the reason: no salary, deactivated employee, no hourly rate, no employment type, or profile not found. Someone who did not work this month is never listed (the 4 unsalaried employees today have no shifts, and listing them monthly would be noise). *Pinned:* model "uncosted", "inactive employee who worked", "contractor with no rate".

**D6. Contractors cost their published hours × their hourly rate, admin shifts included.** A contractor on a front-desk admin shift invoices it, so labour counts it. This deliberately differs from contractor spend, which prices admin at €0 because Richard took admin out of the contractor **budget gate** (SHIFTTYPE.1, index default 14). A contractor is priced whether or not they are still active or still linked to the studio (they worked the hours). Invoices are not used: one invoice per contractor per month across both studios (mig 101:66) cannot be split by studio, and none exists until the month ends. Open question 4. *Pinned:* model "Stillorgan row" (Jordan's 2h admin shift priced), "Hatch row" (Casey deactivated, still priced).

**D7. Forecast = the published roster for the whole month; actual = published shifts that have ended.** Both read live assignments on blocks whose roster is `published`, block dates in the Dublin month, at every studio of the organisation. A shift counts toward "so far" once its effective end is at or before now; a shift in progress counts toward forecast only. Draft shifts are never costed; their hours per studio are shown ("Xh in draft rosters not counted"), so an owner knows the forecast is short. Cancelled assignments count nowhere. A published shift with no usable times is counted in `untimed_shifts` and said once, never guessed. *Pinned:* model "Stillorgan row" (draft 1h, cancelled ignored), "in-progress shift", "untimed shift".

**D8. Hours are real elapsed time via `workingWindow`, so LABOUR.1 does not depend on payroll's `'24:00'` bug.** A shift ending `'24:00'` is 2h here (payroll says 0h, follow-up). A 00:30-03:30 shift on the autumn clock-change night is 4h here (payroll's wall-clock arithmetic says 3h). Nobody is rostered at 1am, so the DST difference is theoretical; the `'24:00'` case is real (`shift_blocks` allows it, WORKTIME met it). *Pinned:* model "Hatch row" (Casey 22:00-24:00 = 2h), "autumn clock change".

**D9. Owner-only by ROLE at the studio, not by a permission key.** `labourStudiosFor(user)` = the studios of the ACTIVE organisation where `hasRoleAtLocation(user, id, ['owner'])` (a master passes everywhere, as everywhere else). The block renders only when the active studio is one of them (`canSeeLabour`). A manager who has been granted `dashboard_business` sees the rest of the page but not this block. A new `WEB_PERMISSIONS` key was rejected. A key is a per-studio toggle an owner can hand to a manager, and Richard's rule is by role: pay reaches owners only. With one or two coaches at a studio, a labour total *is* their pay. Therefore no key, no `WEB_ONLY_OK` entry and no parity change. *Pinned:* model "labourStudiosFor" (manager → none; owner at one studio, staff at the other → one; master → the organisation's studios only; another organisation's studio never), and `tests/labour-owner-gate.test.js` (the page renders `<LabourBlock` exactly once, behind `showLabour ?`).

**D10. Rates never leave the server, by construction.** The block is an async **server** component. Neither it nor `LabourPanel` is a client component (neither has `'use client'`), so the view model is rendered to HTML on the server and never serialised to the browser. No API route exists to call. The view model itself carries only totals, ratios, hours and names. A model test stringifies it and greps for every salary and rate it was given, and for the pay column names. Pay is read from `profile_compensation` (the canonical, master/owner-RLS copy) through `getCompensationForProfiles`. `profiles` is read for `id, full_name, active, deleted_at, employment_type` only, a literal select string that a data test pins. The phone's `/api/dashboard/business` route never imports any of it (source guard test). *Pinned:* model "no pay value in the view model", data test "names its profiles columns", `tests/labour-owner-gate.test.js`.

**D11. Per studio and for all the owner's studios, inside the active organisation.** One row per studio the owner may see (ordered by name), plus "All studios shown" when there are two or more (sums; ratios per D2). The roster is read for every studio of the organisation (`[active, ...siblingLocationIds]`), so a shared coach's salary is split on their real hours even when the owner sees only one of the studios; a studio outside the organisation is dropped even if passed in. *Pinned:* model "single studio shown → no total", data test "drops a studio outside the organisation", "reads the roster at every studio of the organisation".

**D12. A failed read is an error cell, never a figure.** The data module never throws. A failed sibling, roster, membership, profiles or pay read returns `{ error }` after `logError('labour-month', …)`, and the block shows the Business dashboard's standard "Labour against revenue couldn't load — refresh to retry" cell. A partial answer ("€0 labour") would read as a real one. Only MRR degrades per studio (D2), because a missing ratio is visibly missing. `getCompensationForProfiles` now throws on a failed read instead of returning an empty Map (Task 1). *Pinned:* data tests "blocks read fails", "sibling read fails", "pay read fails"; `profile-compensation.test.js`; `LabourBlock.test.jsx`.

**D13. Web only, current month only, no history, no alerts.** Richard's call on the scorecard (a sit-down review document, no phone version) applies. Nothing is stored, so there is no migration and nothing to back-fill.

---

### Files

| File | Responsibility |
|---|---|
| `src/lib/profile-compensation.js` (modify: `getCompensationForProfiles`, lines 76-100) | throw on a failed read (zero callers today) |
| `src/lib/profile-compensation.test.js` (create) | the helper maps rows and throws on a read error |
| `src/lib/labour-month-model.js` (create) | pure: `labourMonthWindow`, `labourStudiosFor`, `canSeeLabour`, `labourShiftRows`, `labourPct`, `buildLabourMonth`, `COUNT_UNROSTERED_SALARIES`, `LABOUR_VIEWER_ROLES`, `CONTRACTOR_TYPE` |
| `src/lib/labour-month-model.test.js` (create) | every money, hours and visibility rule; run under two host timezones |
| `src/lib/labour-month-data.js` (create) | `loadLabourMonth(db, { activeLocationId, studios, nowMs })`: the reads, never throws |
| `src/lib/labour-month-data.test.js` (create) | scope, named columns, degrade vs fail |
| `src/components/dashboard/LabourPanel.jsx` (create) | presentational, server-safe |
| `src/components/dashboard/LabourPanel.test.jsx` (create) | what reaches the markup |
| `src/components/dashboard/LabourBlock.jsx` (create) | async server block: load → panel, or the error cell |
| `src/components/dashboard/LabourBlock.test.jsx` (create) | error cell on failure, props passed through |
| `src/app/dashboard/business/page.js` (modify: imports after line 21; after line 139; after the `MembershipBlock` Suspense, lines 151-153) | render the block for owners only |
| `tests/labour-owner-gate.test.js` (create) | source guard: one gated render, never on the phone route |
| `docs/CHANGELOG.md` (modify) | one row, after `gh pr create` |

**Naming traps.** `tests/shared-pair-sync.test.js` fails on an export name present in both `shared/` and `src/lib/`. Before Task 1 run:

```bash
git grep -nE "export (const|function|async function) (labourMonthWindow|labourStudiosFor|canSeeLabour|labourShiftRows|labourPct|buildLabourMonth|loadLabourMonth|COUNT_UNROSTERED_SALARIES|LABOUR_VIEWER_ROLES|CONTRACTOR_TYPE|LabourPanel|LabourBlock)\b" -- shared src mobile/lib
```

Expected: no output.

**Setup:** fresh worktree off `origin/main` (standing rule; never a shared one):

```bash
cd ~/code/un1t-crm && git fetch origin main && git worktree add ../un1t-crm-labour1 -b labour-1 origin/main && cd ../un1t-crm-labour1 && npm ci
```

---

### Task 1: `getCompensationForProfiles` reports a failed read

**Files:**
- Modify: `src/lib/profile-compensation.js:76-100`
- Create: `src/lib/profile-compensation.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/profile-compensation.test.js`:

```js
// src/lib/profile-compensation.test.js
// LABOUR.1 — the bulk pay reader must never answer "nobody is paid" on a
// failed read: a labour total built on an empty Map would read as a real €0.

import { describe, it, expect } from 'vitest'
import { getCompensationForProfiles } from './profile-compensation'

function fakeDb(result) {
  const seen = []
  return {
    seen,
    from(table) {
      const b = {}
      for (const m of ['select', 'in']) b[m] = (...args) => { seen.push([table, m, ...args]); return b }
      b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
      return b
    },
  }
}

describe('getCompensationForProfiles', () => {
  it('maps each row to numbers, keyed by profile id', async () => {
    const db = fakeDb({
      data: [{
        profile_id: 'p1', annual_salary: '36000.00', hourly_rate: null,
        contracted_hours_per_week: '39.0', annual_leave_entitlement: null, overtime_rate: null,
      }],
      error: null,
    })
    const out = await getCompensationForProfiles(db, ['p1'])
    expect(out.get('p1')).toEqual({
      annual_salary: 36000, hourly_rate: null, contracted_hours_per_week: 39,
      annual_leave_entitlement: null, overtime_rate: null,
    })
    expect(db.seen).toContainEqual(['profile_compensation', 'in', 'profile_id', ['p1']])
  })

  it('throws on a failed read instead of returning an empty map', async () => {
    const db = fakeDb({ data: null, error: { message: 'permission denied' } })
    await expect(getCompensationForProfiles(db, ['p1']))
      .rejects.toThrow('profile_compensation read failed: permission denied')
  })

  it('reads nothing for no ids', async () => {
    const db = fakeDb({ data: [], error: null })
    const out = await getCompensationForProfiles(db, [])
    expect(out.size).toBe(0)
    expect(db.seen).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and see the second test fail**

Run: `npx vitest run src/lib/profile-compensation.test.js`
Expected: FAIL on "throws on a failed read" (the promise resolves with an empty Map).

- [ ] **Step 3: Fix the helper**

In `src/lib/profile-compensation.js`, replace the JSDoc paragraph and loop body of `getCompensationForProfiles` (lines 64-100) with:

```js
/**
 * Bulk-read many profiles' comp rows in one round-trip. Returns a
 * Map keyed by profile_id. Missing profiles have no key — the caller
 * should default to emptyComp() / null fields.
 *
 * LABOUR.1 — THROWS on a failed read. It used to discard the error and
 * return an empty Map, which a caller summing pay reads as "nobody is paid":
 * a silent €0, not a failure. It had no callers when that was fixed.
 *
 * Chunks the IN list at 200 ids (URL length). UN1T has ~20 profiles.
 *
 * @param {SupabaseClient} db
 * @param {string[]} profileIds
 * @returns {Promise<Map<string, object>>}
 */
export async function getCompensationForProfiles(db, profileIds) {
  const out = new Map()
  if (!db || !Array.isArray(profileIds) || profileIds.length === 0) return out
  const CHUNK = 200
  for (let i = 0; i < profileIds.length; i += CHUNK) {
    const slice = profileIds.slice(i, i + CHUNK)
    const { data, error } = await db
      .from('profile_compensation')
      .select(`profile_id, ${COMP_COLS.join(', ')}`)
      .in('profile_id', slice)
    if (error) throw new Error(`profile_compensation read failed: ${error.message || error}`)
    for (const row of (data || [])) {
      out.set(row.profile_id, {
        annual_salary:             toNum(row.annual_salary),
        hourly_rate:               toNum(row.hourly_rate),
        contracted_hours_per_week: toNum(row.contracted_hours_per_week),
        annual_leave_entitlement:  toNum(row.annual_leave_entitlement),
        overtime_rate:             toNum(row.overtime_rate),
      })
    }
  }
  return out
}
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/lib/profile-compensation.test.js`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/profile-compensation.js src/lib/profile-compensation.test.js
git commit -m "LABOUR.1 — getCompensationForProfiles throws on a failed read

It discarded the read error and returned an empty Map, which a pay sum
reads as 'nobody is paid'. No caller existed; LABOUR.1 is the first.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: the model, part 1 — the month window and who may see it

**Files:**
- Create: `src/lib/labour-month-model.js`
- Create: `src/lib/labour-month-model.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/labour-month-model.test.js`:

```js
// src/lib/labour-month-model.test.js
// LABOUR.1 — every rule the labour-against-revenue block applies. Pure.
// Run under TZ=Europe/Dublin AND TZ=America/Los_Angeles: no month edge,
// elapsed fraction or hour may move with the host's clock.

import { describe, it, expect } from 'vitest'
import {
  labourMonthWindow, labourStudiosFor, canSeeLabour,
  labourShiftRows, labourPct, buildLabourMonth,
  COUNT_UNROSTERED_SALARIES, LABOUR_VIEWER_ROLES,
} from './labour-month-model'

const HOUR = 3_600_000
const ORG = 'org-un1t'
const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const CARS = 'loc-cars'
const LOCS = [
  { id: STILL, name: 'UN1T Stillorgan', organization_id: ORG },
  { id: HATCH, name: 'UN1T Hatch Street', organization_id: ORG },
  { id: CARS, name: 'CCF Autos', organization_id: 'org-ccf' },
]

describe('labourMonthWindow', () => {
  it('is the Dublin month holding now, with the elapsed fraction in real time', () => {
    // 00:00 Dublin (IST) on Wed 16 Sep 2026 = 23:00 UTC on the 15th.
    const w = labourMonthWindow(Date.UTC(2026, 8, 15, 23, 0))
    expect(w).toMatchObject({
      month: '2026-09', monthLabel: 'September 2026',
      startDate: '2026-09-01', endDate: '2026-09-30',
      daysInMonth: 30, dayOfMonth: 16,
      startMs: Date.UTC(2026, 7, 31, 23, 0), endMs: Date.UTC(2026, 8, 30, 23, 0),
    })
    expect(w.elapsedFraction).toBe(0.5)
  })

  it('takes the Dublin date, not the UTC one, at a month edge', () => {
    // 23:30 UTC on 31 Aug = 00:30 on 1 Sep in Dublin.
    const w = labourMonthWindow(Date.UTC(2026, 7, 31, 23, 30))
    expect(w.month).toBe('2026-09')
    expect(w.dayOfMonth).toBe(1)
  })

  it('is 31 days and one hour long in October 2026 (clocks go back on the 25th)', () => {
    const w = labourMonthWindow(Date.UTC(2026, 9, 10, 12, 0))
    expect(w.endMs - w.startMs).toBe((31 * 24 + 1) * HOUR)
  })

  it('knows February 2027 has 28 days, and crosses a year end', () => {
    expect(labourMonthWindow(Date.UTC(2027, 1, 10, 12)).endDate).toBe('2027-02-28')
    const dec = labourMonthWindow(Date.UTC(2026, 11, 31, 22))
    expect([dec.month, dec.endDate, dec.monthLabel]).toEqual(['2026-12', '2026-12-31', 'December 2026'])
  })

  it('is 0 at the first instant of the month and 1 at its end', () => {
    expect(labourMonthWindow(Date.UTC(2026, 7, 31, 23, 0)).elapsedFraction).toBe(0)
    expect(labourMonthWindow(Date.UTC(2026, 8, 30, 22, 59, 59)).elapsedFraction).toBeCloseTo(1, 5)
  })
})

describe('labourStudiosFor / canSeeLabour (owner only, by role at the studio)', () => {
  const user = (rolesByLocation, over = {}) => ({
    profileRole: 'staff', rolesByLocation, locations: LOCS.slice(0, 2), activeLocation: LOCS[0], ...over,
  })

  it('an owner at both studios sees both, by name', () => {
    const u = user({ [STILL]: 'owner', [HATCH]: 'owner' }, { profileRole: 'owner' })
    expect(labourStudiosFor(u)).toEqual([
      { id: HATCH, name: 'UN1T Hatch Street' },
      { id: STILL, name: 'UN1T Stillorgan' },
    ])
    expect(canSeeLabour(u)).toBe(true)
  })

  it('an owner at one studio and staff at the other sees only the one', () => {
    const u = user({ [STILL]: 'owner', [HATCH]: 'staff' }, { profileRole: 'owner' })
    expect(labourStudiosFor(u).map((s) => s.id)).toEqual([STILL])
  })

  it('is not shown while the active studio is one they do not own', () => {
    const u = user({ [STILL]: 'owner', [HATCH]: 'staff' }, { profileRole: 'owner', activeLocation: LOCS[1] })
    expect(canSeeLabour(u)).toBe(false)
  })

  it('a manager sees nothing, even with the Business dashboard granted', () => {
    const u = user({ [STILL]: 'manager', [HATCH]: 'manager' }, { profileRole: 'manager', permissions: { dashboard_business: true } })
    expect(labourStudiosFor(u)).toEqual([])
    expect(canSeeLabour(u)).toBe(false)
  })

  it('a master sees every studio of the active organisation and no other', () => {
    const u = user({}, { profileRole: 'master', locations: LOCS })
    expect(labourStudiosFor(u).map((s) => s.id)).toEqual([HATCH, STILL])
  })

  it('nothing without an active studio', () => {
    expect(labourStudiosFor(user({ [STILL]: 'owner' }, { activeLocation: null }))).toEqual([])
    expect(canSeeLabour(null)).toBe(false)
  })

  it('the viewer set is owners (master passes through hasRoleAtLocation)', () => {
    expect(LABOUR_VIEWER_ROLES).toEqual(['owner'])
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/labour-month-model.test.js`
Expected: FAIL, `Failed to resolve import "./labour-month-model"`.

- [ ] **Step 3: Write the module's first half**

Create `src/lib/labour-month-model.js`:

```js
// src/lib/labour-month-model.js
//
// LABOUR.1 — owner-only labour against revenue for the current Dublin month.
// Pure: no IO, no clock of its own (nowMs is passed in), and nothing reads the
// host's timezone (tests run under Europe/Dublin and America/Los_Angeles).
//
// Definitions (plan 35-LABOUR.1.md, D1-D13; don't re-derive them elsewhere):
//   revenue   = the Studio scorecard's MRR (shared/studio-kpis.js fetchMrr),
//               "so far" = MRR × the elapsed fraction of the month.
//   employees = annual_salary / 12 a month whatever the roster says, split
//               between studios by published hours; "so far" = × elapsed.
//   contractors = published hours × hourly_rate, ADMIN SHIFTS INCLUDED (unlike
//               contractor spend's budget gate: an admin shift is still paid).
//   forecast  = the published roster for the whole month; actual = published
//               shifts that have ended. Drafts are never costed.
//
// PAY NEVER LEAVES THIS MODULE AS A RATE. buildLabourMonth takes each person's
// annual_salary / hourly_rate and returns studio TOTALS, ratios and hours, plus
// the NAMES of people it could not cost. The test stringifies the result and
// greps it for every rate it was given.

import { workingWindow, EMPLOYEE_TYPE } from '@shared/working-time'
import { isLiveAssignment } from './roster'
import { hasRoleAtLocation } from './role-at-location'
import { dublinDayStr, dublinDayRangeMs } from './dublin-time'

export const CONTRACTOR_TYPE = 'contractor'

// Richard's program rule: pay reaches owners only. Masters pass through
// hasRoleAtLocation's bypass. Deliberately NOT ADMIN_ROLES (which has manager).
export const LABOUR_VIEWER_ROLES = Object.freeze(['owner'])

// OWNER REVIEW (LABOUR.1 open question 3): a salaried employee with no
// published hours this month is still paid, so their salary is split equally
// across their studios. Flip to false to leave unrostered salaries out.
export const COUNT_UNROSTERED_SALARIES = true

const MINUTE_MS = 60_000

/**
 * The Dublin calendar month holding `nowMs`.
 * @param {number} nowMs
 */
export function labourMonthWindow(nowMs) {
  const today = dublinDayStr(nowMs)
  const month = today.slice(0, 7)
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const startDate = `${month}-01`
  const endDate = `${month}-${String(daysInMonth).padStart(2, '0')}`
  const { startMs, endMs } = dublinDayRangeMs(startDate, endDate)
  const elapsedFraction = Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)))
  const monthLabel = new Intl.DateTimeFormat('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, 1)))
  return {
    month, monthLabel, startDate, endDate, startMs, endMs,
    daysInMonth, dayOfMonth: Number(today.slice(8, 10)), elapsedFraction,
  }
}

/**
 * The studios of the ACTIVE organisation where `user` may see labour: owner
 * at that studio (a master everywhere). Ordered by name.
 * @returns {{ id: string, name: string }[]}
 */
export function labourStudiosFor(user) {
  const orgId = user?.activeLocation?.organization_id
  if (!user?.activeLocation?.id || !orgId) return []
  return (user.locations || [])
    .filter((l) => l?.id && l.organization_id === orgId && hasRoleAtLocation(user, l.id, LABOUR_VIEWER_ROLES))
    .map((l) => ({ id: l.id, name: l.name || 'Studio' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The block renders only when the ACTIVE studio is one the viewer owns. */
export function canSeeLabour(user) {
  const activeId = user?.activeLocation?.id
  return !!activeId && labourStudiosFor(user).some((s) => s.id === activeId)
}
```

- [ ] **Step 4: Run them under both zones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/labour-month-model.test.js && TZ=America/Los_Angeles npx vitest run src/lib/labour-month-model.test.js`
Expected: both runs, 12 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/labour-month-model.js src/lib/labour-month-model.test.js
git commit -m "LABOUR.1 — Dublin month window and the owner-only studio set

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: the model, part 2 — the money

**Files:**
- Modify: `src/lib/labour-month-model.js` (append)
- Modify: `src/lib/labour-month-model.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/labour-month-model.test.js`:

```js
// ── The money ──────────────────────────────────────────────────────────────
//
// Fixture, worked by hand. NOW = 00:00 Dublin on 16 Sep 2026, so exactly half
// of September has elapsed (15 of 30 days, no clock change in September).
//
//   Alex  (employee, €36,000/yr = €3,000/month): 3h Stillorgan 1 Sep (ended),
//         1h Hatch 20 Sep (upcoming) → 75% / 25% → €2,250 / €750 forecast,
//         half of each so far.
//   Max   (employee, €24,000/yr = €2,000/month): no shifts, belongs to both
//         studios → €1,000 each forecast, €500 each so far.
//   Jordan (contractor, €30/h): 2h ADMIN Stillorgan 2 Sep (ended), 1h 22 Sep
//         (upcoming), 1h on a DRAFT block, 1 cancelled → €90 forecast, €60 so far.
//   Casey (contractor, €27.13/h, DEACTIVATED since): 22:00-24:00 Hatch 3 Sep
//         → 2h → €54.26 forecast and so far.
//   Sam   (employee, no salary): 1h Stillorgan 4 Sep → named, not costed.
//   Olive (employee, no salary, no shifts) → nothing, not named.
//
// Stillorgan: forecast €3,250 + €90 = €3,340 on MRR €10,000 → 33.4%;
//   so far €1,625 + €60 = €1,685 on €5,000 of revenue to date → 33.7%.
// Hatch: forecast €1,750 + €54.26 = €1,804.26; so far €875 + €54.26 = €929.26;
//   no recurring revenue → no ratio.

const NOW = Date.UTC(2026, 8, 15, 23, 0)
const PERIOD = labourMonthWindow(NOW)

let seq = 0
const A = (profile_id, over = {}) => ({
  id: `a${++seq}`, profile_id, start_time_override: null, end_time_override: null, status: 'scheduled', ...over,
})
const B = (location_id, block_date, start_time, end_time, assignments, { published = true, kind = 'class' } = {}) => ({
  id: `b${++seq}`, location_id, block_date, start_time, end_time,
  rosters: published ? { status: 'published' } : { status: 'draft' },
  shift_templates: { start_time, end_time, kind },
  shift_assignments: assignments,
})

const BLOCKS = [
  B(STILL, '2026-09-01', '09:00:00', '12:00:00', [A('p-alex')]),
  B(HATCH, '2026-09-20', '09:00:00', '10:00:00', [A('p-alex')]),
  B(STILL, '2026-09-02', '17:00:00', '19:00:00', [A('p-jordan')], { kind: 'admin' }),
  B(STILL, '2026-09-22', '17:00:00', '18:00:00', [A('p-jordan')]),
  B(STILL, '2026-09-29', '10:00:00', '11:00:00', [A('p-jordan')], { published: false }),
  B(STILL, '2026-09-05', '09:00:00', '10:00:00', [A('p-jordan', { status: 'cancelled' })]),
  B(HATCH, '2026-09-03', '22:00:00', '24:00:00', [A('p-casey')]),
  B(STILL, '2026-09-04', '07:00:00', '08:00:00', [A('p-sam')]),
]

const P = (full_name, employment_type, pay = {}, over = {}) => ({
  full_name, employment_type, active: true, deleted_at: null,
  annual_salary: null, hourly_rate: null, ...pay, ...over,
})
const PEOPLE = new Map([
  ['p-alex', P('Alex Example', 'fte', { annual_salary: 36000 })],
  ['p-max', P('Max Beta', 'fte', { annual_salary: 24000 })],
  ['p-jordan', P('Jordan Sample', 'contractor', { hourly_rate: 30 })],
  ['p-casey', P('Casey Demo', 'contractor', { hourly_rate: 27.13 }, { active: false })],
  ['p-sam', P('Sam Demo', 'fte')],
  ['p-olive', P('Olive Owner', 'fte')],
])
const MEMBERSHIPS = new Map([
  ['p-alex', new Set([STILL, HATCH])],
  ['p-max', new Set([STILL, HATCH])],
  ['p-jordan', new Set([STILL])],
  ['p-sam', new Set([STILL])],
  ['p-olive', new Set([STILL])],
])
const REVENUE = new Map([
  [STILL, { mrrCents: 1_000_000, recurringMembers: 191, yieldCents: 5236 }],
  [HATCH, { mrrCents: 0, recurringMembers: 0, yieldCents: null }],
])
const BOTH = [{ id: STILL, name: 'UN1T Stillorgan' }, { id: HATCH, name: 'UN1T Hatch Street' }]

const build = (over = {}) => buildLabourMonth({
  period: PERIOD, nowMs: NOW, studios: BOTH, rows: labourShiftRows(BLOCKS),
  people: PEOPLE, memberships: MEMBERSHIPS, revenue: REVENUE, ...over,
})
const rowOf = (vm, id) => vm.studios.find((s) => s.location_id === id)

describe('labourShiftRows', () => {
  it('keeps live assignments only, with the published flag and the block times', () => {
    const rows = labourShiftRows(BLOCKS)
    expect(rows).toHaveLength(7) // 8 assignments, one cancelled
    expect(rows.filter((r) => !r.published)).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      profile_id: 'p-alex', location_id: STILL, block_date: '2026-09-01', published: true,
      start_time: '09:00:00', end_time: '12:00:00',
      shift_templates: { start_time: '09:00:00', end_time: '12:00:00' },
    })
  })

  it('a block with no roster is not published', () => {
    const [row] = labourShiftRows([{ ...BLOCKS[0], rosters: null }])
    expect(row.published).toBe(false)
  })
})

describe('labourPct', () => {
  it('one decimal place, and never against no revenue', () => {
    expect(labourPct(334_000, 1_000_000)).toBe(33.4)
    expect(labourPct(0, 1_000_000)).toBe(0)
    expect(labourPct(334_000, 0)).toBe(null)
    expect(labourPct(334_000, null)).toBe(null)
  })
})

describe('buildLabourMonth', () => {
  it('the month header', () => {
    const vm = build()
    expect(vm).toMatchObject({ month: '2026-09', month_label: 'September 2026', day_of_month: 16, days_in_month: 30, untimed_shifts: 0 })
  })

  it('Stillorgan row: salaries by hours and pro-rated, contractors per hour (admin included), ratios on MRR', () => {
    expect(rowOf(build(), STILL)).toEqual({
      location_id: STILL, name: 'UN1T Stillorgan',
      revenue_status: 'tracked', mrr_cents: 1_000_000, recurring_members: 191, revenue_to_date_cents: 500_000,
      forecast: { employees_cents: 325_000, contractors_cents: 9_000, cost_cents: 334_000, hours: 7 },
      actual: { employees_cents: 162_500, contractors_cents: 6_000, cost_cents: 168_500, hours: 6 },
      forecast_pct: 33.4, actual_pct: 33.7,
      draft_hours: 1,
    })
  })

  it('Hatch row: labour shown, no revenue tracked, so no ratio; 24:00 is midnight; a deactivated contractor is still paid', () => {
    expect(rowOf(build(), HATCH)).toEqual({
      location_id: HATCH, name: 'UN1T Hatch Street',
      revenue_status: 'none', mrr_cents: null, recurring_members: null, revenue_to_date_cents: null,
      forecast: { employees_cents: 175_000, contractors_cents: 5_426, cost_cents: 180_426, hours: 3 },
      actual: { employees_cents: 87_500, contractors_cents: 5_426, cost_cents: 92_926, hours: 2 },
      forecast_pct: null, actual_pct: null,
      draft_hours: 0,
    })
  })

  it('total: sums every studio shown, ratios over studios with revenue only, and names the rest', () => {
    expect(build().total).toEqual({
      name: 'All studios shown',
      revenue_status: 'tracked', mrr_cents: 1_000_000, recurring_members: 191, revenue_to_date_cents: 500_000,
      forecast: { employees_cents: 500_000, contractors_cents: 14_426, cost_cents: 514_426, hours: 10 },
      actual: { employees_cents: 250_000, contractors_cents: 11_426, cost_cents: 261_426, hours: 8 },
      forecast_pct: 33.4, actual_pct: 33.7,
      draft_hours: 1,
      ratio_excludes: ['UN1T Hatch Street'],
    })
  })

  it('uncosted: someone who worked with no salary is named with their hours; no-one who did not work is', () => {
    expect(build().uncosted).toEqual([{ name: 'Sam Demo', reason: 'no_salary', hours: 1 }])
  })

  it('no pay value, and no pay column name, reaches the view model', () => {
    const json = JSON.stringify(build())
    for (const leak of ['36000', '24000', '27.13', '2713', 'annual_salary', 'hourly_rate', 'overtime_rate']) {
      expect(json).not.toContain(leak)
    }
  })

  it('a single studio shown: no total, and the other studio\'s salary share stays out of it', () => {
    const vm = build({ studios: [BOTH[0]] })
    expect(vm.total).toBe(null)
    expect(vm.studios).toHaveLength(1)
    expect(rowOf(vm, STILL).forecast.cost_cents).toBe(334_000) // the same split as with both shown
  })

  it('an unrostered salary is left out when the owner switch is off', () => {
    expect(COUNT_UNROSTERED_SALARIES).toBe(true)
    const vm = build({ countUnrostered: false })
    expect(rowOf(vm, STILL).forecast.employees_cents).toBe(225_000) // Alex only
    expect(rowOf(vm, HATCH).forecast.employees_cents).toBe(75_000)
  })

  it('revenue that could not be read: labour shown, ratio blank, left out of the total ratio', () => {
    const vm = build({ revenue: new Map([[STILL, null], [HATCH, REVENUE.get(HATCH)]]) })
    expect(rowOf(vm, STILL)).toMatchObject({ revenue_status: 'unavailable', mrr_cents: null, forecast_pct: null, actual_pct: null })
    expect(vm.total).toMatchObject({ revenue_status: 'none', mrr_cents: null, forecast_pct: null, actual_pct: null })
    expect(vm.total.ratio_excludes).toEqual(['UN1T Stillorgan', 'UN1T Hatch Street'])
  })

  it('no "so far" ratio at the first instant of the month (no revenue to date yet)', () => {
    const start = Date.UTC(2026, 7, 31, 23, 0)
    const vm = build({ period: labourMonthWindow(start), nowMs: start })
    expect(rowOf(vm, STILL)).toMatchObject({ revenue_to_date_cents: 0, actual_pct: null, forecast_pct: 33.4 })
  })

  it('a shift in progress counts toward the forecast only', () => {
    const now = Date.UTC(2026, 8, 16, 8, 30) // 09:30 Dublin
    const rows = labourShiftRows([B(STILL, '2026-09-16', '09:00:00', '11:00:00', [A('p-jordan')])])
    const vm = build({ period: labourMonthWindow(now), nowMs: now, rows, memberships: new Map() })
    expect(rowOf(vm, STILL).forecast).toMatchObject({ contractors_cents: 6_000, hours: 2 })
    expect(rowOf(vm, STILL).actual).toMatchObject({ contractors_cents: 0, hours: 0 })
  })

  it('autumn clock change: 00:30-03:30 on 25 Oct 2026 is four real hours', () => {
    const now = Date.UTC(2026, 9, 26, 12, 0)
    const rows = labourShiftRows([B(HATCH, '2026-10-25', '00:30:00', '03:30:00', [A('p-casey')])])
    const vm = build({ period: labourMonthWindow(now), nowMs: now, rows, memberships: new Map() })
    expect(rowOf(vm, HATCH).forecast).toMatchObject({ contractors_cents: 10_852, hours: 4 })
  })

  it('a deactivated employee who worked is named, not salaried', () => {
    const people = new Map([...PEOPLE, ['p-alex', { ...PEOPLE.get('p-alex'), active: false }]])
    const vm = build({ people })
    expect(vm.uncosted).toContainEqual({ name: 'Alex Example', reason: 'inactive_employee', hours: 4 })
    expect(rowOf(vm, STILL).forecast.employees_cents).toBe(100_000) // Max only
  })

  it('a contractor with no rate, an unknown type and a missing profile are named', () => {
    const people = new Map([...PEOPLE,
      ['p-jordan', { ...PEOPLE.get('p-jordan'), hourly_rate: null }],
      ['p-sam', { ...PEOPLE.get('p-sam'), employment_type: null }],
    ])
    people.delete('p-casey')
    const vm = build({ people })
    expect(vm.uncosted).toEqual([
      { name: 'Jordan Sample', reason: 'no_rate', hours: 3 },
      { name: 'Sam Demo', reason: 'unknown_type', hours: 1 },
      { name: 'Unknown person', reason: 'unknown_person', hours: 2 },
    ])
  })

  it('a published shift with no usable times is counted as untimed, never costed', () => {
    const rows = labourShiftRows([{ ...B(STILL, '2026-09-01', null, null, [A('p-jordan')]), shift_templates: null }])
    const vm = build({ rows, memberships: new Map() })
    expect(vm.untimed_shifts).toBe(1)
    expect(rowOf(vm, STILL).forecast.cost_cents).toBe(0)
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/labour-month-model.test.js`
Expected: the Task 2 tests pass; the new ones FAIL with `labourShiftRows is not a function` (and the same for `labourPct`, `buildLabourMonth`).

- [ ] **Step 3: Append the money half**

Append to `src/lib/labour-month-model.js`:

```js
/**
 * Flatten shift_blocks (with their embedded roster, template and
 * assignments) to one row per LIVE assignment, in the shape workingWindow
 * reads: override, then the block's own time, then the template's.
 */
export function labourShiftRows(blocks) {
  const rows = []
  for (const b of blocks || []) {
    const tpl = b?.shift_templates || {}
    const published = b?.rosters?.status === 'published'
    for (const a of b?.shift_assignments || []) {
      if (!a?.profile_id || !isLiveAssignment(a)) continue
      rows.push({
        assignment_id: a.id,
        block_id: b.id,
        profile_id: a.profile_id,
        location_id: b.location_id,
        block_date: b.block_date,
        published,
        status: a.status ?? null,
        start_time: b.start_time ?? null,
        end_time: b.end_time ?? null,
        start_time_override: a.start_time_override ?? null,
        end_time_override: a.end_time_override ?? null,
        shift_templates: { start_time: tpl.start_time ?? null, end_time: tpl.end_time ?? null },
      })
    }
  }
  return rows
}

function round1(n) { return Math.round(n * 10) / 10 }

/** Labour as a % of revenue, one decimal; null when there is no revenue to divide by. */
export function labourPct(costCents, revenueCents) {
  if (costCents == null || !(Number(revenueCents) > 0)) return null
  return Math.round((costCents / revenueCents) * 1000) / 10
}

function uncostedReason(person, type, current) {
  if (!person) return 'unknown_person'
  if (type === EMPLOYEE_TYPE) return current ? 'no_salary' : 'inactive_employee'
  if (type === CONTRACTOR_TYPE) return 'no_rate'
  return 'unknown_type'
}

function emptyAcc() {
  return {
    employees: { forecast: 0, actual: 0 },
    contractors: { forecast: 0, actual: 0 },
    minutes: { forecast: 0, actual: 0 },
  }
}

function shapeStudio({ studio, acc, rev, draftMinutes, elapsed }) {
  const status = rev == null
    ? 'unavailable'
    : (Number(rev.mrrCents) > 0 && Number(rev.recurringMembers) > 0 ? 'tracked' : 'none')
  const mrrCents = status === 'tracked' ? Math.round(Number(rev.mrrCents)) : null
  const revenueToDate = mrrCents != null ? Math.round(mrrCents * elapsed) : null
  const part = (k) => {
    const employees = Math.round(acc.employees[k])
    const contractors = Math.round(acc.contractors[k])
    return { employees_cents: employees, contractors_cents: contractors, cost_cents: employees + contractors, hours: round1(acc.minutes[k] / 60) }
  }
  const forecast = part('forecast')
  const actual = part('actual')
  return {
    location_id: studio.id,
    name: studio.name,
    revenue_status: status,
    mrr_cents: mrrCents,
    recurring_members: status === 'tracked' ? Number(rev.recurringMembers) : null,
    revenue_to_date_cents: revenueToDate,
    forecast,
    actual,
    forecast_pct: labourPct(forecast.cost_cents, mrrCents),
    actual_pct: labourPct(actual.cost_cents, revenueToDate),
    draft_hours: round1(draftMinutes / 60),
  }
}

function totalOf(rows) {
  if (rows.length < 2) return null
  const sum = (list, f) => list.reduce((t, r) => t + f(r), 0)
  const tracked = rows.filter((r) => r.revenue_status === 'tracked')
  const any = tracked.length > 0
  const mrr = any ? sum(tracked, (r) => r.mrr_cents) : null
  const toDate = any ? sum(tracked, (r) => r.revenue_to_date_cents) : null
  const part = (k) => ({
    employees_cents: sum(rows, (r) => r[k].employees_cents),
    contractors_cents: sum(rows, (r) => r[k].contractors_cents),
    cost_cents: sum(rows, (r) => r[k].cost_cents),
    hours: round1(sum(rows, (r) => r[k].hours)),
  })
  return {
    name: 'All studios shown',
    revenue_status: any ? 'tracked' : 'none',
    mrr_cents: mrr,
    recurring_members: any ? sum(tracked, (r) => r.recurring_members) : null,
    revenue_to_date_cents: toDate,
    forecast: part('forecast'),
    actual: part('actual'),
    // Ratios over the studios that HAVE revenue only: Hatch's labour on
    // Stillorgan's revenue would overstate the percentage.
    forecast_pct: labourPct(sum(tracked, (r) => r.forecast.cost_cents), mrr),
    actual_pct: labourPct(sum(tracked, (r) => r.actual.cost_cents), toDate),
    draft_hours: round1(sum(rows, (r) => r.draft_hours)),
    ratio_excludes: rows.filter((r) => r.revenue_status !== 'tracked').map((r) => r.name),
  }
}

/**
 * The owner's view model. TOTALS, RATIOS, HOURS AND NAMES ONLY.
 *
 * @param {object} args
 * @param {ReturnType<typeof labourMonthWindow>} args.period
 * @param {number} args.nowMs
 * @param {{id:string,name:string}[]} args.studios        the studios to show
 * @param {object[]} args.rows                              labourShiftRows over EVERY studio of the organisation
 * @param {Map<string, object>} args.people                 id → { full_name, employment_type, active, deleted_at, annual_salary, hourly_rate }
 * @param {Map<string, Set<string>>} args.memberships       id → the organisation's studios they belong to
 * @param {Map<string, {mrrCents:number, recurringMembers:number}|null>} args.revenue  per studio shown; null = could not be read
 * @param {boolean} [args.countUnrostered]
 */
export function buildLabourMonth({
  period, nowMs, studios, rows, people, memberships, revenue,
  countUnrostered = COUNT_UNROSTERED_SALARIES,
}) {
  const shownIds = new Set(studios.map((s) => s.id))

  // Published minutes per person per studio (forecast = all, actual = ended);
  // draft minutes per studio; untimed published shifts at a studio shown.
  const worked = new Map()
  const draftMinutes = new Map()
  let untimed = 0
  for (const r of rows || []) {
    const w = workingWindow(r)
    if (!w) {
      if (r.published && shownIds.has(r.location_id)) untimed += 1
      continue
    }
    const minutes = (w.endMs - w.startMs) / MINUTE_MS
    if (!r.published) {
      draftMinutes.set(r.location_id, (draftMinutes.get(r.location_id) || 0) + minutes)
      continue
    }
    if (!worked.has(r.profile_id)) worked.set(r.profile_id, new Map())
    const cells = worked.get(r.profile_id)
    const cell = cells.get(r.location_id) || { forecast: 0, actual: 0 }
    cell.forecast += minutes
    if (w.endMs <= nowMs) cell.actual += minutes
    cells.set(r.location_id, cell)
  }

  const acc = new Map(studios.map((s) => [s.id, emptyAcc()]))
  const uncosted = []
  const ids = new Set([...worked.keys(), ...(memberships ? memberships.keys() : [])])
  for (const id of ids) {
    const person = people?.get(id) || null
    const cells = worked.get(id) || new Map()
    let workedMinutes = 0
    let workedShownMinutes = 0
    for (const [loc, c] of cells) {
      workedMinutes += c.forecast
      const a = acc.get(loc)
      if (!a) continue
      a.minutes.forecast += c.forecast
      a.minutes.actual += c.actual
      workedShownMinutes += c.forecast
    }
    const type = person?.employment_type ?? null
    const salary = Number(person?.annual_salary) || 0
    const rate = Number(person?.hourly_rate) || 0
    const current = !!person && person.active !== false && !person.deleted_at

    if (type === EMPLOYEE_TYPE && salary > 0 && current) {
      const monthlyCents = (salary * 100) / 12
      let shares = []
      if (workedMinutes > 0) {
        shares = [...cells].map(([loc, c]) => [loc, c.forecast / workedMinutes])
      } else if (countUnrostered) {
        const locs = [...(memberships?.get(id) || [])]
        shares = locs.map((loc) => [loc, 1 / locs.length])
      }
      for (const [loc, share] of shares) {
        const a = acc.get(loc)
        if (!a) continue
        a.employees.forecast += monthlyCents * share
        a.employees.actual += monthlyCents * share * period.elapsedFraction
      }
      continue
    }

    if (type === CONTRACTOR_TYPE && rate > 0) {
      for (const [loc, c] of cells) {
        const a = acc.get(loc)
        if (!a) continue
        a.contractors.forecast += (c.forecast / 60) * rate * 100
        a.contractors.actual += (c.actual / 60) * rate * 100
      }
      continue
    }

    if (workedShownMinutes <= 0) continue // did not work here: nothing is missing
    uncosted.push({ name: person?.full_name || 'Unknown person', reason: uncostedReason(person, type, current), hours: round1(workedShownMinutes / 60) })
  }

  const studioRows = studios.map((s) => shapeStudio({
    studio: s,
    acc: acc.get(s.id),
    rev: revenue?.get(s.id) ?? null,
    draftMinutes: draftMinutes.get(s.id) || 0,
    elapsed: period.elapsedFraction,
  }))

  return {
    month: period.month,
    month_label: period.monthLabel,
    day_of_month: period.dayOfMonth,
    days_in_month: period.daysInMonth,
    studios: studioRows,
    total: totalOf(studioRows),
    uncosted: uncosted.sort((x, y) => x.name.localeCompare(y.name)),
    untimed_shifts: untimed,
  }
}
```

- [ ] **Step 4: Run under both zones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/labour-month-model.test.js && TZ=America/Los_Angeles npx vitest run src/lib/labour-month-model.test.js`
Expected: both runs, 30 passed. If "Stillorgan row" is off by a cent, check that `cost_cents` is the sum of the two ROUNDED parts (it must be, so the parts always add up on screen), not a separately rounded total.

- [ ] **Step 5: Commit**

```bash
git add src/lib/labour-month-model.js src/lib/labour-month-model.test.js
git commit -m "LABOUR.1 — labour against revenue, forecast and actual (pure model)

Salaries at 1/12 a month split by published hours; contractors per
published hour, admin included; MRR as revenue; drafts and cancelled
never costed; real-time hours (24:00 = midnight). Totals only.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: the reads

**Files:**
- Create: `src/lib/labour-month-data.js`
- Create: `src/lib/labour-month-data.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/labour-month-data.test.js`:

```js
// src/lib/labour-month-data.test.js
// LABOUR.1 — the reads behind the owner's labour block: scoped to the
// organisation, pay from profile_compensation, profiles by NAMED columns,
// and a failed read is an error, never a €0.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/studio-kpis', () => ({ fetchMrr: vi.fn() }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { fetchMrr } from '@shared/studio-kpis'
import { logError } from './log'
import { loadLabourMonth } from './labour-month-data'

const ORG = 'org-un1t'
const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const NOW = Date.UTC(2026, 8, 15, 23, 0) // 00:00 Dublin, 16 Sep 2026: half the month gone
const STUDIOS = [{ id: STILL, name: 'UN1T Stillorgan' }]

function fakeDb(spec) {
  const calls = []
  return {
    calls,
    from(table) {
      const chain = []
      calls.push({ table, chain })
      const b = {}
      for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'range', 'maybeSingle']) {
        b[m] = (...args) => { chain.push([m, ...args]); return b }
      }
      b.then = (resolve, reject) => {
        const s = spec[table]
        const out = typeof s === 'function' ? s(chain) : (s ?? { data: [], error: null })
        return Promise.resolve(out).then(resolve, reject)
      }
      return b
    },
  }
}
const has = (chain, m) => chain.some((c) => c[0] === m)
const chainOf = (db, table) => db.calls.find((c) => c.table === table)?.chain

const LOCATIONS = (chain) => (has(chain, 'maybeSingle')
  ? { data: { id: STILL, organization_id: ORG }, error: null }
  : { data: [{ id: HATCH }], error: null })
const BLOCKS = [
  {
    id: 'b1', location_id: STILL, block_date: '2026-09-01', start_time: '09:00:00', end_time: '12:00:00',
    rosters: { status: 'published' }, shift_templates: { start_time: '09:00:00', end_time: '12:00:00', kind: 'class' },
    shift_assignments: [{ id: 'a1', profile_id: 'p-alex', start_time_override: null, end_time_override: null, status: 'scheduled' }],
  },
  {
    id: 'b2', location_id: STILL, block_date: '2026-09-02', start_time: '17:00:00', end_time: '19:00:00',
    rosters: { status: 'published' }, shift_templates: { start_time: '17:00:00', end_time: '19:00:00', kind: 'admin' },
    shift_assignments: [{ id: 'a2', profile_id: 'p-jordan', start_time_override: null, end_time_override: null, status: 'scheduled' }],
  },
]
const LINKS = [{ profile_id: 'p-alex', location_id: STILL }, { profile_id: 'p-jordan', location_id: STILL }]
const PROFILES = [
  { id: 'p-alex', full_name: 'Alex Example', active: true, deleted_at: null, employment_type: 'fte' },
  { id: 'p-jordan', full_name: 'Jordan Sample', active: true, deleted_at: null, employment_type: 'contractor' },
]
const COMP = [
  { profile_id: 'p-alex', annual_salary: '36000.00', hourly_rate: null, contracted_hours_per_week: '39.0', annual_leave_entitlement: null, overtime_rate: null },
  { profile_id: 'p-jordan', annual_salary: null, hourly_rate: '30.00', contracted_hours_per_week: null, annual_leave_entitlement: null, overtime_rate: null },
]
const okSpec = (over = {}) => ({
  locations: LOCATIONS,
  shift_blocks: { data: BLOCKS, error: null },
  profile_locations: { data: LINKS, error: null },
  profiles: { data: PROFILES, error: null },
  profile_compensation: { data: COMP, error: null },
  ...over,
})

beforeEach(() => {
  vi.mocked(fetchMrr).mockReset()
  vi.mocked(fetchMrr).mockResolvedValue({ success: true, data: { mrrCents: 1_000_000, recurringMembers: 191, yieldCents: 5236 } })
  vi.mocked(logError).mockReset()
})

describe('loadLabourMonth', () => {
  it('computes the month for the studios shown', async () => {
    const db = fakeDb(okSpec())
    const { data, error } = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(error).toBeUndefined()
    // Alex: €3,000/month, all of it at Stillorgan; Jordan: 2h × €30 (admin shift).
    expect(data.studios[0]).toMatchObject({
      location_id: STILL,
      forecast: { employees_cents: 300_000, contractors_cents: 6_000, cost_cents: 306_000, hours: 5 },
      actual: { employees_cents: 150_000, contractors_cents: 6_000, cost_cents: 156_000, hours: 5 },
      forecast_pct: 30.6, actual_pct: 31.2,
    })
  })

  it('reads the roster at every studio of the organisation, for the Dublin month, paged', async () => {
    const db = fakeDb(okSpec())
    await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    const chain = chainOf(db, 'shift_blocks')
    expect(chain).toContainEqual(['in', 'location_id', [STILL, HATCH]])
    expect(chain).toContainEqual(['gte', 'block_date', '2026-09-01'])
    expect(chain).toContainEqual(['lte', 'block_date', '2026-09-30'])
    expect(chain).toContainEqual(['order', 'id', { ascending: true }])
    expect(chain).toContainEqual(['range', 0, 999])
    expect(chainOf(db, 'profile_locations')).toContainEqual(['in', 'location_id', [STILL, HATCH]])
  })

  it('names its profiles columns (no pay from profiles) and reads pay from profile_compensation by id', async () => {
    const db = fakeDb(okSpec())
    await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    const profiles = chainOf(db, 'profiles')
    expect(profiles[0]).toEqual(['select', 'id, full_name, active, deleted_at, employment_type'])
    expect(profiles).toContainEqual(['in', 'id', ['p-alex', 'p-jordan']])
    expect(chainOf(db, 'profile_compensation')).toContainEqual(['in', 'profile_id', ['p-alex', 'p-jordan']])
  })

  it('asks the scorecard\'s fetchMrr once per studio shown', async () => {
    const db = fakeDb(okSpec())
    await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(fetchMrr).toHaveBeenCalledTimes(1)
    expect(fetchMrr).toHaveBeenCalledWith(db, STILL)
  })

  it('drops a studio outside the organisation even if it is passed in', async () => {
    const db = fakeDb(okSpec())
    const { data } = await loadLabourMonth(db, {
      activeLocationId: STILL, studios: [...STUDIOS, { id: 'loc-cars', name: 'CCF Autos' }], nowMs: NOW,
    })
    expect(data.studios.map((s) => s.location_id)).toEqual([STILL])
    expect(fetchMrr).toHaveBeenCalledTimes(1)
  })

  it('fetchMrr failing or throwing for a studio: that studio shows "unavailable", the block still renders', async () => {
    vi.mocked(fetchMrr).mockResolvedValueOnce({ success: false, error: 'timeout' })
    const db = fakeDb(okSpec())
    const { data } = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(data.studios[0]).toMatchObject({ revenue_status: 'unavailable', forecast_pct: null })

    vi.mocked(fetchMrr).mockRejectedValueOnce(new Error('boom'))
    const again = await loadLabourMonth(fakeDb(okSpec()), { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(again.data.studios[0].revenue_status).toBe('unavailable')
  })

  it('a failed roster read is an error, logged, never a €0', async () => {
    const db = fakeDb(okSpec({ shift_blocks: { data: null, error: { message: 'boom' } } }))
    const res = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(res).toEqual({ error: 'Could not read the roster' })
    expect(logError).toHaveBeenCalledWith('labour-month', 'the roster read failed', expect.objectContaining({ location_id: STILL, month: '2026-09' }))
  })

  it('a failed read of the organisation\'s studios is an error', async () => {
    const db = fakeDb(okSpec({ locations: (chain) => (has(chain, 'maybeSingle') ? LOCATIONS(chain) : { data: null, error: { message: 'boom' } }) }))
    const res = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(res).toEqual({ error: "Could not read the organisation's studios" })
  })

  it('a failed profiles or pay read is an error', async () => {
    const p = await loadLabourMonth(fakeDb(okSpec({ profiles: { data: null, error: { message: 'x' } } })), { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(p).toEqual({ error: 'Could not read staff' })
    const c = await loadLabourMonth(fakeDb(okSpec({ profile_compensation: { data: null, error: { message: 'x' } } })), { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(c).toEqual({ error: 'Could not read pay' })
  })

  it('refuses with no studio', async () => {
    const res = await loadLabourMonth(fakeDb(okSpec()), { activeLocationId: STILL, studios: [], nowMs: NOW })
    expect(res).toEqual({ error: 'No studio to report on' })
  })
})
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run src/lib/labour-month-data.test.js`
Expected: FAIL, `Failed to resolve import "./labour-month-data"`.

- [ ] **Step 3: Write the module**

Create `src/lib/labour-month-data.js`:

```js
// src/lib/labour-month-data.js
//
// LABOUR.1 — the reads behind the owner's "Labour against revenue" block.
// Service-role reads: NO RLS applies (CLAUDE.md), so every read is scoped here.
//
//   organisation  = the active studio + siblingLocationIds (ORGSCOPE.1); the
//                   studios SHOWN are clipped to it, whatever the caller passed.
//   roster        = shift_blocks at every studio of the organisation in the
//                   Dublin month, with roster status, template times and
//                   assignments; paged past the 1,000-row cap.
//   memberships   = profile_locations at those studios (unrostered salaries).
//   people        = profiles by id, NAMED columns only (profiles still carries
//                   pay columns: CLAUDE.md "name your columns").
//   pay           = profile_compensation (mig 152, the canonical copy) by id.
//   revenue       = the Studio scorecard's own fetchMrr, per studio shown.
//
// Never throws. A failed organisation, roster, membership, profiles or pay read
// returns { error } (logged): a partial labour figure would read as a real one.
// A failed MRR read degrades that one studio to "unavailable" (its ratio is
// visibly missing, never 0%).
//
// Cost: two small locations reads, then the roster and memberships in parallel,
// then profiles (chunked by 200 ids), the pay read, and one MRR read per studio
// shown. Two studios and ~20 people today: one page each.

import { selectAll } from './select-all'
import { siblingLocationIds } from './sibling-locations'
import { getCompensationForProfiles } from './profile-compensation'
import { logError, logWarn } from './log'
import { fetchMrr } from '@shared/studio-kpis'
import { labourMonthWindow, labourShiftRows, buildLabourMonth } from './labour-month-model'

const ID_CHUNK = 200

/**
 * @param {object} db  service-role client
 * @param {{ activeLocationId: string, studios: {id:string,name:string}[], nowMs?: number }} args
 *   studios: from labourStudiosFor(user) — the caller has already decided
 *   the viewer is an owner there.
 * @returns {Promise<{ data: object } | { error: string }>}
 */
export async function loadLabourMonth(db, { activeLocationId, studios, nowMs = Date.now() } = {}) {
  if (!activeLocationId || !Array.isArray(studios) || studios.length === 0) {
    return { error: 'No studio to report on' }
  }
  const period = labourMonthWindow(nowMs)
  const failed = (what, err) => {
    logError('labour-month', `${what} read failed`, {
      err: err?.message || String(err), location_id: activeLocationId, month: period.month,
    })
    return { error: `Could not read ${what}` }
  }

  const siblings = await siblingLocationIds(db, activeLocationId)
  if (siblings.error) return failed("the organisation's studios", siblings.error)
  const orgStudioIds = [activeLocationId, ...siblings.ids]
  const shown = studios.filter((s) => s?.id && orgStudioIds.includes(s.id))
  if (shown.length === 0) return { error: 'No studio to report on' }

  let blocks
  let links
  try {
    ;[blocks, links] = await Promise.all([
      selectAll((from, to) => db
        .from('shift_blocks')
        .select('id, location_id, block_date, start_time, end_time, rosters:roster_id ( status ), shift_templates ( start_time, end_time, kind ), shift_assignments ( id, profile_id, start_time_override, end_time_override, status )')
        .in('location_id', orgStudioIds)
        .gte('block_date', period.startDate)
        .lte('block_date', period.endDate)
        .order('id', { ascending: true })
        .range(from, to)),
      selectAll((from, to) => db
        .from('profile_locations')
        .select('profile_id, location_id')
        .in('location_id', orgStudioIds)
        .order('profile_id', { ascending: true })
        .order('location_id', { ascending: true })
        .range(from, to)),
    ])
  } catch (e) {
    return failed('the roster', e)
  }

  const rows = labourShiftRows(blocks)
  const memberships = new Map()
  for (const l of links || []) {
    if (!l?.profile_id) continue
    if (!memberships.has(l.profile_id)) memberships.set(l.profile_id, new Set())
    memberships.get(l.profile_id).add(l.location_id)
  }

  const ids = [...new Set([...rows.map((r) => r.profile_id), ...memberships.keys()])]
  const people = new Map()
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const slice = ids.slice(i, i + ID_CHUNK)
    const { data, error } = await db.from('profiles').select('id, full_name, active, deleted_at, employment_type').in('id', slice)
    if (error) return failed('staff', error)
    for (const p of data || []) {
      people.set(p.id, {
        full_name: p.full_name, employment_type: p.employment_type,
        active: p.active, deleted_at: p.deleted_at,
        annual_salary: null, hourly_rate: null,
      })
    }
  }

  let comp
  try {
    comp = await getCompensationForProfiles(db, ids)
  } catch (e) {
    return failed('pay', e)
  }
  for (const [id, c] of comp) {
    const p = people.get(id)
    if (!p) continue
    p.annual_salary = c.annual_salary
    p.hourly_rate = c.hourly_rate
  }

  const revenue = new Map(await Promise.all(shown.map(async (s) => {
    try {
      const res = await fetchMrr(db, s.id)
      if (res?.success) return [s.id, res.data]
      logWarn('labour-month', 'MRR read failed', { location_id: s.id, err: res?.error })
    } catch (e) {
      logWarn('labour-month', 'MRR read threw', { location_id: s.id, err: e?.message })
    }
    return [s.id, null]
  })))

  return { data: buildLabourMonth({ period, nowMs, studios: shown, rows, people, memberships, revenue }) }
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/labour-month-data.test.js`
Expected: 10 passed. If "a failed read of the organisation's studios" returns a success, check that `siblingLocationIds`'s error arm is honoured (it returns `ids: []` WITH an error; an empty id list alone is legitimate for a one-studio organisation).

- [ ] **Step 5: The two repo sweeps that read this file**

Run: `npx vitest run tests/staff-tombstone-readers.test.js tests/shared-pair-sync.test.js && npm run check:select-columns`
Expected: green. The `profiles` read carries `.in('id'` inside the tombstone sweep's 400-character window (keep the chain on one line as written). `check:select-columns` resolves every literal column: `shift_blocks` (067, `rosters` embed via `roster_id`, `shift_templates.kind` 628), `shift_assignments` overrides (099/100), `profile_locations`, `profiles.deleted_at` (622).

- [ ] **Step 6: Commit**

```bash
git add src/lib/labour-month-data.js src/lib/labour-month-data.test.js
git commit -m "LABOUR.1 — the labour reads: organisation-scoped, pay from profile_compensation

Never throws; a failed roster, staff or pay read is an error, never a
EUR 0. MRR degrades per studio. profiles by named columns only.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `LabourPanel`

**Files:**
- Create: `src/components/dashboard/LabourPanel.jsx`
- Create: `src/components/dashboard/LabourPanel.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/dashboard/LabourPanel.test.jsx`:

```jsx
// LABOUR.1 — what the owner's labour block puts in the markup. Rendered to
// static markup in the node environment (no jsdom), like RosterRunwayChip.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LabourPanel } from './LabourPanel'

const part = (employees, contractors, hours) => ({
  employees_cents: employees, contractors_cents: contractors, cost_cents: employees + contractors, hours,
})
const STILL = {
  location_id: 'loc-still', name: 'UN1T Stillorgan',
  revenue_status: 'tracked', mrr_cents: 1_000_000, recurring_members: 191, revenue_to_date_cents: 500_000,
  forecast: part(325_000, 9_000, 7), actual: part(162_500, 6_000, 6),
  forecast_pct: 33.4, actual_pct: 33.7, draft_hours: 1,
}
const HATCH = {
  location_id: 'loc-hatch', name: 'UN1T Hatch Street',
  revenue_status: 'none', mrr_cents: null, recurring_members: null, revenue_to_date_cents: null,
  forecast: part(175_000, 5_426, 3), actual: part(87_500, 5_426, 2),
  forecast_pct: null, actual_pct: null, draft_hours: 0,
}
const VM = {
  month: '2026-09', month_label: 'September 2026', day_of_month: 16, days_in_month: 30,
  studios: [STILL, HATCH],
  total: {
    name: 'All studios shown', revenue_status: 'tracked', mrr_cents: 1_000_000, recurring_members: 191,
    revenue_to_date_cents: 500_000, forecast: part(500_000, 14_426, 10), actual: part(250_000, 11_426, 8),
    forecast_pct: 33.4, actual_pct: 33.7, draft_hours: 1, ratio_excludes: ['UN1T Hatch Street'],
  },
  uncosted: [{ name: 'Sam Demo', reason: 'no_salary', hours: 1 }],
  untimed_shifts: 0,
}

const html = (vm = VM) => renderToStaticMarkup(<LabourPanel vm={vm} />)

describe('LabourPanel', () => {
  it('heads the block with the month and the day', () => {
    expect(html()).toContain('Labour against revenue · September 2026')
    expect(html()).toContain('Day 16 of 30')
  })

  it('shows each studio: forecast and so far, in euros and as a share of revenue', () => {
    const out = html()
    expect(out).toContain('UN1T Stillorgan')
    expect(out).toContain('€3,340')
    expect(out).toContain('33.4%')
    expect(out).toContain('€1,685')
    expect(out).toContain('33.7%')
    expect(out).toContain('€10,000/month recurring (MRR), 191 members')
  })

  it('a studio with no revenue says so and shows no percentage', () => {
    const out = html({ ...VM, studios: [HATCH], total: null })
    expect(out).toContain('Not tracked here')
    expect(out).not.toContain('%')
  })

  it('an unreadable revenue says so', () => {
    expect(html({ ...VM, studios: [{ ...HATCH, revenue_status: 'unavailable' }], total: null })).toContain('Could not be read')
  })

  it('the total, and which studios its ratios leave out', () => {
    const out = html()
    expect(out).toContain('All studios shown')
    expect(out).toContain('Ratios leave out UN1T Hatch Street')
  })

  it('names who worked with no pay on file, with hours and reason', () => {
    expect(html()).toContain('No pay on file, so not counted: Sam Demo (1h, no salary)')
  })

  it('says how many draft hours the forecast leaves out, and any untimed shifts', () => {
    expect(html()).toContain('1h in draft rosters not counted')
    expect(html({ ...VM, untimed_shifts: 2 })).toContain('2 published shifts have no times and are not counted')
  })

  it('says what revenue means', () => {
    expect(html()).toContain('Class packs, drop-ins and one-off charges are not in it')
  })
})
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/components/dashboard/LabourPanel.test.jsx`
Expected: FAIL, cannot resolve `./LabourPanel`.

- [ ] **Step 3: Write the component**

Create `src/components/dashboard/LabourPanel.jsx`:

```jsx
// src/components/dashboard/LabourPanel.jsx
//
// LABOUR.1 — the owner's "Labour against revenue" block. Presentational and
// server-component-safe (no state, no 'use client'): it is rendered to HTML on
// the server by LabourBlock, so its props never travel to the browser as data.
// The view model (src/lib/labour-month-model.js) carries totals, ratios, hours
// and names only.

const REASONS = {
  no_salary: 'no salary',
  inactive_employee: 'deactivated employee',
  no_rate: 'no hourly rate',
  unknown_type: 'no employment type',
  unknown_person: 'profile not found',
}

function euros(cents) {
  if (cents == null) return '—'
  return `€${Math.round(cents / 100).toLocaleString('en-IE')}`
}

function pctLabel(p) {
  return p == null ? null : `${p.toFixed(1)}%`
}

function revenueLine(row) {
  if (row.revenue_status === 'tracked') {
    return `${euros(row.mrr_cents)}/month recurring (MRR), ${row.recurring_members} members`
  }
  if (row.revenue_status === 'unavailable') return 'Could not be read'
  return 'Not tracked here'
}

function StudioLabour({ row, isTotal = false }) {
  const f = pctLabel(row.forecast_pct)
  const a = pctLabel(row.actual_pct)
  return (
    <div className={`rounded-md border border-un1t-border px-3 py-2 ${isTotal ? 'bg-un1t-bg' : ''}`}>
      <p className="text-sm font-medium text-un1t-text">{row.name}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-un1t-muted">Forecast, whole month</dt>
        <dd className="text-un1t-text">
          <span className="font-semibold">{euros(row.forecast.cost_cents)}</span>
          {f ? ` · ${f} of revenue` : ''} · {row.forecast.hours}h
        </dd>
        <dt className="text-un1t-muted">So far</dt>
        <dd className="text-un1t-text">
          <span className="font-semibold">{euros(row.actual.cost_cents)}</span>
          {a ? ` · ${a} of revenue to date` : ''} · {row.actual.hours}h
        </dd>
        <dt className="text-un1t-muted">Revenue</dt>
        <dd className="text-un1t-text">{revenueLine(row)}</dd>
        <dt className="text-un1t-muted">Forecast split</dt>
        <dd className="text-un1t-text">
          employees {euros(row.forecast.employees_cents)} · contractors {euros(row.forecast.contractors_cents)}
        </dd>
      </dl>
      {row.draft_hours > 0 ? (
        <p className="mt-1 text-xs text-un1t-muted">{row.draft_hours}h in draft rosters not counted</p>
      ) : null}
      {isTotal && row.ratio_excludes?.length > 0 ? (
        <p className="mt-1 text-xs text-un1t-muted">
          Ratios leave out {row.ratio_excludes.join(', ')}: no revenue tracked there.
        </p>
      ) : null}
    </div>
  )
}

export function LabourPanel({ vm }) {
  return (
    <section aria-labelledby="labour-heading" className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="labour-heading" className="text-sm font-semibold text-un1t-text">
          Labour against revenue · {vm.month_label}
        </h2>
        <span className="text-xs text-un1t-muted">Day {vm.day_of_month} of {vm.days_in_month} · owners only</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {vm.studios.map((row) => <StudioLabour key={row.location_id} row={row} />)}
        {vm.total ? <StudioLabour row={vm.total} isTotal /> : null}
      </div>
      {vm.uncosted.length > 0 ? (
        <p className="mt-3 text-xs text-amber-700">
          No pay on file, so not counted: {vm.uncosted.map((u) => `${u.name} (${u.hours}h, ${REASONS[u.reason] || u.reason})`).join(', ')}.
        </p>
      ) : null}
      {vm.untimed_shifts > 0 ? (
        <p className="mt-1 text-xs text-amber-700">
          {vm.untimed_shifts} published shift{vm.untimed_shifts === 1 ? ' has' : 's have'} no times and {vm.untimed_shifts === 1 ? 'is' : 'are'} not counted.
        </p>
      ) : null}
      <p className="mt-3 text-xs text-un1t-subtle">
        Revenue is the recurring membership base billing now (the Studio scorecard&apos;s MRR), pro-rated to today for
        &quot;so far&quot;. Class packs, drop-ins and one-off charges are not in it. Forecast is the published roster for
        the whole month. Salaries count in full (a twelfth a month, pro-rated to today for &quot;so far&quot;), split
        between studios by rostered hours. Contractors count per rostered hour at their rate, admin shifts included.
      </p>
    </section>
  )
}
```

Note: `renderToStaticMarkup` escapes `'` and `"`, which is why no test asserts on text containing them.

- [ ] **Step 4: Run**

Run: `npx vitest run src/components/dashboard/LabourPanel.test.jsx`
Expected: 8 passed. `toLocaleString('en-IE')` needs Node's full ICU (the default build has it; `RosterSummaryPanel` tests rely on it too).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/LabourPanel.jsx src/components/dashboard/LabourPanel.test.jsx
git commit -m "LABOUR.1 — LabourPanel (server-safe, totals and ratios only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `LabourBlock`, the Business dashboard, and the owner gate

**Files:**
- Create: `src/components/dashboard/LabourBlock.jsx`
- Create: `src/components/dashboard/LabourBlock.test.jsx`
- Modify: `src/app/dashboard/business/page.js` (imports after line 21; after line 139; after lines 151-153)
- Create: `tests/labour-owner-gate.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/components/dashboard/LabourBlock.test.jsx`:

```jsx
// LABOUR.1 — the async server block: a failed load is the standard error
// cell, never a panel of zeros.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }) => <a href={typeof href === 'string' ? href : '#'} {...rest}>{children}</a>,
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'service-role' })) }))
vi.mock('@/lib/labour-month-data', () => ({ loadLabourMonth: vi.fn() }))

import { loadLabourMonth } from '@/lib/labour-month-data'
import { LabourBlock } from './LabourBlock'

const STUDIOS = [{ id: 'loc-still', name: 'UN1T Stillorgan' }]
const VM = {
  month: '2026-09', month_label: 'September 2026', day_of_month: 16, days_in_month: 30,
  studios: [], total: null, uncosted: [], untimed_shifts: 0,
}

beforeEach(() => { vi.mocked(loadLabourMonth).mockReset() })

describe('LabourBlock', () => {
  it('passes the service-role client, the active studio and the studios to the loader', async () => {
    vi.mocked(loadLabourMonth).mockResolvedValue({ data: VM })
    await LabourBlock({ activeLocationId: 'loc-still', studios: STUDIOS, nowMs: 123 })
    expect(loadLabourMonth).toHaveBeenCalledWith({ tag: 'service-role' }, { activeLocationId: 'loc-still', studios: STUDIOS, nowMs: 123 })
  })

  it('renders the panel on success', async () => {
    vi.mocked(loadLabourMonth).mockResolvedValue({ data: VM })
    const out = renderToStaticMarkup(await LabourBlock({ activeLocationId: 'loc-still', studios: STUDIOS }))
    expect(out).toContain('Labour against revenue · September 2026')
  })

  it('an error result is the error cell, with no figures', async () => {
    vi.mocked(loadLabourMonth).mockResolvedValue({ error: 'Could not read pay' })
    const out = renderToStaticMarkup(await LabourBlock({ activeLocationId: 'loc-still', studios: STUDIOS }))
    expect(out).toContain('Labour against revenue couldn')
    expect(out).not.toContain('€')
  })

  it('a thrown loader is the error cell too', async () => {
    vi.mocked(loadLabourMonth).mockRejectedValue(new Error('boom'))
    const out = renderToStaticMarkup(await LabourBlock({ activeLocationId: 'loc-still', studios: STUDIOS }))
    expect(out).toContain('Labour against revenue couldn')
  })
})
```

Create `tests/labour-owner-gate.test.js`:

```js
// tests/labour-owner-gate.test.js
// LABOUR.1 — labour against revenue carries pay (with one coach at a studio,
// the total IS their pay). It is owner-only by ROLE and web-only. A floor, not
// a proof: it reads source text, like the other guard sweeps in tests/.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repo, p), 'utf8')

describe('LABOUR.1 owner gate', () => {
  it('the Business page renders the labour block once, behind canSeeLabour(user)', () => {
    const src = read('src/app/dashboard/business/page.js')
    expect(src).toContain('const showLabour = canSeeLabour(user)')
    expect(src.split('<LabourBlock').length - 1).toBe(1)
    const at = src.indexOf('<LabourBlock')
    expect(src.slice(Math.max(0, at - 200), at)).toContain('showLabour ?')
  })

  it('the phone Business route never carries labour', () => {
    const src = read('src/app/api/dashboard/business/route.js')
    expect(src).not.toMatch(/labour-month|LabourBlock|LabourPanel/)
  })

  it('the panel and block are not client components', () => {
    for (const f of ['src/components/dashboard/LabourPanel.jsx', 'src/components/dashboard/LabourBlock.jsx']) {
      expect(read(f)).not.toMatch(/['"]use client['"]/)
    }
  })
})
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run src/components/dashboard/LabourBlock.test.jsx tests/labour-owner-gate.test.js`
Expected: FAIL (`./LabourBlock` missing; the page has no `showLabour`).

- [ ] **Step 3: Write the block**

Create `src/components/dashboard/LabourBlock.jsx`:

```jsx
// src/components/dashboard/LabourBlock.jsx
//
// LABOUR.1 — async SERVER component for the Business dashboard. It loads
// the owner's labour view model with the service-role client and renders it
// to HTML here, so no pay-derived data is serialised to the browser. The
// caller (page.js) decides who sees it: canSeeLabour(user), owners only.
//
// react-hooks/error-boundaries: the await happens inside try/catch and the
// JSX is built after it (the DASH-REBUILD pattern in page.js).

import { createServerClient } from '@/lib/supabase'
import { loadLabourMonth } from '@/lib/labour-month-data'
import { LabourPanel } from './LabourPanel'
import { BlockError } from './BusinessBlocks'

export async function LabourBlock({ activeLocationId, studios, nowMs = Date.now() }) {
  let vm = null
  try {
    const res = await loadLabourMonth(createServerClient(), { activeLocationId, studios, nowMs })
    vm = res?.data ?? null
  } catch {
    vm = null
  }
  if (!vm) return <BlockError label="Labour against revenue" />
  return <LabourPanel vm={vm} />
}
```

- [ ] **Step 4: Wire it into the page**

In `src/app/dashboard/business/page.js`:

After the `BusinessBlocks` import (the block ending at line 21, `} from '@/components/dashboard/BusinessBlocks'`), add:

```js
import { LabourBlock } from '@/components/dashboard/LabourBlock'
import { canSeeLabour, labourStudiosFor } from '@/lib/labour-month-model'
```

After `const locationName = user.activeLocation?.name` (line 139), add:

```js
  // LABOUR.1 — owners only, by ROLE at the active studio (a master too).
  // dashboard_business alone is not enough: an owner can grant it to a
  // manager, and a studio's labour total can be one person's pay.
  const showLabour = canSeeLabour(user)
  const labourStudios = showLabour ? labourStudiosFor(user) : []
```

After the `MembershipBlock` Suspense (lines 151-153), before the `TodayBlock` Suspense, add:

```jsx
          {showLabour ? (
            <Suspense fallback={<BlockSkeleton lines={5} />}>
              <LabourBlock activeLocationId={locationId} studios={labourStudios} />
            </Suspense>
          ) : null}
```

- [ ] **Step 5: Run**

Run: `npx vitest run src/components/dashboard/LabourBlock.test.jsx tests/labour-owner-gate.test.js src/lib/dashboard/business-kpis.test.js`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/LabourBlock.jsx src/components/dashboard/LabourBlock.test.jsx src/app/dashboard/business/page.js tests/labour-owner-gate.test.js
git commit -m "LABOUR.1 — Business dashboard: owners see labour against revenue

Async server block; rendered only when the viewer is an owner at the
active studio (or a master). Never on the phone route.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine). Rebase and re-run the focused suites:

```bash
git fetch origin main && git rebase origin/main
npx vitest run src/lib/profile-compensation.test.js src/lib/labour-month-model.test.js src/lib/labour-month-data.test.js src/components/dashboard/LabourPanel.test.jsx src/components/dashboard/LabourBlock.test.jsx tests/labour-owner-gate.test.js tests/staff-tombstone-readers.test.js tests/shared-pair-sync.test.js
TZ=America/Los_Angeles npx vitest run src/lib/labour-month-model.test.js src/lib/labour-month-data.test.js
```

Expected: all green.

- [ ] **The 12-command CI mirror (CLAUDE.md "Build, test & ship"):**

```bash
set -o pipefail
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0 and vitest reports `0 failed`.
- `check:mobile-parity`: no permission key added (D9).
- `check:route-guards`: no route added.
- `check:location-scoping`: `page.js` gains no query of its own; the reads live in `src/lib/labour-month-data.js`, organisation-scoped by `in('location_id', orgStudioIds)` and by id.
- `check:select-columns`: every literal column resolves (Task 4 Step 5). `getCompensationForProfiles`'s select is a template string and is skipped, as it was before.
- `check:guardrails`: no `new Date(\`…Z\`)` and no UTC-today form (dates come from `dublinDayStr`/`dublinDayRangeMs`); no discarded `.single()` error; no write.
- `check:ota-paths`: nothing under `mobile/` or `shared/`.

- [ ] **The build:**

```bash
npm run build
```

Expected: `✓ Compiled successfully`. This is the only check that proves the page's new import graph resolves (`@shared/working-time`, `@shared/studio-kpis` into a server page) and that no server-only module leaked into a client bundle.

- [ ] **Independent review** (standing rule). Point the reviewer at: D1 (MRR, not paid invoices, and why current-month only); D3/D4 (salary at 1/12 split by published hours; unrostered salaries switch); D6 (contractor admin shifts priced, the deliberate difference from contractor spend); D7 (published only; ended = effective end ≤ now); D9 (role gate, no permission key); D10 (server-rendered, no route, profiles by named columns, pay from `profile_compensation`); D12 (error cell vs per-studio MRR degrade); the Task 1 behaviour change to an unused helper.

- [ ] **Browser checks** (memory `jsdom-cannot-see-layout`). On the Vercel preview (it reads prod; this block only reads), `/dashboard/business`:
  1. As an owner (Richard) with Stillorgan active: the block shows Stillorgan and, if he owns Hatch, Hatch Street plus "All studios shown"; Hatch reads "Not tracked here" with no percentage. Record the forecast %, the so-far % and the hours in the PR, and sanity-check the hours against the Weekly hours notice for one week.
  2. "Master: View as" a manager holding `dashboard_business`: the rest of the page renders and the labour block does not.
  3. View source / the RSC payload in DevTools' Network tab: search for `annual_salary`, `hourly_rate` and one known rate. Expect no hit (only rendered euro totals).
  4. At 390px wide: the studio cards stack, no horizontal scroll.
  5. The "No pay on file" line: if it names anyone, confirm with Richard that they work unpaid or that their salary is missing (open question 6).

---

### PR

**Title:** `LABOUR.1 — owners see this month's labour against revenue, forecast vs actual, per studio (Business dashboard)`

**Body must say, in this order:**
1. **No migration. No OTA** (nothing under `mobile/` or `shared/`). No new route, no new permission key.
2. What an owner sees, where: a block on `/dashboard/business`, for the studios of the active organisation where they are an owner (masters: all), with a total when two or more.
3. The definitions: revenue = the Studio scorecard's MRR (`fetchMrr`, unchanged), pro-rated for "so far"; employees = salary/12 split by published hours, pro-rated; contractors = published hours × rate, admin shifts included; forecast = published roster for the whole month; actual = published shifts that have ended; drafts never costed (hours shown). Hatch Street has no revenue source, so it has no ratio.
4. Pay never reaches the browser: server-rendered block, no JSON route; `profiles` read by named columns; pay from `profile_compensation`; the view model carries totals, ratios, hours and names (test greps it for every rate). Owner-only by role at the studio, not by `dashboard_business` (a manager granted the Business page does not see it).
5. `getCompensationForProfiles` now throws on a failed read (it had no callers; it used to return an empty Map, i.e. "nobody is paid").
6. Measured on prod (counts only): 4 of 8 active employees have no salary on file (none rostered since 1 Aug); 0 overtime rates; 0 drift between the pay copies.
7. Browser-check results (the five above).
8. Open questions for Richard (below) and follow-ups found.
9. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit another row (`merge=union`).

```
| #<PR> | LABOUR.1 — owners see this month's labour against revenue, forecast vs actual, per studio | 2026-09-2x. Wave 3 PR 35. **No migration, no OTA, no route, no permission key.** New owner-only block on `/dashboard/business` (async server component `LabourBlock` → `LabourPanel`, rendered only when `canSeeLabour(user)`: owner AT the active studio by `hasRoleAtLocation`, masters too; a manager granted `dashboard_business` does not see it). Pure `src/lib/labour-month-model.js`: Dublin month window (real ms, DST-exact); revenue = the Studio scorecard's MRR (`fetchMrr`, unchanged), "so far" = MRR × elapsed; employees = `annual_salary/12` split between studios by published hours (unrostered salaries split equally across memberships, `COUNT_UNROSTERED_SALARIES` owner switch), "so far" pro-rated; contractors = published hours × `hourly_rate`, **admin shifts included** (unlike contractor spend's budget gate); forecast = published roster for the month, actual = published shifts ended; drafts shown in hours, never costed; cancelled ignored; hours via `workingWindow` (24:00 = midnight, so no dependence on payroll's 24:00 = 0h bug); ratios only over studios with tracked revenue (Hatch: none); anyone who worked without pay on file is named. `src/lib/labour-month-data.js`: organisation-scoped reads (siblingLocationIds), roster paged, `profiles` by named columns, pay from `profile_compensation`; never throws, a failed read is the error cell, MRR degrades per studio. `getCompensationForProfiles` now throws on a failed read (was a silent empty Map; no callers before this). Tests under Dublin + LA; view model grepped for every rate; `tests/labour-owner-gate.test.js` pins the single gated render and keeps it off the phone route. |
```

---

### Open questions for the owner (Richard)

1. **Revenue: recurring (MRR) or paid?** This PR uses the Studio scorecard's MRR (default 8), which leaves out class packs, drop-ins and one-off charges and exists only for "now", so the block is current-month only. The alternative is paid Glofox invoices (the Business card "Revenue MTD"): real cash, includes packs, available for past months, but gross of VAT, blind to refunds, and near zero early in a month. Switching is one reader in `labour-month-data.js`, and it would add a month picker.
2. **Employees at salary, not rostered hours.** An employee costs a twelfth of their salary each month whatever the roster says. Is overtime ever paid? No overtime rate is on file for anyone, so none is modelled.
3. **Salaried people who are never rostered** (today one salaried master-role profile with no shifts since August) are counted, split equally across their studios. Should directors and managers who do not coach be in "labour", or only people on the roster? It is a one-line switch (`COUNT_UNROSTERED_SALARIES`).
4. **Contractors from the roster, not invoices.** Their cost is published hours × rate, including admin shifts. Invoices cannot be split by studio (one per contractor per month, filed against one studio) and do not exist until the month ends. Would a closed-month "roster said €X, invoices say €Y" check be useful later?
5. **Employer costs.** PRSI and pension are not added, so employee labour is understated by roughly the employer rate. Add a multiplier (a studio setting)?
6. **Four employees have no salary on file** (1 owner, 3 staff; none rostered since 1 Aug). They are only named on the block if they work. Is that right, or is pay missing?
7. **Hatch Street has no revenue source** in the CRM (not on Glofox; the un1t.online platform is not built), so it shows labour but no ratio, and the total's ratio is Stillorgan's. Is there a Hatch revenue figure you would want wired in when it exists?
8. **Where it lives.** On the Business dashboard, for owners only. The alternative is a column on the Studio scorecard, but managers and head coaches see that page. Happy with the Business page?
9. **The existing "labour this week" figure** on the Business dashboard's Today strip (and the phone's Business tab) uses a different rule (rostered hours × salary-derived hourly rate, drafts and cancelled shifts included) and is shown to anyone with `dashboard_business`. Retire it, or align it to this definition? (Follow-up below.)

### Follow-ups found while planning (not in this PR)

- 🔴 **"Labour this week" counts cancelled shifts.** `fetchTodayOps` (`shared/dashboard-data.js:659-724`) sums every row `fetchDashboardShifts` returns (95-134), which never filters `status`, so a dropped or swapped-away shift is still costed and its hours counted; drafts are included too. It is on the web Business dashboard and the phone's Business tab, to anyone holding `dashboard_business`. Fix: filter `isLiveRow` in the loop at 708-712 (a `shared/` change, so an OTA), or retire the figure in favour of LABOUR.1 (open question 9).
- **Contractor spend drops worked shifts.** `summarizeMonth` skips staff who are not active (`src/lib/roster-summary.js:336`), and `computeMonthlyContractorSpend` prices only people linked to THIS studio (`src/lib/roster-summary-server.js:86-102`). So a contractor deactivated mid-month, or one from the sibling studio covering a class, vanishes from the month's spend and from the over-budget confirmation. Also `summarizeMonth` parses `referenceDate` with `new Date('YYYY-MM-DD')` (UTC midnight; line 322), which reads the previous month on a host west of UTC (latent: Vercel runs UTC).
- **The contractor-invoice review's "scheduled hours" counts cancelled shifts.** `computeScheduledForPeriod` (`src/lib/contractor-invoices.js:97-159`) reads `shift_assignments` with no `status` filter (115-131), so an invoice is compared against hours the contractor never worked.
- **Revenue MTD's month starts at UTC midnight.** `fetchRevenueMTD` uses `startOfMonth(now)` in the server's zone (`shared/dashboard-data.js:532-541`); on Vercel an invoice paid 00:00-01:00 Dublin on the 1st, in summer, lands in the previous month.
- **One contractor invoice per month across both studios.** `contractor_invoices_one_active_per_period` is `(contractor_id, period_start)` with no location (`supabase/migrations/101_contractor_invoices.sql:66`), so a contractor working at both studios can only invoice one of them for a month. Product question for Richard.
- (Known, from SNAPSHOT.1) `payroll.timeToHours` refuses `'24:00'` (`src/lib/payroll.js:32`), so every reader built on `shiftHours` counts a shift ending at midnight as 0 hours. **LABOUR.1 does not depend on it** (it measures with `workingWindow`, D8), so LABOUR.1 and contractor spend will disagree by that shift's hours until it is fixed.

---

### Self-review (done while writing)

- **Spec coverage.** Owner-only: D9, Task 2 (`labourStudiosFor`/`canSeeLabour`), Task 6 (page gate + guard test). Labour against revenue: Tasks 3-4 (MRR per studio, ratios). Forecast vs actual: D7, Task 3 (published whole month vs ended). Server-computed ratios, rates never reach the browser: D10, Task 3 leak test, Task 4 named-columns test, Task 6 (server component, no route, not a client component). Revenue source named before code: D1 + "What was found". Cost basis for employees and contractors, with reasons, flagged for the owner: D3-D6, open questions 2-5. Both studios vs per studio: D11, Task 3 total tests. `WEB_PERMISSIONS`/`WEB_ONLY_OK`: decided against a key (D9), so `check:mobile-parity` is untouched. Payroll's `'24:00'` bug: D8, Task 3 Hatch row (22:00-24:00 = 2h). Gate, PR, CHANGELOG, open questions, follow-ups: above.
- **Placeholders:** none; every code step carries its code. `<PR>` and the `x` in the CHANGELOG date are filled at PR time.
- **Names:** `labourMonthWindow` (camelCase period fields: `startDate`, `endDate`, `elapsedFraction`, `monthLabel`, `dayOfMonth`, `daysInMonth`), `labourStudiosFor`, `canSeeLabour`, `labourShiftRows`, `labourPct`, `buildLabourMonth({ period, nowMs, studios, rows, people, memberships, revenue, countUnrostered })`, `loadLabourMonth(db, { activeLocationId, studios, nowMs })`, `LabourPanel({ vm })`, `LabourBlock({ activeLocationId, studios, nowMs })`. The view model's keys are snake_case throughout (`month_label`, `day_of_month`, `revenue_status`, `forecast.cost_cents`, `ratio_excludes`, `untimed_shifts`) and are used the same way in the model tests, the panel and its test.
- **Arithmetic re-checked:** Stillorgan 325,000 + 9,000 = 334,000 on 1,000,000 → 33.4; 162,500 + 6,000 = 168,500 on 500,000 → 33.7. Hatch 175,000 + 5,426 = 180,426; 87,500 + 5,426 = 92,926. Total 514,426 / 261,426; hours 7 + 3 = 10, 6 + 2 = 8. Data test: 300,000 + 6,000 = 306,000 → 30.6; 150,000 + 6,000 = 156,000 on 500,000 → 31.2; hours 3 + 2 = 5 (both ended by 16 Sep).
