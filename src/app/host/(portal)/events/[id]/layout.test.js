import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({ notFound: vi.fn(() => { throw new Error('NOT_FOUND') }), redirect: vi.fn(() => { throw new Error('REDIRECT') }) }))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => ({ host: { id: 'h1' } })) }))
const loadHostEvent = vi.fn()
vi.mock('@/lib/host-portal', async (orig) => ({ ...(await orig()), loadHostEvent: (...a) => loadHostEvent(...a) }))
vi.mock('@/lib/host-org-brand', () => ({ resolveHostOrgBrand: vi.fn(async () => ({ name: 'Brand' })) }))
let countResult
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.neq = () => b
      b.then = (res, rej) => Promise.resolve(countResult).then(res, rej)
      return b
    },
  }),
}))
vi.mock('@/components/host/GuardedLink', () => ({ default: function GuardedLink() { return null } }))
vi.mock('@/components/host/HostEventTabs', () => ({ default: function HostEventTabs() { return null } }))
vi.mock('@/components/host/HostEventMenu', () => ({ default: function HostEventMenu() { return null } }))
vi.mock('@/components/DuplicateEventButton', () => ({ default: function DuplicateEventButton() { return null } }))

const { default: Layout } = await import('./layout.js')
const { default: HostEventTabs } = await import('@/components/host/HostEventTabs')
const { default: HostEventMenu } = await import('@/components/host/HostEventMenu')
const { default: DuplicateEventButton } = await import('@/components/DuplicateEventButton')

function find(el, type) {
  if (!el || typeof el !== 'object') return null
  if (Array.isArray(el)) { for (const c of el) { const f = find(c, type); if (f) return f } return null }
  if (el.type === type) return el
  return find(el.props?.children, type)
}
const EVENT = {
  id: 'e1', host_id: 'h1', status: 'published', name: 'Run Club 5k', slug: 'rc-5k', race_date: '2026-11-21', venue_name: 'The Park',
  series_id: null, series: null,
  race_waves: [{ start_time: '12:30:00', display_order: 2 }, { start_time: '10:00:00', display_order: 1 }],
}
const render = () => Layout({ params: Promise.resolve({ id: 'e1' }), children: 'CHILD' })

beforeEach(() => { loadHostEvent.mockReset(); loadHostEvent.mockResolvedValue(EVENT); countResult = { count: 3, error: null } })

describe('event layout', () => {
  it('404s for another host\'s event before rendering anything', async () => {
    loadHostEvent.mockResolvedValue(null)
    await expect(Layout({ params: Promise.resolve({ id: 'theirs' }), children: null })).rejects.toThrow('NOT_FOUND')
  })
  it('hands DuplicateEventButton a string template, never a function', async () => {
    const el = await render()
    const dup = find(el, DuplicateEventButton)
    expect(dup.props.editHref).toBe('/host/events/{id}/setup')
    for (const v of Object.values(dup.props)) expect(typeof v).not.toBe('function')
    for (const t of [HostEventTabs, HostEventMenu]) {
      for (const v of Object.values(find(el, t).props)) expect(typeof v).not.toBe('function')
    }
  })
  it('passes the registration count to the tabs and the menu', async () => {
    const el = await render()
    expect(find(el, HostEventTabs).props).toMatchObject({ eventId: 'e1', attendeeCount: 3 })
    expect(find(el, HostEventMenu).props).toMatchObject({ eventId: 'e1', status: 'published', hasRegistrations: true, brandName: 'Brand' })
  })
  it('says there are no registrations when the count is zero', async () => {
    countResult = { count: 0, error: null }
    const el = await render()
    expect(find(el, HostEventTabs).props.attendeeCount).toBe(0)
    expect(find(el, HostEventMenu).props.hasRegistrations).toBe(false)
  })
  it('treats a failed count as "has registrations"', async () => {
    countResult = { count: null, error: { message: 'boom' } }
    const el = await render()
    expect(find(el, HostEventTabs).props.attendeeCount).toBeNull()
    expect(find(el, HostEventMenu).props.hasRegistrations).toBe(true)
  })
})
