# Scheduler Wave 2+3 follow-ups: fix plan index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each numbered plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every follow-up logged while building Scheduler Wave 2+3 (the "Follow-ups found along the way" list in `../2026-09-25-scheduler-wave2-3/00-INDEX.md`, plus the review nits deferred at merge time), or record why it is held or declined.

**Architecture:** One focused PR per row below, each in its own fresh worktree off `origin/main`, test-first, with the same gate as Wave 2+3: independent review → the 12-command CI mirror + `npm run build` → PR + CHANGELOG row → migration (pre/post checks, rollback record) → merge. OTAs (anything under `mobile/` or `shared/`) merge one at a time, and each EAS Update run is checked before the next. Every row gets its own detail plan (`NN-KEY.md` in this folder), written just before it is built, against the code as it stands then. This index fixes scope, order and decisions.

**Tech Stack:** Next.js 16 App Router, Supabase (project `iyvtbjjxdggiadzwwvdj`), Expo staff app in `mobile/`, Vitest.

**Written:** 27 Sep 2026, against `origin/main` after #1779. File:line anchors below were checked against that tree.

---

## Already fixed (removed from the list)

| Follow-up | Fixed by |
|---|---|
| `/api/public/classes` sent `spots_left` to anonymous callers (plus the events "Only N spots left" refusal) | #1775 PUBCAP.1 |
| "Labour this week" counted cancelled and draft shifts | #1776 LABOURWEEK.1 |
| Time Off Summary dropped leave crossing the period edge, and saved an empty report on a failed read | #1777 TIMEOFFREPORT.1 |
| "Staff today" counted unpublished blocks | #1778 STAFFTODAY.1 |
| The Today strip's today/this week used UTC; `dublinDayRangeMs` returned an empty window on the clocks-back day | #1779 DUBLINDAY.1 (+ champ-app#123) |
| `getCompensationForProfiles` returned empty on a failed read | LABOUR.1 (#1772): it now throws |

## Standing rules (same as Wave 2+3)

- Read `CLAUDE.md` Invariants first. Service-role routes are scoped in code; detail routes return 404, not 403.
- **Merge authority:** Richard's standing "Everything" for the Wave 2+3 program covers these follow-ups: merge web PRs, apply migrations with pre/post checks and a rollback record, and merge OTAs one at a time. **Still ask him** for anything customer-facing that is ON by default, any destructive data change, and every row marked **DECISION** below.
- Dates are Europe/Dublin; test date code under `TZ=Europe/Dublin` and `TZ=America/Los_Angeles`. On the server use `@/lib/dublin-time`. In `shared/`, import `./dublin-time.js` **lazily inside the function** when the module is also loaded by the phone (Hermes without ICU throws on a module-scope timeZone formatter; see `mobile/lib/dates.js`).
- A failed read is never an empty answer. Removing a silent failure must never create a louder one (the CLAUDE.md rule): log with `logError`, accept a duplicate or retry, and fail closed only when proceeding is harmful.
- Every PR carries a test that fails on the code before it.

## The PRs

Size: S under half a day, M a day or two. "Mig" = new migration. "OTA" = merging publishes a phone update.

### Batch A: money and hours (wrong numbers people act on)

| # | Key | Size | What | Mig | OTA | Anchors |
|---|---|---|---|---|---|---|
| A1 | PAYROLL24.1 | S | `timeToHours` refuses hour 24 (`h > 23` → null), so payroll and every report built on `shiftHours` count a shift ending `'24:00'` as **0 hours**. Accept exactly `24:00`/`24:00:00` as 24.0 (nothing past it). Sweep the other hour parsers for the same rule (`shared/dashboard-data.js` `shiftDurationHours` already works; `workingWindow` already works). Test: a 22:00–24:00 shift is 2h in `shiftHours`, `computeWeeklyCost`, the staff_hours and staff_cost reports. | | | `src/lib/payroll.js:25-34` |
| A2 | CONTRACTORSPEND.1 | M | Contractor spend (a) skips a contractor deactivated mid-month, (b) skips the sibling studio's contractors who worked here, so worked shifts go uncounted, and (c) `summarizeMonth` parses its reference date with a local `new Date(...)` (latent on Vercel/UTC; wrong anywhere else). Fix: price every live published assignment in the month at this studio, whoever holds it, active or not (the LABOUR.1 rule); take the month from Dublin calendar strings. | | | `src/lib/roster-summary.js` (~60-80, 216-221, the month summariser), `src/lib/roster-summary-server.js:72-102` |
| A3 | INVOICEHOURS.1 | S | The contractor invoice review's "scheduled hours" (`computeScheduledForPeriod`) counts cancelled assignments, so an invoice for fewer hours than scheduled looks short when it is right. Use `isLiveAssignment` and published rosters only, the same rule as LABOUR.1. | | | `src/lib/contractor-invoices.js:97-131` |
| A4 | REVENUEMTD.1 | S | "Revenue MTD" and last month's comparison start the month at the server's local midnight (UTC on Vercel), so a payment in the first Dublin hour of the 1st lands in the previous month. Use `dublinMonthStartMs`/`dublinDayRangeMs`, imported lazily (this module is loaded by the phone). Check line 589's second month-start use in the same file. | | yes (`shared/`, no behaviour change on phones) | `shared/dashboard-data.js:531-589` |

### Batch B: privacy and access

| # | Key | Size | What | Mig | OTA | Anchors |
|---|---|---|---|---|---|---|
| B1 | TRAINERSROLE.1 | S | `/api/locations/[id]/glofox-trainers` checks the caller's role at their **active** studio, not the studio in the path (the SCHEDROLES class): a manager at A with B active can read B's trainer list, or be refused at their own. Gate on the path's location (`hasRoleAtLocation(user, id, …)`, 404 for outsiders). Fix the stale "~850 rows" comment (it's 184). | | | `src/app/api/locations/[id]/glofox-trainers/route.js` |
| B2 | CONTRACTVIS.1 | M | **DECISION.** Colleagues' `contracted_hours_per_week` reaches **every role** through `STAFF_PICKER_FIELDS` and `STAFF_PUBLIC_FIELDS`, and `/api/schedule/week-cost` (MANAGER_ROLES, head coaches included) returns `contracted_hours`. CANDIDATES.1 and GRID.1 already restrict it to owner/manager/master. **Proposal:** the same rule everywhere. Drop the column from the picker/public field lists, and have week-cost omit it below ADMIN_ROLES. Build only after Richard says yes: it removes a number head coaches and staff see today. | | maybe (if a mobile reader of those fields exists; the plan checks) | `src/lib/staff.js:25` and the `STAFF_PUBLIC_FIELDS` definition, `src/app/api/schedule/week-cost/route.js` |
| B3 | COACHNOTES.1 | S | **DECISION.** A shift block's manager `notes` reach the coach's own row through `toApiShiftRow` (`notes: a.notes ?? b.notes`). COACHSCOPE.1 meant block notes as manager working notes, and BLOCKEDIT.1 added `briefing` as the coach-facing field. **Proposal:** coach-audience rows carry the assignment's own note and the block's `briefing`, never the block's `notes`; manager views are unchanged. Richard to confirm, since coaches may be reading those notes today. | | yes (if the phone renders `notes`; the plan checks) | `src/lib/roster-read.js:66, 98-128` |

### Batch C: silent failures and reliability

| # | Key | Size | What | Mig | OTA | Anchors |
|---|---|---|---|---|---|---|
| C1 | RECIPIENTS.1 | M | `resolveRoleRecipientIds` returns `[]` on a failed read, so a failed managers read looks like "nobody to tell". REPLACE.1b added `readRoleRecipientIds` (returns `{ ids, error }`) for its own path. Move every other caller onto it and treat the error per caller: retry next tick, or leave the stamp unwritten. Callers: equipment-inspection sweep, hyrox reminder runner, `notify.js`, `push-dedup.js` (×2), `push.js:410`, `swap-cover-server.js` (×2), and the roster-runway arm. Each gets a "failed read never stamps / never reports clean" test. Keep `resolveRoleRecipientIds` for one deploy, then delete it. | | | `src/lib/push.js:365-410` and the callers listed |
| C2 | CLASSSYNCHB.1 | S | The `sync-class-occurrences` heartbeat row is **86,400 s + 7,200 s** (checked live, 27 Sep), but the cron runs every 15 minutes (mig 284 intended 900 s + 900 s). A dead class sync goes unnoticed for about a day while the spine holds only 48 hours ahead. New migration: set 900 + 900 with `ON CONFLICT DO UPDATE` and a self-check. Apply it any time; the row already stamps every 15 minutes. | yes (next free number) | | `cron_heartbeats` row `sync-class-occurrences` |
| C3 | TRAINERCALLS.1 | S | `class_occurrences.instructor` is NULL on all 632 rows. Glofox resolves no trainer names, and there is no override, yet every 15-minute sync still makes about 1+N trainer-name calls (a few hundred a day). Stop the futile calls: cache "unresolvable" per trainer id for a day, or skip the lookup when the location has no name source. Filling the names properly is CLASSLINK.1's job (held). | | | the class-occurrence sync (`/api/cron/sync-class-occurrences` and its lib) |
| C4 | ATTENDREPORT.1 | M | The attendance report (`/api/attendance`) has five problems:<br>- it measures lateness against the rostered start, ignoring a manager's adjusted start (:115-147);<br>- its default window is UTC today (:36-39);<br>- it checks dates by shape only (:44), so 30 Feb gives a 500;<br>- it doesn't page its select;<br>- it discards the attendance-events read error (:90-94).<br>Fix all five with `reportPeriodError`/`realIsoDate`, `dublinTodayStr`, `.range()` paging, and lateness against the effective start. | | | `src/app/api/attendance/route.js` |
| C5 | REPLACENITS.1 | S | Follow-ups left from REPLACE.1a/1b:<br>- the cron's `replace_arm_failed` flag ignores `stamp_failed`, and `summary.replace_notices` never triggers the tick log (`send-push-reminders/route.js:~466`);<br>- a double-submitted DELETE of an assignment answers 409 "This shift has just changed"; make it idempotent (the row is already gone → 200);<br>- `unassign-clashes` answers 500 when every row was `changed`; it should be 409;<br>- a "removed" notice for a deleted slot carries no start time, so a 06:00 slot deleted overnight is still announced at 07:00; carry `block_date` + start in the log row details and hold it back once started;<br>- the claim RPC's rare deadlock (SQLSTATE 40P01) with a manager adding the same coach should map to a friendly 409 "Try again".<br>Tests for each. | | yes (if any change reaches `shared/`) | `src/app/api/cron/send-push-reminders/route.js`, `src/lib/shift-unassign.js`, the unassign-clashes route, `src/lib/shift-replace-notify.js`, the offers claim route |
| C6 | RANGEVALID.1 | S | No schedule range route checks that start ≤ end, and `allowances?year=` is not validated (found building DATECHECK.1). Add the check to every schedule route that takes a from/to pair, and validate `year` (4 digits, a sane window). The staff assistant's `generate_report`, `create_shift` and `get_time_off` tools take model-supplied dates unchecked: route them through the same validators. The assistant is off everywhere, so this is low risk and included for completeness. | | | `src/app/api/schedule/**` range routes, the allowances route, the assistant tool handlers |

### Batch D: clean-up and guard rails

| # | Key | Size | What | Mig | OTA | Anchors |
|---|---|---|---|---|---|---|
| D1 | DEADCODE.1 | S | Delete code with no callers left:<br>- `coachConflictsForBlock` (`src/lib/schedule-overlap.js`) and its tests;<br>- the old `GET /api/schedule/working-time` route (CANDIDATES.1 replaced it; the one-deploy grace for open tabs has passed);<br>- `fetchUnstaffedBlocksThisWeek` (`shared/dashboard-data.js`) and `isBlockUnstaffedFuture` (`src/lib/roster.js`), which would count an admin shift as a gap if revived.<br>Also refresh the out-of-date `src/lib/cron-heartbeat.js` docstring, and remove the openapi entry for the deleted route. First confirm with `git grep` that there are no callers, including `mobile/`. | | yes (`shared/` deletion) | as listed |
| D2 | EXPECTLINT.1 | S | An un-awaited `expect(...).resolves/.rejects` races the test's end and flaked CI once (#1762). Add the vitest `valid-expect` rule with `alwaysAwait: true` (or a guard test that scans for un-awaited `.resolves`/`.rejects`) to the test lint, fix what it finds, and add it to the CI mirror if it is a new command. | | | the eslint config for tests |
| D3 | SELCOLS2.1 | M | `check:select-columns` skips two cases silently: columns inside an **aliased** embed (`locations:location_id ( … )`, found building LABOUR.1), and a select string held in a constant (found building REPLACE.1b). Teach the parser the `alias:fk ( cols )` embed form, and resolve a `const X = '…'` select in the same file. Allowlist anything genuinely unreadable with a reason and an expiry. | | | `scripts/check-select-columns.*` |
| D4 | UINITS.1 | S | Two UI nits:<br>- in `ShiftTemplateManager.jsx`, the warning shown after deactivating or reactivating a template is wiped by the list reload before it can show; keep it across the reload;<br>- the phone's `PersonalDashboard` shows "Could not load staff" when the staff read fails even though the ranked candidate list arrived; show it only when the picker has nothing to show. | | yes (phone half) | `src/components/ShiftTemplateManager.jsx`, `mobile/components/dashboard/PersonalDashboard.jsx` |
| D5 | REVIEWNITS.1 | S | Small review nits deferred at merge:<br>- **QUALS.1:** seeds only reach organisations that existed at migration time; seed a new organisation's three types when it is created. The limit of 5 requirements lives only in the API, so two concurrent PUTs can exceed it; enforce it in the table with a count trigger. `can_edit_types` is judged at the active studio while the API judges across the organisation; align them.<br>- **CANDIDATES.1:** `untimed` counts rows over the whole read range; `on_site` misses a shift here that ended after midnight the night before.<br>- **SNAPSHOT.1:** say in the migration comment that the delete trigger lets through any delete fired from another trigger, not only the location cascade.<br>- **REPLACE.1b:** the overlap check assumes one timezone across studios; add a comment.<br>Split this row if its detail plan runs past a day. | maybe (the QUALS count trigger) | maybe | as listed |

### Held: decisions or bigger features (not built from this plan)

| Item | Why held | What unblocks it |
|---|---|---|
| **Manual arrival** (`arrival_source='manual'`): nothing lets a coach or manager record or correct an arrival, which blocks late/no-show alerts and switching ARRIVALSHOW.1's absence lines on | A feature with product choices: who may record, what evidence, and whether it changes pay | Richard's go, then a Wave-style plan |
| **Arrival coverage** is 19% of shifts. The geofence region doesn't re-fire while a coach stays inside, so an arrival more than 45 minutes early is lost | Native geofencing work (Expo location task, dwell or re-arm behaviour), which needs handset testing | A device-test session with Richard |
| **Contractor invoices:** one per contractor per month across both studios (`101_contractor_invoices.sql:66`), so a contractor who works at both can invoice only one | A product rule | Richard's call |
| **Glofox-id-keyed readers** (AC fire log, HR sessions, detections, TV card, automation keys) must be re-keyed before any un1t.online sync writes rows | Part of CLASSLINK.1–3, which is held on the un1t.online spec question | Richard's CLASSLINK decision |
| **Scale limits:** CANDIDATES.1's unchunked `.in()` and AVAIL.1a's unpaged `readStudioAvailability` | Fine at 13 members; revisit before a large studio | A studio over about 150 members |
| **LABOUR.1:** a salary share weighted to a studio deactivated mid-month shows in no view | 0 inactive studios today | The first studio deactivation |
| **Mig 633's header** says "apply before the deploy" (it went after) | A comment in an applied migration; forward-only files aren't edited | The next migration that touches that row can say so |

## Order and batching

Two implementers at a time (8GB machine). Merge OTAs one at a time.

| Wave | Build | Why this order |
|---|---|---|
| 1 | A1 PAYROLL24.1 · B1 TRAINERSROLE.1 | a wrong pay figure and an access-check bug, both small and independent |
| 2 | A2 CONTRACTORSPEND.1 · A3 INVOICEHOURS.1 | the contractor money pair (A3 reuses A2's live-assignment rule) |
| 3 | C1 RECIPIENTS.1 · C2 CLASSSYNCHB.1 | silent failures; C2 is migration-only |
| 4 | C4 ATTENDREPORT.1 · A4 REVENUEMTD.1 | report correctness; A4 is the only OTA in the wave |
| 5 | C5 REPLACENITS.1 · C3 TRAINERCALLS.1 | |
| 6 | C6 RANGEVALID.1 · D1 DEADCODE.1 | D1 is an OTA |
| 7 | D2 EXPECTLINT.1 · D3 SELCOLS2.1 | guard rails last, so they lint the finished code |
| 8 | D4 UINITS.1 · D5 REVIEWNITS.1 | D4 is an OTA |
| on Richard's go | B2 CONTRACTVIS.1 · B3 COACHNOTES.1 | each changes what people see today |

**Conflict hotspots:** `src/lib/payroll.js` (A1; read by A2's pricing, so A1 merges first), `shared/dashboard-data.js` (A4, D1), `src/lib/push.js` (C1), `src/app/api/cron/send-push-reminders/route.js` (C1 via runway, C5), `src/lib/openapi.js` (B1, D1).

## Decisions for Richard (both default to "no change" until he answers)

1. **CONTRACTVIS.1:** restrict colleagues' contracted hours to owner/manager/master everywhere (the rule the new picker and grid already use)?
2. **COACHNOTES.1:** stop showing a block's manager notes on a coach's own shift row, leaving their own note plus the briefing?

## Status log

Newest first.

- 27 Sep 2026: index written. The open follow-ups → 18 PRs: 16 across 8 waves plus 2 waiting on a decision (B2, B3); 7 items held with reasons; 6 already fixed (#1772, #1775–#1779).
