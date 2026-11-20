// UN1TWRITE.14 — POST /api/un1t-online/classes/book through the real withAuth
// wrapper: sign-in, then the body and gateUn1tStaffBooking, unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/un1t-staff-booking', async (importOriginal) => ({ ...(await importOriginal()), gateUn1tStaffBooking: vi.fn() }))
vi.mock('@/lib/un1t-online-write-ops', () => ({ book: vi.fn() }))
vi.mock('@/lib/book-chat-copy', () => ({ readBookChatTemplate: vi.fn(async () => ({ template: 'Booked!' })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { gateUn1tStaffBooking } = await import('@/lib/un1t-staff-booking')
const { book } = await import('@/lib/un1t-online-write-ops')
const { POST } = await import('./route.js')

const CONTACT = 'c0000000-0000-4000-8000-000000000001'
const good = { contact_id: CONTACT, location_id: LOC_A, event_id: 'ev_1' }
const post = (b = good) => POST(new Request('http://localhost/api/un1t-online/classes/book', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
  gateUn1tStaffBooking.mockResolvedValue({ ok: true, un1tUserId: 'u1t-1' })
})

describe('POST /api/un1t-online/classes/book', () => {
  it('401 signed out, nothing gated or written', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(gateUn1tStaffBooking).not.toHaveBeenCalled()
    expect(book).not.toHaveBeenCalled()
  })

  it('400 on a bad body before the gate', async () => {
    expect((await post({ ...good, event_id: '' })).status).toBe(400)
    expect(gateUn1tStaffBooking).not.toHaveBeenCalled()
  })

  it("the gate's refusal (another studio) is answered as it says, nothing written", async () => {
    gateUn1tStaffBooking.mockResolvedValue({ ok: false, status: 403, error: 'You do not have access to this studio.' })
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'You do not have access to this studio.' })
    expect(book).not.toHaveBeenCalled()
  })

  it('books as the signed-in member of staff at the body’s studio', async () => {
    book.mockResolvedValue({ verdict: 'done', id: 'b1', ledgerId: 'l1' })
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ un1t_booking_id: 'b1', chat_template: 'Booked!' })
    expect(gateUn1tStaffBooking).toHaveBeenCalledWith({ tag: 'db' }, expect.objectContaining({ id: 'user-1' }), { locationId: LOC_A, contactId: CONTACT })
    expect(book).toHaveBeenCalledWith({ tag: 'db' }, {
      locationId: LOC_A, contactId: CONTACT, un1tUserId: 'u1t-1', eventId: 'ev_1', origin: 'staff', actor: { id: 'user-1' },
    })
  })
})
