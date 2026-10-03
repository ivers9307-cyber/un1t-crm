// GRANTSWEEP.1 (mig 668) — what a browser or phone session may do on the
// staff scheduling tables. The single source for
// tests/migration-668-scheduling-tables-client-grants.test.js and
// tests/scheduling-client-grants-guard.test.js.
//
//   CLOSED     no client privilege at all, RLS on with no policy
//              (read it through a service-role /api route).
//   READ_ONLY  authenticated: SELECT only (the phone's Today tab reads both);
//              anon: nothing. Every write is a service-role /api route.
//   ANON_NONE  anon and PUBLIC hold nothing (the two above + the mig 646
//              shift tables, whose authenticated column grants 668 leaves
//              unchanged; mig 676 later took their client writes and write
//              policies off: tests/shift-client-writes-guard.test.js).

export const GRANTSWEEP_MIGRATION = 668

export const CLOSED_TABLES = Object.freeze(['staff_attendance_events'])
export const READ_ONLY_TABLES = Object.freeze(['shift_swap_requests', 'time_off_requests'])
export const SHIFT_TABLES = Object.freeze(['shift_blocks', 'shift_assignments'])
export const ANON_NONE_TABLES = Object.freeze([...CLOSED_TABLES, ...READ_ONLY_TABLES, ...SHIFT_TABLES])

export const CLIENT_ROLES = Object.freeze(['anon', 'authenticated', 'public'])
export const TABLE_PRIVILEGES = Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'])

/**
 * The end state mig 668 promises: role → table → the table-level privileges
 * that role holds (everything else is false). Shift tables' SELECT is
 * column-level only (mig 646), so it is false here. This is 668's end state,
 * which its replay (646 + 668 only) proves; since mig 676 authenticated
 * holds no table-level privilege on the shift tables either
 * (tests/migration-676-shift-tables-client-writes-off.test.js).
 */
export const EXPECTED_TABLE_PRIVILEGES = Object.freeze({
  anon: Object.freeze(Object.fromEntries(ANON_NONE_TABLES.map((t) => [t, Object.freeze([])]))),
  public: Object.freeze(Object.fromEntries(ANON_NONE_TABLES.map((t) => [t, Object.freeze([])]))),
  authenticated: Object.freeze({
    staff_attendance_events: Object.freeze([]),
    shift_swap_requests: Object.freeze(['SELECT']),
    time_off_requests: Object.freeze(['SELECT']),
    shift_blocks: Object.freeze(['INSERT', 'UPDATE', 'DELETE']),
    shift_assignments: Object.freeze(['INSERT', 'UPDATE', 'DELETE']),
  }),
})
