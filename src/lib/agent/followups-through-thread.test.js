// src/lib/agent/followups-through-thread.test.js
// MIAORG.1 Task 6 — follow-ups and first-class check-ins go out through the
// thread's number.
//
// A studio with its own active WhatsApp number (Stillorgan) sends exactly as
// before: { locationId }, its own templates, today's conversation handling
// (T6-A). A studio with none (Hatch Street: its threads are stamped with
// Stillorgan's number, WAHOMESTUDIO.1) sends only through a thread whose
// stamped number resolves (replyInConversation), with templates from that
// number's owner (templateLocationIdFor), and never opens a thread it could
// not answer (T6-B). A number refusal there is a recorded skip (T6-B). The
// prompt follows the studio's membership source off the location row (T6-D).
// Daily caps stay per studio (T6-E). Fictional ids throughout.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }) }))
vi.mock('@/lib/radar-outreach', () => ({ extractTemplateBody: () => ({ varCount: 0 }) }))
const anthropicMessages = vi.fn()
vi.mock('@/lib/anthropic', () => ({ anthropicMessages }))

const sendTextMessage = vi.fn(async () => ({ messageId: 'wamid.text' }))
const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.tpl' }))
const getOrCreateConversation = vi.fn(async () => 'conv-new')
vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage,
  sendTemplateMessage,
  headerComponentFor: () => null,
  getOrCreateConversation,
}))

const getConversationNumberConfig = vi.fn()
const templateLocationIdFor = vi.fn()
// The real locationsWithWhatsApp runs over the stub db (WAORGNUMBER.1).
vi.mock('@/lib/whatsapp-config', async (importOriginal) => ({
  locationsWithWhatsApp: (await importOriginal()).locationsWithWhatsApp,
  getConversationNumberConfig,
  templateLocationIdFor,
}))

// The source must come off the location row: a separate read is a failure.
const resolveMembershipSource = vi.fn(async () => { throw new Error('separate membership-source read') })
vi.mock('@/lib/membership/source', async (importOriginal) => ({ ...(await importOriginal()), resolveMembershipSource }))

const { runAgentFollowups, runFirstClassCheckins, composeAgentText, promptCapabilityFor } = await import('./followups')
const { composeAgentText: composeSuggestionText, composeApprovalSuggestion, zonedDateString } = await import('./approval-suggest')
const { buildCachedSystem } = await import('./prompt')
const { WhatsAppNumberMissingError } = await import('@/lib/whatsapp-number-missing')
const { todayStrIn } = await import('@/lib/location-time')

const H = 3600_000
const NOW = Date.UTC(2026, 8, 25, 13, 0, 0) // 14:00 Dublin
const STILL = 'a0000000-0000-0000-0000-0000000000a1'
const HATCH = 'a0000000-0000-0000-0000-0000000000a2'
const STILL_NUMBER_CONFIG = { id: 'num-still', locationId: STILL, phoneNumberId: 'pn-still', token: 't' }
const BOOK_URL = 'https://book.example.test/hatch'

const agentBlob = (extra = {}) => ({
  enabled: true,
  followups: { enabled: true, nudge_after_hours: 3, template_name: 'agent_followup_v1', daily_cap: 50 },
  first_class_checkin: { enabled: true, delay_hours: 2, template_name: 'agent_first_class_checkin_v1', daily_cap: 20 },
  ...extra,
})
const STILL_LOC = { id: STILL, name: 'Stillorgan', organization_id: null, membership_source: 'glofox', settings: { customer_agent: agentBlob() } }
const HATCH_LOC = { id: HATCH, name: 'Hatch Street', organization_id: null, membership_source: 'un1t_online', settings: { customer_agent: agentBlob({ booking_url: BOOK_URL }) } }

const T = (ms) => new Date(ms).toISOString()
const inbound = (ms) => ({ direction: 'inbound', source: 'api', sent_by: null, body: 'Can I come Tuesday?', created_at: T(ms) })
const mia = (ms) => ({ direction: 'outbound', source: 'agent', sent_by: null, body: 'Sure, which class would suit?', created_at: T(ms) })
const APPROVED = (name) => [{ name, language: 'en', status: 'APPROVED', components: [], header_media_url: null }]

// A recording stub. `cfg`:
//   location        the one active studio
//   ownsNumber      what the location_whatsapp_numbers read answers (WAORGNUMBER.1: a
//                   number switched on at the studio) — true / false / 'error'
//   followConvs     follow-up candidate rows
//   checkinConv     the contact's thread at the studio for a check-in (or null)
//   messages        the thread (oldest first; the stub answers newest first)
//   contacts        check-in candidates
//   templateStudio  the only studio whose whatsapp_templates answer APPROVED
//   sentToday       the follow-up head count
function stubDb(cfg) {
  const log = []
  const answer = (q) => {
    const has = (...f) => q.filters.some((x) => JSON.stringify(x) === JSON.stringify(f))
    switch (q.table) {
      case 'locations': return { data: [cfg.location], error: null }
      case 'location_whatsapp_numbers':
        if (cfg.ownsNumber === 'error') return { data: null, error: { message: 'statement timeout', code: '57014' } }
        return { data: cfg.ownsNumber ? [{ location_id: cfg.location.id }] : [], error: null }
      case 'whatsapp_conversations':
        if (q.op === 'update') return { data: null, error: null }
        if (q.opts?.head) return { count: cfg.sentToday ?? 0, error: null }
        if (q.filters.some((f) => f[1] === 'contact_id')) return { data: cfg.checkinConv ? [cfg.checkinConv] : [], error: null }
        return { data: cfg.followConvs || [], error: null }
      case 'whatsapp_messages':
        if (q.op === 'insert') return { data: null, error: null }
        return { data: (cfg.messages || []).slice().reverse(), error: null }
      case 'contacts':
        if (q.op === 'update') return { data: [{ id: 'c1' }], error: null }
        if (q.opts?.head) return { count: 0, error: null }
        if (has('is', 'first_class_checkin_at', null)) return { data: cfg.contacts || [], error: null }
        return { data: [], error: null }
      // WAORGNUMBER.3 — the STUDIO's row, never the contact's global flag.
      // cfg.studioConsent: true (default) | false | null (row absent) | 'error'.
      case 'contact_location_preferences': {
        const c = cfg.studioConsent === undefined ? true : cfg.studioConsent
        if (c === 'error') return { data: null, error: { message: 'statement timeout', code: '57014' } }
        return { data: c === null ? null : { whatsapp_marketing: c }, error: null }
      }
      // The global flag says YES everywhere in this file: if the runner still read it,
      // the 'studio says no' tests below could not pass.
      case 'contact_preferences': return { data: { whatsapp_marketing: true }, error: null }
      case 'whatsapp_templates': {
        const name = q.filters.find((f) => f[0] === 'eq' && f[1] === 'name')?.[2]
        return { data: has('eq', 'location_id', cfg.templateStudio) ? APPROVED(name) : [], error: null }
      }
      default: return { data: [], error: null }
    }
  }
  return {
    log,
    from(table) {
      const q = { table, op: 'select', patch: null, filters: [], opts: null }
      const finish = () => { log.push(q); return answer(q) }
      const f = (name) => (...args) => { q.filters.push([name, ...args]); return b }
      const b = {
        select: (_c, o) => { if (o) q.opts = o; return b },
        update: (patch) => { q.op = 'update'; q.patch = patch; return b },
        insert: (row) => { q.op = 'insert'; q.patch = row; return Promise.resolve(finish()) },
        eq: f('eq'), in: f('in'), gte: f('gte'), lt: f('lt'), lte: f('lte'), is: f('is'), not: f('not'),
        order: () => b, limit: () => b, maybeSingle: () => b, single: () => b,
        then: (ok, bad) => Promise.resolve(finish()).then(ok, bad),
      }
      return b
    },
  }
}
const reads = (db, table) => db.log.filter((q) => q.table === table && q.op === 'select')
const writes = (db, table, op) => db.log.filter((q) => q.table === table && q.op === op)
const locFilter = (q) => q.filters.find((f) => f[0] === 'eq' && f[1] === 'location_id')?.[2]
const systemText = (call = anthropicMessages.mock.calls.at(-1)) => call[0].system.map((b) => b.text).join('\n')

const CONV = (loc) => ({
  id: `conv-${loc === STILL ? 'still' : 'hatch'}`, contact_id: 'c1', location_id: loc, agent_active: true,
  agent_handed_off_at: null, resolved_at: null, agent_followup_stage: 0, last_message_at: T(NOW - H),
  contacts: { first_name: 'Alex', name: 'Alex Example', wa_phone: '353870000001', phone: null, wa_status: 'active' },
})
const NUDGE_THREAD = [inbound(NOW - 5 * H), mia(NOW - 5 * H + 60_000)]
const TEMPLATE_THREAD = [inbound(NOW - 30 * H), mia(NOW - 30 * H + 60_000)]

const CONTACT = (id = 'c1', phone = '353870000001') => ({
  id, first_name: 'Alex', name: 'Alex Example', wa_phone: phone, phone: null,
  pipeline_stage_slug: 'first_class', last_attended_at: T(NOW - 3 * H),
  first_class_checkin_at: null, recent_bookings: [], wa_status: 'active',
})
const CHECKIN_CONV = (loc) => ({ id: `conv-${loc === STILL ? 'still' : 'hatch'}`, contact_id: 'c1', location_id: loc, agent_active: true, agent_paused_at: null, agent_handed_off_at: null })

let errSpy
let warnSpy
beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  anthropicMessages.mockResolvedValue({ res: { ok: true, status: 200 }, data: { content: [{ type: 'text', text: 'Hi Alex, still keen on Tuesday?' }] } })
  sendTextMessage.mockResolvedValue({ messageId: 'wamid.text' })
  sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.tpl' })
  // Hatch's threads are stamped with Stillorgan's number (Phase 1).
  getConversationNumberConfig.mockResolvedValue(STILL_NUMBER_CONFIG)
  templateLocationIdFor.mockResolvedValue(STILL)
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.ANTHROPIC_API_KEY
})
const warned = (reason) => warnSpy.mock.calls.some((c) => c.map(String).join(' ').includes(`"${reason}"`))

// ── T6-A ───────────────────────────────────────────────────────────────

describe('T6-A — a studio with its own number sends exactly as before', () => {
  it('follow-up nudge: sendTextMessage(to, text, { locationId }) and nothing else', async () => {
    const db = stubDb({ location: STILL_LOC, ownsNumber: true, followConvs: [CONV(STILL)], messages: NUDGE_THREAD })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res).toMatchObject({ nudges: 1, templates: 0 })
    expect(sendTextMessage.mock.calls).toEqual([['353870000001', 'Hi Alex, still keen on Tuesday?', { locationId: STILL }]])
    expect(getConversationNumberConfig).not.toHaveBeenCalled()
    expect(templateLocationIdFor).not.toHaveBeenCalled()
    expect(resolveMembershipSource).not.toHaveBeenCalled()
    const [rec] = writes(db, 'whatsapp_messages', 'insert')
    expect(rec.patch).toMatchObject({ conversation_id: 'conv-still', location_id: STILL, source: 'agent', message_type: 'text' })
  })

  it('follow-up template: its own studio’s template row, sendTemplateMessage(..., { locationId })', async () => {
    const db = stubDb({ location: STILL_LOC, ownsNumber: true, followConvs: [CONV(STILL)], messages: TEMPLATE_THREAD, templateStudio: STILL })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res).toMatchObject({ templates: 1 })
    expect(reads(db, 'whatsapp_templates').map(locFilter)).toEqual([STILL])
    expect(sendTemplateMessage.mock.calls).toEqual([['353870000001', 'agent_followup_v1', 'en', [], { locationId: STILL }]])
    expect(getConversationNumberConfig).not.toHaveBeenCalled()
    expect(templateLocationIdFor).not.toHaveBeenCalled()
  })

  // ── WAORGNUMBER.3 (R6) — template consent is the studio's ───────────────

  it('follow-up template skipped when the studio row says no even though contact_preferences says yes', async () => {
    const db = stubDb({ location: STILL_LOC, ownsNumber: true, followConvs: [CONV(STILL)], messages: TEMPLATE_THREAD, templateStudio: STILL, studioConsent: false })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res).toMatchObject({ templates: 0 })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(warned('no_studio_whatsapp_consent')).toBe(true)
    expect(reads(db, 'contact_preferences')).toHaveLength(0)
  })

  it('follow-up template skipped when the studio has no row at all (absent = no)', async () => {
    const db = stubDb({ location: STILL_LOC, ownsNumber: true, followConvs: [CONV(STILL)], messages: TEMPLATE_THREAD, templateStudio: STILL, studioConsent: null })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res).toMatchObject({ templates: 0 })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(warned('no_studio_whatsapp_consent')).toBe(true)
  })

  it('follow-up template sent when the studio row says yes, reading THAT studio\'s row', async () => {
    const db = stubDb({ location: STILL_LOC, ownsNumber: true, followConvs: [CONV(STILL)], messages: TEMPLATE_THREAD, templateStudio: STILL, studioConsent: true })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res).toMatchObject({ templates: 1 })
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(reads(db, 'contact_location_preferences').map(locFilter)).toEqual([STILL])
  })

  it('a failed studio-consent read is a logged skip, never a send', async () => {
    const db = stubDb({ location: STILL_LOC, ownsNumber: true, followConvs: [CONV(STILL)], messages: TEMPLATE_THREAD, templateStudio: STILL, studioConsent: 'error' })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res).toMatchObject({ templates: 0 })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(warned('consent_read_failed')).toBe(true)
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('follow-up consent read failed'))).toBe(true)
  })

  it('check-in template skipped when the studio row says no even though contact_preferences says yes', async () => {
    const db = stubDb({ location: STILL_LOC, ownsNumber: true, contacts: [CONTACT()], checkinConv: null, templateStudio: STILL, studioConsent: false })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.templates).toBe(0)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toMatchObject({ no_studio_whatsapp_consent: 1 })
  })

  it('check-in template sent when the studio row says yes', async () => {
    const db = stubDb({ location: STILL_LOC, ownsNumber: true, contacts: [CONTACT()], checkinConv: null, templateStudio: STILL, studioConsent: true })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.templates).toBe(1)
    expect(reads(db, 'contact_location_preferences').map(locFilter)).toEqual([STILL])
  })

  it('check-in Case A (open window): sendTextMessage(to, text, { locationId })', async () => {
    const db = stubDb({ location: STILL_LOC, ownsNumber: true, contacts: [CONTACT()], checkinConv: CHECKIN_CONV(STILL), messages: [inbound(NOW - 4 * H)] })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.freeform).toBe(1)
    expect(sendTextMessage.mock.calls).toEqual([['353870000001', 'Hi Alex, still keen on Tuesday?', { locationId: STILL }]])
    expect(getConversationNumberConfig).not.toHaveBeenCalled()
  })

  it('check-in Case B with no thread: own template, { locationId }, and the thread opened after the send as today', async () => {
    const db = stubDb({ location: STILL_LOC, ownsNumber: true, contacts: [CONTACT()], checkinConv: null, templateStudio: STILL })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.templates).toBe(1)
    expect(reads(db, 'whatsapp_templates').map(locFilter)).toEqual([STILL])
    expect(sendTemplateMessage.mock.calls).toEqual([['353870000001', 'agent_first_class_checkin_v1', 'en', [], { locationId: STILL }]])
    expect(getOrCreateConversation).toHaveBeenCalledTimes(1)
    expect(getOrCreateConversation.mock.calls[0][2]).toBe(STILL)
    expect(writes(db, 'whatsapp_messages', 'insert')[0].patch).toMatchObject({ conversation_id: 'conv-new', location_id: STILL })
    expect(templateLocationIdFor).not.toHaveBeenCalled()
  })

  it('a failed number read is "owns a number": today’s call, logged', async () => {
    const db = stubDb({ location: STILL_LOC, ownsNumber: 'error', followConvs: [CONV(STILL)], messages: NUDGE_THREAD })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res.nudges).toBe(1)
    expect(sendTextMessage.mock.calls[0][2]).toEqual({ locationId: STILL })
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('studio WhatsApp number unreadable'))).toBe(true)
  })

  it('the number is read once per studio per tick, not per conversation', async () => {
    const two = [CONV(STILL), { ...CONV(STILL), id: 'conv-still-2', contact_id: 'c2' }]
    const db = stubDb({ location: STILL_LOC, ownsNumber: true, followConvs: two, messages: NUDGE_THREAD })
    await runAgentFollowups(db, { nowMs: NOW })
    expect(sendTextMessage).toHaveBeenCalledTimes(2)
    expect(reads(db, 'location_whatsapp_numbers')).toHaveLength(1)
    expect(reads(db, 'location_whatsapp_numbers')[0].filters).toEqual([['in', 'location_id', [STILL]], ['eq', 'whatsapp_numbers.is_active', true]])
  })

  // WAORGNUMBER.1 — "owns a number" is a number switched on at the studio, not
  // one homed there: the read never touches whatsapp_numbers.
  it('a studio with a switched-on org number sends with { locationId }', async () => {
    const db = stubDb({ location: HATCH_LOC, ownsNumber: true, followConvs: [CONV(HATCH)], messages: NUDGE_THREAD })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res.nudges).toBe(1)
    expect(sendTextMessage.mock.calls[0][2]).toEqual({ locationId: HATCH })
    expect(reads(db, 'location_whatsapp_numbers').map((q) => q.filters[0])).toEqual([['in', 'location_id', [HATCH]]])
    expect(reads(db, 'whatsapp_numbers')).toHaveLength(0)
    expect(getConversationNumberConfig).not.toHaveBeenCalled()
  })
})

// ── T6-B: follow-ups at a number-less studio ───────────────────────────

describe('T6-B — a Hatch-filed conversation’s follow-up goes through the thread', () => {
  it('nudge: { locationId: Hatch, replyInConversation: the thread }', async () => {
    const db = stubDb({ location: HATCH_LOC, ownsNumber: false, followConvs: [CONV(HATCH)], messages: NUDGE_THREAD })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res.nudges).toBe(1)
    expect(sendTextMessage.mock.calls).toEqual([['353870000001', 'Hi Alex, still keen on Tuesday?', { locationId: HATCH, replyInConversation: 'conv-hatch' }]])
    expect(getConversationNumberConfig).toHaveBeenCalledWith(HATCH, 'conv-hatch')
    // Recorded against the conversation, at its studio.
    expect(writes(db, 'whatsapp_messages', 'insert')[0].patch).toMatchObject({ conversation_id: 'conv-hatch', location_id: HATCH })
  })

  it('template: Stillorgan’s template (the thread number’s owner), sent through the thread', async () => {
    const db = stubDb({ location: HATCH_LOC, ownsNumber: false, followConvs: [CONV(HATCH)], messages: TEMPLATE_THREAD, templateStudio: STILL })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res.templates).toBe(1)
    expect(templateLocationIdFor).toHaveBeenCalledWith(HATCH, 'conv-hatch')
    expect(reads(db, 'whatsapp_templates').map(locFilter)).toEqual([STILL])
    expect(sendTemplateMessage.mock.calls).toEqual([['353870000001', 'agent_followup_v1', 'en', [], { locationId: HATCH, replyInConversation: 'conv-hatch' }]])
    expect(writes(db, 'whatsapp_messages', 'insert')[0].patch).toMatchObject({ conversation_id: 'conv-hatch', location_id: HATCH, template_name: 'agent_followup_v1' })
  })

  it('a thread with no number it can reply through: skipped before any compose, nothing sent, not stamped', async () => {
    getConversationNumberConfig.mockResolvedValue(null)
    const db = stubDb({ location: HATCH_LOC, ownsNumber: false, followConvs: [CONV(HATCH)], messages: NUDGE_THREAD })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res).toMatchObject({ nudges: 0, templates: 0, skipped: 1 })
    expect(warned('no_thread_number')).toBe(true)
    expect(anthropicMessages).not.toHaveBeenCalled()
    expect(sendTextMessage).not.toHaveBeenCalled()
    expect(writes(db, 'whatsapp_conversations', 'update')).toHaveLength(0)
  })

  it('a number refusal is a recorded skip and the runner carries on to the next thread', async () => {
    sendTextMessage
      .mockRejectedValueOnce(new WhatsAppNumberMissingError(HATCH))
      .mockResolvedValueOnce({ messageId: 'wamid.second' })
    const two = [CONV(HATCH), { ...CONV(HATCH), id: 'conv-hatch-2', contact_id: 'c2' }]
    const db = stubDb({ location: HATCH_LOC, ownsNumber: false, followConvs: two, messages: NUDGE_THREAD })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res).toMatchObject({ nudges: 1, skipped: 1 })
    expect(warned('no_number')).toBe(true)
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('followup error'))).toBe(false)
    expect(sendTextMessage.mock.calls[1][2]).toEqual({ locationId: HATCH, replyInConversation: 'conv-hatch-2' })
  })

  it('T6-E: the daily cap counts this studio’s threads (the conversation stamp is at Hatch)', async () => {
    const db = stubDb({ location: HATCH_LOC, ownsNumber: false, followConvs: [CONV(HATCH)], messages: NUDGE_THREAD, sentToday: 50 })
    const res = await runAgentFollowups(db, { nowMs: NOW })
    expect(res.nudges).toBe(0)
    expect(sendTextMessage).not.toHaveBeenCalled()
    const capRead = db.log.find((q) => q.table === 'whatsapp_conversations' && q.opts?.head)
    expect(locFilter(capRead)).toBe(HATCH)
    expect(warned('daily_cap')).toBe(true)
  })

  it('T6-E: a sent follow-up is stamped on the Hatch conversation the cap counts', async () => {
    const db = stubDb({ location: HATCH_LOC, ownsNumber: false, followConvs: [CONV(HATCH)], messages: NUDGE_THREAD })
    await runAgentFollowups(db, { nowMs: NOW })
    const [stamp] = writes(db, 'whatsapp_conversations', 'update')
    expect(stamp.patch).toMatchObject({ agent_followup_stage: 1, agent_followup_sent_at: expect.any(String) })
    expect(stamp.filters).toEqual([['eq', 'id', 'conv-hatch']])
  })
})

// ── T6-B: check-ins at a number-less studio ────────────────────────────

describe('T6-B — first-class check-ins at a number-less studio', () => {
  it('no conversation there: no_conversation, nothing composed or sent, no thread opened, no stamp', async () => {
    const db = stubDb({ location: HATCH_LOC, ownsNumber: false, contacts: [CONTACT()], checkinConv: null, templateStudio: STILL })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ no_conversation: 1 })
    expect(res.skipped).toBe(1)
    expect(sendTextMessage).not.toHaveBeenCalled()
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(getOrCreateConversation).not.toHaveBeenCalled()
    expect(anthropicMessages).not.toHaveBeenCalled()
    expect(writes(db, 'contacts', 'update')).toHaveLength(0)
    expect(writes(db, 'activities', 'insert')).toHaveLength(0)
  })

  it('a conversation whose number cannot reply (no stamp, or unreadable): no_conversation, nothing sent', async () => {
    getConversationNumberConfig.mockResolvedValue(null)
    const db = stubDb({ location: HATCH_LOC, ownsNumber: false, contacts: [CONTACT()], checkinConv: CHECKIN_CONV(HATCH), templateStudio: STILL })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ no_conversation: 1 })
    expect(getConversationNumberConfig).toHaveBeenCalledWith(HATCH, 'conv-hatch')
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(getOrCreateConversation).not.toHaveBeenCalled()
    expect(writes(db, 'contacts', 'update')).toHaveLength(0)
  })

  it('Case B: the thread number owner’s template, sent through the thread, recorded on that thread', async () => {
    const db = stubDb({ location: HATCH_LOC, ownsNumber: false, contacts: [CONTACT()], checkinConv: CHECKIN_CONV(HATCH), templateStudio: STILL })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.templates).toBe(1)
    expect(templateLocationIdFor).toHaveBeenCalledWith(HATCH, 'conv-hatch')
    expect(reads(db, 'whatsapp_templates').map(locFilter)).toEqual([STILL])
    expect(sendTemplateMessage.mock.calls).toEqual([['353870000001', 'agent_first_class_checkin_v1', 'en', [], { locationId: HATCH, replyInConversation: 'conv-hatch' }]])
    expect(getOrCreateConversation).not.toHaveBeenCalled()
    expect(writes(db, 'whatsapp_messages', 'insert')[0].patch).toMatchObject({ conversation_id: 'conv-hatch', location_id: HATCH })
    // T6-E — the outcome (what the daily cap and the settings card count) is Hatch's.
    expect(writes(db, 'activities', 'insert')[0].patch).toMatchObject({ location_id: HATCH, type: 'agent_checkin', note: expect.stringContaining('(template)') })
  })

  it('Case A: a free-form check-in through the thread', async () => {
    const db = stubDb({ location: HATCH_LOC, ownsNumber: false, contacts: [CONTACT()], checkinConv: CHECKIN_CONV(HATCH), messages: [inbound(NOW - 4 * H)] })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.freeform).toBe(1)
    expect(sendTextMessage.mock.calls).toEqual([['353870000001', 'Hi Alex, still keen on Tuesday?', { locationId: HATCH, replyInConversation: 'conv-hatch' }]])
    expect(writes(db, 'activities', 'insert')[0].patch).toMatchObject({ location_id: HATCH, note: expect.stringContaining('(in-window)') })
  })

  it('a number refusal is a recorded skip (claim released), and the runner carries on to the next contact', async () => {
    sendTemplateMessage
      .mockRejectedValueOnce(new WhatsAppNumberMissingError(HATCH))
      .mockResolvedValueOnce({ messageId: 'wamid.second' })
    const db = stubDb({
      location: HATCH_LOC, ownsNumber: false, contacts: [CONTACT('c1'), CONTACT('c2', '353870000002')],
      checkinConv: CHECKIN_CONV(HATCH), templateStudio: STILL,
    })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons).toMatchObject({ no_number: 1 })
    expect(res.reasons.error).toBeUndefined()
    expect(res.templates).toBe(1)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(2)
    // claim (c1), release (c1: back to NULL, pinned to the claim), claim (c2)
    const updates = writes(db, 'contacts', 'update')
    expect(updates.map((u) => u.patch.first_class_checkin_at === null)).toEqual([false, true, false])
    expect(updates[1].filters).toEqual(expect.arrayContaining([['eq', 'first_class_checkin_at', updates[0].patch.first_class_checkin_at]]))
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('checkin error'))).toBe(false)
  })

  it('T6-E: the check-in cap reads this studio’s sends', async () => {
    const db = stubDb({ location: HATCH_LOC, ownsNumber: false, contacts: [CONTACT()], checkinConv: CHECKIN_CONV(HATCH), templateStudio: STILL })
    await runFirstClassCheckins(db, { nowMs: NOW })
    const capRead = reads(db, 'activities').find((q) => q.filters.some((f) => f[1] === 'type' && f[2] === 'agent_checkin') && !q.filters.some((f) => f[0] === 'in'))
    expect(locFilter(capRead)).toBe(HATCH)
  })
})

// ── T6-D: the prompt follows the studio's source ───────────────────────

const PROMPT_LOC = { id: STILL, name: 'Stillorgan', timezone: 'Europe/Dublin' }
const PROMPT_SETTINGS = { agent_name: 'Mia', tone: 'Warm and brief.', membership_signup_url: 'https://join.example.test', booking_url: BOOK_URL }
// The pre-Task-6 call, argument for argument (no bookings keys).
const oldFollowupSystem = (zoneToday) => buildCachedSystem({
  businessName: 'UN1T', locationName: 'Stillorgan', agentName: 'Mia', membershipUrl: 'https://join.example.test',
  membershipSource: { key: 'glofox', label: 'Glofox' }, tone: 'Warm and brief.', extraRules: null, knowledge: [], today: zoneToday,
})

describe('T6-D — the follow-up prompt follows the studio’s membership source', () => {
  it('promptCapabilityFor: Glofox books (link ignored); un1t.online and none do not (link kept)', () => {
    expect(promptCapabilityFor({ membership_source: 'glofox' }, PROMPT_SETTINGS)).toEqual({ membershipSource: { key: 'glofox', label: 'Glofox' }, bookings: true, bookingUrl: null })
    expect(promptCapabilityFor({ membership_source: 'un1t_online' }, PROMPT_SETTINGS)).toMatchObject({ bookings: false, bookingUrl: BOOK_URL })
    expect(promptCapabilityFor({ membership_source: null }, {})).toMatchObject({ membershipSource: { key: 'none' }, bookings: false, bookingUrl: null })
  })

  it('Glofox: the composed system is byte-identical to the old call', async () => {
    await composeAgentText({
      location: PROMPT_LOC, settings: PROMPT_SETTINGS, historyRows: [], instruction: 'x', companyName: 'UN1T', knowledge: [],
      ...promptCapabilityFor({ membership_source: 'glofox' }, PROMPT_SETTINGS), zone: 'Europe/Dublin',
    })
    const sent = anthropicMessages.mock.calls.at(-1)[0].system
    expect(JSON.stringify(sent)).toBe(JSON.stringify(oldFollowupSystem(todayStrIn('Europe/Dublin'))))
    expect(systemText()).toContain('You CAN book classes')
    expect(systemText()).not.toContain(BOOK_URL)
  })

  it('un1t.online with a booking link: the no-booking rules and the link', async () => {
    await composeAgentText({
      location: PROMPT_LOC, settings: PROMPT_SETTINGS, historyRows: [], instruction: 'x', companyName: 'UN1T', knowledge: [],
      ...promptCapabilityFor({ membership_source: 'un1t_online' }, PROMPT_SETTINGS),
    })
    expect(systemText()).not.toContain('You CAN book classes')
    expect(systemText()).toContain("You can't book or cancel classes here. To book, send the studio's booking link.")
    expect(systemText()).toContain(BOOK_URL)
  })

  it('un1t.online with no link: hand to the team', async () => {
    await composeAgentText({
      location: PROMPT_LOC, settings: { agent_name: 'Mia' }, historyRows: [], instruction: 'x', companyName: 'UN1T', knowledge: [],
      ...promptCapabilityFor({ membership_source: 'un1t_online' }, { agent_name: 'Mia' }),
    })
    expect(systemText()).toContain("You can't book or cancel classes here. To book, hand the customer to the team.")
  })

  it('end to end: a Hatch nudge is composed with the no-booking rules, a Stillorgan one with booking', async () => {
    await runAgentFollowups(stubDb({ location: HATCH_LOC, ownsNumber: false, followConvs: [CONV(HATCH)], messages: NUDGE_THREAD }), { nowMs: NOW })
    expect(systemText()).toContain("To book, send the studio's booking link.")
    expect(systemText()).toContain(BOOK_URL)
    await runAgentFollowups(stubDb({ location: STILL_LOC, ownsNumber: true, followConvs: [CONV(STILL)], messages: NUDGE_THREAD }), { nowMs: NOW })
    expect(systemText()).toContain('You CAN book classes')
    expect(resolveMembershipSource).not.toHaveBeenCalled()
  })

  it('end to end: a Hatch check-in is composed with the no-booking rules', async () => {
    await runFirstClassCheckins(stubDb({ location: HATCH_LOC, ownsNumber: false, contacts: [CONTACT()], checkinConv: CHECKIN_CONV(HATCH), messages: [inbound(NOW - 4 * H)] }), { nowMs: NOW })
    expect(systemText()).not.toContain('You CAN book classes')
    expect(systemText()).toContain(BOOK_URL)
    expect(resolveMembershipSource).not.toHaveBeenCalled()
  })
})

describe('T6-D — the approval suggestion prompt follows the studio’s membership source', () => {
  const ROW = { id: 'r1', location_id: HATCH, kind: 'pause', status: 'approved', decision_note: null, contact_id: null, channel: 'whatsapp', conversation_id: null }
  const suggestDb = (row) => ({
    from(table) {
      const result = table === 'locations' ? { data: row, error: null } : { data: [], error: null }
      const b = { select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b, maybeSingle: () => Promise.resolve(result), then: (ok, bad) => Promise.resolve(result).then(ok, bad) }
      return b
    },
  })
  const locRow = (source) => ({ id: HATCH, name: 'Hatch Street', timezone: 'Europe/Dublin', organization_id: null, membership_source: source, settings: { customer_agent: { agent_name: 'Mia', booking_url: BOOK_URL } } })

  // The pre-Task-6 approval-suggest call, argument for argument: a DIRECT
  // buildCachedSystem with no bookings keys (Task 6 review, Minor 1: the old
  // test compared the new function against itself).
  const oldSuggestionSystem = () => buildCachedSystem({
    businessName: 'UN1T', locationName: 'Stillorgan', agentName: 'Mia', membershipUrl: 'https://join.example.test',
    membershipSource: { key: 'glofox', label: 'Glofox' }, tone: 'Warm and brief.', extraRules: null,
    today: zonedDateString(Date.now(), 'Europe/Dublin'),
  })

  it('Glofox: byte-identical to a direct buildCachedSystem with no bookings keys (the pre-Task-6 call)', async () => {
    for (const capability of [{ bookings: true, bookingUrl: BOOK_URL }, undefined]) {
      await composeSuggestionText(PROMPT_LOC, PROMPT_SETTINGS, [], 'x', 'UN1T', undefined, { key: 'glofox', label: 'Glofox' }, capability)
      expect(JSON.stringify(anthropicMessages.mock.calls.at(-1)[0].system)).toBe(JSON.stringify(oldSuggestionSystem()))
    }
    expect(systemText()).toContain('You CAN book classes')
    expect(systemText()).not.toContain(BOOK_URL)
  })

  it('a Glofox studio’s suggestion books; no separate source read', async () => {
    const r = await composeApprovalSuggestion(suggestDb(locRow('glofox')), ROW)
    expect(r).toEqual({ text: 'Hi Alex, still keen on Tuesday?' })
    expect(systemText()).toContain('You CAN book classes')
    expect(systemText()).not.toContain(BOOK_URL)
    expect(resolveMembershipSource).not.toHaveBeenCalled()
  })

  it('a un1t.online studio’s suggestion gets the no-booking rules and its link', async () => {
    await composeApprovalSuggestion(suggestDb(locRow('un1t_online')), ROW)
    expect(systemText()).not.toContain('You CAN book classes')
    expect(systemText()).toContain(BOOK_URL)
    expect(resolveMembershipSource).not.toHaveBeenCalled()
  })
})
