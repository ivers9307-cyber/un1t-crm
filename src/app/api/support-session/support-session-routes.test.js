// SUPPORT-ACCESS (Repset Phase 3) — start / switch / exit are MASTER-ONLY.
// A non-master (incl. an owner) can never open, switch, or be in a support
// session. Mocks the auth + lib layers to isolate the route gate.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getCurrentUser = vi.fn()
vi.mock('@/lib/auth', () => ({ getCurrentUser: () => getCurrentUser() }))

const startSupportSession = vi.fn()
const switchSupportMode = vi.fn()
const stopSupportSession = vi.fn()
vi.mock('@/lib/support-session', () => ({
  startSupportSession: (...a) => startSupportSession(...a),
  switchSupportMode: (...a) => switchSupportMode(...a),
  stopSupportSession: (...a) => stopSupportSession(...a),
}))

vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/validate', () => ({
  validateBody: async (req) => ({ ok: true, data: await req.json() }),
}))

import { POST as startPOST } from './start/route.js'
import { POST as switchPOST } from './switch/route.js'
import { POST as exitPOST } from './exit/route.js'

const req = (body = {}) => ({
  headers: new Headers(),
  json: async () => body,
})

beforeEach(() => {
  vi.clearAllMocks()
  startSupportSession.mockResolvedValue({
    sessionId: 's1', organizationId: 'org-a', organizationName: 'Org A', mode: 'read_only', impersonatedUserId: 'o1', landing: '/portfolio',
  })
  switchSupportMode.mockResolvedValue({ ok: true, mode: 'act_on_behalf', organizationId: 'org-a' })
  stopSupportSession.mockResolvedValue({ closed: true, organizationId: 'org-a' })
})

describe('start — master only', () => {
  it('non-master (owner) → 403, never opens a session', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'owner', impersonatingFrom: null })
    const res = await startPOST(req({ organization_id: 'org-a', mode: 'read_only' }))
    expect(res.status).toBe(403)
    expect(startSupportSession).not.toHaveBeenCalled()
  })

  it('unauthenticated → 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await startPOST(req({ organization_id: 'org-a', mode: 'read_only' }))
    expect(res.status).toBe(401)
  })

  it('master → opens the session (real master id passed through)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'master-1', profileRole: 'master', impersonatingFrom: null })
    const res = await startPOST(req({ organization_id: 'org-a', mode: 'act_on_behalf' }))
    expect(res.status).toBe(200)
    expect(startSupportSession).toHaveBeenCalledWith(
      expect.objectContaining({ masterProfile: { id: 'master-1', role: 'master' }, organizationId: 'org-a', mode: 'act_on_behalf' })
    )
  })

  it('master already in a session (impersonating) → uses impersonatingFrom.masterId', async () => {
    getCurrentUser.mockResolvedValue({ id: 'owner-x', profileRole: 'owner', impersonatingFrom: { masterId: 'master-1' } })
    const res = await startPOST(req({ organization_id: 'org-b', mode: 'read_only' }))
    expect(res.status).toBe(200)
    expect(startSupportSession).toHaveBeenCalledWith(
      expect.objectContaining({ masterProfile: { id: 'master-1', role: 'master' } })
    )
  })
})

describe('switch — master only', () => {
  it('non-master → 403', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'staff', impersonatingFrom: null })
    const res = await switchPOST(req({ mode: 'act_on_behalf' }))
    expect(res.status).toBe(403)
    expect(switchSupportMode).not.toHaveBeenCalled()
  })

  it('master → switches', async () => {
    getCurrentUser.mockResolvedValue({ id: 'master-1', profileRole: 'master', impersonatingFrom: null })
    const res = await switchPOST(req({ mode: 'act_on_behalf' }))
    expect(res.status).toBe(200)
    expect(switchSupportMode).toHaveBeenCalledWith({ masterUserId: 'master-1', mode: 'act_on_behalf' })
  })
})

describe('exit — always clears (defensive), audited only when a session closed', () => {
  it('unauthenticated → 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await exitPOST(req())
    expect(res.status).toBe(401)
  })

  it('master in a session → stops it via the real master id', async () => {
    getCurrentUser.mockResolvedValue({ id: 'owner-x', impersonatingFrom: { masterId: 'master-1' } })
    const res = await exitPOST(req())
    expect(res.status).toBe(200)
    expect(stopSupportSession).toHaveBeenCalledWith({ masterUserId: 'master-1' })
  })
})
