// STAFFCOST.1 — who may see which schedule report.
//
// Richard's call: head coaches do not see colleagues' pay rates or staff
// cost. That was already true everywhere else pay data lives — the staff
// list hands HR columns only to ADMIN_ROLES (src/lib/staff.js), and
// week-cost / contractor-spend give head_coach hours and aggregates while
// "the per-coach figures never leave the server" — but the Reporting tab
// was gated on MANAGER_ROLES, which includes head_coach, and the Staff Cost
// report stores every person's hourly rate and cost. So a head coach could
// generate, list and be emailed exactly what the rest of the app hides.
//
// The rate-viewing set is ADMIN_ROLES (master, owner, manager), the same set
// staff.js uses for HR fields. Judged at the REPORT's location, never the
// caller's active one: a manager at Stillorgan who is head coach at Hatch
// sees Stillorgan's cost reports and not Hatch's.
//
// Per report type — decided by what generateReport() actually writes into
// report_data and summary (src/lib/report-generator.js):
//   staff_hours      name, role, employment_type, per-day hours, total.
//                    No rate, no cost → head coaches keep it.
//   staff_cost       regular_rate, overtime_rate, per-week and total cost,
//                    and summary total_*_cost → RATE-BEARING, admin only.
//   time_off_summary time_off_requests rows (dates, type, status, reason,
//                    review note) and per-staff day counts. time_off_requests
//                    has no pay column (mig 011) → head coaches keep it;
//                    they already approve time off.
//   roster_coverage  shifts per day, staff working / off. No pay → kept.
//   utilisation      contracted vs actual hours and a percentage. Contracted
//                    hours are not pay data (staff.js ships them to every
//                    role in STAFF_PUBLIC_FIELDS) → kept.
//
// A NEW report type that carries a rate or a cost must be added to
// RATE_REPORT_TYPES; report-access.test.js pins the set.
//
// This module is PURE and client-safe (ScheduleReporting imports it to hide
// the tile). @/lib/auth is server-only, so the role-at-location check is
// injected: routes pass auth.js's hasRoleAtLocation, the browser uses the
// local mirror below — which only ever decides what to SHOW. The server is
// the enforcement.

import { ADMIN_ROLES, MANAGER_ROLES } from '@/lib/schemas'

export const RATE_REPORT_TYPES = Object.freeze(['staff_cost'])
export const RATE_REPORT_VIEWER_ROLES = ADMIN_ROLES

export function isRateReportType(reportType) {
  return RATE_REPORT_TYPES.includes(reportType)
}

// PostgREST list literal for `.not('report_type', 'in', …)` and `.or(…)`.
// Report types are fixed snake_case identifiers, so no quoting is needed.
export const RATE_REPORT_TYPES_IN_LIST = `(${RATE_REPORT_TYPES.join(',')})`

/**
 * Client-side mirror of auth.js's hasRoleAtLocation, for UI decisions only.
 * Same master bypass (profileRole) and the same per-location lookup. One
 * difference, on purpose: when the user object carries no rolesByLocation
 * at all, the active location falls back to user.role — a display
 * convenience for callers that hand a slim user object. Never use this to
 * enforce anything.
 */
export function roleAllowedAtLocationForUi(user, locationId, allowedRoles) {
  if (!user || !locationId) return false
  if (user.profileRole === 'master' || user.role === 'master') return true
  let role = user.rolesByLocation?.[locationId]
  if (!role && !user.rolesByLocation && user.activeLocation?.id === locationId) role = user.role
  if (!role) return false
  return (allowedRoles || []).includes(role)
}

/**
 * May `user` see reports of `reportType` at `locationId`?
 *
 * @param {object} user
 * @param {string} locationId  the REPORT's location
 * @param {string} reportType
 * @param {{ hasRole?: (user, locationId, roles) => boolean }} [opts]
 *   Server callers MUST pass auth.js's hasRoleAtLocation.
 */
export function canViewReportType(user, locationId, reportType, { hasRole = roleAllowedAtLocationForUi } = {}) {
  if (!hasRole(user, locationId, MANAGER_ROLES)) return false
  if (isRateReportType(reportType)) return hasRole(user, locationId, RATE_REPORT_VIEWER_ROLES)
  return true
}
