import { describe, it, expect } from 'vitest'
import { lensMetrics, lensRisk } from './contact-lens.js'

const S = 'a0000000-0000-4000-8000-00000000000a'
const H = 'b0000000-0000-4000-8000-00000000000b'
const G = { locationId: S, name: 'UN1T Stillorgan', platform: 'glofox', primary: true, attended30d: 9, lastAttendedAt: '2026-10-25T07:00:00Z', ltvCents: 90000, owedCents: 0, overdue: false }
const U = { locationId: H, name: 'UN1T Hatch Street', platform: 'un1t_online', primary: false, attended30d: 3, lastAttendedAt: '2026-10-26T18:30:00Z', ltvCents: 15000, owedCents: 4500, overdue: true, amountUnreported: false }
const BASE = { attended: 9, lastAttendedAt: '2026-10-25T07:00:00Z', arrearsCents: 4500, glofoxArrearsCents: 0, ltvCents: 90000, deals: 2, un1t: { overdue: true, amountUnreported: false, amountNotEur: false } }
const DEALS = [{ location_id: S }, { location_id: H }]

describe('lensMetrics (CARDLENS.9)', () => {
  it('a Hatch-only member: the header reads un1t.online, not empty Glofox columns', () => {
    const m = lensMetrics({ memberships: [U], lensId: H, base: { ...BASE, attended: 0, lastAttendedAt: null, ltvCents: null, deals: 0 }, deals: [] })
    expect(m).toMatchObject({ attended: 3, lastAttendedAt: '2026-10-26T18:30:00Z', ltvCents: 15000, arrearsCents: 4500, un1t: { overdue: true } })
  })

  it('lens on the Glofox studio: the Glofox figures and that studio\'s deals, no un1t overdue', () => {
    const m = lensMetrics({ memberships: [G, U], lensId: S, base: BASE, deals: DEALS })
    expect(m).toMatchObject({ attended: 9, ltvCents: 90000, arrearsCents: 0, deals: 1, un1t: null })
  })

  it('All studios: attendance and value summed, the latest class, the merged arrears', () => {
    const m = lensMetrics({ memberships: [G, U], lensId: 'all', base: BASE, deals: DEALS })
    expect(m).toMatchObject({ attended: 12, lastAttendedAt: '2026-10-26T18:30:00Z', ltvCents: 105000, arrearsCents: 4500, deals: 2, un1t: BASE.un1t })
  })

  it('unknown counts are skipped in a sum, never read as 0', () => {
    const m = lensMetrics({ memberships: [G, { ...U, attended30d: null, ltvCents: null }], lensId: 'all', base: BASE, deals: DEALS })
    expect(m).toMatchObject({ attended: 9, ltvCents: 90000 })
  })

  it('a CRM-only studio: nothing to count there', () => {
    const N = { locationId: H, name: 'CCF', platform: 'none', attended30d: null, lastAttendedAt: null, ltvCents: null, owedCents: null, overdue: false }
    expect(lensMetrics({ memberships: [G, N], lensId: H, base: BASE, deals: DEALS })).toMatchObject({ attended: null, lastAttendedAt: null, ltvCents: null, arrearsCents: null, deals: 1, un1t: null })
  })

  it('one studio: the deal count is not filtered (old deals may sit at a studio with no row)', () => {
    expect(lensMetrics({ memberships: [G], lensId: S, base: BASE, deals: DEALS })).toMatchObject({ deals: 2 })
  })

  it('no memberships (a failed read) or a lens not among them: today\'s figures', () => {
    expect(lensMetrics({ memberships: [], lensId: S, base: BASE, deals: DEALS })).toEqual({ ...BASE })
    expect(lensMetrics({ memberships: [G, U], lensId: 'x', base: BASE, deals: DEALS })).toEqual({ ...BASE })
  })
})

describe('lensRisk (CARDLENS.9)', () => {
  const OVERDUE = { label: 'Payment overdue', cls: 'r', title: 'Glofox' }
  const CHURN = { label: 'At risk · High', cls: 'r', title: 'signals' }
  const BILLING = { overdue: true, studios: [{ locationId: H, locationName: 'UN1T Hatch Street', pastDues: [{ since: '2026-10-20' }] }] }
  const names = { [S]: 'Stillorgan', [H]: 'Hatch Street' }

  it('lens on a un1t.online studio: only that studio\'s overdue, named', () => {
    const r = lensRisk({ lensId: H, memberships: [G, U], glofoxOverdue: OVERDUE, glofoxChurn: CHURN, un1tBilling: BILLING, names })
    expect(r.label).toBe('Payment overdue · Hatch Street')
  })

  it('lens on the Glofox studio: the Glofox signal only', () => {
    expect(lensRisk({ lensId: S, memberships: [G, U], glofoxOverdue: null, glofoxChurn: CHURN, un1tBilling: BILLING, names }).label).toBe('At risk · High · Stillorgan')
    expect(lensRisk({ lensId: S, memberships: [G, U], glofoxOverdue: null, glofoxChurn: null, un1tBilling: BILLING, names })).toBeNull()
  })

  it('All studios: the worst, as before (Glofox overdue, then un1t overdue, then churn), named', () => {
    expect(lensRisk({ lensId: 'all', memberships: [G, U], glofoxOverdue: null, glofoxChurn: CHURN, un1tBilling: BILLING, names }).label).toBe('Payment overdue · Hatch Street')
    expect(lensRisk({ lensId: 'all', memberships: [G, U], glofoxOverdue: OVERDUE, glofoxChurn: CHURN, un1tBilling: BILLING, names }).label).toBe('Payment overdue · Stillorgan')
  })

  it('one studio: no studio name on the chip, exactly as before', () => {
    expect(lensRisk({ lensId: S, memberships: [G], glofoxOverdue: null, glofoxChurn: CHURN, un1tBilling: { overdue: false, studios: [] }, names: {} })).toEqual(CHURN)
    expect(lensRisk({ lensId: S, memberships: [], glofoxOverdue: OVERDUE, glofoxChurn: null, un1tBilling: null, names: {} })).toEqual(OVERDUE)
  })
})
