// STAFFCOST.1 — /api/schedule/reports/scheduled: a staff_cost schedule is
// owner/manager/master only at its location. A head coach cannot create one,
// does not see one listed, and gets 404 (not 403) deactivating one by id.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// The recipient rule itself runs for real in
// src/app/api/cron/run-scheduled-reports/route.test.js; here only its verdict
// matters.
vi.mock('@/lib/report-recipients', () => ({ checkRateReportRecipientsForSave: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

const { GET, POST, PATCH, DELETE } = await import('./route.js')
const { checkRateReportRecipientsForSave } = await import('@/lib/report-recipients')
const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const SCHEDULES = [
  { id: 's-cost', location_id: LOC_A, report_type: 'staff_cost', frequency: 'monthly', day_of_month: 1, deliver_email: true, email_recipients: ['owner@example.com'], confirmed_external_recipients: ['owner@example.com'], active: true, paused: false },
  { id: 's-hours', location_id: LOC_A, report_type: 'staff_hours', frequency: 'weekly', day_of_week: 1, deliver_email: false, email_recipients: [], confirmed_external_recipients: [], active: true, paused: false },
  { id: 's-b-cost', location_id: LOC_B, report_type: 'staff_cost', frequency: 'weekly', day_of_week: 1, deliver_email: true, email_recipients: ['owner-b@example.com'], confirmed_external_recipients: [], active: true, paused: false },
  { id: 's-b-hours', location_id: LOC_B, report_type: 'staff_hours', frequency: 'weekly', day_of_week: 1, deliver_email: false, email_recipients: [], confirmed_external_recipients: [], active: true, paused: true },
  { id: 's-deleted', location_id: LOC_A, report_type: 'staff_hours', frequency: 'weekly', day_of_week: 1, deliver_email: false, email_recipients: [], confirmed_external_recipients: [], active: false, paused: false },
]

function fakeDb(rows) {
  const writes = []
  const calls = []
  return {
    writes,
    calls,
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
          calls.push(['not', col, operator, list])
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
        maybeSingle() {
          const hit = rows.filter(r => preds.every(p => p(r)))
          if (op === 'update') {
            writes.push(['update', payload])
            return Promise.resolve({ data: hit[0] ? { ...hit[0], ...payload } : null, error: null })
          }
          return Promise.resolve({ data: hit[0] || null, error: null })
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

const patchReq = (id, body) => new Request(`http://test/api/schedule/reports/scheduled?id=${id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const recipientsOk = (confirmedExternal = []) => ({ refused: [], needsConfirmation: [], confirmedExternal, lookupFailed: false })

let db
beforeEach(() => {
  vi.clearAllMocks()
  checkRateReportRecipientsForSave.mockResolvedValue(recipientsOk())
  db = fakeDb(SCHEDULES)
  createServerClient.mockReturnValue(db)
})

describe('GET scheduled', () => {
  it('a head coach does not see the staff_cost schedule', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH)
    const body = await (await GET(getReq(LOC_A))).json()
    expect(body.data.map(r => r.id)).toEqual(['s-hours'])
    // The QUERY excludes it, not only the defence-in-depth filter after it.
    expect(db.calls).toContainEqual(['not', 'report_type', 'in', '(staff_cost)'])
  })

  it('a manager sees both, with no report_type filter on the query', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const body = await (await GET(getReq(LOC_A))).json()
    expect(body.data.map(r => r.id)).toEqual(['s-cost', 's-hours'])
    expect(db.calls).toEqual([])
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

// REPORTS.2 — pause/resume/edit, the in-app option refused, external confirm.
describe('GET scheduled — deleted rows', () => {
  it('hides a deleted (deactivated) schedule and keeps a paused one', async () => {
    getCurrentUser.mockResolvedValue({ ...MANAGER, locations: locs(LOC_A, LOC_B), rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'manager' } })
    const a = await (await GET(getReq(LOC_A))).json()
    expect(a.data.map(r => r.id)).not.toContain('s-deleted')
    const b = await (await GET(getReq(LOC_B))).json()
    expect(b.data.map(r => r.id)).toContain('s-b-hours')
  })
})

describe('PATCH scheduled — gating identical to create', () => {
  it('404 for a head coach touching a staff_cost schedule, and no write', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH)
    const res = await PATCH(patchReq('s-cost', { paused: true }))
    expect(res.status).toBe(404)
    expect(db.writes).toEqual([])
  })

  it('404 for a caller not at the schedule location', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    expect((await PATCH(patchReq('s-b-hours', { paused: false }))).status).toBe(404)
    expect(db.writes).toEqual([])
  })

  it('404 for a deleted schedule', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    expect((await PATCH(patchReq('s-deleted', { paused: true }))).status).toBe(404)
  })

  it('judges the role at the schedule location, not the active one', async () => {
    // head coach at A, manager at B, B active.
    getCurrentUser.mockResolvedValue(MIXED)
    expect((await PATCH(patchReq('s-cost', { paused: true }))).status).toBe(404)
    expect((await PATCH(patchReq('s-b-cost', { paused: true }))).status).toBe(200)
  })

  it('403 when a head coach changes a staff_hours schedule into staff_cost', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH)
    const res = await PATCH(patchReq('s-hours', { report_type: 'staff_cost' }))
    expect(res.status).toBe(403)
    expect(db.writes).toEqual([])
  })

  it('a head coach can pause a staff_hours schedule', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH)
    const res = await PATCH(patchReq('s-hours', { paused: true }))
    expect(res.status).toBe(200)
    expect(db.writes[0][1]).toMatchObject({ paused: true })
    // Pausing does not move the next run, and never re-checks recipients.
    expect(db.writes[0][1]).not.toHaveProperty('next_run_at')
    expect(checkRateReportRecipientsForSave).not.toHaveBeenCalled()
  })

  it('resuming recomputes next_run_at so a paused schedule does not fire a catch-up run', async () => {
    getCurrentUser.mockResolvedValue({ ...MANAGER, locations: locs(LOC_B), rolesByLocation: { [LOC_B]: 'manager' }, activeLocation: { id: LOC_B } })
    const res = await PATCH(patchReq('s-b-hours', { paused: false }))
    expect(res.status).toBe(200)
    expect(db.writes[0][1].paused).toBe(false)
    expect(new Date(db.writes[0][1].next_run_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('edits frequency and name, recomputing the next run', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const res = await PATCH(patchReq('s-hours', { report_name: 'Monthly hours', frequency: 'monthly', day_of_week: null, day_of_month: 5 }))
    expect(res.status).toBe(200)
    expect(db.writes[0][1]).toMatchObject({ report_name: 'Monthly hours', frequency: 'monthly', day_of_week: null, day_of_month: 5 })
    expect(new Date(db.writes[0][1].next_run_at).getDate()).toBe(5)
  })

  it('400 for an empty change', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    expect((await PATCH(patchReq('s-hours', {}))).status).toBe(400)
  })
})

describe('in-app notification delivery is refused', () => {
  it('POST with deliver_notification: true → 400, nothing written', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const res = await POST(postReq({ ...scheduleBody('staff_hours'), deliver_notification: true }))
    expect(res.status).toBe(400)
    expect(db.writes).toEqual([])
  })

  it('PATCH with deliver_notification: true → 400, nothing written', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const res = await PATCH(patchReq('s-hours', { deliver_notification: true }))
    expect(res.status).toBe(400)
    expect(db.writes).toEqual([])
  })

  it('a new schedule is stored with the option off', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    await POST(postReq(scheduleBody('staff_hours')))
    expect(db.writes[0][1].deliver_notification).toBe(false)
  })
})

describe('staff_cost recipients — external addresses must be confirmed', () => {
  it('POST 409 with the addresses to confirm, and nothing written', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    checkRateReportRecipientsForSave.mockResolvedValue({ refused: [], needsConfirmation: ['someone@example.com'], confirmedExternal: [], lookupFailed: false })
    const res = await POST(postReq(scheduleBody('staff_cost')))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('confirm_external_recipients')
    expect(body.external_recipients).toEqual(['someone@example.com'])
    expect(db.writes).toEqual([])
  })

  it('POST with confirm_external: true stores the confirmed addresses', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    checkRateReportRecipientsForSave.mockResolvedValue(recipientsOk(['someone@example.com']))
    const res = await POST(postReq({ ...scheduleBody('staff_cost'), confirm_external: true }))
    expect(res.status).toBe(201)
    expect(checkRateReportRecipientsForSave).toHaveBeenCalledWith(expect.objectContaining({ locationId: LOC_A, confirmExternal: true, recipients: ['someone@example.com'] }))
    expect(db.writes[0][1].confirmed_external_recipients).toEqual(['someone@example.com'])
  })

  it('POST 400 for a staff address without a rate-viewing role; confirmation cannot override it', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    checkRateReportRecipientsForSave.mockResolvedValue({ refused: ['someone@example.com'], needsConfirmation: [], confirmedExternal: [], lookupFailed: false })
    const res = await POST(postReq({ ...scheduleBody('staff_cost'), confirm_external: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('recipient_not_rate_viewer')
    expect(db.writes).toEqual([])
  })

  it('POST 503 when the recipient lookup fails; nothing written', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    checkRateReportRecipientsForSave.mockResolvedValue({ refused: [], needsConfirmation: [], confirmedExternal: [], lookupFailed: true })
    expect((await POST(postReq(scheduleBody('staff_cost')))).status).toBe(503)
    expect(db.writes).toEqual([])
  })

  it('a non-rate schedule never runs the check', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    await POST(postReq(scheduleBody('staff_hours')))
    expect(checkRateReportRecipientsForSave).not.toHaveBeenCalled()
  })

  it('PATCH recipients passes the schedule\'s existing confirmations as already confirmed', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    checkRateReportRecipientsForSave.mockResolvedValue(recipientsOk(['owner@example.com']))
    const res = await PATCH(patchReq('s-cost', { email_recipients: ['owner@example.com', 'new@example.com'] }))
    expect(res.status).toBe(200)
    expect(checkRateReportRecipientsForSave).toHaveBeenCalledWith(expect.objectContaining({
      previouslyConfirmed: ['owner@example.com'], confirmExternal: false,
    }))
  })

  it('PATCH 409 for a new unconfirmed external address, nothing written', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    checkRateReportRecipientsForSave.mockResolvedValue({ refused: [], needsConfirmation: ['new@example.com'], confirmedExternal: ['owner@example.com'], lookupFailed: false })
    const res = await PATCH(patchReq('s-cost', { email_recipients: ['owner@example.com', 'new@example.com'] }))
    expect(res.status).toBe(409)
    expect(db.writes).toEqual([])
  })
})
