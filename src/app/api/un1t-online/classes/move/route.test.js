// POST /api/un1t-online/classes/move through the real withAuth wrapper: a
// signed-out call is withAuth's 401 (it said 'Unauthorised' before) and a
// studio that is not the caller's is refused by the staff gate, with nothing
// sent to un1t.online either way. The full flow is in ../routes.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/un1t-online-write-ops', async (importOriginal) => ({ ...(await importOriginal()), moveBooking: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { moveBooking } = await import('@/lib/un1t-online-write-ops')
const { POST } = await import('./route.js')

const STAFF_A = person({ [LOC_A]: { role: 'staff' } }, LOC_A)
const BODY = { contact_id: 'c0000000-0000-4000-8000-000000000001', location_id: LOC_B, booking_id: 'bk-1', event_id: 'ev-2' }
const move = (body = BODY) => POST(new Request('http://localhost/api/un1t-online/classes/move', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb())
})

describe('POST /api/un1t-online/classes/move gate', () => {
  it('401 signed out, nothing moved', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await move()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(moveBooking).not.toHaveBeenCalled()
  })

  it('refuses a studio that is not the caller’s, nothing moved', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    const res = await move()
    expect(res.status).toBe(403)
    expect(moveBooking).not.toHaveBeenCalled()
  })
})
