import { describe, it, expect } from 'vitest'
import { mobileApprovalSections, approvalsBadgeCount, MOBILE_APPROVAL_KEYS } from './approvals'

const prov = (key, n) => ({ key, label: key, count: n, items: Array.from({ length: n }, (_, i) => ({ id: `${key}-${i}` })) })

describe('MOBILE_APPROVAL_KEYS', () => {
  it('is the four categories in order', () => {
    expect(MOBILE_APPROVAL_KEYS).toEqual(['time_off', 'shift_swaps', 'fte_expenses', 'contractor_invoices'])
  })
})

describe('mobileApprovalSections', () => {
  it('keeps only the four mobile categories, fixed order, drops empties + unknowns', () => {
    const providers = [
      prov('contractor_invoices', 1),
      prov('issues', 3),       // unknown → excluded
      prov('time_off', 2),
      prov('shift_swaps', 0),  // empty → dropped
      prov('fte_expenses', 1),
    ]
    expect(mobileApprovalSections(providers).map((s) => s.key))
      .toEqual(['time_off', 'fte_expenses', 'contractor_invoices'])
  })
  it('tolerates non-arrays', () => {
    expect(mobileApprovalSections(null)).toEqual([])
    expect(mobileApprovalSections(undefined)).toEqual([])
  })
})

describe('approvalsBadgeCount', () => {
  it('sums only the four mobile categories', () => {
    expect(approvalsBadgeCount([prov('time_off', 2), prov('issues', 5), prov('fte_expenses', 1), prov('rosters', 9)])).toBe(3)
  })
  it('is 0 for none / non-array', () => {
    expect(approvalsBadgeCount([])).toBe(0)
    expect(approvalsBadgeCount(null)).toBe(0)
  })
})
