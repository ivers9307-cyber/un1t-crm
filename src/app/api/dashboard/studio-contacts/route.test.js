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
// W1.M3c — the state resolver is stubbed; the payload shaping is the real one.
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, membershipStateForPage: vi.fn() }
})

const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { hasPermissionForLocation } = await import('@/lib/permissions')
const { createServerClient } = await import('@/lib/supabase')
const { logError } = await import('@/lib/log')
const { fetchStudioContactCounts } = await import('@shared/dashboard-data')
const { dublinWeekStartMs } = await import('@/lib/dublin-time')
const { membershipStateForPage } = await import('@/lib/membership/state-for-page')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER = { id: 'u1' }
const COUNTS = { newLeadsThisWeek: 3, funnel: { new_lead: 3 }, totalContacts: 9 }
const GLOFOX_CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }
const CONFIGURED = { source: 'glofox', state: 'configured', label: 'Glofox', capabilities: GLOFOX_CAPS }
const CONFIGURED_PAYLOAD = { source: 'glofox', state: 'configured', label: 'Glofox', provides_memberships: true, can_manage: false }

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
  membershipStateForPage.mockReset().mockResolvedValue(CONFIGURED)
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
    expect(await res.json()).toEqual({ success: true, data: { ...COUNTS, membership_source: CONFIGURED_PAYLOAD } })
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

  // W1.M3c — the state rides alongside the counts; the counts are never withheld.
  it('a studio with no membership source: the same counts, plus the none state', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: { memberships: false } })
    const res = await GET(req({ location_id: LOC }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      ...COUNTS,
      membership_source: { source: 'none', state: 'none', label: 'No membership source', provides_memberships: false, can_manage: false },
    })
    expect(membershipStateForPage).toHaveBeenCalledWith({ tag: 'service-role' }, LOC)
  })

  it('an owner at the studio gets can_manage (the phone says "Choose one in…")', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' } })
    const body = await (await GET(req({ location_id: LOC }))).json()
    expect(body.data.membership_source.can_manage).toBe(true)
  })

  it('a failed state read is unknown on the payload, never none, and the counts still answer', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', readError: 'MEMBERSHIP_STATE_THREW', label: 'No membership source', capabilities: {} })
    const body = await (await GET(req({ location_id: LOC }))).json()
    expect(body.success).toBe(true)
    expect(body.data.newLeadsThisWeek).toBe(3)
    expect(body.data.membership_source.state).toBe('unknown')
  })

  // 2.3.x phones never read membership_source: a state read that rejects
  // must never cost them the counts they do read.
  it('a state read that REJECTS is still 200: every old count plus membership_source unknown', async () => {
    membershipStateForPage.mockRejectedValue(new Error('boom'))
    const res = await GET(req({ location_id: LOC }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: {
        ...COUNTS,
        membership_source: { source: null, state: 'unknown', label: null, provides_memberships: true, can_manage: false },
      },
    })
    expect(logError).not.toHaveBeenCalled()
  })

  it('a refused caller never reaches the state read', async () => {
    hasPermissionForLocation.mockReturnValue(false)
    await GET(req({ location_id: LOC }))
    expect(membershipStateForPage).not.toHaveBeenCalled()
  })
})
