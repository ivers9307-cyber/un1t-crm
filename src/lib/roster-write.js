// RETIRE-SHIFTS-MIRROR.4 — write the Roster v2 model directly instead of
// the legacy public.shifts table.
//
// `upsertShiftAssignment` replicates the INSERT branch of the (since-removed)
// mig 069 reverse trigger (shifts → shift_blocks + shift_assignments):
// find-or-create the block for (location, template, date), then upsert the
// assignment. (Historical: during cutover the mig 068 forward trigger mirrored
// these writes into public.shifts for not-yet-migrated readers; that mirror +
// table were dropped in mig 238 — shift_blocks + shift_assignments are now the
// sole source of truth.)
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

/**
 * Batch version of upsertShiftAssignment for the copy-week / copy-month
 * routes (RETIRE-SHIFTS-MIRROR.5b). Replaces a single bulk
 * `upsert into public.shifts` — find-or-create every needed block once,
 * then upsert all assignments in one statement, instead of one
 * round-trip trio per row.
 *
 * All rows must share a single locationId (the copy routes are
 * per-location). Overrides ride on the assignment (mig 100); new blocks
 * are created at template default times.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {object} opts
 * @param {string} opts.locationId
 * @param {string|null} [opts.actorId]
 * @param {Array<{
 *   profileId: string,
 *   shiftTemplateId: string,
 *   shiftDate: string,
 *   startTimeOverride?: string|null,
 *   endTimeOverride?: string|null,
 *   notes?: string|null,
 *   status?: string,
 * }>} opts.rows
 * @returns {Promise<{ count: number, error: object|null }>}
 */
export async function bulkUpsertShiftAssignments(db, { locationId, actorId = null, rows }) {
  if (!locationId) return { count: 0, error: { message: 'locationId is required' } }
  if (!Array.isArray(rows) || rows.length === 0) return { count: 0, error: null }

  // 1. Template defaults for every distinct template referenced.
  const templateIds = [...new Set(rows.map((r) => r.shiftTemplateId))]
  const { data: templates, error: tErr } = await db
    .from('shift_templates')
    .select('id, start_time, end_time, max_coaches')
    .in('id', templateIds)
  if (tErr) return { count: 0, error: tErr }
  const tplById = new Map((templates || []).map((t) => [t.id, t]))
  const missing = templateIds.filter((id) => !tplById.has(id))
  if (missing.length > 0) return { count: 0, error: { message: `shift_template not found: ${missing.join(', ')}` } }

  // 2. Find existing blocks covering the needed (template, date) slots.
  const dates = rows.map((r) => r.shiftDate)
  const minDate = dates.reduce((a, b) => (a < b ? a : b))
  const maxDate = dates.reduce((a, b) => (a > b ? a : b))
  const { data: existingBlocks, error: bErr } = await db
    .from('shift_blocks')
    .select('id, template_id, block_date')
    .eq('location_id', locationId)
    .in('template_id', templateIds)
    .gte('block_date', minDate)
    .lte('block_date', maxDate)
  if (bErr) return { count: 0, error: bErr }
  const blockIdByKey = new Map((existingBlocks || []).map((b) => [`${b.template_id}|${b.block_date}`, b.id]))

  // 3. Create blocks for the slots that don't exist yet (template defaults).
  const neededKeys = new Set(rows.map((r) => `${r.shiftTemplateId}|${r.shiftDate}`))
  const toCreate = []
  for (const key of neededKeys) {
    if (blockIdByKey.has(key)) continue
    const [templateId, blockDate] = key.split('|')
    const tpl = tplById.get(templateId)
    toCreate.push({
      location_id: locationId,
      template_id: templateId,
      block_date: blockDate,
      start_time: tpl.start_time,
      end_time: tpl.end_time,
      max_coaches: tpl.max_coaches ?? 15,
      created_by: actorId,
    })
  }
  if (toCreate.length > 0) {
    const { data: created, error: cErr } = await db
      .from('shift_blocks')
      .insert(toCreate)
      .select('id, template_id, block_date')
    if (cErr) return { count: 0, error: cErr }
    for (const b of created || []) blockIdByKey.set(`${b.template_id}|${b.block_date}`, b.id)
  }

  // 4. Build assignment rows, dedup on (block, profile) so a single
  //    upsert statement can't hit the same conflict key twice.
  const assignmentByKey = new Map()
  for (const r of rows) {
    const blockId = blockIdByKey.get(`${r.shiftTemplateId}|${r.shiftDate}`)
    if (!blockId) continue
    assignmentByKey.set(`${blockId}|${r.profileId}`, {
      block_id: blockId,
      profile_id: r.profileId,
      notes: r.notes ?? null,
      status: r.status ?? 'scheduled',
      start_time_override: r.startTimeOverride ?? null,
      end_time_override: r.endTimeOverride ?? null,
      assigned_by: actorId,
    })
  }
  const assignmentRows = [...assignmentByKey.values()]
  if (assignmentRows.length === 0) return { count: 0, error: null }

  const { error: aErr } = await db
    .from('shift_assignments')
    .upsert(assignmentRows, { onConflict: 'block_id,profile_id' })
  if (aErr) return { count: 0, error: aErr }

  return { count: assignmentRows.length, error: null }
}
