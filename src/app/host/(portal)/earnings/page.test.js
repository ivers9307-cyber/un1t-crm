// HOSTPORTAL.1 — /host/earnings: balance, all time, by event, payouts, statements.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redirect = vi.fn((url) => { throw new Error(`REDIRECT:${url}`) })
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect }))

const state = { session: null, revenue: null, revenueThrows: false }

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => state.session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({}) }))
vi.mock('@/lib/host-revenue', () => ({
  getHostRevenue: vi.fn(async () => {
    if (state.revenueThrows) throw new Error('boom')
    return state.revenue
  }),
}))
vi.mock('@/components/host/HostPayouts', () => ({
  HostPayoutsProvider: function HostPayoutsProvider({ children }) { return children },
  HostBalance: function HostBalance() { return null },
  HostPayoutList: function HostPayoutList() { return null },
}))
vi.mock('@/components/host/HostStatements', () => ({ default: function HostStatements() { return null } }))

const { default: Page } = await import('./page.js')
const { HostPayoutsProvider, HostBalance, HostPayoutList } = await import('@/components/host/HostPayouts')
const { default: HostStatements } = await import('@/components/host/HostStatements')

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
function tileLabels(el) {
  const out = []
  walk(el, (n) => {
    if (n.type === 'p' && String(n.props?.className || '').includes('uppercase tracking-wide')) out.push(text(n))
  })
  return out
}
function hrefs(el) { const out = []; walk(el, (n) => { if (n.props?.href) out.push(n.props.href) }); return out }

const totals = { paidCount: 5, gross_cents: 50000, fee_cents: 2500, net_to_host_cents: 47500, refunded_cents: 1000, net_collected_cents: 49000 }
const perEvent = [
  { event_id: 'e1', name: 'Autumn Run', race_date: '2026-10-01', paidCount: 3, gross_cents: 30000, net_to_host_cents: 28500 },
  { event_id: 'e2', name: 'Winter Run', race_date: '2026-09-01', paidCount: 2, gross_cents: 20000, net_to_host_cents: 19000 },
]

beforeEach(() => {
  redirect.mockClear()
  state.session = { host: { id: 'h1', payment_provider: 'stripe_connect', stripe_connected_account_id: 'acct_1' } }
  state.revenue = { currency: 'EUR', totals, perEvent }
  state.revenueThrows = false
})

describe('host earnings page', () => {
  it('redirects to login without a session', async () => {
    state.session = null
    await expect(Page()).rejects.toThrow('REDIRECT:/host/login')
  })

  it('wraps everything in one payouts provider, in order', async () => {
    const el = await Page()
    expect(el.type).toBe(HostPayoutsProvider)
    const order = []
    walk(el, (n) => {
      if (n.type === 'h1') order.push('h1')
      if (n.type === HostBalance) order.push('balance')
      if (n.type === HostPayoutList) order.push('payouts')
      if (n.type === HostStatements) order.push('statements')
      if (n.type === 'h2') order.push(text(n))
    })
    expect(order).toEqual(['h1', 'balance', 'All time', 'By event', 'payouts', 'statements'])
    expect(text(all(el, 'h1')[0])).toBe('Earnings')
  })

  it('shows four tiles for a Stripe host and two for any other', async () => {
    let el = await Page()
    expect(tileLabels(el)).toHaveLength(4)
    expect(text(el)).toContain('Net to you')
    state.session = { host: { id: 'h1', payment_provider: 'revolut' } }
    el = await Page()
    expect(tileLabels(el)).toEqual(['Gross collected', 'Refunded'])
  })

  it('never renders Net to you or booking fees for a non-Stripe host', async () => {
    state.session = { host: { id: 'h1', payment_provider: 'revolut' } }
    const el = await Page()
    const t = text(el)
    expect(t).not.toContain('Net to you')
    expect(t).not.toContain('booking fees')
    expect(t).not.toContain('net')
  })

  it('shows the collected line and the Stripe link only for a connected Stripe host', async () => {
    let el = await Page()
    expect(text(el)).toContain('5 paid bookings · €490.00 collected after refunds')
    expect(hrefs(el)).toContain('https://dashboard.stripe.com')
    state.session = { host: { id: 'h1', payment_provider: 'stripe_connect', stripe_connected_account_id: null } }
    el = await Page()
    expect(hrefs(el)).not.toContain('https://dashboard.stripe.com')
  })

  it('lists by-event rows with net for a Stripe host, linking to the event', async () => {
    const el = await Page()
    const t = text(el)
    expect(t).toContain('Autumn Run')
    expect(t).toContain('3 sold')
    expect(t).toContain('€285.00')
    expect(hrefs(el)).toEqual(expect.arrayContaining(['/host/events/e1', '/host/events/e2']))
  })

  it('lists by-event rows with gross for a non-Stripe host', async () => {
    state.session = { host: { id: 'h1', payment_provider: 'revolut' } }
    const el = await Page()
    const t = text(el)
    expect(t).toContain('€300.00')
    expect(t).not.toContain('€285.00')
  })

  it('shows the unavailable line when revenue throws', async () => {
    state.revenueThrows = true
    const el = await Page()
    expect(text(el)).toContain('Revenue is unavailable right now.')
    expect(tileLabels(el)).toHaveLength(0)
    expect(all(el, HostStatements)).toHaveLength(1)
  })

  it('shows no tiles or by-event rows when nothing has sold', async () => {
    state.revenue = { currency: 'EUR', totals: { ...totals, paidCount: 0 }, perEvent: [] }
    const el = await Page()
    expect(text(el)).toContain('No ticket sales yet.')
    expect(tileLabels(el)).toHaveLength(0)
    expect(text(el)).not.toContain('By event')
  })

  it('passes no function props to the client components', async () => {
    const el = await Page()
    for (const type of [HostPayoutsProvider, HostBalance, HostPayoutList, HostStatements]) {
      for (const n of all(el, type)) {
        expect(Object.entries(n.props).filter(([k, v]) => k !== 'children' && typeof v === 'function')).toEqual([])
      }
    }
  })
})
