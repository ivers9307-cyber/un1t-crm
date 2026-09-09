# Roster v2 — shift template restructure

> Reference doc extracted from CLAUDE.md on 2026-06-01. All phases shipped May 2026. See CLAUDE.md for the day-to-day conventions that reference this feature.

Active roadmap (May 2026). The schedule today is shift-as-coach-row: a template is "a thing a coach does", and editing the schedule means moving coach rows around. Roster v2 inverts that — templates become **demand windows** ("9:30–10:30 mon–fri, up to 15 coaches"), and the schedule is the **fulfilment layer** where operators assign coaches into those windows week by week.

### The model

```
shift_template
  ├─ start_time, end_time
  ├─ days_of_week text[]               ← new (e.g. {mon,tue,wed,thu,fri})
  ├─ max_coaches smallint default 15   ← new, configurable per template
  └─ location_id

shift_block (instance of a template on a specific date)
  ├─ template_id
  ├─ location_id
  ├─ date
  ├─ start_time, end_time              ← snapshot from template at generation time
  ├─ max_coaches                       ← snapshot
  └─ roster_id                         ← phase 5

shift_assignment (n:m — multiple coaches per block)
  ├─ block_id
  ├─ profile_id
  └─ created_at, created_by

profile (extended in phase 3)
  ├─ employment_type 'fte' | 'contractor'
  ├─ contracted_weekly_hours numeric   ← FTE only (CHECK)
  └─ hourly_rate numeric

locations (extended in phase 4)
  └─ monthly_contractor_budget_eur numeric

rosters (phase 5 — the publish-state container)
  ├─ location_id, period_start, period_end
  ├─ status 'draft' | 'published'
  ├─ published_by, published_at
  └─ over_budget_approval_by, over_budget_approval_at
```

A block exists once the template + date combination becomes a candidate week — even with zero assignments. **An empty block is a problem to flag, not a row to suppress.** Customers will be in the studio either way; the system has to surface "no coach is going to be here for the 9:30 class" loud and early.

### Locked decisions (don't re-derive)

- **FTE is sunk cost.** FTE coaches don't count against the contractor budget. The whole point of an FTE is that they're paid whether or not they coach a specific session — costing their shifts in euros against a budget creates the wrong incentive ("don't roster Sarah, she's expensive"). FTE side is tracked in **hours utilisation** (allocated / contracted), not euros.
- **Contractor euros are the only number that hits the budget.** `monthly_contractor_budget_eur` on the location is a **ceiling** for the variable spend. Calc: sum(contractor block hours × hourly_rate) for the month being viewed.
- **One budget field, not two.** No FTE budget. The FTE target is implicit ("get to 100% utilisation of contracted hours where possible").
- **Default capacity = 15.** Not magic — just "high enough that any conceivable all-hands shift fits". Configurable per template, no hard cap.
- **Empty-block flag = red marker on the calendar cell + count badge on the Today tab for managers/owners.** Operators and coaches don't get the alert. The alert addresses owner/manager liability; staff can't fix it.
- **Publish gate is owner-only when over budget.** Manager can publish a draft if projected contractor spend ≤ budget. Over budget → owner approval required, recorded on the roster row (who, when).
- **Leave is phase 6.** Until then, FTE availability = `contracted_weekly_hours`, leave-blind. Don't try to derive leave from whatever ad-hoc system exists today.

### Phase plan

| Phase | Scope | Migrations | Ships independently? |
|---|---|---|---|
| 1 | Data model: `shift_templates.days_of_week`, `shift_templates.max_coaches`, new `shift_blocks` + `shift_assignments` tables. Backfill: each existing shift → block + 1 assignment. RLS mirrors current shift policies. | 067 | ✅ shipped May 2 2026 |
| 2 | Template editor (multi-day picker + capacity field). ScheduleCalendar renders blocks with "n / max" badge + red marker on empty future blocks. Coach assign/unassign popover. Today-tab unstaffed-block badge for owner/manager. Bidirectional sync trigger (mig 068 forward + mig 069 reverse, both guarded by `pg_trigger_depth()`) keeps `public.shifts` mirrored from new writes so mobile + reports + swap-requests + copy-week + copy-month all keep working unchanged during cutover. | 068, 069 | ✅ shipped May 2 2026 |
| 3 | Profile employment fields (`employment_type`, `contracted_hours_per_week`, `hourly_rate`, `overtime_rate`, `annual_salary`). The columns pre-existed from an earlier payroll pass — phase 3 added the CHECK constraint enforcing `employment_type ∈ {fte, contractor}`, set NOT NULL with default `'fte'`, and added `fetchIncompletePayProfiles()` + a manager-facing completeness chip on the Today tab so phase 4's cost calc isn't silently zero-costing incomplete profiles. | 070 | ✅ shipped May 2 2026 |
| 4 | Week summary panel below ScheduleCalendar: per-coach FTE utilisation bars, contractor euro spend (visible month) vs `monthly_contractor_budget_eur`, FTE implicit-cost context, status-coloured rows (overtime / on-target / underused / no_contract), missing-pay-data warning. Read-only / advisory. | 071 | ✅ shipped May 2 2026 |
| 5 | `rosters` table + draft/published state. New `<PublishRosterModal>` shows the budget impact preview (via `dry_run=true` on POST /rosters), then commits via the same endpoint. Owner publishing over budget can confirm with `force_over_budget=true` (records self-approval). Manager publishing over budget creates a `draft` and emails location owners; approval lives at `/schedule/approvals` (calls POST /rosters/[id]/approve). | 072 | ✅ shipped May 2 2026 |
| 6 | Leave-aware FTE availability. `leaveHoursInWeek()` walks weekdays in the overlap of approved `time_off_requests` and the visible week, deducts `(contracted_hours_per_week / 5)` per weekday from the utilisation denominator. New `on_leave` status flags coaches rostered during full-week approved leave (loudest red, sorts to top). Phase 4 callers that don't pass `timeOff` keep their original behaviour. | — | ✅ shipped May 2 2026 |

### Open questions to revisit at each phase boundary

- **Editing a template's `days_of_week`.** Phase 1 default: only future blocks (date >= today) regenerate; past blocks freeze. Confirm at phase 2 when the editor lands.
- **Coach in multiple blocks at the same time.** Phase 2 should warn ("Sarah is already on the 9:30 Hatch block this morning") but not hard-block — sometimes a coach floats across two studios on adjacent slots.
- **Block-level capacity override.** Phase 1 stores `max_coaches` on the block as a snapshot of the template at generation time. Whether a specific block can be overridden post-generation (e.g. drop one Friday's max from 15 → 8) is a phase 2 UX call.

### Conventions

- All Roster v2 migrations land between mig 067 and mig 070 — reserve those numbers now so we don't fight for them mid-phase.
- Profile employment fields go on `profiles`, not `profile_locations` — a coach's `hourly_rate` follows them across studios. (If a coach is paid differently at different studios, that's phase 3.5 and we'll add `profile_locations.hourly_rate_override`.)
- `shift_blocks` is the new source of truth for the schedule. Anything that today queries `shifts` (reports, mobile schedule view, Today tab) will be pointed at `shift_blocks` + `shift_assignments` joined back to profiles. Do this in phase 1 alongside the migration so there's never a moment where two readers disagree.
- `over_budget_approval_by` on the roster row is the audit trail for the May 1-style "why did we spend €X over budget last month?" question. Keep it forever; never null-out.

## Tier 1 enhancements (2026-06)

Closing the "coaches are out of the loop" gap surfaced in the schedule review — the roster had been operator-facing only. All shipped; see `docs/CHANGELOG.md` #214–217.

- **Notify coaches at publish** (#265) — `POST /api/schedule/rosters` calls the existing `notifyStaffOfPublish()` with the just-published shifts, so each coach gets one push summarising their shifts. Fixed a real gap: the common under-budget / owner-self-publish path flipped `shifts.published` but notified nobody.
- **Double-booking advisory** (#266) — `src/lib/schedule-overlap.js#timeRangesOverlap`; warns (doesn't block, same posture as the time-off advisory) when an assignment overlaps another shift the coach is already on that day, at ANY location. Surfaced in the assign / bulk-assign `warnings` array.
- **Post-publish change log + re-notify** (#268, mig 236) — `roster_change_log` audits edits to an already-published roster; a re-publish re-notifies ONLY the coaches who changed since the last publish (`notified_at` flag), not everyone. Helpers in `src/lib/roster-change-log.js`; logging hooked into single-assign, bulk-assign, unassign DELETE (manager removals only), and the time-override PUT.
- **Unpublished-changes exit guard** (#269) — `ScheduleCalendar` warns before leaving with unpublished edits (`beforeunload` + capture-phase in-app link interception); the dirty flag is set by every edit and cleared on a successful publish.

## Legacy `public.shifts` retirement (in progress)

The original plan (Conventions above) was to point every `shifts` reader at the new tables in phase 1. Instead, the **mig 068/069 bidirectional mirror triggers** kept `public.shifts` in sync during cutover. The mirror is now being retired so the table + triggers can be dropped. Phased — the mirror stays live until the final step, so nothing breaks mid-migration:

1. **Reports** — ✅ shipped (#270, RETIRE-SHIFTS-MIRROR.1). `src/lib/report-generator.js` reads `shift_assignments` + `shift_blocks` via `fetchScheduledShiftRows()`, normalised back to the legacy shift shape so report output is unchanged.
2. **Dashboards** — ✅ shipped (#272, RETIRE-SHIFTS-MIRROR.2). `fetchPersonalDashboardData` / `fetchBusinessDashboardData` in `shared/dashboard-data.js` via a local `fetchDashboardShifts` helper; `published` derives from `block → roster`.
3. **Assistant readers** — ✅ shipped (RETIRE-SHIFTS-MIRROR.3). `get_shifts_for_week` + the inline staff_hours / staff_cost report tools in `src/app/api/assistant/chat/route.js` now read the new model via `fetchScheduledShiftRows`.
4. **Writers** — ✅ shipped:
   - ✅ Assistant `create_shift` now writes the new model via `upsertShiftAssignment()` in `src/lib/roster-write.js` (find-or-create block + upsert assignment, faithful to the mig 069 reverse-trigger INSERT; overrides go on the assignment per mig 100). The mig 068 forward trigger keeps `shifts` in sync for remaining readers. (RETIRE-SHIFTS-MIRROR.4)
   - ✅ **copy-week / copy-month** (`/api/schedule/shifts/copy-{week,month}`) — migrated (RETIRE-SHIFTS-MIRROR.5b). Source rows now read from the new model via `fetchSourceShiftRows()` in `src/lib/roster-read.js`, which reproduces the legacy collapsed *effective* override (`coalesce(assignment.override, block≠template ? block.start_time : null)`) so copied shifts keep their exact per-coach times — payroll math is preserved. Writes go through `bulkUpsertShiftAssignments()` in `src/lib/roster-write.js` (find-or-create every needed block once, then one upsert for all assignments — avoids a round-trip-trio per row on a month copy). New blocks carry no `roster_id`, so copied shifts read unpublished until publish, same as the old `published: false`.
   - ✅ **`POST` / `PUT` / `DELETE /api/schedule/shifts` + `/[id]`** — DELETED (RETIRE-SHIFTS-MIRROR.5, #275). Confirmed dead — no UI/mobile/n8n caller. `GET /shifts` stays (reader, phase 5). openapi.js POST registration swapped for GET so the path stays documented.
5. **Shift-swaps + the swap FK** — ✅ shipped (RETIRE-SHIFTS-MIRROR.5c, mig 237). `shift_swap_requests.{requester,target}_shift_id` repointed from `shifts(id)` → `shift_assignments(id)` (table was empty → no data translation). `swaps` GET/POST + `swaps/[id]` PUT now embed/own/swap **assignments** instead of legacy shifts; the GET response is flattened back to the legacy shift shape via `swapShiftShape()` in `src/lib/roster-read.js`, so every consumer (web approvals, `SwapRequestsManager`, web + mobile dashboards) is unchanged. Mobile (`mobile/app/(tabs)/schedule.jsx`) now posts `shift.shift_assignment_id` (already stitched into the `GET /shifts` row) instead of the legacy `shift.id`; web already sent the assignment id via `flattenBlocksToShifts`. The mig 068 forward trigger mirrors the approve-time profile swap back to `public.shifts` for the remaining readers.
   - ✅ **`GET /api/schedule/shifts` reader** (5d) — migrated. Reads the new model via `fetchApiShiftRows()` in `src/lib/roster-read.js`, normalised to the legacy shift shape (byte-identical for the only consumer, the mobile schedule). `id` is now the assignment id (was `shifts.id` — only used as a React key + the swap requester id, both already on `shift_assignment_id` since 5c). `published` is hard-set `true` to match what the mig 100 forward trigger + web `flattenBlocksToShifts` already produce (roster-derived publish state is a separate concern, out of scope for the mirror retirement). **This was the last reader of `public.shifts`.**
6. **Phase 6 — teardown** — ✅ shipped (RETIRE-SHIFTS-MIRROR.6, mig 238). The 3 remaining writes turned out **not** to be dead — they flipped `shifts.published false→true` and reused the flipped set as the publish notify-list (`notifyStaffOfPublish`). They were re-sourced from the new model: each publish path now captures the blocks that are **newly** attached to a roster (`roster_id IS NULL` immediately before tagging) and notifies the coaches assigned to them via `publishNotifyRowsForBlocks()` in `src/lib/roster-notify.js`. This preserves the first-publish-notifies / re-publish-uses-the-change-log behaviour. The redundant `POST /api/schedule/shifts/publish` endpoint (a second flip + notify the client fired as a follow-up) was deleted along with its client call. mig 238 then dropped: the forward mirror trigger + fn, the block-cleanup trigger + fn, the reverse mirror trigger + fn, the `schedule_notifications.shift_id → shifts(id)` FK (the column now holds the assignment id), and the `public.shifts` table itself. **Deploy order:** the code shipped + deployed first; the migration was applied via Supabase MCP only afterwards (dropping the table while the old writing code was live would have broken publishes).

**Key unblock:** `shifts.published` / `published_at` have no equivalent on the new tables, but publishing is a roster concept — a shift's published state derives from `shift_blocks.roster_id → rosters.status === 'published'`. So **no new column and no architectural decision** are needed for any phase.


## Roster ownership and supersede (ROSTER-SUPERSEDE.1, 2026-09-09)

**Ownership is per BLOCK, not per period.** Publishing INSERTs a `rosters` row
and then re-tags `shift_blocks.roster_id` for every block in the period. So
`period_start`/`period_end` is *the range the operator requested*, not a claim
on those days: a later publish over the same range takes the blocks and leaves
the older row claiming dates it owns nothing on. Prod on 2026-09-09 had 74
published rosters, **58 of which owned zero blocks** — every one of them the
residue of a re-publish or a week-then-month widening.

That residue is what made "which roster published this day" unanswerable, and
it is why mig 602's exclusion constraint could not be applied. Richard's
decision (2026-09-09): a publish **supersedes** the rosters it swallows.

- `status` gains **`superseded`**. `superseded_at` records when the row stopped
  owning blocks; `superseded_by` names the roster that took them, and is
  **nullable on purpose** — a period whose successor was itself later emptied
  has no identifiable heir, and "superseded, successor unknown" is truthful.
- `requested_period_start` / `requested_period_end` keep the range the operator
  actually clicked. `period_start`/`period_end` are shrunk to the days a roster
  really owns (that is what the constraint judges); the audit answer to "what
  did this person ask to publish?" must not be silently rewritten to satisfy a
  constraint.
- Nothing is deleted. A superseded roster is the audit trail of a real publish
  event.

**The ordering, which is the whole trick.** The exclusion constraint judges the
INSERT (and the draft→published UPDATE), which necessarily happens *before* any
block can carry the new roster's id. So superseding only after the re-tag
cannot work on its own: an exact re-publish, the commonest flow there is, would
meet a raw 23P01 first. Both publish paths therefore run two phases, in
`src/lib/roster-publish.js`:

1. `releasePublishedRostersFor()` — **before** the write. Stands down every
   published roster the new period fully **contains**. That is exactly the set
   `findConflictingPublishedRosters()` lets through, so afterwards nothing
   published overlaps and the write satisfies the constraint. All-or-nothing,
   and `restorePublishedRosters()` puts them back if the write then fails: a
   roster superseded with no successor still owns its blocks, and every one of
   them would read as UNPUBLISHED to its coach.
2. `supersedeSwallowedRosters()` — **after** the re-tag. Stamps `superseded_by`,
   then sweeps any other still-published overlapping roster: zero blocks left →
   supersede, blocks left → shrink `period_*` to the min/max `block_date` it
   owns (`requested_period_*` untouched). Best-effort: failures surface in the
   route's existing partial-success `warning`, never roll back a publish, never
   throw. It excludes the new roster explicitly — without that it would read
   the new roster as owning nothing and supersede *itself*.

**A DRAFT supersedes nothing.** It owns no blocks until approved, so standing a
live roster down on its behalf would unpublish that period for a draft that may
never be approved. `rosters/[id]/approve` does the release at approval time.

**A STRADDLE still 409s.** Two independently sufficient reasons: mig 602 would
reject it anyway (the un-swallowed half of the older roster keeps overlapping
whatever we do to it), and resolving it would mean shrinking a roster the
operator never asked to change. The 409 names the ranges so they can re-publish
the right one.

**Read paths.** `shift_blocks.roster_id → rosters.status === 'published'` stays
the one derivation of "is this block published" (`src/lib/roster-read.js`,
`shared/dashboard-data.js`). A superseded roster reads as unpublished, which is
correct *and* unreachable — a roster is only superseded once it owns zero
blocks, so no block can embed one. Both derivations are pinned by a test
anyway, because the day it becomes reachable is the day a coach's phone
silently empties. `findPublishedRosterFor` / `findPublishedRosterIdsByDate` /
`publishedRostersCovering` already filter `status='published'`, so superseding
correctly removes a roster from consideration for new blocks.
`GET /api/schedule/rosters` excludes superseded from the default list and keeps
it reachable with `?status=superseded`.

**Still open:** a widening publish does not re-notify the coaches of the week it
swallowed. Both publish paths only notify blocks that were `roster_id IS NULL`
before tagging, and a swallowed week's blocks already carried the old roster's
id. The change-log path covers the coaches whose shifts actually *changed*,
which is the case that matters most; re-notifying the rest is a separate
decision about how much noise a widening publish should make.
