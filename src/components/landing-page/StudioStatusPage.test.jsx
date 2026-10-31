// W1.L4 review — the public status page renders per request (the root layout
// reads the Host header), so a 60 s per-location module cache bounds the
// health aggregator. PAGES.1 moved the page to /<slug>/status on the [slug]
// route; the cache moved with it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const getIntegrationHealth = vi.fn(async () => [])
vi.mock('@/lib/integration-health', () => ({ getIntegrationHealth: (...a) => getIntegrationHealth(...a) }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: async () => ({ companyName: 'Gym A Brand' }) }))
vi.mock('@/components/VisitOriginCapture', () => ({ default: () => null }))

import StudioStatusPage, { HEALTH_CACHE_TTL_MS, _resetStatusHealthCache } from './StudioStatusPage.jsx'

const LOC = { id: 'loc-1', name: 'Gym A', settings: { secret_token: 'SEKRET' }, timezone: 'Europe/Dublin' }
const props = { db: {}, location: LOC }

beforeEach(() => {
  _resetStatusHealthCache()
  getIntegrationHealth.mockClear()
  vi.useRealTimers()
})

describe('StudioStatusPage health cache', () => {
  it('runs the aggregator once per location per 60 s, not per request', async () => {
    await StudioStatusPage(props)
    await StudioStatusPage(props)
    await StudioStatusPage(props)
    expect(getIntegrationHealth).toHaveBeenCalledTimes(1)
    expect(getIntegrationHealth).toHaveBeenCalledWith(expect.anything(), 'loc-1')
  })

  it('re-runs it once the TTL has elapsed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T10:00:00Z'))
    await StudioStatusPage(props)
    vi.setSystemTime(new Date(Date.parse('2026-10-10T10:00:00Z') + HEALTH_CACHE_TTL_MS))
    await StudioStatusPage(props)
    expect(getIntegrationHealth).toHaveBeenCalledTimes(2)
  })

  it('caches a failed aggregation as empty rows too, so a down aggregator is not hammered', async () => {
    getIntegrationHealth.mockRejectedValueOnce(new Error('boom'))
    await StudioStatusPage(props)
    await StudioStatusPage(props)
    expect(getIntegrationHealth).toHaveBeenCalledTimes(1)
  })

  it('renders the member view with the studio name and nothing from its settings', async () => {
    const html = renderToStaticMarkup(await StudioStatusPage(props))
    expect(html).toContain('Gym A')
    expect(html).toContain('System status')
    expect(html).not.toContain('SEKRET')
  })
})
