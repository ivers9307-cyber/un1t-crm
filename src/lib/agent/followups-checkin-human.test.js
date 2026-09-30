// src/lib/agent/followups-checkin-human.test.js
// CHECKINSTALL.2 (C98, Richard's call D1, C104) — every app/front-desk-booked
// first-timer gets the automated booking_class_confirmed_ template (source
// 'api', no sent_by). The check-in runner read ANY non-agent outbound as "a
// human owns this thread", so those leads were skipped human_active on every
// tick (3 of them 25-27 Sep, 9 since 24 Aug). Now only a PERSON
// (isStaffOutbound) parks the check-in.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }) }))

import { runFirstClassCheckins } from './followups'

const H = 3600_000
const NOW = Date.UTC(2026, 8, 25, 13, 0, 0) // 14:00 Dublin
// No template configured: a candidate that gets PAST the human check lands on
// no_template_configured (Case B) without any send being mocked.
const LOCATION = { id: 'loc1', name: 'Stillorgan', settings: { customer_agent: { enabled: true, first_class_checkin: { enabled: true, delay_hours: 2 } } } }
const CONTACT = {
  id: 'c1', first_name: 'Alex', name: 'Alex Example', wa_phone: '353870000000', phone: '353870000000',
  pipeline_stage_slug: 'first_class', last_attended_at: new Date(NOW - 3 * H).toISOString(),
  first_class_checkin_at: null, recent_bookings: [], wa_status: 'active',
}
const CONV = { id: 'conv1', agent_active: true, agent_paused_at: null, agent_handed_off_at: null }
const at = (hAgo) => new Date(NOW - hAgo * H).toISOString()
const inbound = (hAgo) => ({ direction: 'inbound', source: 'api', sent_by: null, created_at: at(hAgo) })
const auto = (hAgo, template_name = 'booking_class_confirmed_') => ({ direction: 'outbound', source: 'api', sent_by: null, message_type: 'template', template_name, created_at: at(hAgo) })
const staff = (hAgo) => ({ direction: 'outbound', source: 'api', sent_by: 'profile-1', message_type: 'text', created_at: at(hAgo) })
// The react route stores no sent_by (a reaction is not a reply; see its test).
const reaction = (hAgo) => ({ direction: 'outbound', source: 'api', sent_by: null, message_type: 'reaction', body: 'Reacted: 👍', created_at: at(hAgo) })
const phoneApp = (hAgo) => ({ direction: 'outbound', source: 'app_echo', sent_by: null, message_type: 'text', created_at: at(hAgo) })

function stubDb(messages) {
  return {
    from(table) {
      const state = { head: false }
      const finish = () => {
        if (table === 'locations') return { data: [LOCATION], error: null }
        if (table === 'contacts') return state.head ? { count: 0, error: null } : { data: [CONTACT], error: null }
        if (table === 'whatsapp_conversations') return { data: [CONV], error: null }
        if (table === 'whatsapp_messages') return { data: [...messages].reverse(), error: null } // runner reads newest-first
        return { data: [], error: null }
      }
      const b = {
        select: (_c, o) => { if (o?.head) state.head = true; return b },
        update: () => b, insert: () => Promise.resolve({ error: null }),
        eq: () => b, in: () => b, gte: () => b, lte: () => b, is: () => b, not: () => b, or: () => b, order: () => b, limit: () => b,
        maybeSingle: () => b, single: () => b,
        then: (ok, bad) => Promise.resolve(finish()).then(ok, bad),
      }
      return b
    },
  }
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())

describe('runFirstClassCheckins — who parks a check-in (CHECKINSTALL.2)', () => {
  it('an automated booking confirmation alone does NOT park it (the C98 leads)', async () => {
    const res = await runFirstClassCheckins(stubDb([auto(40)]), { nowMs: NOW })
    expect(res.reasons.human_active).toBeUndefined()
    expect(res.reasons.no_template_configured).toBe(1)
  })

  it('several automations (confirmations + end_of_trial_) do not either', async () => {
    const res = await runFirstClassCheckins(stubDb([auto(200), auto(100), auto(50, 'end_of_trial_')]), { nowMs: NOW })
    expect(res.reasons.human_active).toBeUndefined()
    expect(res.reasons.no_template_configured).toBe(1)
  })

  it('an automation after the customer\'s last message does not park it', async () => {
    const res = await runFirstClassCheckins(stubDb([inbound(30), auto(29)]), { nowMs: NOW })
    expect(res.reasons.human_active).toBeUndefined()
    expect(res.reasons.no_template_configured).toBe(1)
  })

  it('a staff reply (sent_by set) after their message still parks it', async () => {
    const res = await runFirstClassCheckins(stubDb([inbound(30), staff(29)]), { nowMs: NOW })
    expect(res.reasons).toEqual({ human_active: 1 })
  })

  it('a staff message with no inbound at all still parks it', async () => {
    const res = await runFirstClassCheckins(stubDb([auto(40), staff(20)]), { nowMs: NOW })
    expect(res.reasons).toEqual({ human_active: 1 })
  })

  // Intended consequence of the C104 review: a staff reaction is not a reply
  // (the react route stores no sent_by), so it does not park the check-in.
  it('a staff REACTION after the inbound does NOT park it (no sent_by, so not staff)', async () => {
    const res = await runFirstClassCheckins(stubDb([inbound(30), reaction(29)]), { nowMs: NOW })
    expect(res.reasons.human_active).toBeUndefined()
    expect(res.reasons.no_template_configured).toBe(1)
  })

  it('a reply from the studio phone app (app_echo) still parks it', async () => {
    const res = await runFirstClassCheckins(stubDb([inbound(30), phoneApp(29)]), { nowMs: NOW })
    expect(res.reasons).toEqual({ human_active: 1 })
  })

  it('the customer writing again after staff un-parks it', async () => {
    const res = await runFirstClassCheckins(stubDb([staff(40), inbound(30)]), { nowMs: NOW })
    expect(res.reasons.human_active).toBeUndefined()
    expect(res.reasons.no_template_configured).toBe(1)
  })
})
