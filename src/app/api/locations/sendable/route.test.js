// GET /api/locations/sendable through the real withAuth wrapper: `races`
// anywhere (403), membership of the event's studio (403) and `races` there
// (403); the list is that studio's organisation.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, ORG, LOC_A, LOC_B, LOC_OTHER } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const RACES_OFF = { success: false, error: 'Races feature is disabled at this location' }
const get = (loc) => GET(new Request(`http://localhost/api/locations/sendable${loc ? `?event_location_id=${loc}` : ''}`))
const keyAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { races: a } }, [LOC_B]: { role: 'owner', permissions: { races: b } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({
    tables: {
      locations: [
        { id: LOC_A, name: 'Studio A', organization_id: ORG, active: true, is_host_anchor: false },
        { id: LOC_B, name: 'Studio B', organization_id: ORG, active: true, is_host_anchor: false },
        { id: LOC_OTHER, name: 'Anchor', organization_id: ORG, active: true, is_host_anchor: true },
      ],
      organizations: [{ id: ORG, name: 'Org', master_location_id: LOC_A }],
    },
  }))
})

describe('GET /api/locations/sendable', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get(LOC_A)).status).toBe(401)
  })

  it('403 holding races nowhere, even without a param', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, false))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(RACES_OFF)
  })

  it('403 without races at the event\'s studio, though held at the active one', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    const res = await get(LOC_B)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(RACES_OFF)
  })

  it('403 for an event studio the caller is not in', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    expect((await get(LOC_OTHER)).status).toBe(403)
  })

  it('an empty list without a param; otherwise the org\'s real studios, master flagged', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, true))
    expect(await (await get()).json()).toEqual({ success: true, data: [] })
    const res = await get(LOC_B)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: [
      { id: LOC_A, name: 'Studio A', is_master: true },
      { id: LOC_B, name: 'Studio B', is_master: false },
    ] })
  })
})
