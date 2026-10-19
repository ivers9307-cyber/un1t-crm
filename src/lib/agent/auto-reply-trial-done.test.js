// TRIALDONE.6 — auto-reply reads the trial-done brief once per turn, only
// where the thread's studio has trial_done on and the thread has a contact,
// and the brief reaches the request's UNCACHED system block.
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

vi.mock('./trial-done-context', () => ({ trialDoneLineFor: vi.fn() }))

import { runChannelAgent } from './auto-reply'
import { trialDoneLineFor } from './trial-done-context'

const LINE = 'This customer finished their trial at Hatch Street on Saturday 17 October.'

function turnDb({ conv, customerAgent }) {
  const mk = (table) => {
    const state = { op: 'select', cols: '', selectOpts: null }
    const finish = () => {
      if (state.op === 'update') return { data: [{ id: 'conv-1' }], error: null }
      if (table === 'locations') {
        return { data: { name: 'Stillorgan', timezone: 'Europe/Dublin', membership_source: 'glofox', settings: { customer_agent: customerAgent } }, error: null }
      }
      if (table === 'whatsapp_conversations') return { data: conv, error: null }
      if (table === 'whatsapp_messages') {
        if (state.selectOpts?.head) return { count: 0, error: null }
        if (String(state.cols).includes('direction')) {
          return { data: [{ direction: 'inbound', body: 'Hi, yes I loved it', message_type: 'text', created_at: '2026-10-19T10:00:00.000+00:00' }], error: null }
        }
        return { data: [], error: null }
      }
      if (table === 'agent_decisions' && state.selectOpts?.head) return { count: 0, error: null }
      return { data: [], error: null }
    }
    const builder = {
      select: (cols, opts) => { state.cols = cols || ''; if (opts) state.selectOpts = opts; return builder },
      update: (patch) => { state.op = 'update'; state.patch = patch; return builder },
      insert: () => Promise.resolve({ data: { id: 'row-1' }, error: null }),
      eq: () => builder, or: () => builder, gte: () => builder, gt: () => builder,
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
  contactId: null, messageType: 'text', body: 'Hi, yes I loved it', connection: null,
}
const CONV = { agent_active: true, contact_id: 'contact-1', agent_last_reply_at: null }
const okText = (text) => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }) })
const sentSystems = () => global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).system)

let errSpy, warnSpy
beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => okText('Great to hear!')))
  vi.mocked(trialDoneLineFor).mockResolvedValue(LINE)
})
afterEach(() => {
  errSpy.mockRestore()
  warnSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('TRIALDONE.6 — the trial-done brief in the turn', () => {
  it('trial_done on + a contact: read once, and the brief rides the uncached system block', async () => {
    const db = turnDb({ conv: CONV, customerAgent: { enabled: true, trial_done: { enabled: true } } })
    await runChannelAgent(db, makeAdapter(), ctx)

    expect(trialDoneLineFor).toHaveBeenCalledTimes(1)
    expect(vi.mocked(trialDoneLineFor).mock.calls[0][1]).toMatchObject({
      locationId: 'loc-1', contactId: 'contact-1', studioName: 'Stillorgan', zone: 'Europe/Dublin',
    })
    const [system] = sentSystems()
    expect(system[0].cache_control).toBeTruthy()
    expect(system[0].text).not.toContain(LINE)
    expect(system.at(-1).cache_control).toBeUndefined()
    expect(system.at(-1).text).toContain(LINE)
  })

  it('trial_done off (the default): no read, no brief', async () => {
    const db = turnDb({ conv: CONV, customerAgent: { enabled: true } })
    await runChannelAgent(db, makeAdapter(), ctx)

    expect(trialDoneLineFor).not.toHaveBeenCalled()
    expect(JSON.stringify(sentSystems())).not.toContain('finished their trial')
  })

  it('no contact on the thread: no read', async () => {
    const db = turnDb({ conv: { ...CONV, contact_id: null }, customerAgent: { enabled: true, trial_done: { enabled: true } } })
    await runChannelAgent(db, makeAdapter(), ctx)

    expect(trialDoneLineFor).not.toHaveBeenCalled()
  })

  it('a null brief (no row, closed, stale or a failed read) leaves the prompt as it was', async () => {
    vi.mocked(trialDoneLineFor).mockResolvedValue(null)
    const db = turnDb({ conv: CONV, customerAgent: { enabled: true, trial_done: { enabled: true } } })
    await runChannelAgent(db, makeAdapter(), ctx)

    expect(trialDoneLineFor).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(sentSystems())).not.toContain('finished their trial')
    expect(global.fetch).toHaveBeenCalled()
  })
})
