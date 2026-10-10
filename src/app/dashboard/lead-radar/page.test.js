// W1.M3a — /dashboard/lead-radar gates on the membership source. A
// configured (Stillorgan) studio renders the radar exactly as before; a
// studio with none shows "No membership source connected" instead of an
// empty radar; a failed read shows the retry copy, never the none copy.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((u) => { throw new Error(`NEXT_REDIRECT:${u}`) }) }))
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => ({ ...(await importOriginal()), membershipStateForPage: vi.fn() }))
vi.mock('@/components/LeadRadar', () => ({ default: () => <div data-testid="radar">the radar</div> }))

import Page from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { membershipStateForPage } from '@/lib/membership/state-for-page'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' }, activeLocation: { id: LOC, name: 'Studio' } })
})

describe('/dashboard/lead-radar — membership source gate (W1.M3a)', () => {
  it('configured: the radar renders as before, no gate copy', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS })
    const html = renderToStaticMarkup(await Page())
    expect(membershipStateForPage).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(html).toContain('the radar')
    expect(html).toContain('The non-member base')
    expect(html).not.toContain('No membership source connected')
    expect(html).not.toContain('data-membership-state')
  })

  it('none: "No membership source connected" with the owner\'s settings link; the radar does not mount', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: {} })
    const html = renderToStaticMarkup(await Page())
    expect(html).not.toContain('the radar')
    expect(html).toContain('No membership source connected')
    expect(html).toContain(`href="/settings/locations/${LOC}?section=integrations&amp;tab=glofox"`)
  })

  it('none, a head coach: "Ask an owner", no link', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u2', profileRole: 'staff', rolesByLocation: { [LOC]: 'head_coach' }, activeLocation: { id: LOC, name: 'Studio' } })
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'No membership source', capabilities: {} })
    const html = renderToStaticMarkup(await Page())
    expect(html).toContain('Ask an owner to connect a membership source')
    expect(html).not.toContain('href="/settings/locations/')
  })

  it('unknown: the retry copy, never the none copy', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} })
    const html = renderToStaticMarkup(await Page())
    expect(html).not.toContain('the radar')
    expect(html).toContain('Membership data could not be read right now')
    expect(html).not.toContain('No membership source connected')
  })
})
