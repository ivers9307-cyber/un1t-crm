// SCHEDROLES.1 — POST /api/schedule/templates judges the caller's role AT
// body.location_id, not `user.role` (the ACTIVE studio's role). A head coach
// at one studio who is staff at another could create shift templates (and so
// eight weeks of generated blocks) at the studio where they are staff.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: real.getUserLocationIds,
    // REAL membership + role helpers: both decisions are under test.
    assertLocationAccess: real.assertLocationAccess,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { POST } = await import('./route.js')

const LOC_A = 'a0000000-0000-4000-8000-000000000001'
const LOC_B = 'b0000000-0000-4000-8000-000000000002'

function req(body) {
  return { json: () => Promise.resolve(body), headers: { get: () => '' } }
}

function buildDb() {
  const insertSpy = vi.fn()
  return {
    insertSpy,
    db: {
      from: (table) => {
        if (table !== 'shift_templates') throw new Error(`unexpected table ${table}`)
        return {
          insert: (row) => {
            insertSpy(row)
            return { select: () => ({ single: () => Promise.resolve({ data: { id: 'tpl-new', ...row }, error: null }) }) }
          },
        }
      },
    },
  }
}

const body = (location_id) => ({ location_id, name: 'Morning', start_time: '09:00', end_time: '10:00' })

// Head coach at A, plain staff at B.
const mixed = (active) => ({
  id: 'mix', role: active === LOC_A ? 'head_coach' : 'staff', profileRole: 'staff',
  activeLocation: { id: active },
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'head_coach', [LOC_B]: 'staff' },
})

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
})

describe('POST /api/schedule/templates — role at body.location_id (SCHEDROLES.1)', () => {
  it('refuses the studio where the caller is staff, and inserts nothing', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC_A))
    const { db, insertSpy } = buildDb()
    createServerClient.mockReturnValue(db)
    expect((await POST(req(body(LOC_B)))).status).toBe(403)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('allows the studio the caller manages', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC_A))
    const { db, insertSpy } = buildDb()
    createServerClient.mockReturnValue(db)
    expect((await POST(req(body(LOC_A)))).status).toBe(201)
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ location_id: LOC_A }))
  })

  it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC_B))
    createServerClient.mockReturnValue(buildDb().db)
    expect((await POST(req(body(LOC_A)))).status).toBe(201)
  })

  it('refuses a studio the caller does not belong to, and a caller who manages nowhere', async () => {
    getCurrentUser.mockResolvedValue({ ...mixed(LOC_A), locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'head_coach' } })
    createServerClient.mockReturnValue(buildDb().db)
    expect((await POST(req(body(LOC_B)))).status).toBe(403)

    getCurrentUser.mockResolvedValue({ id: 's', role: 'staff', profileRole: 'staff', locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'staff' } })
    expect((await POST(req(body(LOC_A)))).status).toBe(403)
  })

  it('master is allowed', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'boss', role: 'master', profileRole: 'master',
      locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
    })
    createServerClient.mockReturnValue(buildDb().db)
    expect((await POST(req(body(LOC_B)))).status).toBe(201)
  })
})

// SHIFTTYPE.1 — kind on create.
describe('POST /api/schedule/templates — kind (SHIFTTYPE.1)', () => {
  const MGR = { id: 'm', role: 'manager', profileRole: 'manager', activeLocation: { id: LOC_A }, locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' } }

  it('creates a class template with minimum 1 by default', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, insertSpy } = buildDb()
    createServerClient.mockReturnValue(db)
    expect((await POST(req(body(LOC_A)))).status).toBe(201)
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'class', min_coaches: 1 }))
  })

  it('creates an admin template with minimum 0', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, insertSpy } = buildDb()
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ ...body(LOC_A), kind: 'admin' }))).status).toBe(201)
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'admin', min_coaches: 0 }))
  })

  it('refuses an admin template with a minimum, and inserts nothing', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, insertSpy } = buildDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ ...body(LOC_A), kind: 'admin', min_coaches: 2 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('admin_has_no_minimum')
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('refuses a kind it does not know', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, insertSpy } = buildDb()
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ ...body(LOC_A), kind: 'desk' }))).status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })
})

// ROUTEWRAP.R16 — signed in through withAuth: signed out is its 401 now (POST
// answered 403 'Unauthorized' before; GET already gave 401).
describe('/api/schedule/templates — signed out', () => {
  it('401 on POST, nothing inserted', async () => {
    getCurrentUser.mockResolvedValue(null)
    const { db, insertSpy } = buildDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req(body(LOC_A)))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('401 on GET', async () => {
    getCurrentUser.mockResolvedValue(null)
    const { GET } = await import('./route.js')
    const res = await GET(new Request(`http://localhost/api/schedule/templates?location_id=${LOC_A}`))
    expect(res.status).toBe(401)
  })
})

// USUALCOACH.1 — usual coaches on create: only active staff of THIS studio.
describe('POST /api/schedule/templates — usual coaches (USUALCOACH.1)', () => {
  const MGR = { id: 'm', role: 'manager', profileRole: 'manager', activeLocation: { id: LOC_A }, locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' } }
  const P1 = 'c0000000-0000-4000-8000-000000000001'
  const P2 = 'c0000000-0000-4000-8000-000000000002'
  const P_OTHER = 'c0000000-0000-4000-8000-000000000003'
  const P_OFF = 'c0000000-0000-4000-8000-000000000004'
  // profile_locations rows by studio; P_OFF is linked but deactivated.
  const LINKS = {
    [LOC_A]: [
      { profile_id: P1, role: 'staff', profiles: { id: P1, full_name: 'One', active: true, deleted_at: null, employment_type: 'employee' } },
      { profile_id: P2, role: 'staff', profiles: { id: P2, full_name: 'Two', active: null, deleted_at: null, employment_type: 'contractor' } },
      { profile_id: P_OFF, role: 'staff', profiles: { id: P_OFF, full_name: 'Off', active: false, deleted_at: null, employment_type: 'employee' } },
    ],
    [LOC_B]: [
      { profile_id: P_OTHER, role: 'staff', profiles: { id: P_OTHER, full_name: 'Other', active: true, deleted_at: null, employment_type: 'employee' } },
    ],
  }

  function dbWithMembers() {
    const base = buildDb()
    const memberReads = []
    const from = (table) => {
      if (table !== 'profile_locations') return base.db.from(table)
      let loc = null
      const q = {
        select: () => q,
        eq: (col, v) => { if (col === 'location_id') loc = v; return q },
        order: () => q,
        range: () => q,
        then: (ok, bad) => { memberReads.push(loc); return Promise.resolve({ data: LINKS[loc] || [], error: null }).then(ok, bad) },
      }
      return q
    }
    return { ...base, memberReads, db: { from } }
  }

  it('saves the coaches in the order picked, repeats dropped', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, insertSpy, memberReads } = dbWithMembers()
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ ...body(LOC_A), usual_coach_ids: [P2, P1, P2] }))).status).toBe(201)
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ usual_coach_ids: [P2, P1] }))
    expect(memberReads).toEqual([LOC_A])
  })

  it('defaults to none', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, insertSpy } = dbWithMembers()
    createServerClient.mockReturnValue(db)
    expect((await POST(req(body(LOC_A)))).status).toBe(201)
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ usual_coach_ids: [] }))
  })

  it('refuses staff of another studio and deactivated staff, and inserts nothing', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    for (const id of [P_OTHER, P_OFF]) {
      const { db, insertSpy } = dbWithMembers()
      createServerClient.mockReturnValue(db)
      const res = await POST(req({ ...body(LOC_A), usual_coach_ids: [P1, id] }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/not active staff at this studio/)
      expect(insertSpy).not.toHaveBeenCalled()
    }
  })

  it('refuses a malformed id', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, insertSpy } = dbWithMembers()
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ ...body(LOC_A), usual_coach_ids: ['nope'] }))).status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('a staff member at the studio cannot set them (template permission)', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC_A))
    const { db, insertSpy, memberReads } = dbWithMembers()
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ ...body(LOC_B), usual_coach_ids: [P_OTHER] }))).status).toBe(403)
    expect(insertSpy).not.toHaveBeenCalled()
    expect(memberReads).toEqual([])
  })
})
