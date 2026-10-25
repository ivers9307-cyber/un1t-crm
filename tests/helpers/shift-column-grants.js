// NOTESGRANT.1 (mig 646) — the SELECT column grants `authenticated` holds on
// the two shift tables, and the columns it is refused. The single source for
// tests/migration-646-shift-notes-column-grants.test.js and
// tests/shift-column-grants-guard.test.js. A new column on either table goes
// into exactly one of these lists, in the same PR as the migration that
// adds it (the guard test fails otherwise).
//
// GRANTED = the coach projection the phone reads (columns slimBlockForCoach
// in src/app/api/schedule/blocks/route.js and slimShiftRowForCoach in
// src/lib/roster-read.js serve a coach) + shift_assignments.block_id, the
// join key of every phone embed of shift_blocks.
//
// WITHHELD is not the same as "what the API strips from a coach": two of its
// columns, shift_assignments.assigned_by (served as `created_by`) and
// shift_assignments.updated_at, ARE in the GET /api/schedule/shifts coach
// payload (toApiShiftRow), but no client reads them directly, so they are
// not granted. notes / partial_reason are served on the coach's own row only.

export const SHIFT_COLUMN_GRANTS = Object.freeze({
  shift_blocks: Object.freeze({
    granted: Object.freeze(['id', 'location_id', 'template_id', 'block_date', 'start_time', 'end_time', 'roster_id', 'briefing']),
    withheld: Object.freeze(['notes', 'min_coaches', 'max_coaches', 'created_by', 'created_at', 'updated_at']),
  }),
  shift_assignments: Object.freeze({
    granted: Object.freeze(['id', 'block_id', 'profile_id', 'status', 'assigned_at', 'start_time_override', 'end_time_override']),
    withheld: Object.freeze(['notes', 'partial_reason', 'arrived_at', 'arrival_source', 'assigned_by', 'updated_at']),
  }),
})

export const SHIFT_GRANT_TABLES = Object.freeze(Object.keys(SHIFT_COLUMN_GRANTS))

/** The migration that introduced the column grants. Guards apply to later ones. */
export const SHIFT_GRANT_MIGRATION = 646
