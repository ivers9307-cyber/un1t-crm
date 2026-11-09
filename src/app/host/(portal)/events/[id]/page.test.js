// HOSTPORTAL.2 — the Overview tab: gates, tiles, session bars and the price
// line, each read failing on its own.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NOT_FOUND') }),
  redirect: vi.fn(() => { throw new Error('REDIRECT') }),
}))
const session = { host: { id: 'h1', payment_provider: 'stripe_connect' } }
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({}) }))
vi.mock('@/lib/host-portal', async (orig) => ({
  ...(await orig()),
  loadHostEvent: vi.fn(),
  loadHostToday: vi.fn(async () => ({ zone: 'Europe/Dublin', today: '2026-11-09' })),
}))
vi.mock('@/lib/attendee-export', () => ({ fetchEventAttendees: vi.fn() }))
vi.mock('@/lib/event-stats', () => ({ loadEventStats: vi.fn() }))
vi.mock('@/lib/host-session-fill', () => ({ loadSessionFill: vi.fn() }))
vi.mock('@/lib/host-revenue', () => ({ getHostRevenue: vi.fn() }))
vi.mock('@/lib/pricing-tiers', async (orig) => ({ ...(await orig()), loadSoldByTier: vi.fn() }))
vi.mock('@/components/host/SessionFillBars', () => ({ default: function SessionFillBars() { return null } }))

const { default: Page } = await import('./page.js')
const { getCurrentHost } = await import('@/lib/host-auth')
const { loadHostEvent } = await import('@/lib/host-portal')
const { fetchEventAttendees } = await import('@/lib/attendee-export')
const { loadEventStats } = await import('@/lib/event-stats')
const { loadSessionFill } = await import('@/lib/host-session-fill')
const { getHostRevenue } = await import('@/lib/host-revenue')
const { loadSoldByTier } = await import('@/lib/pricing-tiers')
const { default: SessionFillBars } = await import('@/components/host/SessionFillBars')

const EVENT = {
  id: 'e1', host_id: 'h1', capacity_mode: 'people', entry_policy: null, race_waves: [],
  non_member_fee_cents: 3500, pricing_tiers: [{ id: 'early', name: 'Early bird', price_cents: 2500, capacity: 20 }],
  allowed_team_sizes: null,
}
const SESSIONS = [{ id: 'w1', label: 'Morning', time: '10:00', capacity: 30, booked: 8, full: false }]
const STATS = { views: 120, unique_visitors: 80, confirmed: 12, conversion_pct: 15, waitlist: { waiting: 4, offered: 2, claimed: 1 } }
const REV = { currency: 'EUR', perEvent: [{ event_id: 'e1', paidCount: 10, gross_cents: 50000, net_to_host_cents: 45000 }] }

function text(n) {
  if (n == null || typeof n === 'boolean') return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(text).join(' ')
  return text(n.props?.children)
}
function find(el, type) {
  if (!el || typeof el !== 'object') return null
  if (Array.isArray(el)) { for (const c of el) { const f = find(c, type); if (f) return f } return null }
  if (el.type === type) return el
  return find(el.props?.children, type)
}
function hrefs(n, out = []) {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach((c) => hrefs(c, out)); return out }
  if (n.props?.href) out.push(n.props.href)
  hrefs(n.props?.children, out)
  return out
}
const render = async () => text(await Page({ params: Promise.resolve({ id: 'e1' }) }))
const params = { params: Promise.resolve({ id: 'e1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  session.host.payment_provider = 'stripe_connect'
  getCurrentHost.mockResolvedValue(session)
  loadHostEvent.mockResolvedValue(EVENT)
  fetchEventAttendees.mockResolvedValue([
    { id: 'r1', status: 'confirmed', teams: { team_members: [{}, {}] } },
    { id: 'r2', status: 'pending_payment', teams: null },
  ])
  loadEventStats.mockResolvedValue({ ok: true, stats: STATS })
  loadSessionFill.mockResolvedValue({ ok: true, sessions: SESSIONS, booked: 8, capacity: 30 })
  getHostRevenue.mockResolvedValue(REV)
  loadSoldByTier.mockResolvedValue({ ok: true, soldByTier: { early: 14 } })
})

describe('host event Overview page', () => {
  it('redirects to the host login when signed out', async () => {
    getCurrentHost.mockResolvedValueOnce(null)
    await expect(Page(params)).rejects.toThrow('REDIRECT')
  })

  it("404s for another host's event", async () => {
    loadHostEvent.mockResolvedValueOnce(null)
    await expect(Page(params)).rejects.toThrow('NOT_FOUND')
    expect(loadHostEvent).toHaveBeenCalledWith(expect.anything(), 'h1', 'e1', expect.any(String))
  })

  it('shows the tiles, session bars and the price line', async () => {
    const el = await Page(params)
    const t = text(el)
    expect(t).toContain('1 confirmed · 3 attendees')
    expect(t).toContain('Waitlist')
    expect(t).toContain('2 offered')
    expect(t).toContain('15% of visitors booked')
    expect(t).toContain('Net to you')
    expect(t).toContain('€450.00')
    expect(t).toContain('€500.00 gross')
    expect(find(el, SessionFillBars).props.sessions).toEqual(SESSIONS)
    expect(t).toContain('Early bird €25 · 6 of 20 left · then standard €35')
    expect(hrefs(el)).toContain('/host/events/e1/setup')
  })

  it('reads unavailable for sessions and price when those reads fail, and still renders the tiles', async () => {
    loadSessionFill.mockResolvedValue({ ok: false })
    loadSoldByTier.mockRejectedValue(new Error('boom'))
    const el = await Page(params)
    const t = text(el)
    expect(t).toContain('Session numbers unavailable right now.')
    expect(t).toContain('Price unavailable right now.')
    expect(find(el, SessionFillBars)).toBeNull()
    expect(t).toContain('1 confirmed · 3 attendees')
    expect(t).toContain('15% of visitors booked')
  })

  it('reads a failed price read ({ ok: false }) as unavailable too', async () => {
    loadSoldByTier.mockResolvedValue({ ok: false, error: 'load_failed' })
    expect(await render()).toContain('Price unavailable right now.')
  })

  it('reads each other failing read as unavailable without breaking the page', async () => {
    fetchEventAttendees.mockRejectedValue(new Error('boom'))
    loadEventStats.mockResolvedValue({ ok: false })
    getHostRevenue.mockRejectedValue(new Error('boom'))
    const t = await render()
    expect(t).toContain('Bookings')
    expect(t.match(/unavailable/g).length).toBeGreaterThanOrEqual(4)
    expect(t).toContain('Early bird €25')
  })

  it('shows a dash for money when the read worked but the event has no payments', async () => {
    getHostRevenue.mockResolvedValue({ currency: 'EUR', perEvent: [] })
    const t = await render()
    expect(t).toContain('—')
    expect(t).not.toContain('€450.00')
  })

  it('shows Gross and no net for a non-Stripe host', async () => {
    session.host.payment_provider = null
    const t = await render()
    expect(t).toContain('Gross')
    expect(t).toContain('€500.00')
    expect(t).not.toContain('Net to you')
    expect(t).not.toContain('€450.00')
    expect(t).not.toContain('gross')
  })

  it('does not read sold-by-tier when the event has no tiers', async () => {
    loadHostEvent.mockResolvedValue({ ...EVENT, pricing_tiers: [] })
    expect(await render()).toContain('€35 per person')
    expect(loadSoldByTier).not.toHaveBeenCalled()
  })
})
