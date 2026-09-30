// src/lib/agent/followups-thread.test.js
// CHECKINSTALL.1 — who "spoke" in a WhatsApp thread. Automations (booking
// confirmations, sequences, broadcasts, end-of-trial) insert source='api'
// (the column default) with NO sent_by; operator routes stamp sent_by; the
// studio phone's WhatsApp app shows up as app_echo/history_sync.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }) }))

import { isStaffOutbound, summariseThread, runAgentFollowups } from './followups'

const T = (h) => new Date(Date.UTC(2026, 8, 25, h)).toISOString()
const inbound = (h) => ({ direction: 'inbound', source: 'api', sent_by: null, created_at: T(h) })
const auto = (h) => ({ direction: 'outbound', source: 'api', sent_by: null, message_type: 'template', created_at: T(h) })
const staff = (h) => ({ direction: 'outbound', source: 'api', sent_by: 'profile-1', created_at: T(h) })
const mia = (h) => ({ direction: 'outbound', source: 'agent', sent_by: null, body: 'hi', created_at: T(h) })

describe('isStaffOutbound', () => {
  it('an automation (api, no sent_by) is not staff', () => expect(isStaffOutbound(auto(1))).toBe(false))
  it('an operator send (sent_by set) is staff', () => expect(isStaffOutbound(staff(1))).toBe(true))
  it('the studio phone app is staff', () => {
    expect(isStaffOutbound({ direction: 'outbound', source: 'app_echo', sent_by: null })).toBe(true)
    expect(isStaffOutbound({ direction: 'outbound', source: 'history_sync', sent_by: null })).toBe(true)
    expect(isStaffOutbound({ direction: 'outbound', source: 'operator', sent_by: null })).toBe(true)
  })
  it('Mia is never staff, even with a sent_by', () => expect(isStaffOutbound({ ...mia(1), sent_by: 'x' })).toBe(false))
  it('an inbound is never staff', () => expect(isStaffOutbound({ ...inbound(1), sent_by: 'x' })).toBe(false))
})

describe('summariseThread', () => {
  it('automation only, no inbound: the ladder flag is set (unchanged), the staff flag is not', () => {
    const s = summariseThread([auto(1)])
    expect(s.lastInboundAtMs).toBeNull()
    expect(s.humanSpokeAfterInbound).toBe(true)
    expect(s.staffSpokeAfterInbound).toBe(false)
  })
  it('a staff reply after the inbound sets both', () => {
    const s = summariseThread([inbound(1), staff(2)])
    expect(s.humanSpokeAfterInbound).toBe(true)
    expect(s.staffSpokeAfterInbound).toBe(true)
  })
  it('a newer inbound resets every flag', () => {
    const s = summariseThread([staff(1), inbound(2)])
    expect(s.lastInboundAtMs).toBe(Date.parse(T(2)))
    expect(s.humanSpokeAfterInbound).toBe(false)
    expect(s.staffSpokeAfterInbound).toBe(false)
  })
  it('Mia after the inbound: agent flag + her text, no human', () => {
    const s = summariseThread([inbound(1), mia(2)])
    expect(s.agentSpokeAfterInbound).toBe(true)
    expect(s.agentTexts).toEqual(['hi'])
    expect(s.humanSpokeAfterInbound).toBe(false)
  })
})

// The follow-up ladder reads the same thread. A failed read used to come back
// as an empty thread (no inbound, so a quiet skip with no reason logged); it is
// now a named skip that stops before any further read for that conversation.
describe('runAgentFollowups — a failed thread read (CHECKINSTALL.1)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('skips as thread_read_failed and reads nothing else for that conversation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const NOW = Date.UTC(2026, 8, 25, 13, 0, 0) // 14:00 Dublin
    const read = []
    const db = {
      from(table) {
        read.push(table)
        const finish = () => {
          if (table === 'locations') return { data: [{ id: 'loc1', settings: { customer_agent: { enabled: true, followups: { enabled: true } } } }], error: null }
          if (table === 'whatsapp_conversations') return { data: [{ id: 'conv1', contact_id: 'c1', location_id: 'loc1', agent_followup_stage: 0, contacts: { first_name: 'A', wa_phone: '353870000000', wa_status: 'active' } }], error: null }
          if (table === 'whatsapp_messages') return { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }
          return { data: [], error: null }
        }
        const b = {
          select: () => b, eq: () => b, in: () => b, gte: () => b, lt: () => b, is: () => b, order: () => b, limit: () => b,
          then: (ok, bad) => Promise.resolve(finish()).then(ok, bad),
        }
        return b
      },
    }
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res).toMatchObject({ nudges: 0, templates: 0, skipped: 1 })
    expect(warn.mock.calls.some((c) => String(c[1]).includes('thread_read_failed'))).toBe(true)
    expect(read).not.toContain('agent_membership_requests')
  })
})
