// CONTACTREADSCOPE.1a — route contract for GET /api/dashboard/studio-contacts.
// The counting is pinned in shared/dashboard-data.test.js. Locked here: the
// gate (dashboard_studio AT location_id, never Contacts), the service-role
// client, the Dublin week start, and that a failed read is a 500, not zeros.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'service-role' })) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
vi.mock('@shared/dashboard-data', () => ({ fetchStudioContactCounts: vi.fn() }))

const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { hasPermissionForLocation } = await import('@/lib/permissions')
const { createServerClient } = await import('@/lib/supabase')
const { logError } = await import('@/lib/log')
const { fetchStudioContactCounts } = await import('@shared/dashboard-data')
const { dublinWeekStartMs } = await import('@/lib/dublin-time')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER = { id: 'u1' }
const COUNTS = { newLeadsThisWeek: 3, funnel: { new_lead: 3 }, totalContacts: 9 }

const req = (params = {}) => {
  const url = new URL('http://test/api/dashboard/studio-contacts')
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return { url: url.toString() }
}

beforeEach(() => {
  getCurrentUser.mockReset().mockResolvedValue(USER)
  assertLocationAccess.mockReset().mockReturnValue(null)
  hasPermissionForLocation.mockReset().mockReturnValue(true)
  createServerClient.mockClear()
  logError.mockReset()
  fetchStudioContactCounts.mockReset().mockResolvedValue({ success: true, data: COUNTS })
})

describe('GET /api/dashboard/studio-contacts', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req({ location_id: LOC }))).status).toBe(401)
    expect(fetchStudioContactCounts).not.toHaveBeenCalled()
  })

  it('400 on a missing or malformed location_id', async () => {
    expect((await GET(req({}))).status).toBe(400)
    expect((await GET(req({ location_id: 'nope' }))).status).toBe(400)
    expect(fetchStudioContactCounts).not.toHaveBeenCalled()
  })

  it('assertLocationAccess refusal is passed straight through', async () => {
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }))
    expect((await GET(req({ location_id: LOC }))).status).toBe(403)
    expect(assertLocationAccess).toHaveBeenCalledWith(USER, LOC)
    expect(fetchStudioContactCounts).not.toHaveBeenCalled()
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('403 without dashboard_studio AT that studio; Contacts is never consulted', async () => {
    hasPermissionForLocation.mockReturnValue(false)
    expect((await GET(req({ location_id: LOC }))).status).toBe(403)
    expect(hasPermissionForLocation).toHaveBeenCalledWith(USER, LOC, 'dashboard_studio')
    expect(hasPermissionForLocation.mock.calls.map((c) => c[2])).not.toContain('contacts')
    expect(fetchStudioContactCounts).not.toHaveBeenCalled()
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('200: that ONE studio, the service-role client, the Europe/Dublin Monday', async () => {
    const res = await GET(req({ location_id: LOC }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: COUNTS })
    const [db, loc, opts] = fetchStudioContactCounts.mock.calls[0]
    expect(db).toEqual({ tag: 'service-role' })
    expect(loc).toBe(LOC)
    // the call and this line run within the same Dublin week except across a Monday 00:00
    expect(opts.weekStartIso).toBe(new Date(dublinWeekStartMs(Date.now())).toISOString())
  })

  it('500 on a failed read, logged, never zeros', async () => {
    fetchStudioContactCounts.mockResolvedValue({ success: false, error: 'page down' })
    const res = await GET(req({ location_id: LOC }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read the contact numbers' })
    expect(logError).toHaveBeenCalledWith('dashboard.studio-contacts', 'contact counts read failed',
      { locationId: LOC, error: 'page down' })
  })

  it('a thrown read is the same logged 500', async () => {
    fetchStudioContactCounts.mockRejectedValue(new Error('socket hang up'))
    const res = await GET(req({ location_id: LOC }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read the contact numbers' })
    expect(logError).toHaveBeenCalledWith('dashboard.studio-contacts', 'contact counts read failed',
      { locationId: LOC, error: 'socket hang up' })
  })
})
