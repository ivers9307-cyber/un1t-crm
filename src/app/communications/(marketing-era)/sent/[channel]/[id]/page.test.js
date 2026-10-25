// PAGEGATES.1 — /communications/sent/[channel]/[id] decides at the ROW's location.
//
// The send routes (POST /api/whatsapp/broadcasts/[id]/send, POST
// /api/campaigns/[id]/send, …/duplicate) judge the channel permission at the
// broadcast's / campaign's location. The page judged it at the ACTIVE studio,
// and handed a broadcast from studio B the ACTIVE studio's approved templates
// and location id (so its editor offered A's templates and A's quiet hours).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, MASTER, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'
import { pageDb, navigationMock } from '../../../../../../../tests/helpers/page-db-mock.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => navigationMock())
vi.mock('@/lib/whatsapp-broadcast-stats', () => ({
  loadWhatsappBroadcastRecipientStats: vi.fn(async () => ({})),
  countWhatsappSentToday: vi.fn(async () => 0),
  whatsappBroadcastDisplayStats: vi.fn(() => ({})),
}))
vi.mock('@/lib/campaign-display-stats', () => ({
  loadCampaignRecipientStats: vi.fn(async () => ({})),
  campaignDisplayStats: vi.fn(() => ({})),
}))
vi.mock('@/components/WABroadcastEditor', () => ({ default: () => null }))
vi.mock('@/components/CampaignDetail', () => ({ default: () => null }))
vi.mock('@/components/CampaignEditor', () => ({ default: () => null }))

import SendDetailPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ROW_ID = 'b0000000-0000-4000-8000-0000000000b1'
const props = (channel) => ({ params: Promise.resolve({ channel, id: ROW_ID }), searchParams: Promise.resolve({}) })
const key = (k, a, b) => person({ [LOC_A]: { role: 'owner', permissions: { [k]: a } }, [LOC_B]: { role: 'owner', permissions: { [k]: b } } }, LOC_A)

// Records the location every whatsapp_templates read is scoped to.
let templateLocations
function dbAt(loc) {
  const base = pageDb({
    whatsapp_broadcasts: { id: ROW_ID, location_id: loc, delivery_mode: 'bulk' },
    whatsapp_templates: [],
    whatsapp_broadcast_recipients: [],
    campaigns: { id: ROW_ID, location_id: loc, status: 'sent', ab_subject_b: null, parent_campaign_id: null },
    campaign_recipients: [],
  })
  return {
    ...base,
    from: (table) => {
      const chain = base.from(table)
      if (table !== 'whatsapp_templates') return chain
      const eq = chain.eq
      chain.eq = (col, val) => { if (col === 'location_id') templateLocations.push(val); return eq(col, val) }
      return chain
    },
  }
}

beforeEach(() => { vi.clearAllMocks(); templateLocations = [] })

describe('/communications/sent/whatsapp/[id]', () => {
  it('opens for `whatsapp` at the broadcast\'s studio only, with ITS templates and location (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(key('whatsapp', false, true)); createServerClient.mockReturnValue(dbAt(LOC_B))
    const el = await SendDetailPage(props('whatsapp'))
    expect(el.props.locationId).toBe(LOC_B)
    expect(templateLocations).toEqual([LOC_B])
  })
  it('refuses `whatsapp` at the active studio only (main: Send shown, route 403s)', async () => {
    getCurrentUser.mockResolvedValue(key('whatsapp', true, false)); createServerClient.mockReturnValue(dbAt(LOC_B))
    await expect(SendDetailPage(props('whatsapp'))).rejects.toThrow(/^NEXT_REDIRECT:\/communications$/)
  })
  it('404s an outsider', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: { whatsapp: true } } }, LOC_A)); createServerClient.mockReturnValue(dbAt(LOC_B))
    await expect(SendDetailPage(props('whatsapp'))).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })
  it('a master gets the broadcast\'s own templates, not the active studio\'s', async () => {
    getCurrentUser.mockResolvedValue(MASTER); createServerClient.mockReturnValue(dbAt(LOC_B))
    await SendDetailPage(props('whatsapp'))
    expect(templateLocations).toEqual([LOC_B])
  })
})

describe('/communications/sent/email/[id]', () => {
  it('opens for `email` at the campaign\'s studio only (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(key('email', false, true)); createServerClient.mockReturnValue(dbAt(LOC_B))
    const el = await SendDetailPage(props('email'))
    expect(el.props.locationId).toBe(LOC_B)
  })
  it('refuses `email` at the active studio only (main: Send/Duplicate shown, routes 403)', async () => {
    getCurrentUser.mockResolvedValue(key('email', true, false)); createServerClient.mockReturnValue(dbAt(LOC_B))
    await expect(SendDetailPage(props('email'))).rejects.toThrow(/^NEXT_REDIRECT:\/communications$/)
  })
  it('404s an outsider', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: { email: true } } }, LOC_A)); createServerClient.mockReturnValue(dbAt(LOC_B))
    await expect(SendDetailPage(props('email'))).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })
})
