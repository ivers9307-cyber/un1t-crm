// FEES.3 — POST /api/class-fees/[id]/charge-anyway through the real withAuth
// wrapper: the fee id, the body, the body's studio, class_fees there, then the
// write, in that order.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/class-fees-member', () => ({ chargeAppealedFee: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { chargeAppealedFee } = await import('@/lib/class-fees-member')
const { POST } = await import('./route.js')

const FEE = 'fe000000-0000-4000-8000-000000000001'
const charge = (body = { location_id: LOC_A }, id = FEE) => POST(
  new Request(`http://localhost/api/class-fees/${id}/charge-anyway`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
)
const fees = (on) => person({ [LOC_A]: { role: 'manager', permissions: { class_fees: on } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  chargeAppealedFee.mockResolvedValue({ ok: true })
})

describe('POST /api/class-fees/[id]/charge-anyway', () => {
  it('401 signed out, nothing charged', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await charge()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(chargeAppealedFee).not.toHaveBeenCalled()
  })

  it('404 for a malformed fee id before the body is read', async () => {
    getCurrentUser.mockResolvedValue(fees(true))
    expect((await charge({}, 'nope')).status).toBe(404)
    expect(chargeAppealedFee).not.toHaveBeenCalled()
  })

  it('400 without a location_id', async () => {
    getCurrentUser.mockResolvedValue(fees(true))
    expect((await charge({})).status).toBe(400)
  })

  it('403 for a studio outside the caller’s, nothing charged', async () => {
    getCurrentUser.mockResolvedValue(fees(true))
    const res = await charge({ location_id: LOC_B })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden — location not in your assignments' })
    expect(chargeAppealedFee).not.toHaveBeenCalled()
  })

  it('403 "Forbidden" without class_fees there, nothing charged', async () => {
    getCurrentUser.mockResolvedValue(fees(false))
    const res = await charge()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(chargeAppealedFee).not.toHaveBeenCalled()
  })

  it('puts the fee back to pending at the body’s studio', async () => {
    getCurrentUser.mockResolvedValue(fees(true))
    const res = await charge()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: FEE, status: 'pending' } })
    expect(chargeAppealedFee).toHaveBeenCalledWith({ tag: 'db' }, { locationId: LOC_A, feeId: FEE })
  })

  it('404 not found and 409 not appealed, as the writer says', async () => {
    getCurrentUser.mockResolvedValue(fees(true))
    chargeAppealedFee.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect((await charge()).status).toBe(404)
    chargeAppealedFee.mockResolvedValueOnce({ ok: false, reason: 'not_appealed' })
    const res = await charge()
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_appealed')
  })

  it('a failed write is a 500 with a fixed line', async () => {
    getCurrentUser.mockResolvedValue(fees(true))
    chargeAppealedFee.mockRejectedValue(new Error('secret detail'))
    const res = await charge()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not update the fee just now.' })
  })
})
