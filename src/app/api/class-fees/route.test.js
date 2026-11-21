// GET /api/class-fees through the real withAuth wrapper: signed in, then by
// hand, in the old order: location_id 400, tab 400, studio 403, class_fees 403.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/class-fees-run', async (importOriginal) => ({ ...(await importOriginal()), readClassFeeContext: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { readClassFeeContext } = await import('@/lib/class-fees-run')
const { GET } = await import('./route.js')

const get = (qs) => GET(new Request(`http://localhost/api/class-fees${qs}`))
const feesAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { class_fees: a } }, [LOC_B]: { role: 'owner', permissions: { class_fees: b } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  readClassFeeContext.mockResolvedValue({ location: { membershipSource: 'glofox' }, settings: { a: 1 }, zone: 'Europe/Dublin' })
})

describe('GET /api/class-fees', () => {
  it('401 signed out (withAuth)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get(`?location_id=${LOC_B}`)).status).toBe(401)
    expect(readClassFeeContext).not.toHaveBeenCalled()
  })

  it('400 on an unknown tab, before the studio check', async () => {
    getCurrentUser.mockResolvedValue(feesAt(true, true))
    expect((await get(`?location_id=${LOC_OTHER}&tab=nope`)).status).toBe(400)
  })

  it('403 for a studio the caller is not in (a query param, so not a 404)', async () => {
    getCurrentUser.mockResolvedValue(feesAt(true, true))
    expect((await get(`?location_id=${LOC_OTHER}`)).status).toBe(403)
    expect(readClassFeeContext).not.toHaveBeenCalled()
  })

  it('403 without class_fees at that studio, though held at the active one', async () => {
    getCurrentUser.mockResolvedValue(feesAt(true, false))
    expect((await get(`?location_id=${LOC_B}`)).status).toBe(403)
    expect(readClassFeeContext).not.toHaveBeenCalled()
  })

  it('reads the named studio\'s fees with class_fees there', async () => {
    getCurrentUser.mockResolvedValue(feesAt(false, true))
    const res = await get(`?location_id=${LOC_B}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { rows: [], settings: { a: 1 }, zone: 'Europe/Dublin', notUn1t: true } })
    expect(readClassFeeContext.mock.calls[0][1]).toBe(LOC_B)
  })
})
