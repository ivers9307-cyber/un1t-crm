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
vi.mock('@/lib/sequence-access', () => ({ canCloneSequenceAt: vi.fn(() => false) }))
vi.mock('@/components/automations/ClassClimateCard', () => ({ default: (p) => <div>{`climate:${p.glofoxConnected}:${p.glofoxUnknown ? 'unknown' : 'known'}`}</div> }))
vi.mock('@/components/automations/BathroomClimateCard', () => ({ default: (p) => <div>{`bathroom:${p.glofoxConnected}:${p.glofoxUnknown ? 'unknown' : 'known'}`}</div> }))

// W1.M3a — readGlofoxAutomationStatus carries the membership state the gate
// renders from. The PROFILESPREAD cases below are a CONFIGURED source (Stillorgan).
const CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }
const CONFIGURED = { source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS }
const ALL_KNOWN = { glofox_lead_provisioning: { available: true, trialConfigured: true }, class_climate: { available: true, trialConfigured: false }, bathroom_climate: { available: true, trialConfigured: false } }
const ALL_UNKNOWN = { glofox_lead_provisioning: { available: false, trialConfigured: false, unknown: true }, class_climate: { available: false, trialConfigured: false, unknown: true }, bathroom_climate: { available: false, trialConfigured: false, unknown: true } }

import AutomationsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { readGlofoxAutomationStatus } from '@/lib/automations/glofox-status'
import { hasPermission } from '@/lib/permissions'
import { logError } from '@/lib/log'
import { canCloneSequenceAt } from '@/lib/sequence-access'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
// A db whose every chain resolves to { data: [] } (location_automations, ac_devices).
const emptyDb = () => {
  const chain = { select: () => chain, eq: () => chain, order: () => chain, then: (r) => r({ data: [], error: null }) }
  return { from: () => chain }
}

beforeEach(() => {
  vi.clearAllMocks()
  readGlofoxAutomationStatus.mockResolvedValue({ known: true, connected: true, membership: CONFIGURED, statuses: ALL_KNOWN })
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
    readGlofoxAutomationStatus.mockResolvedValue({ known: true, connected: true, membership: CONFIGURED, statuses: ALL_KNOWN })
    const html = renderToStaticMarkup(await AutomationsPage())
    expect(readGlofoxAutomationStatus).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(html).toContain('glofox_lead_provisioning:true:known')
    expect(html).toContain('climate:true:known')
    expect(html).toContain('bathroom:true:known')
    expect(html).not.toMatch(/Couldn(?:&#x27;|')t check whether Glofox/) // static markup escapes the apostrophe
    // W1.M3a — a configured source renders no gate copy (Stillorgan unchanged).
    expect(html).not.toContain('No membership source connected')
    expect(html).not.toContain('data-membership-state')
  })

  it('a failed read: a page notice, unknown cards, and no card says "connected" or "not connected"', async () => {
    // A failed SETTINGS read (the trial config) with a configured source.
    readGlofoxAutomationStatus.mockResolvedValue({ known: false, connected: null, membership: CONFIGURED, statuses: ALL_UNKNOWN })
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
      return { known: true, connected: false, membership: CONFIGURED, statuses: { glofox_lead_provisioning: { available: false, trialConfigured: false } } }
    })
    await AutomationsPage()
    expect(order.indexOf('from:location_automations')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('from:location_automations')).toBeLessThan(order.indexOf('glofox:resolved'))
  })
})

// W1.M3a — the curated cards render only behind the membership-source gate.
describe('/automations — membership source gate (W1.M3a)', () => {
  beforeEach(() => {
    hasPermission.mockImplementation((_u, k) => k === 'automations')
  })

  it('none: "No membership source connected" (with the owner link), and NO cards', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' }, activeLocation: { id: LOC, name: 'Studio' }, locations: [{ id: LOC, name: 'Studio' }] })
    const NONE = { source: 'none', state: 'none', label: 'No membership source', capabilities: {} }
    readGlofoxAutomationStatus.mockResolvedValue({ known: true, connected: false, membership: NONE, statuses: { glofox_lead_provisioning: { available: false, trialConfigured: false }, class_climate: { available: false, trialConfigured: false }, bathroom_climate: { available: false, trialConfigured: false } } })
    const html = renderToStaticMarkup(await AutomationsPage())
    expect(html).toContain('No membership source connected')
    expect(html).toContain('no class schedule to run on')
    expect(html).toContain(`href="/settings/locations/${LOC}?section=integrations&amp;tab=glofox"`)
    expect(html).not.toContain('data-testid="view"')
    expect(html).not.toContain('climate:')
    expect(html).not.toContain('bathroom:')
    expect(html).not.toMatch(/role="alert"/)
  })

  it('unknown membership state: the gate\'s retry copy once, never the none copy, no cards and no second notice', async () => {
    const UNKNOWN = { source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} }
    readGlofoxAutomationStatus.mockResolvedValue({ known: false, connected: null, membership: UNKNOWN, statuses: ALL_UNKNOWN })
    const html = renderToStaticMarkup(await AutomationsPage())
    expect(html).toContain('Membership data could not be read right now')
    expect(html).not.toContain('No membership source connected')
    expect(html).not.toMatch(/role="alert"/)
    expect(html).not.toContain('climate:')
  })

  it('the device and flow sections are not behind the gate', async () => {
    hasPermission.mockImplementation((_u, k) => k === 'automations' || k === 'device_control' || k === 'email')
    const NONE = { source: 'none', state: 'none', label: 'No membership source', capabilities: {} }
    readGlofoxAutomationStatus.mockResolvedValue({ known: true, connected: false, membership: NONE, statuses: { glofox_lead_provisioning: { available: false, trialConfigured: false }, class_climate: { available: false, trialConfigured: false }, bathroom_climate: { available: false, trialConfigured: false } } })
    const html = renderToStaticMarkup(await AutomationsPage())
    expect(html).toContain('No membership source connected')
    expect(html).toContain('href="/automations/sonos"')
    expect(html).toContain('href="/automations/shelly"')
    expect(seen.flows).not.toBeNull()
  })
})

// SEQCOUNTERS.1 — the flow list's enrolled chip is counted from
// sequence_enrollments (an embedded count in the same read). If that read
// fails, the list is read again without the count (no chips); only if the
// plain read fails too is it a notice, never an empty list.
describe('/automations — flows (SEQCOUNTERS.1)', () => {
  const WITH_COUNT = 'id, name, status, trigger_type, created_at, sequence_steps(id), sequence_enrollments(count)'
  const PLAIN = 'id, name, status, trigger_type, created_at, sequence_steps(id)'
  const ROW = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Welcome', status: 'active', trigger_type: 'manual', created_at: 'T', sequence_steps: [{ id: 's1' }] }
  // resultFor(selectString) → { data, error }; every read is recorded.
  function flowsDb(resultFor) {
    const reads = []
    const from = (table) => {
      const read = { table, select: null, eq: [] }
      reads.push(read)
      const chain = {
        select: (c) => { read.select = c; return chain },
        eq: (...a) => { read.eq.push(a); return chain },
        order: () => chain,
        then: (r, j) => Promise.resolve(resultFor(read.select)).then(r, j),
      }
      return chain
    }
    return { db: { from }, reads }
  }
  const TIMEOUT = { code: '57014', message: 'timeout' }
  beforeEach(() => {
    seen.flows = null
    hasPermission.mockImplementation((_u, k) => k === 'email')
  })

  it('reads named columns with an embedded enrolment count at the active location, and passes enrolled_count', async () => {
    const { db, reads } = flowsDb(() => ({ data: [{ ...ROW, sequence_enrollments: [{ count: 139 }] }], error: null }))
    createServerClient.mockReturnValue(db)
    renderToStaticMarkup(await AutomationsPage()) // the flow list mock captures its props on render
    expect(reads.map((r) => r.select)).toEqual([WITH_COUNT])
    expect(reads[0].eq).toEqual([['location_id', LOC]])
    expect(seen.flows.sequences[0].enrolled_count).toBe(139)
    expect(seen.flows.sequences[0]).not.toHaveProperty('sequence_enrollments')
    expect(seen.flows.loadFailed).toBe(false)
    expect(logError).not.toHaveBeenCalled()
  })

  it('a failed count read is logged and retried without the count: the list renders, with no chips', async () => {
    const { db, reads } = flowsDb((sel) => (sel === WITH_COUNT ? { data: null, error: TIMEOUT } : { data: [ROW], error: null }))
    createServerClient.mockReturnValue(db)
    renderToStaticMarkup(await AutomationsPage())
    expect(reads.map((r) => r.select)).toEqual([WITH_COUNT, PLAIN])
    expect(reads[1].eq).toEqual([['location_id', LOC]])
    expect(seen.flows.loadFailed).toBe(false)
    expect(seen.flows.sequences).toEqual([{ ...ROW, enrolled_count: null }])
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('automations', expect.stringMatching(/enrolment count read failed/), { code: '57014', locationId: LOC })
  })

  it('when the plain read fails too, both are logged and the list is a notice with no rows', async () => {
    const { db, reads } = flowsDb(() => ({ data: null, error: TIMEOUT }))
    createServerClient.mockReturnValue(db)
    renderToStaticMarkup(await AutomationsPage())
    expect(reads.map((r) => r.select)).toEqual([WITH_COUNT, PLAIN])
    expect(seen.flows.loadFailed).toBe(true)
    expect(seen.flows.sequences).toEqual([])
    expect(logError).toHaveBeenCalledTimes(2)
    expect(logError).toHaveBeenLastCalledWith('automations', expect.stringMatching(/sequences read failed/), { code: '57014', locationId: LOC })
  })

  it('a user with no active location reads the nil location, like the page\'s other reads', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: null, locations: [] })
    const { db, reads } = flowsDb(() => ({ data: [], error: null }))
    createServerClient.mockReturnValue(db)
    renderToStaticMarkup(await AutomationsPage())
    expect(reads[0].eq).toEqual([['location_id', '00000000-0000-0000-0000-000000000000']])
  })
})

// C123 GATES-4 (b) — the flow list gets canClone from the clone route's rule
// at the ACTIVE studio (the list is that studio's sequences).
describe('/automations — Clone button gate (C123 b)', () => {
  beforeEach(() => {
    seen.flows = null
    hasPermission.mockImplementation((_u, k) => k === 'whatsapp')
  })
  it('asks canCloneSequenceAt at the active studio and passes its answer', async () => {
    canCloneSequenceAt.mockReturnValue(false)
    renderToStaticMarkup(await AutomationsPage())
    expect(canCloneSequenceAt).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), LOC)
    expect(seen.flows.canClone).toBe(false)
    canCloneSequenceAt.mockReturnValue(true)
    renderToStaticMarkup(await AutomationsPage())
    expect(seen.flows.canClone).toBe(true)
  })
})
