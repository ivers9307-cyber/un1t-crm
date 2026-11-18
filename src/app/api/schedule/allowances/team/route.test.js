// LEAVEBAL.1 — GET /api/schedule/allowances/team: a manager-tier role AT the
// active studio reads every active, non-deleted member of staff THERE (never
// another studio's), with holiday days and lieu hours; a part that cannot be
// read is null and named, never 0.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, getCurrentUser: vi.fn() }
})

import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')

const LOC = '22222222-2222-4222-8222-222222222222'
const LOC2 = '33333333-3333-4333-8333-333333333333'

const at = (role, locs = [LOC]) => ({
  id: `u-${role}`, role, profileRole: role === 'master' ? 'master' : 'staff',
  locations: locs.map((id) => ({ id, timezone: 'Europe/Dublin' })),
  rolesByLocation: role === 'master' ? {} : Object.fromEntries(locs.map((id) => [id, role])),
  activeLocation: { id: locs[0], timezone: 'Europe/Dublin' },
})

const TABLES = {
  profile_locations: [
    { profile_id: 'ann', location_id: LOC },
    { profile_id: 'bob', location_id: LOC },
    { profile_id: 'cat', location_id: LOC },
    { profile_id: 'gone', location_id: LOC },
    { profile_id: 'off', location_id: LOC },
    { profile_id: 'zed', location_id: LOC2 },   // another studio
  ],
  profiles: [
    { id: 'ann', full_name: 'Ann Coach', employment_type: 'fte', active: true, deleted_at: null },
    { id: 'bob', full_name: 'Bob Coach', employment_type: 'fte', active: true, deleted_at: null },
    { id: 'cat', full_name: 'Cat Contractor', employment_type: 'contractor', active: true, deleted_at: null },
    { id: 'gone', full_name: 'Gone Coach', employment_type: 'fte', active: false, deleted_at: '2026-05-01T00:00:00Z' },
    { id: 'off', full_name: 'Off Coach', employment_type: 'fte', active: false, deleted_at: null },
    { id: 'zed', full_name: 'Zed Elsewhere', employment_type: 'fte', active: true, deleted_at: null },
  ],
  staff_allowances: [
    { profile_id: 'ann', year: 2026, total_days: 22, used_days: 5, carried_over: 2 },
    { profile_id: 'ann', year: 2025, total_days: 20, used_days: 20, carried_over: 0 },
    { profile_id: 'zed', year: 2026, total_days: 30, used_days: 0, carried_over: 0 },
  ],
  profile_compensation: [
    { profile_id: 'bob', annual_leave_entitlement: 25 },
  ],
  time_off_requests: [
    { id: 't1', profile_id: 'ann', type: 'holiday', status: 'pending', start_date: '2026-08-03', total_days: 3 },
    { id: 't2', profile_id: 'ann', type: 'holiday', status: 'approved', start_date: '2026-07-01', total_days: 5 },
    { id: 't3', profile_id: 'bob', type: 'sick', status: 'pending', start_date: '2026-08-03', total_days: 2 },
  ],
  staff_lieu_credits: [
    { id: 'l1', profile_id: 'ann', source: 'sunday_worked', credit_date: '2026-06-07', hours: '10.67' },
    { id: 'l2', profile_id: 'ann', source: 'taken', credit_date: '2026-07-01', hours: '-4' },
    { id: 'l3', profile_id: 'bob', source: 'manual', credit_date: '2025-12-28', hours: '8' },   // last year
  ],
}

// FAKEDB.1 — the shared fake, checked against the real schema.
const buildDb = ({ fail = {} } = {}) => createFakeDb({
  tables: TABLES,
  errors: Object.fromEntries(Object.keys(fail).map((t) => [t, { select: { message: `${t} down` } }])),
})

const req = (qs = '') => new Request(`http://x/api/schedule/allowances/team${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/schedule/allowances/team', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req())).status).toBe(401)
  })

  it('403 for plain staff at the active studio', async () => {
    getCurrentUser.mockResolvedValue(at('staff'))
    createServerClient.mockReturnValue(buildDb())
    expect((await GET(req())).status).toBe(403)
  })

  it('403 for a manager elsewhere who is only staff at the active studio', async () => {
    const u = at('staff', [LOC, LOC2])
    u.rolesByLocation = { [LOC]: 'staff', [LOC2]: 'manager' }
    getCurrentUser.mockResolvedValue(u)
    createServerClient.mockReturnValue(buildDb())
    expect((await GET(req())).status).toBe(403)
  })

  it('400 on a malformed year', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    createServerClient.mockReturnValue(buildDb())
    expect((await GET(req('?year=abc'))).status).toBe(400)
  })

  it('lists only active, non-deleted staff at the ACTIVE studio, with days and hours', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    const db = buildDb()
    createServerClient.mockReturnValue(db)
    const json = await (await GET(req('?year=2026'))).json()
    expect(json.success).toBe(true)
    expect(json.data).toMatchObject({ location_id: LOC, year: 2026, can_edit_allowance: true, can_record_lieu: true, unreadable: [] })
    const names = json.data.rows.map((r) => r.full_name)
    expect(names).toEqual(['Ann Coach', 'Bob Coach', 'Cat Contractor'])
    expect(names).not.toContain('Zed Elsewhere')
    // The foreign studio's person is never even asked about.
    for (const f of db.calls.flatMap((c) => c.filters || []).filter((x) => x.op === 'in')) expect(f.value).not.toContain('zed')

    const [ann, bob, cat] = json.data.rows
    expect(ann.holiday).toEqual({ stored: true, total_days: 22, carried_over: 2, used_days: 5, remaining: 19 })
    expect(ann.pending_days).toBe(3)
    expect(ann.lieu).toEqual({ credited_hours: 10.67, taken_hours: 4, balance_hours: 6.67 })
    // No allowance row yet: the contract entitlement, as the per-person GET.
    expect(bob.holiday).toEqual({ stored: false, total_days: 25, carried_over: 0, used_days: 0, remaining: 25 })
    expect(bob.pending_days).toBe(0)
    expect(bob.lieu.balance_hours).toBe(0)   // last year's credit is not this year's
    expect(cat).toMatchObject({ not_applicable: true, holiday: null, pending_days: null, lieu: null })
  })

  it('a head coach reads balances but cannot record lieu', async () => {
    getCurrentUser.mockResolvedValue(at('head_coach'))
    createServerClient.mockReturnValue(buildDb())
    const json = await (await GET(req('?year=2026'))).json()
    expect(json.data.can_record_lieu).toBe(false)
    expect(json.data.rows).toHaveLength(3)
  })

  it('an unreadable lieu ledger is unknown (null), never 0, and the rest still loads', async () => {
    getCurrentUser.mockResolvedValue(at('owner'))
    createServerClient.mockReturnValue(buildDb({ fail: { staff_lieu_credits: true } }))
    const json = await (await GET(req('?year=2026'))).json()
    expect(json.success).toBe(true)
    expect(json.data.unreadable).toEqual(['lieu'])
    const ann = json.data.rows.find((r) => r.profile_id === 'ann')
    expect(ann.lieu).toBeNull()
    expect(ann.holiday.remaining).toBe(19)
  })

  it('an unreadable allowance table makes holiday unknown for everyone', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    createServerClient.mockReturnValue(buildDb({ fail: { staff_allowances: true } }))
    const json = await (await GET(req('?year=2026'))).json()
    expect(json.data.unreadable).toEqual(['allowances'])
    for (const r of json.data.rows.filter((x) => !x.not_applicable)) expect(r.holiday).toBeNull()
  })

  it('500 when the staff list itself cannot be read', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    createServerClient.mockReturnValue(buildDb({ fail: { profile_locations: true } }))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
