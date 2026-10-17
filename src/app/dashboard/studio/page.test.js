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
// UN1TREAD.4 — the un1t adapter's own queries are covered by its tests; here its
// reads are stubs so the column's wiring is what is under test.
vi.mock('@/lib/membership/reads/un1t-online', () => {
  const reads = { mrr: vi.fn(), growth: vi.fn(), engagement: vi.fn(), membershipCounts: vi.fn(), membershipFlows: vi.fn(), revenueMtd: vi.fn() }
  return { un1tOnlineReads: Object.freeze(reads) }
})
vi.mock('@shared/studio-kpis', () => ({
  fetchMrr: vi.fn(), fetchGrowth: vi.fn(), fetchRevenueChurn: vi.fn(), fetchEngagement: vi.fn(),
  fetchFloor: vi.fn(), fetchAdSpend: vi.fn(), fetchAcquisition: vi.fn(),
}))

import Page from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { membershipStateForPage } from '@/lib/membership/state-for-page'
import * as kpis from '@shared/studio-kpis'
import { un1tOnlineReads as un1t } from '@/lib/membership/reads/un1t-online'
import { loadRadar } from '@/lib/churn-radar-data'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const LOC2 = 'a0000000-0000-4000-8000-00000000000b'
const CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }
const CONFIGURED = { source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS }
const UN1T = { source: 'un1t_online', state: 'configured', label: 'un1t.online', capabilities: { memberships: false, bookings: false, credits: false, invoices: false, schedule: false } }
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
  un1t.mrr.mockResolvedValue(ok({ mrrCents: 250_000, recurringMembers: 40, yieldCents: 6250 }))
  un1t.growth.mockResolvedValue(ok({ netRecurring: 4, recurringStarts: 6, recurringCancels: 2 }))
  un1t.engagement.mockResolvedValue(ok({ activeRatePct: 55, activeMembers: 22, members: 40, visitsPerMemberWeek: 1.5 }))
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

  // UN1TCAP.1 — a CONFIGURED source whose adapter cannot read MRR must not render a
  // Glofox-shaped scorecard of zeros. (un1t.online used to be this case; since
  // UN1TREAD.4 it reads MRR, so a source nothing registers stands in.)
  it('configured but the adapter reads no MRR: the "does not provide" gate, no KPI queries', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'mystery', state: 'configured', label: 'Mystery', capabilities: { memberships: false } })
    const [html] = await renderColumns()
    expect(html).toContain('Mystery does not provide membership data')
    expect(html).not.toContain('MRR')
    expect(kpis.fetchMrr).not.toHaveBeenCalled()
    expect(kpis.fetchFloor).not.toHaveBeenCalled()
  })

  it('unconfigured: keeps the "selected but not fully configured" copy with the missing names, no queries', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'unconfigured', missing: ['api_key'], label: 'Glofox', capabilities: CAPS })
    const [html] = await renderColumns()
    expect(html).toContain('Glofox is selected but not fully configured')
    expect(html).toContain('api_key')
    expect(kpis.fetchMrr).not.toHaveBeenCalled()
    expect(kpis.fetchAcquisition).not.toHaveBeenCalled()
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

describe('/dashboard/studio — un1t.online column reads through the seam (UN1TREAD.4)', () => {
  const cellOf = (html, label) => {
    const i = html.indexOf(label)
    expect(i).toBeGreaterThan(-1)
    return html.slice(i, i + 600)
  }

  it('un1t.online column: MRR, net growth and active-member rate render from the un1t reads; revenue churn, arrears, at-risk and saves render — (unavailable); the Glofox column is unchanged', async () => {
    membershipStateForPage.mockImplementation(async (_db, id) => (id === LOC ? CONFIGURED : UN1T))
    const [stillorgan, hatch] = await renderColumns()

    // un1t numbers from the un1t adapter
    expect(un1t.mrr).toHaveBeenCalledWith(expect.anything(), LOC2)
    expect(un1t.growth).toHaveBeenCalledWith(expect.anything(), LOC2)
    expect(un1t.engagement).toHaveBeenCalledWith(expect.anything(), LOC2)
    expect(hatch).toContain('€2.5k')
    expect(hatch).toContain('40 billing now')
    expect(hatch).toContain('6 started')
    expect(hatch).toContain('55%')
    expect(hatch).toContain('22 of 40 monthly recurring')
    // not available on un1t: draw '—' + unavailable, never a Glofox zero
    for (const label of ['Revenue churn', 'Arrears', 'At risk', 'At-risk saves']) {
      expect(cellOf(hatch, label)).toContain('unavailable')
    }
    // no Glofox-only read ran for Hatch
    expect(kpis.fetchRevenueChurn).not.toHaveBeenCalledWith(expect.anything(), LOC2, expect.anything())
    expect(loadRadar).not.toHaveBeenCalledWith(expect.anything(), LOC2)
    // UN1TREAD.7 — the acquisition cells are Glofox-fed (contacts.converted_at /
    // pipeline_stage_slug come from the Glofox sync + classifier; joined_at is
    // the Glofox join date), so they are unavailable at Hatch, never zeros
    for (const label of ['New members', 'Trial conversion', 'New leads', 'Trials done', 'CAC']) {
      expect(cellOf(hatch, label)).toContain('unavailable')
    }
    expect(kpis.fetchAcquisition).not.toHaveBeenCalledWith(expect.anything(), LOC2)
    expect(hatch).not.toContain('became members')
    expect(hatch).not.toContain('entered the funnel')
    expect(hatch).not.toContain('Meta spend ÷ new members')
    // class-table reads still run for Hatch
    expect(kpis.fetchFloor).toHaveBeenCalledWith(expect.anything(), LOC2)
    // the Glofox column keeps its acquisition cells
    expect(kpis.fetchAcquisition).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(stillorgan).toContain('became members')

    // Glofox column: same fetchers, same arguments, Glofox churn + radar still run
    expect(kpis.fetchMrr).toHaveBeenCalledTimes(1)
    expect(kpis.fetchMrr).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(kpis.fetchGrowth).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(kpis.fetchEngagement).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(kpis.fetchRevenueChurn).toHaveBeenCalledWith(expect.anything(), LOC, 5000)
    expect(loadRadar).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(stillorgan).toContain('200 billing now')
    expect(stillorgan).toContain('70%')
    expect(un1t.mrr).toHaveBeenCalledTimes(1)
  })

  it('un1t.online with 0 subs and no classes: LocationEmptyState', async () => {
    membershipStateForPage.mockResolvedValue(UN1T)
    un1t.mrr.mockResolvedValue(ok({ mrrCents: 0, recurringMembers: 0, yieldCents: 0 }))
    kpis.fetchFloor.mockResolvedValue(ok({ fillPct: null, noShowPct: null, activation: { activatedPct: null, cohort: 0 }, attendedVisits: 0, classes: 0, groupTable: [], noData: true }))
    const [html] = await renderColumns()
    expect(html).toContain('No membership data has synced yet')
    expect(html).not.toContain('Glofox')
  })

  it('a failed un1t mrr read renders — for MRR and keeps the other cells', async () => {
    membershipStateForPage.mockResolvedValue(UN1T)
    un1t.mrr.mockResolvedValue({ success: false, error: 'boom' })
    const [html] = await renderColumns()
    expect(cellOf(html, 'MRR')).toContain('unavailable')
    expect(html).toContain('6 started')
    expect(html).toContain('55%')
    expect(html).toContain('Grow the base')
  })

  // CAC divides ad spend by Glofox-stamped new members: with spend present but
  // no new-member count it must say unavailable, not print a sublabel over a blank.
  it('un1t.online with ad spend: CAC is unavailable (no Glofox new-member count to divide by)', async () => {
    membershipStateForPage.mockResolvedValue(UN1T)
    kpis.fetchAdSpend.mockResolvedValue(ok({ spend: 900, prevSpend: 800 }))
    const [html] = await renderColumns()
    expect(cellOf(html, 'Ad spend')).toContain('Meta, campaign level')
    expect(cellOf(html, 'CAC')).toContain('unavailable')
    expect(html).not.toContain('Meta spend ÷ new members')
  })

  it('one membership state read per column (the gate and the numbers share one answer)', async () => {
    membershipStateForPage.mockResolvedValue(UN1T)
    await renderColumns()
    expect(membershipStateForPage).toHaveBeenCalledTimes(2) // two columns, one read each
  })
})
