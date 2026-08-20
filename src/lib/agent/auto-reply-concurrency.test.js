// MIA-REVIEW.2 — concurrency + API robustness of the agent turn.
//
// Pins the four behaviours a double-turn or a flaky model used to break:
//   1. the per-conversation claim is heartbeaten mid-turn and released
//      compare-and-clear, so a slow turn is never reclaimed as stale and a
//      finished turn can never wipe another runner's claim;
//   2. transient Anthropic failures (429/5xx/network) retry before the
//      soft-handoff escalation, and non-retryable 4xx does not;
//   3. a truncated / refused turn is NEVER sent to the customer;
//   4. a throwing tool comes back to the model as an is_error tool_result
//      instead of aborting the turn as a "model API failure".
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
import { sendPushToRolesAtLocation } from '@/lib/push'
import { executeAccountTool } from './account-tools'

// Chainable stub covering every query shape the turn issues. Conversation
// UPDATEs are recorded with their filters so the claim/heartbeat/release
// protocol can be asserted; `convUpdate` lets a test decide which rows a
// conditional update matched.
function agentDb({ conv, history, calls, convUpdate, replyCount = 0, agentSettings }) {
  const mk = (table) => {
    const state = { op: 'select', patch: null, selectOpts: null, eqs: [], sawGt: false }
    const finish = () => {
      if (state.op === 'update') {
        const call = { table, op: 'update', patch: state.patch, eqs: state.eqs, or: state.or || null }
        calls.push(call)
        if (table === 'whatsapp_conversations' && convUpdate) {
          return { data: convUpdate(call), error: null }
        }
        return { data: [{ id: 'conv-1' }], error: null }
      }
      if (table === 'locations') {
        return { data: { name: 'Stillorgan', settings: { customer_agent: agentSettings || { enabled: true } } }, error: null }
      }
      if (table === 'whatsapp_conversations') return { data: conv, error: null }
      if (table === 'whatsapp_messages') {
        if (state.selectOpts?.head) return { count: replyCount, error: null }
        if (state.sawGt) return { data: [], error: null }
        return { data: history, error: null }
      }
      if (table === 'agent_decisions') {
        if (state.selectOpts?.head) return { count: 0, error: null }
        return { data: [], error: null }
      }
      return { data: [], error: null }
    }
    const builder = {
      select: (cols, opts) => { if (opts) state.selectOpts = opts; return builder },
      update: (patch) => { state.op = 'update'; state.patch = patch; return builder },
      insert: (row) => { calls.push({ table, op: 'insert', row }); return Promise.resolve({ data: { id: 'row-1' }, error: null }) },
      eq: (col, val) => { state.eqs.push([col, val]); return builder },
      or: (expr) => { state.or = expr; return builder },
      gte: () => builder,
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
    send: vi.fn().mockResolvedValue({ messageId: 'wamid.out' }),
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
const CONV = { agent_active: true, contact_id: null, agent_last_reply_at: null }
const HISTORY = [{ direction: 'inbound', body: 'Can I book a class tomorrow?', message_type: 'text', created_at: new Date().toISOString() }]

const okBody = (body) => ({ ok: true, status: 200, json: async () => body })
const errBody = (status, headers = null) => ({
  ok: false, status, text: async () => 'boom',
  ...(headers ? { headers: { get: (k) => headers[k] || null } } : {}),
})
const textTurn = (text) => okBody({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })
const toolTurn = (name = 'get_account') => okBody({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'tu-1', name, input: {} }],
})

// Conversation updates that carry the claim column, in call order.
const claimUpdates = (calls) => calls.filter(
  c => c.op === 'update' && c.table === 'whatsapp_conversations' && 'agent_processing_at' in (c.patch || {}),
)
const stampOf = (c) => (c.eqs.find(([col]) => col === 'agent_processing_at') || [])[1]

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

describe('agent turn — claim heartbeat + compare-and-clear release', () => {
  it('heartbeats the claim before every model call and releases only its own stamp', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(toolTurn())
      .mockResolvedValueOnce(textTurn('Booked you in for 7am.')))
    executeAccountTool.mockResolvedValue({ ok: true })
    const calls = []
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    const result = await runChannelAgent(db, makeAdapter(), ctx)
    expect(result).toMatchObject({ handled: true, action: 'reply' })

    const claims = claimUpdates(calls)
    // claim (or-filtered) + one heartbeat per model call + the release.
    expect(claims.length).toBe(4)
    expect(claims[0].or).toContain('agent_processing_at')
    expect(claims[0].eqs.some(([col]) => col === 'agent_processing_at')).toBe(false)

    // Each heartbeat compares against the previous stamp and writes a new one.
    expect(stampOf(claims[1])).toBe(claims[0].patch.agent_processing_at)
    expect(stampOf(claims[2])).toBe(claims[1].patch.agent_processing_at)

    // The release nulls the claim ONLY while it is still this runner's stamp.
    const release = claims[claims.length - 1]
    expect(release.patch.agent_processing_at).toBeNull()
    expect(stampOf(release)).toBe(claims[2].patch.agent_processing_at)
  })

  it('stands down (claim_lost) when the heartbeat no longer owns the claim', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textTurn('hi')))
    const calls = []
    const adapter = makeAdapter()
    // Any compare-and-set on agent_processing_at matches nothing: another
    // runner reclaimed the thread.
    const db = agentDb({
      conv: CONV, history: HISTORY, calls,
      convUpdate: (c) => (c.eqs.some(([col]) => col === 'agent_processing_at') ? [] : [{ id: 'conv-1' }]),
    })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: false, reason: 'claim_lost' })
    expect(adapter.send).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('agent turn — Anthropic retry policy', () => {
  it('retries a 429 and answers normally (no holding message, no page)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(errBody(429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(textTurn('See you at 7am!')))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('gives up after the attempt budget on a persistent 529 and soft-hands-off', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errBody(529)))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'soft_handoff', reason: 'model_error' })
    expect(global.fetch).toHaveBeenCalledTimes(3)
    expect(adapter.send).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a 400 — a retry re-sends the same bad request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errBody(400)))
    const calls = []
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    const result = await runChannelAgent(db, makeAdapter(), ctx)

    expect(result).toMatchObject({ handled: true, action: 'soft_handoff', reason: 'model_error' })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('retries a thrown fetch (network blip) before escalating', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(textTurn('All good.')))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(adapter.send.mock.calls[0][1]).toContain('All good.')
  })
})

describe('agent turn — stop_reason handling', () => {
  it('max_tokens retries once at a raised cap, then answers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okBody({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Monday 6am, Monday 7am, Mon' }] }))
      .mockResolvedValueOnce(textTurn('Here are tomorrow’s times.'))
    vi.stubGlobal('fetch', fetchMock)
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(600)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(1000)
    // The truncated text never reached the customer.
    expect(adapter.send.mock.calls[0][1]).not.toContain('Monday 6am, Monday 7am, Mon')
  })

  it('a twice-truncated turn hands off instead of sending a cut-off reply', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okBody({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Monday 6am, Monday 7am, Mon' }] }),
    ))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'soft_handoff', reason: 'model_truncated' })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(adapter.send.mock.calls[0][1]).not.toContain('Monday 6am')
    expect(sendPushToRolesAtLocation.mock.calls[0][2].body).toMatch(/cut off/i)
  })

  it('a refusal hands off under its own reason, discarding any partial text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okBody({ stop_reason: 'refusal', content: [{ type: 'text', text: 'I cannot help with' }] }),
    ))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'soft_handoff', reason: 'model_refusal' })
    expect(adapter.send.mock.calls[0][1]).not.toContain('I cannot help with')
    expect(sendPushToRolesAtLocation.mock.calls[0][2].body).toMatch(/declined/i)
  })
})

describe('agent turn — tool executor exceptions', () => {
  it('returns a thrown tool to the model as an is_error tool_result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(toolTurn())
      .mockResolvedValueOnce(textTurn('Sorry, I could not check that.'))
    vi.stubGlobal('fetch', fetchMock)
    executeAccountTool.mockRejectedValueOnce(new Error('dynamic import failed'))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    const followUp = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolResult = followUp.messages.at(-1).content[0]
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'tu-1', is_error: true })
    expect(JSON.parse(toolResult.content)).toMatchObject({ error: 'tool_failed' })
    // ...and it carries the intra-turn cache breakpoint. This one stays on the
    // DEFAULT 5-minute TTL deliberately: it caches a prefix that only exists
    // for the rest of this turn, so paying the 1h write premium (2x base vs
    // 1.25x) would buy nothing.
    expect(toolResult.cache_control).toEqual({ type: 'ephemeral' })
  })

  // MIA-HYGIENE.5 — the cross-turn breakpoints (tool block + stable system)
  // carry a 1h TTL. WhatsApp conversations have gaps longer than the 5-minute
  // default, so the ~10k-token prefix was being re-written instead of read on
  // 51% of live calls (measured over 30 days, 2026-08). Untested until now.
  it('sends the stable tool block with a 1h cache breakpoint on its last tool', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(textTurn('Sure, what day suits?'))
    vi.stubGlobal('fetch', fetchMock)
    const calls = []
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    await runChannelAgent(db, makeAdapter(), ctx)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const marked = body.tools.filter(t => t.cache_control)
    // Exactly one breakpoint, on the LAST tool, so the whole block caches as
    // one prefix and the 4-breakpoint request cap is never at risk.
    expect(marked).toHaveLength(1)
    expect(body.tools.at(-1).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('the same tool throwing twice abandons the turn as tool_error, not model failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(toolTurn()))
    executeAccountTool.mockRejectedValue(new Error('boom'))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'soft_handoff', reason: 'tool_error' })
    expect(sendPushToRolesAtLocation.mock.calls[0][2].body).toMatch(/lookup failed/i)
  })
})

describe('agent turn — soft-handoff debounce is atomic', () => {
  it('a concurrent runner that loses the agent_last_reply_at stamp sends nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errBody(400)))
    const calls = []
    const adapter = makeAdapter()
    // The conditional stamp matches no row — another webhook already claimed
    // the 60s window, even though the row read at turn start looked clear.
    const db = agentDb({
      conv: CONV, history: HISTORY, calls,
      convUpdate: (c) => ('agent_last_reply_at' in (c.patch || {}) && c.or ? [] : [{ id: 'conv-1' }]),
    })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: false, reason: 'soft_handoff_debounced' })
    expect(adapter.send).not.toHaveBeenCalled()
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })
})

describe('agent turn — dead-air outcomes page staff', () => {
  it('the per-location daily cap pages managers once per day', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textTurn('hi')))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({
      conv: CONV, history: HISTORY, calls, replyCount: 5,
      agentSettings: { enabled: true, limits: { max_replies_per_location_per_day: 1 } },
    })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: false, reason: 'location_daily_cap' })
    // No customer-facing message — the cap is a cost ceiling, not an escalation.
    expect(adapter.send).not.toHaveBeenCalled()
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    expect(sendPushToRolesAtLocation.mock.calls[0][2].title).toMatch(/daily cap/i)
  })

  it('a failed send pages managers so the unanswered customer is picked up', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textTurn('See you at 7am!')))
    const calls = []
    const adapter = makeAdapter({ send: vi.fn().mockRejectedValue(new Error('dead token')) })
    const db = agentDb({ conv: CONV, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: false, reason: 'send_failed' })
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    expect(sendPushToRolesAtLocation.mock.calls[0][2].title).toMatch(/could not be sent/i)
  })
})
