// STAFFDELETE.1 — /api/admin/assignments writes profile_locations by profile
// id. A permanently deleted staff member keeps a profiles row (a tombstone);
// it must never be given a studio role again. (mig 622 makes the database
// refuse it too; this pins the route's own answer: 404, nothing written.)
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')
const { POST } = await import('./route.js')

const LIVING = '10000000-0000-0000-0000-000000000002'
const GONE = '10000000-0000-0000-0000-000000000001'
const LOC = 'a0000000-0000-0000-0000-00000000000a'
const MASTER = { id: 'master-1', profileRole: 'master' }

const req = (body) => new Request('http://test/api/admin/assignments', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

function makeDb({ profile, existing = null }) {
  return fakeDb((q) => {
    if (q.table === 'profiles') return { data: profile, error: null }
    if (q.table === 'profile_locations' && q.action === 'select') return { data: existing, error: null }
    if (q.table === 'profile_locations') return { data: { profile_id: q.payload?.profile_id ?? LIVING, location_id: LOC, role: q.payload?.role }, error: null }
    if (q.table === 'assignment_change_log') return { data: null, error: null }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
}

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(MASTER) })

describe('POST /api/admin/assignments — a tombstone cannot be assigned', () => {
  it('create → 404, nothing inserted', async () => {
    const db = makeDb({ profile: { id: GONE, deleted_at: '2026-09-19T10:00:00Z' } }); createServerClient.mockReturnValue(db)
    const res = await POST(req({ action: 'create', profile_id: GONE, location_id: LOC, role: 'owner' }))
    expect(res.status).toBe(404)
    expect(queriesOf(db, 'profile_locations', 'insert')).toEqual([])
  })
  it('update → 404, nothing updated', async () => {
    const db = makeDb({ profile: { id: GONE, deleted_at: '2026-09-19T10:00:00Z' }, existing: { profile_id: GONE, location_id: LOC, role: 'staff' } }); createServerClient.mockReturnValue(db)
    const res = await POST(req({ action: 'update', profile_id: GONE, location_id: LOC, role: 'owner' }))
    expect(res.status).toBe(404)
    expect(queriesOf(db, 'profile_locations', 'update')).toEqual([])
  })
  it('control: a living profile is still created', async () => {
    const db = makeDb({ profile: { id: LIVING, deleted_at: null } }); createServerClient.mockReturnValue(db)
    const res = await POST(req({ action: 'create', profile_id: LIVING, location_id: LOC, role: 'staff' }))
    expect(res.status).toBe(200)
    expect(queriesOf(db, 'profile_locations', 'insert')).toHaveLength(1)
  })
  it('an unreadable profile fails closed — nothing written', async () => {
    const db = fakeDb((q) => (q.table === 'profiles' ? { data: null, error: { message: 'down' } } : { data: null, error: null })); createServerClient.mockReturnValue(db)
    const res = await POST(req({ action: 'create', profile_id: LIVING, location_id: LOC, role: 'staff' }))
    expect(res.status).toBe(500)
    expect(queriesOf(db, 'profile_locations', 'insert')).toEqual([])
  })
})
