// HOSTPORTAL.1 — /host/events: needs action, upcoming, series, past.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({ notFound: vi.fn(() => { throw new Error('NOT_FOUND') }), redirect: vi.fn() }))

const state = { host: { id: 'h1', payment_provider: 'stripe_connect' }, events: [], revenue: null, revenueThrows: false, ratings: new Map(), series: [] }

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => ({ host: state.host })) }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.limit = async () => ({ data: state.events, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/host-revenue', () => ({
  getHostRevenue: vi.fn(async () => {
    if (state.revenueThrows) throw new Error('boom')
    return state.revenue
  }),
}))
vi.mock('@/lib/event-series', () => ({ listHostSeries: vi.fn(async () => state.series) }))
vi.mock('@/lib/host-portal', async (orig) => ({
  ...(await orig()),
  loadHostToday: vi.fn(async () => ({ zone: 'Europe/Dublin', today: '2026-11-09' })),
  loadPublicRatingAverages: vi.fn(async () => state.ratings),
}))
vi.mock('@/components/host/HostSubmitButton', () => ({ default: function HostSubmitButton() { return null } }))
vi.mock('@/components/host/HostSeriesList', () => ({ default: function HostSeriesList() { return null } }))
vi.mock('@/components/host/HostPastEvents', () => ({ default: function HostPastEvents() { return null } }))
vi.mock('@/components/host/HostEventRow', () => ({ default: function HostEventRow() { return null } }))

const { default: Page } = await import('./page.js')
const { default: HostSubmitButton } = await import('@/components/host/HostSubmitButton')
const { default: HostSeriesList } = await import('@/components/host/HostSeriesList')
const { default: HostPastEvents } = await import('@/components/host/HostPastEvents')
const { default: HostEventRow } = await import('@/components/host/HostEventRow')

function walk(el, visit) {
  if (!el || typeof el !== 'object') return
  if (Array.isArray(el)) { el.forEach((c) => walk(c, visit)); return }
  visit(el)
  walk(el.props?.children, visit)
}
function all(el, type) { const out = []; walk(el, (n) => { if (n.type === type) out.push(n) }); return out }
function text(el) {
  let s = ''
  const go = (n) => {
    if (n == null || typeof n === 'boolean') return
    if (typeof n === 'string' || typeof n === 'number') { s += n; return }
    if (Array.isArray(n)) { n.forEach(go); return }
    go(n.props?.children)
  }
  go(el)
  return s
}
function headings(el) { const out = []; walk(el, (n) => { if (n.type === 'h2') out.push(text(n)) }); return out }
const ev = (id, status, race_date, extra = {}) => ({ id, name: `Event ${id}`, slug: `s-${id}`, race_date, status, kind: 'run', active: true, ...extra })
const revRow = (id, paidCount, gross, net) => ({ event_id: id, paidCount, gross_cents: gross, net_to_host_cents: net })

beforeEach(() => {
  state.host = { id: 'h1', payment_provider: 'stripe_connect' }
  state.events = []
  state.revenue = { currency: 'EUR', totals: {}, perEvent: [] }
  state.revenueThrows = false
  state.ratings = new Map()
  state.series = []
})

describe('host events page', () => {
  it('renders the four groups in order, each only when it has rows', async () => {
    state.events = [
      ev('d1', 'draft', '2026-12-01'),
      ev('u1', 'published', '2026-12-05'),
      ev('p1', 'published', '2026-10-01'),
    ]
    state.series = [{ id: 's1', name: 'Series A', slug: 'a', upcoming_count: 2 }]
    const el = await Page()
    expect(headings(el)).toEqual(['Needs action', 'Upcoming', 'Past'])
    expect(text(el)).toContain('3 events · 1 series')
    const rows = all(el, HostEventRow).map((r) => r.props.event.id)
    expect(rows).toEqual(['d1', 'u1'])
    const series = all(el, HostSeriesList)
    expect(series).toHaveLength(1)
    expect(series[0].props.series).toEqual(state.series)
    const past = all(el, HostPastEvents)
    expect(past).toHaveLength(1)
    expect(past[0].props.rows.map((r) => r.id)).toEqual(['p1'])
    // order in the tree: needs action, upcoming, series, past
    const order = []
    walk(el, (n) => {
      if (n.type === 'h2') order.push(text(n))
      if (n.type === HostSeriesList) order.push('Series')
    })
    expect(order).toEqual(['Needs action', 'Upcoming', 'Series', 'Past'])
  })

  it('gives a draft row the submit button and a needs-changes row none', async () => {
    state.events = [ev('d1', 'draft', '2026-12-01'), ev('r1', 'rejected', '2026-12-02')]
    const el = await Page()
    const rows = all(el, HostEventRow)
    const byId = Object.fromEntries(rows.map((r) => [r.props.event.id, r.props]))
    expect(byId.d1.action.type).toBe(HostSubmitButton)
    expect(byId.d1.action.props.eventId).toBe('d1')
    expect(byId.r1.action).toBeFalsy()
  })

  it('renders the first-event line and no groups for a host with no events', async () => {
    const el = await Page()
    expect(text(el)).toContain('No events yet')
    expect(text(el)).toContain('create your first one')
    expect(headings(el)).toEqual([])
    expect(all(el, HostEventRow)).toHaveLength(0)
    expect(all(el, HostPastEvents)).toHaveLength(0)
  })

  it('says gross, never net, for a non-Stripe host', async () => {
    state.host = { id: 'h1', payment_provider: 'revolut' }
    state.events = [ev('u1', 'published', '2026-12-05')]
    state.revenue = { currency: 'EUR', totals: {}, perEvent: [revRow('u1', 3, 9000, 8000)] }
    const el = await Page()
    const detail = all(el, HostEventRow)[0].props.detail
    expect(detail).toContain('3 sold')
    expect(detail).toContain('€90.00 gross')
    expect(detail).not.toContain('net')
  })

  it('says net for a Stripe host', async () => {
    state.events = [ev('u1', 'published', '2026-12-05')]
    state.revenue = { currency: 'EUR', totals: {}, perEvent: [revRow('u1', 3, 9000, 8000)] }
    const el = await Page()
    expect(all(el, HostEventRow)[0].props.detail).toContain('€80.00 net')
  })

  it('omits the sold figure for an event with no payments', async () => {
    state.events = [ev('u1', 'published', '2026-12-05'), ev('u2', 'published', '2026-12-06')]
    state.revenue = { currency: 'EUR', totals: {}, perEvent: [revRow('u2', 1, 3000, 2800)] }
    const el = await Page()
    const rows = all(el, HostEventRow)
    expect(rows[0].props.detail).not.toContain('sold')
    expect(rows[0].props.detail).toContain('2026-12-05')
    expect(rows[1].props.detail).toContain('1 sold')
  })

  it('adds the rating to past rows only', async () => {
    state.events = [ev('p1', 'published', '2026-10-01'), ev('u1', 'published', '2026-12-05')]
    state.ratings = new Map([['p1', { average: 4.8, count: 19 }], ['u1', { average: 5, count: 1 }]])
    const el = await Page()
    expect(all(el, HostPastEvents)[0].props.rows[0].detail).toContain('★ 4.8 (19)')
    expect(all(el, HostEventRow)[0].props.detail).not.toContain('★')
  })

  it('still renders the lists when revenue and ratings reads fail', async () => {
    state.revenueThrows = true
    const portal = await import('@/lib/host-portal')
    portal.loadPublicRatingAverages.mockResolvedValueOnce(null)
    state.events = [ev('u1', 'published', '2026-12-05'), ev('p1', 'published', '2026-10-01')]
    const el = await Page()
    const row = all(el, HostEventRow)[0].props
    expect(row.detail).toContain('2026-12-05')
    expect(row.detail).not.toContain('sold')
    const past = all(el, HostPastEvents)[0].props.rows[0]
    expect(past.detail).not.toContain('sold')
    expect(past.detail).not.toContain('★')
  })

  it('passes plain data only to the client component', async () => {
    state.events = [ev('p1', 'published', '2026-10-01')]
    const el = await Page()
    const row = all(el, HostPastEvents)[0].props.rows[0]
    expect(row).toEqual({ id: 'p1', name: 'Event p1', status: 'published', statusLabel: 'Published', href: '/host/events/p1', detail: expect.any(String) })
    expect(Object.values(row).every((v) => typeof v !== 'function')).toBe(true)
  })
})
