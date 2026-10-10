// W1.M3a — /dashboard/studio: each location column gates on ITS membership
// source (the board is per-studio). Configured → the scorecard exactly as
// before; none → the gate copy and NO KPI queries; unknown → retry copy.
// The old data inference ("0 recurring + no class sync = not connected")
// stays as a "nothing synced yet" state for a configured studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true), hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((u) => { throw new Error(`NEXT_REDIRECT:${u}`) }) }))
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => ({ ...(await importOriginal()), membershipStateForPage: vi.fn() }))
vi.mock('@/lib/churn-radar-data', () => ({ loadRadar: vi.fn(async () => ({ summary: null })) }))
vi.mock('@shared/studio-kpis', () => ({
  fetchMrr: vi.fn(), fetchGrowth: vi.fn(), fetchRevenueChurn: vi.fn(), fetchEngagement: vi.fn(),
  fetchFloor: vi.fn(), fetchAdSpend: vi.fn(), fetchAcquisition: vi.fn(),
}))

import Page from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { membershipStateForPage } from '@/lib/membership/state-for-page'
import * as kpis from '@shared/studio-kpis'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const LOC2 = 'a0000000-0000-4000-8000-00000000000b'
const CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }
const CONFIGURED = { source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS }
const NONE = { source: 'none', state: 'none', label: 'No membership source', capabilities: {} }

function findElements(node, name, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => findElements(n, name, out)); return out }
  if (typeof node.type === 'function' && node.type.name === name) out.push(node)
  findElements(node.props?.children, name, out)
  return out
}

async function renderColumns() {
  const tree = await Page()
  const cols = findElements(tree, 'LocationColumn')
  expect(cols.length).toBeGreaterThan(0)
  const out = []
  for (const el of cols) out.push(renderToStaticMarkup(await el.type(el.props)))
  return out
}

const ok = (data) => ({ success: true, data })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({
    id: 'u1', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner', [LOC2]: 'owner' },
    activeLocation: { id: LOC, name: 'Stillorgan' }, activeOrganization: { id: 'org' },
    locations: [{ id: LOC, name: 'Stillorgan', organization_id: 'org' }, { id: LOC2, name: 'Hatch', organization_id: 'org' }],
  })
  kpis.fetchMrr.mockResolvedValue(ok({ mrrCents: 1_000_000, recurringMembers: 200, yieldCents: 5000 }))
  kpis.fetchGrowth.mockResolvedValue(ok({ netRecurring: 3, recurringStarts: 10, recurringCancels: 7 }))
  kpis.fetchRevenueChurn.mockResolvedValue(ok({ churnCents: 0, total: 0, early: 0, tenured: 0, estimatedCount: 0 }))
  kpis.fetchAcquisition.mockResolvedValue(ok({ newMembers: 5, leads: 20, conversionPct: 25, trialsDone: 3 }))
  kpis.fetchEngagement.mockResolvedValue(ok({ activeRatePct: 70, activeMembers: 140, members: 200, visitsPerMemberWeek: 2.1 }))
  kpis.fetchFloor.mockResolvedValue(ok({ fillPct: 72, noShowPct: 8, activation: { activatedPct: 50, cohort: 4 }, attendedVisits: 900, classes: 100, groupTable: [], noData: false }))
  kpis.fetchAdSpend.mockResolvedValue(ok({ spend: 0, prevSpend: 0 }))
})

describe('/dashboard/studio — per-column membership gate (W1.M3a)', () => {
  it('configured: the scorecard renders as before (MRR, the role sections), no gate copy', async () => {
    membershipStateForPage.mockResolvedValue(CONFIGURED)
    const [html] = await renderColumns()
    expect(kpis.fetchMrr).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(html).toContain('MRR')
    expect(html).toContain('Grow the base')
    expect(html).not.toContain('No membership source connected')
    expect(html).not.toContain('data-membership-state')
  })

  it('none: the gate copy for THAT column and no KPI queries for it; the configured column is untouched', async () => {
    membershipStateForPage.mockImplementation(async (_db, id) => (id === LOC ? CONFIGURED : NONE))
    const [stillorgan, hatch] = await renderColumns()
    expect(stillorgan).toContain('MRR')
    expect(hatch).toContain('No membership source connected')
    expect(hatch).not.toContain('MRR')
    expect(hatch).toContain(`href="/settings/locations/${LOC2}?section=integrations&amp;tab=glofox"`)
    expect(kpis.fetchMrr).toHaveBeenCalledTimes(1)
    expect(kpis.fetchMrr).toHaveBeenCalledWith(expect.anything(), LOC)
  })

  it('unknown: the retry copy, never the none copy, no queries', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} })
    const [html] = await renderColumns()
    expect(html).toContain('Membership data could not be read right now')
    expect(html).not.toContain('No membership source connected')
    expect(kpis.fetchMrr).not.toHaveBeenCalled()
  })

  it('configured but nothing synced yet (0 recurring, no class data): a source-neutral "nothing synced" note, not zeros and not "no source"', async () => {
    membershipStateForPage.mockResolvedValue(CONFIGURED)
    kpis.fetchMrr.mockResolvedValue(ok({ mrrCents: 0, recurringMembers: 0, yieldCents: 0 }))
    kpis.fetchFloor.mockResolvedValue(ok({ fillPct: null, noShowPct: null, activation: { activatedPct: null, cohort: 0 }, attendedVisits: 0, classes: 0, groupTable: [], noData: true }))
    const [html] = await renderColumns()
    expect(html).toContain('No membership data has synced yet')
    expect(html).not.toContain('Glofox')
    expect(html).not.toContain('No membership source connected')
  })
})
