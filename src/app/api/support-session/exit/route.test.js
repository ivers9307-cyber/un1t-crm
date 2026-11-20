// POST /api/support-session/exit through the real withAuth wrapper: any signed-in
// session may leave; the stop uses the real master id and the audit row is
// written only when a session closed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/support-session', () => ({ stopSupportSession: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { stopSupportSession } = await import('@/lib/support-session')
const { logAuditEvent } = await import('@/lib/audit')
const { POST } = await import('./route.js')

const post = () => POST(new Request('http://localhost/api/support-session/exit', { method: 'POST' }))

beforeEach(() => {
  vi.clearAllMocks()
  stopSupportSession.mockResolvedValue({ closed: true, organizationId: 'org-a' })
})

describe('POST /api/support-session/exit', () => {
  it('401 signed out, nothing stopped', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(stopSupportSession).not.toHaveBeenCalled()
  })

  it('a master in a session stops it by the real master id and is audited', async () => {
    getCurrentUser.mockResolvedValue({ id: 'owner-x', profileRole: 'owner', impersonatingFrom: { masterId: 'master-1' } })
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(stopSupportSession).toHaveBeenCalledWith({ masterUserId: 'master-1' })
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.support_session_stop', actor: { id: 'master-1' }, target: { resource: 'organizations/org-a' },
    }))
  })

  it('any other session still clears (no role refused) and writes no audit row when nothing closed', async () => {
    stopSupportSession.mockResolvedValue({ closed: false })
    getCurrentUser.mockResolvedValue({ id: 'staff-1', profileRole: 'staff', role: 'staff', impersonatingFrom: null })
    const res = await post()
    expect(res.status).toBe(200)
    expect(stopSupportSession).toHaveBeenCalledWith({ masterUserId: 'staff-1' })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
