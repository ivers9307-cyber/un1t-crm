// POST /api/mobile/impersonate through the real withAuth wrapper, which only
// signs the caller in. The rest keeps its order, as on the web route: the REAL
// master (also while already impersonating), body, self, target; the log rows
// and the audit event are unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/audit', async (importOriginal) => ({ ...(await importOriginal()), logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9', 'user-agent': 'test' }) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { logAuditEvent } = await import('@/lib/audit')
const { POST } = await import('./route.js')

const TARGET = '7a000000-0000-4000-8000-000000000001'
const OWNER = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const post = (body) => POST(new Request('http://localhost/api/mobile/impersonate', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    profiles: [{ id: TARGET, full_name: 'Target', role: 'staff', active: true }],
    impersonation_log: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/mobile/impersonate', () => {
  it('401 signed out (withAuth; was "Unauthorised"), nothing logged', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post({ target_user_id: TARGET })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.impersonation_log).toEqual([])
  })

  it('403 "Master only" for an owner, before the body is read', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await post({})
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
    expect(db.tables.impersonation_log).toEqual([])
  })

  it('400 for the master themselves, 404 for an unknown target', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await post({ target_user_id: MASTER.id })).status).toBe(400)
    expect((await post({ target_user_id: '7a000000-0000-4000-8000-000000000009' })).status).toBe(404)
    expect(db.tables.impersonation_log).toEqual([])
  })

  it('a master starts it: one open log row in their name, and the audit event', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post({ target_user_id: TARGET, reason: 'support' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, targetUserId: TARGET, targetName: 'Target', targetRole: 'staff' })
    expect(db.tables.impersonation_log).toHaveLength(1)
    expect(db.tables.impersonation_log[0]).toMatchObject({ master_user_id: MASTER.id, target_user_id: TARGET, ip: '203.0.113.9', reason: 'support' })
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
  })

  it('already impersonating: the REAL master is the one recorded', async () => {
    getCurrentUser.mockResolvedValue({ ...OWNER, impersonatingFrom: { masterId: MASTER.id } })
    expect((await post({ target_user_id: TARGET })).status).toBe(200)
    expect(db.tables.impersonation_log[0].master_user_id).toBe(MASTER.id)
  })

  it('a failed log insert answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    db.errors.impersonation_log = { insert: { message: 'insert or update on table "impersonation_log" violates foreign key constraint' } }
    const res = await post({ target_user_id: TARGET })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Impersonation failed' })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
