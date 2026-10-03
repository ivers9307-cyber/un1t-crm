// PROFILESPREAD.1 (F6) — the automations pages used to read Glofox presence
// off user.activeLocation.settings, which is why every page carried the
// location's settings. They now read it by id with the service role. A
// failed read is "unknown", never "not connected". Fictional values only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { readGlofoxAutomationStatus } from './glofox-status.js'
import { AUTOMATIONS } from './registry.js'
import { logError } from '@/lib/log'

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
const CONNECTED = { glofox: { branch_id: 'b', api_key: 'SYNTH-K', api_token: 'SYNTH-T', trial_membership_id: 'm', trial_plan_code: 'p' } }

beforeEach(() => vi.clearAllMocks())

describe('readGlofoxAutomationStatus', () => {
  it('reads settings by id and returns booleans only (no settings, no credential)', async () => {
    const d = db({ data: { settings: CONNECTED }, error: null })
    const s = await readGlofoxAutomationStatus(d, LOC)
    expect(d.calls).toEqual({ table: 'locations', select: 'settings', eq: ['id', LOC] })
    expect(s.known).toBe(true)
    expect(s.connected).toBe(true)
    expect(s.statuses.glofox_lead_provisioning).toEqual({ available: true, trialConfigured: true })
    expect(s.statuses.class_climate).toEqual({ available: true, trialConfigured: false })
    expect(Object.keys(s.statuses).sort()).toEqual(AUTOMATIONS.map((a) => a.key).sort())
    expect(JSON.stringify(s)).not.toMatch(/SYNTH-|settings|branch/)
  })

  it('not connected is a KNOWN false', async () => {
    const s = await readGlofoxAutomationStatus(db({ data: { settings: { glofox: { branch_id: 'b' } } }, error: null }), LOC)
    expect(s).toMatchObject({ known: true, connected: false })
    expect(s.statuses.glofox_lead_provisioning).toEqual({ available: false, trialConfigured: false })
  })

  it('a failed read is UNKNOWN (never "not connected"), and logged with the code only', async () => {
    const s = await readGlofoxAutomationStatus(db({ data: null, error: { code: '57014', message: 'timeout' } }), LOC)
    expect(s.known).toBe(false)
    expect(s.connected).toBe(null)
    for (const a of AUTOMATIONS) expect(s.statuses[a.key]).toEqual({ available: false, trialConfigured: false, unknown: true })
    expect(logError).toHaveBeenCalledWith('automations/glofox-status', expect.any(String), { locationId: LOC, code: '57014' })
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

  it('no location: known and not connected, with no read (as when location was null before)', async () => {
    const d = db({ data: null, error: null })
    const s = await readGlofoxAutomationStatus(d, null)
    expect(s).toMatchObject({ known: true, connected: false })
    expect(d.calls.table).toBeUndefined()
  })
})
