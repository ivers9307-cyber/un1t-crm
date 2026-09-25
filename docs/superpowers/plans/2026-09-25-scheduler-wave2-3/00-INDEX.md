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
| 16 | AVAIL.1 | L | Coach availability: weekly unavailable windows plus dated exceptions, per person. Split: **1a** API + manager notice (OTA: `shared/`), **1b** web editor, calendar shading, picker badges | 630 | 1a yes | |
| 17 | AVAIL.2 | M | Phone screen for a coach to set their own availability | | yes | 16 |
| 18 | AVAIL.3 | S | Contractors' "unavailable" time off moves into availability: stop offering the type, carry future rows across | 631 | yes | 16, 17 |
| 19 | CANDIDATES.1 | M | Ranked candidates wherever a coach is picked (web and phone): free or not, leave, availability, already on site, week hours both studios, rest gap. Hours only | | yes | 15, 16 |
| 20 | REPLACE.1 | M | Split: **1a** Replace coach (one guarded UPDATE, one notice each; mig 640 = its `replace-notices` arm heartbeat row, applied AFTER deploy) → **1b** Offer to team (`shift_offers`, locked claim RPC, mig 641) | 640, 641 | yes | 1b needs 19 |
| 21 | GRID.1 | M | Coach-by-day grid: one row per coach, week total, contracted hours, admin balance, leave and availability overlaid, both studios summed | | | 13, 16 |
| 14b | (BLOCKEDIT heartbeat) | S | Heartbeat row for BLOCKEDIT.1's time-change notice arm, applied AFTER its deploy (the arm rule) | 639 | | 14 |
| 22 | ICSFEED.1 | M | Per-coach calendar subscription of published shifts across both studios; secret token, rotate, revoked on deactivation; all four public-path allowlists | 632 | yes | |

### Wave 3 · the roster as the source of truth

| # | Key | Size | What | Mig | OTA | Depends on |
|---|---|---|---|---|---|---|
| 31 | HEARTBEAT.1 | S | Shift-reminder and unbuilt-week arms get heartbeat rows of their own, stamped only on success | 633 | | |
| 32 | SNAPSHOT.1 | M | Publish snapshot: what was published, so "as published", "as finally rostered" and "as arrived" can be compared (manager view) | 634 | | |
| 33 | QUALS.1 | M | Qualifications with expiry (first aid, insurance, vetting), an optional requirement on a template (advisory in the picker), an expiry digest to owners | 635 | yes (shared; one new push toggle) | 19 |
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
10. **Copying templates does not copy their weekdays unless the manager ticks a box.** Copying them fills the target studio's next eight weeks with empty shifts and starts its unbuilt-week alerts at once.
11. **Rest is measured from a day's last shift to the next day's first,** so a split shift inside one day (06:00–10:00 then 17:00–21:00) never flags. The Organisation of Working Time Act asks for 11 consecutive hours in each 24; a stricter reading would flag some split days.
12. **Draft shifts at the other studio count toward the 48 hours, and approved leave is not subtracted.** Both make the advisory err towards flagging.
13. **Changing a template's kind changes its past shifts too** (kind lives on the template, not copied onto each shift). Hours are unaffected either way; only staffing gaps and contractor spend read the kind.
14. **Contractor spend leaves admin shifts out,** as decided, so if a contractor does placed admin work the spend figure under-reports what they will invoice.
15. **Someone has to mark Stillorgan's admin templates** after SHIFTTYPE.1 merges AND its phone update has reached phones (older phones show an admin shift as "No coach") (front desk, sales calls, consultations?). Until then every template stays a class template and nothing changes.
16. **Managers see the note a coach writes on an availability rule,** and the editor tells the coach so.
17. **A permanently deleted coach's availability rules are kept, not wiped** (they stop mattering because the person can't be rostered). The availability change log is kept indefinitely for now.
18. **The availability-change notice is on by default for every role,** not just managers: a push can't be scoped to one studio, so a manager who is plain staff at another studio would otherwise never get it. Outside 07:00–22:00 it waits for 07:00 and overnight saves fold into one notice.
19. **Managers can't set availability on a coach's behalf** in this cut.
20. **A posted admin shift nobody takes still escalates as "Shift still uncovered"** (`src/lib/swap-cover.js` ~413). The admin work still needs its person, so it stays.
21. **Reactivating a coach brings their old calendar-feed link back** (the feed simply refuses while they are inactive). A new link can be made any time from the Subscribe screen.
22. **An edit to a shift made overnight is told from 07:00,** even when the shift starts before then (quiet hours gate the notice). The edit itself is saved at once, and the manager's toast says coaches hear after 7am.
23. **A standing weekly briefing** (the same note every Monday) would need a template field; BLOCKEDIT.1 adds a briefing per shift only.
24. **Availability: the last save wins** if a coach edits on the web and the phone at once (no conflict check). New weekly rows on the phone default to all day; the web defaults to a time window.
25. **Only owners, managers and masters see colleagues' contracted hours** in the ranked picker (hours, never pay; contracted hours live in the owner/master-only `profile_compensation`). The plan had head coaches seeing them too; the review pointed out that is NEW exposure from the pay table, so I took the conservative side (one condition to widen). A coach asking a colleague to cover sees only who is free then at ANY studio of the organisation (one bit per colleague, incl. a studio whose roster they can't otherwise see), published shifts only; a colleague on leave shows as free (reveals less). Keep, or limit to this studio?
26. **The coach grid's admin balance does not subtract approved leave,** and every active team member gets a row (reception and owners included). The existing Weekly hours notice counts one studio only, so it will disagree with the grid's both-studio totals for anyone who works at both.

27. **The coach picker has ONE source of warnings** (CANDIDATES.1): the server's ranked list. If that request fails, the web picker lists the studio A–Z with a note saying nobody could be checked, and shows none of the clash, leave or availability badges it shows today. Ranking puts employees under their contract ahead of contractors, and a coach already on site ahead of one with a lighter week.
28. **On the phone, an existing one-day availability card plus a tap on a later day makes a range** (3 Oct, then a tap on 10 Oct, gives 3–10 Oct) rather than moving the day. Deliberate and documented; worth a look on a real phone.

29. **Qualifications live per organisation, not per studio** (a coach at both studios holds one certificate). First aid, Insurance and Garda vetting are seeded; **expiry is optional** (Garda vetting has none). Requirements on a template are advisory only (a picker badge, never a block), at most 5 per template.
30. **The qualification expiry digest goes weekly to owners and linked masters,** covering only their own studios' people, through a new `qualification_expiry` push toggle (push = the count, the fallback email = the list). The plan lists 13 more questions at its end.

31. **ARRIVALSHOW.1 shows "No arrival recorded" in grey** on a coach's ended shift when their studio tracks arrivals (about 70% of ended shifts today, since only 19% of shifts get a stamp), no minutes late/early, Me view only, own shifts only. Help line under the list: "They don't change your hours".

32. **LABOUR.1 revenue = the Studio scorecard's MRR** (its only trusted revenue figure), current month only, "so far" = MRR × month elapsed; paid Glofox invoices rejected (VAT, refunds, other months). **Employees cost 1/12 of annual salary a month** whatever the roster, split between studios by published hours; **contractors cost published hours × rate, admin shifts included** (they invoice them; contractor spend prices admin at €0 only for the budget gate). Forecast = the whole month's published roster, actual = published shifts that have ended. Owner/master only, on the Business dashboard, rendered on the server so no rate reaches the browser. Hatch shows labour but no ratio (no revenue source). 9 open questions at the end of the plan (overtime, PRSI/pension, 4 employees with no salary on file).

## Follow-ups found along the way (not in any PR yet)

- REPLACE.1a nits (post-merge): the cron's `replace_arm_failed` flag ignores `stamp_failed` and `summary.replace_notices` never triggers the tick log (`send-push-reminders/route.js:466`); a double-submitted DELETE now answers 409 "This shift has just changed" instead of 200, and `unassign-clashes` answers 500 when every row was `changed` (409 fits); a "removed" notice for a DELETED slot has no start time, so a 06:00 slot deleted overnight still gets its notice at 07:00. REPLACE.1b plan must renumber `shift_offers` to 641 and drop its `replace-notices` seed.
- 🔴 "Labour this week" on the Business dashboard and the phone's Business tab (`fetchTodayOps`, `shared/dashboard-data.js:659-724`) counts CANCELLED and DRAFT shifts; `fetchDashboardShifts` never filters status (found planning 35).
- Contractor spend skips contractors deactivated mid-month (`roster-summary.js:336`) and the sibling studio's contractors (`roster-summary-server.js:86-102`), so worked shifts go uncounted; `summarizeMonth` parses its reference date as UTC (`:322`, latent on Vercel) (found planning 35).
- The contractor invoice review's "scheduled hours" (`computeScheduledForPeriod`, `contractor-invoices.js:115-131`) counts cancelled shifts (found planning 35).
- "Revenue MTD" starts the month at UTC midnight, not Dublin (`shared/dashboard-data.js:541`) (found planning 35).
- Product question: contractor invoices are one per contractor per month across BOTH studios (`101_contractor_invoices.sql:66`), so a contractor at both can only invoice one (found planning 35).
- `getCompensationForProfiles` (`src/lib/profile-compensation.js`) returns empty on a failed read; LABOUR.1 makes it throw (no callers today).
- 🔴 Colleagues' contracted hours already reach EVERY role: `STAFF_PICKER_FIELDS` (`src/lib/staff.js:25`) and `STAFF_PUBLIC_FIELDS` send `contracted_hours_per_week`, and `/api/schedule/week-cost` (MANAGER_ROLES, incl. head coaches) returns `contracted_hours`. CANDIDATES.1 and GRID.1 hide them from head coaches; narrowing the old paths together is a separate PR for Richard to call (found reviewing 21).
- 🔴 Nothing writes a MANUAL arrival (`arrival_source='manual'`), so neither a coach nor a manager can correct a wrong or missing stamp. Blocks the late/no-show alert half (found planning 34).
- Arrival coverage is low for a geofence reason, not permissions: stamps on 19% of shifts; 48% of coach-days have no ping at all; on 11 of 23 ping-but-no-stamp days the ping came >45 min before the shift and the region never re-fires while the coach stays inside (found planning 34).
- The attendance report (`src/app/api/attendance/route.js`) measures lateness against the rostered start ignoring a manager's adjusted start (:115-147), defaults its window on UTC today (:36-39), checks dates by shape only (:44, 30 Feb → 500), doesn't page its select, and discards the attendance-events read error (:90-94) (found planning 34).
- 🔴 `payroll.timeToHours` (`src/lib/payroll.js:25-34`) refuses hour 24, so payroll counts a shift ending `'24:00'` as **0 hours** (found planning 32).
- After CANDIDATES.1: `coachConflictsForBlock` in `src/lib/schedule-overlap.js` (and its tests) is unused; delete with the old working-time route.
- CANDIDATES.1 reads leave and shifts with one unchunked `.in()` of member ids and AVAIL.1a's `readStudioAvailability` reads members unpaged; fine at 13 members, revisit before a large studio.
- The phone's `PersonalDashboard` shows "Could not load staff" when the staff read fails even though the ranked list arrived (pre-existing).
- The time-off summary report ignores a failed read and saves an empty report (found planning 11).
- In `ShiftTemplateManager.jsx` the warning after deactivating or reactivating a template is wiped by the list reload before it can show (found planning 12).
- No schedule range route checks that the start comes before the end; `allowances?year=` is not validated (found building 11).
- `resolveRoleRecipientIds` in `src/lib/push.js` discards its read error, so a failed read looks like a clean runway run with nobody to notify (found planning 31).
- Two dead staffing readers (`shared/dashboard-data.js` `fetchUnstaffedBlocksThisWeek`, `src/lib/roster.js` `isBlockUnstaffedFuture`) would treat an admin shift as a gap if revived; delete them (found reviewing 13).
- `src/lib/cron-heartbeat.js` docstring out of date (found building 31).
- 🔴 A shift block's MANAGER `notes` reach a coach's own phone row through `toApiShiftRow` (`notes: a.notes ?? b.notes`); COACHSCOPE.1 meant block notes as manager working notes. Check whether coaches should see them; BLOCKEDIT.1's briefing is the coach-facing field (found planning 14).
- Migration 633's header still says "apply before the code deploys"; the CLAUDE.md rule it added says after. Harmless (the file re-arms) but fix the header next time the file is touched.
- Delete the old `GET /api/schedule/working-time` route one deploy after CANDIDATES.1 ships (kept so open tabs keep working).
- An un-awaited `expect(...).resolves` in a test races the test's end and flakes CI (bit #1762 once). A lint rule (vitest `valid-expect` with `alwaysAwait`, or a guard test) would catch the class repo-wide.
- The staff assistant's `generate_report` tool passes model-supplied report periods unchecked (Postgres refuses a bad one; harmless) (found reviewing 11).
- The staff assistant's `create_shift` and `get_time_off` tools take dates with no calendar check (found planning 11; the assistant is off everywhere).

## Status log

Updated by the loop. Newest first.

- 25 Sep ~16:50Z: 19 CANDIDATES.1 = [PR #1766](https://github.com/ivers9307-cyber/un1t-crm/pull/1766): fix re-check APPROVED; gate 28,708 + build (one PGlite hook timed out under load, passes alone); auto-merge on (OTA). 20 REPLACE.1a fix re-check APPROVED (all 4 defects closed; the three older writers now pinned) → main merged + full gate running; merges after #1766's EAS run; **mig 640 right AFTER its deploy**. 32 SNAPSHOT.1 implementer started (`~/code/un1t-crm-snapshot1`). 21 GRID.1 fixes in progress.
- 25 Sep ~16:15Z: 35 LABOUR.1 plan written (web only, no mig, no route; server-rendered owner block on the Business dashboard; MRR revenue; salary/12 + contractor hours × rate). All batch 7–8 plans now written. 19 CANDIDATES.1 fixes done (published-only for the coach, "Free here", throwing reads, contract hours owner/manager/master) → fix re-check + full gate running. 21 GRID.1 fixes in progress. 20 REPLACE.1a fixes still in progress.
- 25 Sep ~16:00Z: ✅ #1765 AVAIL.2 EAS Update SUCCESS; worktree removed. 21 GRID.1 review: NOT APPROVED, one blocker (head coaches got contracted hours + admin balance via MANAGER_ROLES) + a stale-grid-under-new-dates should-fix → fixes queued for the next implementer slot (head coaches keep the grid with contract hidden). Review page v13.
- 25 Sep ~15:45Z: #1765 AVAIL.2 MERGED; EAS run watched. 21 GRID.1 built (12 commits, web only) → independent review. 34 ARRIVALSHOW.1 plan written (web + OTA, no mig; the check-in no longer writes the paid window since ARRIVAL.1/2, so display only; own rows only; server sends instants + studio-local strings, the phone does no tz maths). Worktrees avail1b + blockedit1 removed.
- 25 Sep ~15:35Z: 19 CANDIDATES.1 review: approved w/ should-fixes (coach-for-cover saw DRAFT shifts as 'Working then'; 'Free' said unqualified when the other studio couldn't be read; a throwing side read failed the request) → fixes in progress, plus contracted hours narrowed to owner/manager/master (default 25 rewritten).
- 25 Sep ~15:25Z: 33 QUALS.1 plan written (mig 635: org-level catalogue, one record per person per type, template requirements ≤5 with a same-org trigger; Schedule › Qualifications page; advisory picker badge via CANDIDATES.1; weekly digest arm on `contract-reminders` with its own `qualification-digest` row). **Correction: QUALS.1 publishes an OTA** (shared + a push toggle). At apply time re-run the heartbeat upsert right after the deploy (the arm rule), though its 36h budget makes the pre-deploy seed harmless.
- 25 Sep 14:15Z: ✅ #1764 BLOCKEDIT.1 EAS Update SUCCESS + prod deploy; **mig 639 APPLIED after the deploy**, `shift-time-changes` stamped by the 14:15Z tick with a clean outcome. BLOCKEDIT.1 DONE. #1765 AVAIL.2 brought up to date (3,307 mobile/shared tests), auto-merge on (next OTA). Review page v12.
- 25 Sep ~15:15Z: **#1764 BLOCKEDIT.1 MERGED** (14:04Z); EAS run + prod deploy being watched, then mig 639. 32 SNAPSHOT.1 plan written (mig 634 `roster_publish_snapshots`, immutable jsonb per publish; best-effort writer; compare route). 19 CANDIDATES.1 built (11 commits; picker now has one source of warnings) → main merged (dashboard select keeps `id` + `briefing`) → independent review. 20 REPLACE.1a review: approved w/ should-fixes (stamp failure resends + green heartbeat; three older writers not pinned to the read profile — incl. a PUT that could land A's paid window on B; notices for already-started shifts; a deleted slot loses A's notice) → fixes + mig 640 in progress. Batch 8 plans commissioned (34 ARRIVALSHOW.1, 35 LABOUR.1).
- 25 Sep ~14:35Z: 17 AVAIL.2 = [PR #1765](https://github.com/ivers9307-cyber/un1t-crm/pull/1765): gate 28,488 + build; fix check APPROVED; merges after #1764's EAS run (OTAs one at a time). 20 REPLACE.1a built (10 commits) → independent review. **Renumber:** 1a's arm heartbeat row `replace-notices` moves into its own mig 640 (applied after 1a's deploy, else the arm logs ~288 missing-row warnings/day); 1b's `shift_offers` becomes mig 641. 21 GRID.1 implementer started (`~/code/un1t-crm-grid1`). Handset item for Richard: an existing one-day availability card + a tap on a later day makes a range, by design — check it feels right.
- 25 Sep ~14:05Z: **#1763 AVAIL.1b MERGED** (web only, no EAS run, correct). 14 BLOCKEDIT.1 = [PR #1764](https://github.com/ivers9307-cyber/un1t-crm/pull/1764): gate 28,500 + build green; **mig 629 APPLIED** (post-checks: log counts unchanged 148/6/165, action check widened, advisors unchanged); main merged after #1763 (clean, union CHANGELOG), targeted re-test running, auto-merge on. **Mig 639 is owed right AFTER #1764's prod deploy.** 17 AVAIL.2 fixes done (first tap = that day; cards locked while saving; 4 nits) → full gate running. 19 CANDIDATES.1 implementer started (`~/code/un1t-crm-candidates1`; told to absorb AVAIL.1b's client-side picker badge into the server ranking). 21 GRID.1 waits for a slot.
- 25 Sep 13:37Z: ✅ `availability-notice-sweep` verified live (stamped 13:30:38Z, clean outcome). 16 AVAIL.1b = [PR #1763](https://github.com/ivers9307-cyber/un1t-crm/pull/1763) (gate 28,381 + build; web only), auto-merge on. 17 AVAIL.2 built (8 commits; started rules match the web editor) → in review. 20 REPLACE.1a implementer started (`~/code/un1t-crm-replace1a`). BLOCKEDIT.1 third check approved w/ small should-fixes → final small round.
- 25 Sep ~13:30Z: 20 REPLACE.1 plan written (1a replace; 1b offer-to-team with a new `shift_offers` table, not the swap table; mig 640 also seeds 1a's held-notice arm heartbeat; 14 open questions in the plan). Batch 7 plans commissioned (32 SNAPSHOT.1, 33 QUALS.1). BLOCKEDIT.1 third round landed → short third check.
- 25 Sep 13:25Z: #1762 AVAIL.1a EAS Update SUCCESS; prod deploy 13:21Z. VERIFY at the next tick: `availability-notice-sweep` stamped by the 13:30Z checklist-sweep (stale threshold 13:41Z; re-run mig 630's heartbeat insert if not). AVAIL.1b: resolved a 1a test conflict by taking main's copy; diff vs main = 15 1b files only; full gate re-running.
- 25 Sep ~13:35Z: **#1762 AVAIL.1a MERGED**; EAS run watched. AVAIL.1b merging main + full gate. 17 AVAIL.2 implementer started (`~/code/un1t-crm-avail2`). 21 GRID.1 plan written (new `GET /api/schedule/grid`, contracted hours from the `profiles` copy by name, pure `roster-grid-model.js`). BLOCKEDIT.1 second review approved w/ should-fixes (form captured opened values each render → could still undo another manager; template min/max propagation; ended-today shifts) → third round.
- 25 Sep ~13:12Z: #1762 AVAIL.1a CI failed on ONE test: an un-awaited `expect(...).resolves` raced the test's end (code fine). Awaited, pushed `7998cb03`, auto-merge still on. BLOCKEDIT.1 fixes all landed (incl. mig 639 heartbeat) → second full review. AVAIL.1b fixes landed (waits for #1762 to rebase onto main).
- 25 Sep ~13:15Z: **#1761 ICSFEED.1 MERGED** (12:51Z), EAS Update SUCCESS. ✅ **MIG 630 APPLIED** (post: 0 browser privileges, RPC exec service_role only, heartbeat 900+1800, 6 indexes; perf advisors only INFO unused_index on the new tables; rollback record `mig630-rollback-2026-09-25.txt`). 16 AVAIL.1a = [PR #1762](https://github.com/ivers9307-cyber/un1t-crm/pull/1762) (gate 28,189 + build; 2 more main merges resolved: openapi + guardrail config), auto-merge on — check its EAS run. AVAIL.1b review approved w/ 3 editor should-fixes → fixing.
- 25 Sep ~13:15Z: 🔴 14 BLOCKEDIT.1 review **NOT APPROVED**: (1) an edit could leave a coach with an end-before-start window that payroll pays as 23.5h; (2) the two-manager overwrite guard never fired (form sent no baseline). Should-fixes: notices silent for started/early shifts, no double-booking warning on a move, a template edit undid one-off edits. All sent back with decisions (refuse invalid windows 409; `expected` baseline; judge started on the old start; overlap warning; template PUT only rewrites un-edited blocks; past-shift edits need confirmation) plus the arm heartbeat (mig 639). AVAIL.1b rebased + in review. AVAIL.1a re-gating after an openapi conflict.
- 25 Sep ~13:05Z: 19 CANDIDATES.1 plan written (one endpoint `GET /api/schedule/blocks/[id]/candidates`, two audiences; `shared/candidates.js` ranking; replaces WORKTIME's per-open picker GET; old working-time route kept one deploy then deleted as a follow-up; Task 0 waits for AVAIL.1a/1b).
- 25 Sep ~13:00Z: 22 ICSFEED.1 = [PR #1761](https://github.com/ivers9307-cyber/un1t-crm/pull/1761) (gate 28,163 + build; mig 632 already applied), auto-merge on — check its EAS run before the next OTA. 16 AVAIL.1a third check APPROVED (duplicate-not-loss holds; no starvation; `gave_up` logged) → full gate running; mig 630 before merge; merges after #1761's EAS. AVAIL.1b rebasing onto final 1a + main.
- 25 Sep ~12:50Z: 14 BLOCKEDIT.1 built (14 commits, mig 629, 805 tests; fixed the plan's `btrim()` blank check, a newline-only briefing slipped past it), in independent review. Its new notice arm gets its OWN heartbeat row in a separate mig **639** (applied after the deploy, per the arm rule; 629 must go before). AVAIL.1a round-3 fixes landed (fully-deduped attempts don't stamp; sweep re-reads before sending; `carryStartedRules`; give-up after 4 retries = `gave_up`), short third check running. Batch 6 plans commissioned (20 REPLACE.1 — uses mig 640 if needed; 21 GRID.1).
- 25 Sep ~12:40Z: 17 AVAIL.2 plan written (modal from the Schedule tab Me view; reuses the leave form's MonthCalendar; typed times; no native module → pure OTA; save blocked until a load succeeded; tap on the managers' notice opens Manage mode). Waits for AVAIL.1a to merge.
- 25 Sep ~12:33Z: ✅ **MIG 632 APPLIED** (`staff_calendar_feeds`): pre (a)–(d) as expected; post 5 cols, RLS on, 0 policies, grants postgres + service_role only, 4 constraints, 0 rows; advisors +1 INFO by design (48 INFO + 2 WARN). Rollback record `mig632-rollback-2026-09-25.txt`. ICSFEED.1 fixes landed (phone always offers Share/copy link; last-fetched keyed by token; DST-day tests; SEQUENCE), full gate running.
- 25 Sep 12:30Z: ✅ HEARTBEAT.1 verified live: `shift-reminders` stamped by the */5 cron at 12:25Z with its counters in `last_outcome`; `roster-runway` first real stamp due 26 Sep 08:00Z. 22 ICSFEED.1 review approved w/ should-fixes (phone could lose the one-time link on Android; last-fetched keyed by person not token; DST-day tests; SEQUENCE for Outlook) → fixing; **mig 632 must be applied BEFORE its merge** (the /api/me route 500s without it). AVAIL.1a second review → 3 more should-fixes (fully-deduped attempt must not stamp; re-read owed rows before the sweep sends; shortening a started rule handled server-side) → fixing.
- 25 Sep 12:20Z: **#1760 HEARTBEAT.1 MERGED** (12:18Z), prod deploy success, then ✅ **MIG 633 APPLIED**: `shift-reminders` (300+900) and `roster-runway` (86400+43200) present, not stale. Rollback note in scratchpad `mig633-rollback-2026-09-25.txt`. To verify at next tick: the */5 cron stamps `shift-reminders` with a `last_outcome`. Follow-up: 633's file header still says "apply BEFORE the code deploys" (contradicts the new CLAUDE.md line; harmless because the file re-arms).
- 25 Sep ~13:45Z: 31 HEARTBEAT.1 = [PR #1760](https://github.com/ivers9307-cyber/un1t-crm/pull/1760) (gate 28,025 + build), auto-merge on; mig 633 AFTER its deploy. AVAIL.1a: all 7 review fixes landed (retry key makes a crashed notice a duplicate not a loss; immediate path folds owed changes; elapsed days kept; no backdating; actor excluded) → focused second review. 14 BLOCKEDIT.1 implementer started (`~/code/un1t-crm-blockedit1`).
- 25 Sep ~13:35Z: #1759 SHIFTTYPE.1 EAS Update run 36132835551 SUCCESS. Operator step now open for Richard: mark admin templates once phones have taken the update.
- 25 Sep ~13:30Z: 14 BLOCKEDIT.1 plan written (PUT /api/schedule/blocks/[id] with optimistic concurrency; mig 629: `shift_blocks.briefing` ≤500 + change-log `block_edited`; notices via a new send-push-reminders arm, 07:00–22:00; OTA). Queued for the next implementer slot.
- 25 Sep ~13:25Z: 16 AVAIL.1a review approved w/ should-fixes: a crash between claim and send could LOSE a manager notice (invariant (c)), and an older owed notice could land after a newer one → fixing (+ keep elapsed days of a shortened rule, refuse backdated rules, never notify the actor). AVAIL.1b built (4 commits, 180 tests), waiting to rebase on fixed 1a + main (SHIFTTYPE/WORKTIME); browser-only checks owed (grey bar vs leave bars, 390px editor, native date inputs).
- 25 Sep ~13:15Z: **#1759 SHIFTTYPE.1 MERGED** (auto-merge, CI green); its EAS run being watched. 22 ICSFEED.1 plan written (feed on the proxy's public list only — an API route, not a page; UTC times; 503 never an empty calendar); implementer started (`~/code/un1t-crm-icsfeed1`). Operator step now due for Richard: mark admin templates once the phone update reaches phones.
- 25 Sep ~13:05Z: **#1758 WORKTIME.1 MERGED** (11:47Z), EAS Update run 36131346625 SUCCESS. 13 SHIFTTYPE.1 = [PR #1759](https://github.com/ivers9307-cyber/un1t-crm/pull/1759) (gate 27,887 + build; merged with WORKTIME, 1 test conflict kept both, 588 affected tests green), auto-merge on; check ITS EAS run before any other OTA merge.
- 25 Sep ~13:10Z: 31 HEARTBEAT.1 review APPROVED (no defects); I corrected its CLAUDE.md line. Ops rule: apply mig 633 right AFTER the prod deploy (a row seeded early goes stale in 20 min if CI is slow). Queued for gate after SHIFTTYPE.1. 16 AVAIL.1a built (8 commits, mig 630, 430 tests), in independent review. AVAIL.1b implementer started, stacked on `avail-1a` (`~/code/un1t-crm-avail1b`). SHIFTTYPE.1 re-gating after resolving 2 test-file conflicts with DATECHECK.1.
- 25 Sep ~12:45Z: ✅ **MIG 628 APPLIED** (`628_shift_template_kind`). Pre-checks (a)–(e) as expected; post (f) `text | NO | 'class'`, (g) 23 class, (h) both CHECKs, (i) true,true; security advisors unchanged (47 INFO + 2 WARN). Rollback record: scratchpad `mig628-rollback-2026-09-25.txt`. SHIFTTYPE.1 review nits fixed, full gate running; merges after #1758's EAS Update succeeds.
- 25 Sep ~13:35 IST: **#1757 DATECHECK.1 MERGED** (11:33Z). 15 WORKTIME.1 = [PR #1758](https://github.com/ivers9307-cyber/un1t-crm/pull/1758) (gate 27,838 + build; main merged in cleanly), auto-merge on; **check its EAS Update run before SHIFTTYPE.1 merges** (both publish).
- 25 Sep: 13 SHIFTTYPE.1 review approved w/ should-fixes (4 UI nits → fixing). HARD GATE before its merge: mig 628 applied and in `list_migrations` (every roster read names `kind`). 31 HEARTBEAT.1 built (mig 633, DO UPDATE re-arm), in review.
- 25 Sep: 16 AVAIL.1 plan written, split 1a (mig 630, API, notice, sweep arm, OTA) / 1b (web). AVAIL.1a implementer started (`~/code/un1t-crm-avail1a`). WORKTIME.1 fixes done, in my gate. Batch 4 plans (14 BLOCKEDIT.1, 22 ICSFEED.1) commissioned.
- 25 Sep ~12:25 IST: **#1756 TPLCLONE.1 MERGED** (11:18Z). 11 DATECHECK.1 = [PR #1757](https://github.com/ivers9307-cyber/un1t-crm/pull/1757) (gate 27,730 + build; 2 review rounds; main merged in, one openapi.test.js conflict kept both), auto-merge on. 15 WORKTIME.1 review approved w/ should-fixes (picker loading state, 2027 spring-forward test, `24:00` end time) → fixes in progress. 31 HEARTBEAT.1 implementer started (`~/code/un1t-crm-heartbeat1`). Review artifact v7 (status table, 15 review items, follow-ups section).
- 25 Sep: 11 DATECHECK.1 fixes landed (reports now refuse a reversed period or one over 366 days, checked in the route and again in `generateReport`; guard tightened; GET /blocks and GET /overview newly in the API docs). Short second review running. 13 SHIFTTYPE.1 implementer started in `~/code/un1t-crm-shifttype1`.
- 25 Sep: 31 HEARTBEAT.1 plan written (arms ride `send-push-reminders` every 5 min and `contract-reminders` daily; mig 633 rows `shift-reminders` and `roster-runway`; build will use `ON CONFLICT DO UPDATE` like migs 601/623 so a slow deploy cannot page). Queue for the next two slots: 13 SHIFTTYPE.1, then 31 HEARTBEAT.1.
- 25 Sep: 12 TPLCLONE.1 = [PR #1756](https://github.com/ivers9307-cyber/un1t-crm/pull/1756): review approved (no defects), 4 dialog nits fixed, gate green (27,751 tests + build), auto-merge on.
- 25 Sep: 13 SHIFTTYPE.1 plan written (14 tasks; `kind` on templates only; mig 628 with a DB CHECK that admin min = 0; admin priced at €0 in the one contractor-cost function; phone Manage chip gets an admin state). Waiting for an implementer slot.
- 25 Sep: 11 DATECHECK.1 review: approved with should-fixes. Real defect caught: a roster-coverage report to 9999-12-31 would walk ~2.9M days and hang (reports will be capped at 366 days). Fixes in progress.
- 25 Sep: 15 WORKTIME.1 plan written (rule in `shared/working-time.js` for the phone later; employees = `employment_type = 'fte'`; no pay read); implementer started in `~/code/un1t-crm-worktime1`. Merges after SHIFTTYPE.1's update run (both publish).
- 25 Sep: 12 TPLCLONE.1 built (9 commits, 226 targeted tests; copies land as "One-off" templates unless weekdays are ticked). In independent review. Batch 3 plans (16 AVAIL.1, 31 HEARTBEAT.1) commissioned.
- 25 Sep: 11 DATECHECK.1 built (10 commits, 32 tests; `week-cost` and `contractor-spend` used to answer 200 for 30 Feb with March's figures). In independent review.
- 25 Sep: 12 TPLCLONE.1 plan written (no migration: the unique (studio, name) key already exists); implementer started in `~/code/un1t-crm-tplclone1` with weekdays NOT copied by default (default 10).
- 25 Sep: 11 DATECHECK.1 plan written (10 routes; `blocks` GET, `shifts` GET and the time-off list had no date check at all; `week-cost`/`contractor-spend` answered 200 for the wrong period); implementer started in `~/code/un1t-crm-datecheck1`.
- 25 Sep: plan index written. Batch 1 and 2 detail plans commissioned.
