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

import { findPublishedRosterFor, clampMinCoaches } from './roster'
import { logWarn } from './log'

/**
 * ROSTER-FIX.4 — the published rosters covering ANY date in [minDate, maxDate]
 * at this location, most recently published first.
 *
 * The batch writer used to call findPublishedRosterFor() once per distinct
 * date, which is a copy-month's worth of round trips (up to 31) to answer a
 * question one range query answers. Same rule as the single-row helper, just
 * resolved in JS: rows come back ordered so the FIRST match for a date wins.
 *
 * Fails SOFT, exactly as findPublishedRosterFor does — a lost probe leaves the
 * new blocks unattached (visible to managers, not yet to staff), where failing
 * the whole copy-week would lose the operator's work outright.
 *
 * @returns {Promise<Array<{id: string, period_start: string, period_end: string}>>}
 */
async function publishedRostersCovering(db, locationId, minDate, maxDate) {
  const { data, error } = await db
    .from('rosters')
    .select('id, period_start, period_end')
    .eq('location_id', locationId)
    .eq('status', 'published')
    // Overlap, not containment: a roster covers SOME date in the span iff it
    // starts on or before the last one and ends on or after the first.
    .lte('period_start', maxDate)
    .gte('period_end', minDate)
    // Most recently PUBLISHED wins — a re-publish or a widening month is the
    // roster that now owns those days. published_at can be null on older rows,
    // so they sort last and created_at breaks the tie.
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
  if (error) {
    logWarn('roster-write', 'published roster lookup failed', { err: error.message, locationId, minDate, maxDate })
    return []
  }
  return data || []
}

/**
 * Find-or-create the block for (location, template, date), then upsert the
 * coach's assignment on it. Returns { blockId, assignment, template, error }.
 *
 * SAAS-1: the template and profile are validated against locationId here,
 * inside the helper, so every caller is covered — callers run on the
 * service-role client (no RLS), and the assistant's create_shift passes
 * ids straight from tool input.
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
  // The location filter doubles as the tenant check (SAAS-1): a bare-id
  // fetch would let a cross-tenant template seed a block here. `name` is
  // selected so callers can render it without a second, unscoped lookup.
  const { data: template, error: tErr } = await db
    .from('shift_templates')
    .select('name, start_time, end_time, min_coaches, max_coaches')
    .eq('id', shiftTemplateId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (tErr) return { error: tErr }
  if (!template) return { error: { message: 'shift_template not found' } }

  // The profile must be linked to the location via profile_locations
  // (SAAS-1) — otherwise any tenant's staff could be rostered here.
  const { data: link, error: lErr } = await db
    .from('profile_locations')
    .select('profile_id')
    .eq('profile_id', profileId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (lErr) return { error: lErr }
  if (!link) return { error: { message: 'profile not linked to this location' } }

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
    // ROSTER-FIX.4 — a block created for a date INSIDE an already-published
    // period joins that roster. Publishing tags the blocks that exist at
    // that moment; one created afterwards stayed roster_id NULL, which every
    // reader treats as "not published" — so the coach we are assigning right
    // here never saw the shift, and later edits to it were never
    // change-logged. Null when nothing covers the date, exactly as before.
    const rosterId = await findPublishedRosterFor(db, locationId, shiftDate)

    // Create it with the template's default times + capacity. HORIZONMIN.1 —
    // min_coaches is written from the template (it used to fall to the DB
    // default of 1 whatever the template said).
    const maxCoaches = template.max_coaches ?? 15
    const { data: created, error: cErr } = await db
      .from('shift_blocks')
      .insert({
        location_id: locationId,
        template_id: shiftTemplateId,
        block_date: shiftDate,
        start_time: template.start_time,
        end_time: template.end_time,
        min_coaches: clampMinCoaches(template.min_coaches, maxCoaches),
        max_coaches: maxCoaches,
        roster_id: rosterId,
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

  return { blockId, assignment, template, error: null }
}

/**
 * COPYMODES.1 — does an absolute time differ from a block's time? Postgres
 * `time` renders as HH:MM:SS; a client may send HH:MM. Pure, exported for tests.
 */
export function timesDiffer(a, b) {
  const norm = (t) => {
    if (t == null || t === '') return null
    const s = String(t)
    return s.length === 5 ? `${s}:00` : s.slice(0, 8)
  }
  return norm(a) !== norm(b)
}

/**
 * COPYMODES.1 — the override a coach needs so that their effective time on
 * `blockTime` is `time`: null when they already match (or no time is known).
 * Pure, exported for tests.
 */
export function overrideAgainstBlock(time, blockTime) {
  if (time == null || time === '') return null
  return timesDiffer(time, blockTime) ? time : null
}

// Writes are chunked so no single statement returns more than the 1,000-row
// cap (the inserted-row count is read back from `.select('id')`).
const WRITE_CHUNK = 500
const READ_PAGE = 1000

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Batch version of upsertShiftAssignment for the copy-week / copy-month
 * routes (RETIRE-SHIFTS-MIRROR.5b). Replaces a single bulk
 * `upsert into public.shifts` — find-or-create every needed block once,
 * then upsert all assignments in batched statements, instead of one
 * round-trip trio per row.
 *
 * All rows must share a single locationId (the copy routes are
 * per-location). Overrides ride on the assignment (mig 100).
 *
 * COPYFIX.1 — the assignment upsert is `ON CONFLICT DO NOTHING`
 * (`ignoreDuplicates: true`), so a coach already on the target block is
 * NEVER touched by a copy: their override, notes, status and
 * `assigned_by` are left exactly as they were. Only a missing (block,
 * profile) pair gets a new row. `count` comes from `.select('id')` on
 * the upsert, so it reflects rows actually inserted, not the size of the
 * payload sent — a re-run over an already-copied period reports 0, not
 * the number it silently re-wrote.
 *
 * COPYMODES.1 —
 *  - `blocks` (optional) lists target blocks to ensure even with nobody on
 *    them; an entry's startTime/endTime/minCoaches/maxCoaches seed the block
 *    IF it has to be created. An existing block is never modified. Blocks
 *    created only because a row needs them take the template's defaults.
 *  - min_coaches is now written on created blocks (it used to fall to the DB
 *    default of 1 whatever the template said).
 *  - A row may give ABSOLUTE `startTime`/`endTime` (the time the coach should
 *    work) instead of `startTimeOverride`/`endTimeOverride`; the override is
 *    then derived against the target block's actual time, so a block created
 *    at the source's times carries no redundant override and a pre-existing
 *    block at template times carries exactly the difference.
 *  - `partialReason` rides along to shift_assignments.partial_reason.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {object} opts
 * @param {string} opts.locationId
 * @param {string|null} [opts.actorId]
 * @param {Array<{
 *   profileId: string,
 *   shiftTemplateId: string,
 *   shiftDate: string,
 *   startTime?: string|null,
 *   endTime?: string|null,
 *   startTimeOverride?: string|null,
 *   endTimeOverride?: string|null,
 *   partialReason?: string|null,
 *   notes?: string|null,
 *   status?: string,
 * }>} opts.rows
 * @param {Array<{
 *   shiftTemplateId: string,
 *   shiftDate: string,
 *   startTime?: string|null,
 *   endTime?: string|null,
 *   minCoaches?: number|null,
 *   maxCoaches?: number|null,
 * }>} [opts.blocks]
 * @returns {Promise<{ count: number, error: object|null }>}
 */
export async function bulkUpsertShiftAssignments(db, { locationId, actorId = null, rows, blocks = [] }) {
  if (!locationId) return { count: 0, error: { message: 'locationId is required' } }
  const safeRows = Array.isArray(rows) ? rows : []
  const safeBlocks = Array.isArray(blocks) ? blocks : []
  if (safeRows.length === 0 && safeBlocks.length === 0) return { count: 0, error: null }

  const slots = [...safeRows, ...safeBlocks]

  // 1. Template defaults for every distinct template referenced.
  const templateIds = [...new Set(slots.map((r) => r.shiftTemplateId))]
  // ROSTER-FIX.4 (SAAS-1) — scoped to the location like the single-row path:
  // without it a copied row could seed a block from another tenant's template.
  const { data: templates, error: tErr } = await db
    .from('shift_templates')
    .select('id, start_time, end_time, min_coaches, max_coaches')
    .in('id', templateIds)
    .eq('location_id', locationId)
  if (tErr) return { count: 0, error: tErr }
  const tplById = new Map((templates || []).map((t) => [t.id, t]))
  const missing = templateIds.filter((id) => !tplById.has(id))
  if (missing.length > 0) return { count: 0, error: { message: `shift_template not found: ${missing.join(', ')}` } }

  // 2. Find existing blocks covering the needed (template, date) slots. Paged:
  //    a month of blocks can pass the 1,000-row select cap, and a block we
  //    fail to see would be re-inserted into the unique key and fail the copy.
  const dates = slots.map((r) => r.shiftDate)
  const minDate = dates.reduce((a, b) => (a < b ? a : b))
  const maxDate = dates.reduce((a, b) => (a > b ? a : b))
  const blockByKey = new Map()
  for (let from = 0; ; from += READ_PAGE) {
    const { data: page, error: bErr } = await db
      .from('shift_blocks')
      .select('id, template_id, block_date, start_time, end_time')
      .eq('location_id', locationId)
      .in('template_id', templateIds)
      .gte('block_date', minDate)
      .lte('block_date', maxDate)
      .order('id', { ascending: true })
      .range(from, from + READ_PAGE - 1)
    if (bErr) return { count: 0, error: bErr }
    for (const b of page || []) blockByKey.set(`${b.template_id}|${b.block_date}`, b)
    if ((page || []).length < READ_PAGE) break
  }

  // 3. Create blocks for the slots that don't exist yet.
  const specByKey = new Map()
  for (const spec of safeBlocks) {
    const key = `${spec.shiftTemplateId}|${spec.shiftDate}`
    if (!specByKey.has(key)) specByKey.set(key, spec)
  }
  const neededKeys = new Set(slots.map((r) => `${r.shiftTemplateId}|${r.shiftDate}`))
  // ROSTER-FIX.4 — same rule as upsertShiftAssignment: a block created inside
  // an already-published period joins that roster, or copy-week silently
  // produces shifts no coach can see. Resolved for the WHOLE span in one query
  // (the block lookup above already reads that span) and matched per date in
  // JS — a copy-month was otherwise firing up to 31 identical-shaped probes.
  const missingKeys = [...neededKeys].filter((key) => !blockByKey.has(key))
  const candidateRosters = missingKeys.length > 0
    ? await publishedRostersCovering(db, locationId, minDate, maxDate)
    : []
  // Ordered most-recently-published first, so the first row covering the date
  // is the roster that owns it.
  const rosterIdFor = (date) => candidateRosters
    .find((r) => r.period_start <= date && r.period_end >= date)?.id ?? null
  const toCreate = []
  for (const key of missingKeys) {
    const [templateId, blockDate] = key.split('|')
    const tpl = tplById.get(templateId)
    const spec = specByKey.get(key) || {}
    const maxCoaches = spec.maxCoaches ?? tpl.max_coaches ?? 15
    // shift_blocks_min_coaches_check (mig 177): 0 <= min <= max.
    const minCoaches = clampMinCoaches(spec.minCoaches ?? tpl.min_coaches, maxCoaches)
    toCreate.push({
      location_id: locationId,
      template_id: templateId,
      block_date: blockDate,
      start_time: spec.startTime || tpl.start_time,
      end_time: spec.endTime || tpl.end_time,
      min_coaches: minCoaches,
      max_coaches: maxCoaches,
      roster_id: rosterIdFor(blockDate),
      created_by: actorId,
    })
  }
  for (const batch of chunk(toCreate, WRITE_CHUNK)) {
    const { data: created, error: cErr } = await db
      .from('shift_blocks')
      .insert(batch)
      .select('id, template_id, block_date, start_time, end_time')
    if (cErr) return { count: 0, error: cErr }
    for (const b of created || []) blockByKey.set(`${b.template_id}|${b.block_date}`, b)
  }

  // 4. Build assignment rows, dedup on (block, profile) so a single
  //    upsert statement can't hit the same conflict key twice.
  const assignmentByKey = new Map()
  for (const r of safeRows) {
    const block = blockByKey.get(`${r.shiftTemplateId}|${r.shiftDate}`)
    if (!block) continue
    const absolute = r.startTime !== undefined || r.endTime !== undefined
    assignmentByKey.set(`${block.id}|${r.profileId}`, {
      block_id: block.id,
      profile_id: r.profileId,
      notes: r.notes ?? null,
      partial_reason: r.partialReason ?? null,
      status: r.status ?? 'scheduled',
      start_time_override: absolute
        ? overrideAgainstBlock(r.startTime, block.start_time)
        : (r.startTimeOverride ?? null),
      end_time_override: absolute
        ? overrideAgainstBlock(r.endTime, block.end_time)
        : (r.endTimeOverride ?? null),
      assigned_by: actorId,
    })
  }
  const assignmentRows = [...assignmentByKey.values()]
  if (assignmentRows.length === 0) return { count: 0, error: null }

  // COPYFIX.1 — ON CONFLICT DO NOTHING: an existing (block, profile) row is
  // never modified, so a copy can't clear a manager-set override, reset a
  // status, or overwrite assigned_by. `.select('id')` reports only the rows
  // actually inserted, so `count` is accurate even when some rows were
  // skipped as duplicates.
  let count = 0
  for (const batch of chunk(assignmentRows, WRITE_CHUNK)) {
    const { data: inserted, error: aErr } = await db
      .from('shift_assignments')
      .upsert(batch, { onConflict: 'block_id,profile_id', ignoreDuplicates: true })
      .select('id')
    if (aErr) return { count, error: aErr }
    count += (inserted || []).length
  }

  return { count, error: null }
}
