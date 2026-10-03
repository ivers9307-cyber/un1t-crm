// SHIFTTYPE.1 (mig 628) — a shift template is a CLASS shift or an ADMIN shift.
//
// Richard, 25 Sep 2026 (scheduler Wave 2 index, binding): the roster is HYBRID.
// Only admin work that needs a time and a person is placed on it, and an admin
// shift carries NO MINIMUM STAFFING: it is never an empty or short gap (the
// staffing chips, the publish check, the runway alert, the Studio Overview and
// the phone's Manage chip look at class shifts only). It is left out of the
// contractor budget gate and contractor spend, and it still counts toward hours.
//
// The column is on shift_templates only; a block reads its kind through its
// template (`block.shift_templates.kind`), so every reader that needs the rule
// embeds `shift_templates(kind)`.
//
// Unreadable = 'class'. A reader that forgot the embed therefore behaves as it
// did before SHIFTTYPE.1 (a false gap, admin hours priced into the budget):
// loud, and never a hidden class gap.
//
// Dependency-free: shared/ is the mobile seam and cannot import src/lib.

export const SHIFT_KINDS = ['class', 'admin']
export const DEFAULT_SHIFT_KIND = 'class'
export const SHIFT_KIND_LABELS = { class: 'Class', admin: 'Admin' }

/**
 * The kind of a shift_templates row, or of a shift_blocks row through its
 * embedded template.
 *
 * @param {object|null|undefined} row  template ({ kind }) or block ({ shift_templates: { kind } })
 * @returns {'class'|'admin'}
 */
export function shiftKindOf(row) {
  const kind = row?.kind ?? row?.shift_templates?.kind
  return kind === 'admin' ? 'admin' : 'class'
}

/** @returns {boolean} */
export function isAdminShift(row) {
  return shiftKindOf(row) === 'admin'
}
