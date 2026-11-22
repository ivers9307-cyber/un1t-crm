// GET/DELETE /api/cars/[id]/documents/[docId] through the real withAuth
// wrapper: signed in, car_processing somewhere, the car's studio (404
// outside), car_processing there; storage text never reaches the response.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { logError } = await import('@/lib/log')
const { GET, DELETE } = await import('./route.js')

const CAR = 'ca000000-0000-4000-8000-000000000001'
const CAR_FAR = 'ca000000-0000-4000-8000-000000000002'
const DOC = 'cd000000-0000-4000-8000-000000000001'
const DOC_FAR = 'cd000000-0000-4000-8000-000000000002'
const call = (fn, carId, docId) => fn(new Request(`http://localhost/api/cars/${carId}/documents/${docId}`), { params: Promise.resolve({ id: carId, docId }) })
const carsAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { car_processing: a } }, [LOC_B]: { role: 'owner', permissions: { car_processing: b } } }, LOC_A)
let db
let signed

beforeEach(() => {
  vi.clearAllMocks()
  signed = { data: { signedUrl: 'https://storage.example/signed' }, error: null }
  db = createFakeDb({ tables: {
    cars: [{ id: CAR, location_id: LOC_B }, { id: CAR_FAR, location_id: LOC_OTHER }],
    car_documents: [
      { id: DOC, car_id: CAR, storage_path: 'b/doc.pdf', filename: 'doc.pdf' },
      { id: DOC_FAR, car_id: CAR_FAR, storage_path: 'd/doc.pdf', filename: 'far.pdf' },
    ],
    invoices_queue: [],
  } })
  db.storage = { from: () => ({ createSignedUrl: async () => signed, remove: async () => ({ error: null }) }) }
  createServerClient.mockReturnValue(db)
})

describe('/api/cars/[id]/documents/[docId]', () => {
  it('401 signed out (withAuth)', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(GET, CAR, DOC)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect((await call(DELETE, CAR, DOC)).status).toBe(401)
    expect(db.tables.car_documents).toHaveLength(2)
  })

  it('403 without car_processing anywhere, before any read', async () => {
    getCurrentUser.mockResolvedValue(carsAt(false, false))
    expect((await call(GET, CAR, DOC)).status).toBe(403)
    expect(db.calls).toHaveLength(0)
  })

  it('404 for another studio\'s document', async () => {
    getCurrentUser.mockResolvedValue(carsAt(true, true))
    expect((await call(GET, CAR_FAR, DOC_FAR)).status).toBe(404)
    expect((await call(DELETE, CAR_FAR, DOC_FAR)).status).toBe(404)
    expect(db.tables.car_documents).toHaveLength(2)
  })

  it('403 without car_processing at the car\'s studio, though held at the active one', async () => {
    getCurrentUser.mockResolvedValue(carsAt(true, false))
    expect((await call(GET, CAR, DOC)).status).toBe(403)
  })

  it('GET hands back the signed url at the car\'s studio', async () => {
    getCurrentUser.mockResolvedValue(carsAt(false, true))
    const res = await call(GET, CAR, DOC)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { url: 'https://storage.example/signed', filename: 'doc.pdf' } })
  })

  it('GET keeps storage text out of a 500', async () => {
    getCurrentUser.mockResolvedValue(carsAt(true, true))
    signed = { data: null, error: { message: 'bucket car-documents: object b/doc.pdf missing' } }
    const res = await call(GET, CAR, DOC)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not open the document.' })
  })

  it('DELETE removes the document', async () => {
    getCurrentUser.mockResolvedValue(carsAt(true, true))
    const res = await call(DELETE, CAR, DOC)
    expect(res.status).toBe(200)
    expect(db.tables.car_documents.map((d) => d.id)).toEqual([DOC_FAR])
  })

  it('SECGAPS.1 — DELETE refuses when the invoice queue read fails: 500, fixed text, nothing removed', async () => {
    getCurrentUser.mockResolvedValue(carsAt(true, true))
    const remove = vi.fn(async () => ({ error: null }))
    db.storage = { from: () => ({ createSignedUrl: async () => signed, remove }) }
    db.errors = { invoices_queue: { select: { code: '57014', message: 'canceling statement due to statement timeout' } } }
    const res = await call(DELETE, CAR, DOC)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not check the document before removing it. Try again.' })
    expect(remove).not.toHaveBeenCalled()
    expect(db.tables.car_documents.map((d) => d.id)).toEqual([DOC, DOC_FAR])
    expect(logError).toHaveBeenCalledWith('car-documents', expect.any(String), expect.objectContaining({ docId: DOC }))
  })
})

