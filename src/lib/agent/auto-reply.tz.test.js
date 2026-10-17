// auto-reply.tz.test.js — TZ.5. Mia's live reply path reads the studio's
// clock from the location row it already loads: quiet hours with no stored tz,
// "Today's date" in the prompt, and the zone handed to every tool (toolCtx.zone).
// Europe/Dublin (and a NULL column) behave exactly as before. The Dublin
// byte-identity sweep ran in TZ.5 and was retired in TZ.18b: Dublin is pinned
// by fixed values below; zoned-time ≡ dublin-time stays proven by
// shared/zoned-time.parity.test.js.
process.env.TZ = 'America/Los_Angeles' // neither zone under test
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


const { runChannelAgent } = await import('./auto-reply')
const { executeAccountTool } = await import('./account-tools')

// Every query answered; the location row carries the zone under test.
function zoneDb({ timezone, settings }) {
  const mk = (table) => {
    const state = { cols: '', opts: null, op: 'select' }
    const finish = () => {
      // the turn's in-flight claim (and every other update) lands on one row
      if (state.op === 'update') return { data: [{ id: 'conv-1' }], error: null }
      // MIAORG.1 Task 5 — a Glofox studio: the zone tests run the booking tools.
      if (table === 'locations') return { data: { name: 'Studio', membership_source: 'glofox', settings: { customer_agent: settings }, timezone }, error: null }
      if (table === 'whatsapp_conversations') return { data: { agent_active: true, contact_id: null, agent_last_reply_at: null }, error: null }
      if (state.opts?.head) return { count: 0, error: null }
      if (table === 'whatsapp_messages' && String(state.cols).includes('direction')) {
        return { data: [{ direction: 'inbound', body: 'Any class tonight?', message_type: 'text', created_at: '2026-07-01T23:29:00Z' }], error: null }
      }
      if (table === 'whatsapp_messages') return { data: [], error: null }
      return { data: [], error: null }
    }
    const b = {
      select: (cols, opts) => { state.cols = cols || ''; if (opts) state.opts = opts; return b },
      update: () => { state.op = 'update'; return b },
      insert: () => Promise.resolve({ data: { id: 'row-1' }, error: null }),
      eq: () => b, or: () => b, gte: () => b, gt: () => b, is: () => b, in: () => b, order: () => b, limit: () => b,
      single: () => b, maybeSingle: () => b,
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return b
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
  contactId: null, messageType: 'text', body: 'Any class tonight?', connection: null,
}
const text = (t) => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] }) })
const toolUse = () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'get_account', input: {} }] }) })
const todayInPrompt = () => {
  const body = JSON.parse(global.fetch.mock.calls[0][1].body)
  const sys = (Array.isArray(body.system) ? body.system : [{ text: body.system }]).map((b) => b.text).join('\n')
  return sys.match(/Today's date: (\S+)/)[1]
}
const QUIET = { start: '21:00', end: '08:00' } // no stored tz: the studio's zone

let errSpy, warnSpy
beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  vi.useFakeTimers({ toFake: ['Date'] })
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  errSpy.mockRestore()
  warnSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('TZ.5 Europe/Dublin pinned values', () => {
  it.each([
    ['2026-03-29T00:30:00Z', '2026-03-29'], // 00:30 GMT, just before the spring-forward
    ['2026-07-01T12:00:00Z', '2026-07-01'], // summer midday
    ['2026-10-24T23:30:00Z', '2026-10-25'], // 00:30 IST, just before the fall-back
    ['2026-12-31T23:30:00Z', '2026-12-31'], // winter: 23:30 GMT
  ])('%s: the prompt\'s today is the Dublin day %s (Dublin or NULL column)', async (iso, day) => {
    for (const timezone of ['Europe/Dublin', null]) {
      vi.setSystemTime(new Date(iso))
      vi.stubGlobal('fetch', vi.fn(async () => text('Yes, 7pm.')))
      await runChannelAgent(zoneDb({ timezone, settings: { enabled: true } }), makeAdapter(), ctx)
      expect(todayInPrompt()).toBe(day)
    }
  })
  it('quiet hours with no stored tz are still read in Dublin for a Dublin studio', async () => {
    vi.setSystemTime(new Date('2026-07-01T23:30:00Z')) // 00:30 IST: quiet
    vi.stubGlobal('fetch', vi.fn(async () => text('Yes')))
    const out = await runChannelAgent(zoneDb({ timezone: 'Europe/Dublin', settings: { enabled: true, quiet_hours: QUIET } }), makeAdapter(), ctx)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(out).toMatchObject({ handled: false, reason: 'quiet_hours' })
  })
})

describe('TZ.5 America/New_York follows New York', () => {
  it('2026-07-01T23:30Z is 19:30 EDT: not quiet, and the prompt says the 1st', async () => {
    vi.setSystemTime(new Date('2026-07-01T23:30:00Z'))
    vi.stubGlobal('fetch', vi.fn(async () => text('Yes, 7pm.')))
    await runChannelAgent(zoneDb({ timezone: 'America/New_York', settings: { enabled: true, quiet_hours: QUIET } }), makeAdapter(), ctx)
    expect(global.fetch).toHaveBeenCalled()
    expect(todayInPrompt()).toBe('2026-07-01')
  })
  it('2026-12-02T02:30Z is 21:30 EST: quiet in New York', async () => {
    vi.setSystemTime(new Date('2026-12-02T02:30:00Z'))
    vi.stubGlobal('fetch', vi.fn(async () => text('Yes')))
    const out = await runChannelAgent(zoneDb({ timezone: 'America/New_York', settings: { enabled: true, quiet_hours: QUIET } }), makeAdapter(), ctx)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(out).toMatchObject({ handled: false, reason: 'quiet_hours' })
  })
  it('the tools get the studio zone on their context', async () => {
    vi.setSystemTime(new Date('2026-07-01T23:30:00Z'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(toolUse()).mockResolvedValue(text('Done.')))
    executeAccountTool.mockResolvedValue({ found: false })
    await runChannelAgent(zoneDb({ timezone: 'America/New_York', settings: { enabled: true } }), makeAdapter(), ctx)
    expect(executeAccountTool).toHaveBeenCalled()
    expect(executeAccountTool.mock.calls[0][2].zone).toBe('America/New_York')
  })
})
