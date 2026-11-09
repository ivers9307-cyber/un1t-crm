// HOSTPORTAL.1 — /host: the short Overview.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({ notFound: vi.fn(() => { throw new Error('NOT_FOUND') }), redirect: vi.fn((url) => { throw new Error(`REDIRECT:${url}`) }) }))

const state = {
  signedOut: false,
  host: { id: 'h1', name: 'Host One', payment_provider: 'stripe_connect', charges_enabled: true },
  events: [], eventsError: null, revenue: null, revenueThrows: false,
  rollup: { bookings: 0, views: 0, signups: 0, contacts: 0 }, windowRevenue: null, windowThrows: false,
  recent: new Map(),
  fill: { ok: true, sessions: [], booked: 0, capacity: null },
  stats: { ok: true, stats: { views: 0, unique_visitors: 0, confirmed: 0, conversion_pct: null, waitlist: { waiting: 0, offered: 0, claimed: 0 } } },
}

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => (state.signedOut ? null : { host: state.host })) }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.limit = async () => ({ data: state.eventsError ? null : state.events, error: state.eventsError })
      return b
    },
  }),
}))
vi.mock('@/lib/host-revenue', () => ({
  getHostRevenue: vi.fn(async (_db, _id, opts) => {
    if (opts?.sinceIso) {
      if (state.windowThrows) throw new Error('boom')
      return state.windowRevenue
    }
    if (state.revenueThrows) throw new Error('boom')
    return state.revenue
  }),
}))
vi.mock('@/lib/host-rollup', () => ({
  loadHostRollup: vi.fn(async () => state.rollup),
  loadRecentRatingCounts: vi.fn(async () => state.recent),
}))
vi.mock('@/lib/host-org-brand', () => ({ resolveHostOrgBrand: vi.fn(async () => ({ name: 'Brand X', shortName: 'BX' })) }))
vi.mock('@/lib/host-session-fill', () => ({ loadSessionFill: vi.fn(async () => state.fill) }))
vi.mock('@/lib/event-stats', () => ({ loadEventStats: vi.fn(async () => state.stats) }))
vi.mock('@/lib/host-portal', async (orig) => ({
  ...(await orig()),
  loadHostToday: vi.fn(async () => ({ zone: 'Europe/Dublin', today: '2026-11-09' })),
}))
vi.mock('@/components/host/HostEventRow', () => ({ default: function HostEventRow() { return null } }))

const { default: Page } = await import('./page.js')
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
function hrefs(el) { const out = []; walk(el, (n) => { if (n.props?.href) out.push(n.props.href) }); return out }
const ev = (id, status, race_date, extra = {}) => ({
  id, name: `Event ${id}`, slug: `s-${id}`, race_date, status, kind: 'run', active: true,
  venue_name: 'The Hall', capacity_mode: 'people', entry_policy: null, race_waves: [], ...extra,
})

beforeEach(() => {
  state.signedOut = false
  state.host = { id: 'h1', name: 'Host One', payment_provider: 'stripe_connect', charges_enabled: true }
  state.events = []
  state.eventsError = null
  state.revenue = { currency: 'EUR', totals: {}, perEvent: [] }
  state.revenueThrows = false
  state.rollup = { bookings: 0, views: 0, signups: 0, contacts: 0 }
  state.windowRevenue = { currency: 'EUR', totals: { gross_cents: 0, net_to_host_cents: 0 }, perEvent: [] }
  state.windowThrows = false
  state.recent = new Map()
  state.fill = { ok: true, sessions: [], booked: 0, capacity: null }
  state.stats = { ok: true, stats: { views: 0, unique_visitors: 0, confirmed: 0, conversion_pct: null, waitlist: { waiting: 0, offered: 0, claimed: 0 } } }
})

describe('host overview page', () => {
  it('redirects to login when signed out', async () => {
    state.signedOut = true
    await expect(Page()).rejects.toThrow('REDIRECT:/host/login')
  })

  it('skips a published event that is off sale for the next on-sale one', async () => {
    state.events = [
      ev('off', 'published', '2026-11-20', { active: false }),
      ev('on', 'published', '2026-12-05'),
    ]
    const next = text(await Page()).split('Next up')[1].split('Coming up')[0]
    expect(next).toContain('Event on')
    expect(next).not.toContain('Event off')
  })

  it('shows the create line when the only published upcoming event is off sale', async () => {
    state.events = [ev('off', 'published', '2026-11-20', { active: false })]
    expect(text(await Page())).toContain('Nothing on sale yet — create an event.')
  })

  it('keeps the Stripe warning above the unavailable line when the events read fails', async () => {
    state.host = { ...state.host, charges_enabled: false }
    state.eventsError = { message: 'boom' }
    const t = text(await Page())
    expect(t).toContain("Your Stripe account isn't fully connected yet")
    expect(t).toContain('Your events are unavailable right now.')
    expect(t.indexOf("Your Stripe account")).toBeLessThan(t.indexOf('Your events are unavailable'))
  })

  it('shows the reviewer note for a needs-changes event with a link to it', async () => {
    state.events = [ev('r1', 'rejected', '2026-12-01', { rejected_reason: 'Add a venue' })]
    const el = await Page()
    expect(headings(el)).toContain('Needs your attention')
    const t = text(el)
    expect(t).toContain('Event r1')
    expect(t).toContain('needs changes.')
    expect(t).toContain('Brand X asked: "Add a venue"')
    expect(hrefs(el)).toContain('/host/events/r1/setup')
  })

  it('renders no Needs your attention heading when nothing needs attention', async () => {
    state.events = [ev('u1', 'published', '2026-12-05')]
    const el = await Page()
    expect(headings(el)).not.toContain('Needs your attention')
  })

  it('shows the Stripe warning under Needs your attention for an unconnected Stripe host', async () => {
    state.host = { ...state.host, charges_enabled: false }
    const el = await Page()
    expect(headings(el)).toContain('Needs your attention')
    expect(text(el)).toContain("Your Stripe account isn't fully connected yet")
  })

  it('shows the welcome line and today in the anchor zone', async () => {
    const el = await Page()
    const t = text(el)
    expect(t).toContain('Welcome, Host One.')
    expect(t).toContain('9 November 2026')
  })

  it('picks the nearest published upcoming event for Next up, skipping an earlier draft', async () => {
    state.events = [
      ev('d1', 'draft', '2026-11-12'),
      ev('u2', 'published', '2026-12-20'),
      ev('u1', 'published', '2026-12-05', { race_waves: [{ id: 'w1', start_time: '09:00:00', capacity: 10, label: null, display_order: 0 }] }),
    ]
    state.fill = { ok: true, sessions: [{ id: 'w1', label: null, time: '09:00', capacity: 10, booked: 4, full: false }], booked: 4, capacity: 10 }
    state.stats = { ok: true, stats: { views: 120, unique_visitors: 80, confirmed: 4, conversion_pct: 5, waitlist: { waiting: 2, offered: 0, claimed: 0 } } }
    state.revenue = { currency: 'EUR', totals: {}, perEvent: [{ event_id: 'u1', paidCount: 3, gross_cents: 9000, net_to_host_cents: 8000 }] }
    const el = await Page()
    expect(headings(el)).toContain('Next up')
    const t = text(el)
    expect(t).toContain('Event u1')
    expect(t).toContain('09:00')
    expect(t).toContain('The Hall')
    expect(t).toContain('4 / 10')
    expect(t).toContain('120')
    expect(t).toContain('5% booked')
    expect(t).toContain('Net so far')
    expect(t).toContain('€80.00')
    expect(t).toContain('3 sold')
    const h = hrefs(el)
    expect(h).toContain('/host/events/u1/attendees')
    expect(h).toContain('/event/s-u1')
    // the draft is a Coming up row, never Next up
    const next = text(el).split('Next up')[1].split('Coming up')[0]
    expect(next).not.toContain('Event d1')
  })

  it('names a full session and shows booked alone when capacity is null', async () => {
    state.events = [ev('u1', 'published', '2026-12-05')]
    state.fill = { ok: true, sessions: [{ id: 'w1', label: 'Early', time: '09:00', capacity: 5, booked: 5, full: true }, { id: 'w2', label: null, time: '10:00', capacity: null, booked: 2, full: false }], booked: 7, capacity: null }
    const t = text(await Page())
    expect(t).toContain('Booked')
    expect(t).toContain('Early (09:00) is full')
    expect(t).not.toContain('7 /')
  })

  it('shows the create line when there is no published upcoming event', async () => {
    state.events = [ev('d1', 'draft', '2026-12-05'), ev('p1', 'published', '2026-10-01')]
    const el = await Page()
    expect(text(el)).toContain('Nothing on sale yet — create an event.')
    expect(hrefs(el)).toContain('/host/events/new')
  })

  it('reads unavailable, not 0, when the stats or the fill read fails', async () => {
    state.events = [ev('u1', 'published', '2026-12-05')]
    state.fill = { ok: false }
    state.stats = { ok: false }
    const t = text(await Page())
    expect(t.match(/unavailable/g)?.length).toBeGreaterThanOrEqual(3)
    expect(t).not.toMatch(/Waitlist\s*0/)
    expect(t).not.toMatch(/Booked\s*0/)
  })

  it('labels the money tile gross for a non-Stripe host', async () => {
    state.host = { id: 'h1', name: 'Host One', payment_provider: 'revolut', charges_enabled: false }
    state.events = [ev('u1', 'published', '2026-12-05')]
    state.revenue = { currency: 'EUR', totals: {}, perEvent: [{ event_id: 'u1', paidCount: 2, gross_cents: 5000, net_to_host_cents: 4000 }] }
    const el = await Page()
    const t = text(el)
    expect(t).toContain('Gross so far')
    expect(t).not.toContain('Net so far')
    expect(t).toContain('€50.00')
    expect(t).not.toContain("Stripe account isn't")
  })

  it('shows a dash for the money tile when the event has no revenue row', async () => {
    state.events = [ev('u1', 'published', '2026-12-05')]
    const t = text(await Page())
    expect(t).toMatch(/Net so far—/)
    expect(t).not.toMatch(/Net so farunavailable/)
  })

  it('reads unavailable, not a dash, on the money tile when the revenue read fails', async () => {
    state.events = [ev('u1', 'published', '2026-12-05')]
    state.revenueThrows = true
    const t = text(await Page())
    expect(t).toMatch(/Net so farunavailable/)
    expect(t).not.toMatch(/Net so far—/)
  })

  it('lists the first three of needs-action and upcoming by date under Coming up, with All events', async () => {
    state.events = [
      ev('a', 'published', '2026-12-01'), ev('b', 'draft', '2026-12-02'),
      ev('c', 'published', '2026-12-03'), ev('d', 'published', '2026-12-04'),
    ]
    const el = await Page()
    expect(headings(el)).toContain('Coming up')
    expect(all(el, HostEventRow).map((r) => r.props.event.id)).toEqual(['a', 'b', 'c'])
    expect(text(el)).toContain('All events →')
    expect(hrefs(el)).toContain('/host/events')
  })

  it('omits Coming up when there are no future events', async () => {
    state.events = [ev('p1', 'published', '2026-10-01')]
    const el = await Page()
    expect(headings(el)).not.toContain('Coming up')
  })

  it('says events are unavailable, with no Next up and no Coming up, when the events read fails', async () => {
    state.eventsError = { message: 'boom' }
    const el = await Page()
    expect(text(el)).toContain('Your events are unavailable right now.')
    expect(headings(el)).not.toContain('Next up')
    expect(headings(el)).not.toContain('Coming up')
  })

  it('no longer renders payouts, statements, the series list or the signup card', async () => {
    state.events = [ev('u1', 'published', '2026-12-05')]
    const el = await Page()
    const names = []
    walk(el, (n) => { if (typeof n.type === 'function') names.push(n.type.name) })
    for (const gone of ['HostPayouts', 'HostStatements', 'HostSeriesList', 'HostSignupPageCard']) {
      expect(names).not.toContain(gone)
    }
    const t = text(el)
    expect(t).not.toContain('Grow your list')
    expect(t).not.toContain('Your events and earnings at a glance')
    expect(headings(el)).not.toContain('Revenue')
  })

  describe('Last 30 days', () => {
    const block = (t) => t.split('Last 30 days')[1].split('Coming up')[0]

    it('sits between Next up and Coming up and shows the four figures', async () => {
      state.events = [ev('u1', 'published', '2026-12-05'), ev('u2', 'published', '2026-12-06')]
      state.rollup = { bookings: 12, views: 340, signups: 5, contacts: 48 }
      state.windowRevenue = { currency: 'EUR', totals: { gross_cents: 20000, net_to_host_cents: 18000 }, perEvent: [] }
      const el = await Page()
      const hs = headings(el)
      expect(hs.indexOf('Last 30 days')).toBeGreaterThan(hs.indexOf('Next up'))
      expect(hs.indexOf('Last 30 days')).toBeLessThan(hs.indexOf('Coming up'))
      const b = block(text(el))
      expect(b).toContain('Bookings12')
      expect(b).toContain('Net earned€180.00')
      expect(b).toContain('Event page views340across all events')
      expect(b).toContain('List signups548 contacts')
    })

    it('shows unavailable for a null roll-up figure and never 0', async () => {
      state.events = [ev('u1', 'published', '2026-12-05')]
      state.rollup = { bookings: null, views: null, signups: null, contacts: null }
      const b = block(text(await Page()))
      expect(b).toContain('Bookingsunavailable')
      expect(b).toContain('Event page viewsunavailable')
      expect(b).toContain('List signupsunavailable')
      expect(b).not.toMatch(/Bookings0|views0|signups0/)
      expect(b).not.toContain('contacts')
    })

    it('shows unavailable on the money tile when the windowed revenue read throws', async () => {
      state.events = [ev('u1', 'published', '2026-12-05')]
      state.windowThrows = true
      expect(block(text(await Page()))).toContain('Net earnedunavailable')
    })

    it('shows Gross collected, not Net earned, for a non-Stripe host', async () => {
      state.host = { id: 'h1', name: 'Host One', payment_provider: 'revolut', charges_enabled: false }
      state.events = [ev('u1', 'published', '2026-12-05')]
      state.windowRevenue = { currency: 'EUR', totals: { gross_cents: 5000, net_to_host_cents: 4000 }, perEvent: [] }
      const b = block(text(await Page()))
      expect(b).toContain('Gross collected€50.00')
      expect(b).not.toContain('Net earned')
    })

    it('renders for a host with no events, with the money tile at the formatted zero', async () => {
      const b = block(text(await Page()))
      expect(b).toContain('Bookings0')
      expect(b).toContain('Net earned€0.00')
    })

    it('asks for the window from 30 days before today at local midnight', async () => {
      const { getHostRevenue } = await import('@/lib/host-revenue')
      const { loadHostRollup } = await import('@/lib/host-rollup')
      state.events = [ev('u1', 'published', '2026-12-05')]
      await Page()
      expect(loadHostRollup).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ hostId: 'h1', eventIds: ['u1'], sinceDay: '2026-10-10', sinceIso: '2026-10-09T23:00:00.000Z' }))
      expect(getHostRevenue).toHaveBeenCalledWith(expect.anything(), 'h1', { sinceIso: '2026-10-09T23:00:00.000Z' })
    })

    it('is absent when the events read fails', async () => {
      state.eventsError = { message: 'boom' }
      expect(headings(await Page())).not.toContain('Last 30 days')
    })
  })

  describe('new ratings', () => {
    it('shows a singular and a plural line linking to Insights, at most three, newest event first', async () => {
      state.events = [
        ev('a', 'published', '2026-10-01'), ev('b', 'published', '2026-10-05'),
        ev('c', 'published', '2026-10-09'), ev('d', 'published', '2026-10-03'),
      ]
      state.recent = new Map([['a', 4], ['b', 1], ['c', 3], ['d', 2]])
      const el = await Page()
      const t = text(el)
      expect(headings(el)).toContain('Needs your attention')
      expect(t).toContain('3 new ratings on Event c this week. Read them →')
      expect(t).toContain('1 new rating on Event b this week. Read them →')
      expect(t).toContain('2 new ratings on Event d this week. Read them →')
      expect(t).not.toContain('on Event a this week')
      expect(t.indexOf('on Event c')).toBeLessThan(t.indexOf('on Event b'))
      expect(t.indexOf('on Event b')).toBeLessThan(t.indexOf('on Event d'))
      const h = hrefs(el)
      expect(h).toContain('/host/events/c/insights')
      expect(h).toContain('/host/events/b/insights')
      expect(h.filter((x) => x.endsWith('/insights'))).toHaveLength(3)
    })

    it('asks for the counts from seven days before today at local midnight', async () => {
      const { loadRecentRatingCounts } = await import('@/lib/host-rollup')
      state.events = [ev('u1', 'published', '2026-12-05')]
      await Page()
      expect(loadRecentRatingCounts).toHaveBeenLastCalledWith(expect.anything(), { eventIds: ['u1'], sinceIso: '2026-11-02T00:00:00.000Z' })
    })

    it('shows the attention heading for a rating line alone', async () => {
      state.events = [ev('u1', 'published', '2026-12-05')]
      state.recent = new Map([['u1', 2]])
      const el = await Page()
      expect(headings(el)).toContain('Needs your attention')
      expect(text(el)).toContain('2 new ratings on Event u1')
    })

    it('shows no rating line, and no heading, when the read failed', async () => {
      const { logWarn } = await import('@/lib/log')
      state.events = [ev('u1', 'published', '2026-12-05')]
      state.recent = null
      const el = await Page()
      expect(headings(el)).not.toContain('Needs your attention')
      expect(text(el)).not.toContain('new rating')
      expect(logWarn).toHaveBeenCalledWith('host-overview', 'recent ratings unavailable')
    })

    it('shows no rating line when the events read failed', async () => {
      state.eventsError = { message: 'boom' }
      state.recent = new Map([['u1', 2]])
      expect(text(await Page())).not.toContain('new rating')
    })
  })
})
