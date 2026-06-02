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
5. **`GET /api/schedule/shifts` + mobile + shift-swaps + the swap FK** — these **must move together** (reordered from the original plan). The mobile swap flow (`mobile/app/(tabs)/schedule.jsx`) uses the `GET /shifts` row `id` as `requester_shift_id`, which is a FK to `shifts.id`. So `GET /shifts` can't return an assignment id until `shift_swap_requests.{requester,target}_shift_id` migrate off `shifts`. Keep the `GET /shifts` response shape byte-identical so mobile needs no change. Also flips `shifts.published` → derive from the roster.
6. **Drop** the mig 068/069 mirror triggers (+ the block-cleanup trigger) and `public.shifts` — after a grace period with nothing reading it.

**Key unblock:** `shifts.published` / `published_at` have no equivalent on the new tables, but publishing is a roster concept — a shift's published state derives from `shift_blocks.roster_id → rosters.status === 'published'`. So **no new column and no architectural decision** are needed for any phase.

