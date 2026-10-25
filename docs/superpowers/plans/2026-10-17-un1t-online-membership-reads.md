# Membership read seam + Hatch membership numbers (P1.2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hatch Street's Business and Studio dashboards (web and phone) show real membership numbers from un1t.online: members, MRR, revenue this month, membership sales and cancellations, net growth and active-member rate. Stillorgan's Glofox numbers stay byte-identical.

**Architecture:** A per-source read adapter in `src/lib/membership/reads/` (the `src/lib/payments/index.js` dispatcher pattern). The Glofox adapter wraps today's functions unchanged; the un1t.online adapter reads `un1t_*` + `contact_memberships`. A surface renders a number when its source's adapter **implements that read**; otherwise it renders the existing "unavailable" or gate state. Provider `capabilities` keep gating whole features (churn and lead radar, engagement, Mia, crons): un1t.online stays `memberships:false` there in this plan.

**Tech Stack:** Next.js 16 App Router server pages and routes, Supabase service-role client, Vitest.

**Spec:** `docs/superpowers/plans/2026-10-17-un1t-online-p1-plan.md` §P1.2, with the 2026-10-17 decisions, and the parent spec `docs/superpowers/specs/2026-09-01-un1t-online-hatch-integration-design.md`.

**Depends on:** #2072 (UN1TCAP.1, `providesCapability`). This branch is stacked on it; rebase onto `main` once #2072 merges.

## Global Constraints

- **Glofox output is unchanged.** Every Glofox read in the adapter calls the existing function with the same arguments and returns its result untouched. Each of these keeps its tests passing without edits: `computeMembershipCounts`, `fetchMrr`, `fetchMembershipFlows`, `fetchGrowth`, `fetchEngagement`, `fetchRevenueMTD`, `fetchArrearsSummary`.
- **un1t reads scope by membership location** (`<table>.location_id = locationId`), never by `contacts.location_id`, so dual-studio members count at Hatch. All of them run on the service-role client, and every list read paginates with `.range()` + `.order()` under the 1,000-row cap.
- **The adapter lives in `src/lib`.** `shared/` cannot import `src/lib` (Metro), so nothing in `shared/` calls the seam. Phones get un1t numbers only through `/api/*` routes.
- **Return shapes match the Glofox functions exactly**, so `MembershipPanel`, `StudioScorecard`, `buildBusinessBriefing` and the phone's `BusinessDashboard` render unchanged. Field lists are in Task 2.
- **Money is integer cents.** MRR normalises each subscription to a month: `price_cents / billing_interval_count` when `billing_interval === 'month'`; years use ×12.
- **un1t classification rules** (from live data, 2026-10-17):
  - A **recurring member** is a `un1t_subscriptions` row with `status = 'active'`.
  - **Active recurring** additionally has `paused_at IS NULL` and `past_due_at IS NULL`.
  - A **trial** is a `un1t_products` row with `type = 'one_time'` and `price_cents = 0`.
  - A **paid pack holder** is a `un1t_clients` row with `credit_balance > 0`, `credit_unlimited = false`, no active subscription, whose most recent `un1t_transactions` row with `product_type = 'pack'` was for a product with `price_cents > 0`.
- **Tracking starts:** un1t sales count from the first synced transaction. un1t cancellations count from `UN1T_CANCEL_TRACKING_START = '2026-10-16'` (the first sync), so earlier months report `cancellations: null`, never 0.
- **Capability flags are not flipped.** `un1tOnlineSource.capabilities` stay all `false`, so radars, the engagement page, Mia and the #2072-gated crons keep skipping Hatch.

## Review Focus

1. **Dual-studio member** (contact at Stillorgan, active Hatch subscription): counted in Hatch's members and MRR, and still counted at Stillorgan if they're a Glofox member there. Test in Task 2.
2. **A 3-month or 12-month subscription** contributes `price/3` or `price/12` a month to MRR, never its full price. Test in Task 2.
3. **Paused or past-due subscription:** counted in `monthly_recurring` and `total_members`, excluded from `active_recurring`. Test in Task 2.
4. **A month before cancellation tracking began:** `cancellations: null` (the chart's "not tracked yet" footnote), not 0. Test in Task 2.
5. **An unreadable source or a failed un1t read:** the surface shows its existing error or "unavailable" state, never Glofox zeros and never a 500 to the phone. Tests in Tasks 3–4.

---

### Task 1: The seam and the Glofox adapter (no behaviour change)

**Files:**
- Create: `src/lib/membership/reads/index.js`, `src/lib/membership/reads/glofox.js`, `src/lib/membership/reads/none.js`
- Test: `src/lib/membership/reads/index.test.js`, `src/lib/membership/reads/glofox.test.js`

**Interfaces:**
- Produces:
  - `export const READ_KEYS = Object.freeze(['membershipCounts','mrr','membershipFlows','growth','engagement','revenueMtd','arrears'])`
  - `export async function membershipReadsFor(db, locationId) → { source: string|null, label: string, state: string, reads: object|null, error: any }`. It resolves via `membershipStateForPage(db, locationId)`. `reads` is the adapter for `state === 'configured'` and `null` otherwise (none / unconfigured / unknown / no_location).
  - `export function supportsRead(r, key) → boolean`, true when `typeof r?.reads?.[key] === 'function'`.
  - Glofox adapter (`reads/glofox.js`) `glofoxReads`: `membershipCounts(db, loc)` → `computeMembershipCounts(db, loc)`; `mrr(db, loc)` → `fetchMrr(db, loc)`; `membershipFlows(db, loc, months, nowMs, opts)` → `fetchMembershipFlows(...)`; `growth(db, loc, now)` → `fetchGrowth`; `engagement(db, loc)` → `fetchEngagement`; `revenueMtd(db, loc, now, zone)` → `fetchRevenueMTD`; `arrears(db, loc)` → `fetchArrearsSummary`. Each one passes through, with the same arguments and the same resolved value or thrown error.
  - `reads/none.js`: `noneReads = Object.freeze({})`.
  - Registry: `export const READS_BY_SOURCE = { glofox: glofoxReads, none: noneReads }`. Task 2 adds `un1t_online`; Task 3 reads it in `membershipStatePayload`. An unknown source key maps to `noneReads`.

- [ ] **Step 1: Write the failing tests.**
  - `index.test.js`:
    - `configured glofox → reads is the glofox adapter`.
    - `none, unconfigured, unknown, no_location → reads null` (and `supportsRead` false for every `READ_KEYS` entry).
    - `an unregistered source key → noneReads (supportsRead false)`.
    - `supportsRead is false for a key the adapter lacks`.
  - `glofox.test.js`, one per read: with each wrapped function mocked via `vi.mock`, the adapter calls it with exactly the same arguments and returns the mock's value. A rejection propagates.
- [ ] **Step 2:** Run `npx vitest run src/lib/membership/reads/` and confirm it FAILS (modules missing).
- [ ] **Step 3:** Implement the three files. The adapter files are plain frozen objects of functions, with no logic beyond delegation.
- [ ] **Step 4:** Run the same command and confirm it PASSES.
- [ ] **Step 5:** Commit `UN1TREAD.1 — membership read seam + Glofox adapter (pass-through)`.

---

### Task 2: The un1t.online read adapter

**Files:**
- Create: `src/lib/membership/reads/un1t-online.js` (queries) and `src/lib/membership/reads/un1t-online-shape.js` (pure shaping)
- Modify: `src/lib/membership/reads/index.js` (register `un1t_online`)
- Test: `src/lib/membership/reads/un1t-online-shape.test.js`, `src/lib/membership/reads/un1t-online.test.js` (recording supabase fake in the style of `src/lib/un1t-online-sync.test.js`)

**Interfaces:**
- Consumes: the `un1t_subscriptions`, `un1t_clients`, `un1t_products`, `un1t_transactions` and `contact_memberships` columns (mig 726, 722); `computeMrr` and `windowBounds` from `shared/studio-kpi-math.js`.
- Produces `un1tOnlineReads`, with exactly these return shapes (identical to the Glofox functions):
  - `membershipCounts(db, loc)` → `{ total_members, monthly_recurring, class_packs, payg: 0, active_recurring, dead_packs: 0, detail: { recurring_by_interval: { '1 month', '3 months', '6 months', '12 months' } } }`
    - `monthly_recurring` = active subscriptions;
    - `active_recurring` = active, not paused, not past due;
    - `class_packs` = paid pack holders;
    - `total_members` = `monthly_recurring + class_packs`.
  - `mrr(db, loc)` → `{ success: true, data: { mrrCents, recurringMembers, yieldCents } }`, from `computeMrr` over active subscriptions as `{ price_cents, interval }`, where `interval` is the Glofox spelling (`'1 month'`, `'3 months'`, `'12 months'`) derived from `billing_interval_count` + `billing_interval`.
  - `membershipFlows(db, loc, months, nowMs, { zone })` → `{ months: [{ month, sales, cancellations }], cancelTrackingStart: UN1T_CANCEL_TRACKING_START }`. `sales` = each `un1t_user_id`'s FIRST `un1t_transactions` row with `type = 'sub_initial'`, bucketed by local month. `cancellations` = `contact_memberships` rows (`source = 'un1t_online_api'`, this location) with `ended_at` in that month. A month before tracking start gets `null`.
  - `growth(db, loc, now)` → `{ success: true, data: { windowDays, recurringStarts, recurringCancels, netRecurring, netRecurringDelta } }`, over the same 28-day windows as `fetchGrowth` (`windowBounds`). `netRecurringDelta` is `null` while the previous window starts before tracking.
  - `engagement(db, loc)` → `{ success: true, data: { members, activeMembers, activeRatePct, visitsPerMemberWeek } }`, from `un1t_clients.bookings_30d_attended` for clients holding an active subscription, through `computeEngagement`.
  - `revenueMtd(db, loc, now, zone)` → `{ totalCents, paidCount, deltaPct }`. It sums `un1t_transactions.amount_cents` where `refunded = false` and `remote_created_at` falls in the local month-to-date, compared with the same window last month (same rule as `fetchRevenueMTD`).
  - **No `arrears`** in this plan. It is left out deliberately, because un1t past-due amounts aren't synced. The surface shows "unavailable".
- `UN1T_CANCEL_TRACKING_START = '2026-10-16'` is exported from `un1t-online-shape.js`.

- [ ] **Step 1: Write failing shape tests** (`un1t-online-shape.test.js`, pure):
  - `counts: active subs → monthly_recurring; paused or past-due excluded from active_recurring only` (Review Focus 3).
  - `counts: a €0 one_time product is a trial, never a class pack; a paid pack with balance > 0 and no sub is a class pack`.
  - `mrr: a 3-month €567 sub adds 18900/month; a 12-month €2268 sub adds 18900/month` (Review Focus 2).
  - `flows: first sub_initial per user only; a month before 2026-10 has cancellations null; ended_at buckets by local month` (Review Focus 4).
  - `revenueMtd: refunded excluded; deltaPct null when last month is 0`.
- [ ] **Step 2: Write failing query tests** (`un1t-online.test.js`):
  - `every read filters .eq('location_id', loc) on its table and never reads contacts.location_id`.
  - `a contact living at Stillorgan with an active Hatch subscription is counted at Hatch` (Review Focus 1).
  - `lists paginate with range + order`.
  - `a failed read throws (counts) or returns { success:false, error } (the fetch-style reads), the same contract as the Glofox function it mirrors`.
- [ ] **Step 3:** Run `npx vitest run src/lib/membership/reads/` and confirm FAIL.
- [ ] **Step 4:** Implement the two files and register `un1t_online: un1tOnlineReads`.
- [ ] **Step 5:** Run and confirm PASS. Then `npm run check:select-columns && npm run check:guardrails`, and arm `src/lib/membership/reads/` for `no-unchecked-supabase-write` if it writes (it shouldn't).
- [ ] **Step 6:** Commit `UN1TREAD.2 — un1t.online membership reads (counts, MRR, flows, growth, engagement, revenue)`.

---

### Task 3: Business dashboard (web + phone) through the seam

**Files:**
- Modify: `src/lib/dashboard/business-kpis.js` (`buildBusinessKpis`)
- Modify: `src/app/dashboard/business/page.js` (`KpiBriefingBlock`, `MembershipBlock`)
- Modify: `src/app/api/dashboard/business/route.js` (`membershipBlock`, the kpis)
- Modify: `src/lib/membership/state-for-page.js` (`membershipStatePayload.provides_memberships`)
- Tests: `src/app/dashboard/business/page.test.js`, `src/lib/dashboard/business-kpis.test.js` (create it if missing), `src/app/api/dashboard/business/route.test.js` (create it if missing)

**Interfaces:**
- Consumes: `membershipReadsFor`, `supportsRead`, `READ_KEYS` (Task 1); `un1tOnlineReads` (Task 2).
- `buildBusinessKpis(db, user, locationId, nowMs)` takes the reads bundle:
  - `revenue` ← `reads.revenueMtd`;
  - `arrearsData` ← `reads.arrears` if supported, else `null`;
  - `memberCount` ← `reads.membershipCounts` (`active_recurring ?? monthly_recurring`);
  - `churnCount` / `churnDelta` ← `loadRadar` only when `providesCapability(membership, 'memberships')`, else `null`.
  
  When `revenueMtd` is unsupported it returns `null` (the existing `BlockError`). Glofox results stay identical.
- **Page gates** (both blocks):
  - The KPI row renders when `supportsRead(r, 'membershipCounts') && supportsRead(r, 'revenueMtd')`.
  - `MembershipBlock` renders when `supportsRead(r, 'membershipCounts') && supportsRead(r, 'membershipFlows')`.
  - Otherwise the existing `MembershipSourceGate`.
  - **`providesCapability` stays the gate for radar-derived cells.** For un1t, Churn risk and In arrears render `—`.
- **Phone route:** the `membership: { live, trend }` block comes from `reads.membershipCounts` plus `fetchMembershipTrend` (the snapshots, which Task 5 starts writing for un1t). `kpis` comes from the new `buildBusinessKpis`.
- **Payload:** `membershipStatePayload(...).provides_memberships` = `configured && (capabilities.memberships !== false || READS_BY_SOURCE[source] implements 'membershipCounts')`, so the phone shows Hatch's numbers. Add a code comment next to it naming this OR as deliberate.

- [ ] **Step 1: Write failing tests:**
  - `un1t.online: KPI row shows Revenue and Members from the un1t reads, Churn risk and In arrears render —` (page);
  - `un1t.online: MembershipBlock renders MembershipPanel with un1t counts and flows`;
  - `glofox: buildBusinessKpis output is deep-equal to before for the same mocks`;
  - `phone route: un1t.online returns membership.live from the un1t adapter and membership_source.provides_memberships true`;
  - `unknown state: no reads run, gate copy` (Review Focus 5).
- [ ] **Step 2:** Run the three test files and confirm FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and confirm PASS, then `npx vitest run src/app/dashboard/ src/lib/dashboard/ src/app/api/dashboard/ mobile/lib/membership-source-copy` (the phone copy tests read the payload flag).
- [ ] **Step 5:** Commit `UN1TREAD.3 — business dashboard (web + phone) reads membership numbers through the seam`.

---

### Task 4: Studio scorecard through the seam

**Files:**
- Modify: `src/app/dashboard/studio/page.js` (`loadLocationScorecard`, `LocationColumn`)
- Test: `src/app/dashboard/studio/page.test.js`

**Interfaces:**
- `loadLocationScorecard(locationId, r)` takes the reads bundle:
  - `mrr` ← `reads.mrr`, `growth` ← `reads.growth`, `engagement` ← `reads.engagement`;
  - `churn` (revenue churn) ← `fetchRevenueChurn` only for Glofox (it needs `membership_transitions.price_cents`); for un1t it is `null`;
  - `acq` ← `fetchAcquisition` (contacts, source-agnostic, unchanged);
  - `floor` ← `fetchFloor` (class tables; empty for Hatch until P1.1a, so `noData`, unchanged);
  - `radarSummary` ← `loadRadar` only when `providesCapability(…, 'memberships')`, else `null`.
- **Gate:** `LocationColumn` renders the scorecard when `supportsRead(r, 'mrr')`; otherwise the existing gate.
- **Empty state:** `LocationEmptyState` still triggers on `mrr.recurringMembers === 0 && floor.noData`.

- [ ] **Step 1: Write failing tests:**
  - `un1t.online column: MRR, net growth and active-member rate render from the un1t reads; revenue churn, arrears, at-risk and saves render — (unavailable); the Glofox column is unchanged`;
  - `un1t.online with 0 subs and no classes: LocationEmptyState`;
  - `a failed un1t mrr read renders — for MRR and keeps the other cells` (soft, as today).
- [ ] **Step 2:** Run `npx vitest run src/app/dashboard/studio/page.test.js` and confirm FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and confirm PASS.
- [ ] **Step 5:** Commit `UN1TREAD.4 — studio scorecard reads MRR, growth and engagement through the seam`.

---

### Task 5: Membership snapshots for un1t.online (so the trend accrues)

**Files:**
- Modify: `src/app/api/cron/membership-snapshot/route.js`, `src/lib/membership-snapshot.js` (`writeMembershipSnapshot` takes an optional `counts` argument)
- Test: `src/app/api/cron/membership-snapshot/route.membership-source.test.js`

**Interfaces:**
- The cron snapshots every active location where `supportsRead(membershipReadsFor(db, id), 'membershipCounts')`, i.e. Glofox and un1t.online. It writes `writeMembershipSnapshot(db, id, { ...opts, counts: await reads.membershipCounts(db, id) })`; with `counts` omitted, behaviour is today's.
- The skip count keeps the key `skipped_no_source`.
- Replace the #2072 `locationIdsWithoutCapability(db, 'memberships')` skip in **this cron only** with the reads check. The other four crons keep the capability skip (they read radar and Glofox data).

- [ ] **Step 1: Write failing tests:**
  - `snapshots Stillorgan (glofox) and Hatch (un1t.online, un1t counts); still skips none`;
  - `a failed un1t counts read records that location's error and continues; the heartbeat still stamps` (as today for a per-location error).
- [ ] **Step 2:** Run and confirm FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and confirm PASS, then `npx vitest run src/app/api/cron/`.
- [ ] **Step 5:** Commit `UN1TREAD.5 — membership snapshots include un1t.online studios`.

---

### Task 6: Verify, document, ship

- [ ] **Step 1:** Run the full CI mirror from CLAUDE.md (13 commands, run individually), then `npm run build`.
- [ ] **Step 2:** Production read-only check (operator present). Compare the un1t adapter's counts for Hatch with SQL:
  - 26 active subscriptions;
  - MRR ≈ €4,914 (26 × €189);
  - class packs = holders of paid packs only.
  
  Report the numbers.
- [ ] **Step 3:** Update the P1 plan (§P1.2 status) and add the changelog entry after `gh pr create`.

---

## Out of scope (next P1.2 plans)

- Flipping `capabilities.memberships` and churn and lead radar for un1t.online: needs a radar adapter (attendance, past due, plan value).
- The pipeline classifier fed from the seam (decision 4).
- `arrears` for un1t.online: needs past-due amounts synced.
- The morning-briefing pulse strip for un1t (needs the counts + snapshot comparator; easy once Task 5 has a month of snapshots).
