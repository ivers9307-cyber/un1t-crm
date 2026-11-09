// EVENT-WAITLIST.1 — the host event page carries the waitlist panel for its
// own event: host URLs, dark styling, and no Remove (read-only for hosts).
import { describe, it, expect, vi } from 'vitest'

vi.mock('next/navigation', () => ({ notFound: vi.fn(() => { throw new Error('NOT_FOUND') }), redirect: vi.fn() }))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => ({ host: { id: 'h1' } })) }))
const race = { status: 'published' }
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: { id: 'e1', host_id: 'h1', status: race.status, name: 'Run Club 5k', slug: 'rc-5k', race_date: '2026-10-18' }, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/attendee-export', () => ({ fetchEventAttendees: vi.fn(async () => []) }))
vi.mock('@/lib/registration-move-history', () => ({ loadMoveHistory: vi.fn(async () => ({ lastMoveByReg: {}, movedOut: [] })) }))
// HOSTSTATS.1 — the Signups card's lib has its own tests; the page test's db stub has no paging.
vi.mock('@/lib/event-stats', () => ({ loadEventStats: vi.fn(async () => ({ ok: false, error: { message: 'stubbed' } })) }))
vi.mock('@/components/host/HostAttendeeTable', () => ({ default: function HostAttendeeTable() { return null } }))
vi.mock('@/components/host/HostPromoCodes', () => ({ default: function HostPromoCodes() { return null } }))
vi.mock('@/components/host/HostEventActions', () => ({ default: function HostEventActions() { return null } }))
vi.mock('@/components/EventWaitlistPanel', () => ({ default: function EventWaitlistPanel() { return null } }))

const { default: Page } = await import('./page.js')
const { default: EventWaitlistPanel } = await import('@/components/EventWaitlistPanel')

function find(el, type) {
  if (!el || typeof el !== 'object') return null
  if (Array.isArray(el)) { for (const c of el) { const f = find(c, type); if (f) return f } return null }
  if (el.type === type) return el
  return find(el.props?.children, type)
}

describe('host event page — waitlist', () => {
  it('renders the read-only dark waitlist panel on the host routes', async () => {
    const el = await Page({ params: Promise.resolve({ id: 'e1' }) })
    const panel = find(el, EventWaitlistPanel)
    expect(panel).toBeTruthy()
    expect(panel.props).toMatchObject({ dark: true, listUrl: '/api/host/events/e1/waitlist', offerUrl: '/api/host/events/e1/waitlist/offer' })
    expect(panel.props.removeUrlFor).toBeUndefined()
  })
})

function hrefs(el) {
  const out = []
  const go = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(go); return }
    if (n.props?.href) out.push(n.props.href)
    go(n.props?.children)
  }
  go(el)
  return out
}

describe('host event page — Edit link', () => {
  it.each(['draft', 'pending_review', 'rejected'])('links to the edit page for a %s event', async (status) => {
    race.status = status
    const el = await Page({ params: Promise.resolve({ id: 'e1' }) })
    expect(hrefs(el)).toContain('/host/events/e1/edit')
  })
  it('has no Edit link for a published event', async () => {
    race.status = 'published'
    const el = await Page({ params: Promise.resolve({ id: 'e1' }) })
    expect(hrefs(el)).not.toContain('/host/events/e1/edit')
  })
})
