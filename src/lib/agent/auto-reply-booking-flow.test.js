// MIAFLOW.1 — through the live runner: at Hatch Street (un1t.online, where Mia
// cannot book in chat) with settings.whatsapp_flow switched on, a WhatsApp
// turn is offered send_booking_flow, and calling it drops the booking Flow
// into the thread once, with the webhook/welcome flow_token, before Mia's own
// reply. Every other case keeps today's request byte for byte (the booking
// link): Flow off, no linked contact, and Stillorgan (Glofox, Mia books in
// chat). A Flow that could not be sent says so, and a second one inside 10
// minutes is not sent.
//
// The Anthropic API is a stubbed fetch, every WhatsApp send is a spy, and the
// db is a recording fake. Fictional ids, phones and addresses only (the repo
// is public).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(),
  sendInteractiveOptions: vi.fn(),
  sendTypingIndicator: vi.fn(),
  sendCtaUrlMessage: vi.fn(),
  sendFlowMessage: vi.fn(async () => ({ messageId: 'wamid.FLOW1' })),
  splitTrailingUrl: vi.fn(() => null),
  getOrCreateConversation: vi.fn(),
}))
vi.mock('@/lib/push', () => ({
  sendPushToRolesAtLocation: vi.fn(async () => {}),
  sendPushToInboxStaffAtLocation: vi.fn(async () => {}),
}))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Dublin' })),
}))
vi.mock('@/lib/person-links', () => ({
  personGroupResolver: vi.fn(async () => ({ groupOf: () => null, primaryOf: () => null })),
}))
vi.mock('@/lib/glofox', () => ({
  GLOFOX_BOOKING_MODEL: 'program',
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(async () => ({ ok: true, events: [] })),
  fetchUserBookingsResult: vi.fn(async () => ({ ok: true, bookings: [] })),
  fetchUserCreditsResult: vi.fn(async () => ({ ok: true, credits: [] })),
  createBooking: vi.fn(async () => ({ ok: true })),
  cancelBooking: vi.fn(async () => ({ ok: true })),
  interpretBookingResult: vi.fn(() => ({ booked: true })),
}))
vi.mock('./member-studios', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveMemberStudios: vi.fn(),
}))
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))
vi.mock('@/lib/person-accounts', async (importOriginal) => ({
  ...(await importOriginal()),
  linkedAccountsForContact: vi.fn(async () => ({ readFailed: true, contacts: [], accounts: [] })),
}))
vi.mock('./un1t-member-read', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchLiveUn1tBookings: vi.fn(async () => ({ ok: false, reason: 'read_failed' })),
}))

import { sendFlowMessage } from '@/lib/whatsapp'
import { flowTokenFor } from '@/lib/whatsapp-flow/config'
import {
  CACHED_ACCOUNT_TOOLS, CACHED_NO_BOOKING_TOOLS, CACHED_UN1T_READ_TOOLS, CACHED_BOOKING_FLOW_BLOCKS, runChannelAgent,
} from './auto-reply'
import { resolveMemberStudios } from './member-studios'
import { BOOKING_FLOW_PROMPT_SECTION, SEND_BOOKING_FLOW_TOOL_NAME } from './booking-flow'

const ORG = 'b2000000-0000-0000-0000-0000000000a1'
const STILLORGAN = 'a1000000-0000-0000-0000-0000000000a1'
const HATCH = 'a1000000-0000-0000-0000-0000000000a2'
const STILLORGAN_CONTACT = 'c1000000-0000-0000-0000-0000000000a1'
const HATCH_CONTACT = 'c1000000-0000-0000-0000-0000000000a2'
const MIA_TEST_PHONE = '15555550199'
const HATCH_BOOKING_URL = 'https://hatch.example.test/book'
const FLOW_ON = Object.freeze({ enabled: true, flow_id: '1000000000000002', template_name: 'fictional_template' })

const hatchStudio = (extra = {}) => ({
  locationId: HATCH, name: 'UN1T Hatch Street', providerKey: 'un1t_online',
  active: true, answerable: true, contactIds: [HATCH_CONTACT], un1tUserId: 'u-1', ...extra,
})
const stillorganStudio = (extra = {}) => ({
  locationId: STILLORGAN, name: 'UN1T Stillorgan', providerKey: 'glofox',
  active: true, answerable: true, contactIds: [STILLORGAN_CONTACT], glofoxMemberId: 'gm-1', ...extra,
})
const resolution = (...studios) => ({ studios, readFailed: false })
const nobody = () => ({ studios: [], readFailed: false })

const HATCH_SETTINGS = { enabled: false, test_mode: true, test_phones: [`+${MIA_TEST_PHONE}`], booking_url: HATCH_BOOKING_URL, booking_mode: 'auto' }
const STILLORGAN_SETTINGS = { enabled: false, test_mode: true, test_phones: [`+${MIA_TEST_PHONE}`] }

function locationRows({ hatchFlow = FLOW_ON, stillorganFlow = FLOW_ON } = {}) {
  return [
    {
      id: STILLORGAN, name: 'UN1T Stillorgan', timezone: 'Europe/Dublin', organization_id: ORG, membership_source: 'glofox',
      settings: { customer_agent: STILLORGAN_SETTINGS, whatsapp_flow: stillorganFlow },
    },
    {
      id: HATCH, name: 'UN1T Hatch Street', timezone: 'Europe/Dublin', organization_id: ORG, membership_source: 'un1t_online',
      settings: { customer_agent: HATCH_SETTINGS, whatsapp_flow: hatchFlow },
    },
  ]
}

const FUTURE = new Date(Date.now() + 3 * 86400_000).toISOString()
const TABLES = () => ({
  agent_knowledge: [],
  contacts: [
    { id: STILLORGAN_CONTACT, first_name: 'Aoife', email: 'aoife@example.test', glofox_member_id: '6a0000000000000000000001' },
    { id: HATCH_CONTACT, first_name: 'Aoife', email: 'aoife@example.test' },
  ],
  un1t_subscriptions: [],
  un1t_clients: [],
  un1t_products: [],
  un1t_events: [{ location_id: HATCH, un1t_id: 'ev-1', title: 'Fictional Hatch HIIT', starts_at: FUTURE, capacity: 12, bookings_count: 3, status: 'scheduled' }],
  un1t_bookings: [],
})

// A recording fake db. Rows are filtered by every .eq/.in the caller applies.
// The recent-Flow read (message_type = 'flow') answers `recentFlows`.
function turnDb({ conv, recentFlows = [], ...locOpts }) {
  const data = { ...TABLES(), locations: locationRows(locOpts) }
  const inserts = []
  const mk = (table) => {
    const state = { op: 'select', cols: null, selectOpts: null, filters: [], single: false, sawGt: false, row: null }
    const pick = (rows) => rows.filter((r) => state.filters.every(([kind, col, val]) => {
      if (!(col in r)) return true
      return kind === 'eq' ? r[col] === val : val.includes(r[col])
    }))
    const finish = () => {
      if (state.op === 'insert') {
        inserts.push({ table, row: state.row })
        return { data: state.single ? { id: 'req-1' } : [{ id: 'req-1' }], error: null }
      }
      if (state.op === 'update') return { data: [{ id: 'conv-1' }], error: null }
      if (table === 'whatsapp_conversations') {
        if (state.cols === 'agent_verified_contact_id') return { data: { agent_verified_contact_id: null }, error: null }
        return { data: conv, error: null }
      }
      if (table === 'whatsapp_messages') {
        if (state.selectOpts?.head) return { count: 0, error: null }
        if (state.filters.some(([k, c, v]) => k === 'eq' && c === 'message_type' && v === 'flow')) return { data: recentFlows, error: null }
        if (state.sawGt) return { data: [], error: null }
        return { data: [{ direction: 'inbound', body: 'can I book a class tomorrow?', message_type: 'text', created_at: new Date().toISOString() }], error: null }
      }
      if (state.selectOpts?.head) return { count: 0, error: null }
      const rows = pick(data[table] || [])
      return { data: state.single ? (rows[0] ?? null) : rows, error: null }
    }
    const builder = {
      select: (cols, opts) => { state.cols = cols; if (opts) state.selectOpts = opts; return builder },
      update: () => { state.op = 'update'; return builder },
      insert: (row) => { state.op = 'insert'; state.row = row; return builder },
      eq: (col, val) => { state.filters.push(['eq', col, val]); return builder },
      in: (col, vals) => { state.filters.push(['in', col, vals]); return builder },
      or: () => builder, gte: () => builder, lte: () => builder, is: () => builder,
      gt: () => { state.sawGt = true; return builder },
      order: () => builder, limit: () => builder, range: () => builder,
      single: () => { state.single = true; return builder },
      maybeSingle: () => { state.single = true; return builder },
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return builder
  }
  return { db: { from: mk }, inserts }
}

const whatsappAdapter = (order) => ({
  name: 'whatsapp', label: 'WhatsApp',
  conversationsTable: 'whatsapp_conversations', messagesTable: 'whatsapp_messages',
  nameColumn: 'wa_profile_name', pushCategory: 'whatsapp', handoffType: 'whatsapp_agent_handoff',
  trustsSenderIdentity: false,
  send: vi.fn(async () => { order?.push('reply'); return { messageId: 'wamid.x' } }),
  outboundRow: ({ conversationId, locationId, contactId, messageId, text, now }) => ({
    conversation_id: conversationId, location_id: locationId, contact_id: contactId || null,
    wa_message_id: messageId, direction: 'outbound', message_type: 'text',
    body: text, status: 'sent', source: 'agent', sent_at: now,
  }),
})

function modelTurns(turns) {
  const bodies = []
  let i = 0
  const fetchFn = vi.fn().mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => turns[Math.min(i++, turns.length - 1)] }
  })
  return { fetchFn, bodies }
}
const toolTurn = (name, input = {}) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name, input }] })
const textTurn = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })
const toolResultOf = (body) => JSON.parse(body.messages.at(-1).content[0].content)
const same = (a, b) => expect(JSON.stringify(a)).toBe(JSON.stringify(b))
const systemText = (body) => body.system.map((b) => b.text).join('\n\n')
const toolNames = (body) => body.tools.map((t) => t.name)

const OPEN = () => new Date(Date.now() + 3600_000).toISOString()
const thread = (contactId, extra = {}) => ({
  agent_active: true, contact_id: contactId, agent_verified_contact_id: null, agent_verified_at: null, agent_last_reply_at: null,
  id: 'conv-1', wa_phone: MIA_TEST_PHONE, window_expires_at: OPEN(), ...extra,
})
const turnCtx = (locationId, extra = {}) => ({
  conversationId: 'conv-1', locationId, recipient: MIA_TEST_PHONE,
  contactId: locationId === HATCH ? HATCH_CONTACT : STILLORGAN_CONTACT,
  messageType: 'text', body: 'can I book a class tomorrow?', connection: null, ...extra,
})
const REPLY = "I've sent you the booking form above. Tap Book now to pick a class and book it."

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

describe('the Flow variants of the tool blocks', () => {
  it('each is its block plus send_booking_flow last, with the one cache breakpoint on it; no Glofox variant', () => {
    expect(Object.keys(CACHED_BOOKING_FLOW_BLOCKS).sort()).toEqual(['no_booking', 'un1t_full', 'un1t_read', 'un1t_read_dual'])
    for (const [block, tools] of Object.entries(CACHED_BOOKING_FLOW_BLOCKS)) {
      expect(tools.at(-1).name, block).toBe(SEND_BOOKING_FLOW_TOOL_NAME)
      expect(tools.at(-1).cache_control, block).toEqual({ type: 'ephemeral', ttl: '1h' })
      expect(tools.filter((t) => t.cache_control), block).toHaveLength(1)
    }
    expect(CACHED_BOOKING_FLOW_BLOCKS.no_booking.slice(0, -1).map((t) => t.name)).toEqual(CACHED_NO_BOOKING_TOOLS.map((t) => t.name))
    expect(CACHED_ACCOUNT_TOOLS.some((t) => t.name === SEND_BOOKING_FLOW_TOOL_NAME)).toBe(false)
  })
})

describe('Hatch WhatsApp, Flow on: the Flow is sent', () => {
  it('a lead asks to book: send_booking_flow offered, the Flow sent once with the right token, then Mia replies pointing to it', async () => {
    resolveMemberStudios.mockResolvedValue(nobody())
    const order = []
    sendFlowMessage.mockImplementation(async () => { order.push('flow'); return { messageId: 'wamid.FLOW1' } })
    const { fetchFn, bodies } = modelTurns([toolTurn(SEND_BOOKING_FLOW_TOOL_NAME), textTurn(REPLY)])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ conv: thread(HATCH_CONTACT) })
    const adapter = whatsappAdapter(order)

    const result = await runChannelAgent(db, adapter, turnCtx(HATCH))

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    for (const body of bodies) same(body.tools, CACHED_BOOKING_FLOW_BLOCKS.no_booking)
    expect(systemText(bodies[0])).toContain(BOOKING_FLOW_PROMPT_SECTION)
    expect(sendFlowMessage).toHaveBeenCalledTimes(1)
    expect(sendFlowMessage).toHaveBeenCalledWith(MIA_TEST_PHONE, expect.objectContaining({
      locationId: HATCH,
      replyInConversation: 'conv-1',
      flowId: FLOW_ON.flow_id,
      flowToken: flowTokenFor(HATCH_CONTACT, HATCH),
      bodyText: 'Tap below to pick a class and book it.',
    }))
    expect(toolResultOf(bodies[1])).toMatchObject({ sent: true, text: 'Tap below to pick a class and book it.' })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(adapter.send.mock.calls[0][1]).toBe(REPLY)
    expect(order).toEqual(['flow', 'reply'])
    const flowRows = inserts.filter((i) => i.table === 'whatsapp_messages' && i.row.message_type === 'flow')
    expect(flowRows).toHaveLength(1)
    expect(flowRows[0].row).toMatchObject({ conversation_id: 'conv-1', contact_id: HATCH_CONTACT, location_id: HATCH, source: 'agent' })
  })

  it('a Hatch member (un1t read block): the Flow variant of that block', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(hatchStudio()))
    const { fetchFn, bodies } = modelTurns([toolTurn(SEND_BOOKING_FLOW_TOOL_NAME), textTurn(REPLY)])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: thread(HATCH_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    same(bodies[0].tools, CACHED_BOOKING_FLOW_BLOCKS.un1t_read)
    expect(systemText(bodies[0])).toContain(BOOKING_FLOW_PROMPT_SECTION)
    expect(sendFlowMessage).toHaveBeenCalledTimes(1)
    expect(toolResultOf(bodies[1])).toMatchObject({ sent: true })
  })
})

describe('Hatch WhatsApp, Flow on: a dual member', () => {
  it("book_class with a un1t: id: the not-from-chat line plus the pointer to send_booking_flow; Flow off, today's answer exactly", async () => {
    for (const [hatchFlow, expectHint] of [[FLOW_ON, true], [{ ...FLOW_ON, enabled: false }, false]]) {
      resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio(), hatchStudio()))
      const { fetchFn, bodies } = modelTurns([toolTurn('book_class', { event_id: 'un1t:ev-1' }), textTurn('ok')])
      vi.stubGlobal('fetch', fetchFn)
      const { db } = turnDb({ conv: thread(HATCH_CONTACT), hatchFlow })

      await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

      const text = `I can't book classes at UN1T Hatch Street from here just yet. You can book here: ${HATCH_BOOKING_URL}`
      if (expectHint) {
        same(bodies[0].tools, CACHED_BOOKING_FLOW_BLOCKS.un1t_read_dual)
        expect(toolResultOf(bodies[1])).toEqual({ booked: false, chat_booking_unavailable: true, text, booking_form: expect.stringContaining('send_booking_flow') })
      } else {
        expect(toolNames(bodies[0])).not.toContain(SEND_BOOKING_FLOW_TOOL_NAME)
        expect(toolResultOf(bodies[1])).toEqual({ booked: false, chat_booking_unavailable: true, text })
      }
      expect(sendFlowMessage).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
      vi.clearAllMocks()
    }
  })
})

describe('Hatch WhatsApp: fallbacks to the booking link', () => {
  it('Flow off at the studio: today\'s request byte for byte; an invented call sends nothing', async () => {
    for (const hatchFlow of [{ ...FLOW_ON, enabled: false }, null, { enabled: true }]) {
      resolveMemberStudios.mockResolvedValue(nobody())
      const { fetchFn, bodies } = modelTurns([toolTurn(SEND_BOOKING_FLOW_TOOL_NAME), textTurn(`You can book here: ${HATCH_BOOKING_URL}`)])
      vi.stubGlobal('fetch', fetchFn)
      const { db } = turnDb({ conv: thread(HATCH_CONTACT), hatchFlow })

      await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

      expect(toolNames(bodies[0]), JSON.stringify(hatchFlow)).toEqual(CACHED_NO_BOOKING_TOOLS.map((t) => t.name))
      same(bodies[0].tools, CACHED_NO_BOOKING_TOOLS)
      expect(systemText(bodies[0])).not.toContain('send_booking_flow')
      expect(toolResultOf(bodies[1])).toMatchObject({ sent: false, reason: 'not_available', link: HATCH_BOOKING_URL })
      expect(sendFlowMessage).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
      vi.clearAllMocks()
    }
  })

  it('no contact linked to the thread: not offered', async () => {
    resolveMemberStudios.mockResolvedValue(nobody())
    const { fetchFn, bodies } = modelTurns([textTurn(`You can book here: ${HATCH_BOOKING_URL}`)])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: thread(null) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH, { contactId: null }))

    same(bodies[0].tools, CACHED_NO_BOOKING_TOOLS)
    expect(sendFlowMessage).not.toHaveBeenCalled()
  })

  it('Meta refuses the Flow: the model is told it was NOT sent, with the link, and the reply still goes', async () => {
    resolveMemberStudios.mockResolvedValue(nobody())
    sendFlowMessage.mockRejectedValueOnce(new Error('fictional Meta refusal'))
    const { fetchFn, bodies } = modelTurns([toolTurn(SEND_BOOKING_FLOW_TOOL_NAME), textTurn(`You can book here: ${HATCH_BOOKING_URL}`)])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ conv: thread(HATCH_CONTACT) })
    const adapter = whatsappAdapter()

    await runChannelAgent(db, adapter, turnCtx(HATCH))

    expect(toolResultOf(bodies[1])).toMatchObject({ sent: false, reason: 'send_failed', link: HATCH_BOOKING_URL })
    expect(inserts.some((i) => i.table === 'whatsapp_messages' && i.row.message_type === 'flow')).toBe(false)
    expect(adapter.send).toHaveBeenCalledTimes(1)
  })

  it('the 24h window is closed: not sent', async () => {
    resolveMemberStudios.mockResolvedValue(nobody())
    const { fetchFn, bodies } = modelTurns([toolTurn(SEND_BOOKING_FLOW_TOOL_NAME), textTurn('ok')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: thread(HATCH_CONTACT, { window_expires_at: new Date(Date.now() - 1000).toISOString() }) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    expect(toolResultOf(bodies[1])).toMatchObject({ sent: false, reason: 'window_closed' })
    expect(sendFlowMessage).not.toHaveBeenCalled()
  })

  it('a Flow already sent on this thread in the last 10 minutes: not sent again, the model points back to it', async () => {
    resolveMemberStudios.mockResolvedValue(nobody())
    const { fetchFn, bodies } = modelTurns([toolTurn(SEND_BOOKING_FLOW_TOOL_NAME), textTurn('The booking form is just above.')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: thread(HATCH_CONTACT), recentFlows: [{ id: 'm-1' }] })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    expect(toolResultOf(bodies[1])).toMatchObject({ sent: false, already_sent: true })
    expect(sendFlowMessage).not.toHaveBeenCalled()
  })
})

describe('Stillorgan (Glofox, Mia books in chat): unchanged', () => {
  it('Flow on at Stillorgan too: the full Glofox block byte for byte, no Flow prompt, an invented call sends nothing', async () => {
    resolveMemberStudios.mockResolvedValue(nobody())
    const { fetchFn, bodies } = modelTurns([toolTurn(SEND_BOOKING_FLOW_TOOL_NAME), textTurn('ok')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: thread(STILLORGAN_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    same(bodies[0].tools, CACHED_ACCOUNT_TOOLS)
    expect(toolNames(bodies[0])).not.toContain(SEND_BOOKING_FLOW_TOOL_NAME)
    expect(systemText(bodies[0])).not.toContain('send_booking_flow')
    expect(toolResultOf(bodies[1])).toMatchObject({ sent: false, reason: 'not_available' })
    expect(sendFlowMessage).not.toHaveBeenCalled()
  })

  it('a Hatch member writing on the Stillorgan thread: the un1t read block, not its Flow variant', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(hatchStudio()))
    const { fetchFn, bodies } = modelTurns([textTurn('ok')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: thread(STILLORGAN_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    same(bodies[0].tools, CACHED_UN1T_READ_TOOLS)
  })
})
