// POST /api/impersonate through the real withAuth wrapper, which only signs
// the caller in. The rest keeps its order: the REAL master (also while already
// impersonating), body, self, target; startImpersonation is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A } from '../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/audit', async (importOriginal) => ({ ...(await importOriginal()), logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/impersonation', async (importOriginal) => ({ ...(await importOriginal()), startImpersonation: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9', 'user-agent': 'test' }) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { startImpersonation } = await import('@/lib/impersonation')
const { POST } = await import('./route.js')

const TARGET = '7a000000-0000-4000-8000-000000000001'
const post = (body) => POST(new Request('http://localhost/api/impersonate', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
const OWNER = person({ [LOC_A]: { role: 'owner' } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { profiles: [{ id: TARGET, full_name: 'Target', role: 'staff', active: true }] } }))
  startImpersonation.mockResolvedValue({ target: { id: TARGET } })
})

describe('POST /api/impersonate', () => {
  it('401 signed out (withAuth; was "Unauthorised"), nothing started', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post({ target_user_id: TARGET })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(startImpersonation).not.toHaveBeenCalled()
  })

  it('403 "Master only" for an owner, before the body is read', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await post({})
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
  })

  it('400 for the master themselves', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await post({ target_user_id: MASTER.id })).status).toBe(400)
  })

  it('404 for an unknown target', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await post({ target_user_id: '7a000000-0000-4000-8000-000000000009' })).status).toBe(404)
    expect(startImpersonation).not.toHaveBeenCalled()
  })

  it('a master starts it as themselves', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post({ target_user_id: TARGET, reason: 'support' })
    expect(res.status).toBe(200)
    expect(startImpersonation.mock.calls[0][0]).toMatchObject({ masterProfile: { id: MASTER.id, role: 'master' }, targetUserId: TARGET, reason: 'support', ip: '203.0.113.9' })
  })

  it('already impersonating: the REAL master is the one who starts the next', async () => {
    getCurrentUser.mockResolvedValue({ ...OWNER, impersonatingFrom: { masterId: MASTER.id } })
    expect((await post({ target_user_id: TARGET })).status).toBe(200)
    expect(startImpersonation.mock.calls[0][0].masterProfile).toEqual({ id: MASTER.id, role: 'master' })
  })

  it('database text from the start stays in the log; the fixed refusals keep their words', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    startImpersonation.mockRejectedValue(new Error('Failed to start impersonation log: duplicate key value violates "x"'))
    let res = await post({ target_user_id: TARGET })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Impersonation failed' })
    startImpersonation.mockRejectedValue(new Error('Target user not found.'))
    res = await post({ target_user_id: TARGET })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Target user not found.' })
  })
})
