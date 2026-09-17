// STAFFCOST.1 — the per-report-type visibility decision.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import {
  RATE_REPORT_TYPES, RATE_REPORT_VIEWER_ROLES, RATE_REPORT_TYPES_IN_LIST,
  canViewReportType, isRateReportType, roleAllowedAtLocationForUi,
} from './report-access'
import { reportTypeSchema, ADMIN_ROLES } from './schemas'
import { hasRoleAtLocation } from './auth'

const LOC = 'loc-a'
const OTHER = 'loc-b'
const user = (role, extra = {}) => ({ role, profileRole: role, rolesByLocation: { [LOC]: role }, activeLocation: { id: LOC }, ...extra })

describe('report-access', () => {
  it('only staff_cost is rate-bearing (a new type carrying rates or cost must be added here)', () => {
    expect([...RATE_REPORT_TYPES]).toEqual(['staff_cost'])
    expect(RATE_REPORT_TYPES_IN_LIST).toBe('(staff_cost)')
    // Every rate type is a real report type.
    for (const t of RATE_REPORT_TYPES) expect(reportTypeSchema.safeParse(t).success).toBe(true)
  })

  it('rate viewers are the same set that sees HR fields on the staff list', () => {
    expect(RATE_REPORT_VIEWER_ROLES).toBe(ADMIN_ROLES)
  })

  const ALL_TYPES = reportTypeSchema.options
  const matrix = [
    ['master', true, true],
    ['owner', true, true],
    ['manager', true, true],
    ['head_coach', true, false],
    ['staff', false, false],
  ]
  for (const hasRole of [roleAllowedAtLocationForUi, hasRoleAtLocation]) {
    for (const [role, nonRate, rate] of matrix) {
      it(`${role} via ${hasRole.name}: non-rate ${nonRate}, rate ${rate}`, () => {
        for (const t of ALL_TYPES) {
          const expected = isRateReportType(t) ? rate : nonRate
          expect(canViewReportType(user(role), LOC, t, { hasRole })).toBe(expected)
        }
      })
    }
  }

  it('is judged at the given location, not the active one', () => {
    const u = { role: 'manager', profileRole: 'manager', rolesByLocation: { [LOC]: 'manager', [OTHER]: 'head_coach' }, activeLocation: { id: LOC } }
    expect(canViewReportType(u, LOC, 'staff_cost', { hasRole: hasRoleAtLocation })).toBe(true)
    expect(canViewReportType(u, OTHER, 'staff_cost', { hasRole: hasRoleAtLocation })).toBe(false)
    expect(canViewReportType(u, OTHER, 'staff_hours', { hasRole: hasRoleAtLocation })).toBe(true)
    expect(canViewReportType(u, OTHER, 'staff_cost')).toBe(false)
  })

  it('UI fallback to user.role applies only to the active location and only without rolesByLocation', () => {
    expect(roleAllowedAtLocationForUi({ role: 'manager', activeLocation: { id: LOC } }, LOC, ADMIN_ROLES)).toBe(true)
    expect(roleAllowedAtLocationForUi({ role: 'manager', activeLocation: { id: LOC } }, OTHER, ADMIN_ROLES)).toBe(false)
    expect(roleAllowedAtLocationForUi({ role: 'manager', rolesByLocation: {}, activeLocation: { id: LOC } }, LOC, ADMIN_ROLES)).toBe(false)
    expect(roleAllowedAtLocationForUi(null, LOC, ADMIN_ROLES)).toBe(false)
  })
})
