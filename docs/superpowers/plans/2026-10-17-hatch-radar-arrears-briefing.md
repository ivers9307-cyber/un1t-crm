# Hatch Street radar, arrears and briefing pulse from un1t.online Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hatch Street's churn radar, lead radar, arrears figures, weekly digest and morning-briefing pulse read un1t.online data through the membership seam, scored by the unchanged Stillorgan rules, ending with `capabilities.memberships = true` for un1t.online.

**Architecture:** Four new read keys on the membership read seam (`radarMembers`, `winbackContacts`, `leadContacts`, `radarPastDue`), dispatched by source key in any state through a new `radarReadsFor`. The Glofox adapter forwards to today's functions untouched; a new un1t adapter (pure shape module + I/O module) produces the scorer's existing row shape from `un1t_*` tables, reusing spec A's `pastDue`, `pipelineInputs`, `shapePipelineSnapshot` and `freshCutoff`. Callers (`churn-radar-data.js`, `lead-radar-data.js`, engagement, pulse, rail) change only their row fetch. A forward DML migration removes Hatch's Glofox-shaped snapshot history; the capability flip is the last PR.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role client, PostgREST), vitest 5, plain JS modules under `src/lib`.

**Spec:** `docs/superpowers/specs/2026-10-17-hatch-radar-arrears-briefing-design.md` (spec B). Depends on `docs/superpowers/specs/2026-10-17-hatch-pipeline-and-invoices-design.md` (spec A; its plan: `docs/superpowers/plans/2026-10-17-hatch-pipeline-and-invoices.md`). Executors read both specs.

## Global Constraints

- Repo house rules: `CLAUDE.md`. Every PR is a fresh branch: `git fetch origin main && git checkout -b <branch> origin/main`. Never build on a local `main`, never `git stash`.
- CI mirror before every push, all thirteen: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths`. Plus `npm run build` (every PR here adds imports).
- Changelog: each PR adds ONE file `docs/changelog/entries/<PR>.md` after `gh pr create`, one row `| #<PR> | UN1TRADAR.N — title | 2026-MM-DD. What and why. |`. Never edit another PR's entry.
- Migrations: forward-only, numbered `NNN` = next free number at build time (736+ today; spec A also takes numbers). Implementer subagents have NO Supabase MCP access: they write the file; the **controller applies via Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj`, then `get_advisors` security**, before the PR merges.
- No new table, column, view or function in this plan, so no grant decision (spec §6 "Schema / grants").
- **OTA:** exactly one task touches `mobile/`: Task 11b (phone estimate label, PR 2). Merging PR 2 publishes an OTA to every phone on the lane at 100%; accepted by the coordinator on 2026-10-17, overriding spec B's anti-goal "No phone OTA" for this one label. No other task touches `mobile/` or `shared/`; if one finds it must, stop and ask the controller.
- Anti-goal, pinned by tests: no change to a single Stillorgan number, row or order. Every Glofox path is a pass-through. Stillorgan's `/api/churn-radar` `data` JSON must stay byte-identical (new response fields go at the top level, beside `data`, never inside it; new per-row keys appear only when true).
- A read un1t.online cannot supply renders exactly `not available from un1t.online`, never `0` (spec §4, Claude's call 12).
- Estimated arrears copy: row `about €X (estimate: amount not reported by un1t.online)`; any total that includes one carries `includes an estimate` (spec §4, Claude's call 11).
- Staff copy, no em-dashes. Exact strings: `Payment reminders are not available for un1t.online studios yet.` / `un1t.online data refreshes every 15 minutes, last at HH:MM` / `No WhatsApp number at this studio yet` / `Payment failed` / `Cancelling` / `Membership ends on <date>`.
- No radar, arrears or other aggregate studio number on a TV or customer-facing screen (#2067 rule). No new customer-facing message, sequence or push. No outbound WhatsApp through Stillorgan's number.
- Richard's address never appears in code, tests, fixtures, migrations, PR text, plan or logs. Test fixtures use `@example.com`.
- Logs carry no names, emails or ids beyond `locationId` (and `contactId` where today's code already logs it).
- `loadContactArrears`, the contact page and the command centre stay Glofox-only here (spec A §6.11 owns un1t billing there).
- `capabilities.bookings`, `credits`, `invoices`, `schedule` are never touched by this plan.

## Review Focus

1. **Dual-studio member (contact owned by Stillorgan, membership at Hatch).** Every Hatch row is built from `un1t_*` at Hatch only; the contact's Stillorgan `glofox_*` columns, `last_attended_at` and plan never leak into a Hatch row (radar, win-back, lead, Overdue tab). Test: Task 2 `shapeRadarMembers ignores contacts.glofox_* on a dual-studio contact`; Task 10 `overdue row at a un1t studio takes plan and last attended from un1t, not contacts`.
2. **Stale-active subscription / stalled sync.** A subscription the API stopped returning (older than A's `freshCutoff`) is not live, and becomes win-back evidence; a stalled sync (every row equally old) keeps every row live. Test: Task 5 `radarMembers drops a subscription older than freshCutoff` and `radarMembers keeps all rows when the sync stalled`.
3. **Window edges and junk rows.** An event starting exactly `now − 7d` counts in the 7-day window; one at `now − 7d − 1ms` does not; an event with null `starts_at` is excluded and counted; statuses are lowercase. Test: Task 2 `total_attended_7d boundary` and `null starts_at excluded`.
4. **The 1,000-row cap and long `.in()` lists.** Every list read is `selectAll` paginated with an explicit order, and booking reads chunk event ids at ≤200. Test: Task 5 `radarMembers pages past 1000 clients` and `bookings read chunks event ids at 200`.
5. **A member who is both cancelling and past due, or dismissed/snoozed.** Past due wins classification (Overdue tab), they still appear in the pinned "Payment failed" block, are never counted twice, and a dismissed contact is in neither. Test: Task 16 `pinned holds a cancelling past-due member once` and `pinned excludes a dismissed contact`.

---

## PR map and dependencies on spec A

| PR | Branch | Tasks | Waits for |
|---|---|---|---|
| (controller) | none | Task 0 | nothing; do first |
| PR 1 `UN1TRADAR.1` seam dispatch, un1t radar adapter, read APIs gated | `un1t-radar-seam` | 1-8 | Build and merge once A's PR 2 `HATCHPIPE.2` (lands `freshCutoff`, `pastDue`, `shapePipelineSnapshot`, `pipelineInputs`) is on `origin/main`. Nothing visible changes at Hatch (coordinator decision, 2026-10-17). |
| PR 2 `UN1TRADAR.2` arrears via A's `pastDue`, pulse comparator, legacy-row migration, phone estimate label (OTA) | `un1t-radar-arrears-pulse` | 9-14 (incl. 11b) | PR 1 merged AND A's PR 4 `HATCHINV.1` (`invoices` flip) live, because this PR lights up Hatch's arrears; migration applied after Hatch's first un1t-shaped `membership_snapshots` row exists (expected 2026-10-18 02:00 UTC) |
| PR 3 `UN1TRADAR.3` cancelling/past-due pins, acting routes, crons | `un1t-radar-pins-actions` | 15-20 | A-side gate is only `HATCHPIPE.2` (nothing visible at Hatch). Code dependency: Task 16 uses PR 2's `radarPastDue` and `owedLabel`, so branch after PR 2 merges; if PR 2 is held waiting on `HATCHINV.1`, Tasks 15, 17, 18, 19 can ship as PR 3 alone and Task 16 moves to a follow-up PR after PR 2. |
| PR 4 `UN1TRADAR.4` flip `memberships` | `un1t-radar-memberships-flip` | 21-22 | PR 3 merged, Task 0 done, PR 2 migration applied, A's PR 4 `HATCHINV.1` (`invoices` flip) live (hard, spec A-7) |

A's interfaces this plan consumes (exact names from spec A §6.2 / §6.10 and A's plan Tasks 4-7; Task 1 Step 1 confirms them on `origin/main` and stops if any differs):
- `un1tOnlineReads.pipelineInputs(db, locationId, { now })` → `{ success, data: { contacts: [{ id, name, email, location_id }], snapshots: Map<contactId, snapshot>, unlinked } } | { success:false, error }`
- `shapePipelineSnapshot({ client, contact, locationId, freshSubs, transactions, productsById, bookings, memberships, ledgerTrials, now })` (pure, `src/lib/membership/reads/un1t-online-shape.js`)
- `un1tOnlineReads.pastDue(db, locationId, { contactIds? })` → `{ success, data: [{ contactId, un1tUserId, subscriptionId, productTitle, since, amountCents|null, currency, openInvoiceIds, cancelAtPeriodEnd, pausedUntil }] } | { success:false, error }`
- `freshCutoff(db, table, locationId)` → `Promise<string|null>` (A's extraction of the stale-active guard)
- `isTrialProduct(p)` (exists today, `un1t-online-shape.js:30`)

Plan-level calls the spec leaves open (each is pinned by a test in its task; Richard can reverse any):
- Overdue rows at a un1t studio take plan and last-attended from un1t (`profileById`, Task 9-10), because `buildOverdue` reads them off `contacts`, which are Stillorgan's for a dual-studio member.
- A lead snapshot carrying `gympass_member_id` is rendered with status `classpass_payg` (Task 4), so the unchanged lead scorer routes it to the aggregator view.
- `account-home` keeps Glofox's contacts head-count and uses `membershipCounts` only for other sources (Task 19), narrowing spec §5's "one line" so no Stillorgan number moves.
- New response fields (`source`, `dataAsOf`, `outreachAvailable`) sit beside `data`, never inside it (Task 7, 18); `dataAsOf` reads `un1t_sync_runs` (spec "Left to the builder").
- A `trialing` subscription is not win-back evidence (Task 3).

---

## Task 0: Controller pre-steps (no PR)

Controller only. Supabase MCP on project `iyvtbjjxdggiadzwwvdj`. Nothing here is written to the repo.

- [ ] **Step 1: Recipients, read (controller, Supabase MCP, read-only).** `select id, name, coalesce(array_length(churn_digest_recipients,1),0) as n from locations where membership_source = 'un1t_online'`. Report `n` to Richard, not the addresses. Expected: exactly one row (Hatch Street).
- [ ] **Step 2: Recipients, set (controller, Supabase MCP `execute_sql`, write).** `update locations set churn_digest_recipients = array['<Richard's address, typed by the controller from the user context>'] where id = '<Hatch id from Step 1>'`. Spec §7 / G8: done first because the briefing's triage email already goes to this list.
- [ ] **Step 3: Recipients, read back (controller, read-only).** Same select as Step 1 plus `churn_digest_recipients = array['<address>']` as a boolean. Expected: `n = 1`, boolean true. Report only "1 address, matches".
- [ ] **Step 4: Renewal-cliff check (controller, Supabase MCP, read-only).** On Stillorgan's `contacts` with `glofox_membership_status='member'` and `glofox_membership_type='time'`, bucket `glofox_membership_expiry - now()` (null / ≤31 days / >31 days) by `glofox_billing_interval`. Decision for Task 2's `RENEWAL_EXPIRY_RULE`: rolling monthly plans carry a next-charge expiry → `'period_end'`; rolling plans mostly null → `'cancelling_or_long'`. Record the counts and the choice; it goes in PR 1's body.
- [ ] **Step 5: Subscription status check (controller, read-only).** At Hatch: `select status, count(*) from un1t_subscriptions where location_id = '<Hatch>' group by 1`, and the latest five `un1t_sync_runs.counts->'history'` at Hatch. Record the distinct statuses and whether cancelled rows are returned by `/subscriptions`; it goes in PR 1's body and Task 3's shape-module header.

---

## PR 1: `UN1TRADAR.1` (branch `un1t-radar-seam`)

### Task 1: Seam keys, `radarReadsFor` and Glofox pass-throughs

**Files:**
- Modify: `src/lib/membership/reads/index.js` (`READ_KEYS`, new `radarReadsFor`)
- Modify: `src/lib/membership/reads/glofox.js`
- Modify: `src/lib/churn-radar-data.js` (export `fetchWinbackContacts`)
- Modify: `src/lib/lead-radar-data.js` (export `fetchNonMembers`)
- Test: `src/lib/membership/reads/index.test.js`, `src/lib/membership/reads/glofox.test.js`

**Interfaces:**
- Consumes: `membershipStateForPage(db, locationId)`, `MEMBERSHIP_SOURCES`, `MEMBERSHIP_SOURCE_UNREADABLE`, `READS_BY_SOURCE`.
- Produces:
  - `READ_KEYS` gains `'radarMembers', 'winbackContacts', 'leadContacts', 'radarPastDue'`.
  - `radarReadsFor(db, locationId) → Promise<{ source: string, reads: object, providesMemberships: boolean, pinArrears: boolean }>`. Resolves by SOURCE KEY in any state (`configured`, `unconfigured`, `unknown` with a known source). `reads` = `READS_BY_SOURCE[source]`, else `noneReads`. `providesMemberships` = `MEMBERSHIP_SOURCES[source]?.capabilities?.memberships === true` (the static table, as `locationIdsWithoutCapability` reads it). `pinArrears` = `reads.pinArrears === true`. Throws `Error` with `.code = MEMBERSHIP_SOURCE_UNREADABLE` when the source key itself is unreadable (`source` null).
  - Adapter read signatures (every adapter): `radarMembers(db, locationId, { nowMs }) → Promise<Row[]>`, `winbackContacts(db, locationId, { nowMs }) → Promise<Row[]>`, `leadContacts(db, locationId, { nowMs }) → Promise<LeadRow[]>`, `radarPastDue(db, locationId, { nowMs }) → Promise<{ ids, byId, membershipById, chargesById, pendingById, unavailable?: string[], profileById?: Map }>`. All throw on failure.
  - `glofoxReads.radarMembers → fetchMembers`, `winbackContacts → fetchWinbackContacts`, `leadContacts → fetchNonMembers`, `radarPastDue → fetchPastDue`, each as a rest-args arrow (`(...args) => fn(...args)`, the file's style; call-time resolution also makes the `churn-radar-data → reads/index → registry → glofox → churn-radar-data` import cycle safe).

- [ ] **Step 1: Confirm spec A's interfaces exist on `origin/main`**

Run: `git grep -n -E "pipelineInputs|shapePipelineSnapshot|freshCutoff|pastDue" origin/main -- src/lib/membership/reads/`
Expected: each of the four names is defined. If any is missing or named differently, stop and report to the controller (do not invent it).

- [ ] **Step 2: Write the failing tests**

```js
// index.test.js
it('radarReadsFor resolves by source key while unconfigured', async () => {
  // membershipStateForPage mocked → { source: 'glofox', state: 'unconfigured', capabilities: { memberships: true } }
  const r = await radarReadsFor(db, 'loc-1')
  expect(r.source).toBe('glofox'); expect(r.reads).toBe(READS_BY_SOURCE.glofox); expect(r.providesMemberships).toBe(true)
})
it('radarReadsFor resolves un1t_online with providesMemberships false today', ...)  // capability false in sources/un1t-online.js
it('radarReadsFor throws MEMBERSHIP_SOURCE_UNREADABLE when the source key is unreadable', async () => {
  // → { source: null, state: 'unknown' }
  await expect(radarReadsFor(db, 'loc-1')).rejects.toMatchObject({ code: 'MEMBERSHIP_SOURCE_UNREADABLE' })
})
it('READ_KEYS lists the four radar keys', () => expect(READ_KEYS).toEqual(expect.arrayContaining(['radarMembers','winbackContacts','leadContacts','radarPastDue'])))
// glofox.test.js — extend the existing forwarding table
it.each(['radarMembers','winbackContacts','leadContacts','radarPastDue'])('%s forwards every argument and returns the value untouched', ...)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/membership/reads/index.test.js src/lib/membership/reads/glofox.test.js`
Expected: FAIL (`radarReadsFor is not a function`, missing keys).

- [ ] **Step 4: Implement** `READ_KEYS`, `radarReadsFor`, the four Glofox entries; add `export` to `fetchWinbackContacts` and `fetchNonMembers` (bodies unchanged).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/membership/reads/ src/lib/churn-radar-data.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/membership/reads/index.js src/lib/membership/reads/glofox.js src/lib/churn-radar-data.js src/lib/lead-radar-data.js src/lib/membership/reads/index.test.js src/lib/membership/reads/glofox.test.js
git commit -m "UN1TRADAR.1 — radar read keys + radarReadsFor (source key, any state) + Glofox pass-throughs"
```

### Task 2: Pure un1t radar member shape

**Files:**
- Create: `src/lib/membership/reads/un1t-online-radar-shape.js`
- Modify: `src/lib/membership/reads/un1t-online-shape.js` (extract `packHolderIds` from `shapeCounts`)
- Test: `src/lib/membership/reads/un1t-online-radar-shape.test.js`, `src/lib/membership/reads/un1t-online-shape.test.js`

**Interfaces:**
- Consumes: `MEMBER_STATUSES` (`['active','past_due']`), `glofoxInterval`, `isTrialProduct` from `un1t-online-shape.js`.
- Produces:
  - `packHolderIds({ subs, clients, packTxs, products }) → Set<un1tUserId>` exported from `un1t-online-shape.js`; `shapeCounts` uses it (its output unchanged).
  - `RENEWAL_EXPIRY_RULE` = `'period_end'` or `'cancelling_or_long'` (value from Task 0 Step 4).
  - `expiryFor(sub, rule = RENEWAL_EXPIRY_RULE) → string|null`: `'period_end'` → `current_period_end`; `'cancelling_or_long'` → `current_period_end` only when `cancel_at_period_end === true` or the plan period exceeds one month, else null.
  - `pickLiveMembership(subsForUser, nowMs) → { sub, cancelling: boolean, paused: boolean } | null`: live = status in `MEMBER_STATUSES`; `sub` = highest monthly-normalised price; `cancelling` = every live sub has `cancel_at_period_end`; `paused` = every live sub has `paused_at` and `paused_until` null or > now.
  - `shapeRadarMembers({ subs, clients, packTxs, products, contactsById, events, bookings, newestBookingAtByUser, lastPaymentAtByUser, nowMs }) → { rows: Row[], members: number, packHolders: number, unlinkedClients: number, skippedEvents: number }`. `Row` keys exactly as spec §2 table: `id, name, glofox_membership_status, glofox_membership_type, glofox_membership_plan, glofox_membership_state, glofox_membership_expiry, glofox_membership_price_cents, glofox_billing_interval, trial_credits_remaining, last_attended_at, last_booked_at, total_attended_30d, total_noshow_30d, total_attended_7d, total_bookings_30d, last_payment_at, joined_at, lifetime_value_cents, person_group_id (always null), cancel_at_period_end`.
  - Header comment states: `glofox_` key names are the scorer's contract; statuses compared lowercase (`booked`, `cancelled`, `attended`, `no_show`); never the uppercase Glofox constants.

- [ ] **Step 1: Write the failing tests** (one `it` per mapping-table row, plus):

```js
it('live sub maps to member/time with plan, price and glofoxInterval', () => {
  const { rows } = shapeRadarMembers(fx({ subs: [sub({ product_title: 'Unlimited', price_cents: 12000, billing_interval: 'month', billing_interval_count: 3 })] }))
  expect(rows[0]).toMatchObject({ glofox_membership_status: 'member', glofox_membership_type: 'time', glofox_membership_plan: 'Unlimited', glofox_membership_price_cents: 12000, glofox_billing_interval: '3 months' })
})
it('pack holder set is identical to shapeCounts', () => {
  const input = fx({ /* subs, clients, packTxs, products incl. a €0 pack and a trial */ })
  const holders = new Set(shapeRadarMembers(input).rows.filter(r => r.glofox_membership_status === 'credit_member').map(r => userOf(r)))
  expect(holders).toEqual(packHolderIds(input)); expect(holders.size).toBe(shapeCounts(input).class_packs)
})
it('€0 pack never becomes a holder; "The UN1T Trial" plan is kept so NON_MEMBER_PLAN_RE drops it', ...)
it('two live subs: plan from the dearest monthly price; cancelling only when both cancel', ...)
it('paused when every live sub is paused and paused_until is null or future', ...)
it('cancel_at_period_end true → row.cancel_at_period_end true', ...)
it('unlinked client (contact_id null) excluded and counted in unlinkedClients', ...)
it('shapeRadarMembers ignores contacts.glofox_* on a dual-studio contact', () => {
  // contactsById: { c1: { name: 'A', glofox_membership_status: 'member', glofox_membership_plan: 'Stillorgan Gold', last_attended_at: '2026-10-16T…' } }
  expect(rows[0].glofox_membership_plan).toBe('Hatch plan'); expect(rows[0].last_attended_at).toBe(un1tClient.last_attended_at)
})
it('total_attended_7d boundary: event at now-7d counts, at now-7d-1ms does not', ...)
it('null starts_at excluded and counted in skippedEvents', ...)
it('statuses compared lowercase: "attended" counts, "ATTENDED" does not', ...)
it('total_bookings_30d excludes cancelled', ...)
it('expiryFor period_end vs cancelling_or_long', () => {
  expect(expiryFor(monthly, 'period_end')).toBe(monthly.current_period_end)
  expect(expiryFor(monthly, 'cancelling_or_long')).toBeNull()
  expect(expiryFor({ ...monthly, cancel_at_period_end: true }, 'cancelling_or_long')).toBe(monthly.current_period_end)
  expect(expiryFor(annual, 'cancelling_or_long')).toBe(annual.current_period_end)
})
```
In `un1t-online-shape.test.js`: `shapeCounts output unchanged after packHolderIds extraction` (deep-equal against the existing fixtures' current outputs).

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/lib/membership/reads/un1t-online-radar-shape.test.js src/lib/membership/reads/un1t-online-shape.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `packHolderIds` (moved verbatim out of `shapeCounts`), then the shape module. `total_attended_30d` / `total_noshow_30d` from `un1t_clients.bookings_30d_attended` / `bookings_30d_no_show` (Claude's call 13); `trial_credits_remaining` = `credit_balance`; `joined_at` = `remote_created_at`; `lifetime_value_cents` = `ltv_cents`.

- [ ] **Step 4: Run to verify pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/membership/reads/un1t-online-radar-shape.js src/lib/membership/reads/un1t-online-radar-shape.test.js src/lib/membership/reads/un1t-online-shape.js src/lib/membership/reads/un1t-online-shape.test.js
git commit -m "UN1TRADAR.1 — pure un1t radar member shape (scorer row contract); packHolderIds shared with shapeCounts"
```

### Task 3: Pure win-back shape

**Files:**
- Modify: `src/lib/membership/reads/un1t-online-radar-shape.js`
- Test: `src/lib/membership/reads/un1t-online-radar-shape.test.js`

**Interfaces:**
- Consumes: `shapeRadarMembers`, `pickLiveMembership` (Task 2).
- Produces: `shapeWinbackRows({ ...shapeRadarMembers input, allSubs, freshCutoffIso, endedMemberships, nowMs }) → Row[]`: the live rows from `shapeRadarMembers` plus `ex_member` rows. `endedMemberships` = `contact_memberships` rows at L with `status='ended'`, `source IN ('un1t_online_api','un1t_online_export')`, `{ contact_id, plan_name, ended_at }`.
- Ex-member rule (spec §2b, Claude's call 4): no live subscription AND no pack credits now, AND any of (i) a sub whose status is not in `['active','past_due','trialing']`, (ii) an `active` sub with `synced_at < freshCutoffIso`, (iii) an ended membership row. Plan/price from the newest sub row, else `plan_name`. Header comment records Task 0 Step 5's distinct statuses.

- [ ] **Step 1: Write the failing tests**

```js
it('ex_member from a non-live subscription row', ...)          // status 'cancelled' → glofox_membership_status 'ex_member'
it('ex_member from a stale-active row', ...)                   // status 'active', synced_at before freshCutoffIso
it('ex_member from an ended export row, plan from plan_name', ...)
it('a current member with an ended export row is NOT an ex_member', () => {
  // live sub + ended un1t_online_export row (the mig 728 case)
  expect(rows.find(r => r.id === 'c1').glofox_membership_status).toBe('member')
})
it('a pack holder with credits is not an ex_member', ...)
it('trialing-only history is not ex_member evidence', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/membership/reads/un1t-online-radar-shape.test.js` → FAIL.
- [ ] **Step 3: Implement `shapeWinbackRows`.**
- [ ] **Step 4: Run to verify pass.** Same command → PASS.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.1 — un1t win-back rows: non-live, stale-active and ended-membership evidence after the live check"`

### Task 4: Pure lead-row shape (spec A's snapshot)

**Files:**
- Modify: `src/lib/membership/reads/un1t-online-radar-shape.js`
- Test: `src/lib/membership/reads/un1t-online-radar-shape.test.js`

**Interfaces:**
- Consumes: A's `pipelineInputs` `data` (`{ contacts, snapshots }`) and `shapePipelineSnapshot`; `NON_MEMBER_STATUSES` from `src/lib/lead-radar.js`.
- Produces: `shapeLeadRows({ pipeline: { contacts, snapshots }, contactsById, ownedWithoutClient, newestBookingAtByContact }) → LeadRow[]`. `LeadRow` keys = `lead-radar-data.js` `CONTACT_COLUMNS`: `id, name, email, phone, glofox_membership_status, last_attended_at, last_booked_at, joined_at, lead_source`.
  - Status from the snapshot unchanged; rows whose status is not in `NON_MEMBER_STATUSES` are dropped (members, credit members, ex-members out).
  - A snapshot with `gympass_member_id` set → `glofox_membership_status: 'classpass_payg'` on the lead row only (routes it to `buildClassPass`, matching the board's Gympass pile; the scorer is unchanged).
  - `joined_at`, `last_attended_at` from the snapshot; `last_booked_at` from `newestBookingAtByContact`; `email/phone/lead_source/name` from `contactsById`.
  - `ownedWithoutClient` (contacts with `location_id = L` and no `un1t_clients` row at L) → `glofox_membership_status: 'lead'`, `joined_at` = `contacts.joined_at ?? contacts.created_at` (Claude's call 5).
  - Never reads `contacts.glofox_membership_status` (G1).

- [ ] **Step 1: Write the failing tests**

```js
it('same status as A\'s snapshot for every shared un1t client fixture', () => {
  const snapshots = new Map(fixtures.map(f => [f.contactId, shapePipelineSnapshot(f.input)]))
  for (const r of shapeLeadRows({ pipeline: { contacts, snapshots }, ... })) {
    const s = snapshots.get(r.id)
    if (s.gympass_member_id) expect(r.glofox_membership_status).toBe('classpass_payg')
    else expect(r.glofox_membership_status).toBe(s.glofox_membership_status)
  }
})
it('a Stillorgan member with no Hatch membership is a Hatch lead or trial', ...)  // contactsById has glofox_membership_status 'member'
it('trial comes from the trial purchase or D\'s op=trial ledger row, not the credit balance', ...) // via shapePipelineSnapshot fixtures
it('aggregator booking (source not direct, or external_member_ref) → classpass view', ...)
it('owned contact with no un1t client → lead, joined_at falls back to created_at', ...)
it('member, credit_member and ex_member snapshots are not lead rows', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/membership/reads/un1t-online-radar-shape.test.js` → FAIL.
- [ ] **Step 3: Implement `shapeLeadRows`.**
- [ ] **Step 4: Run to verify pass.** → PASS.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.1 — un1t lead rows from spec A's pipeline snapshot (one status per person on board and radar)"`

### Task 5: un1t radar I/O module

**Files:**
- Create: `src/lib/membership/reads/un1t-online-radar.js`
- Modify: `src/lib/membership/reads/un1t-online.js` (add `radarMembers`, `winbackContacts`, `leadContacts` to `un1tOnlineReads`)
- Test: `src/lib/membership/reads/un1t-online-radar.test.js`

**Interfaces:**
- Consumes: Tasks 2-4 shape functions; A's `freshCutoff(db, table, locationId)` and `un1tOnlineReads.pipelineInputs`; `selectAll`; `logInfo`.
- Produces: `radarMembers(db, locationId, { nowMs = Date.now() } = {})`, `winbackContacts(...)`, `leadContacts(...)`, each `Promise<Row[]>`, throwing on any failed read or a `pipelineInputs` `success:false`.
- Reads (all `.eq('location_id', L)`, `.order(...).range()` via `selectAll`, reads only): fresh live subscriptions (`un1t_user_id, contact_id, status, product_id, product_title, price_cents, billing_interval, billing_interval_count, current_period_end, cancel_at_period_end, paused_at, paused_until, past_due_at, remote_created_at`, `synced_at >= freshCutoff`); `un1t_clients` (all at L); pack transactions + products (as `shapeCounts`); subscription payments (`type IN ('sub_initial','sub_renewal')`, `amount_cents > 0`, `refunded` not true); `un1t_events` with `starts_at` in [now − 30d, now]; `un1t_bookings` for those `un1t_id`s chunked ≤200; newest `un1t_bookings.remote_created_at` per user; `contacts` by id for `name` (chunked ≤300) and, for leads, `email, phone, lead_source, joined_at, created_at`; for leads, contacts with `location_id = L` (owned) to find `ownedWithoutClient`.
- Build log: `logInfo('churn-radar', 'un1t radar built', { locationId, members, packHolders, unlinkedClients, pinned: 0 })` (`pinned` filled in Task 14).

- [ ] **Step 1: Write the failing tests** (chainable mock db recording table, filters and ranges)

```js
it('every un1t_* query filters location_id = L and reads only', ...)   // no insert/update/delete called
it('radarMembers pages past 1000 clients', ...)                           // 1001 rows across two ranges → 1001 inputs
it('bookings read chunks event ids at 200', ...)                          // 450 events → 3 .in() calls
it('radarMembers drops a subscription older than freshCutoff', ...)
it('radarMembers keeps all rows when the sync stalled', ...)              // freshCutoff relative to newest synced_at
it('a failed page throws (never an empty radar)', async () => { await expect(radarMembers(errDb, 'L')).rejects.toThrow() })
it('leadContacts throws when pipelineInputs returns success:false', ...)
it('build log carries counts and locationId only', ...)                  // no name/email in meta
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/membership/reads/un1t-online-radar.test.js` → FAIL.
- [ ] **Step 3: Implement the module and register the three reads on `un1tOnlineReads`.**
- [ ] **Step 4: Run to verify pass.** `npx vitest run src/lib/membership/reads/` → PASS. Then `npm run check:select-columns` → green (every selected column exists in mig 726 / 722 / contacts).
- [ ] **Step 5: Commit** `git add src/lib/membership/reads/ && git commit -m "UN1TRADAR.1 — un1t radar I/O: members, win-back, leads (location-scoped, paginated, throws on failure)"`

### Task 6: Radar data layers read through the seam

**Files:**
- Modify: `src/lib/churn-radar-data.js` (`loadRadar`, `loadQuarantine`, `loadArrearsRows`, `loadWinback`)
- Modify: `src/lib/lead-radar-data.js` (`loadFunnel`, `loadCleanup`, `loadClassPass`)
- Modify: `src/lib/engagement-analytics-data.js:55-59`
- Test: `src/lib/churn-radar-data.test.js`, Create: `src/lib/lead-radar-data.test.js`

**Interfaces:**
- Consumes: `radarReadsFor` (Task 1).
- Produces: every existing export keeps its signature. Row fetches become `reads.radarMembers(db, L, { nowMs })`, `reads.winbackContacts(...)`, `reads.leadContacts(...)`, `reads.radarPastDue(...)`. A missing key on the resolved adapter throws `Error('radar read missing: <key>')` (un1t lacks `radarPastDue` until PR 2; every Hatch caller is gated). `applyPersonRollup` is untouched (it already returns early without `person_group_id`).

- [ ] **Step 1: Write the failing tests**

```js
it('Glofox: loadRadar output deep-equals today\'s for the existing fixtures', ...)   // capture current output first, assert toEqual
it('dispatches by source key in every state', ...)        // configured / unconfigured / unknown-with-source → same adapter called
it('unreadable source throws MEMBERSHIP_SOURCE_UNREADABLE', ...)
it('Glofox adapter receives (db, locationId, { nowMs })', ...)
it('un1t adapter without radarPastDue makes loadRadar throw "radar read missing: radarPastDue"', ...)
// lead-radar-data.test.js
it('loadFunnel reads leadContacts from the resolved adapter', ...)
it('loadClassPass and loadCleanup use the same read', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/churn-radar-data.test.js src/lib/lead-radar-data.test.js` → FAIL.
- [ ] **Step 3: Implement** the swaps (one `const r = await radarReadsFor(db, locationId)` per loader, then the keyed calls).
- [ ] **Step 4: Run to verify pass.** `npx vitest run src/lib/churn-radar-data.test.js src/lib/lead-radar-data.test.js src/lib/engagement-analytics.test.js src/lib/churn-radar.test.js` → PASS.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.1 — churn/lead/engagement data read rows through the seam; Glofox output identical"`

### Task 7: Read APIs gated, with `source` and `dataAsOf`

**Files:**
- Create: `src/lib/radar-availability.js`
- Modify: `src/app/api/churn-radar/route.js`, `winback/route.js`, `overdue/route.js`, `unpaid-charges/route.js`, `awaiting-authorization/route.js`, `quarantine/route.js` (GET only); `src/app/api/lead-radar/route.js`, `classpass/route.js`, `cleanup/route.js` (GET only); `src/app/api/mobile/radar/route.js`; `src/lib/today-feed-data.js` (`fetchChurn`)
- Test: Create `src/lib/radar-availability.test.js`, `src/app/api/churn-radar/route.availability.test.js`, `src/app/api/mobile/radar/route.availability.test.js`; extend `src/lib/today-feed-data.test.js`

**Interfaces:**
- Consumes: `radarReadsFor`.
- Produces:
  - `radarAvailability(db, locationId, { module }) → Promise<{ available: boolean, source: string|null, dataAsOf: string|null }>`. Unavailable when `!providesMemberships`; logs once per call `logInfo(module, 'radar skipped: source lacks memberships', { locationId, source })`. `dataAsOf` = newest `un1t_sync_runs.finished_at` with `status='ok'` at L for `un1t_online`, else null (decided: `un1t_sync_runs`, not the registry row).
  - `RADAR_UNAVAILABLE = Object.freeze({ success: true, data: null, unavailable: 'memberships' })`.
  - `syncDataAsOf(db, locationId) → Promise<string|null>`: the `dataAsOf` reader, exported (Task 18 uses it).
  - Route GET bodies: unavailable → `RADAR_UNAVAILABLE` (200); available → `{ success: true, data, source, dataAsOf }` (`data` unchanged). The check runs before `radarCache`.
  - `/api/mobile/radar`: unavailable section → `null`; `fetchChurn` returns `null`.

- [ ] **Step 1: Write the failing tests**

```js
it('capability false → { success:true, data:null, unavailable:"memberships" } and one skip log', ...)
it('Glofox location → data identical to loadRadar, source "glofox", dataAsOf null', ...)
it('dataAsOf is the newest ok un1t_sync_runs.finished_at', ...)
it('mobile radar returns churn:null and lead:null at a source without memberships', ...)
it('today-feed churn is null at a source without memberships', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/radar-availability.test.js src/app/api/churn-radar/route.availability.test.js src/app/api/mobile/radar/route.availability.test.js src/lib/today-feed-data.test.js` → FAIL.
- [ ] **Step 3: Implement** the helper and the route changes.
- [ ] **Step 4: Run to verify pass.** Same command → PASS. Then `npm run check:route-guards && npm run check:location-scoping` → green.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.1 — radar read APIs answer data:null + skip log when the source lacks memberships; source + dataAsOf beside data"`

### Task 8: Ship PR 1

- [ ] **Step 1: CI mirror + build.** Run the thirteen-command mirror from Global Constraints, then `npm run build`. Expected: all green.
- [ ] **Step 2: Push and open.** `git push -u origin HEAD && gh pr create --base main --title "UN1TRADAR.1 — Hatch radar: seam dispatch + un1t radar adapter (read APIs gated)" --body-file <tmp>`. Body: what, Task 0 Steps 4-5 results (counts only), "Stillorgan unchanged" evidence, mergeable once A's HATCHPIPE.2 is on main (nothing visible at Hatch). End with the attribution line.
- [ ] **Step 3: Changelog.** Create `docs/changelog/entries/<PR>.md` with one row `| #<PR> | UN1TRADAR.1 — … | 2026-MM-DD. … |`; `npx vitest run tests/changelog-entries.test.js` → PASS; commit `UN1TRADAR.1 — changelog entry`, push.
- [ ] **Step 4: Preview identity check (controller, browser, read-only).** On the Vercel preview and on production, as the same staff session at Stillorgan, fetch `/api/churn-radar`, `/api/churn-radar/winback`, `/api/churn-radar/overdue`, `/api/lead-radar` within the same minute; diff the `data` objects. Expected: identical. At Hatch on the preview: each answers `data:null, unavailable:"memberships"`.

---

## PR 2: `UN1TRADAR.2` (branch `un1t-radar-arrears-pulse`, after PR 1 merges; merge only once A's `HATCHINV.1` is live)

### Task 9: `radarPastDue` fold and the un1t `arrears` read

**Files:**
- Modify: `src/lib/membership/reads/un1t-online-radar-shape.js` (`foldPastDue`, `arrearsFromFold`)
- Modify: `src/lib/membership/reads/un1t-online-radar.js` (`radarPastDue`, `arrears`)
- Modify: `src/lib/membership/reads/un1t-online.js` (register both; add `pinArrears: true` to the frozen adapter; replace the header's "There is no `arrears`" paragraph)
- Test: `src/lib/membership/reads/un1t-online-radar-shape.test.js`, `src/lib/membership/reads/un1t-online-radar.test.js`

**Interfaces:**
- Consumes: A's `un1tOnlineReads.pastDue(db, L)`.
- Produces:
  - `foldPastDue(rows, { priceBySubscriptionId: Map, lastAttendedByUser: Map }) → { ids: Set, byId: Map, membershipById: Map, chargesById: Map(empty), pendingById: Map(empty), unavailable: ['unpaidCharges','awaitingAuth'], profileById: Map<contactId, { glofox_membership_status:'member', glofox_membership_type:'time', glofox_membership_plan, last_attended_at }> }`. Each agg `{ amountCents, count, oldestDueAt: since, amountEstimated?: true }`; a null `amountCents` uses `priceBySubscriptionId.get(subscriptionId)` and sets `amountEstimated: true`. Multiple rows for one contact sum.
  - `radarPastDue(db, L, { nowMs })`: calls A's `pastDue`, throws on `success:false`, reads `un1t_subscriptions (un1t_id, price_cents)` for the row ids and `un1t_clients (un1t_user_id, last_attended_at)` for the users (chunked ≤200), returns `foldPastDue(...)`.
  - `arrearsFromFold(fold) → { totalCents, memberCount, estimated: boolean }`; `arrears(db, L) → { success:true, data } | { success:false, error }` (same envelope as `fetchArrearsSummary`, `shared/dashboard-data.js:570`).
  - `profileById` exists because `buildOverdue` reads plan and last-attended from contact rows, which for a dual-studio contact are Stillorgan's (Review Focus 1).

- [ ] **Step 1: Write the failing tests**

```js
it('folds A\'s rows into fetchPastDue\'s Map shape', () => {
  const f = foldPastDue([pd({ contactId: 'c1', amountCents: 4500, since: '2026-10-01' })], deps)
  expect(f.ids).toEqual(new Set(['c1'])); expect(f.membershipById.get('c1')).toEqual({ amountCents: 4500, count: 1, oldestDueAt: '2026-10-01' })
  expect(f.chargesById.size).toBe(0); expect(f.pendingById.size).toBe(0); expect(f.unavailable).toEqual(['unpaidCharges','awaitingAuth'])
})
it('null amount becomes the subscription price with amountEstimated', ...)
it('two rows for one contact sum and keep the earliest since', ...)
it('radarPastDue throws on success:false (never "nobody owes")', ...)
it('arrears: totals, member count and estimated flag', ...)
it('un1tOnlineReads exposes radarPastDue, arrears and pinArrears true', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/membership/reads/` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.** Same → PASS; `npm run check:select-columns` → green.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.2 — un1t radarPastDue + arrears on spec A's pastDue (estimate when amount unreported)"`

### Task 10: Radar summary and Overdue rows honour `unavailable` and estimates

**Files:**
- Modify: `src/lib/churn-radar-data.js` (`loadRadar` summary, `loadArrearsRows`, `loadOverdue`, `loadUnpaidCharges`, `loadAwaitingAuth`)
- Modify: `src/lib/churn-radar.js` (`buildOverdue`: pass `amountEstimated` through only when true)
- Test: `src/lib/churn-radar-data.test.js`, `src/lib/churn-radar.test.js`

**Interfaces:**
- Consumes: `radarPastDue` result (Task 9).
- Produces:
  - Summary keys when `unavailable` lists them: `unpaidCharges: null, unpaidChargesValueCents: null, awaitingAuth: null, awaitingAuthValueCents: null`; `overdueValueEstimated: true` only when some counted agg is estimated (key absent otherwise, so Glofox JSON is unchanged).
  - `loadUnpaidCharges` / `loadAwaitingAuth` at such a source → `{ charges: [], summary: { total: null, totalValueCents: null, unavailable: true } }`.
  - `loadArrearsRows` overlays `profileById` onto the `fetchContactsByIds` rows (name stays from `contacts`).
  - `buildOverdue` row gains `amountEstimated: true` only when the agg has it.

- [ ] **Step 1: Write the failing tests**

```js
it('Glofox: loadOverdue/loadUnpaidCharges/loadAwaitingAuth deep-equal today\'s output', ...)
it('un1t: summary unpaidCharges and awaitingAuth are null, never 0', ...)
it('un1t: estimated overdue row carries amountEstimated and the summary overdueValueEstimated', ...)
it('overdue row at a un1t studio takes plan and last attended from un1t, not contacts', ...)
it('buildOverdue omits amountEstimated when the agg lacks it', () => expect(Object.hasOwn(buildOverdue([c], now, { pastDueById: m })[0], 'amountEstimated')).toBe(false))
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/churn-radar-data.test.js src/lib/churn-radar.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.** → PASS.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.2 — radar summary: unreadable arrears are null, estimates flagged; Overdue rows use un1t profile"`

### Task 11: Renderers say "not available" and label estimates

**Files:**
- Create: `src/lib/radar-copy.js`
- Modify: `src/components/ChurnRadar.jsx` (stat card, tab labels at `:283`, `:313`, `:315`, Overdue row amount; `dataAsOf` line "un1t.online data as of HH:MM")
- Modify: `src/lib/churn-radar-digest.js` (`buildDigestEmail`)
- Modify: `src/app/dashboard/business/page.js:96-98` (In arrears sublabel), `src/lib/dashboard/business-rail.js` (`arrearsRow` via `radarReadsFor(...).reads.arrears`)
- Test: Create `src/lib/radar-copy.test.js`, `src/lib/dashboard/business-rail.test.js`; extend `src/lib/churn-radar-digest.test.js`, `src/app/dashboard/business/page.test.js`

**Interfaces:**
- Produces (`src/lib/radar-copy.js`, pure):
  - `UN1T_UNAVAILABLE = 'not available from un1t.online'`
  - `countOrUnavailable(n) → string` (`null` → `UN1T_UNAVAILABLE`, number → its string)
  - `owedLabel(cents, { estimated }) → string` (`estimated` → `about €X (estimate: amount not reported by un1t.online)`)
  - `totalLabel(cents, { estimated }) → string` (`estimated` → `€X, includes an estimate`)
- Digest: when `summary.unpaidCharges === null`, one line `Unpaid charges and awaiting authorization: not available from un1t.online`; `Overdue value` row uses `totalLabel` when `overdueValueEstimated`.
- The briefing's copy changes live in Task 12 (they need the pulse bundle's new fields).
- Business card: `arrearsData.estimated` → sublabel `<n> members, includes an estimate`.
- Rail `arrearsRow`: reads through `radarReadsFor`; Glofox output unchanged; unsupported or failed → row omitted.

- [ ] **Step 1: Write the failing tests**

```js
it('countOrUnavailable(null) is "not available from un1t.online", never "0"', ...)
it('owedLabel estimate copy is exact', () => expect(owedLabel(4500, { estimated: true })).toBe('about €45 (estimate: amount not reported by un1t.online)'))
it('digest renders the not-available line and never "0" for null unpaid counts', ...)
it('digest Overdue value says "includes an estimate" when estimated', ...)
it('business In arrears sublabel carries "includes an estimate"', ...)
it('rail arrearsRow: Glofox text unchanged; un1t via the seam; unsupported → null', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/radar-copy.test.js src/lib/churn-radar-digest.test.js src/lib/dashboard/business-rail.test.js src/app/dashboard/business/page.test.js` → FAIL.
- [ ] **Step 3: Implement**; `ChurnRadar.jsx` uses the `radar-copy.js` helpers (no logic in JSX beyond the call).
- [ ] **Step 4: Run to verify pass.** Same → PASS.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.2 — unreadable arrears say 'not available from un1t.online'; estimates labelled on every total"`

### Task 11b: Phone estimate label (touches `mobile/`: OTA on merge)

**Files:**
- Modify: `src/app/api/mobile/radar/route.js` (churn section gains `overdueValueEstimated: true` only when the summary has it)
- Create: `mobile/lib/arrears-estimate-label.js`
- Modify: `mobile/app/(staff)/radar/index.jsx` (the `Overdue value` row, `:46`), `mobile/components/dashboard/BusinessDashboard.jsx:339-344` (In arrears sublabel)
- Test: Create `mobile/lib/arrears-estimate-label.test.js`; extend `src/app/api/mobile/radar/route.availability.test.js`

**Interfaces:**
- Consumes: `summary.overdueValueEstimated` (Task 10); `arrearsData.estimated` on `/api/dashboard/business` (already passed through from Task 9's `arrears` read; confirm the route copies `data` untouched).
- Produces (`mobile/lib/arrears-estimate-label.js`, pure, no imports from `src/`):
  - `ESTIMATE_NOTE = 'includes an estimate'`
  - `overdueValueNote(churn) → string|null`: `churn?.overdueValueEstimated === true` → `ESTIMATE_NOTE`, else null.
  - `arrearsSublabel(arrearsData) → string`: null → `'arrears unavailable'` (today's copy); else `<n> member(s)`, plus `, includes an estimate` when `estimated === true`. Stillorgan's text is byte-identical to today's.
- The radar screen renders `overdueValueNote` under the Overdue value row when non-null; the business dashboard uses `arrearsSublabel` in place of its inline ternary.

- [ ] **Step 1: Write the failing tests**

```js
it('arrearsSublabel matches today\'s copy when not estimated', () => {
  expect(arrearsSublabel({ totalCents: 9000, memberCount: 1 })).toBe('1 member')
  expect(arrearsSublabel(null)).toBe('arrears unavailable')
})
it('arrearsSublabel adds the estimate note', () => expect(arrearsSublabel({ totalCents: 9000, memberCount: 2, estimated: true })).toBe('2 members, includes an estimate'))
it('overdueValueNote only when flagged', () => { expect(overdueValueNote({})).toBeNull(); expect(overdueValueNote({ overdueValueEstimated: true })).toBe('includes an estimate') })
// route.availability.test.js
it('mobile radar carries overdueValueEstimated only when the summary has it', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run mobile/lib/arrears-estimate-label.test.js src/app/api/mobile/radar/route.availability.test.js` → FAIL.
- [ ] **Step 3: Implement** the helper, the route flag and the two render sites.
- [ ] **Step 4: Run to verify pass.** Same → PASS; then `npm run check:mobile-lint && npm run check:mobile-imports && npm run check:ota-paths` → green.
- [ ] **Step 5: Commit** `git add -A src mobile && git commit -m "UN1TRADAR.2 — phone labels estimated arrears (radar Overdue value, business In arrears); OTA accepted"`

### Task 12: Briefing pulse through the seam, 30-day comparator

**Files:**
- Modify: `src/lib/studio-pulse-data.js` (`fetchStudioPulse`, export `pickComparator`)
- Modify: `src/lib/morning-briefing.js` (`shapePulseMetrics`)
- Test: Create `src/lib/studio-pulse-data.test.js`; extend `src/lib/morning-briefing.test.js`

**Interfaces:**
- Consumes: `radarReadsFor` (counts via `r.reads.membershipCounts`), seam-aware `loadRadar`.
- Produces:
  - `pickComparator(db, table, dateCol, cols, locationId, monthStartIso, nowMs) → Promise<row|null>`: read the oldest row first; if it is younger than 30 days (`nowMs − oldest < 30 × 86_400_000`) return null; else today's rule (last row before month start, else oldest).
  - `fetchStudioPulse(db, locationId, nowMs)`: same bundle plus `radar.overdueValueEstimated` (boolean) and `radar.arrearsUnavailable` (true when the summary's `unpaidCharges` is null); still null on any failure.
  - `shapePulseMetrics`: overdue `sub` uses `totalLabel` (Task 11) when `overdueValueEstimated`; when `arrearsUnavailable`, one extra metric `{ key: 'arrears_unavailable', label: 'Unpaid charges and awaiting authorization', value: UN1T_UNAVAILABLE, delta: null }`.

- [ ] **Step 1: Write the failing tests**

```js
it('comparator null while the oldest row is under 30 days old', ...)          // oldest 2026-10-18, now 2026-11-16 → null
it('comparator returns the last row before the month at 30 days', ...)       // now 2026-11-17 → row
it('unchanged with June history (Stillorgan)', ...)                          // same row as today's rule
it('counts come from the resolved adapter\'s membershipCounts', ...)
it('returns null when the seam throws', ...)
// morning-briefing.test.js
it('briefing overdue sub labels an estimate', ...)
it('briefing shows "not available from un1t.online" for unreadable arrears, never 0', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/studio-pulse-data.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.** `npx vitest run src/lib/studio-pulse-data.test.js src/lib/morning-briefing.test.js` → PASS.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.2 — pulse counts via the seam; comparator hidden until a location has 30 days of snapshots"`

### Task 13: Migration NNN — delete Hatch's Glofox-shaped snapshot history

**Files:**
- Create: `supabase/migrations/NNN_hatch_drop_glofox_shaped_snapshots.sql`
- Test: Create `tests/hatch-snapshot-cleanup-migration.test.js` (text guard)

**Interfaces:**
- Consumes: nothing in code. Boundary date `'2026-10-18'` (confirmed in Step 1).
- Produces: DML only, one `DO $$ … $$` block:
  - `v_locs` = `locations where membership_source = 'un1t_online'`; RAISE EXCEPTION unless exactly 1.
  - RAISE EXCEPTION unless a `membership_snapshots` row exists at that location with `snapshot_date = boundary` (the first un1t-shaped row).
  - RAISE EXCEPTION if any `churn_radar_snapshots` or `lead_radar_snapshots` row there has `captured_at >= boundary`.
  - DELETE `churn_radar_snapshots` and `lead_radar_snapshots` at the location (all `< boundary`); DELETE `membership_snapshots` at the location with `snapshot_date < boundary`.
  - Post-check: RAISE EXCEPTION if any of the three still holds a row `< boundary` there. `RAISE NOTICE` the three deleted counts.
  - Header comment: spec §6 "Legacy rows", Claude's call 8, the eleven readers it fixes.

- [ ] **Step 1: Confirm the boundary (controller, Supabase MCP, read-only).** At Hatch: `select snapshot_date, monthly_recurring, class_packs, payg, total_members from membership_snapshots where location_id = '<Hatch>' order by snapshot_date desc limit 5` and `select max(captured_at) from churn_radar_snapshots …` / `lead_radar_snapshots …`. Expected: newest `membership_snapshots` row dated 2026-10-18 whose counts equal the un1t adapter's `membershipCounts` (compare to the business page's Total members); radar tables' max ≤ 2026-10-05. If the first un1t row is not 2026-10-18, give the implementer the confirmed date.
- [ ] **Step 2: Write the failing guard test**

```js
it('migration is DML only, scoped by membership_source, self-checking', () => {
  const sql = readMigration(/hatch_drop_glofox_shaped_snapshots/)
  expect(sql).toMatch(/membership_source\s*=\s*'un1t_online'/)
  expect(sql).toMatch(/RAISE EXCEPTION/g); expect(sql).toMatch(/RAISE NOTICE/)
  expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|GRANT|REVOKE)\b/i)
  expect(sql).toMatch(/2026-10-18/)
})
```

- [ ] **Step 3: Run to verify fail.** `npx vitest run tests/hatch-snapshot-cleanup-migration.test.js` → FAIL.
- [ ] **Step 4: Write the migration.**
- [ ] **Step 5: Run to verify pass.** Same → PASS; `npm run check:bundle-sql` → green.
- [ ] **Step 6: Commit** `git add supabase/migrations/NNN_hatch_drop_glofox_shaped_snapshots.sql tests/hatch-snapshot-cleanup-migration.test.js && git commit -m "UN1TRADAR.2 — mig NNN: delete Hatch's Glofox-shaped snapshot history (self-checking DML)"`
- [ ] **Step 7: Apply (controller).** Controller applies via Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj`, then `get_advisors` security (expected: no new findings). Then re-read (controller, Supabase MCP, read-only) Hatch's three tables: only rows `>= 2026-10-18` remain; NOTICE counts recorded in the PR body.

### Task 14: Ship PR 2

- [ ] **Step 1:** CI mirror + `npm run build` → green.
- [ ] **Step 2:** `git push -u origin HEAD && gh pr create --base main --title "UN1TRADAR.2 — Hatch arrears via spec A's pastDue, pulse comparator, legacy snapshot cleanup"`. Body states: **this PR publishes an OTA** (Task 11b, `mobile/lib` + two screens; coordinator-accepted); merge only once A's `HATCHINV.1` is live; on merge Hatch's business "In arrears" card and rail row light up through `supportsRead(m,'arrears')` (before the flip; consistent with A's invoices flip being live); migration applied + advisor result.
- [ ] **Step 3:** Changelog entry file, `npx vitest run tests/changelog-entries.test.js`, commit, push.
- [ ] **Step 4: Preview check (controller, browser, read-only).** Stillorgan's business "In arrears" card, rail row and `/api/churn-radar/overdue` identical to production; Hatch's business card shows A's past-due total (or `€0 · 0 members` if none is past due, which is real data from A's read).

---

## PR 3: `UN1TRADAR.3` (branch `un1t-radar-pins-actions`; see the PR map for the PR 2 code dependency)

### Task 15: Cancelling detector and pinned sort

**Files:**
- Modify: `src/lib/churn-radar.js` (`detectCancelling`, wire into `scoreMember`, `buildRadar` sort)
- Test: `src/lib/churn-radar.test.js`

**Interfaces:**
- Produces: `detectCancelling(contact, nowMs) → signal|null`: fires when `contact.cancel_at_period_end === true`; signal `{ key:'cancelling', label:'Cancelling', detail:'Membership ends on <date>', weight:6, severity:'critical', pin:true }`, `<date>` = `glofox_membership_expiry` formatted like other details (`en-IE`, day month). `buildRadar` first sort key: rows with any `pin` signal first.

- [ ] **Step 1: Write the failing tests**

```js
it('cancelling signal makes the tier high and pins the row first', ...)   // a weight-6 row sorts above a score-7 unpinned row
it('existing Glofox fixtures produce identical buildRadar and radarSummary output', ...) // toEqual against captured current output
it('a past-due cancelling member classifies overdue and never scores cancelling', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/churn-radar.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.** → PASS.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.3 — Cancelling signal (weight 6, pinned first); Glofox order unchanged"`

### Task 16: Pinned "Payment failed" block

**Files:**
- Modify: `src/lib/churn-radar-data.js` (`loadRadar` returns `pinned`), `src/lib/membership/reads/un1t-online-radar.js` (build log `pinned`)
- Modify: `src/components/ChurnRadar.jsx` (block above the At-risk list)
- Test: `src/lib/churn-radar-data.test.js`

**Interfaces:**
- Consumes: `radarReadsFor(...).pinArrears`, `bucketArrears`, `buildOverdue`.
- Produces: `loadRadar` → `{ radar, summary, pinned? }`. `pinned` present only when `pinArrears` is true: `buildOverdue` rows for `membershipById` minus dismissed and snoozed contacts. Glofox result has no `pinned` key. UI: heading `Payment failed`, each row links to the Overdue tab, amount via `owedLabel`. Summary counts unchanged.

- [ ] **Step 1: Write the failing tests**

```js
it('pinned only with pinArrears; Glofox result has no pinned key', ...)
it('pinned holds a cancelling past-due member once', ...)
it('pinned excludes a dismissed contact', ...)
it('summary counts are identical with and without pinned', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/churn-radar-data.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.** → PASS.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.3 — un1t studios pin past-due members above At-risk (pinArrears)"`

### Task 17: Crossover scope for the five radar write routes

**Files:**
- Modify: `src/lib/contact-crossovers.js` (`isCrossoverAt`, `crossoverIdsAt`)
- Modify: `src/app/api/churn-radar/action/route.js:124`, `refresh-member/route.js:74`, `quarantine/route.js:80-91`, `src/app/api/lead-radar/action/route.js:80`, `cleanup/route.js:~98`
- Test: `src/lib/contact-crossovers.test.js`; extend `src/app/api/churn-radar/action/route.test.js`; Create `src/app/api/churn-radar/quarantine/route.test.js`

**Interfaces:**
- Produces:
  - `isCrossoverAt(db, contactId, locationId) → Promise<boolean>`: `probeMembershipOrClient(db, contactId, [locationId])`; any throw → false (logged, no PII).
  - `crossoverIdsAt(db, contactIds, locationId) → Promise<Set<string>>`: the same two probes as `.in('contact_id', ids)` reads at `[locationId]`; any error → empty Set (fail closed, logged).
  - Single-contact routes: accept when `contact.location_id === activeLocation || await isCrossoverAt(...)`, else today's 404. Bulk routes: scope = owned ids ∪ `crossoverIdsAt(...)`.

- [ ] **Step 1: Write the failing tests**

```js
it('crossover accepted at its membership studio', ...)         // active contact_memberships at L
it('crossover via a un1t_clients row accepted', ...)
it('refused (404) at any other studio', ...)                   // membership at Hatch, active location Stillorgan-B
it('probe error fails closed (404)', ...)
it('bulk quarantine scopes owned ∪ crossover ids only', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/contact-crossovers.test.js src/app/api/churn-radar/` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.** → PASS; `npm run check:location-scoping` → green.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.3 — radar write routes accept a crossover at the active studio only (fails closed)"`

### Task 18: Write routes at a un1t studio

**Files:**
- Modify: `src/app/api/churn-radar/quarantine/route.js` (`stale`), `src/app/api/lead-radar/cleanup/route.js` (`archive`), `src/app/api/churn-radar/action/route.js` (`payment_reminder`, outreach refusal), `src/app/api/lead-radar/action/route.js` (outreach refusal), `src/app/api/churn-radar/refresh-member/route.js`
- Modify: `src/components/ChurnRadar.jsx` (`:702-713`, `:1008-1013` hide payment-reminder and "Refresh from Glofox" when `source !== 'glofox'`), `src/components/RadarOutreachButton.jsx` (prop `outreachAvailable`; false → note `No WhatsApp number at this studio yet`, no picker), `src/components/LeadRadar.jsx` (pass it)
- Test: extend `src/app/api/churn-radar/action/route.test.js`, `route.no-number.test.js`, `quarantine/route.test.js`; Create `src/app/api/churn-radar/refresh-member/route.test.js`, `src/app/api/lead-radar/cleanup/route.test.js`

**Interfaces:**
- Consumes: `radarReadsFor(...).source`, `isWhatsAppNumberMissing`, `logInfo`, `syncDataAsOf(db, locationId)` (Task 7).
- Produces:
  - Source not `glofox`: `stale` / `archive` write the action row only, no `contacts` update.
  - `payment_reminder` → 409 `Payment reminders are not available for un1t.online studios yet.`
  - `refresh-member` → 409 `un1t.online data refreshes every 15 minutes, last at HH:MM` (studio zone; `HH:MM` from `syncDataAsOf`).
  - Outreach (`winback_sent`, `outreach_sent`, lead `outreach_sent`): `isWhatsAppNumberMissing(e)` → 409 `RADAR_NO_NUMBER = 'No WhatsApp number at this studio yet'`, `logInfo('churn-radar'|'lead-radar', 'outreach refused: studio has no WhatsApp number', { locationId })`, no action row, no Meta call. Glofox studios with a number: unchanged.
  - Radar GET responses (Task 7) gain top-level `outreachAvailable: boolean` (an active `whatsapp_numbers` row at L; same resolver `getWhatsAppConfig` uses, caught → false).

- [ ] **Step 1: Write the failing tests**

```js
it('quarantine stale at a un1t studio performs no contacts update', ...)   // db.update never called on contacts
it('cleanup archive at a un1t studio logs only', ...)
it('payment_reminder 409 with the exact copy at a un1t studio', ...)
it('refresh-member 409 with the last sync time', ...)
it('outreach at a number-less studio: 409 copy, one log, no action row, no Meta call', ...)
it('Glofox studio: stale still writes dormant (unchanged)', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/app/api/churn-radar/ src/app/api/lead-radar/` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.** → PASS.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.3 — un1t studios: triage logs only, payment reminder + Glofox refresh refused, outreach refused without a number"`

### Task 19: Crons, rail leads row, account-home members

**Files:**
- Modify: `src/app/api/cron/glofox-data-quality/route.js:53` (iterate `listLocationsByMembershipSource(db,'glofox')`)
- Modify: `src/lib/dashboard/business-rail.js` (`leadsRow`)
- Modify: `src/lib/account-home.js` (`countMembers`)
- Test: `src/app/api/cron/glofox-data-quality/route.membership-source.test.js`, `src/lib/dashboard/business-rail.test.js`, `src/lib/account-home.test.js`

**Interfaces:**
- Produces:
  - `glofox-data-quality`: only `glofox`-source locations; a failed list → 500, no heartbeat (today's rule).
  - `leadsRow(db, locationId, now)`: if the location's `is_primary` pipeline has `key='acquisition'` → today's query unchanged; else count open `deals` on the location's `enabled` `acquisition` pipeline at the stage with `slug='new_lead'`, `created_at` older than 24h, minus contacts with a `contacted` / `outreach_sent` `lead_radar_actions` row (cap 100 as today). No acquisition board → null.
  - `countMembers(db, locationId, membershipSource)`: `glofox` → today's head-count unchanged (Stillorgan anti-goal; deliberate narrowing of spec §5's "one line"); any other source with a `membershipCounts` read → `total_members` from `READS_BY_SOURCE[source].membershipCounts`; failure → 0 as today.

- [ ] **Step 1: Write the failing tests**

```js
it('glofox-data-quality skips non-Glofox sources', ...)
it('leadsRow on a manual-primary location reads acquisition deals', ...)
it('leadsRow on an acquisition-primary location is unchanged', ...)
it('account-home members: glofox head-count unchanged; un1t from membershipCounts', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/app/api/cron/glofox-data-quality/ src/lib/dashboard/business-rail.test.js src/lib/account-home.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.** → PASS; `npm run check:select-columns` → green.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.3 — data-quality cron by Glofox source; rail leads from the acquisition board; account-home members by source"`

### Task 20: Ship PR 3

- [ ] **Step 1:** CI mirror + `npm run build` → green.
- [ ] **Step 2:** `git push -u origin HEAD && gh pr create --base main --title "UN1TRADAR.3 — Hatch radar: cancelling/past-due pins, acting routes, crons"`.
- [ ] **Step 3:** Changelog entry file, test, commit, push.
- [ ] **Step 4: Preview check (controller, browser, read-only).** Stillorgan radar order and buttons unchanged (payment reminder and Refresh from Glofox visible); no write action is clicked.

---

## PR 4: `UN1TRADAR.4` (branch `un1t-radar-memberships-flip`)

Prerequisites, checked by the controller before branching: PR 1-3 merged; Task 0 Steps 1-3 done; Task 13 Step 7 applied; A's `invoices` flip on `origin/main` (`git grep -n "invoices: true" origin/main -- src/lib/membership/sources/un1t-online.js`).

### Task 21: Flip `memberships` and the readers guard

**Files:**
- Modify: `src/lib/membership/sources/un1t-online.js:16` (`memberships: true`) and its header comment
- Modify: `src/lib/membership/sources/un1t-online.test.js:22`
- Modify: `src/app/api/cron/churn-radar-snapshot/route.membership-source.test.js`, `lead-radar-snapshot/route.membership-source.test.js`, `churn-radar-digest/route.membership-source.test.js`
- Create: `tests/memberships-capability-readers.test.js`

**Interfaces:**
- Produces: `un1tOnlineSource.capabilities` = `{ memberships: true, bookings: false, credits: false, invoices: true, schedule: false }` (`invoices: true` is A's).
- Guard test: greps non-test files under `src/` for the capability (`capabilit[a-z]*\??\.memberships|'memberships'|"memberships"`) and asserts the set equals a classified list, each with its effect: the 5 crons, 5 dashboard pages, `MembershipSourceGate.jsx`, `business-kpis.js`, `locations-for-source.js`, `state-for-page.js`, `sources/none.js`, plus non-readers that match the pattern (`glofox-sync.js`, `qualifications-server.js`, `un1t-online-status.js`) marked "not the capability". A new reader fails the test until classified.

- [ ] **Step 1: Write the failing tests**

```js
it('un1t.online provides memberships; bookings stays false', () => {
  expect(un1tOnlineSource.capabilities).toEqual({ memberships: true, bookings: false, credits: false, invoices: true, schedule: false })
})
it('snapshot crons include a un1t location once its provider has the capability', ...)
it('digest sends only to the location\'s list', ...)   // recipients ['ops@example.com'] → one send to exactly that list
it('every memberships-capability reader is classified', ...)
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/lib/membership/sources/un1t-online.test.js src/app/api/cron/ tests/memberships-capability-readers.test.js` → FAIL.
- [ ] **Step 3: Flip the flag and update the header comment** (list what turns on, per spec §8 table).
- [ ] **Step 4: Run to verify pass.** Same → PASS; then `npm test` → PASS.
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "UN1TRADAR.4 — un1t.online provides memberships (radars, digest, pulse at Hatch); readers guard"`

### Task 22: Ship PR 4 and verify live

- [ ] **Step 1:** CI mirror + `npm run build` → green.
- [ ] **Step 2:** `git push -u origin HEAD && gh pr create --base main --title "UN1TRADAR.4 — flip memberships for un1t.online"`. Body: spec §8 "What turns on" table, the customer-facing statement (nothing starts automatically; radar outreach refused at Hatch, payment reminders refused), and the readers guard list.
- [ ] **Step 3:** Changelog entry file, test, commit, push.
- [ ] **Step 4: Preview acceptance (controller, browser + Supabase MCP, read-only).** At Hatch on the preview: radar active base equals the business page's Total members, or every difference is itemised (unlinked client, trial-shaped plan, credit-unlimited holder); a known dual-studio member appears; any cancelling member is first; Overdue matches A's contact-page figures; Unpaid charges and Awaiting authorization read `not available from un1t.online`. Stillorgan identical to production. Richard looks before merge.
- [ ] **Step 5: After merge (controller, Supabase MCP + Postmark, read-only).** Monday 06:00 / 06:30 UTC: one new Hatch row each in `churn_radar_snapshots` and `lead_radar_snapshots`. The 07:00 digest and 06:00 briefing to Hatch went to exactly one recipient (Postmark outbound search by tag). The pulse shows Hatch numbers with no "vs" line until 2026-11-17.
- [ ] **Step 6: 30-day window follow-up (controller, Supabase MCP, read-only, on or after 2026-10-27; does not block the flip).** For every Hatch client compare `bookings_30d_attended` / `bookings_30d_no_show` with mirror-derived 30-day counts. Any difference → a follow-up PR switching both radar counts to mirror-derived, with the reason (spec §2 builder check b).
