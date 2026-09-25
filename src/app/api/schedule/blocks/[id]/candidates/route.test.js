// CANDIDATES.1 — GET /api/schedule/blocks/[id]/candidates. The rules are in
// shared/candidates.test.js and the reads in src/lib/candidates-data.test.js.
// Locked here: the gate, the two audiences, and the response shape.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccessOr404: vi.fn(() => null),
    // REAL: the role AT the block's studio is what is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
  }
})
vi.mock('@/lib/candidates-data', () => ({ loadBlockCandidates: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser, assertLocationAccessOr404 } = await import('@/lib/auth')
const { loadBlockCandidates } = await import('@/lib/candidates-data')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BLOCK_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const BLOCK = {
  id: BLOCK_ID, location_id: LOC, block_date: '2026-09-23', start_time: '10:00:00', end_time: '12:00:00',
  shift_templates: { name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [{ profile_id: 'coach-on', status: 'scheduled' }, { profile_id: 'coach-dropped', status: 'cancelled' }],
  rosters: { status: 'published' },
}
const LOADED = {
  candidates: [{ profile_id: 'p1', full_name: 'Ann Free', role: 'staff', rank: 1, tier: 'ready', reason: 'Free · 4h of 39h this week', free: true }],
  checked: { shifts: true, cross_studio: true, leave: true, availability: true, contract: true },
  untimed: 0,
  error: null,
}

function dbWith({ block = BLOCK, blockError = null } = {}) {
  const log = { select: null, eq: null }
  return {
    log,
    from(table) {
      if (table !== 'shift_blocks') throw new Error(`unexpected table ${table}`)
      const chain = {
        select: (s) => { log.select = s; return chain },
        eq: (c, v) => { log.eq = [c, v]; return chain },
        maybeSingle: async () => ({ data: blockError ? null : block, error: blockError }),
      }
      return chain
    },
  }
}
const call = (id = BLOCK_ID) => GET(new Request(`http://test/api/schedule/blocks/${id}/candidates`), { params: Promise.resolve({ id }) })
const userWith = (id, rolesByLocation, profileRole = 'staff') => ({
  id, profileRole, rolesByLocation, locations: Object.keys(rolesByLocation).map((l) => ({ id: l })),
})

let db
beforeEach(() => {
  db = dbWith()
  createServerClient.mockReset().mockImplementation(() => db)
  getCurrentUser.mockReset()
  assertLocationAccessOr404.mockReset().mockReturnValue(null)
  loadBlockCandidates.mockReset().mockResolvedValue(LOADED)
})

describe('GET /api/schedule/blocks/[id]/candidates', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
    expect(loadBlockCandidates).not.toHaveBeenCalled()
  })

  it('400 on a malformed id', async () => {
    getCurrentUser.mockResolvedValue(userWith('m1', { [LOC]: 'manager' }))
    expect((await call('nope')).status).toBe(400)
  })

  it('404 when the block does not exist; 500 when it cannot be read', async () => {
    getCurrentUser.mockResolvedValue(userWith('m1', { [LOC]: 'manager' }))
    db = dbWith({ block: null })
    expect((await call()).status).toBe(404)
    db = dbWith({ blockError: { message: 'db down' } })
    expect((await call()).status).toBe(500)
  })

  it('404, not 403, for someone outside the block\'s studio: the id is not confirmed', async () => {
    getCurrentUser.mockResolvedValue(userWith('m2', { [OTHER]: 'manager' }))
    assertLocationAccessOr404.mockReturnValue(NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }))
    expect((await call()).status).toBe(404)
    expect(loadBlockCandidates).not.toHaveBeenCalled()
  })

  it('403 for a coach at the studio who is not on the block (a cancelled row does not count), even one who manages elsewhere', async () => {
    for (const id of ['coach-off', 'coach-dropped']) {
      getCurrentUser.mockResolvedValue(userWith(id, { [LOC]: 'staff', [OTHER]: 'manager' }))
      expect((await call()).status).toBe(403)
    }
    expect(loadBlockCandidates).not.toHaveBeenCalled()
  })

  it('200 manager: the full list, read once for this block', async () => {
    getCurrentUser.mockResolvedValue(userWith('m1', { [LOC]: 'head_coach' }))
    const res = await call()
    expect(res.status).toBe(200)
    expect(db.log.eq).toEqual(['id', BLOCK_ID])
    expect(db.log.select).toBe('id, location_id, template_id, block_date, start_time, end_time, roster_id, rosters:roster_id(status), shift_templates(name, start_time, end_time), shift_assignments(profile_id, status)')
    expect(loadBlockCandidates).toHaveBeenCalledTimes(1)
    expect(loadBlockCandidates).toHaveBeenCalledWith(db, { block: BLOCK, audience: 'manager', withContract: false })
    expect(await res.json()).toEqual({
      success: true,
      data: { audience: 'manager', block_id: BLOCK_ID, candidates: LOADED.candidates, checked: LOADED.checked, untimed: 0 },
    })
  })

  // CANDIDATES.1 review 4 — contracted hours: owner, manager, master only.
  it('contracted hours go to an owner, a manager or a master AT the studio, never a head coach', async () => {
    const cases = [
      [userWith('o1', { [LOC]: 'owner' }), true],
      [userWith('m1', { [LOC]: 'manager' }), true],
      [userWith('boss', {}, 'master'), true],
      [userWith('h1', { [LOC]: 'head_coach' }), false],
      // Manager elsewhere, head coach here: the role HERE decides.
      [userWith('h2', { [LOC]: 'head_coach', [OTHER]: 'manager' }), false],
    ]
    for (const [u, expected] of cases) {
      loadBlockCandidates.mockClear()
      getCurrentUser.mockResolvedValue(u)
      expect((await call()).status).toBe(200)
      expect(loadBlockCandidates.mock.calls[0][1]).toMatchObject({ audience: 'manager', withContract: expected })
    }
  })

  it('200 master anywhere: manager audience', async () => {
    getCurrentUser.mockResolvedValue(userWith('boss', {}, 'master'))
    await call()
    expect(loadBlockCandidates.mock.calls[0][1].audience).toBe('manager')
  })

  it('200 colleague: the coach live on the block (asking for cover)', async () => {
    getCurrentUser.mockResolvedValue(userWith('coach-on', { [LOC]: 'staff' }))
    const res = await call()
    expect(res.status).toBe(200)
    expect(loadBlockCandidates).toHaveBeenCalledWith(db, { block: BLOCK, audience: 'colleague', withContract: false })
    expect((await res.json()).data.audience).toBe('colleague')
  })

  // CANDIDATES.1 review 1 — a coach never sees a draft (ROSTER-FIX.1 D1). The
  // swap POST refuses a shift on an unpublished roster the same way.
  it('400 for the coach on the block when its roster is not published; a manager still gets the list', async () => {
    for (const rosters of [{ status: 'draft' }, null]) {
      db = dbWith({ block: { ...BLOCK, rosters } })
      getCurrentUser.mockResolvedValue(userWith('coach-on', { [LOC]: 'staff' }))
      const res = await call()
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('That shift is not published yet')
    }
    expect(loadBlockCandidates).not.toHaveBeenCalled()
    db = dbWith({ block: { ...BLOCK, rosters: { status: 'draft' } } })
    getCurrentUser.mockResolvedValue(userWith('m1', { [LOC]: 'manager' }))
    expect((await call()).status).toBe(200)
    expect(loadBlockCandidates.mock.calls[0][1].audience).toBe('manager')
  })

  it('500 when the member list cannot be read: there is nothing to rank', async () => {
    getCurrentUser.mockResolvedValue(userWith('m1', { [LOC]: 'manager' }))
    loadBlockCandidates.mockResolvedValue({ error: { message: 'profile_locations unreadable' } })
    const res = await call()
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
