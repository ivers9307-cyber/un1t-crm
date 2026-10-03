// src/lib/agent/followups-checkin-reads.test.js
// CHECKINSTALL.1 — the check-in runner discarded four read errors: a failed
// conversation read looked like "no thread" and a failed thread read like "no
// human" (both → send a template), a failed consent read STAMPED the contact
// "skipped — no marketing consent" for ever, and a failed template read
// looked like "not approved". Each is now a named skip, and nothing is stamped.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }) }))
// Only the human-rule tests below reach a send; these stand in for it.
const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.test' }))
vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage,
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.test' })),
  headerComponentFor: () => null,
  getOrCreateConversation: vi.fn(async () => 'conv1'),
}))
vi.mock('@/lib/radar-outreach', () => ({ extractTemplateBody: () => ({ varCount: 0 }) }))

import { runFirstClassCheckins } from './followups'

const H = 3600_000
const NOW = Date.UTC(2026, 8, 25, 13, 0, 0) // 14:00 Dublin
const LOCATION = {
  id: 'loc1', name: 'Stillorgan',
  settings: { customer_agent: { enabled: true, first_class_checkin: { enabled: true, delay_hours: 2, template_name: 'agent_first_class_checkin_v1' } } },
}
const CONTACT = {
  id: 'c1', first_name: 'Alex', name: 'Alex Example', wa_phone: '353870000000', phone: '353870000000',
  pipeline_stage_slug: 'first_class', last_attended_at: new Date(NOW - 3 * H).toISOString(),
  first_class_checkin_at: null, recent_bookings: [], wa_status: 'active',
}
const CONV = { id: 'conv1', agent_active: true, agent_paused_at: null, agent_handed_off_at: null }
const BOOM = { message: 'canceling statement due to statement timeout', code: '57014' }

// Thenable stub keyed by table. `errors[table]` answers that table's read with an error.
function stubDb({ conversation = CONV, messages = [], errors = {}, prefs = { whatsapp_marketing: true }, templates = [] } = {}) {
  const updates = []
  const inserts = []
  return {
    updates, inserts,
    from(table) {
      const state = { head: false }
      const finish = () => {
        if (errors[table]) return { data: null, error: errors[table] }
        if (table === 'locations') return { data: [LOCATION], error: null }
        if (table === 'contacts') return state.head ? { count: 0, error: null } : { data: [CONTACT], error: null }
        if (table === 'whatsapp_conversations') return { data: conversation ? [conversation] : [], error: null }
        if (table === 'whatsapp_messages') return { data: [...messages].reverse(), error: null } // runner reads newest-first
        if (table === 'contact_preferences') return { data: prefs, error: null }
        if (table === 'whatsapp_templates') return { data: templates, error: null }
        return { data: [], error: null }
      }
      const b = {
        select: (_c, o) => { if (o?.head) state.head = true; return b },
        update: (patch) => { updates.push({ table, patch }); return b },
        insert: (row) => { inserts.push({ table, row }); return Promise.resolve({ error: null }) },
        eq: () => b, in: () => b, gte: () => b, lte: () => b, is: () => b, not: () => b, or: () => b, order: () => b, limit: () => b,
        maybeSingle: () => b, single: () => b,
        then: (ok, bad) => Promise.resolve(finish()).then(ok, bad),
      }
      return b
    },
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const stamped = (db) => db.updates.some((u) => u.table === 'contacts' && 'first_class_checkin_at' in u.patch)

describe('runFirstClassCheckins — reads fail closed (CHECKINSTALL.1)', () => {
  it('counts the candidates the query returned', async () => {
    const res = await runFirstClassCheckins(stubDb({ errors: { contact_preferences: BOOM } }), { nowMs: NOW })
    expect(res.candidates).toBe(1)
  })

  it('a failed conversation read is conversation_read_failed, not "no thread"', async () => {
    const db = stubDb({ errors: { whatsapp_conversations: BOOM } })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ conversation_read_failed: 1 })
    expect(stamped(db)).toBe(false)
  })

  it('a failed thread read is thread_read_failed, not "nobody spoke"', async () => {
    const db = stubDb({ errors: { whatsapp_messages: BOOM } })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ thread_read_failed: 1 })
    expect(stamped(db)).toBe(false)
  })

  it('a failed consent read never stamps "no marketing consent" for ever', async () => {
    const db = stubDb({ conversation: null, errors: { contact_preferences: BOOM } })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ consent_read_failed: 1 })
    expect(stamped(db)).toBe(false)
    expect(db.inserts.filter((i) => i.table === 'activities')).toHaveLength(0)
  })

  it('a failed template read is template_read_failed, not "not approved"', async () => {
    const db = stubDb({ conversation: null, errors: { whatsapp_templates: BOOM } })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ template_read_failed: 1 })
    expect(stamped(db)).toBe(false)
  })

  it('a real no-consent answer still stamps (unchanged)', async () => {
    const db = stubDb({ conversation: null, prefs: { whatsapp_marketing: false } })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ no_marketing_consent: 1 })
    expect(stamped(db)).toBe(true)
  })
})

// The check-in runner's human rule, end to end. CHECKINSTALL.1 pinned the OLD
// rule here (an automation after the customer's last message parked the
// check-in). CHECKINSTALL.2 (C104, Richard's yes to D1 on 30 Sep) flipped it ON
// PURPOSE: only a PERSON parks it (sent_by set, or the studio phone app), so an
// automated booking confirmation no longer stops the send. Everything a send
// needs is in place in both tests, so only the human rule decides.
describe('runFirstClassCheckins — the human rule, end to end (CHECKINSTALL.2)', () => {
  const at = (hAgo) => new Date(NOW - hAgo * H).toISOString()
  const APPROVED = [{ name: 'agent_first_class_checkin_v1', language: 'en', status: 'APPROVED', components: [], header_media_url: null }]
  const inbound = { direction: 'inbound', source: 'api', sent_by: null, created_at: at(30) }

  it('an automated outbound (api, no sent_by) after the inbound no longer parks it: the check-in is sent', async () => {
    sendTemplateMessage.mockClear()
    const db = stubDb({
      messages: [
        inbound,
        { direction: 'outbound', source: 'api', sent_by: null, message_type: 'template', template_name: 'booking_class_confirmed_', created_at: at(29) },
      ],
      templates: APPROVED,
    })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons).toEqual({})
    expect(res).toMatchObject({ templates: 1, freeform: 0, skipped: 0 })
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(sendTemplateMessage.mock.calls[0][1]).toBe('agent_first_class_checkin_v1')
    expect(stamped(db)).toBe(true)
  })

  it('a staff message (sent_by set) after the inbound still parks it: human_active, nothing sent', async () => {
    sendTemplateMessage.mockClear()
    const db = stubDb({
      messages: [
        inbound,
        { direction: 'outbound', source: 'api', sent_by: 'profile-1', message_type: 'text', created_at: at(29) },
      ],
      templates: APPROVED,
    })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ human_active: 1 })
    expect(res).toMatchObject({ templates: 0, freeform: 0, skipped: 1 })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(stamped(db)).toBe(false)
  })
})
