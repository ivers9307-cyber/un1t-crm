// POST /api/mobile/impersonate/stop through the real withAuth wrapper: any
// signed-in caller; only the real master's open rows are stamped, and only a
// session that was really viewing as someone is audited.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, MASTER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { logAuditEvent } = await import('@/lib/audit')
const { POST } = await import('./route.js')

const TARGET = 'a1000000-0000-4000-8000-000000000001'
const OTHER_MASTER = 'a1000000-0000-4000-8000-000000000002'
const L1 = 'a2000000-0000-4000-8000-000000000001'
const L2 = 'a2000000-0000-4000-8000-000000000002'
let db
const post = () => POST(new Request('http://localhost/api/mobile/impersonate/stop', { method: 'POST' }))

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({
    tables: {
      impersonation_log: [
        { id: L1, master_user_id: MASTER.id, target_user_id: TARGET, ended_at: null },
        { id: L2, master_user_id: OTHER_MASTER, target_user_id: TARGET, ended_at: null },
      ],
    },
  })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/mobile/impersonate/stop', () => {
  it('401 signed out, nothing stamped', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
    expect(db.tables.impersonation_log.every((r) => r.ended_at === null)).toBe(true)
  })

  it('a staff caller is a no-op: nothing stamped, nothing audited', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    expect((await post()).status).toBe(200)
    expect(db.tables.impersonation_log.every((r) => r.ended_at === null)).toBe(true)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('a master viewing as someone stamps only their own row and is audited', async () => {
    getCurrentUser.mockResolvedValue({ ...person({ [LOC_A]: { role: 'staff' } }, LOC_A), id: TARGET, impersonatingFrom: { masterId: MASTER.id } })
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(db.tables.impersonation_log.find((r) => r.id === L1).ended_at).toBeTruthy()
    expect(db.tables.impersonation_log.find((r) => r.id === L2).ended_at).toBeNull()
    expect(logAuditEvent.mock.calls[0][0]).toMatchObject({ action: 'auth.impersonate_stop', actor: { id: MASTER.id }, target: { id: TARGET } })
  })
})
