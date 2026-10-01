// WAREPLYNUMBER.1 (C86) — a reply goes from the number the customer wrote to.
//
// The inbound webhook stamps whatsapp_conversations.whatsapp_number_id (mig
// 696) with the number that received the message. A reply into that thread
// (opts.replyInConversation on any whatsapp.js sender) resolves that number
// when it is still an active row AT the conversation's studio; otherwise the
// location default, exactly as before. A single-number studio sends from the
// same number either way. A template goes from the thread number only when it
// shares the default's WABA (templates are synced per studio from the
// default's account). A failed read in this layer is never a lost reply: it
// falls back to the default, logged. The real resolvers run against a fake DB.
// Fictional ids only: the repo is public.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { conversations: [], numbers: [], faults: {} }
const reads = []
vi.mock('./supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      const filters = []
      const orders = []
      let cap = Infinity
      const run = () => {
        reads.push(table)
        if (state.faults[table]) return { data: null, error: state.faults[table] }
        const src = table === 'whatsapp_conversations' ? state.conversations : table === 'whatsapp_numbers' ? state.numbers : []
        let rows = src.filter((r) => filters.every((f) => f(r)))
        for (const [col, asc] of orders.slice().reverse()) {
          rows = rows.slice().sort((a, b) => (a[col] === b[col] ? 0 : (a[col] > b[col] ? 1 : -1) * (asc ? 1 : -1)))
        }
        return { data: rows.slice(0, cap), error: null }
      }
      const b = {
        select: () => b,
        eq: (c, v) => { filters.push((r) => r[c] === v); return b },
        order: (c, o) => { orders.push([c, o?.ascending !== false]); return b },
        limit: (n) => { cap = n; return b },
        maybeSingle: async () => { const out = run(); return out.error ? out : { data: out.data[0] ?? null, error: null } },
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }),
}))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const wa = await import('./whatsapp.js')
const { getConversationReplyConfig, getConversationNumberConfig, classifyInboundOwner } = await import('./whatsapp-config.js')
const { isWhatsAppNumberMissing } = await import('./whatsapp-number-missing.js')
const { logWarn } = await import('./log')

const LOC = 'a0000000-0000-4000-8000-000000000001'
const LOC2 = 'a0000000-0000-4000-8000-000000000002'
const CONV = 'c0000000-0000-4000-8000-000000000001'
const num = (id, extra = {}) => ({
  id, location_id: LOC, label: id, phone_number_id: `PNI-${id}`, business_account_id: 'WABA-1', app_id: 'APP',
  access_token: `tok-${id}`, source: 'cloud_api', is_default: false, is_active: true, updated_at: '2026-09-01', ...extra,
})
const DEFAULT = num('n-default', { is_default: true })
const SECOND = num('n-second')
const conv = (whatsapp_number_id, extra = {}) => ({ id: CONV, location_id: LOC, whatsapp_number_id, ...extra })

let sentFrom
beforeEach(() => {
  vi.clearAllMocks()
  reads.length = 0
  state.conversations = []
  state.numbers = [DEFAULT, SECOND]
  state.faults = {}
  sentFrom = []
  globalThis.fetch = vi.fn(async (url) => {
    sentFrom.push(String(url).split('/')[4])
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OK' }], success: true }) }
  })
})

describe('getConversationReplyConfig', () => {
  it('a thread written to on the second number replies from it', async () => {
    state.conversations = [conv('n-second')]
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-second')
  })

  it('a thread with no recorded number (every thread before 696, every single-number studio until it writes) uses the default', async () => {
    state.conversations = [conv(null)]
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-default')
  })

  it('a single-number studio replies from that number whether or not the thread recorded it', async () => {
    state.numbers = [DEFAULT]
    state.conversations = [conv('n-default')]
    const a = await getConversationReplyConfig(LOC, CONV)
    state.conversations = [conv(null)]
    const b = await getConversationReplyConfig(LOC, CONV)
    expect(a).toEqual(b)
  })

  it('a recorded number that was deactivated falls back to the default', async () => {
    state.numbers = [DEFAULT, { ...SECOND, is_active: false }]
    state.conversations = [conv('n-second')]
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-default')
  })

  it('a recorded number at ANOTHER studio is never used', async () => {
    state.numbers = [DEFAULT, { ...SECOND, location_id: LOC2 }]
    state.conversations = [conv('n-second')]
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-default')
  })

  it('a conversation at another studio than the caller named is not read as this one', async () => {
    state.conversations = [conv('n-second', { location_id: LOC2 })]
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-default')
  })

  it('a TEMPLATE goes from the thread number only when it shares the default number’s WABA', async () => {
    state.conversations = [conv('n-second')]
    expect((await getConversationReplyConfig(LOC, CONV, { template: true })).phoneNumberId).toBe('PNI-n-second')
    state.numbers = [DEFAULT, { ...SECOND, business_account_id: 'WABA-2' }]
    expect((await getConversationReplyConfig(LOC, CONV, { template: true })).phoneNumberId).toBe('PNI-n-default')
    state.numbers = [DEFAULT, { ...SECOND, business_account_id: null }]
    expect((await getConversationReplyConfig(LOC, CONV, { template: true })).phoneNumberId).toBe('PNI-n-default')
  })

  it('an unreadable conversation falls back to the default (a lost reply is worse), logged', async () => {
    state.conversations = [conv('n-second')]
    state.faults.whatsapp_conversations = { message: 'column whatsapp_conversations.whatsapp_number_id does not exist' }
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-default')
    expect(logWarn).toHaveBeenCalledWith('wa-config', 'reply number unreadable; replying from the default number', { conversationId: CONV, err: 'column whatsapp_conversations.whatsapp_number_id does not exist' })
  })

  it('a studio with no number still refuses (WhatsAppNumberMissingError), as before', async () => {
    state.numbers = []
    state.conversations = [conv(null)]
    await expect(getConversationReplyConfig(LOC, CONV)).rejects.toSatisfy(isWhatsAppNumberMissing)
  })

  it('no conversation id: the default, with no conversation read', async () => {
    expect((await getConversationReplyConfig(LOC, null)).phoneNumberId).toBe('PNI-n-default')
    expect(reads).not.toContain('whatsapp_conversations')
  })
})

describe('whatsapp.js senders honour opts.replyInConversation', () => {
  it('text, interactive, flow, cta, carousel, media, reaction and typing go from the thread number', async () => {
    state.conversations = [conv('n-second')]
    const o = { locationId: LOC, replyInConversation: CONV }
    await wa.sendTextMessage('+353000000000', 'hi', o)
    await wa.sendInteractiveOptions('+353000000000', 'pick', ['a', 'b'], o)
    await wa.sendFlowMessage('+353000000000', { ...o, flowId: 'f1', flowToken: 't' })
    await wa.sendCtaUrlMessage('+353000000000', { bodyText: 'b', buttonText: 'Go', url: 'https://x.test' }, o)
    await wa.sendMediaCarousel('+353000000000', { bodyText: 'b', cards: [{ image_url: 'https://x.test/a.jpg' }, { image_url: 'https://x.test/b.jpg' }] }, o)
    await wa.sendMediaMessage('+353000000000', 'image', 'https://x.test/a.jpg', 'c', o)
    await wa.sendReaction('+353000000000', 'wamid.1', '👍', o)
    await wa.sendTypingIndicator('wamid.1', o)
    expect(sentFrom).toEqual(Array(8).fill('PNI-n-second'))
  })

  it('a template from the thread number when the WABA matches, else the default', async () => {
    state.conversations = [conv('n-second')]
    await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { locationId: LOC, replyInConversation: CONV })
    state.numbers = [DEFAULT, { ...SECOND, business_account_id: 'WABA-2' }]
    await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { locationId: LOC, replyInConversation: CONV })
    expect(sentFrom).toEqual(['PNI-n-second', 'PNI-n-default'])
  })

  it('without the option nothing changes: the default number, no conversation read', async () => {
    state.conversations = [conv('n-second')]
    await wa.sendTextMessage('+353000000000', 'hi', { locationId: LOC })
    expect(sentFrom).toEqual(['PNI-n-default'])
    expect(reads).not.toContain('whatsapp_conversations')
  })

  it('an explicit config still wins over everything', async () => {
    state.conversations = [conv('n-second')]
    await wa.sendTextMessage('+353000000000', 'hi', { locationId: LOC, replyInConversation: CONV, config: { token: 't', phoneNumberId: 'PNI-explicit' } })
    expect(sentFrom).toEqual(['PNI-explicit'])
  })
})

describe('classifyInboundOwner names the receiving number', () => {
  it('returns the owning row id with the location', () => {
    expect(classifyInboundOwner({ source: 'db', id: 'n-second', locationId: LOC })).toEqual({ action: 'location', locationId: LOC, numberId: 'n-second' })
    expect(classifyInboundOwner(null)).toEqual({ action: 'drop' })
  })
})

// The contact composer reads the thread number on its own (it already holds
// the checked default), so this half never throws and never resolves by
// location.
describe('getConversationNumberConfig', () => {
  it('the thread number while active at this studio; null otherwise; null on a failed read', async () => {
    state.conversations = [conv('n-second')]
    expect((await getConversationNumberConfig(LOC, CONV))?.id).toBe('n-second')
    expect(await getConversationNumberConfig(LOC2, CONV)).toBeNull()
    state.numbers = [DEFAULT, num('n-second', { is_active: false })]
    expect(await getConversationNumberConfig(LOC, CONV)).toBeNull()
    state.conversations = [conv(null)]
    expect(await getConversationNumberConfig(LOC, CONV)).toBeNull()
    state.conversations = [conv('n-second')]
    state.faults.whatsapp_numbers = { message: 'boom' }
    await expect(getConversationNumberConfig(LOC, CONV)).resolves.toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })
})
