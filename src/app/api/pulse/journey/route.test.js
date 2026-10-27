import { describe, it, expect, vi, beforeEach } from 'vitest'

// PULSEUN1T.1 — /api/pulse/journey picks the lane by the studio's membership source.

const LOC = '11111111-1111-4111-8111-111111111111'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => true),
  hasPermissionForLocation: vi.fn(() => true),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/onboarding-journey-data', () => ({ loadJourneyLane: vi.fn() }))
vi.mock('@/lib/onboarding-journey-un1t', () => ({ loadUn1tOnlineJourneyLane: vi.fn() }))
vi.mock('@/lib/membership/source', () => ({ membershipSourceState: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { loadJourneyLane } = await import('@/lib/onboarding-journey-data')
const { loadUn1tOnlineJourneyLane } = await import('@/lib/onboarding-journey-un1t')
const { membershipSourceState } = await import('@/lib/membership/source')
const { GET } = await import('./route')

const call = () => GET(new Request(`http://x/api/pulse/journey?location_id=${LOC}`))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: LOC } })
  loadJourneyLane.mockResolvedValue({ config: {}, lane: [{ contactId: 'glofox' }] })
  loadUn1tOnlineJourneyLane.mockResolvedValue({ config: {}, lane: [{ contactId: 'un1t' }] })
})

describe('GET /api/pulse/journey', () => {
  it('reads the un1t.online lane at a un1t.online studio', async () => {
    membershipSourceState.mockResolvedValue({ source: 'un1t_online', state: 'configured' })
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).data.lane).toEqual([{ contactId: 'un1t' }])
    expect(loadUn1tOnlineJourneyLane).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(loadJourneyLane).not.toHaveBeenCalled()
  })

  it('keeps the Glofox lane at a Glofox studio', async () => {
    membershipSourceState.mockResolvedValue({ source: 'glofox', state: 'configured' })
    const res = await call()
    expect((await res.json()).data.lane).toEqual([{ contactId: 'glofox' }])
    expect(loadUn1tOnlineJourneyLane).not.toHaveBeenCalled()
  })

  it('keeps the Glofox lane at a studio with no membership source', async () => {
    membershipSourceState.mockResolvedValue({ source: 'none', state: 'none' })
    await call()
    expect(loadJourneyLane).toHaveBeenCalled()
  })

  it('answers 500 when the membership source cannot be read, and reads no lane', async () => {
    membershipSourceState.mockResolvedValue({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE' })
    const res = await call()
    expect(res.status).toBe(500)
    expect(loadJourneyLane).not.toHaveBeenCalled()
    expect(loadUn1tOnlineJourneyLane).not.toHaveBeenCalled()
  })
})
