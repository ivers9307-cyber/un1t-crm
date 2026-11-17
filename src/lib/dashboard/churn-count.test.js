// CHURNONE.1 — the Business page's KPI card and "Needs you" rail show ONE
// churn number: the live radar, read once through the shared cache.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/approvals/registry', () => ({ getPendingApprovalsCount: vi.fn(async () => 0) }))
vi.mock('@/lib/membership/reads/index', () => ({ radarReadsFor: vi.fn(async () => ({ source: 'glofox', reads: {} })) }))
vi.mock('@/lib/membership/reads', () => ({ membershipReadsFor: vi.fn(), supportsRead: vi.fn(() => false) }))
vi.mock('@/lib/membership/state-for-page', () => ({ providesCapability: vi.fn() }))
vi.mock('@/lib/churn-radar-data', () => ({ loadRadar: vi.fn() }))

import { membershipReadsFor } from '@/lib/membership/reads'
import { providesCapability } from '@/lib/membership/state-for-page'
import { loadRadar } from '@/lib/churn-radar-data'
import { invalidateRadar } from '@/lib/radar-cache'
import { buildNeedsYouRail } from './business-rail'
import { cachedChurnRadar, highRiskOf } from './churn-count'

const L = 'loc-1'
const db = (() => {
  const api = { from: () => api, select: () => api, eq: () => api, gte: () => api, lte: () => api, in: () => api, order: () => api, limit: () => api, then: (res) => Promise.resolve({ data: [], error: null }).then(res) }
  return api
})()
const churnRow = async () => (await buildNeedsYouRail(db, { id: 'u1' }, L, new Date('2026-10-18T12:00:00Z'))).find((r) => r.key === 'churn') ?? null

beforeEach(() => {
  vi.clearAllMocks()
  invalidateRadar('churn', L)
  membershipReadsFor.mockResolvedValue({ reads: {}, state: 'connected' })
  providesCapability.mockReturnValue(true)
  loadRadar.mockResolvedValue({ summary: { highRisk: 7 } })
})

describe('rail churn row (CHURNONE.1)', () => {
  it('shows the LIVE high-risk count, not a snapshot', async () => {
    expect(await churnRow()).toEqual({ key: 'churn', chip: 'Churn', tone: 'amber', text: '7 members at high risk', href: '/dashboard/churn-radar' })
  })
  it('reads the radar once for the rail and the card together (shared cache)', async () => {
    await Promise.all([churnRow(), cachedChurnRadar(db, L)])
    expect(loadRadar).toHaveBeenCalledTimes(1)
  })
  it('no row where the source supplies no memberships, and the radar never runs', async () => {
    providesCapability.mockReturnValue(false)
    expect(await churnRow()).toBeNull()
    expect(loadRadar).not.toHaveBeenCalled()
  })
  it('no row on a failed radar or zero high-risk', async () => {
    loadRadar.mockRejectedValueOnce(new Error('boom'))
    expect(await churnRow()).toBeNull()
    invalidateRadar('churn', L)
    loadRadar.mockResolvedValue({ summary: { highRisk: 0 } })
    expect(await churnRow()).toBeNull()
  })
})

describe('highRiskOf', () => {
  it('a number, or null (never a fake zero)', () => {
    expect(highRiskOf({ summary: { highRisk: 3 } })).toBe(3)
    expect(highRiskOf(null)).toBeNull()
    expect(highRiskOf({ summary: {} })).toBeNull()
  })
})
