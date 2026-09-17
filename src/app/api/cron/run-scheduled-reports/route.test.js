// STAFFCOST.1 — the scheduled-report sender must never email a rate-bearing
// report (staff_cost) to a head coach. The recipient rule runs for real here
// (src/lib/report-recipients.js) against an in-memory DB; only report
// generation, Postmark and the heartbeat are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.example' }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/report-generator', async () => {
  const actual = await vi.importActual('@/lib/report-generator')
  return { ...actual, generateReport: vi.fn() }
})

const { GET } = await import('./route.js')
const { createServerClient } = await import('@/lib/supabase')
const { sendTransactionalEmail } = await import('@/lib/postmark')
const { generateReport } = await import('@/lib/report-generator')
const { filterRateReportRecipients } = await import('@/lib/report-recipients')
const { logWarn } = await import('@/lib/log')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const ORG = 'o0000000-0000-0000-0000-000000000001'

// Real ILIKE semantics (wildcards honoured), so an unescaped pattern in the
// code under test would visibly over-match.
const { ilikeMatches } = await import('@/lib/like-escape.test-helpers')

function makeDb(tables, { failTable } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      const preds = []
      let op = 'select'
      let payload
      const result = () => {
        if (table === failTable) return { data: null, error: { message: 'boom' } }
        if (op === 'update') { updates.push([table, payload]); return { data: null, error: null } }
        return { data: (tables[table] || []).filter(r => preds.every(p => p(r))), error: null }
      }
      const b = {
        select() { return b },
        order() { return b },
        limit() { return b },
        not() { return b },
        lte() { return b },
        eq(col, v) { preds.push(r => r[col] === v); return b },
        ilike(col, pattern) { preds.push(r => ilikeMatches(pattern, r[col])); return b },
        update(p) { op = 'update'; payload = p; return b },
        maybeSingle() {
          const r = result()
          if (r.error) return Promise.resolve(r)
          return Promise.resolve({ data: r.data[0] || null, error: null })
        },
        then(resolve) { resolve(result()) },
      }
      return b
    },
  }
}

const PEOPLE = {
  profiles: [
    { id: 'p-owner', email: 'Owner@Example.com', role: 'owner' },
    { id: 'p-hc', email: 'coach@example.com', role: 'head_coach' },
    { id: 'p-master', email: 'root@example.com', role: 'master' },
    { id: 'p-orgadmin', email: 'org@example.com', role: 'staff' },
    { id: 'p-elsewhere', email: 'far@example.com', role: 'manager' },
    { id: 'p-gone', email: 'gone@example.com', role: 'manager', active: false },
  ],
  profile_locations: [
    { profile_id: 'p-owner', location_id: LOC, role: 'owner' },
    { profile_id: 'p-hc', location_id: LOC, role: 'head_coach' },
    { profile_id: 'p-elsewhere', location_id: 'other-loc', role: 'manager' },
    // Role row left behind after deactivation.
    { profile_id: 'p-gone', location_id: LOC, role: 'manager' },
  ],
  locations: [{ id: LOC, organization_id: ORG }],
  profile_organizations: [{ profile_id: 'p-orgadmin', organization_id: ORG, role: 'org_admin' }],
}

const schedule = (report_type, email_recipients) => ({
  id: `sched-${report_type}`, location_id: LOC, report_type, report_name: 'Weekly', frequency: 'weekly',
  day_of_week: 1, deliver_email: true, email_recipients, deliver_notification: false, created_by: 'p-owner', active: true,
})

function cronReq() {
  return { headers: { get: (h) => (h === 'authorization' ? 'Bearer secret' : null) } }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'secret'
  sendTransactionalEmail.mockResolvedValue({})
  generateReport.mockImplementation(async ({ report_type }) => ({
    success: true,
    data: { id: 'gen-1', report_type, report_name: 'Staff Cost Breakdown', period_start: '2026-09-01', period_end: '2026-09-07', summary: { total_cost: 1234.5, currency: 'EUR' } },
  }))
})

describe('run-scheduled-reports — rate-bearing recipients', () => {
  it('drops a head coach from a staff_cost email and keeps the owner', async () => {
    const db = makeDb({ ...PEOPLE, scheduled_reports: [schedule('staff_cost', ['owner@example.com', 'coach@example.com'])] })
    createServerClient.mockReturnValue(db)

    const body = await (await GET(cronReq())).json()

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    const to = sendTransactionalEmail.mock.calls[0][0].to
    expect(to).toBe('owner@example.com')
    expect(to).not.toContain('coach@')
    expect(body.results[0].recipients_withheld).toBe(1)
    expect(body.results[0].email).toBe('sent')
    // Counts only in the logged body — no withheld address.
    expect(JSON.stringify(body)).not.toContain('coach@example.com')
  })

  it('sends nothing when the only recipient is a head coach', async () => {
    const db = makeDb({ ...PEOPLE, scheduled_reports: [schedule('staff_cost', ['coach@example.com'])] })
    createServerClient.mockReturnValue(db)
    const body = await (await GET(cronReq())).json()
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(body.results[0].email).toBe('withheld')
    expect(logWarn).toHaveBeenCalledWith('run-scheduled-reports', expect.any(String), expect.objectContaining({ scheduleId: 'sched-staff_cost', withheld: 1 }))
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('coach@example.com')
  })

  it('does not filter a non-rate report: a head coach still gets staff_hours', async () => {
    const db = makeDb({ ...PEOPLE, scheduled_reports: [schedule('staff_hours', ['coach@example.com'])] })
    createServerClient.mockReturnValue(db)
    await GET(cronReq())
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(sendTransactionalEmail.mock.calls[0][0].to).toBe('coach@example.com')
  })
})

describe('filterRateReportRecipients', () => {
  it('allows master, owner at the location, org admin without a row, and non-staff addresses', async () => {
    const db = makeDb(PEOPLE)
    const { allowed, dropped } = await filterRateReportRecipients({
      db, locationId: LOC,
      recipients: ['OWNER@example.com', 'root@example.com', 'org@example.com', 'accountant@firm.ie', 'coach@example.com', 'far@example.com'],
    })
    expect(allowed).toEqual(['OWNER@example.com', 'root@example.com', 'org@example.com', 'accountant@firm.ie'])
    expect(dropped).toEqual([
      { email: 'coach@example.com', reason: 'not_rate_viewer' },
      // A manager somewhere else has no business seeing THIS location's pay.
      { email: 'far@example.com', reason: 'not_rate_viewer' },
    ])
  })

  it('withholds a deactivated profile even though its manager role row remains', async () => {
    const db = makeDb(PEOPLE)
    const { allowed, dropped } = await filterRateReportRecipients({ db, locationId: LOC, recipients: ['gone@example.com', 'owner@example.com'] })
    expect(allowed).toEqual(['owner@example.com'])
    expect(dropped).toEqual([{ email: 'gone@example.com', reason: 'not_rate_viewer' }])
  })

  it('treats _ and % in an address literally', async () => {
    const db = makeDb(PEOPLE)
    // As a raw pattern `%@example.com` matches the head coach (and would drop
    // the address). Escaped, it matches no profile, so it is a non-staff address.
    const { allowed } = await filterRateReportRecipients({ db, locationId: LOC, recipients: ['%@example.com'] })
    expect(allowed).toEqual(['%@example.com'])
  })

  it('fails closed per recipient when a lookup errors', async () => {
    const db = makeDb(PEOPLE, { failTable: 'profiles' })
    const { allowed, dropped } = await filterRateReportRecipients({ db, locationId: LOC, recipients: ['owner@example.com'] })
    expect(allowed).toEqual([])
    expect(dropped).toEqual([{ email: 'owner@example.com', reason: 'lookup_failed' }])
  })
})
