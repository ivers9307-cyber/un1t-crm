// buildBusinessKpis — DASH-M.1 extraction test.
//
// The composition rules are the bit that bites: revenue failure kills
// the whole block (null → error cell) while every OTHER source
// degrades quietly (null card values, dropped briefing labels, zeroed
// approvals). Wrong degradation = a dishonest "€0 · 0 members" board.
// Data sources are mocked; buildBusinessBriefing runs REAL so the
// briefing sentence is pinned end-to-end.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildBusinessKpis } from './business-kpis'
import { fetchRevenueMTD, fetchArrearsSummary } from '@shared/dashboard-data'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'
import { computeMembershipCounts } from '@/lib/membership-snapshot'
import { loadRadar } from '@/lib/churn-radar-data'

vi.mock('@shared/dashboard-data', () => ({
  fetchRevenueMTD: vi.fn(),
  fetchArrearsSummary: vi.fn(),
}))
vi.mock('@/lib/approvals/registry', () => ({
  getPendingApprovalsCount: vi.fn(),
}))
vi.mock('@/lib/membership-snapshot', () => ({
  computeMembershipCounts: vi.fn(),
}))
vi.mock('@/lib/churn-radar-data', () => ({
  loadRadar: vi.fn(),
}))

// The churn comparator is a direct thenable query chain
// (from → select → eq → lte → order → limit → .then(onF, onR)).
function mockDb(snapshotResult, { reject = false } = {}) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    lte: () => chain,
    order: () => chain,
    limit: () => chain,
    then: (onFulfilled, onRejected) => (reject
      ? Promise.reject(new Error('snapshot query failed')).then(onFulfilled, onRejected)
      : Promise.resolve(snapshotResult).then(onFulfilled, onRejected)),
  }
  return { from: vi.fn(() => chain) }
}

const USER = { id: 'user-1' }
const LOC = 'loc-1'

function happyPathMocks() {
  fetchRevenueMTD.mockResolvedValue({ success: true, data: { totalCents: 1234500, paidCount: 42, deltaPct: 12.4 } })
  fetchArrearsSummary.mockResolvedValue({ success: true, data: { totalCents: 45000, memberCount: 3 } })
  computeMembershipCounts.mockResolvedValue({ active_recurring: 210, monthly_recurring: 250 })
  loadRadar.mockResolvedValue({ summary: { highRisk: 5 } })
  getPendingApprovalsCount.mockResolvedValue(2)
}

beforeEach(() => {
  vi.resetAllMocks()
  happyPathMocks()
})

describe('buildBusinessKpis', () => {
  it('composes the full view-model on the happy path', async () => {
    const db = mockDb({ data: [{ high_risk: 3, captured_at: '2026-07-01' }] })
    const vm = await buildBusinessKpis(db, USER, LOC)
    expect(vm).not.toBeNull()
    expect(vm.revenue).toEqual({ totalCents: 1234500, paidCount: 42, deltaPct: 12.4 })
    expect(vm.arrearsData).toEqual({ totalCents: 45000, memberCount: 3 })
    expect(vm.memberCount).toBe(210) // active_recurring wins over monthly_recurring
    expect(vm.churnCount).toBe(5)
    expect(vm.churnDelta).toBe(2) // 5 live − 3 in the week-old snapshot
    expect(vm.briefing).toBe(
      'Solid month so far: €12,345 MTD (+12%), 210 members. ' +
      'Watch: 2 pending approvals, 3 in arrears (€450), 5 at churn risk.'
    )
  })

  it('returns null (whole-block failure) when revenue fails', async () => {
    fetchRevenueMTD.mockResolvedValue({ success: false, error: 'boom' })
    const vm = await buildBusinessKpis(mockDb({ data: [] }), USER, LOC)
    expect(vm).toBeNull()
  })

  it('degrades arrears to null — not a fake {0,0} — and drops its label', async () => {
    fetchArrearsSummary.mockResolvedValue({ success: false, error: 'nope' })
    const vm = await buildBusinessKpis(mockDb({ data: [] }), USER, LOC)
    expect(vm.arrearsData).toBeNull()
    expect(vm.briefing).not.toContain('in arrears')
  })

  it('degrades membership to a null count (card shows —, briefing shows 0)', async () => {
    computeMembershipCounts.mockRejectedValue(new Error('db down'))
    const vm = await buildBusinessKpis(mockDb({ data: [] }), USER, LOC)
    expect(vm.memberCount).toBeNull()
    expect(vm.briefing).toContain('0 members')
  })

  it('falls back to monthly_recurring when active_recurring is nullish', async () => {
    computeMembershipCounts.mockResolvedValue({ active_recurring: null, monthly_recurring: 250 })
    const vm = await buildBusinessKpis(mockDb({ data: [] }), USER, LOC)
    expect(vm.memberCount).toBe(250)
  })

  it('nulls churnCount AND churnDelta when the radar fails, even with a snapshot', async () => {
    loadRadar.mockRejectedValue(new Error('radar down'))
    const vm = await buildBusinessKpis(mockDb({ data: [{ high_risk: 3 }] }), USER, LOC)
    expect(vm.churnCount).toBeNull()
    expect(vm.churnDelta).toBeNull()
    expect(vm.briefing).not.toContain('churn risk')
  })

  it('nulls churnDelta when the comparator snapshot query rejects (guarded thenable)', async () => {
    const vm = await buildBusinessKpis(mockDb(null, { reject: true }), USER, LOC)
    expect(vm.churnCount).toBe(5)
    expect(vm.churnDelta).toBeNull()
  })

  it('nulls churnDelta when there is no week-old snapshot yet', async () => {
    const vm = await buildBusinessKpis(mockDb({ data: [] }), USER, LOC)
    expect(vm.churnDelta).toBeNull()
  })

  it('treats an approvals-count failure as 0 (label dropped, block healthy)', async () => {
    getPendingApprovalsCount.mockRejectedValue(new Error('registry down'))
    const vm = await buildBusinessKpis(mockDb({ data: [] }), USER, LOC)
    expect(vm).not.toBeNull()
    expect(vm.briefing).not.toContain('pending approval')
  })

  it('omits zero-count labels entirely (Nothing urgent)', async () => {
    fetchArrearsSummary.mockResolvedValue({ success: true, data: { totalCents: 0, memberCount: 0 } })
    loadRadar.mockResolvedValue({ summary: { highRisk: 0 } })
    getPendingApprovalsCount.mockResolvedValue(0)
    const vm = await buildBusinessKpis(mockDb({ data: [] }), USER, LOC)
    expect(vm.briefing).toContain('Nothing urgent.')
  })
})
