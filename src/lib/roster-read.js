// RETIRE-SHIFTS-MIRROR.5b — read the source roster for the copy-week /
// copy-month routes from the Roster v2 model (shift_blocks +
// shift_assignments) instead of the legacy public.shifts mirror.
//
// The legacy `shifts.start_time_override` column the copy routes used to
// read was a *collapsed effective* value, computed by the mig 100 mirror
// trigger as:
//
//   coalesce(
//     assignment.start_time_override,                       -- per-coach override
//     block.start_time <> template.start_time               -- block-vs-template
//       ? block.start_time : null
//   )
//
// `effectiveOverride` below reproduces that exactly so a copied shift
// preserves the same effective per-coach start/end time it had at source
// — payroll math (src/lib/payroll.js) reads these overrides, so this has
// to match the legacy behaviour byte-for-byte.

import { isLiveAssignment } from './roster'

/**
 * Collapse a block-level time + a per-assignment override into the single
 * "effective override vs the template" value the legacy shifts mirror
 * carried. Returns null when the coach's effective time equals the
 * template default (i.e. no override needed).
 *
 * @param {string|null|undefined} assignmentOverride  per-assignment override
 * @param {string|null|undefined} blockTime           block's snapshot time
 * @param {string|null|undefined} templateTime        template default time
 * @returns {string|null}
 */
export function effectiveOverride(assignmentOverride, blockTime, templateTime) {
  if (assignmentOverride) return assignmentOverride
  if (blockTime && templateTime && blockTime !== templateTime) return blockTime
  return null
}

/**
 * Flatten a shift_assignment row embedded with its block + template into
 * the legacy "shift"-shaped object the swap UIs read off
 * `requester_shift` / `target_shift` (RETIRE-SHIFTS-MIRROR.5c). Keeps the
 * GET /api/schedule/swaps response shape identical after the FK repointed
 * from shifts(id) → shift_assignments(id), so no consumer (web approvals,
 * SwapRequestsManager, web + mobile dashboards) needs to change.
 *
 * Expects the embed:
 *   shift_assignments(
 *     id, profile_id, status, notes, start_time_override, end_time_override,
 *     shift_blocks!block_id ( block_date, start_time, end_time,
 *       shift_templates ( name, start_time, end_time, role_label ) ),
 *     profiles!profile_id ( ... )
 *   )
 *
 * @param {object|null} a embedded shift_assignments row (or null)
 * @returns {object|null}
 */
export function swapShiftShape(a) {
  if (!a) return null
  const b = a.shift_blocks || {}
  const tpl = b.shift_templates || {}
  return {
    id: a.id,
    profile_id: a.profile_id,
    status: a.status,
    notes: a.notes ?? null,
    shift_date: b.block_date ?? null,
    // COVERLOOP.2 — the block's own times, same keys as toApiShiftRow. The
    // taker works these (a moved shift loses its overrides).
    block_start_time: b.start_time ?? null,
    block_end_time: b.end_time ?? null,
    start_time_override: effectiveOverride(a.start_time_override, b.start_time, tpl.start_time),
    end_time_override: effectiveOverride(a.end_time_override, b.end_time, tpl.end_time),
    role_label: tpl.role_label ?? null,
    shift_templates: tpl,
    profiles: a.profiles ?? null,
  }
}

// COPYMODES.1 — the copy routes' source reader (fetchSourceShiftRows) moved to
// src/lib/roster-copy.js as fetchSourceBlocks: it reads BLOCKS (so empty ones
// can be carried), pages past the 1,000-row cap, and returns raw times so each
// copy mode can decide what to keep. effectiveOverride stays here for the swap
// and API shapes below.

// RETIRE-SHIFTS-MIRROR.5d — the legacy-shaped row GET /api/schedule/shifts
// returns, built from the Roster v2 model. Mobile is the only consumer; the
// shape is kept byte-identical to what the mig 100 forward trigger wrote into
// public.shifts (+ the shift_assignment_id / partial_reason the route used to
// stitch in a second query):
//
//   - id = the assignment id (was shifts.id — only used as a React key + the
//     swap requester id, both already on shift_assignment_id since 5c)
//   - start/end_time_override = the collapsed effective override
//   - published derives from block → roster (ROSTER-FIX.1) — it was hard-coded
//     true here (and by the mig 100 forward trigger), which showed draft and
//     copied shifts to every coach's phone as if they were live
//   - notes = assignment.notes ?? block.notes (matches the trigger's coalesce)
const API_SHIFT_SELECT = `
  id, profile_id, status, notes, partial_reason,
  start_time_override, end_time_override, assigned_by, assigned_at, updated_at,
  shift_blocks!inner (
    location_id, template_id, block_date, start_time, end_time, notes, roster_id,
    rosters:roster_id ( status ),
    shift_templates (*)
  ),
  profiles!profile_id ( id, full_name, email, avatar_url, role )
`

function toApiShiftRow(a) {
  const b = a.shift_blocks || {}
  const tpl = b.shift_templates || {}
  return {
    id: a.id,
    location_id: b.location_id,
    profile_id: a.profile_id,
    shift_template_id: b.template_id,
    shift_date: b.block_date,
    // ROSTER-FIX.1 — the BLOCK's own times ride along (the legacy shifts row
    // had none). Mobile needs them to sort the day list on the effective
    // start and to compare an override against the true block default rather
    // than the template's, which silently discarded a block-level time change.
    block_start_time: b.start_time ?? null,
    block_end_time: b.end_time ?? null,
    start_time_override: effectiveOverride(a.start_time_override, b.start_time, tpl.start_time),
    end_time_override: effectiveOverride(a.end_time_override, b.end_time, tpl.end_time),
    role_label: tpl.role_label ?? null,
    notes: a.notes ?? b.notes ?? null,
    status: a.status,
    // ROSTER-FIX.1 — publishing is a roster concept: a shift is published
    // iff its block belongs to a published roster (same derivation as
    // shared/dashboard-data.js fetchDashboardShifts). Was hard-coded true,
    // which showed draft + copied shifts to every coach's phone as live.
    published: b.rosters?.status === 'published',
    created_by: a.assigned_by ?? null,
    updated_at: a.updated_at ?? null,
    shift_templates: tpl,
    profiles: a.profiles ?? null,
    shift_assignment_id: a.id,
    partial_reason: a.partial_reason ?? null,
  }
}

/**
 * COACHSCOPE.1 — the non-manager projection of one API shift row.
 *
 * The feed is a coach surface (mobile Me + Team views, web Today's "On with
 * you today"), and it used to hand every coach each colleague's EMAIL and
 * NOTES. What a coach needs about a colleague is who they are and when they
 * are on: id, name, avatar, role label. Their own row keeps its notes and
 * partial_reason (the Me view renders both); a colleague's row loses them,
 * because assignment notes / partial_reason are a manager's working notes
 * about that person. Email is dropped from every row, own included — the app
 * already knows the caller's own address and no coach screen renders one.
 *
 * Allow-list on the profile embed, not a delete-list: a column added to the
 * embed later stays manager-only until someone lists it here on purpose.
 *
 * @param {object} row     a toApiShiftRow() result
 * @param {string} viewerId the caller's profile id
 * @returns {object}
 */
export function slimShiftRowForCoach(row, viewerId) {
  const own = !!viewerId && row.profile_id === viewerId
  const p = row.profiles
  return {
    ...row,
    notes: own ? row.notes : null,
    partial_reason: own ? row.partial_reason : null,
    profiles: p
      ? { id: p.id, full_name: p.full_name, avatar_url: p.avatar_url, role: p.role }
      : p,
  }
}

// PostgREST's silent per-select row cap (CLAUDE.md: "1,000-row select cap").
const POSTGREST_ROW_CAP = 1000

/**
 * Read shifts for GET /api/schedule/shifts from the Roster v2 model,
 * normalised to the legacy shift shape (see toApiShiftRow). Filters by a set
 * of location ids, optional date range, optional profile. Sorted by date.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {object} opts
 * @param {string[]} opts.locationIds  one or more location ids (required, non-empty)
 * @param {string} [opts.startDate]
 * @param {string} [opts.endDate]
 * @param {string} [opts.profileId]
 * @param {boolean} [opts.publishedOnly=false] drop rows whose roster is not published
 * @param {{ id: string, isManagerAt: (locationId: string) => boolean }} [opts.viewer]
 *   COACHSCOPE.1 — judge each row by the caller's role AT THAT ROW'S LOCATION.
 *   Where the caller is not a manager: draft rows are dropped (D1) and the row
 *   is slimmed (slimShiftRowForCoach). Where they are, the row is untouched.
 *   A multi-location caller can be both in one response.
 * @returns {Promise<{ rows: Array<object>, error: object|null, capped?: true }>}
 */
export async function fetchApiShiftRows(db, { locationIds, startDate, endDate, profileId, publishedOnly = false, viewer = null }) {
  if (!Array.isArray(locationIds) || locationIds.length === 0) return { rows: [], error: null }

  let q = db.from('shift_assignments')
    .select(API_SHIFT_SELECT)
    .in('shift_blocks.location_id', locationIds)
  if (startDate) q = q.gte('shift_blocks.block_date', startDate)
  if (endDate) q = q.lte('shift_blocks.block_date', endDate)
  if (profileId) q = q.eq('profile_id', profileId)

  const { data, error } = await q
  if (error) return { rows: [], error }

  const rows = (data || [])
    .filter((a) => a.shift_blocks && isLiveAssignment(a))
    .map(toApiShiftRow)
    // D1 — coaches see published shifts only; managers pass publishedOnly:false.
    .filter((r) => !publishedOnly || r.published)
    // COACHSCOPE.1 — per-location: a non-manager at this row's studio gets
    // published rows only, slimmed.
    .filter((r) => !viewer || r.published || viewer.isManagerAt(r.location_id))
    .map((r) => (!viewer || viewer.isManagerAt(r.location_id) ? r : slimShiftRowForCoach(r, viewer.id)))
    .sort((x, y) => (x.shift_date < y.shift_date ? -1 : x.shift_date > y.shift_date ? 1 : 0))
  // SHIFTREMIND.1 — this read is not paged, and PostgREST caps a select at
  // 1,000 rows without saying so. A FULL page is therefore reported (`capped`,
  // present only when true) so a caller that must see every row can say so
  // instead of acting on a silently truncated set. Judged on the RAW count:
  // cancelled and draft rows are filtered out above but still used the page.
  if ((data || []).length >= POSTGREST_ROW_CAP) return { rows, error: null, capped: true }
  return { rows, error: null }
}
