// PERSON-ACCT.7 — when book_class refuses to guess between two live accounts
// the turn ends in a DETERMINISTIC handoff: the model's composed text is
// discarded, the customer gets the operator-editable script (default in
// core.js), the thread parks for a human, managers are pushed. Same posture
// as the no_credits handoff (auto-reply-no-credits.test.js — this harness
// mirrors that file's).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(),
  getOrCreateConversation: vi.fn(),
}))
vi.mock('@/lib/push', () => ({
  sendPushToRolesAtLocation: vi.fn(async () => {}),
  sendPushToInboxStaffAtLocation: vi.fn(async () => {}),
}))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({})),
}))
vi.mock('@/lib/person-links', () => ({
  personGroupResolver: vi.fn(async () => ({ groupOf: () => null, primaryOf: () => null })),
}))
vi.mock('./booking-tools', async (importOriginal) => ({
  ...(await importOriginal()),
  executeBookingTool: vi.fn(),
}))

import { runChannelAgent } from './auto-reply'
import { executeBookingTool } from './booking-tools'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { DEFAULT_ACCOUNT_CONFLICT_HANDOFF_TEXT } from './core'

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
  body: 'can you book me into ENG1NE tomorrow 7am?',
  connection: null,
}

const HISTORY = [{ direction: 'inbound', body: 'can you book me into ENG1NE tomorrow 7am?', message_type: 'text', created_at: new Date().toISOString() }]

function bookThenReply() {
  const turns = [
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'book_class', input: { event_id: '64aa00000000000000000001', class_name: 'ENG1NE' } }],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'MODEL COMPOSED TEXT that must never reach the customer' }] },
  ]
  let i = 0
  return vi.fn().mockImplementation(async () => ({
    ok: true, status: 200, json: async () => turns[Math.min(i++, turns.length - 1)],
  }))
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

describe('runChannelAgent — deterministic handoff on an account_conflict booking', () => {
  it('sends the escalation script (not the model text), parks the thread, pushes managers', async () => {
    executeBookingTool.mockResolvedValue({ booked: false, account_conflict: true, message: 'two live accounts' })
    vi.stubGlobal('fetch', bookThenReply())
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({
      conv: { agent_active: true, contact_id: 'c-1', agent_verified_contact_id: 'c-1', agent_last_reply_at: null },
      history: HISTORY, calls, settings: { enabled: true },
    })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'handoff', reason: 'account_conflict' })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    const sentText = adapter.send.mock.calls[0][1]
    expect(sentText).toBe(DEFAULT_ACCOUNT_CONFLICT_HANDOFF_TEXT)
    expect(sentText).not.toContain('MODEL COMPOSED')
    const handoffPatch = calls.find(c => c.op === 'update' && c.patch?.agent_handed_off_at)
    expect(handoffPatch.patch).toMatchObject({ agent_active: false, handoff_escalated_at: null })
    expect(sendPushToRolesAtLocation).toHaveBeenCalled()
  })

  it('operator-edited script wins over the default', async () => {
    executeBookingTool.mockResolvedValue({ booked: false, account_conflict: true })
    vi.stubGlobal('fetch', bookThenReply())
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({
      conv: { agent_active: true, contact_id: 'c-1', agent_verified_contact_id: 'c-1', agent_last_reply_at: null },
      history: HISTORY, calls,
      settings: { enabled: true, account_conflict_handoff_text: 'Two accounts here — a coach will sort it.' },
    })

    await runChannelAgent(db, adapter, ctx)

    expect(adapter.send.mock.calls[0][1]).toBe('Two accounts here — a coach will sort it.')
  })

  it('a booking WITHOUT the flag replies normally (no handoff)', async () => {
    executeBookingTool.mockResolvedValue({ booked: true, class_name: 'ENG1NE' })
    vi.stubGlobal('fetch', bookThenReply())
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({
      conv: { agent_active: true, contact_id: 'c-1', agent_verified_contact_id: 'c-1', agent_last_reply_at: null },
      history: HISTORY, calls, settings: { enabled: true },
    })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(adapter.send.mock.calls[0][1]).toContain('MODEL COMPOSED')
  })
})
