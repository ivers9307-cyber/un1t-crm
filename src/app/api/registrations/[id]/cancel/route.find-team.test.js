// FINDTEAM.8 (I3) — the operator cancel route answers 409 not_active for a
// placed solo's row (cancelRaceRegistration refuses it). FINDTEAM.9 — and 409
// has_placed_solos for a team entry that solos were placed into.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
let reg
let placedCount = 0
let placedErr = null
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
const { getCurrentUser } = await import('@/lib/auth')
const { POST } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const manager = {
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role: 'manager', profileRole: 'manager',
  activeLocation: { id: L1 }, rolesByLocation: { [L1]: 'manager' },
  assignmentsByLocation: { [L1]: { role: 'manager', permissions: { races: true } } },
  locations: [{ id: L1, role: 'manager', features: { races: true } }],
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(manager)
  placedCount = 0
  placedErr = null
  db = fakeDb((q) => {
    if (q.table !== 'race_registrations' || q.action !== 'select') return { data: null, error: null }
    if (q.ops.some((o) => o[0] === 'eq' && o[1] === 'placed_into_registration_id')) return { data: null, count: placedCount, error: placedErr }
    return { data: reg, error: null }
  })
})

const call = () => POST(new Request('http://localhost/api/x', { method: 'POST' }), { params: Promise.resolve({ id: 'r1' }) })

describe('POST /api/registrations/[id]/cancel — placed', () => {
  it('409 not_active for a placed row, nothing written', async () => {
    reg = { id: 'r1', status: 'placed', race_events: { location_id: L1 } }
    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('not_active')
    expect(db.queries.some((x) => x.action === 'update')).toBe(false)
  })
  it('a confirmed row still cancels', async () => {
    reg = { id: 'r1', status: 'confirmed', race_events: { location_id: L1 } }
    const res = await call()
    expect(res.status).toBe(200)
    expect(db.queries.some((x) => x.action === 'update')).toBe(true)
  })

  // FINDTEAM.9 — a team entry that solos were placed into: the same 409 the
  // registration DELETE answers.
  it('409 has_placed_solos for a team solos were placed into, the DELETE route\'s message shape, nothing written', async () => {
    reg = { id: 'r1', status: 'confirmed', race_events: { location_id: L1 } }
    placedCount = 2
    const res = await call()
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json).toEqual({
      success: false,
      error: 'has_placed_solos',
      message: expect.stringMatching(/^2 placed entrants point at this team; un-place them first\./),
      placed_count: 2,
    })
    expect(json.message).toMatch(/cannot be cancelled from here\.$/)
    expect(db.queries.some((x) => x.action === 'update')).toBe(false)
  })
  it('an unreadable placed count is a 500, nothing written', async () => {
    reg = { id: 'r1', status: 'confirmed', race_events: { location_id: L1 } }
    placedErr = { message: 'boom' }
    const res = await call()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('boom')
    expect(db.queries.some((x) => x.action === 'update')).toBe(false)
  })
})

// The gates, through the real withAuth wrapper (ROUTEWRAP.R5).
describe('POST /api/registrations/[id]/cancel — gates', () => {
  const L2 = 'a0000000-0000-0000-0000-000000000002'
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
  })
  it('403 for staff (no manager role anywhere), nothing read', async () => {
    getCurrentUser.mockResolvedValue({ ...manager, role: 'staff', profileRole: 'staff', rolesByLocation: { [L1]: 'staff' } })
    expect((await call()).status).toBe(403)
    expect(db.queries.length).toBe(0)
  })
  it('404 for a registration at another studio, nothing written', async () => {
    reg = { id: 'r1', status: 'confirmed', race_events: { location_id: L2 } }
    expect((await call()).status).toBe(404)
    expect(db.queries.some((x) => x.action === 'update')).toBe(false)
  })
})
