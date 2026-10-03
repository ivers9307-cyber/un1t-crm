// STAFFDELETE.1 — the bulk twin of /api/admin/assignments. One tombstone in a
// batch must not be given a role, and must not stop the living rows.
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

function makeDb({ tombstones = [GONE], profilesError = null } = {}) {
  return fakeDb((q) => {
    if (q.table === 'profiles') {
      if (profilesError) return { data: null, error: profilesError }
      const ids = q.calls.find(([op, col]) => op === 'in' && col === 'id')?.[2] || []
      return { data: ids.map((id) => ({ id, deleted_at: tombstones.includes(id) ? '2026-09-19T10:00:00Z' : null })), error: null }
    }
    if (q.table === 'profile_locations' && q.action === 'select') return { data: null, error: null }
    if (q.table === 'profile_locations') return { data: { ...q.payload }, error: null }
    if (q.table === 'assignment_change_log') return { data: null, error: null }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
}

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(MASTER) })

describe('POST /api/admin/assignments/bulk — a tombstone cannot be assigned', () => {
  it('upsert: the tombstone pair fails as not found, the living pair is created', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    const res = await POST(req({ action: 'upsert', role: 'owner', pairs: [{ profile_id: GONE, location_id: LOC }, { profile_id: LIVING, location_id: LOC }] }))
    expect(res.status).toBe(200)
    const inserts = queriesOf(db, 'profile_locations', 'insert')
    expect(inserts.map((q) => q.payload.profile_id)).toEqual([LIVING])
    const body = await res.json()
    const results = body.data?.results || body.results
    expect(results.find((r) => r.pair.startsWith(GONE))).toMatchObject({ outcome: 'failed', reason: 'profile_not_found' })
    expect(results.find((r) => r.pair.startsWith(LIVING))).toMatchObject({ outcome: 'created' })
  })
  it('an unreadable profiles list fails closed — nothing written', async () => {
    const db = makeDb({ profilesError: { message: 'down' } }); createServerClient.mockReturnValue(db)
    const res = await POST(req({ action: 'upsert', role: 'owner', pairs: [{ profile_id: LIVING, location_id: LOC }] }))
    expect(res.status).toBe(500)
    expect(queriesOf(db, 'profile_locations', 'insert')).toEqual([])
  })
})
