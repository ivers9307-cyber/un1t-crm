// EQUIP-MAINT.2 — draft construction and tick merging for an
// inspection run. Pure: no DB, no clock. Callers pass `at`.

/**
 * Build the row for a new draft inspection.
 * `items` is a deep copy of the type's checklist AT THIS MOMENT — the
 * whole point of the snapshot is that an admin editing the type
 * mid-walk-round cannot shift state under the inspector.
 */
export function buildDraftRow({ asset, type, inspectorId }) {
  const items = Array.isArray(type?.items) ? type.items : []
  if (items.length === 0) {
    throw new Error(`Equipment type "${type?.name ?? '?'}" has no checklist items.`)
  }
  return {
    location_id: asset.location_id,
    equipment_id: asset.id,
    type_id: type.id,
    inspector_id: inspectorId,
    due_on: asset.next_due_on,
    items: JSON.parse(JSON.stringify(items)),
    results: {},
    status: 'draft',
  }
}

/** Apply one mark to a results object, returning a new object. */
export function mergeTick(results, { itemId, state, note, at, by }) {
  const entry = { state, at, by }
  // A note only means something on a fail; carrying one on a pass
  // would leak a stale explanation into the issue description if the
  // inspector changed their mind.
  if (state === 'fail' && note) entry.note = note
  return { ...(results || {}), [itemId]: entry }
}

/** Does every item in the snapshot carry a valid pass/fail mark? */
export function isFullyMarked(items, results) {
  if (!Array.isArray(items)) return false
  return items.every((it) => {
    const s = results?.[it.id]?.state
    return s === 'pass' || s === 'fail'
  })
}
