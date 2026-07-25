// MIA-REVIEW.3 (3.2) — the first-class check-in runner used to look up the
// contact's conversation selecting only agent_handed_off_at, and skipped on
// that alone. The sticky operator pause (mig 435 whatsapp_conversations
// .agent_paused_at, the inbox "pause Mia" button) deliberately does NOT stamp
// agent_handed_off_at, and shouldAgentReply's contract is that a paused thread
// stays FULLY silent — so Mia could send a proactive check-in into a thread an
// operator had just paused. The followup runner already guarded this
// (.is('agent_paused_at', null) + .eq('agent_active', true)); this pins the
// same contract on the check-in runner.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }),
}))

import { runFirstClassCheckins } from './followups'

const H = 3600_000
const NOW = Date.UTC(2026, 5, 12, 13, 0, 0) // 14:00 Dublin — inside the band

const LOCATION = {
  id: 'loc1',
  name: 'Stillorgan',
  settings: { customer_agent: { enabled: true, first_class_checkin: { enabled: true, delay_hours: 2 } } },
}

const CONTACT = {
  id: 'c1',
  first_name: 'Jane',
  name: 'Jane Murphy',
  wa_phone: '353870000000',
  phone: '353870000000',
  pipeline_stage_slug: 'first_class',
  last_attended_at: new Date(NOW - 3 * H).toISOString(),
  first_class_checkin_at: null,
  recent_bookings: [{ event_name: 'ARENA', time_start: Math.floor((NOW - 3 * H) / 1000), attended: true }],
  wa_status: 'active',
}

// Thenable-builder stub keyed by table. `conversation` is the row the
// contact's conversation lookup returns (null = no thread yet).
function checkinDb({ conversation, contacts = [CONTACT], onInsert = () => {} }) {
  return {
    from(table) {
      const state = { selectOpts: null }
      const finish = () => {
        if (table === 'locations') return { data: [LOCATION], error: null }
        if (table === 'contacts') {
          if (state.selectOpts?.head) return { count: 0, error: null }
          return { data: contacts, error: null }
        }
        if (table === 'whatsapp_conversations') return { data: conversation ? [conversation] : [], error: null }
        return { data: [], error: null }
      }
      const b = {
        select: (_cols, opts) => { if (opts) state.selectOpts = opts; return b },
        update: () => b,
        insert: (row) => { onInsert(table, row); return Promise.resolve({ error: null }) },
        eq: () => b, in: () => b, gte: () => b, is: () => b, not: () => b,
        or: () => b, order: () => b, limit: () => b,
        maybeSingle: () => b, single: () => b,
        then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
      }
      return b
    },
  }
}

let warnSpy, errSpy
beforeEach(() => {
  vi.clearAllMocks()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { warnSpy.mockRestore(); errSpy.mockRestore() })

describe('runFirstClassCheckins — operator-pause guards', () => {
  it('skips a thread an operator PAUSED (agent_paused_at set, no handoff stamp)', async () => {
    const db = checkinDb({
      conversation: { id: 'conv1', agent_active: true, agent_paused_at: '2026-06-12T09:00:00Z', agent_handed_off_at: null },
    })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons.agent_paused).toBe(1)
    expect(res.freeform + res.templates).toBe(0)
  })

  it('skips a thread whose agent was switched OFF (agent_active false)', async () => {
    const db = checkinDb({
      conversation: { id: 'conv1', agent_active: false, agent_paused_at: null, agent_handed_off_at: null },
    })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons.agent_inactive).toBe(1)
    expect(res.freeform + res.templates).toBe(0)
  })

  it('still skips a handed-off thread (unchanged behaviour)', async () => {
    const db = checkinDb({
      conversation: { id: 'conv1', agent_active: false, agent_paused_at: null, agent_handed_off_at: '2026-06-12T09:00:00Z' },
    })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons.handed_off).toBe(1)
  })

  it('an unpaused thread is NOT skipped by these guards', async () => {
    const db = checkinDb({
      conversation: { id: 'conv1', agent_active: true, agent_paused_at: null, agent_handed_off_at: null },
    })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons.agent_paused).toBeUndefined()
    expect(res.reasons.agent_inactive).toBeUndefined()
    expect(res.reasons.handed_off).toBeUndefined()
  })
})

// MIA-REVIEW.3 (3.17) — operator quiet_hours now gate the proactive runners,
// not just the live reply path.
describe('runFirstClassCheckins — operator quiet hours', () => {
  it('sends nothing while the location is inside its configured quiet hours', async () => {
    const db = checkinDb({ conversation: null })
    const quietLocation = {
      ...LOCATION,
      settings: {
        customer_agent: {
          ...LOCATION.settings.customer_agent,
          quiet_hours: { start: '13:00', end: '09:00', tz: 'Europe/Dublin' },
        },
      },
    }
    // Swap the location the stub serves.
    const quietDb = { from: (t) => (t === 'locations'
      ? { select: () => ({ eq: () => Promise.resolve({ data: [quietLocation], error: null }) }) }
      : db.from(t)) }
    const res = await runFirstClassCheckins(quietDb, { nowMs: NOW })
    expect(res.reasons.operator_quiet_hours).toBe(1)
    expect(res.freeform + res.templates).toBe(0)
  })
})
