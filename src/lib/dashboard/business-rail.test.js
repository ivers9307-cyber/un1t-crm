// UN1TRADAR.2 — the rail's arrears row reads through the membership seam.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/approvals/registry', () => ({ getPendingApprovalsCount: vi.fn(async () => 0) }))
vi.mock('@/lib/membership/reads/index', () => ({ radarReadsFor: vi.fn() }))

import { radarReadsFor } from '@/lib/membership/reads/index'
import { buildNeedsYouRail } from './business-rail'

const L = 'loc-1'
// every other row's query answers nothing
const db = (() => {
  const api = { from: () => api, select: () => api, eq: () => api, gte: () => api, lte: () => api, in: () => api, order: () => api, limit: () => api, then: (res) => Promise.resolve({ data: [], error: null }).then(res) }
  return api
})()
const arrearsRow = async () => (await buildNeedsYouRail(db, { id: 'u1' }, L, new Date('2026-10-18T12:00:00Z'))).find((r) => r.key === 'arrears') ?? null

beforeEach(() => vi.clearAllMocks())

describe('rail arrearsRow', () => {
  it('Glofox text unchanged', async () => {
    const arrears = vi.fn(async () => ({ success: true, data: { totalCents: 123456, memberCount: 3 } }))
    radarReadsFor.mockResolvedValue({ source: 'glofox', reads: { arrears }, providesMemberships: true, pinArrears: false })
    expect(await arrearsRow()).toEqual({ key: 'arrears', chip: 'Arrears', tone: 'amber', text: '3 members — €1,235 owed', href: '/dashboard/churn-radar' })
    expect(arrears).toHaveBeenCalledWith(db, L)
  })
  it('un1t via the seam; an estimate says so', async () => {
    const arrears = vi.fn(async () => ({ success: true, data: { totalCents: 16500, memberCount: 1, estimated: true } }))
    radarReadsFor.mockResolvedValue({ source: 'un1t_online', reads: { arrears }, providesMemberships: false, pinArrears: true })
    expect((await arrearsRow()).text).toBe('1 member owes €165, includes an estimate')
  })
  it('unsupported, failed or nobody owing → no row', async () => {
    radarReadsFor.mockResolvedValue({ source: 'none', reads: {}, providesMemberships: false, pinArrears: false })
    expect(await arrearsRow()).toBeNull()
    radarReadsFor.mockResolvedValue({ source: 'glofox', reads: { arrears: async () => ({ success: false, error: 'x' }) } })
    expect(await arrearsRow()).toBeNull()
    radarReadsFor.mockRejectedValue(new Error('unreadable'))
    expect(await arrearsRow()).toBeNull()
    radarReadsFor.mockResolvedValue({ source: 'glofox', reads: { arrears: async () => ({ success: true, data: { totalCents: 0, memberCount: 0 } }) } })
    expect(await arrearsRow()).toBeNull()
  })
})
