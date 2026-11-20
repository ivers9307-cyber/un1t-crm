// HR-DETECT.1 — GET /api/live/[locationId]/detection-visits through the real
// withAuth wrapper: membership + studio_management at the URL's studio, rows
// scoped to that studio and that detection.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const D1 = 'd1000000-0000-4000-8000-0000000000d1'
const D2 = 'd1000000-0000-4000-8000-0000000000d2'
const get = (locationId = LOC_A, qs = `?detection_id=${D1}`) => GET(new Request(`http://localhost/api/live/${locationId}/detection-visits${qs}`), { params: Promise.resolve({ locationId }) })
const visits = () => [
  { id: 'a1000000-0000-4000-8000-000000000001', detection_id: D1, location_id: LOC_A, started_at: '2026-11-20T09:00:00Z' },
  { id: 'a1000000-0000-4000-8000-000000000002', detection_id: D2, location_id: LOC_A, started_at: '2026-11-20T09:05:00Z' },
  { id: 'a1000000-0000-4000-8000-000000000003', detection_id: D1, location_id: LOC_B, started_at: '2026-11-20T09:10:00Z' },
]
const coach = () => person({ [LOC_A]: { role: 'head_coach', permissions: { studio_management: true } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { hr_detection_visits: visits() } }))
})

describe('GET /api/live/[locationId]/detection-visits', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 "Studio management permission required" for a member without it', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager', permissions: { studio_management: false } } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Studio management permission required' })
  })

  it('a permitted member reads only this studio’s visits for this detection', async () => {
    getCurrentUser.mockResolvedValue(coach())
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.visits.map((v) => v.id)).toEqual(['a1000000-0000-4000-8000-000000000001'])
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(coach())
    createServerClient.mockReturnValue(createFakeDb({ tables: { hr_detection_visits: visits() }, errors: { hr_detection_visits: { select: { message: 'secret detail' } } } }))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
