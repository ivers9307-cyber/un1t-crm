// STAFFCOST.1 — the per-report-type visibility decision.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import {
  RATE_REPORT_TYPES, RATE_REPORT_VIEWER_ROLES, RATE_REPORT_TYPES_IN_LIST,
  canViewReportType, isRateReportType, roleAllowedAtLocationForUi, adminOnlyReportRefusal,
  adminOnlyReportName,
} from './report-access'
import { reportTypeSchema, ADMIN_ROLES } from './schemas'
import { hasRoleAtLocation } from './auth'

const LOC = 'loc-a'
const OTHER = 'loc-b'
const user = (role, extra = {}) => ({ role, profileRole: role, rolesByLocation: { [LOC]: role }, activeLocation: { id: LOC }, ...extra })

describe('report-access', () => {
  it('staff_cost and utilisation are admin-only: a rate, a cost, or a colleague\'s contract (CONTRACTVIS.1)', () => {
    expect([...RATE_REPORT_TYPES]).toEqual(['staff_cost', 'utilisation'])
    expect(RATE_REPORT_TYPES_IN_LIST).toBe('(staff_cost,utilisation)')
    for (const t of RATE_REPORT_TYPES) expect(reportTypeSchema.safeParse(t).success).toBe(true)
  })

  it('names the report in its refusal', () => {
    expect(adminOnlyReportRefusal('run', 'staff_cost')).toBe('Only owners and managers can run staff cost reports.')
    expect(adminOnlyReportRefusal('schedule', 'utilisation')).toBe('Only owners and managers can schedule staff utilisation reports.')
  })

  it('every admin-only type has a name, so no refusal reads "these reports"', () => {
    for (const t of RATE_REPORT_TYPES) expect(adminOnlyReportName(t)).not.toBe('these')
    expect(adminOnlyReportName('staff_hours')).toBe('these')
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
