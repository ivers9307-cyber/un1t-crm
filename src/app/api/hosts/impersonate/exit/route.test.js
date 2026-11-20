// HOST-PORTAL.4 — POST /api/hosts/impersonate/exit through the real withAuth
// wrapper: any signed-in staff session closes its own open log rows and
// clears the un1t_host_impersonate cookie.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

const cookieSet = vi.fn()
vi.mock('next/headers', () => ({ cookies: async () => ({ set: cookieSet }) }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const H1 = 'c0000000-0000-4000-8000-0000000000c1'
const post = () => POST(new Request('http://localhost/api/hosts/impersonate/exit', { method: 'POST' }))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({
    tables: {
      host_impersonation_log: [
        { id: 'a1000000-0000-4000-8000-0000000000a1', admin_user_id: 'user-1', host_id: H1, ended_at: null },
        { id: 'a1000000-0000-4000-8000-0000000000a2', admin_user_id: 'someone-else', host_id: H1, ended_at: null },
      ],
    },
  })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/hosts/impersonate/exit', () => {
  it('401 signed out, nothing closed and no cookie touched', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
    expect(db.tables.host_impersonation_log.every((r) => r.ended_at === null)).toBe(true)
    expect(cookieSet).not.toHaveBeenCalled()
  })

  it('any signed-in staffer (no role floor) closes only their own row and clears the cookie', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    const [mine, theirs] = db.tables.host_impersonation_log
    expect(mine.ended_at).toBeTruthy()
    expect(theirs.ended_at).toBeNull()
    expect(cookieSet).toHaveBeenCalledWith('un1t_host_impersonate', '', { maxAge: 0, path: '/' })
  })
})
