// ROUTEWRAP.R16 — GET/POST /api/sonos/schedules through the real withAuth
// wrapper: signed in (the same 401), device_control at the active studio
// ('Forbidden' 403), the active studio's rows only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')

const S_A = 'c3000000-0000-4000-8000-0000000000a1'
const S_B = 'c3000000-0000-4000-8000-0000000000b1'
const get = () => GET(new Request('http://localhost/api/sonos/schedules'))
const post = (body) => POST(new Request('http://localhost/api/sonos/schedules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const devices = (on) => person({ [LOC_A]: { role: 'manager', permissions: { device_control: on } }, [LOC_B]: { role: 'manager', permissions: { device_control: true } } }, LOC_A)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { sonos_schedules: [
    { id: S_A, location_id: LOC_A, name: 'Mornings', created_at: '2026-11-01T00:00:00Z' },
    { id: S_B, location_id: LOC_B, name: 'B only', created_at: '2026-11-01T00:00:00Z' },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/sonos/schedules', () => {
  it('401 signed out, both methods', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect(await (await get()).json()).toEqual({ success: false, error: 'Unauthorized' })
    expect((await post({ name: 'x' })).status).toBe(401)
  })

  it("403 'Forbidden' without device_control at the active studio", async () => {
    getCurrentUser.mockResolvedValue(devices(false))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect((await post({ name: 'x' })).status).toBe(403)
    expect(db.tables.sonos_schedules).toHaveLength(2)
  })

  it("lists only the active studio's schedules", async () => {
    getCurrentUser.mockResolvedValue(devices(true))
    const body = await (await get()).json()
    expect(body.schedules.map((s) => s.id)).toEqual([S_A])
  })

  it('creates at the active studio; a failed insert hides the database text', async () => {
    getCurrentUser.mockResolvedValue(devices(true))
    const res = await post({ name: 'Evenings' })
    expect(res.status).toBe(200)
    expect((await res.json()).schedule.location_id).toBe(LOC_A)
    db.errors.sonos_schedules = { insert: { message: 'secret db text' } }
    const bad = await post({ name: 'Late' })
    expect(bad.status).toBe(500)
    expect(JSON.stringify(await bad.json())).not.toContain('secret db text')
  })
})
