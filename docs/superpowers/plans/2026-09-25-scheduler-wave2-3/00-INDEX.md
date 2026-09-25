# Scheduler Wave 2 + 3 — Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each numbered plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the rest of the scheduler roadmap from the 19 Sep product review: the inputs a manager needs to build a week (availability, working time, ranked candidates), fewer clicks to fix one (replace, offer to team, edit one shift), coach-pulled features (calendar feed, arrival stamp), and the roster as a source of truth (types, snapshots, qualifications, labour, the class link).

**Architecture:** One PR per numbered plan, each in its own fresh worktree off `origin/main`, built TDD by one implementer, then independent review, then the full gate (CI mirror + `npm run build`), then PR. Decision logic goes in pure modules (`src/lib/`, `shared/` when the phone needs it, `mobile/lib/` for phone-only rules) with tests; routes follow the mutation skeleton in `CLAUDE.md`. Detail plans are written just in time, one batch ahead of the build, so each is written against the code the previous batch left.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + PostgREST, project `iyvtbjjxdggiadzwwvdj`), Expo / React Native staff app in `mobile/`, Vitest.

**Started:** 25 Sep 2026, from `origin/main` at `2f0b35ba` (#1755). Last migration on disk: 627.

---

## Standing rules for every PR in this program

- Read `CLAUDE.md` Invariants first. Service-role routes get no RLS: every read and write is scoped in code (`assertLocationAccess`, org filters, 404 not 403 on detail routes).
- **Richard's decisions (don't reopen):** availability is self-declared, no approval, managers are notified of changes; roster scope is HYBRID (templates gain a type, class or admin; only admin that needs a time and a person is placed; the rest of a contract is an unplaced admin balance); **admin shifts carry no minimum staffing**, so an unfilled admin block is never a gap and the publish check, staffing chips and runway alert look at class shifts only; admin blocks stay out of the contractor budget gate but count toward working-time advisories; the rostered coach's name on customer screens is an operator toggle, **off by default**; hours only, never rates, reach anyone but owners.
- **Merge authority (Richard, 25 Sep):** I may merge, apply migrations and merge phone updates without asking, once independent review is approved, my gate is green and CI is green on the final rebase. Migrations: pre-checks, a rollback record in the scratchpad, apply via Supabase MCP, post-checks, `get_advisors`. Phone updates: one at a time; check the EAS Update run before the next.
- Anything under a bundle path in `mobile/` or `shared/` publishes an OTA on merge. Say so in the PR body.
- Migration numbers are reserved below so parallel PRs never collide.
- Every PR adds a `docs/CHANGELOG.md` row once its number exists; never edit a pushed row.

## The PRs

Size: S under a day, M one to three days, L a week or more. "Mig" = new migration (reserved number). "OTA" = merging publishes a phone update.

### Wave 2 · plan with inputs

| # | Key | Size | What | Mig | OTA | Depends on |
|---|---|---|---|---|---|---|
| 11 | DATECHECK.1 | S | Every schedule route that takes a date refuses one the calendar does not have (`blocks`, `rosters`, `week-cost`, `contractor-spend`, any other shape-only check) | | | |
| 12 | TPLCLONE.1 | S | Copy shift templates from one studio to another in the same organisation (Hatch Street has none; Stillorgan has 18) | | | |
| 13 | SHIFTTYPE.1 | M | Templates gain a kind, `class` or `admin`. Admin: no minimum, never a gap, out of the contractor budget gate, still counted in hours. Card tone per kind | 628 | yes | |
| 14 | BLOCKEDIT.1 | M | Edit one shift: times, minimum, maximum, logged in the change log and notified when published. A separate coach-visible briefing note on web and phone | 629 | yes | 13 |
| 15 | WORKTIME.1 | M | Working-time advisories for employees: 11-hour rest between shifts, 48 hours in a rostered week, across both studios. Advisory only: publish check, assign picker | | yes (shared) | |
| 16 | AVAIL.1 | L | Coach availability: weekly unavailable windows plus dated exceptions, per person. API, manager notification on change, web calendar shading and picker badges | 630 | | |
| 17 | AVAIL.2 | M | Phone screen for a coach to set their own availability | | yes | 16 |
| 18 | AVAIL.3 | S | Contractors' "unavailable" time off moves into availability: stop offering the type, carry future rows across | 631 | yes | 16, 17 |
| 19 | CANDIDATES.1 | M | Ranked candidates wherever a coach is picked (web and phone): free or not, leave, availability, already on site, week hours both studios, rest gap. Hours only | | yes | 15, 16 |
| 20 | REPLACE.1 | M | Replace coach (one action, one notice) and "Offer to team" for an unfilled published shift | | yes | 19 |
| 21 | GRID.1 | M | Coach-by-day grid: one row per coach, week total, contracted hours, admin balance, leave and availability overlaid, both studios summed | | | 13, 16 |
| 22 | ICSFEED.1 | M | Per-coach calendar subscription of published shifts across both studios; secret token, rotate, revoked on deactivation; all four public-path allowlists | 632 | yes | |

### Wave 3 · the roster as the source of truth

| # | Key | Size | What | Mig | OTA | Depends on |
|---|---|---|---|---|---|---|
| 31 | HEARTBEAT.1 | S | Shift-reminder and unbuilt-week arms get heartbeat rows of their own, stamped only on success | 633 | | |
| 32 | SNAPSHOT.1 | M | Publish snapshot: what was published, so "as published", "as finally rostered" and "as arrived" can be compared (manager view) | 634 | | |
| 33 | QUALS.1 | M | Qualifications with expiry (first aid, insurance, vetting), an optional requirement on a template (advisory in the picker), an expiry digest to owners | 635 | | 19 |
| 34 | ARRIVALSHOW.1 | S | Coaches see their own arrival stamp on the phone. The first half of late and no-show alerts | | yes | |
| 35 | LABOUR.1 | M | Owner-only labour against revenue, and the month's forecast against actual. Server-computed ratios; rates never reach the browser | | | 13 |
| 36 | CLASSLINK.1 | M | Class schedule goes platform-neutral: `class_occurrences` gains a source, `glofox_event_id` becomes optional, coaches map to trainer ids | 636 | | |
| 37 | CLASSLINK.2 | L | Link shift blocks to classes over the roster horizon, nightly reconcile, mismatch list for managers | 637 | | 36 |
| 38 | CLASSLINK.3 | S | Operator toggle to show the rostered coach's name on customer class screens, **off by default** | 638 | yes | 37 |

**Held, not built:** late and no-show alerts. Arrival stamps exist for 19% of shifts and three of nine coaches have none, so an alert would mostly cry wolf. ARRIVALSHOW.1 is the step that can raise coverage; revisit when coverage is above about 80% for a month.

## Build order

Two implementers at a time (8GB machine). Pairs are chosen so they touch different files; within a pair either can merge first.

| Batch | Pair | Why together |
|---|---|---|
| 1 | 11 DATECHECK.1 · 12 TPLCLONE.1 | small, independent, warm-up |
| 2 | 13 SHIFTTYPE.1 · 15 WORKTIME.1 | the two foundations everything later reads |
| 3 | 16 AVAIL.1 · 31 HEARTBEAT.1 | the big one, with a small one beside it |
| 4 | 14 BLOCKEDIT.1 · 22 ICSFEED.1 | both touch shift cards and the phone schedule tab: BLOCKEDIT first |
| 5 | 17 AVAIL.2 · 19 CANDIDATES.1 | |
| 6 | 20 REPLACE.1 · 21 GRID.1 | |
| 7 | 32 SNAPSHOT.1 · 33 QUALS.1 | |
| 8 | 34 ARRIVALSHOW.1 · 35 LABOUR.1 | |
| 9 | 36 CLASSLINK.1 · 18 AVAIL.3 | |
| 10 | 37 CLASSLINK.2 → 38 CLASSLINK.3 | sequential |

**Conflict hotspots** (rebase before merge, merge in batch order): `src/components/ScheduleCalendar.jsx` (13, 14, 16, 19, 20, 21, 33), the phone schedule tab `mobile/app/(staff)/(tabs)/schedule.jsx` and `mobile/components/schedule/*` (14, 17, 19, 20, 22, 34), `src/lib/openapi.js`, `docs/CHANGELOG.md` (every PR).

## Defaults I chose where the review left a gap (flagged for Richard's review)

These are marked **REVIEW** in the artifact until he confirms or changes them. Each is cheap to change before its PR merges.

1. **Availability is per person, not per studio,** and is declared as UNAVAILABLE windows (weekly by weekday + time, and dated exceptions), with everything else available. That matches how coaches already use "unavailable" time off (36 requests in 120 days).
2. **A manager is notified once per save** of availability, not per window, at every studio the coach belongs to, inside the 07:00–22:00 notice band.
3. **The 48-hour check is per rostered week,** not the Organisation of Working Time Act's four-month average. It is advisory, so an early flag is the safe side.
4. **The admin balance** is contracted hours minus class hours minus placed admin hours, employees only, shown to managers as hours. It never shows pay.
5. **The calendar feed** carries published shifts only, two weeks back and eight ahead, both studios, and stops working when the coach is deactivated.
6. **"Offer to team" goes to coaches at that studio** who are free, not on leave and not unavailable at that time; the first to claim it gets the shift; the manager is told.
7. **Qualifications have no document upload** in the first cut (phone uploads are dead, `mobile-multipart-upload-dead`); a manager records the type, the expiry and a note.
8. **Labour against revenue** uses whatever revenue source the studio scorecard already trusts; the LABOUR.1 plan names it before any code.
9. **The class link does not widen the Glofox sync** beyond what the API can bear; CLASSLINK.2's plan measures the call cost first.

## Status log

Updated by the loop. Newest first.

- 25 Sep: plan index written. Batch 1 and 2 detail plans commissioned.
