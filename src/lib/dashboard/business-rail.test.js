// ARREARSONE.1 — the rail's arrears row is the KPI card's number: the radar's
// Overdue count (overdue memberships minus the dismissed), from the shared cache.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/approvals/registry', () => ({ getPendingApprovalsCount: vi.fn(async () => 0) }))
vi.mock('@/lib/membership/reads/index', () => ({ radarReadsFor: vi.fn(async () => ({ providesMemberships: false })) }))
vi.mock('@/lib/membership/reads', () => ({ membershipReadsFor: vi.fn() }))
vi.mock('@/lib/membership/state-for-page', () => ({ providesCapability: (m, cap) => Boolean(m?.caps?.includes(cap)) }))
vi.mock('@/lib/dashboard/churn-count', async (orig) => ({ ...(await orig()), cachedChurnRadar: vi.fn() }))

import { membershipReadsFor } from '@/lib/membership/reads'
import { cachedChurnRadar } from '@/lib/dashboard/churn-count'
import { buildNeedsYouRail } from './business-rail'

const L = 'loc-1'
// every other row's query answers nothing
const db = (() => {
  const api = { from: () => api, select: () => api, eq: () => api, gte: () => api, lte: () => api, in: () => api, order: () => api, limit: () => api, then: (res) => Promise.resolve({ data: [], error: null }).then(res) }
  return api
})()
const arrearsRow = async () => (await buildNeedsYouRail(db, { id: 'u1' }, L, new Date('2026-10-18T12:00:00Z'))).find((r) => r.key === 'arrears') ?? null
const withMembers = () => membershipReadsFor.mockResolvedValue({ reads: {}, caps: ['memberships'] })

beforeEach(() => vi.clearAllMocks())

describe('rail arrearsRow', () => {
  it('names the overdue members and what they owe', async () => {
    withMembers()
    cachedChurnRadar.mockResolvedValue({ summary: { overdue: 3, overdueValueCents: 123456 } })
    expect(await arrearsRow()).toEqual({ key: 'arrears', chip: 'Arrears', tone: 'amber', text: '3 members owe €1,235', href: '/dashboard/churn-radar' })
    expect(cachedChurnRadar).toHaveBeenCalledWith(db, L)
  })
  it('an estimate says so; an unknown total is never "€0"', async () => {
    withMembers()
    cachedChurnRadar.mockResolvedValue({ summary: { overdue: 1, overdueValueCents: 16500, overdueValueEstimated: true } })
    expect((await arrearsRow()).text).toBe('1 member owes €165, includes an estimate')
    cachedChurnRadar.mockResolvedValue({ summary: { overdue: 1, overdueValueCents: 0, overdueValueEstimated: true } })
    expect((await arrearsRow()).text).toBe('1 member owes amount not available from un1t.online')
  })
  it('no memberships, a failed radar or nobody owing: no row', async () => {
    membershipReadsFor.mockResolvedValue({ reads: {}, caps: [] })
    expect(await arrearsRow()).toBeNull()
    withMembers()
    cachedChurnRadar.mockRejectedValue(new Error('unreadable'))
    expect(await arrearsRow()).toBeNull()
    cachedChurnRadar.mockResolvedValue({ summary: { overdue: 0, overdueValueCents: 0 } })
    expect(await arrearsRow()).toBeNull()
  })
})
