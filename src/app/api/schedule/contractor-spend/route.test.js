// SCHEDULE-SPEND-AGG.1 — route-level contract tests for
// GET /api/schedule/contractor-spend.
//
// We mock auth + the spend-compute helper, so the tests lock the
// auth gate (MANAGER_ROLES + location membership), the query-
// validation contract, and the success / 404 / 500 envelopes —
// not the math, which lives in roster-summary.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: vi.fn(),
    // SCHEDROLES.1 — REAL: the role at location_id is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
    // ROLESWEEP.1c — REAL: membership is the canonical guard over user.locations.
    assertLocationAccess: real.assertLocationAccess,
  }
})
// FTECOSTVIS.1 — contractorSpendOnly stays REAL: what a head coach receives is under test.
vi.mock('@/lib/roster-summary-server', async (importOriginal) => ({
  ...(await importOriginal()),
  computeMonthlyContractorSpend: vi.fn(),
}))

const { getCurrentUser, getUserLocationIds } = await import('@/lib/auth')
const { computeMonthlyContractorSpend } = await import('@/lib/roster-summary-server')
const { GET } = await import('./route.js')

beforeEach(() => {
  getCurrentUser.mockReset()
  getUserLocationIds.mockReset()
  computeMonthlyContractorSpend.mockReset()
})

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const buildReq = (params = {}) => {
  const url = new URL('http://test/api/schedule/contractor-spend')
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v)
  }
  return { url: url.toString() }
}

const okParams = { location_id: LOC, reference_date: '2026-05-01' }

describe('GET /api/schedule/contractor-spend — auth', () => {
  it('403 when no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(403)
  })

  it('403 when caller is not in MANAGER_ROLES (staff)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', profileRole: 'staff', rolesByLocation: { [LOC]: 'staff' } })
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(403)
  })

  it('403 when caller is a manager but not a member of the requested location', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'head_coach', profileRole: 'staff', rolesByLocation: { 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb': 'head_coach' }, locations: [{ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }] })
    getUserLocationIds.mockReturnValue(['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'])
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(403)
    expect(computeMonthlyContractorSpend).not.toHaveBeenCalled()
  })

  it('lets a master through for every active location', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'master', profileRole: 'master', rolesByLocation: {}, locations: [{ id: LOC }] })
    computeMonthlyContractorSpend.mockResolvedValue({
      monthStartIso: '2026-05-01', monthEndIso: '2026-05-31',
      contractorCostEur: 0, fteImplicitCostEur: 0, monthlyBudgetEur: null,
      remainingEur: null, overBudget: false, utilisationPct: null,
    })
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(200)
    expect(getUserLocationIds).not.toHaveBeenCalled()
  })

  it('lets a head_coach who is a member of the location through', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'head_coach', profileRole: 'staff', rolesByLocation: { [LOC]: 'head_coach' }, locations: [{ id: LOC }] })
    getUserLocationIds.mockReturnValue([LOC])
    computeMonthlyContractorSpend.mockResolvedValue({
      monthStartIso: '2026-05-01', monthEndIso: '2026-05-31',
      contractorCostEur: 1234.56, fteImplicitCostEur: 200,
      monthlyBudgetEur: 5000, remainingEur: 3765.44,
      overBudget: false, utilisationPct: 25,
    })
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(200)
  })
})

// SCHEDROLES.1 — head coach at LOC, plain staff at LOC_B. The route read
// `user.role` (the ACTIVE studio's) and then checked only membership.
describe('GET /api/schedule/contractor-spend — role at location_id (SCHEDROLES.1)', () => {
  const LOC_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const mixed = (active) => ({
    id: 'mix', role: active === LOC ? 'head_coach' : 'staff', profileRole: 'staff',
    activeLocation: { id: active },
    rolesByLocation: { [LOC]: 'head_coach', [LOC_B]: 'staff' },
    locations: [{ id: LOC }, { id: LOC_B }],
  })
  beforeEach(() => {
    getUserLocationIds.mockReturnValue([LOC, LOC_B])
    computeMonthlyContractorSpend.mockResolvedValue({ contractorCostEur: 1 })
  })

  it('refuses the studio where the caller is staff, and computes nothing', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC))
    const res = await GET(buildReq({ location_id: LOC_B, reference_date: '2026-05-01' }))
    expect(res.status).toBe(403)
    expect(computeMonthlyContractorSpend).not.toHaveBeenCalled()
  })

  it('allows the studio the caller manages', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC))
    expect((await GET(buildReq(okParams))).status).toBe(200)
  })

  it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC_B))
    expect((await GET(buildReq(okParams))).status).toBe(200)
  })
})

describe('GET — query validation', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'master', profileRole: 'master', rolesByLocation: {}, locations: [{ id: LOC }] })
  })

  it('400 when location_id is missing', async () => {
    const res = await GET(buildReq({ reference_date: '2026-05-01' }))
    expect(res.status).toBe(400)
  })

  it('400 when reference_date is missing', async () => {
    const res = await GET(buildReq({ location_id: LOC }))
    expect(res.status).toBe(400)
  })

  it('400 on a malformed reference_date', async () => {
    const res = await GET(buildReq({ location_id: LOC, reference_date: 'not-a-date' }))
    expect(res.status).toBe(400)
  })

  it('400 on a non-uuid location_id', async () => {
    const res = await GET(buildReq({ location_id: 'not-a-uuid', reference_date: '2026-05-01' }))
    expect(res.status).toBe(400)
  })

  // DATECHECK.1 — 2026-02-30 was read as 2 March and answered 200 with
  // MARCH's spend and budget.
  it('400 on a reference_date the calendar does not have, and computes nothing', async () => {
    for (const reference_date of ['2026-02-30', '2026-09-31', '2026-13-01']) {
      const res = await GET(buildReq({ location_id: LOC, reference_date }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('reference_date: Use a real date, YYYY-MM-DD')
    }
    expect(computeMonthlyContractorSpend).not.toHaveBeenCalled()
  })
})

describe('GET — success + error envelopes', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'master', profileRole: 'master', rolesByLocation: {}, locations: [{ id: LOC }] })
  })

  it('returns the aggregate from computeMonthlyContractorSpend', async () => {
    const aggregate = {
      monthStartIso: '2026-05-01', monthEndIso: '2026-05-31',
      contractorCostEur: 4200, fteImplicitCostEur: 800,
      monthlyBudgetEur: 5000, remainingEur: 800,
      overBudget: false, utilisationPct: 84,
    }
    computeMonthlyContractorSpend.mockResolvedValue(aggregate)
    const res = await GET(buildReq(okParams))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data).toEqual(aggregate)
  })

  it('404s when the helper signals LOCATION_NOT_FOUND', async () => {
    const err = new Error('Location not found')
    err.code = 'LOCATION_NOT_FOUND'
    computeMonthlyContractorSpend.mockRejectedValue(err)
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(404)
  })

  it('500s on any other helper failure', async () => {
    computeMonthlyContractorSpend.mockRejectedValue(new Error('db down'))
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(500)
  })
})

// FTECOSTVIS.1 (Richard, 28 Sep 2026: "keep the cost hidden") — the FTE labour
// total is salary-derived, so it goes to owner / manager / master AT
// location_id only. A head coach keeps every contractor figure (a 200, the key
// absent), judged at the studio asked about, never the ACTIVE one.
describe('GET — the FTE labour total goes to owner/manager/master at location_id only (FTECOSTVIS.1)', () => {
  const LOC_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const FULL = {
    monthStartIso: '2026-05-01', monthEndIso: '2026-05-31',
    contractorCostEur: 1234.56, unpublishedContractorCostEur: 100, projectedContractorCostEur: 1334.56,
    fteImplicitCostEur: 850,
    monthlyBudgetEur: 5000, remainingEur: 3765.44, overBudget: false, projectedOverBudget: false, utilisationPct: 25,
  }
  const CONTRACTOR_ONLY = Object.fromEntries(Object.entries(FULL).filter(([k]) => k !== 'fteImplicitCostEur'))
  const at = (rolesByLocation, active) => ({
    id: 'u1', role: rolesByLocation[active], profileRole: 'staff',
    activeLocation: { id: active }, rolesByLocation,
    // ROLESWEEP.1c — membership is read from user.locations (assertLocationAccess).
    locations: Object.keys(rolesByLocation).map((id) => ({ id })),
  })
  const body = async () => {
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(200)
    return (await res.json()).data
  }

  beforeEach(() => {
    getUserLocationIds.mockReturnValue([LOC, LOC_B])
    computeMonthlyContractorSpend.mockResolvedValue({ ...FULL })
  })

  it('a head coach at the studio gets every contractor figure and no FTE labour key', async () => {
    getCurrentUser.mockResolvedValue(at({ [LOC]: 'head_coach' }, LOC))
    const data = await body()
    expect(data).toEqual(CONTRACTOR_ONLY)
    expect(Object.keys(data)).not.toContain('fteImplicitCostEur')
    expect(JSON.stringify(data)).not.toMatch(/fte/i)
  })

  for (const role of ['owner', 'manager']) {
    it(`${role} at the studio still gets the FTE labour total`, async () => {
      getCurrentUser.mockResolvedValue(at({ [LOC]: role }, LOC))
      expect(await body()).toEqual(FULL)
    })
  }

  it('a master still gets it (no per-studio role at all)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'master', profileRole: 'master', rolesByLocation: {}, locations: [{ id: LOC }] })
    expect(await body()).toEqual(FULL)
  })

  it('judged AT location_id: a manager elsewhere (the active studio) who is head coach here does not get it', async () => {
    getCurrentUser.mockResolvedValue(at({ [LOC]: 'head_coach', [LOC_B]: 'manager' }, LOC_B))
    expect(await body()).toEqual(CONTRACTOR_ONLY)
  })

  it('judged AT location_id: a head coach elsewhere (the active studio) who manages here gets it', async () => {
    getCurrentUser.mockResolvedValue(at({ [LOC]: 'manager', [LOC_B]: 'head_coach' }, LOC_B))
    expect(await body()).toEqual(FULL)
  })

  it('fails closed: a figure the helper adds later does not reach a head coach until it is classified', async () => {
    computeMonthlyContractorSpend.mockResolvedValue({ ...FULL, fteProjectedCostEur: 999 })
    getCurrentUser.mockResolvedValue(at({ [LOC]: 'head_coach' }, LOC))
    expect(await body()).toEqual(CONTRACTOR_ONLY)
  })
})
