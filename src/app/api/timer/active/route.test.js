// GET /api/timer/active through the real withAuth wrapper: signed in (401,
// now 'Unauthorized'), the query (400), the studio in scope (403) and
// class_timer there (403), then the live run for that studio only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/class-occurrences', async (importOriginal) => ({ ...(await importOriginal()), resolveCurrentOccurrence: vi.fn(async () => null) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const COACH_A = person({ [LOC_A]: { role: 'staff', permissions: { class_timer: true } } }, LOC_A)
const NO_TIMER_A = person({ [LOC_A]: { role: 'staff', permissions: { class_timer: false } } }, LOC_A)
const call = (q) => GET(new Request(`http://localhost/api/timer/active${q ? `?${q}` : ''}`))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { class_timer_runs: [
    { id: 'r1000000-0000-4000-8000-00000000000a', location_id: LOC_A, status: 'paused', created_at: '2026-11-20T10:00:00Z' },
    { id: 'r1000000-0000-4000-8000-00000000000b', location_id: LOC_B, status: 'paused', created_at: '2026-11-20T10:00:00Z' },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/timer/active', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(`location_id=${LOC_A}`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('400 without a location id', async () => {
    getCurrentUser.mockResolvedValue(COACH_A)
    expect((await call()).status).toBe(400)
  })

  it('403 for a studio that is not the caller’s, nothing read', async () => {
    getCurrentUser.mockResolvedValue(COACH_A)
    const res = await call(`location_id=${LOC_B}`)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Location not in your scope' })
    expect(db.calls.length).toBe(0)
  })

  it('403 without class_timer at the studio', async () => {
    getCurrentUser.mockResolvedValue(NO_TIMER_A)
    expect((await call(`location_id=${LOC_A}`)).status).toBe(403)
  })

  it('answers the studio’s own paused run', async () => {
    getCurrentUser.mockResolvedValue(COACH_A)
    const res = await call(`location_id=${LOC_A}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.run.location_id).toBe(LOC_A)
  })
})
