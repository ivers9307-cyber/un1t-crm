// ROUTEWRAP.R10 — DELETE /api/registrations/[id]/penalties/[penaltyId] through
// the real withAuth wrapper: signed out is the wrapper's 401, races is judged
// at the registration's studio, another studio's registration and another
// registration's penalty are 404, and a failed delete answers a fixed message.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { DELETE } = await import('./route.js')

const id = (n) => `a0000000-0000-4000-8000-00000000000${n}`
const EV_A = id(1), EV_B = id(2), REG_A = id(3), REG_B = id(4), PEN_A = id(5), PEN_B = id(6)
const del = (reg, pen) => DELETE(new Request(`http://localhost/api/registrations/${reg}/penalties/${pen}`, { method: 'DELETE' }), { params: Promise.resolve({ id: reg, penaltyId: pen }) })
const manager = (on = true) => person({ [LOC_A]: { role: 'manager', permissions: { races: on } } }, LOC_A)
let db
const seed = (errors) => createFakeDb({
  tables: {
    race_events: [{ id: EV_A, location_id: LOC_A, name: 'A', slug: 'a', kind: 'race' }, { id: EV_B, location_id: LOC_B, name: 'B', slug: 'b', kind: 'race' }],
    race_registrations: [{ id: REG_A, race_event_id: EV_A, team_id: id(7) }, { id: REG_B, race_event_id: EV_B, team_id: id(8) }],
    race_penalties: [{ id: PEN_A, race_registration_id: REG_A, reason: 'x' }, { id: PEN_B, race_registration_id: REG_B, reason: 'y' }],
  },
  errors,
})

beforeEach(() => {
  vi.clearAllMocks()
  db = seed()
  createServerClient.mockImplementation(() => db)
})

describe('DELETE /api/registrations/[id]/penalties/[penaltyId]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await del(REG_A, PEN_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without races', async () => {
    getCurrentUser.mockResolvedValue(manager(false))
    expect((await del(REG_A, PEN_A)).status).toBe(403)
    expect(db.tables.race_penalties).toHaveLength(2)
  })

  it('404 for another studio’s registration and for another registration’s penalty', async () => {
    getCurrentUser.mockResolvedValue(manager())
    expect((await del(REG_B, PEN_B)).status).toBe(404)
    expect((await del(REG_A, PEN_B)).status).toBe(404)
    expect(db.tables.race_penalties).toHaveLength(2)
  })

  it('removes the penalty', async () => {
    getCurrentUser.mockResolvedValue(manager())
    const res = await del(REG_A, PEN_A)
    expect(await res.json()).toEqual({ success: true })
    expect(db.tables.race_penalties.map((p) => p.id)).toEqual([PEN_B])
  })

  it('a failed delete answers a fixed message', async () => {
    db = seed({ race_penalties: { delete: { message: 'fk violation xyz' } } })
    getCurrentUser.mockResolvedValue(manager())
    const res = await del(REG_A, PEN_A)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('xyz')
  })
})
