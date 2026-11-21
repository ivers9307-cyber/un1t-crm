// PATCH /api/registrations/[id]/race-edit through the real withAuth wrapper:
// signed in (withAuth's 401), races somewhere (403), the body, the race's
// studio (404 outside), races there (403); then the timing write.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PATCH } = await import('./route.js')

const EV_B = 'e0000000-0000-4000-8000-0000000000b1'
const EV_FAR = 'e0000000-0000-4000-8000-0000000000f1'
const REG_B = 'a0000000-0000-4000-8000-0000000000b1'
const REG_FAR = 'a0000000-0000-4000-8000-0000000000f1'
const START = '2026-11-21T09:00:00.000Z'
const patch = (id, body) => PATCH(new Request(`http://localhost/api/registrations/${id}/race-edit`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) })
const racesAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { races: a } }, [LOC_B]: { role: 'manager', permissions: { races: b } } }, LOC_A)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    race_events: [{ id: EV_B, location_id: LOC_B, kind: 'race' }, { id: EV_FAR, location_id: LOC_OTHER, kind: 'race' }],
    race_registrations: [
      { id: REG_B, race_event_id: EV_B, race_started_at: START, race_finished_at: null },
      { id: REG_FAR, race_event_id: EV_FAR, race_started_at: START, race_finished_at: null },
    ],
  } })
  createServerClient.mockReturnValue(db)
})

describe('PATCH /api/registrations/[id]/race-edit', () => {
  it('401 signed out (withAuth; was "Unauthorised")', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await patch(REG_B, { finished_at: null })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without races anywhere', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, false))
    expect((await patch(REG_B, { finished_at: null })).status).toBe(403)
  })

  it("404 for another studio's registration, nothing written", async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    expect((await patch(REG_FAR, { finished_at: '2026-11-21T10:00:00.000Z' })).status).toBe(404)
    expect(db.tables.race_registrations.find((r) => r.id === REG_FAR).race_finished_at).toBeNull()
  })

  it("403 without races at the race's studio", async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, false))
    expect((await patch(REG_B, { finished_at: '2026-11-21T10:00:00.000Z' })).status).toBe(403)
  })

  it('writes the finish time', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, true))
    const res = await patch(REG_B, { finished_at: '2026-11-21T10:00:00.000Z' })
    expect(res.status).toBe(200)
    expect((await res.json()).data.race_finished_at).toBe('2026-11-21T10:00:00.000Z')
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    db.errors.race_registrations = { update: { message: 'secret db text' } }
    const res = await patch(REG_B, { finished_at: '2026-11-21T10:00:00.000Z' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret db text')
  })
})
