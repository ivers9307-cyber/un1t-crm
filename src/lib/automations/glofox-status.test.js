// PROFILESPREAD.1 (F6) — the automations pages used to read Glofox presence
// off user.activeLocation.settings, which is why every page carried the
// location's settings. They now read it by id with the service role. A
// failed read is "unknown", never "not connected". Fictional values only.
//
// W1.M3a — "connected" is the membership source (membershipStateForPage),
// not the settings slice; the slice is read only for the trial config, and
// a failure of EITHER read is unknown.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => ({ ...(await importOriginal()), membershipStateForPage: vi.fn() }))

import { readGlofoxAutomationStatus } from './glofox-status.js'
import { AUTOMATIONS } from './registry.js'
import { logError } from '@/lib/log'
import { membershipStateForPage } from '@/lib/membership/state-for-page'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const db = (result) => {
  const calls = {}
  return {
    calls,
    from: (t) => {
      calls.table = t
      return { select: (c) => { calls.select = c; return { eq: (k, v) => { calls.eq = [k, v]; return { maybeSingle: async () => result } } } } }
    },
  }
}
const CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }
const CONFIGURED = { source: 'glofox', state: 'configured', label: 'Glofox', capabilities: CAPS }
const NONE = { source: 'none', state: 'none', label: 'No membership source', capabilities: {} }
const UNKNOWN = { source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: {} }
const WITH_TRIAL = { glofox: { branch_id: 'b', api_key: 'SYNTH-K', api_token: 'SYNTH-T', trial_membership_id: 'm', trial_plan_code: 'p' } }

beforeEach(() => {
  vi.clearAllMocks()
  membershipStateForPage.mockResolvedValue(CONFIGURED)
})

describe('readGlofoxAutomationStatus', () => {
  it('reads settings by id (trial config) and the membership state, and returns booleans only (no settings, no credential)', async () => {
    const d = db({ data: { settings: WITH_TRIAL }, error: null })
    const s = await readGlofoxAutomationStatus(d, LOC)
    expect(d.calls).toEqual({ table: 'locations', select: 'settings', eq: ['id', LOC] })
    expect(membershipStateForPage).toHaveBeenCalledWith(d, LOC)
    expect(s.known).toBe(true)
    expect(s.connected).toBe(true)
    expect(s.membership).toBe(CONFIGURED)
    expect(s.statuses.glofox_lead_provisioning).toEqual({ available: true, trialConfigured: true })
    expect(s.statuses.class_climate).toEqual({ available: true, trialConfigured: false })
    expect(Object.keys(s.statuses).sort()).toEqual(AUTOMATIONS.map((a) => a.key).sort())
    expect(JSON.stringify(s)).not.toMatch(/SYNTH-|settings|branch/)
  })

  it('connected comes from the membership source, NOT the slice: a full slice at a "none" studio is not connected', async () => {
    membershipStateForPage.mockResolvedValue(NONE)
    const s = await readGlofoxAutomationStatus(db({ data: { settings: WITH_TRIAL }, error: null }), LOC)
    expect(s).toMatchObject({ known: true, connected: false, membership: NONE })
    expect(s.statuses.glofox_lead_provisioning).toEqual({ available: false, trialConfigured: true })
    expect(s.statuses.class_climate).toEqual({ available: false, trialConfigured: false })
  })

  it('…and a configured source with a bare slice IS connected (the registry row is what configures Glofox)', async () => {
    const s = await readGlofoxAutomationStatus(db({ data: { settings: { glofox: { branch_id: 'b' } } }, error: null }), LOC)
    expect(s).toMatchObject({ known: true, connected: true })
    expect(s.statuses.glofox_lead_provisioning).toEqual({ available: true, trialConfigured: false })
  })

  it('unconfigured is a KNOWN not-connected', async () => {
    membershipStateForPage.mockResolvedValue({ ...CONFIGURED, state: 'unconfigured', missing: ['API Key'] })
    const s = await readGlofoxAutomationStatus(db({ data: { settings: {} }, error: null }), LOC)
    expect(s).toMatchObject({ known: true, connected: false })
  })

  it('a failed SETTINGS read is UNKNOWN (never "not connected"), and logged with the code only', async () => {
    const s = await readGlofoxAutomationStatus(db({ data: null, error: { code: '57014', message: 'timeout' } }), LOC)
    expect(s.known).toBe(false)
    expect(s.connected).toBe(null)
    expect(s.membership).toBe(CONFIGURED)
    for (const a of AUTOMATIONS) expect(s.statuses[a.key]).toEqual({ available: false, trialConfigured: false, unknown: true })
    expect(logError).toHaveBeenCalledWith('automations/glofox-status', expect.any(String), { locationId: LOC, code: '57014' })
  })

  it('an UNKNOWN membership state is unknown too, whatever the slice says', async () => {
    membershipStateForPage.mockResolvedValue(UNKNOWN)
    const s = await readGlofoxAutomationStatus(db({ data: { settings: WITH_TRIAL }, error: null }), LOC)
    expect(s).toMatchObject({ known: false, connected: null, membership: UNKNOWN })
    for (const a of AUTOMATIONS) expect(s.statuses[a.key]).toEqual({ available: false, trialConfigured: false, unknown: true })
  })

  it('a missing row is unknown too (the active location vanished mid-request)', async () => {
    const s = await readGlofoxAutomationStatus(db({ data: null, error: null }), LOC)
    expect(s.known).toBe(false)
  })

  it('a thrown read is unknown, not a crash', async () => {
    const d = { from: () => { throw new Error('socket hang up') } }
    const s = await readGlofoxAutomationStatus(d, LOC)
    expect(s.known).toBe(false)
  })

  it('no location: known and not connected, with no settings read (as when location was null before)', async () => {
    membershipStateForPage.mockResolvedValue(NONE)
    const d = db({ data: null, error: null })
    const s = await readGlofoxAutomationStatus(d, null)
    expect(s).toMatchObject({ known: true, connected: false, membership: NONE })
    expect(d.calls.table).toBeUndefined()
    expect(membershipStateForPage).toHaveBeenCalledWith(d, null)
  })
})
