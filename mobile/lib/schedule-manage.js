// Pure helpers for the Schedule tab's manager "Manage" mode. No React/Supabase
// — pure functions over the /api/schedule/blocks shape (a shift_block with
// shift_assignments[] each embedding profiles) and the /api/staff shape.
// Lives in mobile/lib so the root vitest picks it up (config includes mobile/lib/**).

// Fill state of a block vs capacity. 'under' = fewer than min_coaches assigned;
// 'over' = more than max_coaches; else 'ok'. Missing min → 0, missing max → ∞.
export function blockFillState(block) {
  const n = Array.isArray(block?.shift_assignments) ? block.shift_assignments.length : 0
  const min = block?.min_coaches ?? 0
  const max = block?.max_coaches
  if (n < min) return 'under'
  if (max != null && n > max) return 'over'
  return 'ok'
}

// Coaches assignable to a block: active staff who belong to `locationId` and
// aren't already on the block, sorted by name. `staff` is the /api/staff data
// array (each { id, full_name, active, profile_locations:[{ location_id }] }).
export function filterAssignableCoaches(staff, block, locationId) {
  const assigned = new Set((block?.shift_assignments || []).map((a) => a.profile_id))
  return (Array.isArray(staff) ? staff : [])
    .filter((s) => {
      if (!s || s.active === false) return false
      if (assigned.has(s.id)) return false
      return (s.profile_locations || []).some((pl) => pl.location_id === locationId)
    })
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''))
}
