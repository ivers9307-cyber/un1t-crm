// STAFFCOST.1 — GET/POST /api/schedule/reports: rate-bearing reports
// (staff_cost) are owner/manager/master only AT THE REPORT'S LOCATION.
//
// @/lib/auth is the REAL module with only getCurrentUser mocked, so the gate
// runs against hasRoleAtLocation's actual contract. The fake DB applies the
// filters the route builds (eq / in / not-in / or) the way PostgREST would,
// so a filter string that is wrong shows up as a leaked row — not a spy
// assertion that the right method was called.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/report-generator', () => ({ generateReport: vi.fn() }))

const { GET, POST } = await import('./route.js')
const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { generateReport } = await import('@/lib/report-generator')

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const ROWS = [
  { id: 'r1', location_id: LOC_A, report_type: 'staff_cost', created_at: '2026-09-10', report_data: { staff: [{ name: 'Anna', regular_rate: 23.5, total_cost: 400 }] }, summary: { total_cost: 400 } },
  { id: 'r2', location_id: LOC_A, report_type: 'staff_hours', created_at: '2026-09-09', report_data: { staff: [{ name: 'Anna', total: 17 }] }, summary: { total_hours: 17 } },
  { id: 'r3', location_id: LOC_B, report_type: 'staff_cost', created_at: '2026-09-08', report_data: { staff: [{ name: 'Ben', regular_rate: 31, total_cost: 900 }] }, summary: { total_cost: 900 } },
  { id: 'r4', location_id: LOC_B, report_type: 'utilisation', created_at: '2026-09-07', report_data: { staff: [] }, summary: {} },
]

function parseList(s) { return s.replace(/^\(|\)$/g, '').split(',') }

// Split a PostgREST or=() body on top-level commas only.
function splitTop(s) {
  const out = []; let depth = 0; let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function orTerm(term) {
  const m = term.match(/^(\w+)\.(not\.)?in\.(\(.*\))$/)
  if (!m) throw new Error(`fake db: unsupported or term ${term}`)
  const [, col, not, list] = m
  const vals = parseList(list)
  return (row) => (not ? !vals.includes(row[col]) : vals.includes(row[col]))
}

function fakeDb(rows) {
  const calls = []
  const db = {
    calls,
    from(table) {
      const preds = []
      const b = {
        select() { return b },
        order() { return b },
        limit() { return b },
        eq(col, v) { calls.push(['eq', col, v]); preds.push(r => r[col] === v); return b },
        in(col, vs) { calls.push(['in', col, vs]); preds.push(r => vs.includes(r[col])); return b },
        not(col, op, list) {
          calls.push(['not', col, op, list])
          if (op !== 'in') throw new Error('fake db: only not.in')
          const vals = parseList(list)
          preds.push(r => !vals.includes(r[col]))
          return b
        },
        or(expr) {
          calls.push(['or', expr])
          const terms = splitTop(expr).map(orTerm)
          preds.push(r => terms.some(t => t(r)))
          return b
        },
        then(resolve) {
          expect(table).toBe('generated_reports')
          resolve({ data: rows.filter(r => preds.every(p => p(r))), error: null })
        },
      }
      return b
    },
  }
  return db
}

const locs = (...ids) => ids.map(id => ({ id }))

const HEAD_COACH_A = { id: 'hc', role: 'head_coach', profileRole: 'head_coach', locations: locs(LOC_A), rolesByLocation: { [LOC_A]: 'head_coach' }, activeLocation: { id: LOC_A } }
const MANAGER_A = { id: 'm', role: 'manager', profileRole: 'manager', locations: locs(LOC_A), rolesByLocation: { [LOC_A]: 'manager' }, activeLocation: { id: LOC_A } }
// Manager at A (active), head coach at B — the per-location case.
const MIXED = { id: 'x', role: 'manager', profileRole: 'manager', locations: locs(LOC_A, LOC_B), rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'head_coach' }, activeLocation: { id: LOC_A } }
const MASTER = { id: 'ms', role: 'master', profileRole: 'master', locations: locs(LOC_A, LOC_B), rolesByLocation: {}, activeLocation: { id: LOC_A } }

function listReq(locationId) {
  const url = new URL('http://test/api/schedule/reports')
  if (locationId) url.searchParams.set('location_id', locationId)
  return { url: url.toString() }
}

function postReq(body) {
  return new Request('http://test/api/schedule/reports', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = fakeDb(ROWS)
  createServerClient.mockReturnValue(db)
  generateReport.mockResolvedValue({ success: true, data: { id: 'new' } })
})

describe('GET /api/schedule/reports — list', () => {
  it('a head coach gets no staff_cost rows and none of their data', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH_A)
    const res = await GET(listReq(LOC_A))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.map(r => r.id)).toEqual(['r2'])
    const wire = JSON.stringify(body)
    expect(wire).not.toContain('staff_cost')
    expect(wire).not.toContain('regular_rate')
    expect(wire).not.toContain('total_cost')
    expect(db.calls).toContainEqual(['not', 'report_type', 'in', '(staff_cost)'])
  })

  it('a manager at the location gets every type', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const body = await (await GET(listReq(LOC_A))).json()
    expect(body.data.map(r => r.id)).toEqual(['r1', 'r2'])
  })

  it('judges the REPORT location, not the active one: manager at A, head coach at B', async () => {
    getCurrentUser.mockResolvedValue(MIXED)
    const body = await (await GET(listReq(LOC_B))).json()
    expect(body.data.map(r => r.id)).toEqual(['r4'])
  })

  it('unscoped list: rate rows only from locations where the caller is an admin', async () => {
    getCurrentUser.mockResolvedValue(MIXED)
    const body = await (await GET(listReq(null))).json()
    expect(body.data.map(r => r.id)).toEqual(['r1', 'r2', 'r4'])
    // The QUERY excludes them, not only the defence-in-depth filter after it.
    expect(db.calls).toContainEqual(['or', `location_id.in.(${LOC_A}),report_type.not.in.(staff_cost)`])
  })

  it('unscoped list for a head coach everywhere excludes every rate row', async () => {
    getCurrentUser.mockResolvedValue({ ...HEAD_COACH_A, locations: locs(LOC_A, LOC_B), rolesByLocation: { [LOC_A]: 'head_coach', [LOC_B]: 'head_coach' } })
    const body = await (await GET(listReq(null))).json()
    expect(body.data.map(r => r.id)).toEqual(['r2', 'r4'])
  })

  it('master sees everything', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const body = await (await GET(listReq(null))).json()
    expect(body.data.map(r => r.id)).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  it('a staff member at the location is refused even with a manager active role elsewhere', async () => {
    getCurrentUser.mockResolvedValue({ ...MIXED, rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' } })
    const res = await GET(listReq(LOC_B))
    expect(res.status).toBe(403)
  })

  it('403 for a staff caller', async () => {
    getCurrentUser.mockResolvedValue({ ...HEAD_COACH_A, role: 'staff', rolesByLocation: { [LOC_A]: 'staff' } })
    expect((await GET(listReq(LOC_A))).status).toBe(403)
  })
})

// Coordinator security review: the routes gated on the ACTIVE studio's
// user.role, then accepted any studio the caller belonged to. Manager at A,
// plain staff at B — with B active, and with A active.
describe('mixed roles: manager at A, staff at B', () => {
  const MGR_A_STAFF_B = (active) => ({
    id: 'mix', role: active === LOC_A ? 'manager' : 'staff', profileRole: 'manager',
    locations: locs(LOC_A, LOC_B), rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
    activeLocation: { id: active },
  })
  const genBody = (report_type, location_id) => ({ report_type, period_start: '2026-09-01', period_end: '2026-09-07', location_id })

  for (const active of [LOC_A, LOC_B]) {
    const label = active === LOC_A ? 'A active' : 'B active'

    it(`${label}: A is readable, staff cost included`, async () => {
      getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(active))
      const res = await GET(listReq(LOC_A))
      expect(res.status).toBe(200)
      expect((await res.json()).data.map(r => r.id)).toEqual(['r1', 'r2'])
    })

    it(`${label}: B is refused`, async () => {
      getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(active))
      const res = await GET(listReq(LOC_B))
      expect(res.status).toBe(403)
      expect(JSON.stringify(await res.json())).not.toContain('Ben')
    })

    it(`${label}: the no-location_id list holds only A's rows`, async () => {
      getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(active))
      const body = await (await GET(listReq(null))).json()
      expect(body.data.map(r => r.id)).toEqual(['r1', 'r2'])
      expect(db.calls).toContainEqual(['in', 'location_id', [LOC_A]])
    })

    it(`${label}: can generate at A, cannot generate anything at B`, async () => {
      getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(active))
      expect((await POST(postReq(genBody('staff_cost', LOC_A)))).status).toBe(201)
      expect((await POST(postReq(genBody('staff_hours', LOC_B)))).status).toBe(403)
      expect((await POST(postReq(genBody('staff_cost', LOC_B)))).status).toBe(403)
      expect(generateReport).toHaveBeenCalledTimes(1)
      expect(generateReport).toHaveBeenCalledWith(expect.objectContaining({ location_id: LOC_A }))
    })
  }
})

describe('POST /api/schedule/reports — generate', () => {
  const body = (report_type, location_id = LOC_A) => ({ report_type, period_start: '2026-09-01', period_end: '2026-09-07', location_id })

  it('403 for a head coach generating staff_cost, and nothing is generated', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH_A)
    const res = await POST(postReq(body('staff_cost')))
    expect(res.status).toBe(403)
    expect(generateReport).not.toHaveBeenCalled()
  })

  it('a head coach can still generate staff_hours', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH_A)
    const res = await POST(postReq(body('staff_hours')))
    expect(res.status).toBe(201)
    expect(generateReport).toHaveBeenCalledWith(expect.objectContaining({ report_type: 'staff_hours', location_id: LOC_A }))
  })

  it('a manager can generate staff_cost', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await POST(postReq(body('staff_cost')))
    expect(res.status).toBe(201)
  })

  it('manager at A cannot generate staff_cost for B, where they are head coach', async () => {
    getCurrentUser.mockResolvedValue(MIXED)
    const res = await POST(postReq(body('staff_cost', LOC_B)))
    expect(res.status).toBe(403)
    expect(generateReport).not.toHaveBeenCalled()
  })
})
