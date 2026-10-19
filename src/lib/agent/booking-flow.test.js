// MIAFLOW.1 — at a studio whose booking Flow is switched on
// (settings.whatsapp_flow.enabled + flow_id) and where Mia cannot book in chat
// (un1t.online at Hatch Street), Mia's send_booking_flow tool drops the same
// in-session Flow message the staff inbox "Send booking flow" route sends,
// with the same flow_token (flowTokenFor), and tells the model honestly
// whether it went. Every fallback (not offered, no contact, window closed,
// a Flow already sent in the last 10 minutes, a failed read or send) sends
// nothing and points the model back to the booking link.
//
// Fictional ids and synthetic 555 numbers only (the repo is public).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({ sendFlowMessage: vi.fn(async () => ({ messageId: 'wamid.FLOW1' })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import {
  SEND_BOOKING_FLOW_TOOL, SEND_BOOKING_FLOW_TOOL_NAME, RECENT_FLOW_MS,
  bookingFlowOffered, executeSendBookingFlow, BOOKING_FLOW_PROMPT_SECTION,
} from './booking-flow'
import { sendFlowMessage } from '@/lib/whatsapp'
import { logError } from '@/lib/log'
import { flowTokenFor } from '@/lib/whatsapp-flow/config'
import { MIA_HATCH_COPY, renderMiaCopy } from './mia-copy'
import { DEFAULTS, SettingsSchema, buildCustomerAgentSettings } from './settings-contract'
import { INHERITABLE_SCALAR_KEYS } from './settings-overrides'
import { buildCustomerSystemPromptParts } from './prompt'

const CONV_ID = 'a0000000-0000-0000-0000-0000000000f1'
const CONTACT_ID = 'b0000000-0000-0000-0000-0000000000f2'
const HATCH = 'd0000000-0000-0000-0000-0000000000f4'
const FLOW = Object.freeze({ enabled: true, flow_id: '1000000000000001', cta_text: 'Book now', template_name: 'fictional_template' })
const OPEN = () => new Date(Date.now() + 3600_000).toISOString()
const CLOSED = () => new Date(Date.now() - 60_000).toISOString()
const conversation = (extra = {}) => ({
  id: CONV_ID, location_id: HATCH, contact_id: CONTACT_ID, wa_phone: '15555550100', window_expires_at: OPEN(), ...extra,
})

// A recording fake db: one conversation row, the recent-Flow read, inserts.
function fakeDb({ conv = conversation(), convError = null, recent = [], recentError = null, insertError = null } = {}) {
  const inserts = []
  const reads = []
  return {
    inserts,
    reads,
    from(table) {
      const state = { op: 'select', cols: null, filters: [] }
      const finish = () => {
        if (state.op === 'insert') return { error: insertError }
        reads.push({ table, cols: state.cols, filters: state.filters })
        if (table === 'whatsapp_conversations') return convError ? { data: null, error: convError } : { data: conv, error: null }
        if (table === 'whatsapp_messages') return recentError ? { data: null, error: recentError } : { data: recent, error: null }
        return { data: null, error: null }
      }
      const b = {
        select: (cols) => { state.cols = cols; return b },
        insert: (row) => { state.op = 'insert'; inserts.push({ table, row }); return b },
        eq: (col, val) => { state.filters.push(['eq', col, val]); return b },
        gte: (col, val) => { state.filters.push(['gte', col, val]); return b },
        order: () => b, limit: () => b,
        maybeSingle: () => b,
        then: (ok, bad) => Promise.resolve(finish()).then(ok, bad),
      }
      return b
    },
  }
}

const ctxFor = (db, extra = {}) => ({
  db, conversationId: CONV_ID, locationId: HATCH, channel: 'whatsapp',
  settings: { booking_url: 'https://hatch.example.test/book' },
  bookingFlow: { offered: true, config: FLOW },
  ...extra,
})

beforeEach(() => { vi.clearAllMocks() })

describe('bookingFlowOffered', () => {
  const base = { channel: 'whatsapp', canBook: false, block: 'no_booking', flowConfig: FLOW, contactId: CONTACT_ID }
  it('WhatsApp, a studio Mia cannot book at, Flow enabled with an id, a linked contact: offered', () => {
    expect(bookingFlowOffered(base)).toBe(true)
    for (const block of ['no_booking', 'un1t_read', 'un1t_read_dual']) expect(bookingFlowOffered({ ...base, block }), block).toBe(true)
  })
  it('not offered: Instagram, a studio Mia books at, the Glofox block, the un1t full block, Flow off or unset, no flow_id, no contact', () => {
    expect(bookingFlowOffered({ ...base, channel: 'instagram' })).toBe(false)
    expect(bookingFlowOffered({ ...base, canBook: true })).toBe(false)
    expect(bookingFlowOffered({ ...base, block: 'glofox' })).toBe(false)
    // Ruling 24 — block 3b: known Hatch members book in chat, never through the Flow.
    expect(bookingFlowOffered({ ...base, block: 'un1t_full' })).toBe(false)
    expect(bookingFlowOffered({ ...base, flowConfig: { ...FLOW, enabled: false } })).toBe(false)
    expect(bookingFlowOffered({ ...base, flowConfig: { flow_id: FLOW.flow_id } })).toBe(false)
    expect(bookingFlowOffered({ ...base, flowConfig: { enabled: true } })).toBe(false)
    expect(bookingFlowOffered({ ...base, flowConfig: null })).toBe(false)
    expect(bookingFlowOffered({ ...base, contactId: null })).toBe(false)
    expect(bookingFlowOffered()).toBe(false)
  })
})

describe('the tool definition', () => {
  it('takes no input, and its words carry no em or en dash', () => {
    expect(SEND_BOOKING_FLOW_TOOL.name).toBe(SEND_BOOKING_FLOW_TOOL_NAME)
    expect(SEND_BOOKING_FLOW_TOOL_NAME).toBe('send_booking_flow')
    expect(SEND_BOOKING_FLOW_TOOL.input_schema).toEqual({ type: 'object', properties: {} })
    expect(SEND_BOOKING_FLOW_TOOL.description).not.toMatch(/[—–]/)
    expect(SEND_BOOKING_FLOW_TOOL.description).toMatch(/sent/)
    expect(BOOKING_FLOW_PROMPT_SECTION).not.toMatch(/[—–]/)
  })
})

describe('executeSendBookingFlow: sent', () => {
  it('sends the Flow once, from the thread, with the webhook/welcome token and the default line; records the thread row', async () => {
    const db = fakeDb()
    const result = await executeSendBookingFlow(ctxFor(db))

    expect(sendFlowMessage).toHaveBeenCalledTimes(1)
    expect(sendFlowMessage).toHaveBeenCalledWith('15555550100', {
      locationId: HATCH,
      replyInConversation: CONV_ID,
      flowId: FLOW.flow_id,
      flowToken: flowTokenFor(CONTACT_ID, HATCH),
      flowCta: 'Book now',
      bodyText: 'Tap below to pick a class and book it.',
    })
    expect(result).toMatchObject({ sent: true, text: 'Tap below to pick a class and book it.' })
    expect(result.message).toMatch(/tap/i)
    expect(result.message).not.toMatch(/[—–]/)
    const rows = db.inserts.filter((i) => i.table === 'whatsapp_messages')
    expect(rows).toHaveLength(1)
    expect(rows[0].row).toMatchObject({
      conversation_id: CONV_ID, contact_id: CONTACT_ID, location_id: HATCH, wa_message_id: 'wamid.FLOW1',
      direction: 'outbound', message_type: 'flow', status: 'sent', source: 'agent',
      body: '[Booking Flow] Tap below to pick a class and book it.',
    })
    expect(rows[0].row.sent_by).toBeUndefined()
  })

  it('looks back exactly 10 minutes for an outbound Flow on this thread', async () => {
    const db = fakeDb()
    const before = Date.now()
    await executeSendBookingFlow(ctxFor(db))
    const recent = db.reads.find((r) => r.table === 'whatsapp_messages')
    expect(recent.filters).toContainEqual(['eq', 'conversation_id', CONV_ID])
    expect(recent.filters).toContainEqual(['eq', 'direction', 'outbound'])
    expect(recent.filters).toContainEqual(['eq', 'message_type', 'flow'])
    const since = Date.parse(recent.filters.find(([k]) => k === 'gte')[2])
    expect(RECENT_FLOW_MS).toBe(10 * 60_000)
    expect(since).toBeGreaterThanOrEqual(before - RECENT_FLOW_MS - 5)
    expect(since).toBeLessThanOrEqual(Date.now() - RECENT_FLOW_MS + 5)
  })

  it("the operator's booking_flow_text wins, dashes scrubbed", async () => {
    const db = fakeDb()
    const result = await executeSendBookingFlow(ctxFor(db, { settings: { booking_flow_text: 'Pick a class below — then you are in.' } }))
    expect(sendFlowMessage.mock.calls[0][1].bodyText).toBe('Pick a class below, then you are in.')
    expect(result.text).toBe('Pick a class below, then you are in.')
  })

  it('a lost thread row never un-sends it: still sent:true, logged structurally', async () => {
    const db = fakeDb({ insertError: { message: 'fictional insert failure' } })
    const result = await executeSendBookingFlow(ctxFor(db))
    expect(result.sent).toBe(true)
    expect(logError).toHaveBeenCalledWith('mia-booking-flow', expect.stringMatching(/thread row/), expect.objectContaining({ conversationId: CONV_ID, locationId: HATCH }))
  })
})

describe('executeSendBookingFlow: nothing sent, back to the link', () => {
  const expectFallback = (result, reason, { attempted = false } = {}) => {
    expect(result).toMatchObject({ sent: false, reason, link: 'https://hatch.example.test/book' })
    expect(result.message).toMatch(/never say/i)
    expect(result.message).toContain('https://hatch.example.test/book')
    expect(result.message).not.toMatch(/[—–]/)
    if (!attempted) expect(sendFlowMessage).not.toHaveBeenCalled()
  }

  it('not offered this turn (Flow off, not WhatsApp, a Glofox studio): no read, no send', async () => {
    for (const extra of [{ bookingFlow: undefined }, { bookingFlow: { offered: false, config: FLOW } }, { channel: 'instagram' }]) {
      const db = fakeDb()
      expectFallback(await executeSendBookingFlow(ctxFor(db, extra)), 'not_available')
      expect(db.reads).toHaveLength(0)
    }
  })

  it('no contact linked to the thread', async () => {
    expectFallback(await executeSendBookingFlow(ctxFor(fakeDb({ conv: conversation({ contact_id: null }) }))), 'no_contact')
  })

  it('the 24h window is closed (or was never opened)', async () => {
    expectFallback(await executeSendBookingFlow(ctxFor(fakeDb({ conv: conversation({ window_expires_at: CLOSED() }) }))), 'window_closed')
    expectFallback(await executeSendBookingFlow(ctxFor(fakeDb({ conv: conversation({ window_expires_at: null }) }))), 'window_closed')
  })

  it('the conversation is unreadable or gone', async () => {
    expectFallback(await executeSendBookingFlow(ctxFor(fakeDb({ convError: { message: 'fictional timeout' } }))), 'conversation_unreadable')
    expect(logError).toHaveBeenCalled()
    expectFallback(await executeSendBookingFlow(ctxFor(fakeDb({ conv: null }))), 'conversation_not_found')
  })

  it('the recent-Flow read fails: never a second Flow on a guess', async () => {
    expectFallback(await executeSendBookingFlow(ctxFor(fakeDb({ recentError: { message: 'fictional timeout' } }))), 'recent_check_failed')
    expect(logError).toHaveBeenCalled()
  })

  it('Meta refuses the send: sent:false, logged structurally, no thread row', async () => {
    sendFlowMessage.mockRejectedValueOnce(new Error('fictional Meta refusal'))
    const db = fakeDb()
    expectFallback(await executeSendBookingFlow(ctxFor(db)), 'send_failed', { attempted: true })
    expect(sendFlowMessage).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('mia-booking-flow', expect.stringMatching(/send failed/), expect.objectContaining({ conversationId: CONV_ID, locationId: HATCH, err: 'fictional Meta refusal' }))
    expect(db.inserts).toHaveLength(0)
  })

  it('no booking link at the studio: the fallback says hand off', async () => {
    const result = await executeSendBookingFlow(ctxFor(fakeDb({ conv: conversation({ contact_id: null }) }), { settings: {} }))
    expect(result).toMatchObject({ sent: false, reason: 'no_contact', link: null })
    expect(result.message).toMatch(/team/)
  })
})

describe('executeSendBookingFlow: no duplicate within 10 minutes', () => {
  it('a Flow already on this thread in the last 10 minutes: not sent again, points back to it', async () => {
    const db = fakeDb({ recent: [{ id: 'm-1' }] })
    const result = await executeSendBookingFlow(ctxFor(db))
    expect(sendFlowMessage).not.toHaveBeenCalled()
    expect(result).toMatchObject({ sent: false, already_sent: true })
    expect(result.message).toMatch(/already/)
    expect(result.message).not.toMatch(/[—–]/)
    expect(db.inserts).toHaveLength(0)
  })
})

describe('booking_flow_text: operator-editable copy with a default', () => {
  it('the default exactly, no dashes', () => {
    expect(MIA_HATCH_COPY.booking_flow_text).toEqual({ text: 'Tap below to pick a class and book it.' })
    expect(renderMiaCopy('booking_flow_text', null)).toBe('Tap below to pick a class and book it.')
    expect(renderMiaCopy('booking_flow_text', { booking_flow_text: '  ' })).toBe('Tap below to pick a class and book it.')
  })
  it('a settings key: null by default, round-trips, blank is null, inherits from the org', () => {
    expect(DEFAULTS.booking_flow_text).toBe(null)
    expect(INHERITABLE_SCALAR_KEYS).toContain('booking_flow_text')
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, booking_flow_text: '  Tap to book.  ' })).booking_flow_text).toBe('Tap to book.')
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, booking_flow_text: '   ' })).booking_flow_text).toBe(null)
    expect(SettingsSchema.safeParse({ enabled: true, booking_flow_text: 'x'.repeat(501) }).success).toBe(false)
  })
})

describe('the prompt names the tool only when it is offered', () => {
  const opts = { businessName: 'UN1T Dublin', locationName: 'UN1T Hatch Street', bookings: false, bookingUrl: 'https://hatch.example.test/book' }
  it('bookingFlow true: the section is in the stable prefix', () => {
    const { stable } = buildCustomerSystemPromptParts({ ...opts, bookingFlow: true })
    expect(stable).toContain(BOOKING_FLOW_PROMPT_SECTION)
    expect(BOOKING_FLOW_PROMPT_SECTION).toContain('send_booking_flow')
  })
  it('absent or false: byte-identical to before', () => {
    const before = buildCustomerSystemPromptParts(opts)
    expect(buildCustomerSystemPromptParts({ ...opts, bookingFlow: false })).toEqual(before)
    expect(before.stable).not.toContain('send_booking_flow')
  })
})
