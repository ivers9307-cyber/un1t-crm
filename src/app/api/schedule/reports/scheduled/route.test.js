// STAFFCOST.1 — /api/schedule/reports/scheduled: a staff_cost schedule is
// owner/manager/master only at its location. A head coach cannot create one,
// does not see one listed, and gets 404 (not 403) deactivating one by id.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

const { GET, POST, DELETE } = await import('./route.js')
const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const SCHEDULES = [
  { id: 's-cost', location_id: LOC_A, report_type: 'staff_cost', email_recipients: ['owner@example.com'] },
  { id: 's-hours', location_id: LOC_A, report_type: 'staff_hours', email_recipients: [] },
  { id: 's-b-cost', location_id: LOC_B, report_type: 'staff_cost', email_recipients: ['owner-b@example.com'] },
  { id: 's-b-hours', location_id: LOC_B, report_type: 'staff_hours', email_recipients: [] },
]

function fakeDb(rows) {
  const writes = []
  return {
    writes,
    from(table) {
      expect(table).toBe('scheduled_reports')
      const preds = []
      let op = 'select'
      let payload = null
      const b = {
        select() { return b },
        order() { return b },
        eq(col, v) { preds.push(r => r[col] === v); return b },
        not(col, operator, list) {
          const vals = list.replace(/^\(|\)$/g, '').split(',')
          preds.push(r => !vals.includes(r[col]))
          return b
        },
        insert(p) { op = 'insert'; payload = p; return b },
        update(p) { op = 'update'; payload = p; return b },
        single() {
          if (op === 'insert') { writes.push(['insert', payload]); return Promise.resolve({ data: { id: 'new', ...payload }, error: null }) }
          const hit = rows.filter(r => preds.every(p => p(r)))
          return Promise.resolve(hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { message: 'no rows' } })
        },
        then(resolve) {
          if (op === 'update') { writes.push(['update', payload]); return resolve({ data: null, error: null }) }
          resolve({ data: rows.filter(r => preds.every(p => p(r))), error: null })
        },
      }
      return b
    },
  }
}

const locs = (...ids) => ids.map(id => ({ id }))
const HEAD_COACH = { id: 'hc', role: 'head_coach', profileRole: 'head_coach', locations: locs(LOC_A), rolesByLocation: { [LOC_A]: 'head_coach' }, activeLocation: { id: LOC_A } }
const MANAGER = { id: 'm', role: 'manager', profileRole: 'manager', locations: locs(LOC_A), rolesByLocation: { [LOC_A]: 'manager' }, activeLocation: { id: LOC_A } }
const MIXED = { id: 'x', role: 'manager', profileRole: 'manager', locations: locs(LOC_A, LOC_B), rolesByLocation: { [LOC_A]: 'head_coach', [LOC_B]: 'manager' }, activeLocation: { id: LOC_B } }

const getReq = (loc) => ({ url: `http://test/api/schedule/reports/scheduled?location_id=${loc}` })
const delReq = (id) => ({ url: `http://test/api/schedule/reports/scheduled?id=${id}` })
const postReq = (body) => new Request('http://test/api/schedule/reports/scheduled', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const scheduleBody = (report_type) => ({
  location_id: LOC_A, report_type, report_name: 'Weekly', frequency: 'weekly', day_of_week: 1,
  deliver_email: true, email_recipients: ['someone@example.com'],
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = fakeDb(SCHEDULES)
  createServerClient.mockReturnValue(db)
})

describe('GET scheduled', () => {
  it('a head coach does not see the staff_cost schedule', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH)
    const body = await (await GET(getReq(LOC_A))).json()
    expect(body.data.map(r => r.id)).toEqual(['s-hours'])
  })

  it('a manager sees both', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const body = await (await GET(getReq(LOC_A))).json()
    expect(body.data.map(r => r.id)).toEqual(['s-cost', 's-hours'])
  })

  it('uses the role at the requested location, not the active one', async () => {
    getCurrentUser.mockResolvedValue(MIXED)
    const body = await (await GET(getReq(LOC_A))).json()
    expect(body.data.map(r => r.id)).toEqual(['s-hours'])
  })
})

describe('POST scheduled', () => {
  it('403 for a head coach scheduling staff_cost; nothing is written', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH)
    const res = await POST(postReq(scheduleBody('staff_cost')))
    expect(res.status).toBe(403)
    expect(db.writes).toEqual([])
  })

  it('a head coach can schedule staff_hours', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH)
    const res = await POST(postReq(scheduleBody('staff_hours')))
    expect(res.status).toBe(201)
  })

  it('a manager can schedule staff_cost', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const res = await POST(postReq(scheduleBody('staff_cost')))
    expect(res.status).toBe(201)
  })
})

describe('DELETE scheduled', () => {
  it('404 (not 403) for a head coach deactivating a staff_cost schedule, and no write', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH)
    const res = await DELETE(delReq('s-cost'))
    expect(res.status).toBe(404)
    expect(db.writes).toEqual([])
  })

  it('a head coach can deactivate a staff_hours schedule', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH)
    const res = await DELETE(delReq('s-hours'))
    expect(res.status).toBe(200)
  })

  it('a manager can deactivate the staff_cost schedule', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const res = await DELETE(delReq('s-cost'))
    expect(res.status).toBe(200)
  })

  it('404 for a caller not at the schedule location', async () => {
    getCurrentUser.mockResolvedValue({ ...MANAGER, locations: locs(LOC_B), rolesByLocation: { [LOC_B]: 'manager' } })
    const res = await DELETE(delReq('s-hours'))
    expect(res.status).toBe(404)
  })
})

// Coordinator security review: manager at A, plain staff at B.
describe('mixed roles: manager at A, staff at B', () => {
  const MGR_A_STAFF_B = (active) => ({
    id: 'mix', role: active === LOC_A ? 'manager' : 'staff', profileRole: 'manager',
    locations: locs(LOC_A, LOC_B), rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
    activeLocation: { id: active },
  })
  const bodyAt = (report_type, location_id) => ({ ...scheduleBody(report_type), location_id })

  for (const active of [LOC_A, LOC_B]) {
    const label = active === LOC_A ? 'A active' : 'B active'

    it(`${label}: lists A, refuses B`, async () => {
      getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(active))
      const a = await GET(getReq(LOC_A))
      expect(a.status).toBe(200)
      expect((await a.json()).data.map(r => r.id)).toEqual(['s-cost', 's-hours'])
      const b = await GET(getReq(LOC_B))
      expect(b.status).toBe(403)
    })

    it(`${label}: creates at A, refused at B`, async () => {
      getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(active))
      expect((await POST(postReq(bodyAt('staff_cost', LOC_A)))).status).toBe(201)
      expect((await POST(postReq(bodyAt('staff_hours', LOC_B)))).status).toBe(403)
      expect(db.writes.filter(w => w[0] === 'insert')).toHaveLength(1)
    })

    it(`${label}: deactivates at A, 404 at B`, async () => {
      getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(active))
      expect((await DELETE(delReq('s-hours'))).status).toBe(200)
      expect((await DELETE(delReq('s-b-hours'))).status).toBe(404)
      expect((await DELETE(delReq('s-b-cost'))).status).toBe(404)
      expect(db.writes.filter(w => w[0] === 'update')).toHaveLength(1)
    })
  }
})
