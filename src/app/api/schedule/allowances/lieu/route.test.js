// LIEU.1 — /api/schedule/allowances/lieu: own ledger for anyone, another
// person's for a manager at one of their studios; a manager AT the studio
// records lieu taken (never past the banked balance) or a manual credit with
// a note; only manual / taken rows can be removed, at their own studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    getCurrentUser: vi.fn(),
  }
})

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET, POST, DELETE } = await import('./route.js')

const PID = '11111111-1111-4111-8111-111111111111'
const LOC = '22222222-2222-4222-8222-222222222222'
const LOC2 = '33333333-3333-4333-8333-333333333333'
const ROW = '44444444-4444-4444-8444-444444444444'

const at = (role, locs = [LOC]) => ({
  role, profileRole: role === 'master' ? 'master' : 'staff',
  locations: locs.map((id) => ({ id })),
  rolesByLocation: role === 'master' ? {} : Object.fromEntries(locs.map((id) => [id, role])),
  activeLocation: { id: locs[0], timezone: 'Europe/Dublin' },
})
const MGR = { id: 'mgr', ...at('manager') }
const HEAD = { id: 'hc', ...at('head_coach') }
const STAFF = { id: 'me', ...at('staff') }
const MASTER = { id: 'root', ...at('master') }   // getCurrentUser gives a master every studio

const jsonReq = (method, body, url = 'http://x/api/schedule/allowances/lieu') =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const getReq = (qs) => new Request(`http://x/api/schedule/allowances/lieu${qs}`)

// links: profile_locations rows; ledger: staff_lieu_credits rows.
function buildDb({ links = [{ profile_id: PID, location_id: LOC }], ledger = [], ledgerError = null, insertError = null } = {}) {
  const inserted = []
  const deleted = []
  const db = {
    from: (t) => {
      if (t === 'profile_locations') {
        const preds = []
        const chain = {
          select: () => chain,
          eq: (col, v) => { preds.push((r) => r[col] === v); return chain },
          limit: () => chain,
          then: (res, rej) => Promise.resolve({ data: links.filter((r) => preds.every((p) => p(r))), error: null }).then(res, rej),
        }
        return chain
      }
      if (t === 'staff_lieu_credits') {
        const preds = []
        let single = false
        let mode = 'read'
        let payload = null
        const chain = {
          select: () => chain,
          eq: (col, v) => { preds.push((r) => r[col] === v); return chain },
          in: (col, vs) => { preds.push((r) => vs.includes(r[col])); return chain },
          gte: (col, v) => { preds.push((r) => r[col] >= v); return chain },
          lte: (col, v) => { preds.push((r) => r[col] <= v); return chain },
          order: () => chain,
          range: () => chain,
          maybeSingle: () => { single = true; return chain },
          single: () => { single = true; return chain },
          insert: (row) => { mode = 'insert'; payload = row; return chain },
          delete: () => { mode = 'delete'; return chain },
          then: (res, rej) => {
            if (ledgerError) return Promise.resolve({ data: null, error: ledgerError }).then(res, rej)
            if (mode === 'insert') {
              if (insertError) return Promise.resolve({ data: null, error: insertError }).then(res, rej)
              const row = { id: ROW, created_at: '2026-10-20T10:00:00Z', ...payload }
              inserted.push(row)
              return Promise.resolve({ data: row, error: null }).then(res, rej)
            }
            const rows = ledger.filter((r) => preds.every((p) => p(r)))
            if (mode === 'delete') { deleted.push(...rows.map((r) => r.id)); return Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null }).then(res, rej) }
            return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(res, rej)
          },
        }
        return chain
      }
      throw new Error(t)
    },
  }
  return { db, inserted, deleted }
}

beforeEach(() => vi.clearAllMocks())

describe('GET', () => {
  const ledger = [
    { id: 'a', profile_id: PID, location_id: LOC, source: 'sunday_worked', shift_assignment_id: 'as1', credit_date: '2026-06-07', hours: '10.67', worked_hours: '8', multiplier: '1.3333', holiday_name: null, note: null, created_by: null, created_at: 'x' },
    { id: 'b', profile_id: PID, location_id: LOC, source: 'taken', shift_assignment_id: null, credit_date: '2026-07-01', hours: '-4', worked_hours: null, multiplier: null, holiday_name: null, note: 'Day off 1 Jul', created_by: 'mgr', created_at: 'y' },
  ]
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq(''))).status).toBe(401)
  })
  it('a coach reads their own ledger and balance, numbers as numbers', async () => {
    getCurrentUser.mockResolvedValue({ id: PID, ...at('staff') })
    createServerClient.mockReturnValue(buildDb({ ledger }).db)
    const json = await (await GET(getReq('?year=2026'))).json()
    expect(json.data).toMatchObject({ profile_id: PID, year: 2026, credited_hours: 10.67, taken_hours: 4, balance_hours: 6.67 })
    expect(json.data.entries.map((e) => [e.id, e.hours, e.multiplier])).toEqual([['a', 10.67, 1.3333], ['b', -4, null]])
  })
  it("a coach cannot read a colleague's ledger (403)", async () => {
    getCurrentUser.mockResolvedValue(STAFF)
    createServerClient.mockReturnValue(buildDb({ ledger }).db)
    expect((await GET(getReq(`?profile_id=${PID}`))).status).toBe(403)
  })
  it('a manager reads a profile at their studio; a foreign profile is 404', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    createServerClient.mockReturnValue(buildDb({ ledger }).db)
    expect((await GET(getReq(`?profile_id=${PID}&year=2026`))).status).toBe(200)
    createServerClient.mockReturnValue(buildDb({ ledger, links: [{ profile_id: PID, location_id: LOC2 }] }).db)
    expect((await GET(getReq(`?profile_id=${PID}&year=2026`))).status).toBe(404)
  })
  it('a bad year is 400; an unreadable ledger is 500, never an empty balance', async () => {
    getCurrentUser.mockResolvedValue({ id: PID, ...at('staff') })
    createServerClient.mockReturnValue(buildDb({ ledger }).db)
    expect((await GET(getReq('?year=abc'))).status).toBe(400)
    createServerClient.mockReturnValue(buildDb({ ledgerError: { message: 'down' } }).db)
    expect((await GET(getReq('?year=2026'))).status).toBe(500)
  })
})

describe('POST', () => {
  const body = { profile_id: PID, location_id: LOC, source: 'manual', hours: 2, credit_date: '2026-10-20', note: 'Covered the open day' }
  it('a head coach or a coach cannot write (403); signed out 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(jsonReq('POST', body))).status).toBe(401)
    getCurrentUser.mockResolvedValue(HEAD)
    expect((await POST(jsonReq('POST', body))).status).toBe(403)
    getCurrentUser.mockResolvedValue(STAFF)
    expect((await POST(jsonReq('POST', body))).status).toBe(403)
  })
  it('a manager at the studio records a manual credit with a note', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, inserted } = buildDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(jsonReq('POST', body))
    expect(res.status).toBe(201)
    expect(inserted[0]).toMatchObject({ profile_id: PID, location_id: LOC, source: 'manual', hours: 2, credit_date: '2026-10-20', note: 'Covered the open day', created_by: 'mgr', shift_assignment_id: null })
    expect((await res.json()).data).toMatchObject({ id: ROW, hours: 2 })
  })
  it("'taken' is stored negative and refused past the banked balance on that date", async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const ledger = [
      { id: 'a', profile_id: PID, source: 'sunday_worked', credit_date: '2026-06-07', hours: '10.67' },
      { id: 'b', profile_id: PID, source: 'manual', credit_date: '2026-11-01', hours: '20' },   // after the taken date: not yet banked
    ]
    const { db, inserted } = buildDb({ ledger })
    createServerClient.mockReturnValue(db)
    const over = await POST(jsonReq('POST', { ...body, source: 'taken', hours: 11 }))
    expect(over.status).toBe(409)
    expect((await over.json()).data).toEqual({ balance_hours: 10.67 })
    expect(inserted).toEqual([])
    const ok = await POST(jsonReq('POST', { ...body, source: 'taken', hours: 8 }))
    expect(ok.status).toBe(201)
    expect(inserted[0]).toMatchObject({ source: 'taken', hours: -8 })
  })
  it('a manager at another studio, or a profile not at that studio, cannot write', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr', ...at('manager', [LOC2]) })
    createServerClient.mockReturnValue(buildDb().db)
    expect((await POST(jsonReq('POST', body))).status).toBe(403)        // assertLocationAccess
    getCurrentUser.mockResolvedValue(MGR)
    createServerClient.mockReturnValue(buildDb({ links: [{ profile_id: PID, location_id: LOC2 }] }).db)
    expect((await POST(jsonReq('POST', body))).status).toBe(404)
  })
  it('validation: a sweep source, zero hours, a fake date or a blank note is 400', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    createServerClient.mockReturnValue(buildDb().db)
    for (const bad of [
      { ...body, source: 'sunday_worked' }, { ...body, hours: 0 }, { ...body, hours: -1 },
      { ...body, credit_date: '2026-02-30' }, { ...body, note: '  ' },
    ]) {
      expect((await POST(jsonReq('POST', bad))).status).toBe(400)
    }
  })
  it('a master anywhere may write', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, inserted } = buildDb()
    createServerClient.mockReturnValue(db)
    expect((await POST(jsonReq('POST', body))).status).toBe(201)
    expect(inserted).toHaveLength(1)
  })
})

describe('DELETE', () => {
  const manual = { id: ROW, profile_id: PID, location_id: LOC, source: 'manual' }
  const auto = { id: ROW, profile_id: PID, location_id: LOC, source: 'sunday_worked' }
  it('removes a manual row at the manager\'s studio', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, deleted } = buildDb({ ledger: [manual] })
    createServerClient.mockReturnValue(db)
    expect((await DELETE(getReq(`?id=${ROW}`))).status).toBe(200)
    expect(deleted).toEqual([ROW])
  })
  it('an automatic credit is 409; a missing row 404; a bad id 400', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    createServerClient.mockReturnValue(buildDb({ ledger: [auto] }).db)
    expect((await DELETE(getReq(`?id=${ROW}`))).status).toBe(409)
    createServerClient.mockReturnValue(buildDb({ ledger: [] }).db)
    expect((await DELETE(getReq(`?id=${ROW}`))).status).toBe(404)
    expect((await DELETE(getReq('?id=nope'))).status).toBe(400)
  })
  it("a row at another studio is 404 (not 403) so ids cannot be probed; a head coach is 403", async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr', ...at('manager', [LOC2]) })
    createServerClient.mockReturnValue(buildDb({ ledger: [manual] }).db)
    expect((await DELETE(getReq(`?id=${ROW}`))).status).toBe(404)
    getCurrentUser.mockResolvedValue(HEAD)
    expect((await DELETE(getReq(`?id=${ROW}`))).status).toBe(403)
  })
})
