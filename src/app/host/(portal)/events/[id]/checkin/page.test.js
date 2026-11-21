// HOSTCHECKIN.1 — the host Check-in tab: own events only, the host routes
// and theme, confirmed entries only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NOT_FOUND') }),
  redirect: vi.fn(() => { throw new Error('REDIRECT') }),
}))
let session
let race
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.in = async () => ({ data: table === 'race_checkins' ? [{ race_registration_id: 'r1', team_member_id: 'm1' }] : [], error: null })
      b.maybeSingle = async () => ({ data: race, error: null })
      return b
    },
  }),
}))
vi.mock('@/components/EventCheckinClient', () => ({ default: function EventCheckinClient() { return null } }))

const { default: Page } = await import('./page.js')

beforeEach(() => {
  session = { host: { id: 'h1' } }
  race = {
    id: 'e1', host_id: 'h1', kind: 'workshop',
    waves: [{ id: 'w1', start_time: '12:30:00', label: null, display_order: 0 }],
    registrations: [
      { id: 'r1', status: 'confirmed', wave_id: 'w1', teams: { id: 't1', name: 'Ann', team_members: [{ id: 'm1', name: 'Ann', email: 'ann@example.test' }] } },
      { id: 'r2', status: 'cancelled', wave_id: 'w1', teams: { id: 't2', name: 'Bo', team_members: [{ id: 'm2', name: 'Bo', email: null }] } },
    ],
  }
})

describe('/host/events/[id]/checkin', () => {
  it('renders the roster for the host\'s own event on the host routes and theme', async () => {
    const el = await Page({ params: Promise.resolve({ id: 'e1' }) })
    const client = el.props.children
    expect(client.props).toMatchObject({ eventId: 'e1', isRace: false, apiBase: '/api/host/events/e1/checkin', host: true })
    expect(client.props.registrations.map((r) => r.id)).toEqual(['r1'])
    expect(client.props.registrations[0]).toMatchObject({ wave_time: '12:30' })
    expect(client.props.registrations[0].team.team_members[0].checked_in).toBe(true)
  })

  it('404s another host\'s event and sends a signed-out visitor to sign in', async () => {
    race.host_id = 'h2'
    await expect(Page({ params: Promise.resolve({ id: 'e1' }) })).rejects.toThrow('NOT_FOUND')
    session = null
    await expect(Page({ params: Promise.resolve({ id: 'e1' }) })).rejects.toThrow('REDIRECT')
  })
})
