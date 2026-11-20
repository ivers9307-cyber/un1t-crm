// UN1TWRITE.14 — POST /api/un1t-online/classes/cancel through the real
// withAuth wrapper: sign-in, then the body, the gate and the mirrored booking.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/un1t-staff-booking', async (importOriginal) => ({ ...(await importOriginal()), gateUn1tStaffBooking: vi.fn() }))
const cancel = vi.fn()
vi.mock('@/lib/booking-ops', () => ({ bookingOpsFor: () => ({ cancel }) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { gateUn1tStaffBooking } = await import('@/lib/un1t-staff-booking')
const { POST } = await import('./route.js')

const CONTACT = 'c0000000-0000-4000-8000-000000000001'
const good = { contact_id: CONTACT, location_id: LOC_A, booking_id: 'bk_1' }
const post = (b = good) => POST(new Request('http://localhost/api/un1t-online/classes/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { un1t_bookings: [
    { un1t_id: 'bk_1', location_id: LOC_A, un1t_user_id: 'u1t-1' },
    { un1t_id: 'bk_2', location_id: LOC_B, un1t_user_id: 'u1t-1' },
  ] } })
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
  gateUn1tStaffBooking.mockResolvedValue({ ok: true, un1tUserId: 'u1t-1' })
  cancel.mockResolvedValue({ verdict: 'done', id: 'bk_1', ledgerId: 'l1' })
})

describe('POST /api/un1t-online/classes/cancel', () => {
  it('401 signed out, nothing gated or written', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(gateUn1tStaffBooking).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it("the gate's refusal is answered as it says, nothing written", async () => {
    gateUn1tStaffBooking.mockResolvedValue({ ok: false, status: 403, error: 'You do not have access to this studio.' })
    expect((await post()).status).toBe(403)
    expect(cancel).not.toHaveBeenCalled()
  })

  it("404 for a booking at another studio, nothing written", async () => {
    const res = await post({ ...good, booking_id: 'bk_2' })
    expect(res.status).toBe(404)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancels as the signed-in member of staff', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(cancel).toHaveBeenCalledWith({ db }, {
      locationId: LOC_A, contactId: CONTACT, un1tUserId: 'u1t-1', bookingId: 'bk_1', origin: 'staff', actor: { id: 'user-1' },
    })
  })
})
