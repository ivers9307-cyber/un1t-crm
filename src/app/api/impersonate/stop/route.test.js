// POST /api/impersonate/stop through the real withAuth wrapper: any signed-in
// session may clear its cookie; the audit row is written only for a real
// impersonation session, keyed on the master behind it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/impersonation', () => ({ stopImpersonation: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { stopImpersonation } = await import('@/lib/impersonation')
const { logAuditEvent } = await import('@/lib/audit')
const { POST } = await import('./route.js')

const post = () => POST(new Request('http://localhost/api/impersonate/stop', { method: 'POST' }))

beforeEach(() => vi.clearAllMocks())

describe('POST /api/impersonate/stop', () => {
  it('401 signed out, nothing stopped', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(stopImpersonation).not.toHaveBeenCalled()
  })

  it('an impersonating master stops by the real master id and the target is audited', async () => {
    getCurrentUser.mockResolvedValue({ id: 'target-1', profileRole: 'staff', impersonatingFrom: { masterId: 'master-1' } })
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(stopImpersonation).toHaveBeenCalledWith({ masterUserId: 'master-1' })
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.impersonate_stop', actor: { id: 'master-1' }, target: { id: 'target-1', resource: 'profiles/target-1' },
    }))
  })

  it('a session that is not impersonating still clears (no role refused), with no audit row', async () => {
    getCurrentUser.mockResolvedValue({ id: 'staff-1', profileRole: 'staff', role: 'staff', impersonatingFrom: null })
    const res = await post()
    expect(res.status).toBe(200)
    expect(stopImpersonation).toHaveBeenCalledWith({ masterUserId: 'staff-1' })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
