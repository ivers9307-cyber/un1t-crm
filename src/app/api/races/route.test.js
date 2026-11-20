// ROUTEWRAP.R10 — GET /api/races through the real withAuth wrapper: signed out
// is the wrapper's 401, Manager+ and races are judged at the studio asked for,
// and a failed read answers a fixed message (tests/role-sweep covers the
// mixed-role table).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const get = (q = '') => GET(new Request(`http://localhost/api/races${q}`))
const manager = (role = 'manager') => person({ [LOC_A]: { role, permissions: { races: true } } }, LOC_A)
const EVENTS = [
  { id: 'e0000000-0000-4000-8000-0000000000e1', location_id: LOC_A, name: 'A race', race_date: '2026-12-01' },
  { id: 'e0000000-0000-4000-8000-0000000000e2', location_id: LOC_B, name: 'B race', race_date: '2026-12-02' },
]
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { race_events: EVENTS.map((e) => ({ ...e })), race_waves: [], race_registrations: [] } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/races', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Manager+ required" for staff', async () => {
    getCurrentUser.mockResolvedValue(manager('staff'))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
  })

  it('403 for a studio outside the caller’s, nothing read', async () => {
    getCurrentUser.mockResolvedValue(manager())
    const res = await get(`?location_id=${LOC_B}`)
    expect(res.status).toBe(403)
    expect(db.calls.length).toBe(0)
  })

  it('lists only the caller’s studio', async () => {
    getCurrentUser.mockResolvedValue(manager())
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((e) => e.location_id)).toEqual([LOC_A])
  })

  it('a failed read answers a fixed message', async () => {
    db = createFakeDb({ tables: { race_events: [] }, errors: { race_events: { select: { message: 'relation exploded' } } } })
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(manager())
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('exploded')
  })
})
