// FINDTEAM.8 (I3) — the operator cancel route answers 409 not_active for a
// placed solo's row (cancelRaceRegistration refuses it).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
let reg
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
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
  db = fakeDb((q) => (q.table === 'race_registrations' && q.action === 'select' ? { data: reg, error: null } : { data: null, error: null }))
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
})
