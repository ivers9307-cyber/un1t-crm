// GET /api/events/[id]/teams/export through the real withAuth wrapper: `races`
// anywhere (403), the event (404), membership of its studio (404) and `races`
// there (403); then the CSV.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/attendee-export', () => ({
  fetchEventAttendees: vi.fn(),
  attendeeCsvResponse: vi.fn(() => new Response('name\n', { status: 200, headers: { 'Content-Type': 'text/csv' } })),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { fetchEventAttendees } = await import('@/lib/attendee-export')
const { GET } = await import('./route.js')

const EV_A = 'e0000000-0000-4000-8000-0000000000a1'
const EV_B = 'e0000000-0000-4000-8000-0000000000b1'
const RACES_OFF = { success: false, error: 'Races feature is disabled at this location' }
const get = (id = EV_A) => GET(new Request(`http://localhost/api/events/${id}/teams/export`), { params: Promise.resolve({ id }) })
const keyAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { races: a } }, [LOC_B]: { role: 'owner', permissions: { races: b } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  fetchEventAttendees.mockResolvedValue([])
  createServerClient.mockReturnValue(createFakeDb({
    tables: {
      race_events: [
        { id: EV_A, location_id: LOC_A, name: 'A', slug: 'a', race_date: '2026-12-01' },
        { id: EV_B, location_id: LOC_B, name: 'B', slug: 'b', race_date: '2026-12-01' },
      ],
    },
  }))
})

describe('GET /api/events/[id]/teams/export', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 holding races nowhere', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, false))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(RACES_OFF)
  })

  it('403 without races at the event\'s studio', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    const res = await get(EV_B)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(RACES_OFF)
    expect(fetchEventAttendees).not.toHaveBeenCalled()
  })

  it('404 for an event at a studio the caller is not in', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: { races: true } } }, LOC_A))
    expect((await get(EV_B)).status).toBe(404)
  })

  it('an allowed caller gets the CSV', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv')
    expect(fetchEventAttendees).toHaveBeenCalledWith(expect.anything(), EV_A)
  })

  it('a failed export is a 500 without the error text', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    fetchEventAttendees.mockRejectedValue(new Error('secret detail'))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
