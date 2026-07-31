// EQUIP-MAINT.1 — Supabase reads/writes for the equipment feature.
// Kept apart from ./equipment.js so the pure logic stays testable
// without mocks. Every function takes an already-constructed
// service-role client; none of them do auth — routes gate first.
//
// Row-count note: a studio holds 30-80 assets and ~15 types, well
// under the 1,000-row PostgREST select cap, so these do not paginate.
// If a tenant ever exceeds that, switch to .range() pagination the way
// src/lib/pipeline-reclassify.js does.

import { EQUIPMENT_STATUS } from './equipment.js'

const TYPE_COLUMNS = 'id, location_id, name, items, interval_weeks, enabled, created_at, updated_at'
const EQUIPMENT_COLUMNS =
  'id, location_id, type_id, name, asset_tag, serial_number, manufacturer, zone, ' +
  'purchase_date, notes, status, out_of_service_issue_id, next_due_on, last_inspected_on, ' +
  'created_at, updated_at'

// ---- settings -----------------------------------------------------

export async function getSettings(db, locationId) {
  const { data, error } = await db
    .from('equipment_settings')
    .select('location_id, inspection_day_of_week, enabled, created_at, updated_at')
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function upsertSettings(db, locationId, { inspectionDayOfWeek, enabled }) {
  const { data, error } = await db
    .from('equipment_settings')
    .upsert(
      { location_id: locationId, inspection_day_of_week: inspectionDayOfWeek, enabled },
      { onConflict: 'location_id' }
    )
    .select('location_id, inspection_day_of_week, enabled')
    .single()
  if (error) throw error
  return data
}

// ---- types --------------------------------------------------------

export async function listTypes(db, locationId, { includeDisabled = false } = {}) {
  let q = db.from('equipment_types').select(TYPE_COLUMNS).eq('location_id', locationId)
  if (!includeDisabled) q = q.eq('enabled', true)
  const { data, error } = await q.order('name', { ascending: true })
  if (error) throw error
  return data || []
}

export async function getType(db, id) {
  const { data, error } = await db.from('equipment_types').select(TYPE_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw error
  return data || null
}

export async function insertType(db, { locationId, name, items, intervalWeeks }) {
  const { data, error } = await db
    .from('equipment_types')
    .insert({ location_id: locationId, name, items, interval_weeks: intervalWeeks })
    .select(TYPE_COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function updateType(db, id, patch) {
  const { data, error } = await db.from('equipment_types').update(patch).eq('id', id).select(TYPE_COLUMNS).single()
  if (error) throw error
  return data
}

/** How many non-retired assets sit on this type — blocks disabling a live type. */
export async function countActiveAssetsOfType(db, typeId) {
  const { count, error } = await db
    .from('equipment')
    .select('id', { count: 'exact', head: true })
    .eq('type_id', typeId)
    .neq('status', EQUIPMENT_STATUS.RETIRED)
  if (error) throw error
  return count || 0
}

// ---- equipment ----------------------------------------------------

export async function listEquipment(db, locationId, { includeRetired = false } = {}) {
  let q = db
    .from('equipment')
    .select(`${EQUIPMENT_COLUMNS}, equipment_types!type_id ( id, name, interval_weeks )`)
    .eq('location_id', locationId)
  if (!includeRetired) q = q.neq('status', EQUIPMENT_STATUS.RETIRED)
  const { data, error } = await q.order('next_due_on', { ascending: true }).order('name', { ascending: true })
  if (error) throw error
  return data || []
}

export async function getEquipment(db, id) {
  const { data, error } = await db
    .from('equipment')
    .select(`${EQUIPMENT_COLUMNS}, equipment_types!type_id ( id, name, interval_weeks, items )`)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function insertEquipment(db, row) {
  const { data, error } = await db.from('equipment').insert(row).select(EQUIPMENT_COLUMNS).single()
  if (error) throw error
  return data
}

export async function updateEquipment(db, id, patch) {
  const { data, error } = await db.from('equipment').update(patch).eq('id', id).select(EQUIPMENT_COLUMNS).single()
  if (error) throw error
  return data
}

// ---- inspections ---------------------------------------------------

const INSPECTION_COLUMNS =
  'id, location_id, equipment_id, type_id, inspector_id, due_on, items, results, ' +
  'status, submitted_at, issue_id, created_at, updated_at'

/** The draft for this asset's CURRENT cycle, if one exists. */
export async function getDraftFor(db, { equipmentId, dueOn }) {
  const { data, error } = await db
    .from('equipment_inspections')
    .select(INSPECTION_COLUMNS)
    .eq('equipment_id', equipmentId)
    .eq('due_on', dueOn)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function getInspection(db, id) {
  const { data, error } = await db
    .from('equipment_inspections')
    .select(`${INSPECTION_COLUMNS}, equipment!equipment_id ( id, name, location_id, status, next_due_on ), equipment_types!type_id ( id, name, interval_weeks )`)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function insertDraft(db, row) {
  const { data, error } = await db
    .from('equipment_inspections')
    .insert(row)
    .select(INSPECTION_COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function updateInspection(db, id, patch) {
  const { data, error } = await db
    .from('equipment_inspections')
    .update(patch)
    .eq('id', id)
    .select(INSPECTION_COLUMNS)
    .single()
  if (error) throw error
  return data
}

/**
 * Assets due for inspection at a location as of `today`.
 * Mirrors isDue(): in-service only, next_due_on <= today. The
 * equipment_due_idx predicate (status <> 'retired') is deliberately
 * wider — index for cheapness, isDue() for truth — so we filter
 * status here rather than relying on the index shape.
 *
 * Row-count note: 30-80 assets per studio, well under the 1000-row
 * PostgREST cap, so this does not paginate.
 */
export async function listDueEquipment(db, locationId, today) {
  const { data, error } = await db
    .from('equipment')
    .select(`${EQUIPMENT_COLUMNS}, equipment_types!type_id ( id, name, interval_weeks, items )`)
    .eq('location_id', locationId)
    .eq('status', 'in_service')
    .lte('next_due_on', today)
    .order('next_due_on', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  return data || []
}

/** Assets currently off the floor — shown in their own section. */
export async function listOutOfServiceEquipment(db, locationId) {
  const { data, error } = await db
    .from('equipment')
    .select(`${EQUIPMENT_COLUMNS}, equipment_types!type_id ( id, name )`)
    .eq('location_id', locationId)
    .eq('status', 'out_of_service')
    .order('name', { ascending: true })
  if (error) throw error
  return data || []
}
