// COMMS-AUDIT 2026-07-10 — Mia went silent on a model outage.
//
// An Anthropic API failure (non-2xx or a thrown fetch) returned
// { handled: false, reason: 'model_error' | 'model_exception' } with only
// a log line — the customer got dead air and nobody was paged. These
// tests pin the fix: a model failure takes the existing soft-handoff
// path (holding message to the customer + manager push), including its
// 60s agent_last_reply_at debounce so webhook retries / message bursts
// during an outage never produce a string of holding messages.
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
}))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }),
}))
// MIA-HYGIENE.4 — agent failures now mirror into error_events (mig 435).
vi.mock('@/lib/error-events', () => ({
  recordErrorEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/person-links', () => ({
  personGroupResolver: vi.fn().mockResolvedValue({ groupOf: () => null, primaryOf: () => null }),
}))

import { runChannelAgent } from './auto-reply'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { recordErrorEvent } from '@/lib/error-events'

// Minimal chainable stub covering the query shapes runChannelAgentInner
// issues on the way to the model call. Results keyed by table.
function agentDb({ conv, history, calls }) {
  const mk = (table) => {
    const state = { op: 'select', patch: null, selectOpts: null }
    const finish = () => {
      if (state.op === 'update') {
        calls.push({ table, op: 'update', patch: state.patch })
        // claimAgentTurn chains .update().eq().or().select() and needs rows back
        return { data: [{ id: 'conv-1' }], error: null }
      }
      if (table === 'locations') {
        return { data: { name: 'Stillorgan', settings: { customer_agent: { enabled: true } } }, error: null }
      }
      if (table === 'whatsapp_conversations') return { data: conv, error: null }
      if (table === 'whatsapp_messages') {
        if (state.selectOpts?.head) return { count: 0, error: null }
        // hasInboundAfter's .gt(created_at) probe — nothing arrived mid-turn.
        if (state.sawGt) return { data: [], error: null }
        return { data: history, error: null }
      }
      return { data: [], error: null }
    }
    const builder = {
      select: (cols, opts) => { if (opts) state.selectOpts = opts; return builder },
      update: (patch) => { state.op = 'update'; state.patch = patch; return builder },
      insert: (row) => { calls.push({ table, op: 'insert', row }); return Promise.resolve({ error: null }) },
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

function makeAdapter(overrides = {}) {
  return {
    name: 'whatsapp',
    label: 'WhatsApp',
    conversationsTable: 'whatsapp_conversations',
    messagesTable: 'whatsapp_messages',
    nameColumn: 'wa_profile_name',
    pushCategory: 'whatsapp',
    handoffType: 'whatsapp_agent_handoff',
    trustsSenderIdentity: false,
    send: vi.fn().mockResolvedValue({ messageId: 'wamid.holding' }),
    outboundRow: ({ conversationId, locationId, contactId, messageId, text, now }) => ({
      conversation_id: conversationId, location_id: locationId, contact_id: contactId || null,
      wa_message_id: messageId, direction: 'outbound', message_type: 'text',
      body: text, status: 'sent', source: 'agent', sent_at: now,
    }),
    ...overrides,
  }
}

const ctx = {
  conversationId: 'conv-1',
  locationId: 'loc-1',
  recipient: '353870000000',
  contactId: null,
  messageType: 'text',
  body: 'Can I book a class tomorrow?',
  connection: null,
}

const HISTORY = [{ direction: 'inbound', body: 'Can I book a class tomorrow?', message_type: 'text', created_at: new Date().toISOString() }]

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

describe('runChannelAgent — model failure soft handoff', () => {
  it('non-2xx from Anthropic → holding message sent once + managers paged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 529, text: async () => 'overloaded' }))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: { agent_active: true, contact_id: null, agent_last_reply_at: null }, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'soft_handoff', reason: 'model_error' })
    // Holding message reached the customer, exactly once.
    expect(adapter.send).toHaveBeenCalledTimes(1)
    const insert = calls.find(c => c.op === 'insert' && c.table === 'whatsapp_messages')
    expect(insert?.row?.direction).toBe('outbound')
    // Managers paged.
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    const [, , payload] = sendPushToRolesAtLocation.mock.calls[0]
    expect(payload.data).toMatchObject({ type: 'whatsapp_agent_handoff', conversation_id: 'conv-1' })
  })

  // MIA-HYGIENE.4 — the 2026-08-12 model_error row in prod carried meta: null:
  // the trace knew a turn had failed but not the status, the attempt count or
  // the upstream message, and the richer detail existed only in a console line
  // Vercel had long since rotated away.
  it('non-2xx records the status + attempts in the decision trace and error_events', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 529, text: async () => 'overloaded' }))
    const calls = []
    const db = agentDb({ conv: { agent_active: true, contact_id: null, agent_last_reply_at: null }, history: HISTORY, calls })

    await runChannelAgent(db, makeAdapter(), ctx)

    const decision = calls.find(c => c.op === 'insert' && c.table === 'agent_decisions')
    expect(decision?.row?.meta?.error).toMatchObject({ kind: 'model_error', status: 529, attempts: 3 })
    expect(decision.row.meta.error.message).toContain('overloaded')

    expect(recordErrorEvent).toHaveBeenCalledTimes(1)
    expect(recordErrorEvent.mock.calls[0][0]).toMatchObject({
      route_type: 'agent',
      route_path: 'agent:whatsapp:conv-1',
      name: 'model_error',
    })
  })

  it('a thrown fetch records the exception message in the decision trace', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    const calls = []
    const db = agentDb({ conv: { agent_active: true, contact_id: null, agent_last_reply_at: null }, history: HISTORY, calls })

    await runChannelAgent(db, makeAdapter(), ctx)

    const decision = calls.find(c => c.op === 'insert' && c.table === 'agent_decisions')
    expect(decision?.row?.meta?.error).toMatchObject({ kind: 'model_exception', message: 'ECONNRESET' })
    expect(recordErrorEvent).toHaveBeenCalledTimes(1)
  })

  it('a successful turn records no error in the trace', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'Sure, what day suits?' }], stop_reason: 'end_turn' }),
    }))
    const calls = []
    const db = agentDb({ conv: { agent_active: true, contact_id: null, agent_last_reply_at: null }, history: HISTORY, calls })

    await runChannelAgent(db, makeAdapter(), ctx)

    const decision = calls.find(c => c.op === 'insert' && c.table === 'agent_decisions')
    expect(decision?.row?.meta?.error).toBeUndefined()
    expect(recordErrorEvent).not.toHaveBeenCalled()
  })

  it('thrown fetch (network / SDK exception) → same soft handoff', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: { agent_active: true, contact_id: null, agent_last_reply_at: null }, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'soft_handoff', reason: 'model_exception' })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
  })

  it('debounced: a recent agent reply suppresses a second holding message (webhook retry / burst)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'oops' }))
    const calls = []
    const adapter = makeAdapter()
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString()
    const db = agentDb({ conv: { agent_active: true, contact_id: null, agent_last_reply_at: tenSecondsAgo }, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: false, reason: 'soft_handoff_debounced' })
    expect(adapter.send).not.toHaveBeenCalled()
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('a model SUCCESS still replies normally (no handoff)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'See you at 7am!' }] }),
    }))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: { agent_active: true, contact_id: null, agent_last_reply_at: null }, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(adapter.send.mock.calls[0][1]).toContain('See you at 7am!')
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })
})
