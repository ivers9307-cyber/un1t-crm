// MIAPREFILL.1 — the request Mia sends must never end on an assistant turn.
//
// Sonnet 5 (Mia's model since 22 Aug) rejects a trailing assistant message
// as "assistant message prefill" with a 400. Three prod turns hit it (8, 13
// and 25 Sep), every one a missed-inbound RERUN: the customer's second
// message landed while Mia was composing, her reply was written after it,
// so the rerun's history ended on her own reply. These tests read the body
// that actually goes to the API (the fetch mock's second argument), not a
// helper's return value, so they fail on any path that builds a bad array.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(),
  sendInteractiveOptions: vi.fn(),
  sendTypingIndicator: vi.fn(),
  sendCtaUrlMessage: vi.fn(),
  splitTrailingUrl: () => null,
}))
vi.mock('@/lib/push', () => ({
  sendPushToRolesAtLocation: vi.fn().mockResolvedValue(undefined),
  sendPushToInboxStaffAtLocation: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }),
}))
vi.mock('@/lib/error-events', () => ({
  recordErrorEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/person-links', () => ({
  personGroupResolver: vi.fn().mockResolvedValue({ groupOf: () => null, primaryOf: () => null }),
}))
vi.mock('./account-tools', () => ({
  ACCOUNT_TOOLS: [{ name: 'get_account', description: 'x', input_schema: { type: 'object' } }],
  ACCOUNT_TOOL_NAMES: new Set(['get_account']),
  executeAccountTool: vi.fn(),
}))
vi.mock('./booking-tools', () => ({ BOOKING_TOOLS: [], executeBookingTool: vi.fn() }))
vi.mock('./event-tools', () => ({ EVENT_TOOLS: [], EVENT_TOOL_NAMES: new Set(), executeEventTool: vi.fn() }))
vi.mock('./card-tools', () => ({ CARD_TOOLS: [], CARD_TOOL_NAMES: new Set(), executeCardTool: vi.fn() }))

import { runChannelAgent } from './auto-reply'
import { recordErrorEvent } from '@/lib/error-events'

// Stub for every query the turn issues. `historyReads` is a queue of
// snapshots, one per history read, in the order the runner makes them (the
// runner reads NEWEST FIRST and reverses, so each snapshot is newest-first).
// `lateReads` answers the missed-inbound probe (the `.gt(created_at)` read).
function shapeDb({ conv, historyReads, lateReads = [], calls }) {
  let historyIdx = 0
  let lateIdx = 0
  const mk = (table) => {
    const state = { op: 'select', cols: '', selectOpts: null, sawGt: false }
    const finish = () => {
      if (state.op === 'update') {
        calls.push({ table, op: 'update', patch: state.patch })
        return { data: [{ id: 'conv-1' }], error: null }
      }
      if (table === 'locations') {
        return { data: { name: 'Stillorgan', settings: { customer_agent: { enabled: true } } }, error: null }
      }
      if (table === 'whatsapp_conversations') return { data: conv, error: null }
      if (table === 'whatsapp_messages') {
        if (state.selectOpts?.head) return { count: 0, error: null }
        if (state.sawGt) {
          const rows = lateReads[Math.min(lateIdx, lateReads.length - 1)] || []
          lateIdx++
          return { data: rows, error: null }
        }
        if (String(state.cols).includes('direction')) {
          const rows = historyReads[Math.min(historyIdx, historyReads.length - 1)]
          historyIdx++
          return { data: rows, error: null }
        }
        // humanTookOverDuringTurn's last-outbound read: no human sender.
        return { data: [{ source: 'agent', sent_by: null, created_at: '2026-09-25T08:41:00+00:00' }], error: null }
      }
      if (table === 'agent_decisions' && state.selectOpts?.head) return { count: 0, error: null }
      return { data: [], error: null }
    }
    const builder = {
      select: (cols, opts) => { state.cols = cols || ''; if (opts) state.selectOpts = opts; return builder },
      update: (patch) => { state.op = 'update'; state.patch = patch; return builder },
      insert: (row) => { calls.push({ table, op: 'insert', row }); return Promise.resolve({ data: { id: 'row-1' }, error: null }) },
      eq: () => builder, or: () => builder, gte: () => builder,
      gt: () => { state.sawGt = true; return builder },
      is: () => builder, in: () => builder, order: () => builder, limit: () => builder,
      single: () => builder, maybeSingle: () => builder,
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return builder
  }
  return { from: mk }
}

function makeAdapter() {
  return {
    name: 'whatsapp',
    label: 'WhatsApp',
    conversationsTable: 'whatsapp_conversations',
    messagesTable: 'whatsapp_messages',
    nameColumn: 'wa_profile_name',
    pushCategory: 'whatsapp',
    handoffType: 'whatsapp_agent_handoff',
    trustsSenderIdentity: false,
    humanOutboundColumns: 'source, sent_by',
    isHumanOutbound: (m) => m.source !== 'agent' && m.sent_by != null,
    send: vi.fn().mockResolvedValue({ messageId: 'wamid.out' }),
    outboundRow: ({ conversationId, locationId, contactId, messageId, text, now }) => ({
      conversation_id: conversationId, location_id: locationId, contact_id: contactId || null,
      wa_message_id: messageId, direction: 'outbound', message_type: 'text',
      body: text, status: 'sent', source: 'agent', sent_at: now,
    }),
  }
}

const ctx = {
  conversationId: 'conv-1', locationId: 'loc-1', recipient: '353870000000',
  contactId: null, messageType: 'text', body: 'Is there a class at 6pm?', connection: null,
}
const CONV = { agent_active: true, contact_id: null, agent_last_reply_at: null }

// The 25 Sep shape: A (seen by turn 1), B (landed mid-turn), R (Mia's reply to A).
const A = { direction: 'inbound', body: 'Is there a class at 6pm?', message_type: 'text', created_at: '2026-09-25T08:41:36.100+00:00' }
const B = { direction: 'inbound', body: 'And one tomorrow?', message_type: 'text', created_at: '2026-09-25T08:41:38.200+00:00' }
const R = { direction: 'outbound', body: 'Yes, 6pm has space.', message_type: 'text', source: 'agent', created_at: '2026-09-25T08:41:42.300+00:00' }

const okText = (text) => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }) })
const prefill400 = () => ({
  ok: false, status: 400,
  text: async () => '{"type":"error","error":{"type":"invalid_request_error","message":"This model does not support assistant message prefill. The conversation must end with a user message."}}',
})
// Behaves like the real API: 400s a request whose last message is not a user turn.
const apiLike = (reply) => vi.fn(async (_url, init) => {
  const { messages } = JSON.parse(init.body)
  return messages[messages.length - 1]?.role === 'user' ? okText(reply) : prefill400()
})
const sentBodies = () => global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body))

let errSpy, warnSpy
beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  errSpy.mockRestore()
  warnSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('MIAPREFILL.1 — every request Mia sends ends on a user turn', () => {
  it('missed-inbound rerun: the rerun request ends on the missed message, after Mia\'s reply (the 25 Sep shape)', async () => {
    vi.stubGlobal('fetch', apiLike('Tomorrow at 7am too.'))
    const calls = []
    const adapter = makeAdapter()
    const db = shapeDb({
      conv: CONV,
      historyReads: [[A], [R, B, A]],
      lateReads: [[{ id: 'm-b', message_type: 'text', body: B.body }], []],
      calls,
    })

    adapter.onEngage = vi.fn()
    const result = await runChannelAgent(db, adapter, ctx)

    expect(adapter.onEngage).toHaveBeenCalled()
    const bodies = sentBodies()
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(body.messages.at(-1).role).toBe('user')
    }
    const rerun = bodies[1].messages
    expect(rerun.at(-2)).toMatchObject({ role: 'assistant', content: R.body })
    expect(rerun.at(-1).content).toContain(B.body)
    expect(recordErrorEvent).not.toHaveBeenCalled()
    expect(adapter.send).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ handled: true, action: 'reply' })
  })

  it('a second Mia reply that already followed the missed message: the rerun makes no API call ([A, B, R, R2], no double answer)', async () => {
    vi.stubGlobal('fetch', apiLike('Yes, 6pm has space.'))
    const adapter = makeAdapter()
    const R2 = { direction: 'outbound', body: 'Tomorrow at 7am too.', message_type: 'text', source: 'agent', created_at: '2026-09-25T08:41:47.000+00:00' }
    const db = shapeDb({
      conv: CONV,
      historyReads: [[A], [R2, R, B, A]],
      lateReads: [[{ id: 'm-b', message_type: 'text', body: B.body }], []],
      calls: [],
    })

    await runChannelAgent(db, adapter, ctx)

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(adapter.send).toHaveBeenCalledTimes(1)
  })

  it('a business auto-responder that lands mid-turn does not start a rerun', async () => {
    vi.stubGlobal('fetch', apiLike('Yes, 6pm has space.'))
    const adapter = makeAdapter()
    const db = shapeDb({
      conv: CONV,
      historyReads: [[A]],
      lateReads: [[{ id: 'm-auto', message_type: 'text', body: 'Thanks for your message. This is an automated reply: we are closed right now and will get back to you as soon as we can.' }], []],
      calls: [],
    })

    await runChannelAgent(db, adapter, ctx)

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(adapter.send).toHaveBeenCalledTimes(1)
  })

  it('a reaction that lands mid-turn does not start a rerun (reactions are never answered)', async () => {
    vi.stubGlobal('fetch', apiLike('Yes, 6pm has space.'))
    const calls = []
    const adapter = makeAdapter()
    const db = shapeDb({
      conv: CONV,
      historyReads: [[A]],
      lateReads: [[{ id: 'm-r', message_type: 'reaction', body: 'Reacted: 👍' }], []],
      calls,
    })

    await runChannelAgent(db, adapter, ctx)

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(adapter.send).toHaveBeenCalledTimes(1)
  })

  it('first turn whose newest row is outbound (e.g. the STOP acknowledgement) makes no API call, sends nothing, records no model failure', async () => {
    vi.stubGlobal('fetch', apiLike('unused'))
    const calls = []
    const adapter = makeAdapter()
    adapter.onEngage = vi.fn()
    const stop = { direction: 'inbound', body: 'STOP', message_type: 'text', created_at: '2026-09-25T09:00:00.000+00:00' }
    const ack = { direction: 'outbound', body: 'You have been unsubscribed.', message_type: 'text', created_at: '2026-09-25T09:00:01.000+00:00' }
    const db = shapeDb({ conv: CONV, historyReads: [[ack, stop, R, A]], calls })

    const result = await runChannelAgent(db, adapter, { ...ctx, body: 'STOP' })

    expect(global.fetch).not.toHaveBeenCalled()
    expect(adapter.send).not.toHaveBeenCalled()
    expect(recordErrorEvent).not.toHaveBeenCalled()
    expect(result).toMatchObject({ handled: false, reason: 'nothing_to_answer' })
    // No read receipt or "typing…" for a turn that will say nothing.
    expect(adapter.onEngage).not.toHaveBeenCalled()
    // The structured no-reply line names the trailing row (source + type, no body).
    const line = warnSpy.mock.calls.find(([tag]) => tag === '[radar-agent] no-reply')
    expect(line).toBeTruthy()
    expect(JSON.parse(line[1])).toMatchObject({ reason: 'nothing_to_answer', trailing: { source: null, message_type: 'text' } })
    expect(line[1]).not.toContain('unsubscribed')
  })

  it('tool loop: every request in a multi-call turn ends on a user turn (tool_result)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-1', name: 'get_account', input: {} }] }) })
      .mockResolvedValueOnce(okText('Your plan renews on the 1st.'))
    vi.stubGlobal('fetch', fetchMock)
    const { executeAccountTool } = await import('./account-tools')
    executeAccountTool.mockResolvedValueOnce({ ok: true })
    const db = shapeDb({ conv: CONV, historyReads: [[A]], calls: [] })

    await runChannelAgent(db, makeAdapter(), ctx)

    const bodies = sentBodies()
    expect(bodies).toHaveLength(2)
    expect(bodies.map(b => b.messages.at(-1).role)).toEqual(['user', 'user'])
    expect(bodies[1].messages.at(-1).content[0].type).toBe('tool_result')
  })
})
