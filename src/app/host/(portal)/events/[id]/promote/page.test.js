// HOSTPORTAL.2 — Promote tab: the share link, promo codes and series actions
// for the host's own event; another host's event id answers 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NOT_FOUND') }),
  redirect: vi.fn(() => { throw new Error('REDIRECT') }),
}))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => ({ host: { id: 'h1' } })) }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://studio.test/some/path') }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

const state = { event: null, hostRow: null }
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => (table === 'race_events'
        ? { data: state.event, error: null }
        : { data: state.hostRow, error: null })
      return b
    },
  }),
}))
vi.mock('@/components/host/CopyLinkButton', () => ({ default: function CopyLinkButton() { return null } }))
vi.mock('@/components/host/EventShareLinks', () => ({ default: function EventShareLinks() { return null } }))
vi.mock('@/components/host/HostPromoCodes', () => ({ default: function HostPromoCodes() { return null } }))
vi.mock('@/components/host/HostSeriesActions', () => ({ default: function HostSeriesActions() { return null } }))

const { default: Page } = await import('./page.js')
const { getCurrentHost } = await import('@/lib/host-auth')
const { resolveCustomerBaseUrl } = await import('@/lib/tenant-host')
const { default: CopyLinkButton } = await import('@/components/host/CopyLinkButton')
const { default: EventShareLinks } = await import('@/components/host/EventShareLinks')
const { default: HostPromoCodes } = await import('@/components/host/HostPromoCodes')
const { default: HostSeriesActions } = await import('@/components/host/HostSeriesActions')

function find(el, type) {
  if (!el || typeof el !== 'object') return null
  if (Array.isArray(el)) { for (const c of el) { const f = find(c, type); if (f) return f } return null }
  if (el.type === type) return el
  return find(el.props?.children, type)
}
function text(el) {
  if (el == null || typeof el === 'boolean') return ''
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map(text).join(' ')
  return text(el.props?.children)
}

const EVENT = {
  id: 'e1', host_id: 'h1', name: 'Summer Run', slug: 'summer-run', race_date: '2026-12-01', status: 'published', active: true,
  series_id: 's1', series: { id: 's1', name: 'The Series', slug: 'the-series' },
}
const params = { params: Promise.resolve({ id: 'e1' }) }

beforeEach(() => {
  state.event = { ...EVENT }
  state.hostRow = { anchor_location_id: 'loc1' }
  getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
  resolveCustomerBaseUrl.mockResolvedValue('https://studio.test/some/path')
})

describe('host event Promote tab', () => {
  it('redirects to login without a host session', async () => {
    getCurrentHost.mockResolvedValueOnce(null)
    await expect(Page(params)).rejects.toThrow('REDIRECT')
  })

  it("404s for another host's event", async () => {
    state.event = { ...EVENT, host_id: 'someone-else' }
    await expect(Page(params)).rejects.toThrow('NOT_FOUND')
  })

  it('404s for a missing event', async () => {
    state.event = null
    await expect(Page(params)).rejects.toThrow('NOT_FOUND')
  })

  it('renders Share, promo codes and series with the right props', async () => {
    const el = await Page(params)
    const t = text(el)
    expect(t).toContain('Share')
    expect(t).toContain('https://studio.test/event/summer-run')
    expect(find(el, CopyLinkButton).props).toEqual({ url: 'https://studio.test/event/summer-run' })
    expect(resolveCustomerBaseUrl).toHaveBeenCalledWith(expect.anything(), 'loc1')
    expect(find(el, HostPromoCodes).props).toEqual({ eventId: 'e1' })
    expect(find(el, HostSeriesActions).props).toEqual({
      eventId: 'e1', eventName: 'Summer Run', raceDate: '2026-12-01',
      seriesId: 's1', seriesName: 'The Series', seriesSlug: 'the-series',
    })
    expect(t).toContain('Series')
  })

  it('renders the tagged share links with plain props only, on sale for a published active event', async () => {
    const el = await Page(params)
    expect(find(el, EventShareLinks).props).toEqual({ url: 'https://studio.test/event/summer-run', eventId: 'e1', onSale: true })
  })

  it('marks the event not on sale when it is a draft or inactive', async () => {
    state.event = { ...EVENT, status: 'draft' }
    expect(find(await Page(params), EventShareLinks).props.onSale).toBe(false)
    state.event = { ...EVENT, active: false }
    expect(find(await Page(params), EventShareLinks).props.onSale).toBe(false)
  })

  it('passes null/empty series props for a standalone event', async () => {
    state.event = { ...EVENT, series_id: null, series: null }
    const el = await Page(params)
    expect(find(el, HostSeriesActions).props).toMatchObject({ seriesId: null, seriesName: '', seriesSlug: '' })
  })

  it('shows the unavailable line but still renders codes and series when the link cannot be built', async () => {
    resolveCustomerBaseUrl.mockRejectedValueOnce(new Error('boom'))
    const el = await Page(params)
    expect(text(el)).toContain('The link is unavailable right now.')
    expect(find(el, CopyLinkButton)).toBeNull()
    expect(find(el, EventShareLinks)).toBeNull()
    expect(find(el, HostPromoCodes)).toBeTruthy()
    expect(find(el, HostSeriesActions)).toBeTruthy()
  })

  it('shows the unavailable line when the event has no slug, never a link ending in "undefined"', async () => {
    state.event = { ...EVENT, slug: null }
    const el = await Page(params)
    expect(text(el)).toContain('The link is unavailable right now.')
    expect(text(el)).not.toContain('undefined')
    expect(text(el)).not.toContain('/event/null')
    expect(find(el, CopyLinkButton)).toBeNull()
  })
})
