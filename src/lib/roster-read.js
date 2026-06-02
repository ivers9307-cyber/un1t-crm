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
    start_time_override: effectiveOverride(a.start_time_override, b.start_time, tpl.start_time),
    end_time_override: effectiveOverride(a.end_time_override, b.end_time, tpl.end_time),
    role_label: tpl.role_label ?? null,
    shift_templates: tpl,
    profiles: a.profiles ?? null,
  }
}

/**
 * Fetch the per-coach scheduled rows in [startDate, endDate] for a
 * location from the Roster v2 model, normalised to the shape the copy
 * routes need. Each row is one coach assigned to one block:
 *
 *   { profileId, shiftTemplateId, shiftDate,
 *     startTimeOverride, endTimeOverride, notes }
 *
 * Overrides are the collapsed effective values (see effectiveOverride).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {object} opts
 * @param {string} opts.locationId
 * @param {string} opts.startDate  YYYY-MM-DD inclusive
 * @param {string} opts.endDate    YYYY-MM-DD inclusive
 * @returns {Promise<{ rows: Array<object>, error: object|null }>}
 */
export async function fetchSourceShiftRows(db, { locationId, startDate, endDate }) {
  const { data, error } = await db
    .from('shift_assignments')
    .select(`
      profile_id,
      notes,
      start_time_override,
      end_time_override,
      shift_blocks!inner (
        location_id,
        template_id,
        block_date,
        start_time,
        end_time,
        shift_templates ( start_time, end_time )
      )
    `)
    .eq('shift_blocks.location_id', locationId)
    .gte('shift_blocks.block_date', startDate)
    .lte('shift_blocks.block_date', endDate)

  if (error) return { rows: [], error }

  const rows = []
  for (const a of data || []) {
    const b = a.shift_blocks
    if (!b) continue
    const tpl = b.shift_templates || {}
    rows.push({
      profileId: a.profile_id,
      shiftTemplateId: b.template_id,
      shiftDate: b.block_date,
      startTimeOverride: effectiveOverride(a.start_time_override, b.start_time, tpl.start_time),
      endTimeOverride: effectiveOverride(a.end_time_override, b.end_time, tpl.end_time),
      notes: a.notes ?? null,
    })
  }
  return { rows, error: null }
}

// RETIRE-SHIFTS-MIRROR.5d — the legacy-shaped row GET /api/schedule/shifts
// returns, built from the Roster v2 model. Mobile is the only consumer; the
// shape is kept byte-identical to what the mig 100 forward trigger wrote into
// public.shifts (+ the shift_assignment_id / partial_reason the route used to
// stitch in a second query):
//
//   - id = the assignment id (was shifts.id — only used as a React key + the
//     swap requester id, both already on shift_assignment_id since 5c)
//   - start/end_time_override = the collapsed effective override
//   - published = true (the forward trigger + web flattenBlocksToShifts both
//     hard-set this; roster-derived publish state is out of scope here)
//   - notes = assignment.notes ?? block.notes (matches the trigger's coalesce)
const API_SHIFT_SELECT = `
  id, profile_id, status, notes, partial_reason,
  start_time_override, end_time_override, assigned_by, assigned_at, updated_at,
  shift_blocks!inner (
    location_id, template_id, block_date, start_time, end_time, notes,
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
    start_time_override: effectiveOverride(a.start_time_override, b.start_time, tpl.start_time),
    end_time_override: effectiveOverride(a.end_time_override, b.end_time, tpl.end_time),
    role_label: tpl.role_label ?? null,
    notes: a.notes ?? b.notes ?? null,
    status: a.status,
    published: true,
    created_by: a.assigned_by ?? null,
    updated_at: a.updated_at ?? null,
    shift_templates: tpl,
    profiles: a.profiles ?? null,
    shift_assignment_id: a.id,
    partial_reason: a.partial_reason ?? null,
  }
}

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
 * @returns {Promise<{ rows: Array<object>, error: object|null }>}
 */
export async function fetchApiShiftRows(db, { locationIds, startDate, endDate, profileId }) {
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
    .filter((a) => a.shift_blocks)
    .map(toApiShiftRow)
    .sort((x, y) => (x.shift_date < y.shift_date ? -1 : x.shift_date > y.shift_date ? 1 : 0))
  return { rows, error: null }
}
