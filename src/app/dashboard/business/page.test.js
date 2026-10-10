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
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => ({ ...(await importOriginal()), membershipStateForPage: vi.fn() }))
vi.mock('@/lib/membership-snapshot', () => ({ computeMembershipCounts: vi.fn() }))
vi.mock('@/lib/membership-flows', () => ({ fetchMembershipFlows: vi.fn() }))
vi.mock('@/components/dashboard/MembershipPanel', () => ({ MembershipPanel: ({ live }) => <div>{`membership-panel:${live.active}`}</div> }))
vi.mock('@/lib/labour-month-model', () => ({ canSeeLabour: () => false, labourStudiosFor: () => [] }))

import Page from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { membershipStateForPage } from '@/lib/membership/state-for-page'
import { computeMembershipCounts } from '@/lib/membership-snapshot'
import { fetchMembershipFlows } from '@/lib/membership-flows'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }

// Depth-first search of a React element tree for a component by name.
function findElement(node, name) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const f = findElement(n, name); if (f) return f }; return null }
  if (typeof node.type === 'function' && node.type.name === name) return node
  return findElement(node.props?.children, name)
}

async function renderMembershipBlock() {
  const tree = await Page()
  const el = findElement(tree, 'MembershipBlock')
  expect(el, 'MembershipBlock is on the page').toBeTruthy()
  return renderToStaticMarkup(await el.type(el.props))
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' }, activeLocation: { id: LOC, name: 'Studio' }, locations: [] })
  computeMembershipCounts.mockResolvedValue({ active: 412 })
  fetchMembershipFlows.mockResolvedValue([])
})

describe('/dashboard/business — membership trend gate (W1.M3a)', () => {
  it('configured: the trend block reads and renders as before', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    const html = await renderMembershipBlock()
    expect(computeMembershipCounts).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(fetchMembershipFlows).toHaveBeenCalledWith(expect.anything(), LOC, 12)
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

  it('unknown: the retry copy, never the none copy', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} })
    const html = await renderMembershipBlock()
    expect(html).toContain('Membership data could not be read right now')
    expect(html).not.toContain('No membership source connected')
    expect(computeMembershipCounts).not.toHaveBeenCalled()
  })

  it('the other blocks are not gated: the KPI block never asks the membership state', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: {} })
    const tree = await Page()
    for (const name of ['KpiBriefingBlock', 'FunnelAdsBlock', 'TodayBlock', 'RailBlock']) {
      expect(findElement(tree, name), name).toBeTruthy()
    }
    expect(membershipStateForPage).not.toHaveBeenCalled() // only MembershipBlock asks, and only when rendered
  })
})
