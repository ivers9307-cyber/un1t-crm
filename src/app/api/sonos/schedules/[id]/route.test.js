// SONOS.15 — PATCH/DELETE /api/sonos/schedules/[id] through the real withAuth
// wrapper. device_control at the active studio and the active studio itself
// are checked in the handler with their old words; the write is pinned to the
// active studio, so another studio's schedule is a 404 and stays untouched.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PATCH, DELETE } = await import('./route.js')

const HERE = 'e6000000-0000-4000-8000-000000000001'
const THERE = 'e6000000-0000-4000-8000-000000000002'
const props = (id) => ({ params: Promise.resolve({ id }) })
const patch = (id, body) => PATCH(new Request(`http://localhost/api/sonos/schedules/${id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), props(id))
const del = (id) => DELETE(new Request(`http://localhost/api/sonos/schedules/${id}`, { method: 'DELETE' }), props(id))
const withKey = (on) => person({ [LOC_A]: { role: 'manager', permissions: { device_control: on } }, [LOC_B]: { role: 'manager', permissions: { device_control: true } } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { sonos_schedules: [
    { id: HERE, location_id: LOC_A, name: 'Morning', enabled: true },
    { id: THERE, location_id: LOC_B, name: 'Other studio', enabled: true },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('PATCH /api/sonos/schedules/[id]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await patch(HERE, { enabled: false })).status).toBe(401)
    expect(db.tables.sonos_schedules[0].enabled).toBe(true)
  })

  it('403 "Forbidden" without device_control at the active studio', async () => {
    getCurrentUser.mockResolvedValue(withKey(false))
    const res = await patch(HERE, { enabled: false })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('404 for another studio\'s schedule, which is not written', async () => {
    getCurrentUser.mockResolvedValue(withKey(true))
    expect((await patch(THERE, { enabled: false })).status).toBe(404)
    expect(db.tables.sonos_schedules[1].enabled).toBe(true)
  })

  it('saves a schedule at the active studio', async () => {
    getCurrentUser.mockResolvedValue(withKey(true))
    const res = await patch(HERE, { enabled: false })
    expect(res.status).toBe(200)
    expect((await res.json()).schedule).toMatchObject({ id: HERE, enabled: false })
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(withKey(true))
    createServerClient.mockReturnValue(createFakeDb({ tables: { sonos_schedules: [{ id: HERE, location_id: LOC_A }] }, errors: { sonos_schedules: { update: { message: 'secret detail' } } } }))
    const res = await patch(HERE, { enabled: false })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})

describe('DELETE /api/sonos/schedules/[id]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await del(HERE)).status).toBe(401)
    expect(db.tables.sonos_schedules).toHaveLength(2)
  })

  it('another studio\'s schedule is never deleted', async () => {
    getCurrentUser.mockResolvedValue(withKey(true))
    await del(THERE)
    expect(db.tables.sonos_schedules.map((r) => r.id)).toContain(THERE)
  })

  it('deletes a schedule at the active studio', async () => {
    getCurrentUser.mockResolvedValue(withKey(true))
    expect((await del(HERE)).status).toBe(200)
    expect(db.tables.sonos_schedules.map((r) => r.id)).toEqual([THERE])
  })
})
