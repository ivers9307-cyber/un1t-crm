// GET /api/cars/[id]/xero-invoice-pdf through the real withAuth wrapper:
// car_processing somewhere, then at the car's studio; 404 outside it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const CAR = 'ca000000-0000-4000-8000-000000000001'
const CAR_B = 'ca000000-0000-4000-8000-000000000002'
let signError
const build = () => {
  const d = createFakeDb({
    tables: {
      cars: [
        { id: CAR, location_id: LOC_A, xero_invoice_pdf_path: 'inv/car1.pdf' },
        { id: CAR_B, location_id: LOC_B, xero_invoice_pdf_path: 'inv/car2.pdf' },
      ],
    },
  })
  d.storage = { from: () => ({ createSignedUrl: async (p) => (signError ? { data: null, error: signError } : { data: { signedUrl: `https://signed/${p}` }, error: null }) }) }
  return d
}
const get = (id = CAR) => GET(new Request(`http://localhost/api/cars/${id}/xero-invoice-pdf`), { params: Promise.resolve({ id }) })
const processor = (on = true) => person({ [LOC_A]: { role: 'staff', permissions: { car_processing: on } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  signError = null
  createServerClient.mockReturnValue(build())
})

describe('GET /api/cars/[id]/xero-invoice-pdf', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 "Not permitted" without car_processing', async () => {
    getCurrentUser.mockResolvedValue(processor(false))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Not permitted' })
  })

  it('404 for a car at another studio', async () => {
    getCurrentUser.mockResolvedValue(processor())
    expect((await get(CAR_B)).status).toBe(404)
  })

  it('a signed URL for a car at the caller\'s studio', async () => {
    getCurrentUser.mockResolvedValue(processor())
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, url: 'https://signed/inv/car1.pdf' })
  })

  it('a failed signing is a 500 without the storage text', async () => {
    getCurrentUser.mockResolvedValue(processor())
    signError = { message: 'secret detail' }
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
