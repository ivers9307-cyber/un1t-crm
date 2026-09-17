// COACHSCOPE.1 — what GET /api/schedule/swaps shows a coach.
//
// The list used to return EVERY swap at the studio to anyone there: who is
// swapping with whom, their reasons, a colleague's shift notes, the manager's
// review notes. A caller now gets a location's whole list only where they
// review swaps (manager role there, or approvals_shift_swaps for it). Everyone
// else gets what the coach swap UIs render — their own swaps and the open pool.
//
// @/lib/permissions and @shared/permissions stay REAL, so the reviewer test
// runs through the same resolver PUT /swaps/[id] approves with.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn((u) => (u?.locations || []).map((l) => l.id)),
  hasRoleAtLocation: (user, loc, roles) => {
    if (!user || !loc) return false
    if (user.profileRole === 'master') return true
    const role = user.rolesByLocation?.[loc]
    return !!role && roles.includes(role)
  },
}))
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn(), notifyUsersAtRolesOnce: vi.fn() }))
vi.mock('@/lib/push', () => ({ resolveRoleRecipientIds: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')

const LOC = 'loc-a'
const LOC_B = 'loc-b'

const shiftEmbed = (id, profileId, notes) => ({
  id, profile_id: profileId, status: 'scheduled', notes,
  start_time_override: null, end_time_override: null,
  shift_blocks: { block_date: '2026-09-30', start_time: '06:00:00', end_time: '10:00:00', shift_templates: { name: 'Morning', start_time: '06:00:00', end_time: '10:00:00', role_label: 'Coach' } },
  profiles: { id: profileId, full_name: `Name ${profileId}` },
})

const ROWS = [
  // mine, requested
  { id: 's-mine', location_id: LOC, requester_id: 'me', target_id: null, status: 'pending', reason: 'wedding', review_note: null,
    requester_shift: shiftEmbed('a-me', 'me', 'my note'), target_shift: null },
  // offered to me by a colleague (reciprocal)
  { id: 's-offered', location_id: LOC, requester_id: 'sam', target_id: 'me', status: 'pending', reason: 'childcare', review_note: null,
    requester_shift: shiftEmbed('a-sam', 'sam', 'sam physio note'), target_shift: shiftEmbed('a-me2', 'me', 'my other note') },
  // open pool from a colleague — claimable
  { id: 's-open', location_id: LOC, requester_id: 'kim', target_id: null, status: 'pending', reason: 'hospital appointment', review_note: null,
    requester_shift: shiftEmbed('a-kim', 'kim', 'kim note'), target_shift: null },
  // two colleagues between themselves — none of my business
  { id: 's-others', location_id: LOC, requester_id: 'kim', target_id: 'sam', status: 'awaiting_approval', reason: 'x', review_note: 'y',
    requester_shift: shiftEmbed('a-kim2', 'kim', 'n'), target_shift: shiftEmbed('a-sam2', 'sam', 'n') },
  // someone else's rejected open swap — not open any more
  { id: 's-closed', location_id: LOC, requester_id: 'kim', target_id: null, status: 'rejected', reason: 'x', review_note: 'no cover',
    requester_shift: null, target_shift: null },
]

function listDb(rows) {
  const calls = []
  const chain = {}
  for (const op of ['select', 'order', 'eq', 'in', 'is', 'neq', 'or']) {
    chain[op] = (...args) => { calls.push([op, ...args]); return chain }
  }
  chain.then = (onF, onR) => Promise.resolve({ data: rows, error: null }).then(onF, onR)
  return { calls, db: { from: () => chain } }
}

const get = (qs = `location_id=${LOC}`) => GET({ url: `https://x.test/api/schedule/swaps?${qs}` })

const staffUser = (extra = {}) => ({
  id: 'me', role: 'staff', profileRole: 'staff',
  rolesByLocation: { [LOC]: 'staff' },
  locations: [{ id: LOC, role: 'staff' }],
  assignmentsByLocation: { [LOC]: { role: 'staff', permissions: {} } },
  ...extra,
})

beforeEach(() => { createServerClient.mockReset(); getCurrentUser.mockReset() })

describe('GET /api/schedule/swaps — coach', () => {
  it('gets only their own swaps and the open pool, and the query says so', async () => {
    getCurrentUser.mockResolvedValue(staffUser())
    const { db, calls } = listDb(ROWS)
    createServerClient.mockReturnValue(db)
    const body = await (await get()).json()
    expect(body.data.map((r) => r.id)).toEqual(['s-mine', 's-offered', 's-open'])
    const or = calls.find((c) => c[0] === 'or')
    expect(or?.[1]).toBe('requester_id.eq.me,target_id.eq.me,and(target_id.is.null,status.eq.pending)')
  })

  it('keeps names, shift and own notes; drops a colleague\'s notes and a stranger\'s reason', async () => {
    getCurrentUser.mockResolvedValue(staffUser())
    createServerClient.mockReturnValue(listDb(ROWS).db)
    const byId = Object.fromEntries((await (await get()).json()).data.map((r) => [r.id, r]))

    expect(byId['s-mine'].reason).toBe('wedding')
    expect(byId['s-mine'].requester_shift.notes).toBe('my note')

    expect(byId['s-offered'].reason).toBe('childcare')
    expect(byId['s-offered'].requester_shift.notes).toBeNull()
    expect(byId['s-offered'].requester_shift.profiles.full_name).toBe('Name sam')
    expect(byId['s-offered'].target_shift.notes).toBe('my other note')

    expect(byId['s-open'].reason).toBeNull()
    expect(byId['s-open'].requester_shift.notes).toBeNull()
    expect(byId['s-open'].requester_shift.shift_templates.name).toBe('Morning')
    expect(byId['s-open'].requester_shift.shift_date).toBe('2026-09-30')
  })

  it('for_me / open still narrow as before on top of the scope', async () => {
    getCurrentUser.mockResolvedValue(staffUser())
    const { db, calls } = listDb([])
    createServerClient.mockReturnValue(db)
    await get(`location_id=${LOC}&open=1`)
    expect(calls).toContainEqual(['is', 'target_id', null])
    expect(calls).toContainEqual(['neq', 'requester_id', 'me'])
    expect(calls.some((c) => c[0] === 'or')).toBe(true)
  })

  it('a head coach elsewhere who is staff HERE is a coach here', async () => {
    getCurrentUser.mockResolvedValue(staffUser({
      role: 'head_coach', profileRole: 'head_coach',
      rolesByLocation: { [LOC]: 'staff', [LOC_B]: 'head_coach' },
      locations: [{ id: LOC, role: 'staff' }, { id: LOC_B, role: 'head_coach' }],
      assignmentsByLocation: { [LOC]: { role: 'staff', permissions: {} }, [LOC_B]: { role: 'head_coach', permissions: {} } },
    }))
    createServerClient.mockReturnValue(listDb(ROWS).db)
    const body = await (await get()).json()
    expect(body.data.map((r) => r.id)).toEqual(['s-mine', 's-offered', 's-open'])
  })
})

describe('GET /api/schedule/swaps — reviewers', () => {
  it('a head coach at the location gets every row, untouched, with no scope filter', async () => {
    getCurrentUser.mockResolvedValue(staffUser({
      role: 'head_coach', profileRole: 'head_coach', rolesByLocation: { [LOC]: 'head_coach' },
      locations: [{ id: LOC, role: 'head_coach' }], assignmentsByLocation: { [LOC]: { role: 'head_coach', permissions: {} } },
    }))
    const { db, calls } = listDb(ROWS)
    createServerClient.mockReturnValue(db)
    const body = await (await get()).json()
    expect(body.data.map((r) => r.id)).toEqual(ROWS.map((r) => r.id))
    expect(body.data.find((r) => r.id === 's-others').review_note).toBe('y')
    expect(calls.some((c) => c[0] === 'or')).toBe(false)
  })

  it('a staff member granted approvals_shift_swaps at the location reviews there too', async () => {
    getCurrentUser.mockResolvedValue(staffUser({
      assignmentsByLocation: { [LOC]: { role: 'staff', permissions: { approvals_shift_swaps: true } } },
    }))
    createServerClient.mockReturnValue(listDb(ROWS).db)
    const body = await (await get()).json()
    expect(body.data).toHaveLength(ROWS.length)
  })

  it('no location_id: full rows where they manage, coach rows elsewhere', async () => {
    getCurrentUser.mockResolvedValue(staffUser({
      role: 'head_coach', profileRole: 'head_coach',
      rolesByLocation: { [LOC]: 'staff', [LOC_B]: 'head_coach' },
      locations: [{ id: LOC, role: 'staff' }, { id: LOC_B, role: 'head_coach' }],
      assignmentsByLocation: { [LOC]: { role: 'staff', permissions: {} }, [LOC_B]: { role: 'head_coach', permissions: {} } },
    }))
    const bRow = { ...ROWS[3], id: 's-b-others', location_id: LOC_B }
    const { db, calls } = listDb([...ROWS, bRow])
    createServerClient.mockReturnValue(db)
    const body = await (await get('')).json()
    expect(body.data.map((r) => r.id)).toEqual(['s-mine', 's-offered', 's-open', 's-b-others'])
    expect(calls.find((c) => c[0] === 'or')?.[1]).toBe(`location_id.in.(${LOC_B}),requester_id.eq.me,target_id.eq.me,and(target_id.is.null,status.eq.pending)`)
  })
})
