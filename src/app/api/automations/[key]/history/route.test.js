// CLASS-CLIMATE.6 — GET /api/automations/[key]/history through the real withAuth
// wrapper: a manager-tier role somewhere (coarse 403), then membership of the
// ?location_id studio (403) and a manager-tier role there (403).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const at = (role) => person({ [LOC_A]: { role } }, LOC_A)
const get = (loc = LOC_A) => GET(new Request(`http://localhost/api/automations/class_climate/history?location_id=${loc}`), { params: Promise.resolve({ key: 'class_climate' }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { automation_fire_log: [
    { automation_key: 'class_climate', location_id: LOC_A, status: 'fired', action_step: 'on', fired_at: '2026-11-01T07:00:00Z', detail: { class_name: 'HIIT' } },
    { automation_key: 'class_climate', location_id: LOC_B, status: 'fired', action_step: 'on', fired_at: '2026-11-01T08:00:00Z', detail: { class_name: 'Spin' } },
  ], ac_devices: [] } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/automations/[key]/history', () => {
  it('401 signed out (it answered 403 before withAuth)', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Unauthorized" for staff, nothing read', async () => {
    getCurrentUser.mockResolvedValue(at('staff'))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.calls).toEqual([])
  })

  it('403 for a studio that is not the caller’s', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    expect((await get(LOC_B)).status).toBe(403)
    expect(db.calls).toEqual([])
  })

  it('lists the studio’s runs only', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).items.map((i) => i.class_name)).toEqual(['HIIT'])
  })

  it('a failed read answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    db.errors.automation_fire_log = { select: { message: 'relation "automation_fire_log" does not exist' } }
    const res = await get()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load the run history.' })
  })
})
