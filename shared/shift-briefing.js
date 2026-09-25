// shared/shift-briefing.js
// BLOCKEDIT.1 (mig 629) — the coach-visible BRIEFING on one shift block.
//
// A note a manager writes for the coaches on ONE shift ("fire drill at 10").
// Coaches read it (web calendar dialog + card marker + Today, phone Me list +
// Manage card); only a manager writes it, through PUT /api/schedule/blocks/[id].
// It is NOT shift_blocks.notes or shift_assignments.notes: those are a
// manager's working notes and stay out of coach surfaces.
//
// Every read carries it at the top level of the row as `briefing` (the
// /api/schedule/blocks block, the /api/schedule/shifts row, the Today row).
//
// Dependency-free: shared/ is the mobile seam and cannot import src/lib.

/** The database cap: CHECK shift_blocks_briefing_shape (mig 629). */
export const BRIEFING_MAX_LENGTH = 500

/**
 * Trimmed text, or null for blank / not a string. The database refuses a blank
 * briefing, so every writer normalises through here first.
 * @returns {string|null}
 */
export function normaliseBriefing(value) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t === '' ? null : t
}

/** A row's briefing, ready to draw (null = draw nothing). */
export function briefingOf(row) {
  return normaliseBriefing(row?.briefing)
}
