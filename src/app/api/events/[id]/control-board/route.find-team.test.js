// FINDTEAM.8 (I1) — the race-day control board never shows a placed solo's
// own row: they race with the team they joined.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const EV = 'e0000000-0000-4000-8000-000000000001'
const manager = {
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role: 'manager', profileRole: 'manager',
  activeLocation: { id: L1 }, rolesByLocation: { [L1]: 'manager' },
  assignmentsByLocation: { [L1]: { role: 'manager', permissions: { races: true } } },
  locations: [{ id: L1, role: 'manager', features: { races: true } }],
}
const ROWS = [
  { id: 'r-team', status: 'confirmed' },
  { id: 'r-placed', status: 'placed' },
]

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(manager)
  db = fakeDb((q) => {
    if (q.table === 'race_events') return { data: { id: EV, location_id: L1, kind: 'race', waves: [] }, error: null }
    if (q.table === 'race_registrations') {
      // Honour .neq('status', x) the way PostgREST would.
      const neq = q.ops.filter((o) => o[0] === 'neq' && o[1] === 'status').map((o) => o[2])
      return { data: ROWS.filter((r) => !neq.includes(r.status)), error: null }
    }
    return { data: null, error: null }
  })
})

describe('GET /api/events/[id]/control-board — placed rows', () => {
  it('leaves a placed row out of the payload', async () => {
    const res = await GET(new Request('http://localhost/api/x'), { params: Promise.resolve({ id: EV }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.registrations.map((r) => r.id)).toEqual(['r-team'])
    const read = db.queries.find((x) => x.table === 'race_registrations')
    expect(read.ops).toContainEqual(['neq', 'status', 'placed'])
  })
})
