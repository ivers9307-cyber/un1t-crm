// GET /api/events/[id]/qr-code through the real withAuth wrapper (a staff
// session; the public page is /event/[slug]): signed in, races somewhere, the
// event's studio (404 outside), races there; then a PNG.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/tenant-host', async (importOriginal) => ({ ...(await importOriginal()), resolveCustomerBaseUrl: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { resolveCustomerBaseUrl } = await import('@/lib/tenant-host')
const { GET } = await import('./route.js')

const EV = 'e0000000-0000-4000-8000-000000000021'
const EV_FAR = 'e0000000-0000-4000-8000-000000000022'
const get = (id) => GET(new Request(`http://localhost/api/events/${id}/qr-code`), { params: Promise.resolve({ id }) })
const racesAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { races: a } }, [LOC_B]: { role: 'manager', permissions: { races: b } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: {
    race_events: [{ id: EV, slug: 'hyrox-may', name: 'Hyrox', location_id: LOC_B, active: true }, { id: EV_FAR, slug: 'far', name: 'Far', location_id: LOC_OTHER, active: true }],
  } }))
  resolveCustomerBaseUrl.mockResolvedValue('https://app.example.com/some/path')
})

describe('GET /api/events/[id]/qr-code', () => {
  it('401 signed out (withAuth; was "Unauthorised")', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get(EV)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without races anywhere', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, false))
    expect((await get(EV)).status).toBe(403)
  })

  it('404 for another studio\'s event', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    expect((await get(EV_FAR)).status).toBe(404)
  })

  it('403 without races at the event\'s studio', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, false))
    expect((await get(EV)).status).toBe(403)
  })

  it('a PNG named after the slug', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, true))
    const res = await get(EV)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toContain('qr-hyrox-may.png')
  })

  it('a bad base url is a 500 without the parser\'s text', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    resolveCustomerBaseUrl.mockResolvedValue('not a url')
    const res = await get(EV)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Cannot build public URL — check NEXT_PUBLIC_APP_URL is configured.')
  })
})
