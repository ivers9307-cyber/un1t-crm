// GLOFOX3.6 — GET /api/admin/glofox-push-events through the real withAuth
// wrapper: masters only; failures and needs_review rows not yet reviewed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, MASTER } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const E = (n, status, reviewed_at = null) => ({ id: `e${n}000000-0000-4000-8000-000000000000`, location_id: LOC_A, status, reviewed_at, created_at: `2026-11-0${n}T10:00:00Z` })
const events = () => [E(1, 'failed'), E(2, 'needs_review'), E(3, 'success'), E(4, 'failed', '2026-11-05T00:00:00Z')]
const get = (qs = '') => GET(new Request(`http://localhost/api/admin/glofox-push-events${qs}`))

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { glofox_push_events: events(), contacts: [] } }))
})

describe('GET /api/admin/glofox-push-events', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 "Master only" for an owner', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
  })

  it('a master gets the unreviewed failures and needs_review rows, newest first', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const body = await (await get()).json()
    expect(body.events.map((e) => e.status)).toEqual(['needs_review', 'failed'])
    expect(body.count).toBe(2)
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(createFakeDb({ tables: { glofox_push_events: events() }, errors: { glofox_push_events: { select: { message: 'secret detail' } } } }))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
