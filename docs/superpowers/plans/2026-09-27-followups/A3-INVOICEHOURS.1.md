## PR INVOICEHOURS.1: the contractor invoice review counts only live shifts on published rosters as "scheduled hours"

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The contractor invoice review ("Schedule vs invoice" on `/schedule/invoices`, the phone's invoice detail and its Approvals card, and the snapshot saved at approval) prices a contractor's month from **live assignments on published rosters** at the invoice's studio. It never prices a cancelled assignment or a shift on a roster that was never published. Hours on unpublished shifts are reported beside the estimate, not inside it. A failed roster read shows "could not read the roster", never a figure, and approval waits until the read works.

**Why:** 00-INDEX row A3 (Batch A: money and hours). `computeScheduledForPeriod` (`src/lib/contractor-invoices.js:97-159`) reads `shift_assignments` with no `status` filter and no roster filter (lines 114-131). A cancelled assignment or a shift on a draft roster is therefore counted as scheduled, and a correct invoice reads "under roster". LABOUR.1 (#1772) settled the rule for money read off the roster: live (`isLiveAssignment`) and published (`rosters.status === 'published'`). This PR applies that rule here.

**Architecture:** One new pure function in `src/lib/contractor-invoices.js`, `scheduledFromAssignments(rows)`, holds the whole rule: live, published, hours via payroll's `shiftHours`, and unpublished hours tallied apart. `computeScheduledForPeriod` keeps its signature and its scope (one contractor, the invoice's studio, the invoice's period). It gains the roster status in its select, pages through `selectAll`, and hands the rows to the pure function. Its result gains two additive fields. The two routes that call it stop treating a failed read quietly:
- the detail route flags `roster_unavailable`;
- the approve route answers 503 and leaves the invoice `submitted`.

The web review panel gains one small presentational component that states those two facts. No `shared/` or `mobile/` change.

**Tech Stack:** Next.js 16 App Router route handlers, Supabase PostgREST via the service-role client, Vitest (node for lib/route tests; jsdom + `@testing-library/react` for the component test, as `src/components/InvoicesManager.test.jsx` does).

**Size / ships:** S. **No migration. No OTA**: nothing under `mobile/` or `shared/` changes. The phone reads the same `GET /api/invoices/[id]`, so its figures correct themselves on deploy. **No new route, no new permission key**, so `check:route-guards`, `check:mobile-parity` and `src/lib/openapi.js` are untouched.

**Depends on:** **A1 PAYROLL24.1 merged** (Wave 1). This PR prices hours with `shiftHours`, which counts a shift ending `'24:00'` as 0 h until A1 lands (`src/lib/payroll.js:32`, `h > 23` → null). Task 0 checks it. **Pairs with A2 CONTRACTORSPEND.1** (Wave 2). The two PRs share no file except `docs/CHANGELOG.md`; see "Overlap with A2".

---

### What was found (verified against `origin/main` at `28d02e59`, #1779)

**The function and its rule today.**
- `computeScheduledForPeriod(db, { contractor_id, location_id, period_start, period_end })` (`src/lib/contractor-invoices.js:97-159`):
  - reads `profiles.hourly_rate, employment_type` by id with `.single()`, and throws on error (101-106);
  - reads `shift_assignments` with an inner `shift_blocks` embed, filtered by `profile_id`, `shift_blocks.location_id`, and `block_date` between the period's strings (114-131). The select has **no `status`, no roster, no paging**. It throws on error (132);
  - sums `shiftHours` over every row (135-147) and counts every row as a shift (155);
  - returns `{ scheduled_hours, shift_count, hourly_rate, estimated_cost }`, where `estimated_cost` is `null` without a positive rate (149-158).
- Hours come from `shiftHours` (`src/lib/payroll.js:44-61`): override, then the block's own time, then the template (`effectiveShiftStart/End`), wall-clock arithmetic, overnight wraps +24. `timeToHours` refuses hour 24 (line 32), so `'24:00'` → 0 h today (A1 fixes it).
- `shift_blocks.start_time`/`end_time` are `NOT NULL` (`supabase/migrations/067_roster_v2_shift_blocks.sql:70-71`), so an untimed row cannot occur.
- The header comment (`contractor-invoices.js:10-14`) says the hours "match what payroll.js does downstream"; this PR keeps that promise (D5).

**Who consumes the result (every reader, checked with `git grep` for `computeScheduledForPeriod`, `scheduled_hours`, `computed_scheduled`, `_at_review`).**
1. `GET /api/invoices/[id]` (`src/app/api/invoices/[id]/route.js`), for reviewers only (master, or owner at the invoice's studio; lines 42-62):
   - computes live figures (63-78). A throw is caught and logged with `logWarn`, and `computed` stays `null` (72-77);
   - feeds `selectReviewComparison(inv, computed)` (83);
   - returns `computed_scheduled` and `review_comparison` (104-105).
   - The contractor's own view never gets figures, and the `*_at_review` snapshot is stripped (91-98).
2. `POST /api/invoices/[id]/approve` (`src/app/api/invoices/[id]/approve/route.js`) snapshots the result into `scheduled_hours_at_review`, `estimated_cost_at_review` and `hourly_rate_at_review` (62-84). The call at 63-68 is **not wrapped**: a failed read throws out of the handler, Next answers a bare 500, and the web's `approve()` fails on `res.json()` (`src/components/InvoicesManager.jsx:444-461`), showing a JSON parse error.
3. `selectReviewComparison` (`shared/contractor-invoice-review.js:125-155`): before approval the live figures are primary; after approval the snapshot is primary and the live figures show as "Current roster (changed since approval)" only when they differ (145-150). It reads only `scheduled_hours`, `hourly_rate`, `estimated_cost` and `shift_count`, so the new fields pass through it untouched. `rosterComparison` (57-77) is the verdict: a gap under €1 or 1% matches, and more than 5% is significant.
4. Web: `InvoicesManager.jsx`
   - renders `ReviewComparison` only when `reviewerMode && data.review_comparison` (568-573);
   - `FiguresRows` shows "Scheduled hours (N shifts)", "Hourly rate" and "Estimated cost" (778-799).
   - When `review_comparison` is `null` (a failed read on a submitted invoice) **the block silently disappears**: nothing says why, and Approve is still offered.
5. Phone:
   - `mobile/lib/invoice-review.js` `reviewComparisonView` (99-117) → `mobile/components/invoices/RosterComparison.jsx` (invoice detail);
   - `InvoiceRosterCheck` (57-90) on the Approvals card fetches the same route; with no comparison it prints "No roster comparison available." (87). It reads the same payload, so no phone change is needed for the corrected figures.
6. **Not consumers:**
   - the contractor-invoices approvals provider (`src/lib/approvals/providers/contractor-invoices.js`) lists invoices and amounts only;
   - `invoices_queue`, `src/lib/xero/contractor-bills.js`, `src/lib/invoices-queue/enqueue.js` and `src/lib/contractor-invoice-email.js` never read hours.

**The roster facts the rule rests on.**
- `isLiveAssignment(a)` = `a?.status !== 'cancelled'` (`src/lib/roster.js:440-442`). A missing status is a legacy live row; `swapped` is live.
- `cancelled` is still allowed by the table's CHECK (`src/lib/schemas.js:249-251`, mig 337), but ROSTER-FIX.1 stopped writing it (the roster DELETEs an assignment), mig 603 deleted every tombstone (`supabase/migrations/603_rostering_indexes_fks_tombstones.sql:214`), and the assignment route's schema refuses it (`src/lib/schemas.js:260`). So today the "counts cancelled" half is **latent**: only a hand edit or an old code path could create one.
- A swap moves the row: mig 612/615's approve functions set `profile_id` to the taker and `status = 'swapped'` (`src/lib/swap-lifecycle.js:212-223`). Filtering by `profile_id` therefore gives the taker the hours and the giver none.
- Published = `block.rosters.status === 'published'`, via `rosters:roster_id ( status )`, the test used by LABOUR.1 (`src/lib/labour-month-model.js:102`), `src/lib/roster-read.js:137` and `shared/dashboard-data.js`. `rosters.status` is `draft | published | superseded` (`supabase/migrations/602_rosters_no_overlap.sql:194`). A block with no `roster_id` belongs to no published roster.
- `selectAll` (`src/lib/select-all.js`) pages at 1,000 with a stable `.order()` and throws on a page error.

**Scope facts.**
- One invoice per contractor per month **across all studios**: `contractor_invoices_one_active_per_period ON (contractor_id, period_start)`, created in `supabase/migrations/101_contractor_invoices.sql:65-67` and redefined in `102_contractor_invoice_revoke.sql:20-23` as `WHERE status NOT IN ('declined', 'revoked')`; no later migration touches it. There is no `location_id` in the key. The invoice is filed against one `location_id`, and approval enqueues it for that studio's Xero organisation (CLAUDE.md: one location = one Xero organisation).
- 00-INDEX "Held" already lists that per-month rule as Richard's product call.

**Measured on prod, 27 Sep (read-only aggregates, counts only):**
- **Invoices:** 10 (periods April-September), 6 not declined or revoked.
- **Inside invoice periods at the invoice's studio:** 181 assignments. **0 cancelled**, 1 swapped, 2 on blocks with no roster (both in one **revoked** May invoice).
- **Every contractor assignment since 1 April:** 299 rows. **0 cancelled**; 8 live on unpublished blocks, **none before September**. 0 ending `24:00`, 0 on admin templates, **0 contractor-months at two studios**.
- **Roster coverage:** every block from June to September sits on a published roster. May had 56 blocks with no roster (6 assignments). October has 131 unrostered blocks (35 assignments) waiting to be published.
- **So this PR changes no figure on any live invoice today.** It closes a latent defect: the next draft week, or the next cancelled row, would have priced unworked hours. Approved snapshots are unaffected, and no "current roster changed" line appears from this change.

---

### Decisions (made here, each pinned by a test)

**D1. Scheduled = published only.** A shift counts only when its block belongs to a roster whose status is `published`. A block with no roster, or one on a `draft` or `superseded` roster, is not scheduled: nobody was told to work it. Its hours are reported separately as `unpublished_hours` / `unpublished_shift_count`, and the web review says "Not counted: X h on N shifts in rosters that were not published". A manager who forgot to publish then sees why a correct invoice reads "over roster". *Pinned:* `scheduledFromAssignments` "no roster, draft and superseded are not scheduled", `computeScheduledForPeriod` "published-only figures and the unpublished tally", `RosterCheckNotes` "unpublished line".

**D2. Cancelled rows are out, everywhere.** A cancelled assignment is neither scheduled nor unpublished, and it is dropped before either tally. The rule is `isLiveAssignment`, never a copy of it. It is latent today (0 rows, D-facts above), and the test guards the next one. *Pinned:* "a cancelled assignment counts nowhere".

**D3. A swapped shift is the taker's.** Swap approval rewrites `profile_id` to the taker and sets `status = 'swapped'`, so the contractor-scoped read already returns the taker's row and never the giver's. `swapped` is live. A legacy row with no status is live. *Pinned:* "a swapped shift counts for the contractor who holds it", "a legacy row with no status counts".

**D4. Admin shifts count.** A contractor invoices a front-desk admin shift, so the review prices it. The read has no `kind` filter and adds none. This agrees with LABOUR.1 D6 and deliberately differs from contractor spend's budget gate, which prices admin at €0 (SHIFTTYPE.1). *Pinned:* "an admin shift counts".

**D5. Hours are payroll's `shiftHours`, after A1.** The review keeps its stated promise to match payroll and the staff_cost report (`contractor-invoices.js:10-14`):
- override, then the block's own time, then the template;
- wall-clock hours;
- `'24:00'` is midnight once A1 lands (22:00-24:00 = 2 h).

It deliberately does **not** switch to `workingWindow` (LABOUR.1's real-elapsed-time measure). That would make the review disagree with payroll and the snapshot history. The only case where the two differ is a shift crossing the 01:00-02:00 clock change (00:30-03:30 on 25 Oct 2026 is 3 h here, 4 h in LABOUR.1). No contractor has ever been rostered in those hours; open question 3. The arithmetic is on `HH:MM` strings only, so the host timezone cannot move a figure. *Pinned:* "22:00-24:00 is 2 h", "the October clock change" (run under `Europe/Dublin` and `America/Los_Angeles`).

**D6. The invoice's own studio only (unchanged).** The estimate covers shifts at `inv.location_id`. The approval files the bill into that studio's Xero organisation (one location = one Xero organisation), so pricing a sibling studio's shifts into it would have the review endorse charging one company for another's work. The one-invoice-a-month-across-studios rule is the held product item in 00-INDEX, and it is Richard's call (open question 1). Measured: 0 contractor-months at two studios. *Pinned:* `computeScheduledForPeriod` "reads the invoice's studio and period, by string" (the `shift_blocks.location_id` filter is exactly the invoice's).

**D7. The period is the invoice's own date strings, inclusive.** `period_start`/`period_end` come off the row (Postgres `date` → `YYYY-MM-DD`) and go straight into `gte`/`lte` on `block_date`. The code does no `Date` parsing, so a DST month and a US host behave identically. *Pinned:* the same test, run in a loop under both zones for October 2026 (clocks go back 25 Oct).

**D8. Paged.** The assignment read goes through `selectAll` (`order('id')`, 1,000 per page). A contractor-month is ~40 rows today, but the 1,000-row cap truncates silently (CLAUDE.md), and a truncated read would be an under-count dressed as a real figure. *Pinned:* "pages past 1,000 rows".

**D9. A failed read is never a figure.**
- `computeScheduledForPeriod` throws on a failed profile or assignment read (as today, and now through paging too). It never returns 0.
- **Detail route:** keeps answering 200 (an approved invoice still has its snapshot to show) and adds `roster_unavailable: true` for a reviewer.
- **Web panel:** says "Could not read the roster for this period, so there is no schedule comparison. Refresh before approving." whenever that flag is set and no comparison could be shown.
- **Approve route:** logs with `logError` and answers **503** `{ success: false, error: 'Could not read the roster …' }`. It writes nothing, so the invoice stays `submitted`.

Failing closed is right for the approval (CLAUDE.md order: log → retry → fail closed only when proceeding does harm):
- approving without a snapshot saves `null`s, which later read as "Approved before snapshots were saved", a false statement in the audit record;
- the reviewer may be approving without having seen any comparison;
- nothing is lost, and the retry is one click.

*Pinned:* lib "the assignment read fails → throws", route "reviewer told the roster could not be read", approve "503 and nothing written", `RosterCheckNotes` "unavailable".

**D10. Snapshots are history; no back-fill.** `*_at_review` values already saved stay as saved. Measured: no approved invoice's period holds a cancelled or unpublished row, so no stored snapshot is wrong and no drift line appears. *Pinned:* no code writes to past rows (nothing to test beyond the approve test's single `update`).

**D11. Web and API only. No `shared/`, no `mobile/`, so no OTA.**
- The phone shows the corrected figures from the same route on deploy.
- Its Approvals card already says "No roster comparison available." when there is none.
- The phone invoice detail shows nothing on a failed read and does not show the unpublished line: follow-up, not this PR.
- `selectReviewComparison` is unchanged: the new result fields ride in `computed_scheduled`, which the web reads directly.

**D12. The rate source is unchanged.** It stays `profiles.hourly_rate`, the deprecated copy. LABOUR.1 measured 0 drift against `profile_compensation`. Moving to the canonical table is a separate follow-up, so this PR changes one thing.

---

### Files

| File | Responsibility |
|---|---|
| `src/lib/contractor-invoices.js` (modify: imports 16-18; header 10-14; docstring + body 73-159) | new pure `scheduledFromAssignments`; `computeScheduledForPeriod` reads status + roster, pages, delegates |
| `src/lib/contractor-invoices-scheduled.test.js` (create) | the rule (D1-D5) under two host timezones; the read (D6-D9) against a recording fake |
| `src/app/api/invoices/[id]/approve/route.js` (modify: import 25; lines 62-68) | 503 on a failed roster read, nothing written |
| `src/app/api/invoices/[id]/approve/route.test.js` (create) | 503 path + snapshot path |
| `src/app/api/invoices/[id]/route.js` (modify: 63-78, 100-110) | `roster_unavailable` for reviewers |
| `src/app/api/invoices/[id]/route.test.js` (modify: append a `describe`) | flag set on failure, false on success, never for self |
| `src/components/InvoicesManager.jsx` (modify: after 568-573; new exported `RosterCheckNotes` after `FiguresRows`, ~799) | the two notes |
| `src/components/InvoicesManager.roster-notes.test.jsx` (create) | what the notes say, and when |
| `docs/CHANGELOG.md` (modify) | one row, after `gh pr create` |

**Setup:** a fresh worktree off `origin/main` (standing rule; never a shared one):

```bash
cd ~/code/un1t-crm && git fetch origin main && git worktree add ../un1t-crm-invoicehours1 -b invoicehours-1 origin/main && cd ../un1t-crm-invoicehours1 && npm ci
```

---

### Task 0: Pre-flight

- [ ] **Step 1: A1 PAYROLL24.1 is on main.**

```bash
git fetch origin main && git show origin/main:src/lib/payroll.js | sed -n '/export function timeToHours/,/^}/p'
```

Expected: the function accepts exactly `24:00`/`24:00:00` (A1's change; hour 24 with non-zero minutes still refused). If it still reads `if (h > 23 || …) return null` with no 24 case, **stop**: A1 has not merged, and Task 1's "22:00-24:00 is 2 h" test cannot pass. Build A3 after A1.

- [ ] **Step 2: No name clash** (`tests/shared-pair-sync.test.js` fails on an export present in both `shared/` and `src/lib/`).

```bash
git grep -nE "export (const|function|async function) (scheduledFromAssignments|RosterCheckNotes)\b" -- shared src mobile/lib
```

Expected: no output.

- [ ] **Step 3: See whether A2 has merged** (it may add a shared "live and published" predicate).

```bash
git log origin/main --oneline -20 | grep -i CONTRACTORSPEND
```

If it has merged **and** exports a predicate for "live assignment on a published roster", use it inside `scheduledFromAssignments` in place of the two inline tests (keep `isLiveAssignment` as the live test either way). Otherwise build as written.

---

### Task 1: The rule, pure: `scheduledFromAssignments`

**Files:**
- Modify: `src/lib/contractor-invoices.js` (imports at 16-18; add the function above `computeScheduledForPeriod`, i.e. before line 73)
- Create: `src/lib/contractor-invoices-scheduled.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/contractor-invoices-scheduled.test.js`:

```js
// src/lib/contractor-invoices-scheduled.test.js
// INVOICEHOURS.1 — the contractor invoice review's "scheduled hours": live
// assignments on PUBLISHED rosters only (the LABOUR.1 rule), hours by payroll's
// shiftHours, unpublished hours tallied apart. Pure string arithmetic, so every
// case runs under Dublin and a US zone.

import { describe, it, expect, afterEach } from 'vitest'
import { scheduledFromAssignments } from './contractor-invoices'

const realTz = process.env.TZ
afterEach(() => { process.env.TZ = realTz })

// One shift_assignments row as the read returns it: the assignment's own
// fields plus its block, the block's roster status and its template times.
function row({
  status = 'scheduled', roster = 'published', date = '2026-10-12',
  start = '09:00:00', end = '17:00:00', so = null, eo = null,
  tpl = { start_time: '09:00:00', end_time: '17:00:00' },
} = {}) {
  return {
    id: `a-${Math.random().toString(36).slice(2, 8)}`,
    status,
    start_time_override: so,
    end_time_override: eo,
    shift_blocks: {
      block_date: date,
      start_time: start,
      end_time: end,
      location_id: 'locA',
      rosters: roster == null ? null : { status: roster },
      shift_templates: tpl,
    },
  }
}

for (const tz of ['Europe/Dublin', 'America/Los_Angeles']) {
  describe(`scheduledFromAssignments (TZ=${tz})`, () => {
    it('counts live assignments on a published roster, override first', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([
        row({ so: '09:00:00', eo: '13:00:00' }),                    // 4h (override)
        row({ start: '07:00:00', end: '08:30:00', tpl: null }),     // 1.5h (block's own time)
      ])
      expect(out).toEqual({
        scheduled_hours: 5.5, shift_count: 2,
        unpublished_hours: 0, unpublished_shift_count: 0,
      })
    })

    it('a cancelled assignment counts nowhere', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([
        row({ status: 'cancelled' }),
        row({ status: 'cancelled', roster: 'draft' }),
      ])
      expect(out).toEqual({
        scheduled_hours: 0, shift_count: 0,
        unpublished_hours: 0, unpublished_shift_count: 0,
      })
    })

    it('a swapped shift counts for the contractor who holds it', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([row({ status: 'swapped', start: '18:00:00', end: '19:00:00', tpl: null })])
      expect(out.scheduled_hours).toBe(1)
      expect(out.shift_count).toBe(1)
    })

    it('a legacy row with no status counts', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([row({ status: null })])
      expect(out.scheduled_hours).toBe(8)
    })

    it('no roster, draft and superseded are not scheduled; their hours are tallied apart', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([
        row({ roster: null, start: '09:00:00', end: '10:00:00', tpl: null }),
        row({ roster: 'draft', start: '10:00:00', end: '11:00:00', tpl: null }),
        row({ roster: 'superseded', start: '11:00:00', end: '12:30:00', tpl: null }),
        row({ start: '13:00:00', end: '15:00:00', tpl: null }),     // published, 2h
      ])
      expect(out).toEqual({
        scheduled_hours: 2, shift_count: 1,
        unpublished_hours: 3.5, unpublished_shift_count: 3,
      })
    })

    it('an admin shift counts (contractors invoice it)', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([row({
        start: '08:00:00', end: '12:00:00',
        tpl: { start_time: '08:00:00', end_time: '12:00:00', kind: 'admin' },
      })])
      expect(out.scheduled_hours).toBe(4)
    })

    it('22:00-24:00 is 2 h (needs A1 PAYROLL24.1)', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([row({ start: '22:00:00', end: '24:00:00', tpl: null })])
      expect(out.scheduled_hours).toBe(2)
    })

    it('the October clock change: a day shift is its wall-clock length, and so is a night one (D5)', () => {
      process.env.TZ = tz
      // Clocks go back 02:00 -> 01:00 on Sunday 25 Oct 2026.
      expect(scheduledFromAssignments([row({ date: '2026-10-25' })]).scheduled_hours).toBe(8)
      expect(scheduledFromAssignments([row({
        date: '2026-10-25', start: '00:30:00', end: '03:30:00', tpl: null,
      })]).scheduled_hours).toBe(3)
      // Last day of the month is an ordinary day to the rule.
      expect(scheduledFromAssignments([row({ date: '2026-10-31' })]).scheduled_hours).toBe(8)
    })

    it('skips a row whose block did not come back', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([{ id: 'x', status: 'scheduled', shift_blocks: null }, null])
      expect(out.shift_count).toBe(0)
    })
  })
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/contractor-invoices-scheduled.test.js`
Expected: FAIL. `scheduledFromAssignments` is not exported (`TypeError: … is not a function`).

- [ ] **Step 3: Implement**

In `src/lib/contractor-invoices.js`, replace the imports (lines 16-18):

```js
import { shiftHours } from './payroll.js'
import { logWarn } from './log.js'
import { latestQueueRowByInvoice } from '@shared/contractor-invoice-review'
```

with:

```js
import { shiftHours } from './payroll.js'
import { logWarn } from './log.js'
import { isLiveAssignment } from './roster.js'
import { selectAll } from './select-all.js'
import { latestQueueRowByInvoice } from '@shared/contractor-invoice-review'
```

Then insert immediately above the `computeScheduledForPeriod` docstring (before line 73):

```js
const round2 = (n) => +n.toFixed(2)

/**
 * INVOICEHOURS.1 — the scheduled-hours rule for a contractor invoice review,
 * pure. The LABOUR.1 rule for money read off the roster:
 *   - live only (isLiveAssignment): a cancelled row counts NOWHERE;
 *     'swapped' is live and already belongs to the taker (swap approval moves
 *     profile_id), so a contractor-scoped read gives the giver nothing;
 *   - published only (block.rosters.status === 'published'): a block with no
 *     roster, or on a draft / superseded one, was never rostered for real. Its
 *     hours are tallied apart as unpublished_* so the review can say so;
 *   - admin shifts count (a contractor invoices them; no kind filter);
 *   - hours by payroll's shiftHours (override → block → template, wall clock,
 *     '24:00' = midnight since PAYROLL24.1), so the review, the approval
 *     snapshot, payroll and the staff_cost report agree.
 *
 * @param {Array<{ status?: string|null, start_time_override?: string|null,
 *   end_time_override?: string|null, shift_blocks?: { start_time, end_time,
 *   rosters?: { status?: string }|null, shift_templates?: object|null }|null }>} rows
 * @returns {{ scheduled_hours: number, shift_count: number,
 *   unpublished_hours: number, unpublished_shift_count: number }}
 */
export function scheduledFromAssignments(rows) {
  let hours = 0
  let shifts = 0
  let unpublishedHours = 0
  let unpublishedShifts = 0
  for (const row of rows || []) {
    const block = row?.shift_blocks
    if (!block || !isLiveAssignment(row)) continue
    const tpl = block.shift_templates || {}
    const h = shiftHours({
      start_time_override: row.start_time_override,
      end_time_override: row.end_time_override,
      start_time: block.start_time,
      end_time: block.end_time,
      shift_templates: { start_time: tpl.start_time, end_time: tpl.end_time },
    })
    if (block.rosters?.status === 'published') {
      hours += h
      shifts += 1
    } else {
      unpublishedHours += h
      unpublishedShifts += 1
    }
  }
  return {
    scheduled_hours: round2(hours),
    shift_count: shifts,
    unpublished_hours: round2(unpublishedHours),
    unpublished_shift_count: unpublishedShifts,
  }
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/lib/contractor-invoices-scheduled.test.js src/lib/contractor-invoices.test.js`
Expected: PASS (all cases, both zones; the existing file unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/contractor-invoices.js src/lib/contractor-invoices-scheduled.test.js
git commit -m "INVOICEHOURS.1 — scheduledFromAssignments: live assignments on published rosters, unpublished tallied apart

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The read: `computeScheduledForPeriod` reads status and roster, pages, delegates

**Files:**
- Modify: `src/lib/contractor-invoices.js:73-159` (header comment 10-14 too)
- Modify: `src/lib/contractor-invoices-scheduled.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/contractor-invoices-scheduled.test.js`, and add `computeScheduledForPeriod` to its import line so it reads `import { scheduledFromAssignments, computeScheduledForPeriod } from './contractor-invoices'`:

```js
// A recording fake of the two reads. profiles: .select().eq().single();
// shift_assignments: .select().eq().eq().gte().lte().order().range() awaited
// (selectAll), one page per await.
function fakeDb({
  profile = { hourly_rate: 20, employment_type: 'contractor' },
  profileError = null, pages = [[]], rowsError = null,
} = {}) {
  const calls = []
  let page = 0
  return {
    calls,
    from(table) {
      const q = { table, filters: [], select: null, order: null, range: null }
      calls.push(q)
      const b = {
        select(cols) { q.select = cols; return b },
        eq(col, val) { q.filters.push(['eq', col, val]); return b },
        gte(col, val) { q.filters.push(['gte', col, val]); return b },
        lte(col, val) { q.filters.push(['lte', col, val]); return b },
        order(col, opts) { q.order = [col, opts]; return b },
        range(from, to) { q.range = [from, to]; return b },
        single() {
          return Promise.resolve(profileError
            ? { data: null, error: profileError }
            : { data: profile, error: null })
        },
        then(res, rej) {
          const out = rowsError
            ? { data: null, error: rowsError }
            : { data: pages[page++] || [], error: null }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    },
  }
}

const ARGS = { contractor_id: 'c1', location_id: 'locA', period_start: '2026-10-01', period_end: '2026-10-31' }

for (const tz of ['Europe/Dublin', 'America/Los_Angeles']) {
  describe(`computeScheduledForPeriod (TZ=${tz})`, () => {
    it("reads the invoice's studio and period, by string, with status and roster", async () => {
      process.env.TZ = tz
      const db = fakeDb()
      await computeScheduledForPeriod(db, ARGS)
      const q = db.calls.find((c) => c.table === 'shift_assignments')
      expect(q.filters).toEqual([
        ['eq', 'profile_id', 'c1'],
        ['eq', 'shift_blocks.location_id', 'locA'],
        ['gte', 'shift_blocks.block_date', '2026-10-01'],
        ['lte', 'shift_blocks.block_date', '2026-10-31'],
      ])
      expect(q.select).toMatch(/\bstatus\b/)
      expect(q.select).toMatch(/rosters:roster_id \( status \)/)
      expect(q.order).toEqual(['id', { ascending: true }])
      expect(q.range).toEqual([0, 999])
    })
  })
}

describe('computeScheduledForPeriod', () => {
  it('published-only figures and the unpublished tally reach the result', async () => {
    const db = fakeDb({ pages: [[
      row(),                                                          // 8h published
      row({ roster: 'draft', start: '10:00:00', end: '12:00:00', tpl: null }), // 2h draft
      row({ status: 'cancelled' }),                                   // nowhere
    ]] })
    await expect(computeScheduledForPeriod(db, ARGS)).resolves.toEqual({
      scheduled_hours: 8, shift_count: 1,
      hourly_rate: 20, estimated_cost: 160,
      unpublished_hours: 2, unpublished_shift_count: 1,
    })
  })

  it('pages past 1,000 rows (a truncated read would be an under-count)', async () => {
    const oneHour = () => row({ start: '09:00:00', end: '10:00:00', tpl: null })
    const db = fakeDb({ pages: [Array.from({ length: 1000 }, oneHour), Array.from({ length: 5 }, oneHour)] })
    const out = await computeScheduledForPeriod(db, ARGS)
    expect(out.shift_count).toBe(1005)
    expect(out.scheduled_hours).toBe(1005)
    expect(out.estimated_cost).toBe(20100)
    const ranges = db.calls.filter((c) => c.table === 'shift_assignments').map((c) => c.range)
    expect(ranges).toEqual([[0, 999], [1000, 1999]])
  })

  it('the assignment read fails → throws, never 0', async () => {
    const db = fakeDb({ rowsError: { message: 'boom' } })
    await expect(computeScheduledForPeriod(db, ARGS)).rejects.toThrow(/Assignment lookup failed: boom/)
  })

  it('the profile read fails → throws', async () => {
    const db = fakeDb({ profileError: { message: 'nope' } })
    await expect(computeScheduledForPeriod(db, ARGS)).rejects.toThrow(/Profile lookup failed: nope/)
  })

  it('no hourly rate → hours, but no estimated cost', async () => {
    const db = fakeDb({ profile: { hourly_rate: null, employment_type: 'contractor' }, pages: [[row()]] })
    await expect(computeScheduledForPeriod(db, ARGS)).resolves.toMatchObject({
      scheduled_hours: 8, shift_count: 1, hourly_rate: null, estimated_cost: null,
    })
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/contractor-invoices-scheduled.test.js`
Expected: FAIL. The filter test fails on `select` (no `status`, no `rosters`) and on `order`/`range` (`null`). "published-only" fails: the draft and cancelled rows are counted (`scheduled_hours: 18`, `shift_count: 3`, no `unpublished_*`). "pages" fails with `shift_count: 1000`.

- [ ] **Step 3: Implement**

In `src/lib/contractor-invoices.js`, replace the header paragraph (lines 10-14):

```js
// Hours computation is OVERRIDE-AWARE: assignment.start_time_override
// and end_time_override (mig 099/100) take precedence over the
// parent block's times. So a contractor adjusted to 9-1 on a 9-5
// block contributes 4 hours, not 8 — matches what payroll.js does
// downstream.
```

with:

```js
// Hours computation is OVERRIDE-AWARE: assignment.start_time_override
// and end_time_override (mig 099/100) take precedence over the
// parent block's times. So a contractor adjusted to 9-1 on a 9-5
// block contributes 4 hours, not 8 — matches what payroll.js does
// downstream.
//
// INVOICEHOURS.1 — "scheduled" means a LIVE assignment on a PUBLISHED
// roster (scheduledFromAssignments): cancelled rows and shifts on rosters
// nobody published are never priced; the latter are reported apart.
```

Then replace the whole `computeScheduledForPeriod` docstring and function (lines 73-159) with:

```js
/**
 * Compute the contractor's scheduled hours + estimated cost for a
 * given period. Reads every shift_assignment where:
 *   - profile_id = contractor (a swapped shift is the taker's: swap
 *     approval moves profile_id)
 *   - parent block.location_id = the INVOICE's studio (INVOICEHOURS.1 D6:
 *     the bill is filed into that studio's Xero organisation)
 *   - parent block.block_date in [period_start, period_end] (date strings,
 *     inclusive; no Date parsing, so no host-timezone effect)
 * paged past the 1,000-row cap, then applies scheduledFromAssignments
 * (live + published only; unpublished hours tallied apart).
 *
 * Throws on a failed read. Callers must never show a figure for a read
 * that failed (INVOICEHOURS.1 D9).
 *
 * @param {SupabaseClient} db   service-role client
 * @param {object} args
 * @param {string} args.contractor_id
 * @param {string} args.location_id
 * @param {string} args.period_start  YYYY-MM-DD
 * @param {string} args.period_end    YYYY-MM-DD
 * @returns {Promise<{
 *   scheduled_hours: number,
 *   shift_count: number,
 *   hourly_rate: number | null,
 *   estimated_cost: number | null,
 *   unpublished_hours: number,
 *   unpublished_shift_count: number,
 * }>}
 */
export async function computeScheduledForPeriod(db, args) {
  const { contractor_id, location_id, period_start, period_end } = args

  // Pull the contractor's profile for the rate calc.
  const { data: profile, error: profileErr } = await db
    .from('profiles')
    .select('hourly_rate, employment_type')
    .eq('id', contractor_id)
    .single()
  if (profileErr) throw new Error(`Profile lookup failed: ${profileErr.message}`)

  // Status (live test) and the block's roster status (published test) ride
  // along with the override + block + template times shiftHours() needs.
  let rows
  try {
    rows = await selectAll((from, to) => db
      .from('shift_assignments')
      .select('id, status, start_time_override, end_time_override, shift_blocks!inner ( block_date, start_time, end_time, location_id, rosters:roster_id ( status ), shift_templates ( start_time, end_time ) )')
      .eq('profile_id', contractor_id)
      .eq('shift_blocks.location_id', location_id)
      .gte('shift_blocks.block_date', period_start)
      .lte('shift_blocks.block_date', period_end)
      .order('id', { ascending: true })
      .range(from, to))
  } catch (e) {
    throw new Error(`Assignment lookup failed: ${e?.message || String(e)}`)
  }

  const scheduled = scheduledFromAssignments(rows)

  const hourlyRate = Number(profile?.hourly_rate)
  const validRate = Number.isFinite(hourlyRate) && hourlyRate > 0
  const estimated = validRate ? round2(scheduled.scheduled_hours * hourlyRate) : null

  return {
    scheduled_hours: scheduled.scheduled_hours,
    shift_count: scheduled.shift_count,
    hourly_rate: validRate ? hourlyRate : null,
    estimated_cost: estimated,
    unpublished_hours: scheduled.unpublished_hours,
    unpublished_shift_count: scheduled.unpublished_shift_count,
  }
}
```

Note: `estimated_cost` now multiplies the already-rounded hours (2 dp). The old code multiplied the unrounded sum, so the two can differ by under €0.01 × rate on awkward minute totals. Real shifts are on 5-minute boundaries; a 1/12 h remainder can still round. This stays far inside `rosterComparison`'s €1 tolerance, and it makes "hours × rate = estimate" true on screen.

- [ ] **Step 4: Run them to see them pass**

Run:

```bash
npx vitest run src/lib/contractor-invoices-scheduled.test.js src/lib/contractor-invoices.test.js
TZ=America/Los_Angeles npx vitest run src/lib/contractor-invoices-scheduled.test.js
```

Expected: PASS.

- [ ] **Step 5: The select resolves against the schema**

Run: `npm run check:select-columns`
Expected: exit 0. `id`, `status`, `start_time_override`, `end_time_override` resolve on `shift_assignments`, and the `shift_blocks` embed columns resolve. The aliased `rosters:roster_id ( … )` embed is one the checker skips silently (D3 SELCOLS2.1 in 00-INDEX), so it was checked by hand: `rosters.status` exists (mig 602:194), and `shift_blocks.roster_id` exists (mig 067:77).

- [ ] **Step 6: Commit**

```bash
git add src/lib/contractor-invoices.js src/lib/contractor-invoices-scheduled.test.js
git commit -m "INVOICEHOURS.1 — computeScheduledForPeriod prices live published shifts only, pages, reports unpublished hours

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Approval waits for a roster read that works

**Files:**
- Modify: `src/app/api/invoices/[id]/approve/route.js` (import line 25; lines 62-68)
- Create: `src/app/api/invoices/[id]/approve/route.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/invoices/[id]/approve/route.test.js`:

```js
// INVOICEHOURS.1 D9 — approval snapshots the roster figures; a failed roster
// read must refuse the approval cleanly (503, nothing written), not throw a
// bare 500 and not save a null snapshot that later reads "approved before
// snapshots were saved".

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/contractor-invoices', async (importOriginal) => ({
  ...(await importOriginal()),
  computeScheduledForPeriod: vi.fn(),
}))
vi.mock('@/lib/contractor-invoice-email', () => ({ sendInvoiceApprovedEmail: vi.fn(async () => {}) }))
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn(async () => {}) }))
vi.mock('@/lib/invoices-queue/enqueue', () => ({ enqueueFromContractorInvoice: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { computeScheduledForPeriod } from '@/lib/contractor-invoices'
import { logError } from '@/lib/log'
import { POST } from './route.js'

const INV = {
  id: 'inv1', contractor_id: 'c1', location_id: 'locA',
  period_start: '2026-09-01', period_end: '2026-09-30', status: 'submitted',
}
const props = { params: Promise.resolve({ id: 'inv1' }) }

// select().eq().single() → the invoice; update().eq().eq().select().single()
// → the updated row. Records every update payload.
function mockDb() {
  const updates = []
  const b = {
    from: () => b,
    select: () => b,
    eq: () => b,
    update: (u) => { updates.push(u); return b },
    single: () => Promise.resolve(updates.length
      ? { data: { ...INV, ...updates[0], invoice_amount: '160.00' }, error: null }
      : { data: INV, error: null }),
  }
  return { db: b, updates }
}

describe('POST /api/invoices/[id]/approve — INVOICEHOURS.1', () => {
  let m
  beforeEach(() => {
    vi.clearAllMocks()
    m = mockDb()
    createServerClient.mockReturnValue(m.db)
    getCurrentUser.mockResolvedValue({ id: 'o1', role: 'owner', rolesByLocation: { locA: 'owner' } })
  })

  it('a failed roster read answers 503, writes nothing, and logs', async () => {
    computeScheduledForPeriod.mockRejectedValueOnce(new Error('Assignment lookup failed: boom'))
    const res = await POST({}, props)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/Could not read the roster/)
    expect(m.updates).toHaveLength(0)
    expect(logError).toHaveBeenCalledWith('invoice-approve', expect.any(String), expect.objectContaining({ invoiceId: 'inv1' }))
  })

  it('a good read snapshots the published-only figures', async () => {
    computeScheduledForPeriod.mockResolvedValueOnce({
      scheduled_hours: 8, shift_count: 1, hourly_rate: 20, estimated_cost: 160,
      unpublished_hours: 2, unpublished_shift_count: 1,
    })
    const res = await POST({}, props)
    expect(res.status).toBe(200)
    expect(m.updates).toHaveLength(1)
    expect(m.updates[0]).toMatchObject({
      status: 'awaiting_accountant_review',
      scheduled_hours_at_review: 8,
      estimated_cost_at_review: 160,
      hourly_rate_at_review: 20,
    })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run "src/app/api/invoices/[id]/approve/route.test.js"`
Expected: the 503 case FAILS (the rejection escapes `POST`: `Error: Assignment lookup failed: boom`). The snapshot case passes already.

- [ ] **Step 3: Implement**

In `src/app/api/invoices/[id]/approve/route.js`, change line 25:

```js
import { logWarn } from '@/lib/log'
```

to:

```js
import { logWarn, logError } from '@/lib/log'
```

and replace lines 62-68:

```js
  // Snapshot the at-review numbers for audit.
  const computed = await computeScheduledForPeriod(db, {
    contractor_id: inv.contractor_id,
    location_id: inv.location_id,
    period_start: inv.period_start,
    period_end: inv.period_end,
  })
```

with:

```js
  // Snapshot the at-review numbers for audit. INVOICEHOURS.1 D9 — a failed
  // roster read refuses the approval (nothing written, invoice stays
  // 'submitted'): approving without a snapshot would save nulls that later
  // read "approved before snapshots were saved", and the reviewer may not
  // have seen any comparison. Retrying is one click; nothing is lost.
  let computed
  try {
    computed = await computeScheduledForPeriod(db, {
      contractor_id: inv.contractor_id,
      location_id: inv.location_id,
      period_start: inv.period_start,
      period_end: inv.period_end,
    })
  } catch (e) {
    logError('invoice-approve', 'roster read failed; approval refused', {
      err: e?.message || String(e), invoiceId: inv.id,
    })
    return NextResponse.json(
      { success: false, error: 'Could not read the roster for this period, so the invoice was not approved. Try again in a moment.' },
      { status: 503 },
    )
  }
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run "src/app/api/invoices/[id]/approve/route.test.js"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/invoices/[id]/approve/route.js" "src/app/api/invoices/[id]/approve/route.test.js"
git commit -m "INVOICEHOURS.1 — approving waits for a roster read that works (503, nothing written)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The reviewer is told when the roster could not be read

**Files:**
- Modify: `src/app/api/invoices/[id]/route.js` (lines 63-78 and 100-110)
- Modify: `src/app/api/invoices/[id]/route.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/app/api/invoices/[id]/route.test.js`:

```js
// INVOICEHOURS.1 D9 — a failed live read is never a figure and never silent:
// the reviewer gets roster_unavailable (the web says so; the phone's Approvals
// card already prints "No roster comparison available.").
describe('GET /api/invoices/[id] — INVOICEHOURS.1 roster read failure', () => {
  const SUBMITTED = { id: 'inv1', contractor_id: 'c1', location_id: 'locA', status: 'submitted', invoice_amount: '800.00' }

  beforeEach(() => {
    vi.clearAllMocks()
    createServerClient.mockReturnValue(mockDb({ data: SUBMITTED, error: null }))
  })

  it('a reviewer is told the roster could not be read, never shown 0 h', async () => {
    computeScheduledForPeriod.mockRejectedValueOnce(new Error('boom'))
    getCurrentUser.mockResolvedValue({ id: 'o1', role: 'owner', rolesByLocation: { locA: 'owner' } })
    const res = await GET({}, props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.roster_unavailable).toBe(true)
    expect(body.data.computed_scheduled).toBeNull()
    expect(body.data.review_comparison).toBeNull()
  })

  it('a good read says roster_unavailable: false', async () => {
    computeScheduledForPeriod.mockResolvedValueOnce({ scheduled_hours: 40, shift_count: 10, hourly_rate: 20, estimated_cost: 800, unpublished_hours: 0, unpublished_shift_count: 0 })
    getCurrentUser.mockResolvedValue({ id: 'o1', role: 'owner', rolesByLocation: { locA: 'owner' } })
    const body = await (await GET({}, props)).json()
    expect(body.data.roster_unavailable).toBe(false)
    expect(body.data.review_comparison.primary.scheduled_hours).toBe(40)
  })

  it('the contractor never gets the flag (nothing was read for them)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c1', role: 'staff', rolesByLocation: {} })
    const body = await (await GET({}, props)).json()
    expect(body.data.roster_unavailable).toBe(false)
    expect(computeScheduledForPeriod).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run "src/app/api/invoices/[id]/route.test.js"`
Expected: the three new cases FAIL (`roster_unavailable` is `undefined`); the existing seven pass.

- [ ] **Step 3: Implement**

In `src/app/api/invoices/[id]/route.js`, replace lines 62-78:

```js
  const reviewerView = isMaster || isOwnerHere
  let computed = null
  if (reviewerView) {
    try {
      computed = await computeScheduledForPeriod(db, {
        contractor_id: inv.contractor_id,
        location_id: inv.location_id,
        period_start: inv.period_start,
        period_end: inv.period_end,
      })
    } catch (e) {
      // INVOICEREVIEW.2 — an approved invoice still has its saved
      // snapshot to show, so a live-recompute failure must not 500 the
      // whole detail view.
      logWarn('invoice-detail', 'live roster recompute failed', { err: e, invoiceId: inv.id })
    }
  }
```

with:

```js
  const reviewerView = isMaster || isOwnerHere
  let computed = null
  let rosterUnavailable = false
  if (reviewerView) {
    try {
      computed = await computeScheduledForPeriod(db, {
        contractor_id: inv.contractor_id,
        location_id: inv.location_id,
        period_start: inv.period_start,
        period_end: inv.period_end,
      })
    } catch (e) {
      // INVOICEREVIEW.2 — an approved invoice still has its saved
      // snapshot to show, so a live-recompute failure must not 500 the
      // whole detail view. INVOICEHOURS.1 D9 — but it must not be silent
      // either: the reviewer is told the roster could not be read.
      rosterUnavailable = true
      logWarn('invoice-detail', 'live roster recompute failed', { err: e, invoiceId: inv.id })
    }
  }
```

and in the response (lines 100-110) add the flag after `computed_scheduled: computed,`:

```js
      computed_scheduled: computed,
      roster_unavailable: rosterUnavailable,
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run "src/app/api/invoices/[id]/route.test.js"`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/invoices/[id]/route.js" "src/app/api/invoices/[id]/route.test.js"
git commit -m "INVOICEHOURS.1 — invoice detail flags a roster it could not read

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The web review says both facts

**Files:**
- Modify: `src/components/InvoicesManager.jsx` (after lines 568-573; add `RosterCheckNotes` after `FiguresRows`, which ends at line 799)
- Create: `src/components/InvoicesManager.roster-notes.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/InvoicesManager.roster-notes.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// INVOICEHOURS.1 — two honest notes beside "Schedule vs invoice":
//   - the roster could not be read (so there is no comparison; never "0 h");
//   - hours on shifts in rosters that were not published (not counted).

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { RosterCheckNotes } from './InvoicesManager.jsx'

afterEach(cleanup)

describe('RosterCheckNotes', () => {
  it('unavailable: says the roster could not be read when there is no comparison', () => {
    render(<RosterCheckNotes data={{ roster_unavailable: true, review_comparison: null, computed_scheduled: null }} />)
    expect(screen.getByRole('alert').textContent).toMatch(/Could not read the roster for this period/)
    expect(screen.queryByText(/0 h/)).toBeNull()
  })

  it('unavailable but an approval snapshot is showing: no alert (the snapshot is the record)', () => {
    const { container } = render(<RosterCheckNotes data={{
      roster_unavailable: true, review_comparison: { primary: { source: 'snapshot' } }, computed_scheduled: null,
    }} />)
    expect(container.textContent).toBe('')
  })

  it('unpublished line: names the hours and shifts left out', () => {
    render(<RosterCheckNotes data={{
      roster_unavailable: false, review_comparison: { primary: {} },
      computed_scheduled: { unpublished_hours: 2, unpublished_shift_count: 1 },
    }} />)
    expect(screen.getByText(/Not counted: 2 h on 1 shift in rosters that were not published/)).toBeTruthy()
  })

  it('plural shifts', () => {
    render(<RosterCheckNotes data={{ computed_scheduled: { unpublished_hours: 3.5, unpublished_shift_count: 3 } }} />)
    expect(screen.getByText(/3\.5 h on 3 shifts/)).toBeTruthy()
  })

  it('nothing to say: renders nothing', () => {
    const { container } = render(<RosterCheckNotes data={{
      roster_unavailable: false, review_comparison: { primary: {} },
      computed_scheduled: { unpublished_hours: 0, unpublished_shift_count: 0 },
    }} />)
    expect(container.textContent).toBe('')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/components/InvoicesManager.roster-notes.test.jsx`
Expected: FAIL. `RosterCheckNotes` is not exported (element type is invalid / undefined).

- [ ] **Step 3: Implement**

In `src/components/InvoicesManager.jsx`, after the block at lines 568-573:

```jsx
                {reviewerMode && data.review_comparison && (
                  <ReviewComparison
                    comparison={data.review_comparison}
                    invoiced={Number(data.invoice_amount)}
                  />
                )}
```

add:

```jsx
                {reviewerMode && <RosterCheckNotes data={data} />}
```

and after the `FiguresRows` function (it ends at line 799) add:

```jsx
// INVOICEHOURS.1 — what the comparison above leaves out, said plainly.
//   - roster_unavailable (GET /api/invoices/[id]): the live roster read
//     failed; with no snapshot to fall back on there is no comparison at
//     all, so say so rather than show nothing (approval also refuses with a
//     503 until the read works).
//   - unpublished_*: shifts on rosters nobody published are not scheduled
//     (D1), but a contractor may still have worked one; show the hours so a
//     correct invoice reading "over roster" has its explanation beside it.
export function RosterCheckNotes({ data }) {
  const unavailable = !!data?.roster_unavailable && !data?.review_comparison
  const live = data?.computed_scheduled
  const unpublishedShifts = Number(live?.unpublished_shift_count) || 0
  const unpublishedHours = Number(live?.unpublished_hours) || 0
  if (!unavailable && unpublishedShifts === 0) return null
  return (
    <div className="space-y-1.5 text-xs">
      {unavailable && (
        <p role="alert" className="text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded p-2 flex items-start gap-1.5">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>Could not read the roster for this period, so there is no schedule comparison. Refresh before approving.</span>
        </p>
      )}
      {unpublishedShifts > 0 && (
        <p className="text-un1t-subtle">
          Not counted: {unpublishedHours} h on {unpublishedShifts} {unpublishedShifts === 1 ? 'shift' : 'shifts'} in rosters that were not published.
        </p>
      )}
    </div>
  )
}
```

(`AlertCircle` is already imported at line 19. `text-amber-700` is the light-safe amber this file already uses at line 790; the dark-theme `text-amber-200` used by the older warning boxes fails light-theme contrast.)

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/components/InvoicesManager.roster-notes.test.jsx src/components/InvoicesManager.test.jsx`
Expected: PASS (5 new + 3 existing).

- [ ] **Step 5: Commit**

```bash
git add src/components/InvoicesManager.jsx src/components/InvoicesManager.roster-notes.test.jsx
git commit -m "INVOICEHOURS.1 — the invoice review says when the roster could not be read, and what was left out

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine). Rebase and re-run the focused suites:

```bash
git fetch origin main && git rebase origin/main
npx vitest run src/lib/contractor-invoices-scheduled.test.js src/lib/contractor-invoices.test.js "src/app/api/invoices/[id]/route.test.js" "src/app/api/invoices/[id]/approve/route.test.js" src/components/InvoicesManager.roster-notes.test.jsx src/components/InvoicesManager.test.jsx src/lib/payroll.test.js shared/contractor-invoice-review.test.js mobile/lib/invoice-review.test.js tests/shared-pair-sync.test.js
TZ=America/Los_Angeles npx vitest run src/lib/contractor-invoices-scheduled.test.js src/lib/contractor-invoices.test.js
```

Expected: all green. `shared/contractor-invoice-review.test.js` and `mobile/lib/invoice-review.test.js` are run unchanged to show the consumers still read the widened result.

- [ ] **The 12-command CI mirror (CLAUDE.md "Build, test & ship"):**

```bash
set -o pipefail
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0 and vitest reports `0 failed`.
- `check:route-guards`: no route added.
- `check:location-scoping`: the two routes gain no query; the lib read stays scoped by `profile_id` + `shift_blocks.location_id` (the invoice's studio).
- `check:select-columns`: the new literal select resolves. The aliased `rosters:roster_id` embed is skipped silently and was checked by hand (Task 2 Step 5).
- `check:guardrails`: no `new Date(\`…Z\`)`, no UTC-today form, no discarded `.single()` error (the profile read destructures `error`; the approve route's reads are unchanged), no write added.
- `check:ota-paths`: nothing under `mobile/` or `shared/`.

- [ ] **The build:**

```bash
npm run build
```

Expected: `✓ Compiled successfully`. This matters here: `InvoicesManager.jsx` is a **client** component that imports `@/lib/contractor-invoices`, which now also imports `./roster.js` and `./select-all.js`. The build is the only check that proves those resolve into the client bundle. Both are plain modules; `roster.js` imports only `@/lib/log`.

- [ ] **Independent review** (standing rule). Point the reviewer at:
  - D1: published only, unpublished hours reported, not counted;
  - D2: `isLiveAssignment`, latent today;
  - D3: swapped = the taker's, via `profile_id`;
  - D4: admin counted;
  - D5: `shiftHours`, not `workingWindow`, and the DST-night difference from LABOUR.1;
  - D6: the invoice's studio only, and why;
  - D9: detail flags, approve 503s. Is failing closed right for an approval?
  - the estimate is now rounded hours × rate (Task 2 note).

- [ ] **Browser checks** (memory `jsdom-cannot-see-layout`). On the Vercel preview (it reads prod; these checks only read, and **do not click Approve**), `/schedule/invoices` as an owner:
  1. Open the most recent approved invoice. "Schedule vs invoice, as approved on …" shows its snapshot, and **no** "Current roster (changed since approval)" line has appeared (measured: no approved period holds a cancelled or unpublished row). Record hours and verdict in the PR.
  2. If a submitted invoice exists, open it. The figures match the published roster for that month at that studio, cross-checked against the Schedule calendar for one week.
  3. The unpublished line, if an invoice period has unpublished shifts. None does today (the only such rows sit in a revoked May invoice, whose detail shows no comparison to a reviewer before approval). Say so in the PR if it cannot be seen.
  4. At 390px wide: the notes wrap, no horizontal scroll.
  5. The phone's Approvals card and invoice detail still render the comparison for a submitted invoice (same route, no OTA).

---

### PR

**Title:** `INVOICEHOURS.1 — the contractor invoice review counts only live shifts on published rosters`

**Body must say, in this order:**
1. **No migration. No OTA** (nothing under `mobile/` or `shared/`). No new route, no new permission key. Depends on A1 PAYROLL24.1 (merged as #<A1>).
2. The rule, as the reviewer now sees it: scheduled hours are live assignments (not cancelled) on published rosters, at the invoice's studio, in the invoice's month. Swapped shifts count for the contractor holding them, and admin shifts count. Hours are payroll's `shiftHours` (24:00 = midnight since A1).
3. Hours on shifts whose roster was never published are shown ("Not counted: X h on N shifts…"), never priced.
4. Failure handling: a failed roster read is flagged on the detail (`roster_unavailable`, web note), and approval answers 503 and writes nothing until the read works. Previously the detail silently dropped the comparison, and approval threw a bare 500.
5. Measured on prod (counts only): 181 assignments inside the 10 invoice periods, 0 cancelled, 2 unpublished (in one revoked invoice), 0 contractor-months at two studios. **No live figure changes today**; the fix is for the next draft week or cancelled row. Snapshots untouched.
6. What it deliberately does not do: count a sibling studio's shifts (held product item: one invoice per contractor per month across studios, mig 101:65-67 as redefined by mig 102:20-23); move the rate to `profile_compensation`; change the phone.
7. Browser-check results (the five above).
8. Open questions for Richard (below) and follow-ups found.
9. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit another row (`merge=union`).

```
| #<PR> | INVOICEHOURS.1 — the contractor invoice review counts only live shifts on published rosters | 2026-09-2x. Follow-ups row A3. **No migration, no OTA, no route.** `computeScheduledForPeriod` (`src/lib/contractor-invoices.js`) now reads assignment `status` + the block's `rosters:roster_id ( status )`, pages via `selectAll`, and delegates to the new pure `scheduledFromAssignments`: live (`isLiveAssignment`, cancelled counts nowhere) AND published (no roster / draft / superseded = not scheduled, tallied as `unpublished_hours`/`unpublished_shift_count`); swapped = the taker's (swap approval moves `profile_id`); admin shifts counted; hours by payroll's `shiftHours` (24:00 = midnight since PAYROLL24.1; wall clock, so the 00:30-03:30 clocks-back night is 3 h, where LABOUR.1 says 4 h); the invoice's own studio only (Xero org per location; cross-studio is the held product item). Estimate = rounded hours × rate. `GET /api/invoices/[id]` adds `roster_unavailable` for reviewers on a failed read (was a silently missing comparison); `POST …/approve` answers 503 and writes nothing on a failed read (was a bare 500). Web `RosterCheckNotes` says both. Measured 27 Sep: 0 cancelled and 0 unpublished rows in any live invoice period, so no figure moved and no snapshot drifted. Tests under Dublin + LA. |
```

---

### Open questions for the owner (Richard)

1. **A contractor who works at both studios** can file only one invoice a month, against one studio (mig 101:65-67, redefined by mig 102:20-23). This PR prices only the invoice's own studio, so such an invoice would read "over roster" by the other studio's hours. None has happened yet (0 contractor-months at two studios). When it does, should they file one invoice per studio (a unique-index change, the held item), or should the review add a line "also rostered at <other studio>: X h"?
2. **Shifts on rosters that were never published** are not priced; their hours are shown beside the estimate. If a contractor worked such a shift, is the fix to publish the week (the figures then correct themselves), or should the review price it?
3. **Clock-change nights.** The review uses payroll's wall-clock hours, so a shift across the 01:00-02:00 change is an hour short (autumn) or long (spring) compared with LABOUR.1. Nobody has been rostered in those hours. Leave it, or move payroll and this review to elapsed time together?

### Overlap with A2 CONTRACTORSPEND.1

- **Same rule, different question.** A2 prices a studio's month for every contractor who worked there (active or not, linked or not). A3 prices one contractor's month at the invoice's studio. Both use "live (`isLiveAssignment`) on a published roster" and both count admin shifts **for the invoice** (A2 keeps admin at €0 in the **budget gate** per SHIFTTYPE.1, which is not a conflict: the gate is a budget, the invoice is pay).
- **No shared file except `docs/CHANGELOG.md`.** A2 lives in `src/lib/roster-summary.js` / `roster-summary-server.js`; A3 in `contractor-invoices.js`, the two invoice routes and `InvoicesManager.jsx`. Either can merge first. If A2 merges first with an exported "live and published" predicate, Task 0 Step 3 swaps it in; nothing else changes.
- **Hours helper must agree.** A3 uses `shiftHours` (D5). If A2's plan chooses `workingWindow`, the two will disagree on clock-change-night shifts only. Align them in whichever plan is written second (this one says `shiftHours`, to match payroll and the approval snapshots).
- **Both depend on A1** (A2 prices through `shiftHours`/`summarizeMonth`; A3 through `shiftHours`).

### Follow-ups found while planning (not in this PR)

- **The phone invoice detail says nothing when the roster read fails** (`mobile/app/(staff)/invoices/[id].jsx:129` renders `reviewComparisonView(data)`, `null` → no block), and it does not show the unpublished line. The Approvals card already prints "No roster comparison available." A small OTA: teach `mobile/lib/invoice-review.js` to read `roster_unavailable` and `computed_scheduled.unpublished_*`. Fits D4 UINITS.1.
- **The rate comes from the deprecated `profiles.hourly_rate`** (`contractor-invoices.js:101-105`) and the detail route's `contractor:contractor_id ( …, hourly_rate, … )` embed (`src/app/api/invoices/[id]/route.js:32`). The canonical copy is `profile_compensation` (mig 152). LABOUR.1 measured 0 drift; move both reads when the `profiles` pay columns are dropped.
- **A revoked invoice still blocks a resubmit.** Mig 102 (`102_contractor_invoice_revoke.sql:20-23`) let a revoked row make way for a fresh submission, and the UI promises it ("A fresh submission can be made for the same period", `InvoicesManager.jsx:600-601`, `637-639`). But the submit route's pre-check (`src/app/api/invoices/route.js:157-175`) filters only `.neq('status', 'declined')`, so a revoked row answers 409 "You already have a submission pending review". The pre-check also discards the `.maybeSingle()` error, so a failed read lets the insert through to the unique index. Fix: `.not('status', 'in', '(declined,revoked)')` and handle `error`. Prod has 4 declined-or-revoked rows of 10 (27 Sep), so the path has been used; check with Richard whether any contractor has hit the 409.

---

### Self-review (done while writing)

- **Spec coverage:**

  | Asked for | Where |
  |---|---|
  | Use `isLiveAssignment` | D2, Task 1 |
  | Published rosters only | D1, Tasks 1-2 |
  | Every consumer read | "What was found", consumers 1-6 |
  | `shiftHours` and the A1 dependency | D5, Task 0 Step 1, the 24:00 test |
  | Across studios | D6, open question 1, measured 0 |
  | Pagination | D8, Task 2 "pages past 1,000" |
  | A failed read is never "0 scheduled" | D9, Tasks 2-5 |
  | Draft = not scheduled | D1 |
  | Cancelled = out | D2 |
  | Swapped = the taker's | D3 |
  | Admin shifts count | D4 |
  | DST month and a US TZ | D5/D7, both test loops, and the `TZ=America/Los_Angeles` gate run |
  | Final gate | 12-command mirror + `npm run build` |
  | PR title/body, CHANGELOG row, open questions | above |
- **Placeholders:** none in code steps. `<PR>`, `<A1>` and the `x` in the CHANGELOG date are filled at PR time.
- **Names:** used identically in Tasks 1-5, the tests and the CHANGELOG:
  - `scheduledFromAssignments(rows)` → `{ scheduled_hours, shift_count, unpublished_hours, unpublished_shift_count }`;
  - `computeScheduledForPeriod` → those plus `hourly_rate`, `estimated_cost`;
  - `roster_unavailable` (API) / `rosterUnavailable` (route local);
  - `RosterCheckNotes({ data })`.
- **Arithmetic re-checked:**
  - Task 1: 4 + 1.5 = 5.5; unpublished 1 + 1 + 1.5 = 3.5.
  - Task 2: 8 × 20 = 160; 1,005 × 1 h × 20 = 20,100; the old code on the "published-only" fixture = 8 + 2 + 8 = 18 h over 3 rows, so the test fails before the change.
- **Anchors verified at `28d02e59`:**
  - `contractor-invoices.js`: 10-14, 16-18, 73-159 (read 114-131);
  - detail route: 32, 42-62, 63-78, 83, 91-98, 100-110;
  - approve route: 25, 62-68, 74-88;
  - `InvoicesManager.jsx`: 19, 444-461, 568-573, 600-601, 637-639, 745-799, 790;
  - `shared/contractor-invoice-review.js`: 57-77, 125-155;
  - `mobile/lib/invoice-review.js`: 99-117;
  - `RosterComparison.jsx`: 57-90;
  - `payroll.js`: 25-34, 44-61;
  - `roster.js`: 440-442;
  - `schemas.js`: 249-251, 260;
  - migrations: 067:70-71, 067:77, 101:65-67, 102:20-23, 602:194, 603:214; `src/app/api/invoices/route.js:157-175`.
