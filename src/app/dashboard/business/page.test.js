// W1.M3a — /dashboard/business gates ONLY the membership trend block
// (MembershipBlock) on the membership source. The other blocks are
// untouched. The page is a tree of Suspense-wrapped async blocks, so the
// test renders the page element, finds the block, and renders THAT.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((u) => { throw new Error(`NEXT_REDIRECT:${u}`) }) }))
// UN1TREAD.3 — the un1t adapter's own reads are tested in reads/un1t-online.test.js; here they are stubs.
vi.mock('@/lib/membership/reads/un1t-online', () => ({
  un1tOnlineReads: Object.freeze({ membershipCounts: vi.fn(), membershipFlows: vi.fn() , revenueMtd: vi.fn() }),
}))
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => ({ ...(await importOriginal()), membershipStateForPage: vi.fn() }))
vi.mock('@/lib/membership-snapshot', () => ({ computeMembershipCounts: vi.fn() }))
vi.mock('@/lib/membership-flows', () => ({ fetchMembershipFlows: vi.fn() }))
vi.mock('@/components/dashboard/MembershipPanel', () => ({ MembershipPanel: ({ live }) => <div>{`membership-panel:${live.active}`}</div> }))
vi.mock('@/lib/labour-month-model', () => ({ canSeeLabour: () => false, labourStudiosFor: () => [] }))
vi.mock('@/lib/dashboard/business-kpis', () => ({ buildBusinessKpis: vi.fn() }))

import Page from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { membershipStateForPage } from '@/lib/membership/state-for-page'
import { computeMembershipCounts } from '@/lib/membership-snapshot'
import { fetchMembershipFlows } from '@/lib/membership-flows'
import { un1tOnlineReads } from '@/lib/membership/reads/un1t-online'
import { buildBusinessKpis } from '@/lib/dashboard/business-kpis'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }

// Depth-first search of a React element tree for a component by name.
function findElement(node, name) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const f = findElement(n, name); if (f) return f }; return null }
  if (typeof node.type === 'function' && node.type.name === name) return node
  return findElement(node.props?.children, name)
}

async function renderBlock(name) {
  const tree = await Page()
  const el = findElement(tree, name)
  expect(el, `${name} is on the page`).toBeTruthy()
  return renderToStaticMarkup(await el.type(el.props))
}
const renderMembershipBlock = () => renderBlock('MembershipBlock')

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' }, activeLocation: { id: LOC, name: 'Studio' }, locations: [] })
  computeMembershipCounts.mockResolvedValue({ active: 412 })
  fetchMembershipFlows.mockResolvedValue([])
  buildBusinessKpis.mockResolvedValue({
    revenue: { totalCents: 1_234_500, deltaPct: 4, paidCount: 300 },
    arrearsData: { totalCents: 45_000, memberCount: 3 },
    memberCount: 412, churnCount: 7, churnDelta: 2, briefing: '2 pending approvals',
    gate: { state: 'configured', showNumbers: true },
  })
})

// What the real buildBusinessKpis returns when the source is not configured:
// zero revenue (never null) and gate.showNumbers false.
const numberless = (state) => ({
  revenue: { totalCents: 0, paidCount: 0, deltaPct: null },
  arrearsData: null, memberCount: null, churnCount: null, churnDelta: null, briefing: '2 pending approvals',
  gate: { state, showNumbers: false },
})

describe('/dashboard/business — membership trend gate (W1.M3a)', () => {
  it('configured: the trend block reads and renders as before', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    const html = await renderMembershipBlock()
    expect(computeMembershipCounts).toHaveBeenCalledWith(expect.anything(), LOC)
    // TZ.11a — the flows are bucketed on the active studio's calendar (no
    // timezone on this user's location: the Dublin floor).
    expect(fetchMembershipFlows).toHaveBeenCalledWith(expect.anything(), LOC, 12, undefined, { zone: 'Europe/Dublin' })
    expect(html).toContain('membership-panel:412')
    expect(html).not.toContain('No membership source connected')
  })

  it('none: the gate copy instead of a zero trend, and the trend queries do not run', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: {} })
    const html = await renderMembershipBlock()
    expect(computeMembershipCounts).not.toHaveBeenCalled()
    expect(fetchMembershipFlows).not.toHaveBeenCalled()
    expect(html).toContain('No membership source connected')
    expect(html).toContain(`href="/settings/locations/${LOC}?section=integrations&amp;tab=glofox"`)
    expect(html).not.toContain('membership-panel')
  })

  // UN1TCAP.1 — configured on un1t.online, which supplies no membership data yet.
  it('configured, source reads no counts or flows (an adapter with neither): the "does not provide" gate, no trend queries', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'unregistered', state: 'configured', label: 'Other', capabilities: { memberships: false } })
    const html = await renderMembershipBlock()
    expect(computeMembershipCounts).not.toHaveBeenCalled()
    expect(fetchMembershipFlows).not.toHaveBeenCalled()
    expect(html).toContain('Other does not provide membership data')
    expect(html).not.toContain('membership-panel')
  })

  it('unknown: the retry copy, never the none copy', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} })
    const html = await renderMembershipBlock()
    expect(html).toContain('Membership data could not be read right now')
    expect(html).not.toContain('No membership source connected')
    expect(computeMembershipCounts).not.toHaveBeenCalled()
  })

  it('the funnel, today and rail blocks are not gated and never ask the membership state', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: {} })
    const tree = await Page()
    for (const name of ['KpiBriefingBlock', 'FunnelAdsBlock', 'TodayBlock', 'RailBlock']) {
      expect(findElement(tree, name), name).toBeTruthy()
    }
    expect(membershipStateForPage).not.toHaveBeenCalled() // only the gated blocks ask, and only when rendered
  })
})

// The KPI row is Glofox-derived end to end (Revenue MTD + In arrears read
// glofox_invoices, Members the membership counts, Churn risk the radar).
describe('/dashboard/business — KPI row gate (W1.M3a review)', () => {
  it('configured: briefing + the four tiles exactly as before, no gate copy', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    const html = await renderBlock('KpiBriefingBlock')
    expect(buildBusinessKpis).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'u1' }), LOC)
    expect(html).toContain('2 pending approvals')
    for (const label of ['Revenue MTD', 'Members', 'Churn risk', 'In arrears']) expect(html).toContain(`>${label}<`)
    expect(html).toContain('412')
    expect(html).not.toContain('No membership source connected')
    expect(html).not.toContain('data-membership-state')
  })

  it('none: the briefing line stays, the tiles are replaced by the gate (no zeros)', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: {} })
    buildBusinessKpis.mockResolvedValue(numberless('none'))
    const html = await renderBlock('KpiBriefingBlock')
    expect(html).toContain('2 pending approvals')
    expect(html).toContain('No membership source connected')
    expect(html).toContain(`href="/settings/locations/${LOC}?section=integrations&amp;tab=glofox"`)
    for (const label of ['Revenue MTD', 'Members', 'Churn risk', 'In arrears']) expect(html).not.toContain(`>${label}<`)
  })

  it('unknown: the retry copy, never the none copy', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} })
    buildBusinessKpis.mockResolvedValue(numberless('unknown'))
    const html = await renderBlock('KpiBriefingBlock')
    expect(html).toContain('Membership data could not be read right now')
    expect(html).not.toContain('No membership source connected')
    expect(html).not.toContain('>Members<')
  })

  it('a failed KPI build is still the block error, state or no state', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: {} })
    buildBusinessKpis.mockResolvedValue(null)
    const html = await renderBlock('KpiBriefingBlock')
    expect(html).toContain('Headline numbers')
    expect(html).not.toContain('No membership source connected')
  })
})

// UN1TREAD.7 — the trend block asks the seam ONCE and draws its gate from that
// same answer (as the studio column does): a second, separately resolved state
// could disagree with the reads and draw a blank section.
describe('/dashboard/business — MembershipBlock gate comes from the reads result (UN1TREAD.7)', () => {
  it('asks the membership state exactly once (no parallel state read)', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    await renderMembershipBlock()
    expect(membershipStateForPage).toHaveBeenCalledTimes(1)
  })

  it('divergent case: a configured source whose capabilities say memberships:true but whose adapter reads nothing draws the "does not provide" copy, never a blank section', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'unregistered', state: 'configured', label: 'Other', capabilities: CAPS })
    const html = await renderMembershipBlock()
    expect(html).toContain('Other does not provide membership data')
    expect(html).not.toContain('membership-panel')
    expect(computeMembershipCounts).not.toHaveBeenCalled()
  })

  it('the seam answer carries the gate copy for the missing-credentials and unknown states', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'unconfigured', missing: ['api_key'], label: 'Glofox', capabilities: CAPS })
    const html = await renderMembershipBlock()
    expect(html).toContain('Glofox is selected but not fully configured')
    expect(html).toContain('api_key')
  })
})

describe('/dashboard/business — the active studio zone (TZ.11a)', () => {
  it('a New York studio buckets its membership flows on New York months', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' }, activeLocation: { id: LOC, name: 'Studio', timezone: 'America/New_York' }, locations: [] })
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    await renderMembershipBlock()
    expect(fetchMembershipFlows).toHaveBeenCalledWith(expect.anything(), LOC, 12, undefined, { zone: 'America/New_York' })
  })
})

// UN1TREAD.3 — un1t.online (Hatch Street) is configured with every Glofox-shaped
// capability false, yet its adapter reads member counts, flows and revenue.
describe('/dashboard/business — un1t.online reads through the seam (UN1TREAD.3)', () => {
  const UN1T = { source: 'un1t_online', state: 'configured', label: 'un1t.online', capabilities: { memberships: false, bookings: false, credits: false, invoices: false, schedule: false } }
  beforeEach(() => {
    un1tOnlineReads.membershipCounts.mockReset().mockResolvedValue({ active: 33 })
    un1tOnlineReads.membershipFlows.mockReset().mockResolvedValue({ months: [], cancelTrackingStart: '2026-10-16' })
    membershipStateForPage.mockResolvedValue(UN1T)
  })

  it('un1t.online: KPI row shows Revenue and Members from the un1t reads, Churn risk and In arrears render —', async () => {
    buildBusinessKpis.mockResolvedValue({
      revenue: { totalCents: 640_000, deltaPct: null, paidCount: 31 },
      arrearsData: null, memberCount: 33, churnCount: null, churnDelta: null, briefing: 'Nothing urgent.',
      gate: { state: 'configured', showNumbers: true },
    })
    const html = await renderBlock('KpiBriefingBlock')
    for (const label of ['Revenue MTD', 'Members', 'Churn risk', 'In arrears']) expect(html).toContain(`>${label}<`)
    expect(html).toContain('31 payments')
    expect(html).toContain('>33<')
    expect(html).toContain('radar unavailable')
    expect(html).toContain('arrears unavailable')
    expect(html).not.toContain('does not provide membership data')
  })

  it('un1t.online: MembershipBlock renders MembershipPanel with un1t counts and flows', async () => {
    const html = await renderMembershipBlock()
    expect(un1tOnlineReads.membershipCounts).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(un1tOnlineReads.membershipFlows).toHaveBeenCalledWith(expect.anything(), LOC, 12, undefined, { zone: 'Europe/Dublin' })
    expect(computeMembershipCounts).not.toHaveBeenCalled() // never the Glofox function
    expect(fetchMembershipFlows).not.toHaveBeenCalled()
    expect(html).toContain('membership-panel:33')
  })

  it('un1t.online: a throwing un1t read is the block error, never Glofox zeros', async () => {
    un1tOnlineReads.membershipCounts.mockRejectedValue(new Error('un1t down'))
    const html = await renderMembershipBlock()
    expect(html).toContain('Membership sales')
    expect(html).not.toContain('membership-panel')
  })

  it('unknown state: no membership read runs and the retry copy shows in both blocks', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} })
    buildBusinessKpis.mockResolvedValue(numberless('unknown'))
    const block = await renderMembershipBlock()
    const kpi = await renderBlock('KpiBriefingBlock')
    for (const html of [block, kpi]) expect(html).toContain('Membership data could not be read right now')
    expect(un1tOnlineReads.membershipCounts).not.toHaveBeenCalled()
    expect(computeMembershipCounts).not.toHaveBeenCalled()
    expect(fetchMembershipFlows).not.toHaveBeenCalled()
  })

  // The page's own state read and the vm's gate come from different calls and can
  // disagree (cache expiry between them, a source changed mid-render). The vm
  // decides, and nothing dereferences a missing number.
  it('page state says configured but the vm gate says not: the gate copy renders, no tiles, no crash', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    buildBusinessKpis.mockResolvedValue(numberless('none'))
    const html = await renderBlock('KpiBriefingBlock')
    expect(html).toContain('2 pending approvals')
    expect(html).toContain('No membership source connected')
    for (const label of ['Revenue MTD', 'Members', 'Churn risk', 'In arrears']) expect(html).not.toContain(`>${label}<`)
  })

  it('page state says configured, the vm is configured but shows no numbers: the "does not provide" copy, never an empty block', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    buildBusinessKpis.mockResolvedValue({ ...numberless('configured') })
    const html = await renderBlock('KpiBriefingBlock')
    expect(html).toContain('Glofox does not provide membership data')
    expect(html).not.toContain('>Revenue MTD<')
  })

  it('a vm without a gate fails closed to the gate copy', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    buildBusinessKpis.mockResolvedValue({ revenue: { totalCents: 1, paidCount: 1, deltaPct: null }, arrearsData: null, memberCount: 1, churnCount: null, churnDelta: null, briefing: 'b' })
    const html = await renderBlock('KpiBriefingBlock')
    expect(html).not.toContain('>Revenue MTD<')
    expect(html).toContain('does not provide membership data')
  })

  it('a failed revenue read (vm null) is the BlockError even when the page state is configured', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'un1t_online', state: 'configured', label: 'un1t.online', capabilities: { memberships: false } })
    buildBusinessKpis.mockResolvedValue(null)
    const html = await renderBlock('KpiBriefingBlock')
    expect(html).toContain('Headline numbers')
  })
})

// UN1TRADAR.2 — an estimated arrears total says so on the card.
describe('/dashboard/business In arrears estimate (UN1TRADAR.2)', () => {
  it('business In arrears sublabel carries "includes an estimate"', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'un1t_online', state: 'configured', label: 'un1t.online', capabilities: { memberships: true, bookings: false, credits: true, invoices: true, schedule: false } })
    buildBusinessKpis.mockResolvedValue({
      revenue: { totalCents: 640_000, deltaPct: null, paidCount: 31 },
      arrearsData: { totalCents: 16500, memberCount: 2, estimated: true }, memberCount: 33, churnCount: null, churnDelta: null, briefing: 'x',
      gate: { state: 'configured', showNumbers: true },
    })
    const html = await renderBlock('KpiBriefingBlock')
    expect(html).toContain('2 members, includes an estimate')
  })
  it('an exact total keeps today\'s sublabel', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    buildBusinessKpis.mockResolvedValue({
      revenue: { totalCents: 640_000, deltaPct: null, paidCount: 31 },
      arrearsData: { totalCents: 5000, memberCount: 1 }, memberCount: 33, churnCount: 0, churnDelta: 0, briefing: 'x',
      gate: { state: 'configured', showNumbers: true },
    })
    const html = await renderBlock('KpiBriefingBlock')
    expect(html).toContain('>1 member<')
    expect(html).not.toContain('includes an estimate')
  })
  it('no known euro amount (every past-due row unpriced): the card says so, never "€0"', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'un1t_online', state: 'configured', label: 'un1t.online', capabilities: { memberships: false, bookings: false, credits: false, invoices: true, schedule: false } })
    buildBusinessKpis.mockResolvedValue({
      revenue: { totalCents: 640_000, deltaPct: null, paidCount: 31 },
      arrearsData: { totalCents: 0, memberCount: 3, estimated: true }, memberCount: 33, churnCount: null, churnDelta: null, briefing: 'x',
      gate: { state: 'configured', showNumbers: true },
    })
    const html = await renderBlock('KpiBriefingBlock')
    expect(html).toContain('amount not available from un1t.online')
    expect(html).not.toContain('€0')
  })
  it('Glofox: a €0 exact total still prints €0', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    buildBusinessKpis.mockResolvedValue({
      revenue: { totalCents: 640_000, deltaPct: null, paidCount: 31 },
      arrearsData: { totalCents: 0, memberCount: 0 }, memberCount: 33, churnCount: 0, churnDelta: 0, briefing: 'x',
      gate: { state: 'configured', showNumbers: true },
    })
    const html = await renderBlock('KpiBriefingBlock')
    expect(html).toContain('€0')
    expect(html).not.toContain('not available from un1t.online')
  })
})
