// POST /api/staff/[id]/send-password-reset through the real withAuth wrapper,
// which only signs the caller in (401 'Unauthorized'; was 'Unauthorised'). The
// admin pre-check (403), the target (404), the shared admin studio (404, never
// 403), the email (400) and active (409) keep their order; one reset email.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/app-url', async (importOriginal) => ({ ...(await importOriginal()), getAppUrl: () => 'https://crm.example.test' }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const STAFF_A = 'cf000000-0000-4000-8000-00000000000a'
const STAFF_B = 'cf000000-0000-4000-8000-00000000000b'
const MANAGER_A = person({ [LOC_A]: { role: 'manager' } }, LOC_A)
const COACH_A = person({ [LOC_A]: { role: 'staff' } }, LOC_A)
const send = (id) => POST(new Request(`http://localhost/api/staff/${id}/send-password-reset`, { method: 'POST' }), { params: Promise.resolve({ id }) })
let db, reset

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    profiles: [
      { id: STAFF_A, email: 'staff.a@example.com', full_name: 'Staff A', active: true },
      { id: STAFF_B, email: 'staff.b@example.com', full_name: 'Staff B', active: true },
    ],
    profile_locations: [{ profile_id: STAFF_A, location_id: LOC_A }, { profile_id: STAFF_B, location_id: LOC_B }],
  } })
  reset = vi.fn(async () => ({ error: null }))
  db.auth = { resetPasswordForEmail: reset }
  createServerClient.mockReturnValue(db)
})

describe('POST /api/staff/[id]/send-password-reset', () => {
  it('401 signed out, nothing sent', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await send(STAFF_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(reset).not.toHaveBeenCalled()
  })

  it('403 "Admin only" for a coach, nothing sent', async () => {
    getCurrentUser.mockResolvedValue(COACH_A)
    const res = await send(STAFF_A)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Admin only' })
    expect(reset).not.toHaveBeenCalled()
  })

  it('404 for a staffer at another studio, nothing sent', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await send(STAFF_B)).status).toBe(404)
    expect(reset).not.toHaveBeenCalled()
  })

  it('a manager at the staffer’s studio sends one reset email', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await send(STAFF_A)).status).toBe(200)
    expect(reset).toHaveBeenCalledTimes(1)
    expect(reset).toHaveBeenCalledWith('staff.a@example.com', { redirectTo: 'https://crm.example.test/reset-password' })
  })

  it('a failed send answers a fixed 502, never the provider text', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    reset.mockResolvedValueOnce({ error: { message: 'Email rate limit exceeded for staff.a@example.com' } })
    const res = await send(STAFF_A)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, error: 'Failed to send the reset email. Try again.' })
  })
})
