// /api/admin/plans through the real withAuth wrapper: signed in (401; it was
// a 403 'Master only' before), profiles.role master (403 'Master only'), then
// the catalogue. Database text never reaches the response.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')

const OWNER = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const MASTER = person({ [LOC_A]: { role: 'owner' } }, LOC_A, { isMaster: true, profileRole: 'master', role: 'master' })
const post = (body) => POST(new Request('http://localhost/api/admin/plans', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { plans: [], plan_versions: [] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/admin/plans', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost/api/admin/plans'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect((await post({ slug: 'a', name: 'A', kind: 'tier' })).status).toBe(401)
  })

  it('403 Master only for a studio owner, nothing written', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await GET(new Request('http://localhost/api/admin/plans'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
    expect((await post({ slug: 'a', name: 'A', kind: 'tier' })).status).toBe(403)
    expect(db.tables.plans).toEqual([])
  })

  it('a master reads the catalogue', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await GET(new Request('http://localhost/api/admin/plans'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: [] })
  })

  it('a failed read or write answers a fixed message, never the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    db.errors.plans = { select: { message: 'relation "plans" is locked' }, insert: { code: '42501', message: 'permission denied for table plans' } }
    const read = await GET(new Request('http://localhost/api/admin/plans'))
    expect(read.status).toBe(500)
    expect(await read.json()).toEqual({ success: false, error: 'Could not load the plans. Try again.' })
    const write = await post({ slug: 'core', name: 'Core', kind: 'tier' })
    expect(write.status).toBe(400)
    expect(await write.json()).toEqual({ success: false, error: 'Could not create the plan. Try again.' })
  })
})
