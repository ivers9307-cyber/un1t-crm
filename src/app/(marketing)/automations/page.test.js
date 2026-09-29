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
const seen = vi.hoisted(() => ({ flows: null }))
vi.mock('@/components/automations/AutomationsFlowList', () => ({ default: (p) => { seen.flows = p; return null } }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/components/automations/ClassClimateCard', () => ({ default: (p) => <div>{`climate:${p.glofoxConnected}:${p.glofoxUnknown ? 'unknown' : 'known'}`}</div> }))
vi.mock('@/components/automations/BathroomClimateCard', () => ({ default: (p) => <div>{`bathroom:${p.glofoxConnected}:${p.glofoxUnknown ? 'unknown' : 'known'}`}</div> }))

import AutomationsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { readGlofoxAutomationStatus } from '@/lib/automations/glofox-status'
import { hasPermission } from '@/lib/permissions'
import { logError } from '@/lib/log'

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
  // The flows describe below switches hasPermission; restore the module
  // mock's implementation so test order cannot leak it in here.
  beforeEach(() => {
    hasPermission.mockImplementation((u, k) => k === 'automations')
  })

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
    // A disabled card can't be switched OFF either, so "switched on" undersold it.
    expect(html).toMatch(/The automation cards below can(?:&#x27;|')t be changed until it can\. Reload to try again\./)
    expect(html).not.toMatch(/switched on until/)
    expect(html).toContain('glofox_lead_provisioning:false:unknown')
    expect(html).toContain('climate:false:unknown')
    expect(html).toContain('bathroom:false:unknown')
  })

  it('the Glofox read and the location_automations read run together, not one after the other', async () => {
    const order = []
    const chain = { select: () => chain, eq: () => chain, order: () => chain, then: (r) => r({ data: [], error: null }) }
    createServerClient.mockReturnValue({ from: (t) => { order.push(`from:${t}`); return chain } })
    readGlofoxAutomationStatus.mockImplementation(async () => {
      await Promise.resolve()
      order.push('glofox:resolved')
      return { known: true, connected: false, statuses: { glofox_lead_provisioning: { available: false, trialConfigured: false } } }
    })
    await AutomationsPage()
    expect(order.indexOf('from:location_automations')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('from:location_automations')).toBeLessThan(order.indexOf('glofox:resolved'))
  })
})

// SEQCOUNTERS.1 — the flow list's enrolled chip is counted from
// sequence_enrollments (an embedded count in the same read), and a failed
// read is a notice, not an empty list.
describe('/automations — flows (SEQCOUNTERS.1)', () => {
  function flowsDb(result) {
    const calls = { select: null }
    const chain = {
      select: (c) => { calls.select = c; return chain },
      eq: () => chain,
      order: () => chain,
      then: (r, j) => Promise.resolve(result).then(r, j),
    }
    return { db: { from: () => chain }, calls }
  }
  beforeEach(() => {
    seen.flows = null
    hasPermission.mockImplementation((_u, k) => k === 'email')
  })

  it('reads named columns with an embedded enrolment count, and passes enrolled_count', async () => {
    const { db, calls } = flowsDb({
      data: [{ id: 'a0000000-0000-4000-8000-000000000001', name: 'Welcome', status: 'active', trigger_type: 'manual', created_at: 'T', sequence_steps: [{ id: 's1' }], sequence_enrollments: [{ count: 139 }] }],
      error: null,
    })
    createServerClient.mockReturnValue(db)
    renderToStaticMarkup(await AutomationsPage()) // the flow list mock captures its props on render
    expect(calls.select).toBe('id, name, status, trigger_type, created_at, sequence_steps(id), sequence_enrollments(count)')
    expect(seen.flows.sequences[0].enrolled_count).toBe(139)
    expect(seen.flows.sequences[0]).not.toHaveProperty('sequence_enrollments')
    expect(seen.flows.loadFailed).toBe(false)
  })

  it('a failed read is logged and passed as loadFailed, with no rows', async () => {
    const { db } = flowsDb({ data: null, error: { code: '57014', message: 'timeout' } })
    createServerClient.mockReturnValue(db)
    renderToStaticMarkup(await AutomationsPage()) // the flow list mock captures its props on render
    expect(seen.flows.loadFailed).toBe(true)
    expect(seen.flows.sequences).toEqual([])
    expect(logError).toHaveBeenCalledWith('automations', expect.stringMatching(/sequences read failed/), { code: '57014' })
  })
})
