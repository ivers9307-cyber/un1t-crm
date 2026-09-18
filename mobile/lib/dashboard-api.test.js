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
const { fetchStudioDashboard } = await import('./dashboard-api')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const BASE = { newLeadsThisWeek: 3, funnel: { new_lead: 3 }, totalContacts: 3, totalUnreadWhatsapp: 0 }

function routeApi({ timeOff, swaps }) {
  api.mockImplementation((path) => {
    if (path.startsWith('/api/schedule/time-off')) return Promise.resolve(timeOff)
    if (path.startsWith('/api/schedule/swaps')) return Promise.resolve(swaps)
    return Promise.reject(new Error(`unexpected ${path}`))
  })
}

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

    const sw = queryOf('/api/schedule/swaps')
    expect(sw.pathname).toBe('/api/schedule/swaps')
    expect(sw.params).toEqual({ location_id: LOC, status: 'pending' })
    expect(sw.opts).toMatchObject({ locationId: LOC })
  })

  it('merges the named rows into the shared payload', async () => {
    const timeOff = [{ id: 't1', type: 'holiday', profiles: { full_name: 'Coach A' } }]
    const swaps = [{ id: 's1', requester: { full_name: 'Coach B' } }]
    routeApi({ timeOff: { success: true, data: timeOff }, swaps: { success: true, data: swaps } })

    const res = await fetchStudioDashboard(LOC)
    expect(res).toEqual({ success: true, data: { ...BASE, pendingTimeOff: timeOff, pendingSwaps: swaps } })
  })

  it('a failed list is null, not an empty list — "nothing waiting" must never stand in for "could not read"', async () => {
    routeApi({ timeOff: { success: false, error: 'boom' }, swaps: { success: true, data: [{ id: 's1' }] } })
    const res = await fetchStudioDashboard(LOC)
    expect(res.success).toBe(true)
    expect(res.data.pendingTimeOff).toBeNull()
    expect(res.data.pendingSwaps).toEqual([{ id: 's1' }])
  })

  it('a rejected list call is also null and does not blank the rest of the tab', async () => {
    api.mockImplementation((path) => (path.startsWith('/api/schedule/swaps')
      ? Promise.reject(new Error('offline'))
      : Promise.resolve({ success: true, data: [] })))
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
