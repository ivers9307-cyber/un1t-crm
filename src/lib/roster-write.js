// RETIRE-SHIFTS-MIRROR.4 — write the Roster v2 model directly instead of
// the legacy public.shifts table.
//
// `upsertShiftAssignment` replicates the INSERT branch of the mig 069
// reverse trigger (shifts → shift_blocks + shift_assignments): find-or-create
// the block for (location, template, date), then upsert the assignment. With
// the writers calling this, the mig 068 FORWARD trigger keeps public.shifts in
// sync for the readers that haven't migrated yet (GET /shifts + mobile + swaps,
// phase 5) — so nothing breaks mid-cutover.
//
// Override note: unlike the old reverse trigger (which folded a shift's
// start/end override onto the shared BLOCK), this puts overrides on the
// ASSIGNMENT (start_time_override / end_time_override, mig 100) — the canonical
// per-coach location. Blocks keep the template's default times. For the
// override-free callers (assistant create_shift) this distinction is moot.

/**
 * Find-or-create the block for (location, template, date), then upsert the
 * coach's assignment on it. Returns { blockId, assignment, error }.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {object} input
 * @param {string} input.locationId
 * @param {string} input.profileId
 * @param {string} input.shiftTemplateId
 * @param {string} input.shiftDate            YYYY-MM-DD
 * @param {string|null} [input.startTimeOverride]
 * @param {string|null} [input.endTimeOverride]
 * @param {string|null} [input.notes]
 * @param {string} [input.status='scheduled']
 * @param {string|null} [input.actorId]
 */
export async function upsertShiftAssignment(db, input) {
  const {
    locationId, profileId, shiftTemplateId, shiftDate,
    startTimeOverride = null, endTimeOverride = null,
    notes = null, status = 'scheduled', actorId = null,
  } = input || {}

  if (!locationId || !profileId || !shiftTemplateId || !shiftDate) {
    return { error: { message: 'locationId, profileId, shiftTemplateId and shiftDate are required' } }
  }

  // Template defaults populate a freshly-created block's snapshot columns.
  const { data: template, error: tErr } = await db
    .from('shift_templates')
    .select('start_time, end_time, max_coaches')
    .eq('id', shiftTemplateId)
    .maybeSingle()
  if (tErr) return { error: tErr }
  if (!template) return { error: { message: 'shift_template not found' } }

  // Find the block for (location, template, date).
  const { data: existing, error: fErr } = await db
    .from('shift_blocks')
    .select('id')
    .eq('location_id', locationId)
    .eq('template_id', shiftTemplateId)
    .eq('block_date', shiftDate)
    .maybeSingle()
  if (fErr) return { error: fErr }

  let blockId = existing?.id
  if (!blockId) {
    // Create it with the template's default times + capacity (min_coaches
    // defaults at the DB level, matching the reverse trigger).
    const { data: created, error: cErr } = await db
      .from('shift_blocks')
      .insert({
        location_id: locationId,
        template_id: shiftTemplateId,
        block_date: shiftDate,
        start_time: template.start_time,
        end_time: template.end_time,
        max_coaches: template.max_coaches ?? 15,
        notes,
        created_by: actorId,
      })
      .select('id')
      .single()
    if (cErr) return { error: cErr }
    blockId = created.id
  }

  // Upsert the assignment, dedup on (block, profile) — same key the reverse
  // trigger uses. Overrides ride on the assignment (mig 100).
  const { data: assignment, error: aErr } = await db
    .from('shift_assignments')
    .upsert({
      block_id: blockId,
      profile_id: profileId,
      notes,
      status,
      start_time_override: startTimeOverride,
      end_time_override: endTimeOverride,
      assigned_by: actorId,
    }, { onConflict: 'block_id,profile_id' })
    .select('id, block_id, profile_id, status')
    .single()
  if (aErr) return { error: aErr }

  return { blockId, assignment, error: null }
}
