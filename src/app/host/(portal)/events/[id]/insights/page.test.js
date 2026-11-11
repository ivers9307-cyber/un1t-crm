// HOSTPORTAL.2 — Insights tab: signups card and ratings for the host's own
// event; another host's event id answers 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NOT_FOUND') }),
  redirect: vi.fn(() => { throw new Error('REDIRECT') }),
}))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => ({ host: { id: 'h1' } })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
const state = { event: null }
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: state.event, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/event-stats', () => ({ loadEventStats: vi.fn() }))
vi.mock('@/components/EventSignupsCard', () => ({ default: function EventSignupsCard() { return null } }))
vi.mock('@/components/host/HostEventRatings', () => ({ default: function HostEventRatings() { return null } }))

const { default: Page } = await import('./page.js')
const { getCurrentHost } = await import('@/lib/host-auth')
const { loadEventStats } = await import('@/lib/event-stats')
const { default: EventSignupsCard } = await import('@/components/EventSignupsCard')
const { default: HostEventRatings } = await import('@/components/host/HostEventRatings')

function find(el, type) {
  if (!el || typeof el !== 'object') return null
  if (Array.isArray(el)) { for (const c of el) { const f = find(c, type); if (f) return f } return null }
  if (el.type === type) return el
  return find(el.props?.children, type)
}
const params = { params: Promise.resolve({ id: 'e1' }) }
const STATS = { views: 10 }

beforeEach(() => {
  state.event = { id: 'e1', host_id: 'h1' }
  getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
  loadEventStats.mockReset()
  loadEventStats.mockResolvedValue({ ok: true, stats: STATS })
})

describe('host event Insights tab', () => {
  it('redirects to login without a host session', async () => {
    getCurrentHost.mockResolvedValueOnce(null)
    await expect(Page(params)).rejects.toThrow('REDIRECT')
  })

  it("404s for another host's event, without reading stats", async () => {
    state.event = { id: 'e1', host_id: 'someone-else' }
    await expect(Page(params)).rejects.toThrow('NOT_FOUND')
    expect(loadEventStats).not.toHaveBeenCalled()
  })

  it('passes the stats to the dark signups card and the event id to ratings', async () => {
    const el = await Page(params)
    expect(find(el, EventSignupsCard).props).toEqual({ stats: STATS, dark: true })
    expect(find(el, HostEventRatings).props).toEqual({ eventId: 'e1' })
  })

  it('passes stats={null} when the stats read is not ok', async () => {
    loadEventStats.mockResolvedValue({ ok: false, error: new Error('x') })
    const el = await Page(params)
    expect(find(el, EventSignupsCard).props.stats).toBeNull()
  })

  it('passes stats={null} when the stats loader throws', async () => {
    loadEventStats.mockRejectedValue(new Error('boom'))
    const el = await Page(params)
    expect(find(el, EventSignupsCard).props.stats).toBeNull()
  })
})
