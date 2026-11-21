// POST /api/admin/achievements/test through the real withAuth wrapper: signed
// out is its 401 (was a 403 { ok: false }); a non-master keeps this route's
// own 403 body; the preview never writes.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const CONTACT = 'c1000000-0000-4000-8000-000000000001'
const OWNER = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const post = (body = { contact_id: CONTACT }) => POST(new Request('http://localhost/api/admin/achievements/test', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { heart_rate_sessions: [], achievement_rules: [], contact_achievements: [] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/admin/achievements/test', () => {
  it('401 signed out (withAuth; was a 403)', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 { ok: false } for an owner, before the body is read', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await post({})
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Forbidden' })
    expect(db.calls).toEqual([])
  })

  it('a master previews a contact with no sessions', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, fired: [], reason: 'no sessions in window' })
  })

  it('a failed history read answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    db.errors.heart_rate_sessions = { select: { message: 'canceling statement due to statement timeout' } }
    const res = await post()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'Could not read the session history. Try again.' })
  })
})
