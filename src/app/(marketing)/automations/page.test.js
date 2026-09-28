// PROFILESPREAD.1 (F6) — /automations reads Glofox presence itself (the user
// object no longer carries settings). A failed read shows a notice and never
// "not connected". Fictional values only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn((u, k) => k === 'automations') }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((u) => { throw new Error(`NEXT_REDIRECT:${u}`) }) }))
vi.mock('@/lib/automations/glofox-status', () => ({ readGlofoxAutomationStatus: vi.fn() }))
vi.mock('@/components/automations/AutomationsView', () => ({
  default: ({ cards }) => <div data-testid="view">{cards.map((c) => `${c.key}:${c.status.available}:${c.status.unknown ? 'unknown' : 'known'}`).join('|')}</div>,
}))
vi.mock('@/components/automations/AutomationsFlowList', () => ({ default: () => null }))
vi.mock('@/components/automations/ClassClimateCard', () => ({ default: (p) => <div>{`climate:${p.glofoxConnected}:${p.glofoxUnknown ? 'unknown' : 'known'}`}</div> }))
vi.mock('@/components/automations/BathroomClimateCard', () => ({ default: (p) => <div>{`bathroom:${p.glofoxConnected}:${p.glofoxUnknown ? 'unknown' : 'known'}`}</div> }))

import AutomationsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { readGlofoxAutomationStatus } from '@/lib/automations/glofox-status'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
// A db whose every chain resolves to { data: [] } (location_automations, ac_devices).
const emptyDb = () => {
  const chain = { select: () => chain, eq: () => chain, order: () => chain, then: (r) => r({ data: [], error: null }) }
  return { from: () => chain }
}

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(emptyDb())
  // The user object carries NO settings now (PROFILESPREAD.1a).
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: { id: LOC, name: 'Studio' }, locations: [{ id: LOC, name: 'Studio' }] })
})

describe('/automations — Glofox presence (PROFILESPREAD.1)', () => {
  it('reads it by the active location id and passes the booleans on', async () => {
    readGlofoxAutomationStatus.mockResolvedValue({
      known: true, connected: true,
      statuses: { glofox_lead_provisioning: { available: true, trialConfigured: true }, class_climate: { available: true, trialConfigured: false }, bathroom_climate: { available: true, trialConfigured: false } },
    })
    const html = renderToStaticMarkup(await AutomationsPage())
    expect(readGlofoxAutomationStatus).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(html).toContain('glofox_lead_provisioning:true:known')
    expect(html).toContain('climate:true:known')
    expect(html).toContain('bathroom:true:known')
    expect(html).not.toMatch(/Couldn(?:&#x27;|')t check whether Glofox/) // static markup escapes the apostrophe
  })

  it('a failed read: a page notice, unknown cards, and no card says "connected" or "not connected"', async () => {
    readGlofoxAutomationStatus.mockResolvedValue({
      known: false, connected: null,
      statuses: { glofox_lead_provisioning: { available: false, trialConfigured: false, unknown: true }, class_climate: { available: false, trialConfigured: false, unknown: true }, bathroom_climate: { available: false, trialConfigured: false, unknown: true } },
    })
    const html = renderToStaticMarkup(await AutomationsPage())
    expect(html).toMatch(/role="alert"[^>]*>[^<]*Couldn(?:&#x27;|')t check whether Glofox is connected/)
    expect(html).toContain('glofox_lead_provisioning:false:unknown')
    expect(html).toContain('climate:false:unknown')
    expect(html).toContain('bathroom:false:unknown')
  })
})
