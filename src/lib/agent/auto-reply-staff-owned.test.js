// INBOXFOLLOW.1 — a coach's thread stays theirs until a coach completes it.
// On a staff-owned thread Mia sends the customer nothing at all: no answer, no
// holding message, no voice-note hand-off, and no push that claims she is
// chatting. Both channels run the same runChannelAgent. Harness mirrors
// auto-reply-no-credits.test.js. Fictional ids only.
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

import { runChannelAgent } from './auto-reply'
import { sendPushToRolesAtLocation, sendPushToInboxStaffAtLocation } from '@/lib/push'

function agentDb({ table: convTable, conv, calls }) {
  const mk = (table) => {
    const state = { op: 'select' }
    const finish = () => {
      if (state.op === 'update') { calls.push({ table, op: 'update', patch: state.patch }); return { data: [{ id: 'conv-1' }], error: null } }
      if (table === 'locations') return { data: { name: 'Stillorgan', membership_source: 'glofox', settings: { customer_agent: { enabled: true } } }, error: null }
      if (table === convTable) return { data: conv, error: null }
      return { data: [], error: null, count: 0 }
    }
    const builder = {
      select: (cols) => { if (table === convTable) calls.push({ table, op: 'select', cols }); return builder },
      update: (patch) => { state.op = 'update'; state.patch = patch; return builder },
      insert: (row) => { calls.push({ table, op: 'insert', row }); return Promise.resolve({ error: null }) },
      eq: () => builder, or: () => builder, gte: () => builder, gt: () => builder,
      is: () => builder, in: () => builder, order: () => builder, limit: () => builder,
      single: () => builder, maybeSingle: () => builder,
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return builder
  }
  return { from: mk }
}

const ADAPTERS = {
  whatsapp: () => ({
    name: 'whatsapp', label: 'WhatsApp', conversationsTable: 'whatsapp_conversations', messagesTable: 'whatsapp_messages',
    nameColumn: 'wa_profile_name', pushCategory: 'whatsapp', handoffType: 'whatsapp_agent_handoff', trustsSenderIdentity: false,
    send: vi.fn().mockResolvedValue({ messageId: 'wamid.x' }), outboundRow: (r) => r,
  }),
  instagram: () => ({
    name: 'instagram', label: 'Instagram', conversationsTable: 'instagram_conversations', messagesTable: 'instagram_messages',
    nameColumn: 'customer_name', pushCategory: 'instagram', handoffType: 'instagram_agent_handoff', trustsSenderIdentity: true,
    send: vi.fn().mockResolvedValue({ messageId: 'mid.x' }), outboundRow: (r) => r,
  }),
}

// A coach replied 13 hours ago: past the 12 h handoff cooldown, Mia switched off.
const STAFF_OWNED_CONV = {
  agent_active: false,
  agent_handed_off_at: new Date(Date.now() - 13 * 3600_000).toISOString(),
  staff_owned_since: new Date(Date.now() - 13 * 3600_000).toISOString(),
  contact_id: 'c-1', agent_verified_contact_id: null, agent_last_reply_at: null,
}

let fetchSpy
beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each(['whatsapp', 'instagram'])('runChannelAgent on a coach-owned %s thread', (channel) => {
  const base = { conversationId: 'conv-1', locationId: 'loc-1', recipient: '353870000000', contactId: 'c-1', connection: null }

  it.each([
    ['a text message', { messageType: 'text', body: 'hello? anyone there?' }],
    ['an audio message', { messageType: 'audio', body: '' }],
  ])('sends nothing and writes nothing for %s', async (_label, msg) => {
    const calls = []
    const adapter = ADAPTERS[channel]()
    const db = agentDb({ table: adapter.conversationsTable, conv: STAFF_OWNED_CONV, calls })

    const result = await runChannelAgent(db, adapter, { ...base, ...msg })

    expect(result).toEqual({ handled: false, reason: 'staff_owned' })
    expect(adapter.send).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
    expect(sendPushToInboxStaffAtLocation).not.toHaveBeenCalled()
    // The only write is the staff-only decision trace row (agent_decisions): nothing
    // reaches the conversation or the customer's message log.
    const writes = calls.filter(c => c.op === 'update' || c.op === 'insert')
    expect(writes.filter(c => c.table !== 'agent_decisions')).toEqual([])
    expect(writes.filter(c => c.table === 'agent_decisions').every(c => c.row.decision === 'silent' && c.row.reason === 'staff_owned')).toBe(true)
  })

  it('reads staff_owned_since in the conversation select', async () => {
    const calls = []
    const adapter = ADAPTERS[channel]()
    const db = agentDb({ table: adapter.conversationsTable, conv: STAFF_OWNED_CONV, calls })
    await runChannelAgent(db, adapter, { ...base, messageType: 'text', body: 'hi' })
    const selects = calls.filter(c => c.op === 'select')
    expect(selects.length).toBeGreaterThan(0)
    expect(selects[0].cols).toContain('staff_owned_since')
  })
})
