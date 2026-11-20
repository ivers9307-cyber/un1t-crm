// POST /api/support-session/switch through the real withAuth wrapper: the real
// master (or a master viewing as someone) only; the switch itself is faked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, MASTER } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/support-session', () => ({ switchSupportMode: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { switchSupportMode } = await import('@/lib/support-session')
const { logAuditEvent } = await import('@/lib/audit')
const { POST } = await import('./route.js')

const post = (body = { mode: 'act_on_behalf' }) => POST(new Request('http://localhost/api/support-session/switch', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))

beforeEach(() => {
  vi.clearAllMocks()
  switchSupportMode.mockResolvedValue({ ok: true, mode: 'act_on_behalf', organizationId: 'org-1' })
})

describe('POST /api/support-session/switch', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(switchSupportMode).not.toHaveBeenCalled()
  })

  it('403 "Master only" for an owner, before the body is read', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await post({ mode: 'nonsense' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
    expect(switchSupportMode).not.toHaveBeenCalled()
  })

  it('a master switches and it is audited against the real master', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { mode: 'act_on_behalf' } })
    expect(switchSupportMode).toHaveBeenCalledWith({ masterUserId: MASTER.id, mode: 'act_on_behalf' })
    expect(logAuditEvent.mock.calls[0][0]).toMatchObject({ action: 'auth.support_session_switch', actor: { id: MASTER.id } })
  })

  it('a master viewing as someone switches as the master', async () => {
    getCurrentUser.mockResolvedValue({ ...person({ [LOC_A]: { role: 'staff' } }, LOC_A), impersonatingFrom: { masterId: 'user-m' } })
    await post()
    expect(switchSupportMode).toHaveBeenCalledWith({ masterUserId: 'user-m', mode: 'act_on_behalf' })
  })

  it('404 with no open session; a failed insert answers a fixed code, not the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    switchSupportMode.mockResolvedValueOnce({ ok: false, error: 'no_active_support_session' })
    expect((await post()).status).toBe(404)
    switchSupportMode.mockResolvedValueOnce({ ok: false, error: 'secret detail' })
    const res = await post()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'insert_failed' })
  })
})
