// MIA-REVIEW.3 (3.9) — AGENT-VERIFY-HANDOFF.1 wiring, end to end.
//
// The pure helpers (resolveVerifyFailHandoff / shouldHandoffAfterVerifyFail /
// nextVerifyAttempts) were unit-tested, but NOTHING exercised the
// orchestration in auto-reply.js: the counter read from
// conv.agent_verify_attempts, the increment on a failed verify_identity tool
// result, the handoff trigger, and the persisted counter. The eval runner
// reimplements the tool loop without the counter, so evals could never cover
// it either — the only prior verification was a one-off live E2E. A rename or
// a moved early-return would have shipped with every test green.
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
vi.mock('./account-tools', async (importOriginal) => ({
  ...(await importOriginal()),
  executeAccountTool: vi.fn(),
}))

import { runChannelAgent } from './auto-reply'
import { executeAccountTool } from './account-tools'

// Chainable stub covering the reads runChannelAgentInner makes. Every update
// patch is captured so the test can assert the persisted counter.
function agentDb({ conv, history, calls, settings }) {
  const mk = (table) => {
    const state = { op: 'select', patch: null, selectOpts: null }
    const finish = () => {
      if (state.op === 'update') {
        calls.push({ table, op: 'update', patch: state.patch })
        return { data: [{ id: 'conv-1' }], error: null }
      }
      if (table === 'locations') {
        return { data: { name: 'Stillorgan', settings: { customer_agent: settings } }, error: null }
      }
      if (table === 'whatsapp_conversations') return { data: conv, error: null }
      if (table === 'whatsapp_messages') {
        if (state.selectOpts?.head) return { count: 0, error: null }
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
    send: vi.fn().mockResolvedValue({ messageId: 'wamid.x' }),
    outboundRow: ({ conversationId, locationId, contactId, messageId, text, now }) => ({
      conversation_id: conversationId, location_id: locationId, contact_id: contactId || null,
      wa_message_id: messageId, direction: 'outbound', message_type: 'text',
      body: text, status: 'sent', source: 'agent', sent_at: now,
    }),
  }
}

const ctx = {
  conversationId: 'conv-1',
  locationId: 'loc-1',
  recipient: '353870000000',
  contactId: 'c-1',
  messageType: 'text',
  body: 'my email is jane@example.com',
  connection: null,
}

const HISTORY = [{ direction: 'inbound', body: 'my email is jane@example.com', message_type: 'text', created_at: new Date().toISOString() }]

// One verify_identity tool call, then a plain reply turn.
function verifyThenReply() {
  const turns = [
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'verify_identity', input: { email: 'jane@example.com' } }],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'That email did not match, can you double-check it?' }] },
  ]
  let i = 0
  return vi.fn().mockImplementation(async () => ({
    ok: true, status: 200, json: async () => turns[Math.min(i++, turns.length - 1)],
  }))
}

function verifyPatches(calls) {
  return calls
    .filter(c => c.op === 'update' && c.table === 'whatsapp_conversations' && 'agent_verify_attempts' in (c.patch || {}))
    .map(c => c.patch.agent_verify_attempts)
}

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

describe('runChannelAgent — auto-handoff after N failed verify_identity attempts', () => {
  it('the SECOND consecutive failure (default threshold 2) hands off and resets the counter', async () => {
    executeAccountTool.mockResolvedValue({ verified: false, hint: 'No match yet.' })
    vi.stubGlobal('fetch', verifyThenReply())
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({
      conv: { agent_active: true, contact_id: 'c-1', agent_last_reply_at: null, agent_verify_attempts: 1 },
      history: HISTORY, calls, settings: { enabled: true },
    })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'handoff', reason: 'verify_failed' })
    // The model's "try again" text is discarded in favour of the holding message.
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(adapter.send.mock.calls[0][1]).not.toContain('double-check')
    // Counter reset so the next handoff cycle starts clean.
    expect(verifyPatches(calls)).toContain(0)
    // The thread is handed off (and its SLA escalation re-armed).
    const handoffPatch = calls.find(c => c.op === 'update' && c.patch?.agent_handed_off_at)
    expect(handoffPatch.patch).toMatchObject({ agent_active: false, handoff_escalated_at: null })
  })

  it('the FIRST failure only increments the counter and still replies', async () => {
    executeAccountTool.mockResolvedValue({ verified: false, hint: 'No match yet.' })
    vi.stubGlobal('fetch', verifyThenReply())
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({
      conv: { agent_active: true, contact_id: 'c-1', agent_last_reply_at: null, agent_verify_attempts: 0 },
      history: HISTORY, calls, settings: { enabled: true },
    })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(verifyPatches(calls)).toContain(1)
    expect(adapter.send.mock.calls[0][1]).toContain('double-check')
  })

  it('a SUCCESSFUL verify resets the counter to 0, never hands off, and logs the ACTING account', async () => {
    executeAccountTool.mockResolvedValue({ verified: true })
    vi.stubGlobal('fetch', verifyThenReply())
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({
      // The re-read after a successful verify returns the stamped account —
      // the contact the quiz matched, which may differ from the thread's
      // contact (PERSON-ACCT.6: it is used as stamped, never remapped to the
      // person group's display primary).
      conv: {
        agent_active: true, contact_id: 'c-1', agent_last_reply_at: null,
        agent_verify_attempts: 1, agent_verified_contact_id: 'primary-1',
      },
      history: HISTORY, calls, settings: { enabled: true },
    })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(verifyPatches(calls)).toContain(0)
    expect(calls.some(c => c.patch?.agent_handed_off_at)).toBe(false)
    // MIA-REVIEW.3 (3.16, partial) — the decision row names the account whose
    // data the turn was authorised to read, not just the bound contact.
    const decision = calls.find(c => c.op === 'insert' && c.table === 'agent_decisions')
    expect(decision.row.contact_id).toBe('primary-1')
  })

  it('the threshold is operator-configurable — 3 keeps a 2nd failure in the quiz', async () => {
    executeAccountTool.mockResolvedValue({ verified: false })
    vi.stubGlobal('fetch', verifyThenReply())
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({
      conv: { agent_active: true, contact_id: 'c-1', agent_last_reply_at: null, agent_verify_attempts: 1 },
      history: HISTORY, calls, settings: { enabled: true, handoff_after_verify_failures: 3 },
    })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(verifyPatches(calls)).toContain(2)
  })

  it('0 disables the auto-handoff entirely', async () => {
    executeAccountTool.mockResolvedValue({ verified: false })
    vi.stubGlobal('fetch', verifyThenReply())
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({
      conv: { agent_active: true, contact_id: 'c-1', agent_last_reply_at: null, agent_verify_attempts: 9 },
      history: HISTORY, calls, settings: { enabled: true, handoff_after_verify_failures: 0 },
    })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(calls.some(c => c.patch?.agent_handed_off_at)).toBe(false)
  })
})
