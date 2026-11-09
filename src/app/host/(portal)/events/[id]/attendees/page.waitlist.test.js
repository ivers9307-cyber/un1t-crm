// EVENT-WAITLIST.1 — the Attendees tab of a host event carries the waitlist panel for its
// own event: host URLs, dark styling, and no Remove (read-only for hosts).
import { describe, it, expect, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NOT_FOUND') }),
  redirect: vi.fn(() => { throw new Error('REDIRECT') }),
}))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => ({ host: { id: 'h1' } })) }))
const race = { host_id: 'h1' }
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: { id: 'e1', host_id: race.host_id, registration_questions: null }, error: null })
      return b
    },
  }),
}))
const attendees = { rows: [] }
vi.mock('@/lib/attendee-export', () => ({ fetchEventAttendees: vi.fn(async () => attendees.rows) }))
vi.mock('@/lib/registration-move-history', () => ({ loadMoveHistory: vi.fn(async () => ({ lastMoveByReg: {}, movedOut: [] })) }))
vi.mock('@/components/host/HostAttendeeTable', () => ({ default: function HostAttendeeTable() { return null } }))
vi.mock('@/components/EventWaitlistPanel', () => ({ default: function EventWaitlistPanel() { return null } }))

const { default: Page } = await import('./page.js')
const { getCurrentHost } = await import('@/lib/host-auth')
const { default: EventWaitlistPanel } = await import('@/components/EventWaitlistPanel')

function find(el, type) {
  if (!el || typeof el !== 'object') return null
  if (Array.isArray(el)) { for (const c of el) { const f = find(c, type); if (f) return f } return null }
  if (el.type === type) return el
  return find(el.props?.children, type)
}

describe('host event attendees page — waitlist', () => {
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

describe('host event attendees page — gates and Export CSV', () => {
  it("404s for another host's event", async () => {
    race.host_id = 'someone-else'
    await expect(Page({ params: Promise.resolve({ id: 'e1' }) })).rejects.toThrow('NOT_FOUND')
    race.host_id = 'h1'
  })
  it('redirects to the host login when signed out', async () => {
    getCurrentHost.mockResolvedValueOnce(null)
    await expect(Page({ params: Promise.resolve({ id: 'e1' }) })).rejects.toThrow('REDIRECT')
  })
  it('has no Export CSV link when there are no registrations', async () => {
    attendees.rows = []
    const el = await Page({ params: Promise.resolve({ id: 'e1' }) })
    expect(hrefs(el)).not.toContain('/api/host/events/e1/attendees/export')
  })
  it('links Export CSV when there are registrations', async () => {
    attendees.rows = [{ id: 'r1', status: 'confirmed', teams: null, contact: { first_name: 'A', last_name: 'B' }, wave: null, payment: null, answers: null }]
    const el = await Page({ params: Promise.resolve({ id: 'e1' }) })
    expect(hrefs(el)).toContain('/api/host/events/e1/attendees/export')
    attendees.rows = []
  })
})
