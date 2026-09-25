// STAFFCOST.1 (coordinator security review) — GET /api/schedule/overview
// judged role and the schedule feature at the ACTIVE studio (user.role,
// hasPermission) and then served any location_id the caller belonged to. Both
// are now judged at the requested studio.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

const { GET } = await import('./route.js')
const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

function emptyDb() {
  const tables = []
  const db = {
    tables,
    from(t) {
      tables.push(t)
      const b = {
        select: () => b, eq: () => b, gte: () => b, lte: () => b, in: () => b, or: () => b,
        then: (resolve) => resolve({ data: [], error: null }),
      }
      return b
    },
  }
  return db
}

const MGR_A_STAFF_B = (active) => ({
  id: 'mix', role: active === LOC_A ? 'manager' : 'staff', profileRole: 'manager',
  locations: [{ id: LOC_A, role: 'manager', features: {} }, { id: LOC_B, role: 'staff', features: {} }],
  rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
  assignmentsByLocation: { [LOC_A]: { role: 'manager', permissions: {} }, [LOC_B]: { role: 'staff', permissions: {} } },
  activeLocation: { id: active, features: {} },
  activeAssignment: { role: active === LOC_A ? 'manager' : 'staff', permissions: {} },
})

const req = (loc) => ({ url: `http://test/api/schedule/overview?from=2026-09-14&to=2026-09-20&location_id=${loc}` })

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = emptyDb()
  createServerClient.mockReturnValue(db)
})

describe('GET /api/schedule/overview — role at the requested studio', () => {
  for (const active of [LOC_A, LOC_B]) {
    const label = active === LOC_A ? 'A active' : 'B active'

    it(`${label}: A is served`, async () => {
      getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(active))
      const res = await GET(req(LOC_A))
      expect(res.status).toBe(200)
      expect(db.tables.length).toBeGreaterThan(0)
    })

    it(`${label}: B is refused before any read`, async () => {
      getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(active))
      const res = await GET(req(LOC_B))
      expect(res.status).toBe(403)
      expect(db.tables).toEqual([])
    })
  }

  it('403, not 400, for a non-manager sending a malformed query', async () => {
    getCurrentUser.mockResolvedValue({ ...MGR_A_STAFF_B(LOC_B), profileRole: 'staff', rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'staff' } })
    const res = await GET({ url: 'http://test/api/schedule/overview?from=bad' })
    expect(res.status).toBe(403)
    expect(db.tables).toEqual([])
  })

  it('a manager with a malformed query still gets the 400', async () => {
    getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(LOC_A))
    const res = await GET({ url: 'http://test/api/schedule/overview?from=bad' })
    expect(res.status).toBe(400)
  })

  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req(LOC_A))).status).toBe(401)
  })

  // SHIFTTYPE.1 — the day dialog needs each block's kind to leave admin out.
  it("reads each block's template kind", async () => {
    getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(LOC_A))
    const selects = {}
    createServerClient.mockReturnValue({
      from(t) {
        const b = {
          select: (s) => { selects[t] = s; return b },
          eq: () => b, gte: () => b, lte: () => b, in: () => b, or: () => b,
          then: (resolve) => resolve({ data: [], error: null }),
        }
        return b
      },
    })
    expect((await GET(req(LOC_A))).status).toBe(200)
    expect(selects.shift_blocks).toMatch(/shift_templates \( name, color, kind \)/)
  })
})
