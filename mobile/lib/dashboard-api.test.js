// STUDIODASH.1 — the mobile Studio tab's pending time-off + swap lists.
//
// They used to ride inside shared/dashboard-data.js's direct select on the
// mobile (authenticated) client, embedding `profiles!…(full_name)`. That role
// has no grant on public.profiles (mig 153b), so both selects 500'd and the
// fetcher's `|| []` rendered "Nothing waiting on you." for every manager. The
// lists now come from the service-role /api/schedule routes (which already
// embed names), and a failed load is `null` — never an empty list.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./supabase', () => ({ supabase: { tag: 'rls-client' } }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('shared/dashboard-data', () => ({
  fetchPersonalDashboardData: vi.fn(),
  fetchStudioDashboardData: vi.fn(),
}))

const { api } = await import('./api')
const shared = await import('shared/dashboard-data')
const { fetchStudioDashboard, fetchRosterRunway, swapRowTitle } = await import('./dashboard-api')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const BASE = { newLeadsThisWeek: 3, funnel: { new_lead: 3 }, totalContacts: 3, totalUnreadWhatsapp: 0 }

// `swaps` is one envelope for both status calls, or { pending, awaiting_approval }.
function routeApi({ timeOff, swaps, runway = { success: true, data: { runway: null } } }) {
  api.mockImplementation((path) => {
    if (path.startsWith('/api/schedule/runway')) return runway instanceof Error ? Promise.reject(runway) : Promise.resolve(runway)
    if (path.startsWith('/api/schedule/time-off')) return Promise.resolve(timeOff)
    if (path.startsWith('/api/schedule/swaps')) {
      const status = new URLSearchParams(path.split('?')[1]).get('status')
      const env = 'success' in swaps ? swaps : swaps[status]
      return env instanceof Error ? Promise.reject(env) : Promise.resolve(env)
    }
    return Promise.reject(new Error(`unexpected ${path}`))
  })
}
const OK_EMPTY = { success: true, data: [] }

function queryOf(prefix) {
  const [path, opts] = api.mock.calls.find(([p]) => p.startsWith(prefix))
  return { pathname: path.split('?')[0], params: Object.fromEntries(new URLSearchParams(path.split('?')[1] || '')), opts }
}

beforeEach(() => {
  api.mockReset()
  shared.fetchStudioDashboardData.mockReset()
  shared.fetchStudioDashboardData.mockResolvedValue({ success: true, data: { ...BASE } })
})

describe('fetchStudioDashboard', () => {
  it('reads both pending lists through the service-role schedule routes, scoped to the location', async () => {
    routeApi({ timeOff: { success: true, data: [] }, swaps: { success: true, data: [] } })
    await fetchStudioDashboard(LOC)

    const off = queryOf('/api/schedule/time-off')
    expect(off.pathname).toBe('/api/schedule/time-off')
    expect(off.params).toEqual({ location_id: LOC, status: 'pending' })
    expect(off.opts).toMatchObject({ locationId: LOC })

    // STUDIODASH.2 — the manager's swap queue is the web approvals
    // provider's: pending (open/targeted, or a drop approvable directly) AND
    // awaiting_approval (a coach claimed it). One call per status — the
    // route takes a single status.
    const swapCalls = api.mock.calls.filter(([p]) => p.startsWith('/api/schedule/swaps'))
    expect(swapCalls.map(([p]) => Object.fromEntries(new URLSearchParams(p.split('?')[1]))))
      .toEqual(expect.arrayContaining([
        { location_id: LOC, status: 'pending' },
        { location_id: LOC, status: 'awaiting_approval' },
      ]))
    expect(swapCalls).toHaveLength(2)
    for (const [, opts] of swapCalls) expect(opts).toMatchObject({ locationId: LOC })
  })

  it('merges both swap statuses newest-first', async () => {
    const older = { id: 's1', status: 'pending', created_at: '2026-09-10T10:00:00Z' }
    const newer = { id: 's2', status: 'awaiting_approval', created_at: '2026-09-12T10:00:00Z' }
    routeApi({ timeOff: OK_EMPTY, swaps: {
      pending: { success: true, data: [older] },
      awaiting_approval: { success: true, data: [newer] },
    } })
    const res = await fetchStudioDashboard(LOC)
    expect(res.data.pendingSwaps.map((s) => s.id)).toEqual(['s2', 's1'])
  })

  it('either swap call failing makes the swap list null — a half list would hide approvals', async () => {
    routeApi({ timeOff: OK_EMPTY, swaps: {
      pending: { success: true, data: [{ id: 's1', created_at: '2026-09-10T10:00:00Z' }] },
      awaiting_approval: { success: false, error: 'boom' },
    } })
    const res = await fetchStudioDashboard(LOC)
    expect(res.data.pendingSwaps).toBeNull()
    expect(res.data.pendingTimeOff).toEqual([])
  })

  it('merges the named rows into the shared payload', async () => {
    const timeOff = [{ id: 't1', type: 'holiday', profiles: { full_name: 'Coach A' } }]
    const swap = { id: 's1', created_at: '2026-09-10T10:00:00Z', requester: { full_name: 'Coach B' } }
    routeApi({ timeOff: { success: true, data: timeOff }, swaps: {
      pending: { success: true, data: [swap] },
      awaiting_approval: OK_EMPTY,
    } })

    const res = await fetchStudioDashboard(LOC)
    expect(res).toEqual({ success: true, data: { ...BASE, pendingTimeOff: timeOff, pendingSwaps: [swap], rosterRunway: null } })
  })

  it('a failed list is null, not an empty list — "nothing waiting" must never stand in for "could not read"', async () => {
    routeApi({ timeOff: { success: false, error: 'boom' }, swaps: OK_EMPTY })
    const res = await fetchStudioDashboard(LOC)
    expect(res.success).toBe(true)
    expect(res.data.pendingTimeOff).toBeNull()
    expect(res.data.pendingSwaps).toEqual([])
  })

  it('a rejected list call is also null and does not blank the rest of the tab', async () => {
    routeApi({ timeOff: OK_EMPTY, swaps: { pending: OK_EMPTY, awaiting_approval: new Error('offline') } })
    const res = await fetchStudioDashboard(LOC)
    expect(res.success).toBe(true)
    expect(res.data.pendingSwaps).toBeNull()
    expect(res.data.pendingTimeOff).toEqual([])
  })

  it('passes the shared fetcher failure straight through', async () => {
    routeApi({ timeOff: { success: true, data: [] }, swaps: { success: true, data: [] } })
    shared.fetchStudioDashboardData.mockResolvedValue({ success: false, error: 'No location' })
    expect(await fetchStudioDashboard(LOC)).toEqual({ success: false, error: 'No location' })
  })
})

// RUNWAY.1 — the Studio tab's roster-runway chip.
describe('fetchStudioDashboard — roster runway', () => {
  const RUNWAY = {
    weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
    blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
  }

  it('reads the runway through the manager-gated route, scoped to the location', async () => {
    routeApi({ timeOff: OK_EMPTY, swaps: OK_EMPTY, runway: { success: true, data: { runway: RUNWAY } } })
    const res = await fetchStudioDashboard(LOC)
    expect(res.data.rosterRunway).toEqual(RUNWAY)
    const call = queryOf('/api/schedule/runway')
    expect(call.pathname).toBe('/api/schedule/runway')
    expect(call.params).toEqual({ location_id: LOC })
    expect(call.opts).toMatchObject({ locationId: LOC })
  })

  it('a 403 envelope, a rejected call and a ready studio are all null: no chip, and the tab still loads', async () => {
    for (const runway of [{ success: false, error: 'Unauthorized' }, new Error('offline'), { success: true, data: { runway: null } }]) {
      routeApi({ timeOff: OK_EMPTY, swaps: OK_EMPTY, runway })
      const res = await fetchStudioDashboard(LOC)
      expect(res.success).toBe(true)
      expect(res.data.rosterRunway).toBeNull()
      expect(res.data.pendingTimeOff).toEqual([])
    }
  })

  // DEPLOY ORDER: the merge publishes the OTA and deploys the route together,
  // and either can land first. A phone on the new bundle that reaches a
  // not-yet-deployed route gets Next's HTML 404, which api() turns into a
  // transport envelope (or, behind a JSON edge, a bare { success: false,
  // status: 404 }). Both must be SILENT: no chip, no thrown error, no banner,
  // and the rest of the Studio tab still loads.
  it('a 404 from a not-yet-deployed route is silent: null, and the tab still loads', async () => {
    for (const runway of [
      { success: false, transport: true, status: 404, error: 'Non-JSON response (404)' },
      { success: false, status: 404, error: 'HTTP 404' },
    ]) {
      routeApi({ timeOff: OK_EMPTY, swaps: OK_EMPTY, runway })
      await expect(fetchRosterRunway(LOC)).resolves.toBeNull()
      const res = await fetchStudioDashboard(LOC)
      expect(res).toEqual({ success: true, data: { ...BASE, pendingTimeOff: [], pendingSwaps: [], rosterRunway: null } })
    }
  })

  it('a success envelope with no usable runway is null, never undefined', async () => {
    for (const runway of [{ success: true }, { success: true, data: {} }, { success: true, data: null }, null, undefined]) {
      routeApi({ timeOff: OK_EMPTY, swaps: OK_EMPTY, runway })
      expect(await fetchRosterRunway(LOC)).toBeNull()
    }
  })
})

describe('swapRowTitle — same wording as the web approvals queue', () => {
  it('names both sides of a two-way or reassign swap', () => {
    expect(swapRowTitle({ status: 'pending', requester: { full_name: 'Ann' }, target: { full_name: 'Bo' } }))
      .toBe('Ann ↔ Bo')
  })
  it('an untargeted swap is a drop', () => {
    expect(swapRowTitle({ status: 'pending', requester: { full_name: 'Ann' }, target: null })).toBe('Ann (drop)')
  })
  it('marks a claimed swap — the one waiting on the manager', () => {
    expect(swapRowTitle({ status: 'awaiting_approval', requester: { full_name: 'Ann' }, target: { full_name: 'Bo' } }))
      .toBe('Ann ↔ Bo — claimed')
  })
  it('falls back to "Coach" without a name', () => {
    expect(swapRowTitle({ status: 'pending' })).toBe('Coach (drop)')
  })
})

describe('shared fetchStudioDashboardData never embeds profiles', () => {
  it('its selects carry no profiles embed (mobile calls it on the authenticated client)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../shared/dashboard-data.js', import.meta.url), 'utf8')
    const start = src.indexOf('export async function fetchStudioDashboardData')
    const end = src.indexOf('\nexport ', start + 1)
    const body = src.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    // Strip comments so the explanation of the old bug doesn't trip it.
    const code = body.replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/profiles/)
  })
})
