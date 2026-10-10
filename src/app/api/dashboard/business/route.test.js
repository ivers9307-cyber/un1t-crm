// W1.M3c — route contract for GET /api/dashboard/business (the phone's
// Business dashboard). The KPI/rail/funnel composition is pinned in its own
// libs; locked here: the gate, that every block keeps its key and shape
// (an older phone bundle reads them blindly), and that `membership_source`
// rides ALONGSIDE them, server-judged, with a failed read as 'unknown'
// (never 'none'). Fictional ids only.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'service-role' })) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn() }))
vi.mock('@shared/dashboard-data', () => ({
  fetchFunnelCounts: vi.fn(),
  fetchAdsSummary: vi.fn(),
  fetchTodayOps: vi.fn(),
}))
vi.mock('@/lib/dashboard/business-kpis', () => ({ buildBusinessKpis: vi.fn() }))
vi.mock('@/lib/dashboard/business-rail', () => ({ buildNeedsYouRail: vi.fn() }))
vi.mock('@/lib/membership-snapshot', () => ({ computeMembershipCounts: vi.fn(), fetchMembershipTrend: vi.fn() }))
// The state resolver is stubbed; the payload shaping and the manage bit are the real ones.
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, membershipStateForPage: vi.fn() }
})

const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { hasPermission } = await import('@/lib/permissions')
const shared = await import('@shared/dashboard-data')
const { buildBusinessKpis } = await import('@/lib/dashboard/business-kpis')
const { buildNeedsYouRail } = await import('@/lib/dashboard/business-rail')
const { computeMembershipCounts, fetchMembershipTrend } = await import('@/lib/membership-snapshot')
const { membershipStateForPage } = await import('@/lib/membership/state-for-page')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'c0000000-0000-4000-8000-000000000001'
const USER = { id: 'u1', profileRole: 'staff', rolesByLocation: { [LOC]: 'manager' }, activeLocation: { id: LOC, name: 'Test Studio' } }

const KPIS = {
  briefing: '2 approvals waiting.',
  revenue: { totalCents: 123400, deltaPct: 4, paidCount: 20 },
  memberCount: 80, churnCount: 3, churnDelta: 1,
  arrearsData: { totalCents: 5000, memberCount: 2 },
}
const FUNNEL = { stages: [{ slug: 'new_lead', count: 4 }], entered: 4, converted: 1, conversionPct: 25 }
const ADS = { spend: 120, results: 6, costPerResult: 20, attributedContacts: 3 }
const LIVE = { monthly_recurring: 60, active_recurring: 58, class_packs: 12, dead_packs: 1, payg: 8, total_members: 80 }
const TREND = [{ month: '2026-09', monthly_recurring: 59, class_packs: 11, payg: 7 }]
const TODAY = { bookedToday: 40, classesToday: 6, staffToday: 3, labourWeekCents: 90000, hoursWeek: 60 }
const RAIL = [{ key: 'approvals', chip: '2', text: '2 approvals', tone: 'purple' }]
const GLOFOX_CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }

beforeEach(() => {
  getCurrentUser.mockReset().mockResolvedValue(USER)
  assertLocationAccess.mockReset().mockReturnValue(null)
  hasPermission.mockReset().mockReturnValue(true)
  shared.fetchFunnelCounts.mockReset().mockResolvedValue({ success: true, data: FUNNEL })
  shared.fetchAdsSummary.mockReset().mockResolvedValue({ success: true, data: ADS })
  shared.fetchTodayOps.mockReset().mockResolvedValue({ success: true, data: TODAY })
  buildBusinessKpis.mockReset().mockResolvedValue(KPIS)
  buildNeedsYouRail.mockReset().mockResolvedValue(RAIL)
  computeMembershipCounts.mockReset().mockResolvedValue(LIVE)
  fetchMembershipTrend.mockReset().mockResolvedValue(TREND)
  membershipStateForPage.mockReset().mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: GLOFOX_CAPS })
})

describe('GET /api/dashboard/business', () => {
  it('401 with no session; 403 without dashboard_business; 400 with no active studio', async () => {
    getCurrentUser.mockResolvedValueOnce(null)
    expect((await GET()).status).toBe(401)
    hasPermission.mockReturnValueOnce(false)
    expect((await GET()).status).toBe(403)
    getCurrentUser.mockResolvedValueOnce({ ...USER, activeLocation: null })
    expect((await GET()).status).toBe(400)
    expect(membershipStateForPage).not.toHaveBeenCalled()
  })

  it('assertLocationAccess refusal is passed straight through', async () => {
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }))
    expect((await GET()).status).toBe(403)
    expect(membershipStateForPage).not.toHaveBeenCalled()
  })

  // Stillorgan's shape: configured glofox. Every block the phone rendered
  // before W1.M3c is present, unchanged; membership_source is the only new key.
  it('a configured studio: the same blocks as before, plus membership_source configured', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: {
        locationName: 'Test Studio',
        kpis: KPIS,
        funnel: FUNNEL,
        ads: ADS,
        membership: { live: LIVE, trend: TREND },
        today: TODAY,
        rail: RAIL,
        membership_source: { source: 'glofox', state: 'configured', label: 'Glofox', provides_memberships: true, can_manage: false },
      },
    })
    expect(membershipStateForPage).toHaveBeenCalledWith({ tag: 'service-role' }, LOC)
  })

  it('a studio with no membership source: state none ALONGSIDE the blocks (older bundles keep their shape)', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: { memberships: false } })
    const { data } = await (await GET()).json()
    expect(data.membership_source).toEqual({ source: 'none', state: 'none', label: 'No membership source', provides_memberships: false, can_manage: false })
    expect(data.kpis).toEqual(KPIS)
    expect(data.membership).toEqual({ live: LIVE, trend: TREND })
  })

  it('unconfigured names the missing credentials; an owner gets can_manage', async () => {
    getCurrentUser.mockResolvedValue({ ...USER, rolesByLocation: { [LOC]: 'owner' } })
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'unconfigured', missing: ['API Key'], label: 'Glofox', capabilities: GLOFOX_CAPS })
    const { data } = await (await GET()).json()
    expect(data.membership_source).toEqual({
      source: 'glofox', state: 'unconfigured', label: 'Glofox', missing: ['API Key'], provides_memberships: true, can_manage: true,
    })
  })

  it('a failed state read is unknown, never none', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} })
    const { data } = await (await GET()).json()
    expect(data.membership_source.state).toBe('unknown')
    expect(data.membership_source).not.toHaveProperty('readError')
  })

  it('a failed block is still null under its own key', async () => {
    computeMembershipCounts.mockResolvedValue(null)
    shared.fetchAdsSummary.mockResolvedValue({ success: false })
    const { data } = await (await GET()).json()
    expect(data.membership).toBeNull()
    expect(data.ads).toBeNull()
    expect(data.membership_source.state).toBe('configured')
  })
})
