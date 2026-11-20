// ROUTEWRAP.R10 — POST /api/support-session/start through the real withAuth
// wrapper: signed out is the wrapper's 401, only a real master starts a
// session (403 'Master only'), a master already in a support session may
// switch, and a failure answers a fixed message.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers({ 'user-agent': 'test' })) }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/support-session', () => ({ startSupportSession: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => {}) }))

const { getCurrentUser } = await import('@/lib/auth')
const { startSupportSession } = await import('@/lib/support-session')
const { logAuditEvent } = await import('@/lib/audit')
const { POST } = await import('./route.js')

const ORG_T = 'e0000000-0000-4000-8000-0000000000e0'
const post = (body = { organization_id: ORG_T, mode: 'read_only' }) => POST(new Request('http://localhost/api/support-session/start', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
const owner = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const master = person({ [LOC_A]: { role: 'owner' } }, LOC_A, { id: 'master-1', isMaster: true, profileRole: 'master' })

beforeEach(() => {
  vi.clearAllMocks()
  startSupportSession.mockResolvedValue({ organizationName: 'Tenant', impersonatedUserId: 'u2', sessionId: 's1', landing: '/portfolio' })
})

describe('POST /api/support-session/start', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Master only" for an owner, before the body is read', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const res = await post({})
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
    expect(startSupportSession).not.toHaveBeenCalled()
  })

  it('a master starts a session, audited', async () => {
    getCurrentUser.mockResolvedValue(master)
    const res = await post()
    expect(res.status).toBe(200)
    expect(startSupportSession).toHaveBeenCalledWith(expect.objectContaining({ masterProfile: { id: 'master-1', role: 'master' }, organizationId: ORG_T, mode: 'read_only' }))
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.support_session_start', actor: { id: 'master-1' } }))
  })

  it('a master inside a support session switches tenants as themselves', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, impersonatingFrom: { masterId: 'master-1' } })
    expect((await post()).status).toBe(200)
    expect(startSupportSession).toHaveBeenCalledWith(expect.objectContaining({ masterProfile: { id: 'master-1', role: 'master' } }))
  })

  it('a failure answers a fixed message, not the error text', async () => {
    getCurrentUser.mockResolvedValue(master)
    startSupportSession.mockRejectedValue(new Error('Failed to open support session: duplicate key xyz'))
    const res = await post()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Failed to start support session' })
  })
})
