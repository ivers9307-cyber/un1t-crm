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
