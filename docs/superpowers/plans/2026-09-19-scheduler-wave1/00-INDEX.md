# Scheduler Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loops around a roster engine that is already trustworthy: copying respects leave, coaches get reminded, cover requests reach people who can take them, an unbuilt week gets noticed, post-publish changes are readable, leave on the phone is honest, deleting a staff member keeps history, and the roster page shows shifts without scrolling.

**Architecture:** Ten independent pull requests, one file each in this folder. Every decision lives in a pure, table-tested helper; routes and components stay thin. No new tables: one CHECK widened (mig 619) and one tombstone migration (mig 622). Cron work rides existing crons as extra arms, reusing their heartbeats. Mobile changes are JS-only and ship by OTA on merge.

**Tech Stack:** Next.js 16 (App Router), Supabase Postgres (service-role API routes, forward-only migrations applied by the operator through the Supabase MCP), Vitest, Tailwind, Expo/React Native (SDK 57) with EAS Update.

**Source:** product review of 19 Sep 2026, https://claude.ai/artifact/WnVXQtZKMSD7zFG2FrUdf5 (main @ `8231d438`).

---

## Owner decisions this plan is built on (19 Sep 2026, do not reopen)

1. **Permanent staff delete** removes the person from UPCOMING shifts only. History stays, and stays reportable by name. (PR 09)
2. **Roster look:** keep the day-column cards, polished, plus five changes: one toolbar row, Studio Overview folded into day headers, neutral cards with colour kept for status and the future class/admin split, staffing numbers only when short, coach names in month view. The time-grid rewrite was rejected. (PR 10)
3. **Wave 2, recorded here so Wave 1 does not block it:** availability is self-declared with no approval and managers are notified of changes; roster scope is the hybrid (class shifts plus only the admin that needs a time and a person, the rest an unplaced balance); the rostered coach's name on customer screens is an operator toggle, off by default. PR 10's `cardTone(block)` hook exists for the admin type; nothing else in Wave 1 depends on these.
4. Standing rules: coaches never see drafts, never set their own hours; arrival never changes pay; contractors are paid on their invoice; rates never reach the browser; `rosters` is column-granted.

## The ten PRs

| # | Code | What it delivers | Ships | Tasks |
|---|---|---|---|---|
| 01 | COPYLEAVE.1 | Copy week/month skip coaches on approved leave and say so; publish preview lists leave clashes and double bookings (other studio included), advisory | web | 10 |
| 02 | HOLIDAYLEAVE.1 | Bank holidays and studio holidays are not charged as holiday leave; operator-run correction for existing 2026 rows | web + operator SQL | 6 |
| 03 | CHANGELOG.1 | "Changes since publish" drawer from the Published chip | web | 6 |
| 04 | SHIFTREMIND.1 | One reminder per shift: 20:00 the evening before for starts before 08:00, otherwise 2 hours before | **mig 619** + web + OTA | 7 |
| 05 | RUNWAY.1 | Chip and one push when a week inside 10 days is unpublished or has uncovered shifts | web + OTA | 9 |
| 06 | COVERLOOP.1 | Open swaps go to every coach who could take them; managers re-pushed at T-48h and T-12h; started or orphaned swaps closed | web | 7 |
| 07 | COVERLOOP.2 | Phone swap flow: working push tap, times on cards, confirm + reason, claim warnings, "Swap pending" chip, Studio rows open the approval | web + OTA | 10 |
| 08 | LEAVEPHONE.1 | Phone leave form shows balance, days charged (server's number), own clashing shifts, confirmation, "My leave" list | web + OTA | 9 |
| 09 | STAFFDELETE.1 | Permanent delete becomes a tombstone: future shifts removed, history kept by name, PII stripped, auth user banned | **mig 622** + web | 8 |
| 10 | ROSTERLOOK.1 | The roster page clean-up (decision 2) plus the `/schedule` tab-title fix | web | 19 |

Migration numbers 620 and 621 were reserved for 05 and 06 and are NOT used. The next free number after this plan is 623 (check `supabase/migrations/` first; duplicate prefixes exist on purpose elsewhere).

## Merge order

Three chains share files. Inside a chain, merge serially and rebase the next PR onto the new `main` before its gate. Across chains, anything goes.

```
Chain A  (src/components/ScheduleCalendar.jsx)      01 ──▶ 03 ──▶ 10
Chain B  (src/lib/time-off-days.js, time-off route) 02 ──▶ 08
Chain C  (mobile/lib/notification-nav.js,           04 ──▶ 05 ──▶ 07 ──▶ 08
          mobile/app/(staff)/(tabs)/schedule.jsx)
Free                                                 06, 09
```

- **08 is last in both B and C.** It displays the day count the server computes with 02's four-argument `countLeaveDays(type, startIso, endIso, nonWorkingDates)`; it must not be built against the three-argument rule.
- **10 is last in A.** It moves the publish-state chip into the toolbar without rewriting it; 03's drawer anchors on that chip.
- `src/lib/openapi.js` is appended to by 01, 02, 03, 05, 07, 08. Conflicts there are additive: keep both sides.
- `src/lib/notifications-registry.js`, `src/lib/push.js`: 04, 05, 06 each add entries. Additive.

## Recommended build order (value and urgency first)

1. **01 COPYLEAVE.1** — the October roster is about to be built (on 19 Sep the week of 28 Sep had 0 of 34 shifts staffed), and Copy Last Month is how it gets built.
2. **09 STAFFDELETE.1** — the only item where doing nothing risks irreversible loss.
3. **02 HOLIDAYLEAVE.1**, then **04 SHIFTREMIND.1**.
4. **06 COVERLOOP.1**, then **07 COVERLOOP.2**.
5. **05 RUNWAY.1**, **03 CHANGELOG.1**.
6. **08 LEAVEPHONE.1**, then **10 ROSTERLOOK.1**.

Two implementers at a time is the ceiling on the 8GB machine. Good pairs (no shared files): 01 + 09, 02 + 04, 06 + 05, 03 + 07, then 08, then 10.

## Rules for every PR

- **Fresh worktree per PR**, branched from `origin/main`: `git fetch origin main && git worktree add ../un1t-crm-<code> -b <code> origin/main`, then `npm ci`. Never reuse a worktree, never `git stash`. This plan's own worktree has no `node_modules`.
- **Tests:** `npx vitest run <file>` one file at a time while building; the full suite and `npm run build` only at the PR gate. A test that `waitFor`s a bug to stop happening hides the bug. jsdom cannot see layout.
- **`check:select-columns`** fails CI on a `.select()` naming a column that does not exist. Verify against `supabase/migrations/`, not memory.
- **Independent review is mandatory** on 06, 07, 09 (auth, RLS-adjacent, migration, who-gets-notified). On the 16 to 18 Sep round reviewers sent four such PRs back.
- **The repo is public.** No real names, emails or phones in fixtures (`tests/fixture-pii.test.js` guards it).
- **Never edit a pushed `docs/CHANGELOG.md` row** (`merge=union` duplicates it). Add the row after the PR is opened.

## Operator steps (not code)

| When | Step |
|---|---|
| Before merging 04 | Apply `619_push_reminder_sends_shift.sql` via the Supabase MCP to project `iyvtbjjxdggiadzwwvdj`, then `get_advisors` (security). Safe alone. |
| Merging 04 | No merge-time restriction: the arm never sends outside 07:00 to 22:00 Dublin (see Amendments). Apply mig 619 first. |
| Before merging 09 | Run the PRE-APPLY queries in the header of `622_staff_tombstone.sql`, apply it, `get_advisors`. **Code alone is NOT safe:** reads wrapped in `excludeTombstones()` 400 on the missing column. |
| After deploying 02 | Run Task 5's dry-run SELECT, read the rows, then the single data-modifying CTE. A bare `begin;` without `commit;` in the MCP rolls back. |
| Merging 04, 05, 07, 08 | Each merge **publishes an OTA at 100%**. Merge them one at a time; open the EAS Update run and confirm SUCCESS and the runtime lane before merging the next. A partial rollout blocks the next publish. |
| After 10 deploys | Browser verification (Task 18): 1280 and 390 wide, in a real logged-in Chrome session, using the same-origin fixed-width iframe (a maximised Chrome window ignores resize). |

## Verification owed at the end of the wave

- Web: leave-skipping toast on Copy Last Month; publish preview advisories; change-log drawer; roster page at 1512x786 shows shifts on load.
- Phone (the only proof for OTA work): a shift reminder arrives and its tap opens the right day; the open-pool push tap opens the card; a targeted swap asks for confirmation; the leave form shows balance, days and clashes; the runway chip opens the right week.
- Data: after 09, a tombstoned test profile appears in no picker and still appears by name in a past `staff_cost` report.

## Not in this wave

- Coach availability, ranked candidates, Replace / Offer to team, coach-by-day grid, per-block edit and coach-visible note, ICS feed, working-time advisories, clone templates, the admin template type (Wave 2).
- Class-timetable link, late and no-show alerts (gated on geofence coverage, 19% today), labour against revenue, publish snapshot, qualifications (Wave 3).
- Found while planning, tracked separately: three equipment pushes pass a double-prefixed category and are suppressed for everyone but masters; the browser tab title is wrong estate-wide (root layout takes the first `company_settings.company_name` by `location_id`; PR 10 fixes `/schedule` only); `getCurrentUser()` ignores `profiles.active`; the staff assistant's `get_shifts_for_week` uses template times and no published filter (latent, assistant is off everywhere).

## Amendments after the plan was written

**20 Sep, PR 09 STAFFDELETE.1 (found by the implementer before any code was written; these override the text of `09-STAFFDELETE.1.md`):**

1. **A tombstone does not keep its role.** `private.auth_is_master()` / `auth_role()` (mig 051) and dozens of inline policies decide from `profiles.role` alone, so a tombstoned master or owner whose login survives (`kept_*_login`, or a failed ban) would stay a master at the RLS layer. `tombstone_staff_profile()` therefore copies `role` into a new `deleted_role text` column and sets `role` to the least-privileged allowed value, in the same transaction. Readers the plan already touches use `deleted_role ?? role` for history.
2. **"Upcoming" means not started, not "today or later".** The function takes `p_now timestamptz default now()` and removes an assignment only when `block_date` is after Dublin today, or is today with an effective start (`coalesce(start_time_override, shift_blocks.start_time)`) later than Dublin local time. A shift in progress or already worked today is history and stays, so `staff_attendance_events.matched_assignment_id` is never unlinked from a worked shift. The preview lists kept-today shifts separately.

**20 Sep, PR 04 SHIFTREMIND.1 (rule amended after the first build; overrides "The rule" in `04-SHIFTREMIND.1.md`):**

1. **Nothing fires before 07:00 Dublin.** The evening-before branch (20:00 the evening before) applies to any start before 09:00, not 08:00. A 09:00 start is reminded at 07:00.
2. **One reminder per run, not per shift.** A coach's live published shifts on a Dublin date, across all studios, are grouped into runs (a shift joins the run when it starts no more than 120 minutes after the run's latest end). Only the first shift of a run carries a reminder, and the body describes the whole run. A split day gives two reminders. The ledger claim stays keyed on the first shift's (assignment, coach).
4. **Quiet hours are absolute (added after the safety review).** A shift reminder may only be SENT while the Dublin wall-clock is within 07:00 to 22:00, whatever the fire time says; outside it the arm returns before any read. A run that could not be reminded before 22:00 (published or assigned late, or delivery failing) gets no reminder for a start before 07:30; the assign/publish push already told that coach. This replaces the operator instruction to merge between 08:00 and 20:00, which is no longer needed.
3. **Half-day leave does not suppress a reminder.** Approved leave skips only when it covers the whole day (a single-day request with `total_days < 1` does not skip).

**20 Sep, PR 09 STAFFDELETE.1, after independent review (in addition to the two items above):** an assignment with an arrival (`arrived_at` or a matched attendance event) is history and stays; Copy Last Week/Month drop anyone without an active membership at the target studio (`skipped_not_at_studio`); triggers refuse un-tombstoning and refuse re-adding a tombstone to `profile_locations` / `profile_organizations`; the auth step is retryable and its disposition is recorded; the person's address is removed from `scheduled_reports.email_recipients`; audit rows lose only PII keys; and mig 622 revokes the vestigial INSERT/UPDATE/DELETE/TRUNCATE grants `anon` and `authenticated` hold on `public.profiles` (verified on prod 20 Sep; no client code writes that table).

**20 Sep, PR 01 COPYLEAVE.1, after review:** the other-studio double-booking read is limited to sibling studios in the same organisation; advisories run on the dry run only, never on the real publish or an approval.

## Self-review record (19 Sep)

- Spec coverage: every Wave 1 item in the review and all six live defects map to a PR, except the assistant tool (latent, listed above).
- Placeholder scan across all ten files: clean.
- Cross-PR consistency: one mismatch found and fixed (08 was written against 02's pre-change day-count rule). 04 corrected the brief: `swapped` assignments are live and ARE reminded; only `cancelled` is skipped.
- Execution status: 04, 05 and the pure parts of 08 and 09 were run red-then-green in a scratch sandbox by their authors. 01, 02, 03, 06, 07, 10 were verified by reading only; expect small corrections on first run.
