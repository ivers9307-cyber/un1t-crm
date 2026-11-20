// POST /api/live/sessions/[id]/end through the real withAuth wrapper
// (ROUTEWRAP.R6): the coach pre-check (403), then the session's studio, role
// and studio_management there (404), as before.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/live-class', async (importOriginal) => ({ ...(await importOriginal()), endSession: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { endSession } = await import('@/lib/live-class')
const { POST } = await import('./route.js')

const S_A = 'e0000000-0000-4000-8000-00000000000a'
const S_B = 'e0000000-0000-4000-8000-00000000000b'
const end = (id = S_A) => POST(new Request(`http://localhost/api/live/sessions/${id}/end`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const at = (role) => person({ [LOC_A]: { role, permissions: { studio_management: true } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { heart_rate_sessions: [
    { id: S_A, location_id: LOC_A },
    { id: S_B, location_id: LOC_B },
  ] } }))
  endSession.mockResolvedValue({ ok: true, summary: { avg_bpm: 120 } })
})

describe('POST /api/live/sessions/[id]/end', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await end()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(endSession).not.toHaveBeenCalled()
  })

  it('403 "Coach only" for staff, before any lookup', async () => {
    getCurrentUser.mockResolvedValue(at('staff'))
    const res = await end()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Coach only')
  })

  it("404 for a session at another studio; nothing ended", async () => {
    getCurrentUser.mockResolvedValue(at('head_coach'))
    expect((await end(S_B)).status).toBe(404)
    expect(endSession).not.toHaveBeenCalled()
  })

  it('a head coach ends a session at their studio', async () => {
    getCurrentUser.mockResolvedValue(at('head_coach'))
    const res = await end()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, summary: { avg_bpm: 120 }, alreadyEnded: false })
    expect(endSession).toHaveBeenCalledWith(expect.anything(), S_A)
  })

  it('a failed end is a 400 with a fixed message', async () => {
    getCurrentUser.mockResolvedValue(at('owner'))
    endSession.mockResolvedValue({ ok: false, error: 'sample load: relation "hr_samples" timeout' })
    const res = await end()
    expect(res.status).toBe(400)
    expect((await res.json()).error).not.toMatch(/hr_samples/)
  })
})
