# Mobile Schedule Editing — manager "Manage" mode

**Date:** 2026-06-04 · **Surface:** Expo iOS app (`mobile/`) · **Status:** design approved, ready for plan

## Goal

Let managers (`head_coach`, `manager`, `owner`, `master`) edit the roster from the phone: **move coaches on/off shifts** (assign / change who's on / remove), **adjust shift times**, and **approve/reject** pending time-off and swap requests — all from a new manager-only **"Manage"** mode on the Schedule tab.

## Scope (user-approved: Tier A + B)

In:
- Approve / reject pending **time-off** requests.
- Approve / reject pending **swap** requests.
- **Adjust** any coach's shift start/end times.
- **Assign** a coach to a shift block.
- **Remove** a coach from a shift.

Out (v1): creating/deleting shift blocks, editing templates, publishing rosters, draft-roster over-budget approval, bulk-assign (one coach → many blocks). These keep their heavier web-only logic.

## Key finding — no backend changes

Every read **and** mutation route this needs already exists, is gated to `MANAGER_ROLES` (= exactly the target roles), uses the service-role client (so it returns coach **names** that the `authenticated` mobile client can't embed itself — see the PR #371 profiles-grant lesson), and works over the mobile Bearer/`x-active-location` path. **No new route, no migration, no permission key.** Pure mobile feature: helpers + UI.

| Need | Route | Method | Gate | Notes |
|---|---|---|---|---|
| Day's blocks (incl. empty) + capacity + assigned coaches | `/api/schedule/blocks?location_id&start_date&end_date` | GET | `MANAGER_ROLES` + `assertLocationAccess` | embeds `shift_templates` + `shift_assignments[].profiles{full_name,avatar_url,role}` |
| Assign coach(es) to a block | `/api/schedule/blocks/[id]/assignments` | POST | `MANAGER_ROLES` | body `{ profile_id \| profile_ids[], notes?, allow_over_capacity? }`; capacity-checked, time-off/double-book are advisories |
| Remove coach from shift | `/api/schedule/assignments/[id]` | DELETE | self or `MANAGER_ROLES` | deletes the assignment row |
| Adjust shift times | `/api/schedule/assignments/[id]` | PUT | self or `MANAGER_ROLES` | already wired as `adjustShiftAssignment` |
| Pending time-off (location-wide) | `/api/schedule/time-off?status=pending&location_id` | GET | manager sees all; staff see own only | embeds requester `profiles` |
| Approve/reject time-off | `/api/schedule/time-off/[id]` | PUT | `MANAGER_ROLES` | body `{ status: approved\|rejected, review_note? }` |
| Pending swaps (location-wide) | `/api/schedule/swaps?status=pending&location_id` | GET | location-scoped | already wired as `getOpenSwaps`; embeds requester + shift |
| Approve/reject swap | `/api/schedule/swaps/[id]` | PUT | `MANAGER_ROLES` | already wired as `respondToSwap` |
| Assignable coaches at location | `/api/staff` | GET | scoped to caller's locations | returns `{ id, full_name, role, active, profile_locations[] }` |

## Approach — a third "Manage" segment

The Schedule tab already has a `Me | Team` segmented control (shipped 2026-06-04). Add a **third segment `Manage`, rendered only for `MANAGER_ROLES`** → `Me | Team | Manage` for managers, `Me | Team` for everyone else. This keeps viewing (Me/Team, unchanged) separate from editing (Manage), reuses the existing week-strip + selected-day model, and adds no new navigation surface.

Rejected: making Team itself editable (overloads one mode with role-dependent behavior); a separate Manage screen (a whole new navigation surface for what's still day/week-scoped).

## Manage mode — contents

Reuses the week header + `WeekStrip` + selected-day state. Two stacked parts:

### 1. Pending approvals (location-wide, not day-specific)
A collapsible `Pending approvals (N)` section at the top (hidden when N = 0). N = pending time-off + pending swaps for the active location. Each row is an `ApprovalCard`:
- **Time-off:** requester name · type (holiday/sick/…) · date range · reason → **Approve** / **Reject** (`respondToTimeOff`).
- **Swap:** requester name · the shift (template name · date · time) → **Approve** / **Reject** (`respondToSwap`).
Approvals are a queue, so they show regardless of the selected day. Reject offers an optional note.

### 2. The selected day's roster — block-centric
From `getScheduleBlocks` (the week's blocks, filtered to the selected day; same week-fetch pattern as Team). Each block is a `BlockCard`:
- Header: template name · `timeRange(block)` · **capacity chip** `assigned/max` (amber when `assigned < min_coaches`; neutral otherwise).
- Each assigned coach: avatar (initials fallback) + name → tap → action sheet **Adjust times** (opens the existing `AdjustSheet`, adapted from block+assignment) · **Remove from shift** (`removeAssignment`, confirm first).
- **+ Add coach** → `CoachPickerSheet`: list from `getLocationStaff` filtered to active staff at the location **minus those already on this block** → tap a name → `assignCoachToBlock`. If the block is at/over `max_coaches`, confirm **"Block is full (max N) — add anyway?"** and retry with `allow_over_capacity: true`. Surface any time-off/double-book advisory the response returns as a non-blocking note.

Empty day → "No shifts scheduled for {day}."

## Permissions

Role-gated to `MANAGER_ROLES` (`['master','owner','manager','head_coach']`) via the existing `isManagerRole(profile.role)` helper in `schedule.jsx`, on top of the screen's existing `schedule` tab gate — mirroring how web roster editing is role-gated rather than permission-gated. The `Manage` segment and every edit action are hidden/blocked for non-managers; the API routes enforce the same gate server-side (defence in depth). No `shared/permissions.js` change → `check:mobile-parity` unaffected. *(A future per-user `schedule_manage` mobile toggle could let an admin revoke a specific head_coach's edit rights — explicitly out of scope for v1.)*

## Data flow & new helpers

New helpers in `mobile/lib/schedule-api.js`:
- `getScheduleBlocks({ locationId, startDate, endDate })` → GET `/api/schedule/blocks`
- `assignCoachToBlock(blockId, { profileId, allowOverCapacity, locationId })` → POST `/api/schedule/blocks/[id]/assignments`
- `removeAssignment(assignmentId, { locationId })` → DELETE `/api/schedule/assignments/[id]`
- `getPendingTimeOff({ locationId })` → GET `/api/schedule/time-off?status=pending&location_id`
- `respondToTimeOff(id, status, reviewNote, locationId)` → PUT `/api/schedule/time-off/[id]`
- `getLocationStaff({ locationId })` → GET `/api/staff`

(`getOpenSwaps`, `respondToSwap`, `adjustShiftAssignment` already exist and are reused.)

State: Manage mode fetches the week's blocks (`getScheduleBlocks`) + the pending approvals (`getPendingTimeOff` + `getOpenSwaps`) on entry / day-change / pull-to-refresh / `useFocusEffect`, mirroring the Me/Team fetch wiring. Coach list (`getLocationStaff`) is lazy-loaded when a `CoachPickerSheet` opens (cached for the session). After any mutation, refetch the day's blocks and the approvals counts (keep current data on screen during the refetch).

**`AdjustSheet` adaptation:** the block editor builds the shift-shaped object `AdjustSheet` expects from `block` + `assignment` — `{ shift_assignment_id: a.id, shift_date: block.block_date, start_time: block.start_time, end_time: block.end_time, shift_templates: block.shift_templates, start_time_override: a.start_time_override ?? null, end_time_override: a.end_time_override ?? null }`. The plan's first step confirms the exact `shift_assignments` embed fields in `blocks/route.js`; if the overrides aren't embedded, the sheet prefills from block defaults (the manager is setting the time anyway).

## New components

Under a new `mobile/components/schedule/` dir (keeps `schedule.jsx` from ballooning past its current ~750 lines):
- `ManageMode.jsx` — owns the approvals section + the selected-day block list; receives `{ profile, activeLocation, weekStart, weekEnd, selectedIso }` + an `onAdjust(shiftLike)` callback so time edits reuse the screen's existing `AdjustSheet`.
- `BlockCard.jsx` — one block: header + capacity chip + coach rows + "+ Add coach".
- `CoachPickerSheet.jsx` — modal list of assignable coaches.
- `ApprovalCard.jsx` — time-off / swap approve-reject card.

`mobile/lib/schedule-manage.js` (new, pure, unit-tested):
- `blockFillState(block)` → `'under' | 'ok' | 'over'` (from `shift_assignments.length` vs `min_coaches`/`max_coaches`).
- `filterAssignableCoaches(staff, block, locationId)` → active staff at `locationId`, excluding coaches already on the block.

`mobile/app/(tabs)/schedule.jsx`: add `'manage'` to the `view` values; render the `Manage` segment only for managers; in manage mode render `<ManageMode … onAdjust={setAdjustingShift} />`; the existing `AdjustSheet` already lives here and is reused.

## Edge cases

- **Over capacity:** confirm-and-retry with `allow_over_capacity: true` (plan confirms whether the POST signals over-capacity as an error or an advisory and branches accordingly).
- **Advisories** (assigning a coach who has approved leave / a clashing shift): surface as a non-blocking alert; the assignment still proceeds per the server's advisory model.
- **Published roster edits** notify the affected coach server-side automatically — no mobile handling.
- **Impersonation:** edits run as the effective user (consistent with the rest of the app). If `view === 'manage'` and the effective role loses manager rights mid-session (a master starts "View as user" on a staff member), reset `view` to `'me'` so Manage UI/calls never render for a non-manager identity — guard with an effect keyed on `isManagerRole(profile?.role)`.
- **Refetch, not optimistic:** simplest correct model; the studio block set is small so refetch is cheap.
- **Errors:** per-action `Alert` on failure; the existing red error banner for load failures.

## Testing

- `mobile/lib/schedule-manage.test.js` (vitest — `mobile/lib/**` is in the config include): `blockFillState` (under / ok / over, missing min or max); `filterAssignableCoaches` (excludes already-assigned, inactive, and other-location staff).
- CI mirror: `npm test && npm run lint && npm run check:mobile-parity` (parity unaffected — no permission change).
- `cd mobile && npx expo export --platform ios` — bundle compiles (new imports resolve).
- On-device: assign / remove / adjust a coach; approve & reject a time-off and a swap; over-capacity confirm; non-manager sees no Manage segment; impersonation reflects the effective user's location.

## Files

| File | Change |
|---|---|
| `mobile/lib/schedule-manage.js` + `.test.js` | **new** — pure `blockFillState` + `filterAssignableCoaches` |
| `mobile/lib/schedule-api.js` | +6 helpers (blocks, assign, remove, pending time-off, respond time-off, staff) |
| `mobile/components/schedule/ManageMode.jsx` | **new** |
| `mobile/components/schedule/BlockCard.jsx` | **new** |
| `mobile/components/schedule/CoachPickerSheet.jsx` | **new** |
| `mobile/components/schedule/ApprovalCard.jsx` | **new** |
| `mobile/app/(tabs)/schedule.jsx` | add `manage` view + manager-only segment + render `ManageMode` |

No web, schema, permission, or API-route changes.
