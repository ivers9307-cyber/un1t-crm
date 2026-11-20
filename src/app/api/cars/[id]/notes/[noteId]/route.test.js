// DELETE /api/cars/[id]/notes/[noteId] through the real withAuth wrapper:
// car_processing anywhere (403), the note pinned to its car (404), membership
// of the note's studio (404) and car_processing there (403).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { DELETE } = await import('./route.js')

const CAR = 'c0000000-0000-4000-8000-0000000000c1'
const NOTE_A = 'e0000000-0000-4000-8000-0000000000a1'
const NOTE_B = 'e0000000-0000-4000-8000-0000000000b1'
const del = (noteId = NOTE_A) => DELETE(new Request(`http://localhost/api/cars/${CAR}/notes/${noteId}`, { method: 'DELETE' }), { params: Promise.resolve({ id: CAR, noteId }) })
const rows = () => [
  { id: NOTE_A, car_id: CAR, location_id: LOC_A, content: 'a', kind: 'user' },
  { id: NOTE_B, car_id: CAR, location_id: LOC_B, content: 'b', kind: 'user' },
]
const keyAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { car_processing: a } }, [LOC_B]: { role: 'owner', permissions: { car_processing: b } } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { car_notes: rows() } })
  createServerClient.mockReturnValue(db)
})

describe('DELETE /api/cars/[id]/notes/[noteId]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await del()).status).toBe(401)
  })

  it('403 "Not permitted" holding car_processing nowhere', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, false))
    const res = await del()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Not permitted' })
    expect(db.tables.car_notes).toHaveLength(2)
  })

  it('403 "Not permitted" without car_processing at the note\'s studio', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    const res = await del(NOTE_B)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Not permitted' })
    expect(db.tables.car_notes).toHaveLength(2)
  })

  it('404 for a note at a studio the caller is not in', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: { car_processing: true } } }, LOC_A))
    expect((await del(NOTE_B)).status).toBe(404)
    expect(db.tables.car_notes).toHaveLength(2)
  })

  it('an allowed caller deletes the note', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    const res = await del()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(db.tables.car_notes.map((n) => n.id)).toEqual([NOTE_B])
  })

  it('a failed delete is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    createServerClient.mockReturnValue(createFakeDb({ tables: { car_notes: rows() }, errors: { car_notes: { delete: { message: 'secret detail' } } } }))
    const res = await del()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
