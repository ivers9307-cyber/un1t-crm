// HOST-PORTAL.4 — POST /api/hosts/[id]/impersonate through the real withAuth
// wrapper: ADMIN_ROLES at the active studio, host in the caller's org (404
// otherwise), then the open log row is closed, a new one written and the
// un1t_host_impersonate cookie set.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, ORG } from '../../../../../../tests/helpers/role-sweep-callers.js'

const cookieSet = vi.fn()
vi.mock('next/headers', () => ({ cookies: async () => ({ set: cookieSet }) }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const H1 = 'c0000000-0000-4000-8000-0000000000c1'
const H_OTHER = 'c0000000-0000-4000-8000-0000000000c2'
const OPEN_LOG = 'a1000000-0000-4000-8000-0000000000a1'
const manager = () => person({ [LOC_A]: { role: 'manager' } }, LOC_A)
const post = (id = H1) => POST(
  new Request(`http://localhost/api/hosts/${id}/impersonate`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'test-agent' } }),
  { params: Promise.resolve({ id }) },
)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({
    tables: {
      event_hosts: [
        { id: H1, organization_id: ORG, name: 'Host One' },
        { id: H_OTHER, organization_id: 'f0000000-0000-4000-8000-0000000000f9', name: 'Elsewhere' },
      ],
      host_impersonation_log: [{ id: OPEN_LOG, admin_user_id: 'user-1', host_id: H_OTHER, started_at: '2026-11-20T09:00:00Z', ended_at: null }],
    },
  })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/hosts/[id]/impersonate', () => {
  it('401 signed out, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
    expect(db.tables.host_impersonation_log).toHaveLength(1)
    expect(cookieSet).not.toHaveBeenCalled()
  })

  it('403 "Manager+ required" for staff at the active studio, nothing written', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
    expect(db.tables.host_impersonation_log).toHaveLength(1)
    expect(cookieSet).not.toHaveBeenCalled()
  })

  it('404 for a host in another org, nothing written', async () => {
    getCurrentUser.mockResolvedValue(manager())
    const res = await post(H_OTHER)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
    expect(db.tables.host_impersonation_log[0].ended_at).toBeNull()
    expect(cookieSet).not.toHaveBeenCalled()
  })

  it('a manager starts the session: old log closed, new log row, cookie set', async () => {
    getCurrentUser.mockResolvedValue(manager())
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { hostId: H1 } })
    const [old, fresh] = db.tables.host_impersonation_log
    expect(old.ended_at).toBeTruthy()
    expect(fresh).toMatchObject({ admin_user_id: 'user-1', host_id: H1, organization_id: ORG, ip: '203.0.113.7', user_agent: 'test-agent' })
    expect(cookieSet).toHaveBeenCalledWith('un1t_host_impersonate', H1, expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }))
  })
})
