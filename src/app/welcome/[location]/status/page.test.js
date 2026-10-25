// W1.L4 review — the public status page renders per request now (the root
// layout reads the Host header), so its `revalidate = 60` no longer bounded
// the health aggregator. A 60 s per-location module cache does instead.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getIntegrationHealth = vi.fn(async () => [])
vi.mock('@/lib/integration-health', () => ({ getIntegrationHealth: (...a) => getIntegrationHealth(...a) }))

const LOC = { id: 'loc-1', name: 'Gym A', settings: {} }
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { location_id: LOC.id, locations: LOC }, error: null }) }) }) }),
  }),
}))

import StatusPage, { HEALTH_CACHE_TTL_MS, _resetStatusHealthCache } from './page.js'

const props = { params: Promise.resolve({ location: 'gym-a' }) }

beforeEach(() => {
  _resetStatusHealthCache()
  getIntegrationHealth.mockClear()
  vi.useRealTimers()
})

describe('/welcome/[location]/status health cache', () => {
  it('runs the aggregator once per location per 60 s, not per request', async () => {
    await StatusPage(props)
    await StatusPage(props)
    await StatusPage(props)
    expect(getIntegrationHealth).toHaveBeenCalledTimes(1)
    expect(getIntegrationHealth).toHaveBeenCalledWith(expect.anything(), 'loc-1')
  })

  it('re-runs it once the TTL has elapsed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T10:00:00Z'))
    await StatusPage(props)
    vi.setSystemTime(new Date(Date.parse('2026-10-10T10:00:00Z') + HEALTH_CACHE_TTL_MS))
    await StatusPage(props)
    expect(getIntegrationHealth).toHaveBeenCalledTimes(2)
  })

  it('caches a failed aggregation as empty rows too, so a down aggregator is not hammered', async () => {
    getIntegrationHealth.mockRejectedValueOnce(new Error('boom'))
    await StatusPage(props)
    await StatusPage(props)
    expect(getIntegrationHealth).toHaveBeenCalledTimes(1)
  })
})
