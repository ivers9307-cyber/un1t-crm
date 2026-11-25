// INBOXFOLLOW.2 — Mia's proactive messages leave an actively snoozed thread
// alone: the follow-up ladder and the first-class check-in. A snooze that has
// ended no longer holds anything back.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }) }))

import { runAgentFollowups, runFirstClassCheckins } from './followups'
import { STILLORGAN_BLOB } from './settings-fixtures.test-helpers'

const H = 3600_000
const STILL = 'a0000000-0000-0000-0000-0000000000a1'
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0) // 13:00 Dublin
const ahead = (h) => new Date(NOW + h * H).toISOString()
const ago = (h) => new Date(NOW - h * H).toISOString()

const LOCATION = { id: STILL, name: 'Stillorgan', organization_id: null, settings: { customer_agent: STILLORGAN_BLOB } }

// `convs` answers the whatsapp_conversations read; `reads` records every table touched.
function tickDb({ convs = [], contacts = [] }) {
  const reads = []
  return {
    reads,
    from(table) {
      reads.push(table)
      const state = { selectOpts: null }
      const finish = () => {
        if (table === 'location_whatsapp_numbers') return { data: [{ location_id: STILL }], error: null }
        if (table === 'locations') return { data: [LOCATION], error: null }
        if (table === 'contacts') return state.selectOpts?.head ? { count: 0, error: null } : { data: contacts, error: null }
        if (table === 'whatsapp_conversations') return { data: convs, error: null }
        return { data: [], error: null }
      }
      const b = {
        select: (_c, opts) => { if (opts) state.selectOpts = opts; return b },
        update: () => b, eq: () => b, in: () => b, gte: () => b, lte: () => b, lt: () => b, is: () => b, not: () => b,
        or: () => b, order: () => b, limit: () => b, range: () => b, maybeSingle: () => b, single: () => b,
        then: (ok, bad) => Promise.resolve(finish()).then(ok, bad),
      }
      return b
    },
  }
}

let warn
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const followupCandidate = (extra = {}) => ({
  id: 'conv-1', contact_id: 'c1', location_id: STILL, agent_active: true, agent_handed_off_at: null,
  resolved_at: null, agent_followup_stage: 0, last_message_at: ago(5), snoozed_until: null,
  contacts: { first_name: 'Jane', name: 'Jane Murphy', wa_phone: '353870000000', phone: '353870000000', wa_status: 'active' },
  ...extra,
})

describe('runAgentFollowups — snoozed threads', () => {
  it('skips a thread with an active snooze, logs it, and reads no messages for it', async () => {
    const db = tickDb({ convs: [followupCandidate({ snoozed_until: ahead(3) })] })
    const out = await runAgentFollowups(db, { nowMs: NOW })
    expect(out.skipped).toBe(1)
    expect(out.nudges + out.templates).toBe(0)
    expect(warn.mock.calls.some((c) => String(c[1]).includes('"reason":"snoozed"'))).toBe(true)
    expect(db.reads).not.toContain('whatsapp_messages')
  })

  it('a snooze that has ended no longer holds the thread back', async () => {
    const db = tickDb({ convs: [followupCandidate({ snoozed_until: ago(1) })] })
    await runAgentFollowups(db, { nowMs: NOW })
    expect(warn.mock.calls.some((c) => String(c[1]).includes('"reason":"snoozed"'))).toBe(false)
    expect(db.reads).toContain('whatsapp_messages')
  })
})

describe('runFirstClassCheckins — snoozed threads', () => {
  const CONTACT = {
    id: 'c1', first_name: 'Jane', name: 'Jane Murphy', wa_phone: '353870000000', phone: '353870000000',
    pipeline_stage_slug: 'first_class', last_attended_at: ago(3), first_class_checkin_at: null,
    recent_bookings: [{ event_name: 'ARENA', time_start: Math.floor((NOW - 3 * H) / 1000), attended: true }],
    wa_status: 'active',
  }
  const conversation = (extra = {}) => ({ id: 'conv-1', agent_active: true, agent_paused_at: null, agent_handed_off_at: null, staff_owned_since: null, snoozed_until: null, ...extra })

  it('skips with reason snoozed while the snooze is active, sending nothing', async () => {
    const db = tickDb({ contacts: [CONTACT], convs: [conversation({ snoozed_until: ahead(3) })] })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons.snoozed).toBe(1)
    expect(res.freeform + res.templates).toBe(0)
    expect(db.reads).not.toContain('whatsapp_messages')
  })

  it('an ended snooze is not a reason to skip', async () => {
    const db = tickDb({ contacts: [CONTACT], convs: [conversation({ snoozed_until: ago(1) })] })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons.snoozed).toBeUndefined()
  })
})
