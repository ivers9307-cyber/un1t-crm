// POST /api/registrations/[id]/race-reset through the real withAuth wrapper:
// signed in (401, now 'Unauthorized'), races somewhere (403), the
// registration (404), its event's studio (404, never 403), races there (403)
// and the kind (409), then the timing is cleared.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const EV_A = 'ee000000-0000-4000-8000-00000000000a'
const EV_B = 'ee000000-0000-4000-8000-00000000000b'
const REG_A = 'aa000000-0000-4000-8000-00000000000a'
const REG_B = 'aa000000-0000-4000-8000-00000000000b'
const RACES_A = person({ [LOC_A]: { role: 'manager', permissions: { races: true } } }, LOC_A)
const NO_RACES = person({ [LOC_A]: { role: 'manager', permissions: { races: false } } }, LOC_A)
const reset = (id) => POST(new Request(`http://localhost/api/registrations/${id}/race-reset`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const STARTED = '2026-11-20T09:00:00Z'
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    race_events: [{ id: EV_A, location_id: LOC_A, kind: 'race' }, { id: EV_B, location_id: LOC_B, kind: 'race' }],
    race_registrations: [
      { id: REG_A, race_event_id: EV_A, race_started_at: STARTED },
      { id: REG_B, race_event_id: EV_B, race_started_at: STARTED },
    ],
  } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/registrations/[id]/race-reset', () => {
  it('401 signed out, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await reset(REG_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.race_registrations[0].race_started_at).toBe(STARTED)
  })

  it('403 without races anywhere', async () => {
    getCurrentUser.mockResolvedValue(NO_RACES)
    expect((await reset(REG_A)).status).toBe(403)
  })

  it('404 for another studio’s registration, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(RACES_A)
    expect((await reset(REG_B)).status).toBe(404)
    expect(db.tables.race_registrations[1].race_started_at).toBe(STARTED)
  })

  it('clears the caller’s own registration timing', async () => {
    getCurrentUser.mockResolvedValue(RACES_A)
    const res = await reset(REG_A)
    expect(res.status).toBe(200)
    expect(db.tables.race_registrations[0].race_started_at).toBeNull()
  })

  it('a failed write answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(RACES_A)
    db.errors.race_registrations = { update: { message: 'could not serialize access' } }
    const res = await reset(REG_A)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not reset the timing. Try again.' })
  })
})
