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
import { membershipStateForPage } from '@/lib/membership/state-for-page'
import { un1tOnlineReads as un1t } from '@/lib/membership/reads/un1t-online'

const GLOFOX_STATE = { source: 'glofox', state: 'configured', label: 'Glofox', capabilities: { memberships: true, bookings: true, credits: true, invoices: true, schedule: true } }
const UN1T_STATE = { source: 'un1t_online', state: 'configured', label: 'un1t.online', capabilities: { memberships: false, bookings: false, credits: false, invoices: false, schedule: false } }

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
// UN1TREAD.3 — the source state is stubbed; the seam, the Glofox adapter and
// providesCapability are the real ones, wrapping the mocked Glofox functions.
// The un1t adapter's own reads are tested in reads/un1t-online.test.js; here it is two stubs.
vi.mock('@/lib/membership/reads/un1t-online', () => ({
  un1tOnlineReads: Object.freeze({ revenueMtd: vi.fn(), membershipCounts: vi.fn() }),
}))
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => ({
  ...(await importOriginal()),
  membershipStateForPage: vi.fn(),
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
  membershipStateForPage.mockResolvedValue(GLOFOX_STATE)
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

// UN1TREAD.3 — the numbers come through the membership read seam.
describe('buildBusinessKpis: through the read seam (UN1TREAD.3)', () => {
  it('glofox: the view-model is deep-equal to what the direct calls produced, with the same read arguments', async () => {
    const db = mockDb({ data: [{ high_risk: 3, captured_at: '2026-07-01' }] })
    const now = Date.parse('2026-09-15T10:00:00Z')
    const vm = await buildBusinessKpis(db, USER, LOC, now)
    expect(vm).toEqual({
      revenue: { totalCents: 1234500, paidCount: 42, deltaPct: 12.4 },
      arrearsData: { totalCents: 45000, memberCount: 3 },
      memberCount: 210,
      churnCount: 5,
      churnDelta: 2,
      briefing:
        'Solid month so far: €12,345 MTD (+12%), 210 members. ' +
        'Watch: 2 pending approvals, 3 in arrears (€450), 5 at churn risk.',
      gate: { state: 'configured', showNumbers: true },
    })
    expect(fetchRevenueMTD).toHaveBeenCalledWith(db, LOC, new Date(now), expect.any(String))
    expect(fetchArrearsSummary).toHaveBeenCalledWith(db, LOC)
    expect(computeMembershipCounts).toHaveBeenCalledWith(db, LOC)
    expect(loadRadar).toHaveBeenCalledWith(db, LOC)
  })

  it('un1t.online: revenue + members from the un1t reads; arrears and churn are null and the radar never runs', async () => {
    membershipStateForPage.mockResolvedValue(UN1T_STATE)
    un1t.revenueMtd.mockResolvedValue({ success: true, data: { totalCents: 500000, paidCount: 20, deltaPct: null } })
    un1t.membershipCounts.mockResolvedValue({ active_recurring: 40, monthly_recurring: 45 })
    {
      const db = mockDb({ data: [{ high_risk: 3 }] })
      const vm = await buildBusinessKpis(db, USER, LOC)
      expect(vm).toMatchObject({ revenue: { totalCents: 500000 }, arrearsData: null, memberCount: 40, churnCount: null, churnDelta: null, gate: { state: 'configured', showNumbers: true } })
      expect(vm.briefing).toBe('Solid month so far: €5,000 MTD, 40 members. Watch: 2 pending approvals.')
      expect(un1t.revenueMtd).toHaveBeenCalledOnce()
      expect(fetchArrearsSummary).not.toHaveBeenCalled()
      expect(loadRadar).not.toHaveBeenCalled()
      expect(db.from).not.toHaveBeenCalledWith('churn_radar_snapshots') // not even the comparator
    }
  })

  // UN1TREAD.7 — radarOk comes from the reads result's own capabilities; a second
  // state read (cache expiry between the two) can no longer flip it.
  it('asks the membership state once, and decides the radar from that answer', async () => {
    let calls = 0
    membershipStateForPage.mockImplementation(async () => (++calls === 1 ? GLOFOX_STATE : UN1T_STATE))
    const vm = await buildBusinessKpis(mockDb({ data: [] }), USER, LOC)
    expect(calls).toBe(1)
    expect(loadRadar).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(vm.churnCount).toBe(5)
  })

  it('un1t.online: a failed revenue read is the whole-block failure (null), a failed count read just a null count', async () => {
    membershipStateForPage.mockResolvedValue(UN1T_STATE)
    const base = un1t
    {
      base.revenueMtd.mockResolvedValue({ success: false, error: 'un1t down' })
      base.membershipCounts.mockResolvedValue({ active_recurring: 1 })
      expect(await buildBusinessKpis(mockDb({ data: [] }), USER, LOC)).toBeNull()
      base.revenueMtd.mockResolvedValue({ success: true, data: { totalCents: 100, paidCount: 1, deltaPct: null } })
      base.membershipCounts.mockRejectedValue(new Error('un1t down'))
      const vm = await buildBusinessKpis(mockDb({ data: [] }), USER, LOC)
      expect(vm.memberCount).toBeNull()
    }
  })

  it.each([
    ['none', { source: 'none', state: 'none', label: 'No membership source', capabilities: { memberships: false } }],
    ['unknown', { source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} }],
    ['unconfigured', { source: 'glofox', state: 'unconfigured', missing: ['API Key'], label: 'Glofox', capabilities: { memberships: true } }],
  ])('%s: no membership read runs; a numberless view-model keeps the briefing for the gate', async (_n, state) => {
    membershipStateForPage.mockResolvedValue(state)
    const db = mockDb({ data: [] })
    const vm = await buildBusinessKpis(db, USER, LOC)
    // Never revenue: null (pre-M3c phones read kpis.revenue.totalCents unguarded).
    expect(vm).toEqual({
      revenue: { totalCents: 0, paidCount: 0, deltaPct: null },
      arrearsData: null, memberCount: null, churnCount: null, churnDelta: null,
      briefing: 'Watch: 2 pending approvals.',
      gate: { state: state.state, showNumbers: false },
    })
    for (const fn of [fetchRevenueMTD, fetchArrearsSummary, computeMembershipCounts, loadRadar]) expect(fn).not.toHaveBeenCalled()
    expect(db.from).not.toHaveBeenCalled()
  })
})
