// W1.M3a — /dashboard/engagement (the churn-radar cross-tab) gates on the
// membership source: configured renders the report as before; none shows
// "No membership source connected" and never runs the report query; a
// failed read shows the retry copy, never the none copy.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((u) => { throw new Error(`NEXT_REDIRECT:${u}`) }) }))
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => ({ ...(await importOriginal()), membershipStateForPage: vi.fn() }))
vi.mock('@/lib/engagement-analytics-data', () => ({ loadEngagementChurn: vi.fn() }))
vi.mock('@/components/dashboard/EngagementReport', () => ({ default: ({ report }) => <div>{`report:${report.tiers}`}</div> }))

import Page from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { membershipStateForPage } from '@/lib/membership/state-for-page'
import { loadEngagementChurn } from '@/lib/engagement-analytics-data'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' }, activeLocation: { id: LOC, name: 'Studio' } })
  loadEngagementChurn.mockResolvedValue({ tiers: 3 })
})

describe('/dashboard/engagement — membership source gate (W1.M3a)', () => {
  it('configured: the report loads and renders as before, no gate copy', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    const html = renderToStaticMarkup(await Page())
    expect(loadEngagementChurn).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(html).toContain('report:3')
    expect(html).not.toContain('No membership source connected')
    expect(html).not.toContain('data-membership-state')
  })

  it('configured, a failed report query: the old "No engagement data yet" line (unchanged)', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    loadEngagementChurn.mockRejectedValue(new Error('timeout'))
    const html = renderToStaticMarkup(await Page())
    expect(html).toContain('No engagement data yet for this location.')
  })

  it('none: the gate copy with the owner link; the report query does not run', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: {} })
    const html = renderToStaticMarkup(await Page())
    expect(loadEngagementChurn).not.toHaveBeenCalled()
    expect(html).toContain('No membership source connected')
    expect(html).toContain(`href="/settings/locations/${LOC}?section=integrations&amp;tab=glofox"`)
    expect(html).not.toContain('report:')
    expect(html).not.toContain('No engagement data yet')
  })

  it('unknown: the retry copy, never the none copy', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} })
    const html = renderToStaticMarkup(await Page())
    expect(html).toContain('Membership data could not be read right now')
    expect(html).not.toContain('No membership source connected')
    expect(loadEngagementChurn).not.toHaveBeenCalled()
  })
})
