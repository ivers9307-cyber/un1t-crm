// MEMBERWRITESWEEP.1f — PATCH/DELETE /api/admin/tv-displays/[id]: a TV's
// orientation, and deleting a TV. They replace direct updates and deletes on
// tv_displays from the web TV admin and the staff phone. Gate: tv_displays,
// web OR mobile, at the TV's own studio; a TV outside the caller's studios is
// a 404 and nothing is touched.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { PATCH, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import {
  OWNER_A, STAFF_A, LOC_A, LOC_B, TV_ID, makeFakeDb, writesOf, jsonRequest, paramsOf, display,
} from '@/lib/tv-admin.test-helpers.js'

const rotate = (rotation, id = TV_ID) => PATCH(jsonRequest(`/api/admin/tv-displays/${id}`, 'PATCH', { rotation }), paramsOf(id))
const remove = (id = TV_ID) => DELETE(jsonRequest(`/api/admin/tv-displays/${id}`, 'DELETE'), paramsOf(id))

function tvDb(row = display(), write = () => ({ data: [{ id: TV_ID }], error: null })) {
  return makeFakeDb((call) => (call.op === 'select' ? { data: row, error: null } : write(call)))
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER_A)
  db = tvDb()
})

describe('PATCH /api/admin/tv-displays/[id] (orientation)', () => {
  it.each([[0], [90], [180], [270]])('sets rotation %i on that TV, narrowed to its studio', async (r) => {
    const res = await rotate(r)
    expect(res.status).toBe(200)
    const [w] = writesOf(db)
    expect(w).toMatchObject({ table: 'tv_displays', op: 'update', filters: [['eq', 'id', TV_ID], ['eq', 'location_id', LOC_A]] })
    expect(w.payload.rotation).toBe(r)
    expect(Object.keys(w.payload).sort()).toEqual(['rotation', 'updated_at'])
  })

  it.each([[45], [-90], [360], ['90'], [null]])('400 on rotation %j, nothing written', async (r) => {
    expect((await rotate(r)).status).toBe(400)
    expect(writesOf(db)).toEqual([])
  })

  it('a TV deleted between the read and the write: 404', async () => {
    db = tvDb(display(), () => ({ data: [], error: null }))
    expect((await rotate(90)).status).toBe(404)
  })

  it('an update error is a 500', async () => {
    db = tvDb(display(), () => ({ data: null, error: { message: 'boom' } }))
    expect((await rotate(90)).status).toBe(500)
  })

  it('another studio\'s TV: 404, nothing written; plain staff: 403', async () => {
    db = tvDb(display({ location_id: LOC_B }))
    expect((await rotate(90)).status).toBe(404)
    expect(writesOf(db)).toEqual([])
    db = tvDb()
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await rotate(90)).status).toBe(403)
    expect(writesOf(db)).toEqual([])
  })
})

describe('DELETE /api/admin/tv-displays/[id]', () => {
  it('deletes the TV, narrowed to its studio (its content goes with it: ON DELETE CASCADE)', async () => {
    const res = await remove()
    expect(res.status).toBe(200)
    expect(writesOf(db)).toEqual([expect.objectContaining({
      table: 'tv_displays', op: 'delete', filters: [['eq', 'id', TV_ID], ['eq', 'location_id', LOC_A]],
    })])
  })

  it('gone between the read and the delete: still 200 (the TV is gone, which is what was asked)', async () => {
    db = tvDb(display(), () => ({ data: [], error: null }))
    expect((await remove()).status).toBe(200)
  })

  it('another studio\'s TV: 404, touches nothing', async () => {
    db = tvDb(display({ location_id: LOC_B }))
    const res = await remove()
    expect(res.status).toBe(404)
    expect(writesOf(db)).toEqual([])
  })

  it('an unknown TV: 404', async () => {
    db = tvDb(null)
    expect((await remove()).status).toBe(404)
  })

  it('a delete error is a 500', async () => {
    db = tvDb(display(), () => ({ data: null, error: { message: 'boom' } }))
    expect((await remove()).status).toBe(500)
  })

  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await remove()).status).toBe(401)
    expect(db.calls).toEqual([])
  })
})
