// WRCPACK.1 — GET /api/schedule/reports/wrc-pack: owner tier only, scoped to
// an organisation the caller can reach, the period checked before any read,
// CSV or JSON. @/lib/auth is the REAL module with only getCurrentUser mocked,
// so assertOrganizationAccess runs against its actual contract.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/wrc-pack', async () => {
  const actual = await vi.importActual('@/lib/wrc-pack')
  return { ...actual, generateWrcPack: vi.fn() }
})
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const { GET } = await import('./route.js')
const { getCurrentUser } = await import('@/lib/auth')
const { generateWrcPack } = await import('@/lib/wrc-pack')

const ORG = 'f1000000-0000-0000-0000-000000000001'
const ORG_2 = 'f2000000-0000-0000-0000-000000000002'
const LOC_A = 'a0000000-0000-0000-0000-000000000001'

const PACK = {
  staff: [{ profile_id: 'p1', full_name: 'Anna Byrne', email: 'a@x.ie', status: 'active', employment_type: 'fte', role: 'staff', studios: 'Stillorgan', first_shift_date: '2026-06-01', last_shift_date: '2026-06-01', contracted_hours_per_week: 40, hourly_rate: 20, rostered_shifts: 1, rostered_hours: 8, sunday_shifts: 0, sunday_hours: 0, weeks_over_contract: 0, overtime_hours: 0, holiday_days: 0, sick_days: 0, other_leave_days: 0, allowance_year: 2026, allowance_total_days: 20, allowance_used_days: 0, allowance_carried_over: 0, contract_signed: true, contract_signed_at: '2026-01-01T00:00:00Z', handbook_version: 2, handbook_viewed: true }],
  shifts: [{ assignment_id: 'as1', date: '2026-06-01', weekday: 'Mon', sunday: false, profile_id: 'p1', full_name: 'Anna Byrne', email: 'a@x.ie', studio: 'Stillorgan', shift: 'Day', rostered_start: '09:00', rostered_end: '17:00', adjusted_start: '09:00', adjusted_end: '17:00', hours: 8, arrived_at: null, arrived_local: '', status: 'scheduled', cancelled: false }],
}

function owner(over = {}) {
  return {
    id: 'u1', isMaster: false, role: 'owner', profileRole: 'owner',
    locations: [{ id: LOC_A, organization_id: ORG }],
    rolesByLocation: { [LOC_A]: 'owner' },
    organizationsById: { [ORG]: { id: ORG } },
    orgAdminOrgIds: [],
    activeLocation: { id: LOC_A, organization_id: ORG, timezone: 'Europe/Dublin' },
    activeOrganization: { id: ORG },
    ...over,
  }
}

const req = (q = '') => new Request(`http://x/api/schedule/reports/wrc-pack${q}`)

beforeEach(() => {
  vi.clearAllMocks()
  generateWrcPack.mockResolvedValue({ pack: PACK, locations: [{ id: LOC_A, name: 'Stillorgan' }], error: null })
})

describe('GET /api/schedule/reports/wrc-pack', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req())).status).toBe(401)
  })

  it('403 for a manager, even at the organisation', async () => {
    getCurrentUser.mockResolvedValue(owner({ role: 'manager', profileRole: 'manager', rolesByLocation: { [LOC_A]: 'manager' } }))
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(generateWrcPack).not.toHaveBeenCalled()
  })

  it('403 for an owner asking about another organisation', async () => {
    getCurrentUser.mockResolvedValue(owner())
    const res = await GET(req(`?organization_id=${ORG_2}`))
    expect(res.status).toBe(403)
    expect(generateWrcPack).not.toHaveBeenCalled()
  })

  it('a master may ask about any organisation', async () => {
    getCurrentUser.mockResolvedValue(owner({ isMaster: true, role: 'master', profileRole: 'master' }))
    const res = await GET(req(`?organization_id=${ORG_2}&from=2026-01-01&to=2026-01-31`))
    expect(res.status).toBe(200)
    expect(generateWrcPack).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG_2, from: '2026-01-01', to: '2026-01-31', year: 2026 })
  })

  it('defaults to the active organisation and the 12 months ending today, and answers JSON', async () => {
    getCurrentUser.mockResolvedValue(owner())
    const res = await GET(req())
    expect(res.status).toBe(200)
    const args = generateWrcPack.mock.calls[0][1]
    expect(args.organizationId).toBe(ORG)
    expect(args.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const days = (Date.parse(`${args.to}T00:00:00Z`) - Date.parse(`${args.from}T00:00:00Z`)) / 86400000 + 1
    expect(days).toBeLessThanOrEqual(366)
    expect(days).toBeGreaterThanOrEqual(365)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.staff).toHaveLength(1)
    expect(body.data.shifts).toHaveLength(1)
    expect(body.data.period).toEqual({ from: args.from, to: args.to })
  })

  it('refuses a bad period before any read', async () => {
    getCurrentUser.mockResolvedValue(owner())
    for (const q of ['?from=2026-02-30&to=2026-03-01', '?from=2026-03-01&to=2026-02-01', '?from=2025-01-01&to=2026-12-31', '?organization_id=nope']) {
      const res = await GET(req(q))
      expect(res.status, q).toBe(400)
    }
    expect(generateWrcPack).not.toHaveBeenCalled()
  })

  it('format=csv streams the staff CSV by default, the shifts CSV on file=shifts, as attachments', async () => {
    getCurrentUser.mockResolvedValue(owner())
    const staff = await GET(req('?format=csv&from=2026-01-01&to=2026-06-30'))
    expect(staff.status).toBe(200)
    expect(staff.headers.get('content-type')).toContain('text/csv')
    expect(staff.headers.get('content-disposition')).toBe('attachment; filename="wrc-staff-2026-01-01-to-2026-06-30.csv"')
    const staffText = await staff.text()
    expect(staffText.split('\n')[0]).toMatch(/^Full name,Email,/)
    expect(staffText).toContain('Anna Byrne')

    const shifts = await GET(req('?format=csv&file=shifts&from=2026-01-01&to=2026-06-30'))
    expect(shifts.headers.get('content-disposition')).toBe('attachment; filename="wrc-shifts-2026-01-01-to-2026-06-30.csv"')
    const text = await shifts.text()
    expect(text.split('\n')[0]).toMatch(/^Date,Weekday,Sunday,/)
    expect(text).toContain('2026-06-01,Mon,no,,Anna Byrne')   // LIEU.1: a "Public holiday" column follows Sunday

    expect((await GET(req('?format=pdf'))).status).toBe(400)
    expect((await GET(req('?format=csv&file=everything'))).status).toBe(400)
  })

  it('a failed read is a 500 with no database words, never an empty pack', async () => {
    getCurrentUser.mockResolvedValue(owner())
    generateWrcPack.mockResolvedValue({ pack: null, locations: [], error: 'Failed to read staff profiles: relation is down' })
    const res = await GET(req('?format=csv'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).not.toContain('relation')
  })
})
