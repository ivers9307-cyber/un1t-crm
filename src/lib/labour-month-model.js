// src/lib/labour-month-model.js
//
// LABOUR.1 — owner-only labour against revenue for the current Dublin month.
// Pure: no IO, no clock of its own (nowMs is passed in), and nothing reads the
// host's timezone (tests run under Europe/Dublin and America/Los_Angeles).
//
// Definitions (plan 35-LABOUR.1.md, D1-D13; don't re-derive them elsewhere):
//   revenue   = the Studio scorecard's MRR (shared/studio-kpis.js fetchMrr),
//               "so far" = MRR × the elapsed fraction of the month.
//   employees = annual_salary / 12 a month whatever the roster says, split
//               between studios by published hours; "so far" = × elapsed.
//   contractors = published hours × hourly_rate, ADMIN SHIFTS INCLUDED (unlike
//               contractor spend's budget gate: an admin shift is still paid).
//   forecast  = the published roster for the whole month; actual = published
//               shifts that have ended. Drafts are never costed.
//
// PAY NEVER LEAVES THIS MODULE AS A RATE. buildLabourMonth takes each person's
// annual_salary / hourly_rate and returns studio TOTALS, ratios and hours, plus
// the NAMES of people it could not cost. The test stringifies the result and
// greps it for every rate it was given.

import { workingWindow, EMPLOYEE_TYPE } from '@shared/working-time'
import { isLiveAssignment } from './roster'
import { hasRoleAtLocation } from './role-at-location'
import { dublinDayStr, dublinDayRangeMs } from './dublin-time'

export const CONTRACTOR_TYPE = 'contractor'

// Richard's program rule: pay reaches owners only. Masters pass through
// hasRoleAtLocation's bypass. Deliberately NOT ADMIN_ROLES (which has manager).
export const LABOUR_VIEWER_ROLES = Object.freeze(['owner'])

// OWNER REVIEW (LABOUR.1 open question 3): a salaried employee with no
// published hours this month is still paid, so their salary is split equally
// across their studios. Flip to false to leave unrostered salaries out.
export const COUNT_UNROSTERED_SALARIES = true

const MINUTE_MS = 60_000

/**
 * The Dublin calendar month holding `nowMs`.
 * @param {number} nowMs
 */
export function labourMonthWindow(nowMs) {
  const today = dublinDayStr(nowMs)
  const month = today.slice(0, 7)
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const startDate = `${month}-01`
  const endDate = `${month}-${String(daysInMonth).padStart(2, '0')}`
  const { startMs, endMs } = dublinDayRangeMs(startDate, endDate)
  const elapsedFraction = Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)))
  const monthLabel = new Intl.DateTimeFormat('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, 1)))
  return {
    month, monthLabel, startDate, endDate, startMs, endMs,
    daysInMonth, dayOfMonth: Number(today.slice(8, 10)), elapsedFraction,
  }
}

/**
 * The studios of the ACTIVE organisation where `user` may see labour: owner
 * at that studio (a master everywhere). Ordered by name.
 * @returns {{ id: string, name: string }[]}
 */
export function labourStudiosFor(user) {
  const orgId = user?.activeLocation?.organization_id
  if (!user?.activeLocation?.id || !orgId) return []
  return (user.locations || [])
    .filter((l) => l?.id && l.organization_id === orgId && hasRoleAtLocation(user, l.id, LABOUR_VIEWER_ROLES))
    .map((l) => ({ id: l.id, name: l.name || 'Studio' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The block renders only when the ACTIVE studio is one the viewer owns. */
export function canSeeLabour(user) {
  const activeId = user?.activeLocation?.id
  return !!activeId && labourStudiosFor(user).some((s) => s.id === activeId)
}
