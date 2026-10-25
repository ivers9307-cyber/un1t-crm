// FINDTEAM.8 (I3, M4) — PUT and DELETE refuse a placed solo's row, and DELETE
// refuses a team entry that solos were placed into.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
let reg
let placedCount
let placedErr
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
const { getCurrentUser } = await import('@/lib/auth')
const { PUT, DELETE } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const W2 = 'f0000000-0000-4000-8000-0000000000f2'
const manager = {
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role: 'manager', profileRole: 'manager',
  activeLocation: { id: L1 }, rolesByLocation: { [L1]: 'manager' },
  assignmentsByLocation: { [L1]: { role: 'manager', permissions: { races: true } } },
  locations: [{ id: L1, role: 'manager', features: { races: true } }],
}
const props = { params: Promise.resolve({ id: 'r1' }) }
const put = (body) => PUT(new Request('http://localhost/api/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), props)
const del = () => DELETE(new Request('http://localhost/api/x', { method: 'DELETE' }), props)
const writes = () => db.queries.filter((x) => x.table === 'race_registrations' && (x.action === 'update' || x.action === 'delete'))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(manager)
  reg = { id: 'r1', status: 'confirmed', wave_id: null, race_event_id: 'e1', team_id: 't1', race: { id: 'e1', location_id: L1, waves: [{ id: W2 }] } }
  placedCount = 0
  placedErr = null
  db = fakeDb((q) => {
    if (q.table !== 'race_registrations') return { data: null, error: null }
    if (q.action === 'select' && q.ops.some((o) => o[0] === 'eq' && o[1] === 'placed_into_registration_id')) return { data: null, count: placedCount, error: placedErr }
    if (q.action === 'select') return { data: reg, error: null }
    return { data: null, error: null }
  })
})

describe('PUT /api/event-registrations/[id]', () => {
  it('refuses a placed row with 409 not_active and writes nothing', async () => {
    reg.status = 'placed'
    const res = await put({ wave_id: W2 })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('not_active')
    expect(writes()).toHaveLength(0)
  })
  it('still moves a confirmed row', async () => {
    const res = await put({ wave_id: W2 })
    expect(res.status).toBe(200)
    expect(writes()).toHaveLength(1)
  })
})

describe('DELETE /api/event-registrations/[id]', () => {
  it('refuses a placed row with 409 not_active', async () => {
    reg.status = 'placed'
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('not_active')
    expect(writes()).toHaveLength(0)
  })
  it('refuses a team that solos were placed into with 409 has_placed_solos', async () => {
    placedCount = 2
    const res = await del()
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe('has_placed_solos')
    expect(json.message).toMatch(/^2 placed entrants point at this team; un-place them first\./)
    expect(json.message).toMatch(/no un-place tool/)
    expect(writes()).toHaveLength(0)
  })
  it('a failed placed-into check deletes nothing', async () => {
    placedErr = { message: 'boom' }
    expect((await del()).status).toBe(500)
    expect(writes()).toHaveLength(0)
  })
  it('deletes a team nobody was placed into', async () => {
    const res = await del()
    expect(res.status).toBe(200)
    expect(writes()).toHaveLength(1)
  })
})
