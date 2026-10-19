// MIAHATCH.2 Task 8 — Mia's turn dispatched by the member's studio.
//
// The resolver (member-studios.js) says which studios this sender may be
// answered for; the turn now picks its tool block and prompt from that
// (tool-blocks.js selectToolBlock), runs the Glofox executors with the Glofox
// studio's credentials when the thread is filed elsewhere, answers a `un1t:`
// booking id with the operator-editable "not from chat yet" line, and files a
// Hatch member's pause or cancellation at Hatch.
//
// Everything below is scripted: the Anthropic API is a stubbed fetch, every
// Glofox entry point is a spy, and the un1t.online live read is a stub. Fictional
// ids, phones and addresses only (the repo is public).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const flags = vi.hoisted(() => ({ un1tBookings: false }))

vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(),
  sendInteractiveOptions: vi.fn(),
  sendTypingIndicator: vi.fn(),
  sendCtaUrlMessage: vi.fn(),
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
// Every Glofox entry point is a spy: a Hatch turn must reach none of them.
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
// Anti-goal 3: a test can flip un1t.online's bookings capability on.
vi.mock('@/lib/membership/sources/un1t-online', async (importOriginal) => {
  const actual = await importOriginal()
  const source = actual.un1tOnlineSource
  return {
    ...actual,
    un1tOnlineSource: {
      key: source.key,
      label: source.label,
      isConfigured: source.isConfigured,
      get capabilities() { return { ...source.capabilities, bookings: flags.un1tBookings } },
    },
  }
})
vi.mock('./member-studios', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveMemberStudios: vi.fn(),
}))
// verify_identity is scripted (its own reads are account-tools' tests); every
// other account tool runs for real.
vi.mock('./account-tools', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    executeAccountTool: vi.fn(async (name, input, ctx) => (name === 'verify_identity'
      ? { verified: true }
      : actual.executeAccountTool(name, input, ctx))),
  }
})
// promptOptionsForPlan runs for real unless a test makes it throw.
vi.mock('./turn-studios', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, promptOptionsForPlan: vi.fn((...args) => actual.promptOptionsForPlan(...args)) }
})
vi.mock('./booking-tools', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, executeBookingTool: vi.fn((name, input, ctx) => actual.executeBookingTool(name, input, ctx)) }
})
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))
vi.mock('@/lib/person-accounts', async (importOriginal) => ({
  ...(await importOriginal()),
  linkedAccountsForContact: vi.fn(async () => ({ readFailed: true, contacts: [], accounts: [] })),
}))
vi.mock('./un1t-member-read', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchLiveUn1tBookings: vi.fn(async () => ({ ok: false, reason: 'read_failed' })),
  openUn1tMemberReader: vi.fn(async () => ({ ok: false, reason: 'not_connected' })),
}))
// MIAHATCH.5 Tasks 16 and 17 — D's write primitives and refund card are fakes:
// un1t.online is never called.
vi.mock('@/lib/un1t-online-write-ops', async () => {
  const { fakeUn1tWrite } = await import('./un1t-fakes.test-helpers')
  return fakeUn1tWrite()['@/lib/un1t-online-write-ops']()
})
vi.mock('@/lib/un1t-online-approval', async () => {
  const { fakeUn1tWrite } = await import('./un1t-fakes.test-helpers')
  return fakeUn1tWrite()['@/lib/un1t-online-approval']()
})

import * as glofox from '@/lib/glofox'
import {
  CACHED_ACCOUNT_TOOLS, CACHED_NO_BOOKING_TOOLS, CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS, CACHED_UN1T_FULL_TOOLS,
  runChannelAgent,
} from './auto-reply'
import { resolveMemberStudios } from './member-studios'
import { executeBookingTool } from './booking-tools'
import { promptOptionsForPlan, planKey, executorCtxFor } from './turn-studios'
import { book as un1tBook, cancel as un1tCancel } from '@/lib/un1t-online-write-ops'
import { fileRefundCard } from '@/lib/un1t-online-approval'
import { openUn1tMemberReader, fetchLiveUn1tBookings } from './un1t-member-read'
import { fakeUn1tReader } from './un1t-fakes.test-helpers'
import { formatClassTime } from './dublin-format'
import { notifyAgentApprovalRequest } from './approval-notify'
import { DEFAULT_NO_CREDITS_HANDOFF_TEXT } from './core'
import { DEFAULT_REFUND_REQUEST_TEXT } from './default-copy'

// Fictional ids.
const ORG = 'b2000000-0000-0000-0000-000000000001'
const STILLORGAN = 'a1000000-0000-0000-0000-000000000001'
const HATCH = 'a1000000-0000-0000-0000-000000000002'
const HATCH_2 = 'a1000000-0000-0000-0000-000000000003'
const STILLORGAN_CONTACT = 'c1000000-0000-0000-0000-000000000001'
const HATCH_CONTACT = 'c1000000-0000-0000-0000-000000000002'
const MIA_TEST_PHONE = '353870000099'
const OTHER_PHONE = '353870000055'
const HATCH_BOOKING_URL = 'https://hatch.example.test/book'

const stillorganStudio = (extra = {}) => ({
  locationId: STILLORGAN, name: 'UN1T Stillorgan', providerKey: 'glofox',
  active: true, answerable: true, contactIds: [STILLORGAN_CONTACT], glofoxMemberId: 'gm-1', ...extra,
})
const hatchStudio = (extra = {}) => ({
  locationId: HATCH, name: 'UN1T Hatch Street', providerKey: 'un1t_online',
  active: true, answerable: true, contactIds: [HATCH_CONTACT], un1tUserId: 'u-1', ...extra,
})
const resolution = (...studios) => ({ studios, readFailed: false })

const STILLORGAN_SETTINGS = { enabled: true }
const HATCH_TEST_SETTINGS = { enabled: false, test_mode: true, test_phones: [`+${MIA_TEST_PHONE}`], booking_url: HATCH_BOOKING_URL, booking_mode: 'auto' }

function locationRows({ hatchSettings = HATCH_TEST_SETTINGS, stillorganSettings = STILLORGAN_SETTINGS, hatchUn1tOnline } = {}) {
  return [
    {
      id: STILLORGAN, name: 'UN1T Stillorgan', timezone: 'Europe/Dublin', organization_id: ORG, membership_source: 'glofox',
      address: 'Fictional 1 Main Street, Stillorgan', settings: { customer_agent: stillorganSettings },
    },
    {
      id: HATCH, name: 'UN1T Hatch Street', timezone: 'Europe/Dublin', organization_id: ORG, membership_source: 'un1t_online',
      address: 'Fictional 2 Hatch Street, Dublin',
      settings: { customer_agent: hatchSettings, ...(hatchUn1tOnline ? { un1t_online: hatchUn1tOnline } : {}) },
    },
    {
      id: HATCH_2, name: 'UN1T Second Studio', timezone: 'Europe/Dublin', organization_id: ORG, membership_source: 'un1t_online',
      address: 'Fictional 3 Second Street, Dublin', settings: { customer_agent: HATCH_TEST_SETTINGS },
    },
  ]
}

const FUTURE = new Date(Date.now() + 3 * 86400_000).toISOString()
const DEFAULT_TABLES = () => ({
  agent_knowledge: [
    { location_id: STILLORGAN, category: 'sales', title: 'Stillorgan intro', content: 'Fictional: Stillorgan intro is 30 euro.', enabled: true },
    { location_id: HATCH, category: 'sales', title: 'Hatch intro', content: 'Fictional: Hatch intro is 25 euro.', enabled: true },
  ],
  contacts: [
    {
      id: STILLORGAN_CONTACT, first_name: 'Aoife', email: 'aoife@example.test',
      glofox_member_id: '6a0000000000000000000001', glofox_membership_status: 'member', glofox_membership_state: 'active',
    },
    { id: HATCH_CONTACT, first_name: 'Aoife', email: 'aoife@example.test' },
  ],
  un1t_subscriptions: [{
    location_id: HATCH, un1t_user_id: 'u-1', status: 'active', product_id: 'p-1', product_title: 'Fictional Hatch Unlimited',
    price_cents: 18900, currency: 'eur', billing_interval: 'month', billing_interval_count: 1, current_period_end: FUTURE,
    cancel_at_period_end: false, paused_at: null, paused_until: null, past_due_at: null,
  }],
  un1t_clients: [{ location_id: HATCH, un1t_user_id: 'u-1', credit_balance: 0, credit_unlimited: false, bookings_30d_attended: 6, last_attended_at: new Date().toISOString() }],
  un1t_products: [],
  un1t_events: [
    { location_id: HATCH, un1t_id: 'ev-1', title: 'Fictional Hatch HIIT', starts_at: FUTURE, capacity: 12, bookings_count: 3, status: 'scheduled' },
  ],
  un1t_bookings: [],
})

// A recording fake db. Rows are filtered by every .eq/.in the caller applies,
// so a read at the wrong studio comes back empty (and is recorded).
function turnDb({ threadLocationId: _threadLocationId, conv, freshVerified = null, history = 'what is my membership?', tables = {}, failLocationIds = [], ...locOpts }) {
  const data = { ...DEFAULT_TABLES(), ...tables, locations: locationRows(locOpts) }
  const reads = []
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
      reads.push({ table, cols: state.cols, filters: state.filters })
      if (table === 'locations' && state.filters.some(([kind, col, val]) => kind === 'eq' && col === 'id' && failLocationIds.includes(val))) {
        return { data: null, error: { message: 'fictional read failure', code: 'XX000' } }
      }
      if (table === 'whatsapp_conversations') {
        if (state.cols === 'agent_verified_contact_id') return { data: { agent_verified_contact_id: freshVerified }, error: null }
        return { data: conv, error: null }
      }
      if (table === 'whatsapp_messages') {
        if (state.selectOpts?.head) return { count: 0, error: null }
        if (state.sawGt) return { data: [], error: null }
        return { data: [{ direction: 'inbound', body: history, message_type: 'text', created_at: new Date().toISOString() }], error: null }
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
      or: () => builder, gte: () => builder, lte: () => builder, is: () => builder, contains: () => builder,
      gt: () => { state.sawGt = true; return builder },
      order: () => builder, limit: () => builder, range: () => builder,
      single: () => { state.single = true; return builder },
      maybeSingle: () => { state.single = true; return builder },
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return builder
  }
  return { db: { from: mk }, reads, inserts }
}

const whatsappAdapter = () => ({
  name: 'whatsapp', label: 'WhatsApp',
  conversationsTable: 'whatsapp_conversations', messagesTable: 'whatsapp_messages',
  nameColumn: 'wa_profile_name', pushCategory: 'whatsapp', handoffType: 'whatsapp_agent_handoff',
  trustsSenderIdentity: false,
  send: vi.fn().mockResolvedValue({ messageId: 'wamid.x' }),
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
const decisionMeta = (inserts) => inserts.find((i) => i.table === 'agent_decisions').row.meta
const glofoxCalls = () => Object.values(glofox).filter((fn) => typeof fn === 'function' && fn.mock).reduce((n, fn) => n + fn.mock.calls.length, 0)

const verifiedThread = (contactId) => ({
  agent_active: true, contact_id: contactId, agent_verified_contact_id: contactId,
  agent_verified_at: new Date().toISOString(), agent_last_reply_at: null,
})
const unverifiedThread = (contactId) => ({ agent_active: true, contact_id: contactId, agent_verified_contact_id: null, agent_verified_at: null, agent_last_reply_at: null })
const turnCtx = (locationId, extra = {}) => ({
  conversationId: 'conv-1', locationId, recipient: MIA_TEST_PHONE,
  contactId: locationId === HATCH ? HATCH_CONTACT : STILLORGAN_CONTACT,
  messageType: 'text', body: 'what is my membership?', connection: null, ...extra,
})

let errSpy, warnSpy
beforeEach(() => {
  vi.clearAllMocks()
  flags.un1tBookings = false
  process.env.ANTHROPIC_API_KEY = 'test-key'
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  errSpy.mockRestore()
  warnSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('anti-goal 3: un1t.online never reaches a Glofox executor', () => {
  it('with bookings:true on un1t.online, a Hatch turn never reaches a Glofox executor', async () => {
    flags.un1tBookings = true
    for (const answerable of [null, resolution(hatchStudio())]) {
      resolveMemberStudios.mockResolvedValue(answerable || { studios: [], readFailed: true })
      const { fetchFn, bodies } = modelTurns([
        toolTurn('list_upcoming_classes'),
        toolTurn('book_class', { event_id: '64aa00000000000000000001' }),
        toolTurn('list_my_upcoming_bookings'),
        toolTurn('get_my_membership'),
        textTurn('Done'),
      ])
      vi.stubGlobal('fetch', fetchFn)
      const { db, inserts } = turnDb({ threadLocationId: HATCH, conv: verifiedThread(HATCH_CONTACT) })

      await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

      expect(glofoxCalls()).toBe(0)
      // bookings:true does not make Hatch a Glofox studio: no-booking without a
      // resolution, the un1t read block with one.
      same(bodies[0].tools, answerable ? CACHED_UN1T_READ_TOOLS : CACHED_NO_BOOKING_TOOLS)
      expect(toolResultOf(bodies[2])).toMatchObject({ error: 'not_available_at_this_studio' })
      expect(decisionMeta(inserts).tool_block).toBe(answerable ? 'un1t_read' : 'no_booking')
      vi.unstubAllGlobals()
      vi.clearAllMocks()
    }
  })
})

describe('Hatch thread', () => {
  it('Hatch thread, Hatch in test mode, MIA TEST phone: un1t_read block, reads answered from un1t', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(hatchStudio()))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('get_my_membership'),
      toolTurn('get_my_recent_attendance'),
      toolTurn('list_upcoming_classes'),
      textTurn('You are on Fictional Hatch Unlimited.'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, reads, inserts } = turnDb({ threadLocationId: HATCH, conv: verifiedThread(HATCH_CONTACT) })

    const result = await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    for (const body of bodies) same(body.tools, CACHED_UN1T_READ_TOOLS)
    expect(toolResultOf(bodies[1])).toMatchObject({ status: 'active', plan: 'Fictional Hatch Unlimited', price_label: '€189 a month' })
    expect(toolResultOf(bodies[2])).toMatchObject({ found: true, total_attended_30d: 6, total_attended_7d: null })
    expect(toolResultOf(bodies[3]).classes).toEqual([expect.objectContaining({ event_id: 'un1t:ev-1', name: 'Fictional Hatch HIIT', full: false })])
    const un1tReads = reads.filter((r) => r.table.startsWith('un1t_'))
    expect(un1tReads.length).toBeGreaterThan(0)
    for (const r of un1tReads) expect(r.filters).toContainEqual(['eq', 'location_id', HATCH])
    expect(glofoxCalls()).toBe(0)
    // The un1t read prompt, naming Hatch and its booking link. Hatch is the thread: no facts block.
    const text = systemText(bodies[0])
    expect(text).toContain("You can't book or cancel classes at UN1T Hatch Street from chat")
    expect(text).toContain(HATCH_BOOKING_URL)
    expect(text).not.toContain('## Facts for')
    expect(decisionMeta(inserts).tool_block).toBe('un1t_read')
  })

  it('Hatch test mode, any other phone: no reply (gate) and no Hatch data', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(hatchStudio()))
    const { fetchFn } = modelTurns([toolTurn('get_my_membership'), textTurn('x')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, reads } = turnDb({ threadLocationId: HATCH, conv: verifiedThread(HATCH_CONTACT) })

    const result = await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH, { recipient: OTHER_PHONE }))

    expect(result.handled).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(resolveMemberStudios).not.toHaveBeenCalled()
    expect(reads.some((r) => r.table.startsWith('un1t_'))).toBe(false)
  })

  it('nobody answerable at Hatch: the no-booking block, byte for byte', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(hatchStudio({ active: false, answerable: false })))
    const { fetchFn, bodies } = modelTurns([textTurn('Hi!')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: HATCH, conv: verifiedThread(HATCH_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    same(bodies[0].tools, CACHED_NO_BOOKING_TOOLS)
    expect(systemText(bodies[0])).not.toContain('## Facts for')
    expect(decisionMeta(inserts).tool_block).toBe('no_booking')
  })
})

describe('Stillorgan thread', () => {
  it('Hatch-only member on Stillorgan thread, Hatch on: un1t_read block, Hatch timetable, facts block, rule line', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio({ active: false }), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([toolTurn('list_upcoming_classes'), textTurn('Here is Hatch.')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, reads, inserts } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    same(bodies[0].tools, CACHED_UN1T_READ_TOOLS)
    expect(toolResultOf(bodies[1]).classes).toEqual([expect.objectContaining({ event_id: 'un1t:ev-1', name: 'Fictional Hatch HIIT' })])
    const events = reads.find((r) => r.table === 'un1t_events')
    expect(events.filters).toContainEqual(['eq', 'location_id', HATCH])
    expect(glofoxCalls()).toBe(0)

    const [stable, volatile] = bodies[0].system
    // The Hatch rules and link in the stable prompt; the carve-out rule beside them.
    expect(stable.text).toContain("You can't book or cancel classes at UN1T Hatch Street from chat")
    expect(stable.text).toContain(`UN1T Hatch Street's booking link is ${HATCH_BOOKING_URL}`)
    expect(stable.text).toContain("When a facts block below names another studio, that studio's prices, offers, timetable and links come only from its facts block and your tools.")
    // Stillorgan's own knowledge stays the KNOWLEDGE section; Hatch's goes to its facts block only.
    expect(stable.text).toContain('Fictional: Stillorgan intro is 30 euro.')
    expect(stable.text).not.toContain('Fictional: Hatch intro is 25 euro.')
    expect(volatile.text).toContain('## Facts for UN1T Hatch Street')
    expect(volatile.text).toContain('Address: Fictional 2 Hatch Street, Dublin')
    expect(volatile.text).toContain(`Booking link: ${HATCH_BOOKING_URL}`)
    expect(volatile.text).toContain('- Hatch intro: Fictional: Hatch intro is 25 euro.')
    expect(volatile.text.trim().split('\n').at(-1))
      .toBe('Prices and the timetable for UN1T Hatch Street come only from your tools and this block, never from the studio knowledge above.')
    expect(stable.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(volatile.cache_control).toBeUndefined()
    expect(decisionMeta(inserts).tool_block).toBe('un1t_read')
  })

  it('dual member: un1t_read_dual; book_class with un1t: id answers chat_booking_unavailable_text with the link; without link the no-link line', async () => {
    for (const [hatchSettings, text] of [
      [HATCH_TEST_SETTINGS, `I can't book classes at UN1T Hatch Street from here just yet. You can book here: ${HATCH_BOOKING_URL}`],
      [{ ...HATCH_TEST_SETTINGS, booking_url: null }, "I can't book classes at UN1T Hatch Street from here just yet. The team will help you book."],
    ]) {
      resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio(), hatchStudio()))
      const { fetchFn, bodies } = modelTurns([
        toolTurn('book_class', { event_id: 'un1t:ev-1', class_name: 'Fictional Hatch HIIT' }),
        toolTurn('cancel_class_booking', { booking_id: 'un1t:bk-1' }),
        textTurn('Not from chat yet.'),
      ])
      vi.stubGlobal('fetch', fetchFn)
      const { db, inserts } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT), hatchSettings })

      await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

      same(bodies[0].tools, CACHED_UN1T_READ_DUAL_TOOLS)
      expect(toolResultOf(bodies[1])).toEqual({ booked: false, chat_booking_unavailable: true, text })
      expect(toolResultOf(bodies[2])).toEqual({ cancelled: false, chat_booking_unavailable: true, text })
      expect(glofoxCalls()).toBe(0)
      expect(inserts.some((i) => i.table === 'agent_membership_requests')).toBe(false)
      expect(systemText(bodies[0])).toContain('Say which studio each answer is for')
      expect(decisionMeta(inserts).tool_block).toBe('un1t_read_dual')
      vi.unstubAllGlobals()
      vi.clearAllMocks()
    }
  })

  it('dual member: an operator chat_booking_unavailable_text at Hatch is what the model gets', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio(), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([toolTurn('book_class', { event_id: 'un1t:ev-1' }), textTurn('ok')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({
      threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT),
      hatchSettings: { ...HATCH_TEST_SETTINGS, chat_booking_unavailable_text: 'Book {studio} online at {link}' },
    })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    expect(toolResultOf(bodies[1]).text).toBe(`Book UN1T Hatch Street online at ${HATCH_BOOKING_URL}`)
  })

  it('dual member: a Glofox event id still books at Stillorgan', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio(), hatchStudio()))
    const { fetchFn } = modelTurns([toolTurn('book_class', { event_id: '64aa00000000000000000001' }), textTurn('ok')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    expect(executeBookingTool).toHaveBeenCalledWith('book_class', expect.any(Object), expect.objectContaining({ locationId: STILLORGAN }))
    expect(glofox.glofoxCredentialsForLocation).toHaveBeenCalledWith(db, STILLORGAN)
    expect(glofox.createBooking).toHaveBeenCalledTimes(1)
  })

  it('tagged id from a non-answerable studio refused', async () => {
    // Stillorgan-only: the Glofox block, today's request; a un1t: id is no studio Mia answers for.
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio()))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('book_class', { event_id: 'un1t:ev-1' }),
      toolTurn('cancel_class_booking', { booking_id: 'un1t:bk-1' }),
      textTurn('Sorry'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, reads, inserts } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    same(bodies[0].tools, CACHED_ACCOUNT_TOOLS)
    expect(toolResultOf(bodies[1])).toMatchObject({ error: 'not_available_at_this_studio' })
    expect(toolResultOf(bodies[2])).toMatchObject({ error: 'not_available_at_this_studio' })
    expect(glofoxCalls()).toBe(0)
    expect(reads.some((r) => /glofox/.test(r.cols || ''))).toBe(false)
    expect(inserts.some((i) => i.table === 'agent_membership_requests')).toBe(false)
    expect(decisionMeta(inserts).tool_block).toBe('glofox')
  })

  it('verify mid-turn changes the block on the next iteration', async () => {
    resolveMemberStudios
      .mockResolvedValueOnce(resolution(stillorganStudio()))
      .mockResolvedValueOnce(resolution(stillorganStudio({ active: false }), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('verify_identity', { email: 'aoife@example.test', surname: 'Example' }),
      toolTurn('get_my_membership'),
      textTurn('You are on Fictional Hatch Unlimited.'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: STILLORGAN, conv: unverifiedThread(STILLORGAN_CONTACT), freshVerified: HATCH_CONTACT })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    same(bodies[0].tools, CACHED_ACCOUNT_TOOLS)
    expect(systemText(bodies[0])).not.toContain('## Facts for')
    // After verify the person is a Hatch member: new tools AND matching system blocks.
    same(bodies[1].tools, CACHED_UN1T_READ_TOOLS)
    expect(bodies[1].system[0].text).toContain("You can't book or cancel classes at UN1T Hatch Street from chat")
    expect(bodies[1].system[1].text).toContain('## Facts for UN1T Hatch Street')
    same(bodies[2].tools, CACHED_UN1T_READ_TOOLS)
    same(bodies[2].system, bodies[1].system)
    expect(toolResultOf(bodies[2])).toMatchObject({ status: 'active', plan: 'Fictional Hatch Unlimited' })
    expect(decisionMeta(inserts).tool_block).toBe('un1t_read')
  })

  it('request_cancellation for a Hatch member on a Stillorgan thread is filed at Hatch', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio({ active: false }), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('request_cancellation', { reason: 'moving away' }),
      toolTurn('request_pause', { reason: 'injury' }),
      textTurn('Requested.'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    expect(toolResultOf(bodies[1])).toEqual({ requested: true, kind: 'cancellation' })
    expect(toolResultOf(bodies[2])).toEqual({ requested: true, kind: 'pause' })
    const rows = inserts.filter((i) => i.table === 'agent_membership_requests').map((i) => i.row)
    expect(rows.map((r) => [r.kind, r.location_id])).toEqual([['cancellation', HATCH], ['pause', HATCH]])
    // Hatch-only (un1t_read): no dual stamp.
    for (const r of rows) {
      expect(r.details).not.toHaveProperty('member_studios_dual')
      expect(r.details).not.toHaveProperty('also_member_at_location_id')
    }
    expect(glofoxCalls()).toBe(0)
  })

  it('dual member: request_cancellation is filed at Hatch and says they are also a member at Stillorgan', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio(), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('request_cancellation', { reason: 'moving away' }),
      toolTurn('request_pause', { reason: 'injury' }),
      textTurn('Requested.'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    same(bodies[0].tools, CACHED_UN1T_READ_DUAL_TOOLS)
    const rows = inserts.filter((i) => i.table === 'agent_membership_requests').map((i) => i.row)
    expect(rows.map((r) => [r.kind, r.location_id])).toEqual([['cancellation', HATCH], ['pause', HATCH]])
    for (const r of rows) {
      expect(r.details).toMatchObject({ member_studios_dual: true, also_member_at_location_id: STILLORGAN, reason: expect.any(String) })
    }
    expect(glofoxCalls()).toBe(0)
  })
})

describe('Glofox studio override', () => {
  it("Stillorgan member on a Hatch-filed thread: Glofox executors get Stillorgan's locationId", async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio(), hatchStudio({ active: false, answerable: true, un1tUserId: undefined })))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('list_upcoming_classes'),
      toolTurn('book_class', { event_id: '64aa00000000000000000001' }),
      textTurn('Booked at Stillorgan.'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: HATCH, conv: verifiedThread(HATCH_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    // The Glofox block and the Glofox render (it books), not Hatch's no-booking one.
    same(bodies[0].tools, CACHED_ACCOUNT_TOOLS)
    const text = systemText(bodies[0])
    expect(text).not.toContain("You can't book or cancel classes")
    expect(text).toContain('## Facts for UN1T Stillorgan')
    // Every Glofox credential read is Stillorgan's, never Hatch's.
    const credCalls = glofox.glofoxCredentialsForLocation.mock.calls.map((c) => c[1])
    expect(credCalls.length).toBeGreaterThan(0)
    expect(new Set(credCalls)).toEqual(new Set([STILLORGAN]))
    for (const call of executeBookingTool.mock.calls) {
      // The Glofox studio's own contact is the anchor (the Hatch contact has no Glofox account).
      expect(call[2]).toMatchObject({ locationId: STILLORGAN, canBook: true, verifiedContactId: STILLORGAN_CONTACT })
    }
    expect(glofox.fetchUpcomingEvents).toHaveBeenCalled()
    expect(glofox.createBooking).toHaveBeenCalledTimes(1)
    const audit = inserts.filter((i) => i.table === 'agent_membership_requests').map((i) => i.row)
    expect(audit.length).toBeGreaterThan(0)
    for (const row of audit) expect(row.location_id).toBe(STILLORGAN)
    expect(decisionMeta(inserts).tool_block).toBe('glofox')
  })

  it('dual member on a Hatch thread: a Glofox book_class runs at Stillorgan; a un1t: id gets the line', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio(), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('book_class', { event_id: '64aa00000000000000000001' }),
      toolTurn('book_class', { event_id: 'un1t:ev-1' }),
      textTurn('ok'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ threadLocationId: HATCH, conv: verifiedThread(HATCH_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    same(bodies[0].tools, CACHED_UN1T_READ_DUAL_TOOLS)
    expect(executeBookingTool.mock.calls[0][2]).toMatchObject({ locationId: STILLORGAN, canBook: true, verifiedContactId: STILLORGAN_CONTACT })
    expect(new Set(glofox.glofoxCredentialsForLocation.mock.calls.map((c) => c[1]))).toEqual(new Set([STILLORGAN]))
    expect(glofox.createBooking).toHaveBeenCalledTimes(1)
    expect(toolResultOf(bodies[2])).toMatchObject({ booked: false, chat_booking_unavailable: true })
    // Hatch is the thread: the facts block is Stillorgan's.
    expect(systemText(bodies[0])).toContain('## Facts for UN1T Stillorgan')
    expect(systemText(bodies[0])).not.toContain('## Facts for UN1T Hatch Street')
  })
})

describe('fix round 1 (rulings 14, 15 and the minors)', () => {
  it.each([
    ['ClassPass pay-as-you-go'],
    ['a paused member'],
  ])('%s at Stillorgan, active at Hatch, on a Stillorgan thread: un1t_read_dual, a Glofox book_class reaches Stillorgan', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio({ active: false, liveRelationship: true }), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([toolTurn('book_class', { event_id: '64aa00000000000000000001' }), textTurn('ok')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    same(bodies[0].tools, CACHED_UN1T_READ_DUAL_TOOLS)
    expect(executeBookingTool).toHaveBeenCalledWith('book_class', expect.any(Object), expect.objectContaining({ locationId: STILLORGAN }))
    expect(new Set(glofox.glofoxCredentialsForLocation.mock.calls.map((c) => c[1]))).toEqual(new Set([STILLORGAN]))
    expect(toolResultOf(bodies[1])).not.toMatchObject({ error: 'not_available_at_this_studio' })
    expect(decisionMeta(inserts).tool_block).toBe('un1t_read_dual')
  })

  it('a lead at Stillorgan (no live relationship), active at Hatch: un1t_read, book_class refused', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio({ active: false, liveRelationship: false }), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([toolTurn('book_class', { event_id: '64aa00000000000000000001' }), textTurn('ok')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    same(bodies[0].tools, CACHED_UN1T_READ_TOOLS)
    expect(toolResultOf(bodies[1])).toMatchObject({ error: 'not_available_at_this_studio' })
    expect(glofoxCalls()).toBe(0)
  })

  it("Glofox studio settings unreadable: no override, the Hatch thread keeps today's block and prompt", async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio(), hatchStudio({ active: false, un1tUserId: undefined })))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('book_class', { event_id: '64aa00000000000000000001' }),
      toolTurn('list_upcoming_classes'),
      textTurn('ok'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: HATCH, conv: verifiedThread(HATCH_CONTACT), failLocationIds: [STILLORGAN] })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    same(bodies[0].tools, CACHED_NO_BOOKING_TOOLS)
    expect(systemText(bodies[0])).not.toContain('## Facts for')
    expect(toolResultOf(bodies[1])).toMatchObject({ error: 'not_available_at_this_studio' })
    expect(glofoxCalls()).toBe(0)
    for (const call of executeBookingTool.mock.calls) expect(call[2].locationId).toBe(HATCH)
    expect(decisionMeta(inserts).tool_block).toBe('no_booking')
  })

  it('executorCtxFor refuses (null) rather than borrow the thread\'s settings for the Glofox studio', async () => {
    const toolCtx = {
      locationId: HATCH, glofoxLocationId: STILLORGAN, verifiedContactId: HATCH_CONTACT, settings: { booking_mode: 'draft' }, zone: 'Europe/Dublin',
      turn: { block: 'glofox', answerable: [stillorganStudio()], channel: 'whatsapp', un1tWrites: false },
    }
    const studios = { settings: async () => null, zone: async () => 'Europe/Dublin' }
    expect(await executorCtxFor('book_class', { event_id: '64aa00000000000000000001' }, toolCtx, studios)).toBeNull()
    const ok = { settings: async () => ({ booking_mode: 'auto' }), zone: async () => 'Europe/Dublin' }
    expect(await executorCtxFor('book_class', { event_id: '64aa00000000000000000001' }, toolCtx, ok))
      .toMatchObject({ locationId: STILLORGAN, settings: { booking_mode: 'auto' }, verifiedContactId: STILLORGAN_CONTACT })
  })

  it('a bare un1t: id never reaches Glofox', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio()))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('book_class', { event_id: 'un1t:' }),
      toolTurn('cancel_class_booking', { booking_id: 'un1t:' }),
      textTurn('Sorry'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, reads } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    expect(toolResultOf(bodies[1])).toMatchObject({ error: 'not_available_at_this_studio' })
    expect(toolResultOf(bodies[2])).toMatchObject({ error: 'not_available_at_this_studio' })
    expect(glofoxCalls()).toBe(0)
    expect(reads.some((r) => /glofox/.test(r.cols || ''))).toBe(false)
  })

  it('planKey changes with the block, the named un1t studio and the facts studios', () => {
    const base = { block: 'un1t_read', un1tStudio: hatchStudio(), otherStudios: [] }
    expect(planKey(base)).toBe(planKey({ ...base, answerable: [hatchStudio({ active: false })] }))
    expect(planKey({ ...base, block: 'un1t_read_dual' })).not.toBe(planKey(base))
    expect(planKey({ ...base, un1tStudio: hatchStudio({ locationId: HATCH_2 }) })).not.toBe(planKey(base))
    expect(planKey({ ...base, otherStudios: [hatchStudio({ locationId: HATCH_2 })] })).not.toBe(planKey(base))
  })

  it('verify mid-turn with the same block but a new facts studio rebuilds the system', async () => {
    const second = hatchStudio({ locationId: HATCH_2, name: 'UN1T Second Studio', un1tUserId: 'u-2' })
    resolveMemberStudios
      .mockResolvedValueOnce(resolution(hatchStudio()))
      .mockResolvedValueOnce(resolution(hatchStudio(), second))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('verify_identity', { email: 'aoife@example.test', surname: 'Example' }),
      textTurn('ok'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ threadLocationId: HATCH, conv: unverifiedThread(HATCH_CONTACT), freshVerified: HATCH_CONTACT })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    same(bodies[0].tools, CACHED_UN1T_READ_TOOLS)
    same(bodies[1].tools, CACHED_UN1T_READ_TOOLS)
    expect(systemText(bodies[0])).not.toContain('## Facts for')
    expect(systemText(bodies[1])).toContain('## Facts for UN1T Second Studio')
  })

  it('verify mid-turn with an unchanged plan keeps the system built once', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio({ active: false }), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('verify_identity', { email: 'aoife@example.test', surname: 'Example' }),
      textTurn('ok'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ threadLocationId: STILLORGAN, conv: unverifiedThread(STILLORGAN_CONTACT), freshVerified: STILLORGAN_CONTACT })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    same(bodies[1].system, bodies[0].system)
    expect(promptOptionsForPlan).toHaveBeenCalledTimes(1)
  })

  it("a prompt that cannot be built drops the turn to today's block: tools and system agree", async () => {
    promptOptionsForPlan.mockRejectedValueOnce(new Error('boom'))
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio({ active: false }), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([textTurn('Hi')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT) })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    same(bodies[0].tools, CACHED_ACCOUNT_TOOLS)
    expect(systemText(bodies[0])).not.toContain("You can't book or cancel classes")
    expect(systemText(bodies[0])).not.toContain('## Facts for')
    expect(decisionMeta(inserts).tool_block).toBe('glofox')
  })
})

// MIAHATCH.5 (Task 15, Ruling 25) — block 3b at the turn: Hatch's
// writes_enabled (ALREADY true live, for the funnel) is not enough on its own;
// the studio's Mia switch un1t_chat_actions_enabled must be on too.
describe('un1t_full at the turn (MIAHATCH.5)', () => {
  const WRITES_ON = { writes_enabled: true, funnel_enabled: true }
  const SWITCH_ON = { ...HATCH_TEST_SETTINGS, un1t_chat_actions_enabled: true }

  it('writes_enabled true, switch absent: a Hatch turn stays un1t_read, a dual one un1t_read_dual (the live state)', async () => {
    for (const [threadLocationId, studios, tools, block, conv] of [
      [HATCH, [hatchStudio()], CACHED_UN1T_READ_TOOLS, 'un1t_read', verifiedThread(HATCH_CONTACT)],
      [STILLORGAN, [stillorganStudio(), hatchStudio()], CACHED_UN1T_READ_DUAL_TOOLS, 'un1t_read_dual', verifiedThread(STILLORGAN_CONTACT)],
    ]) {
      resolveMemberStudios.mockResolvedValue(resolution(...studios))
      const { fetchFn, bodies } = modelTurns([toolTurn('request_refund', { reason: 'late cancel' }), textTurn('ok')])
      vi.stubGlobal('fetch', fetchFn)
      const { db, inserts } = turnDb({ threadLocationId, conv, hatchUn1tOnline: WRITES_ON })

      await runChannelAgent(db, whatsappAdapter(), turnCtx(threadLocationId))

      same(bodies[0].tools, tools)
      expect(toolResultOf(bodies[1])).toMatchObject({ error: 'not_available_at_this_studio' })
      expect(systemText(bodies[0])).not.toMatch(/request_refund/)
      expect(decisionMeta(inserts).tool_block).toBe(block)
      vi.unstubAllGlobals()
      vi.clearAllMocks()
    }
  })

  it('switch on but writes_enabled off: still the read block', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(hatchStudio()))
    const { fetchFn, bodies } = modelTurns([textTurn('ok')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: HATCH, conv: verifiedThread(HATCH_CONTACT), hatchSettings: SWITCH_ON, hatchUn1tOnline: { writes_enabled: false } })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    same(bodies[0].tools, CACHED_UN1T_READ_TOOLS)
    expect(decisionMeta(inserts).tool_block).toBe('un1t_read')
  })

  const FUTURE_LABEL = formatClassTime(Date.parse(FUTURE) / 1000, 'Europe/Dublin')

  it('both on, Hatch thread: un1t_full tools and prompt; book_class books (Task 16), cancel cancels and request_refund files a card (Task 17) through D', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(hatchStudio()))
    un1tBook.mockResolvedValueOnce({ verdict: 'done', sent: true, id: 'bk-new', code: null, message: null, alreadyBooked: false, recovered: null, retryable: false, data: null, ledgerId: 'led-1' })
    un1tCancel.mockResolvedValueOnce({ verdict: 'done', sent: true, id: 'bk-1', code: null, message: null, alreadyBooked: false, recovered: null, retryable: false, data: null, ledgerId: 'led-2' })
    fileRefundCard.mockResolvedValueOnce({ approvalId: 'appr-1' })
    // book_class's live read fails (D decides); cancel's finds the booking.
    fetchLiveUn1tBookings
      .mockResolvedValueOnce({ ok: false, reason: 'read_failed' })
      .mockResolvedValueOnce({ ok: true, rows: [{ id: 'bk-1', event_id: 'ev-1', status: 'booked' }] })
    const { fetchFn, bodies } = modelTurns([
      toolTurn('book_class', { event_id: 'un1t:ev-1', class_name: 'Fictional Hatch HIIT', starts_at: FUTURE_LABEL }),
      toolTurn('cancel_class_booking', { booking_id: 'un1t:bk-1' }),
      toolTurn('request_refund', { reason: 'late cancel', booking_id: 'un1t:bk-1' }),
      toolTurn('send_purchase_link', { offer_id: 'o-1' }),
      textTurn('ok'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: HATCH, conv: verifiedThread(HATCH_CONTACT), hatchSettings: SWITCH_ON, hatchUn1tOnline: WRITES_ON })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    for (const body of bodies) same(body.tools, CACHED_UN1T_FULL_TOOLS)
    const stable = bodies[0].system[0].text
    expect(stable).toContain('You can book and cancel classes at UN1T Hatch Street in chat for a verified member.')
    expect(stable).toMatch(/call request_refund/)
    expect(stable).not.toMatch(/limited|spaces|capacity/i)
    expect(toolResultOf(bodies[1])).toEqual({ booked: true, class_name: 'Fictional Hatch HIIT', class_time: FUTURE_LABEL })
    expect(un1tBook).toHaveBeenCalledTimes(1)
    expect(un1tBook.mock.calls[0][1]).toEqual({ locationId: HATCH, contactId: HATCH_CONTACT, un1tUserId: 'u-1', eventId: 'ev-1', origin: 'mia', originRef: 'req-1', actor: null })
    const writeAhead = inserts.filter((i) => i.table === 'agent_membership_requests')
    expect(writeAhead[0].row).toMatchObject({ location_id: HATCH, kind: 'class_booking', details: { provider: 'un1t_online', event_id: 'ev-1', stage: 'executing' } })
    expect(toolResultOf(bodies[2])).toEqual({ cancelled: true, class_name: 'Fictional Hatch HIIT', class_time: FUTURE_LABEL })
    expect(un1tCancel).toHaveBeenCalledTimes(1)
    expect(un1tCancel.mock.calls[0][1]).toEqual({ locationId: HATCH, contactId: HATCH_CONTACT, un1tUserId: 'u-1', bookingId: 'bk-1', origin: 'mia', originRef: 'req-1', actor: null })
    expect(writeAhead[1].row).toMatchObject({ location_id: HATCH, kind: 'class_cancellation', details: { provider: 'un1t_online', booking_id: 'bk-1', reason: 'mia_cancellation', stage: 'executing' } })
    expect(toolResultOf(bodies[3])).toEqual({ filed: true, text: DEFAULT_REFUND_REQUEST_TEXT })
    expect(fileRefundCard).toHaveBeenCalledTimes(1)
    expect(fileRefundCard.mock.calls[0][1]).toMatchObject({ locationId: HATCH, reason: 'member_request', bookingId: 'bk-1', origin: 'mia', originRef: 'conv-1:bk-1', channel: 'whatsapp' })
    expect(toolResultOf(bodies[4])).toMatchObject({ error: 'not_available_at_this_studio' })
    expect(glofoxCalls()).toBe(0)
    expect(decisionMeta(inserts).tool_block).toBe('un1t_full')
  })

  it('both on, Hatch member with nothing to book with: the no_credits card at Hatch and the deterministic handoff', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(hatchStudio()))
    openUn1tMemberReader.mockResolvedValueOnce(fakeUn1tReader({ ledger: { balance: 0, is_unlimited: false } }))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('book_class', { event_id: 'un1t:ev-1', class_name: 'Fictional Hatch HIIT', starts_at: FUTURE_LABEL }),
      textTurn('You are booked!'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const adapter = whatsappAdapter()
    const { db, inserts } = turnDb({
      threadLocationId: HATCH, conv: verifiedThread(HATCH_CONTACT), hatchSettings: SWITCH_ON, hatchUn1tOnline: WRITES_ON,
      tables: { un1t_subscriptions: [] },
    })

    const result = await runChannelAgent(db, adapter, turnCtx(HATCH))

    expect(toolResultOf(bodies[1])).toMatchObject({ booked: false, no_credits: true })
    expect(result).toEqual({ handled: true, action: 'handoff', reason: 'no_credits' })
    expect(un1tBook).not.toHaveBeenCalled()
    const card = inserts.find((i) => i.table === 'agent_membership_requests')
    expect(card.row).toMatchObject({ location_id: HATCH, kind: 'class_booking', status: 'pending', details: { provider: 'un1t_online', reason: 'no_credits', event_id: 'ev-1', un1t_user_id: 'u-1' } })
    expect(notifyAgentApprovalRequest).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: HATCH, kind: 'class_booking' }))
    // The model's "You are booked!" is discarded for the operator script.
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(adapter.send.mock.calls[0][1]).toBe(DEFAULT_NO_CREDITS_HANDOFF_TEXT)
    expect(glofoxCalls()).toBe(0)
  })

  it('un1t_read_dual: book_class and cancel_class_booking with a un1t: id keep the slice 1 answer, request_refund is refused; D is never reached', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio(), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('book_class', { event_id: 'un1t:ev-1', class_name: 'Fictional Hatch HIIT', starts_at: FUTURE_LABEL }),
      toolTurn('cancel_class_booking', { booking_id: 'un1t:bk-1' }),
      toolTurn('request_refund', { reason: 'late cancel', booking_id: 'un1t:bk-1' }),
      textTurn('ok'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT), hatchUn1tOnline: WRITES_ON })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    expect(decisionMeta(inserts).tool_block).toBe('un1t_read_dual')
    expect(toolResultOf(bodies[1])).toMatchObject({ booked: false, chat_booking_unavailable: true })
    expect(toolResultOf(bodies[2])).toMatchObject({ cancelled: false, chat_booking_unavailable: true })
    expect(toolResultOf(bodies[3])).toMatchObject({ error: 'not_available_at_this_studio' })
    expect(un1tBook).not.toHaveBeenCalled()
    expect(un1tCancel).not.toHaveBeenCalled()
    expect(fileRefundCard).not.toHaveBeenCalled()
    expect(inserts.some((i) => i.table === 'agent_membership_requests')).toBe(false)
  })

  it('both on, Hatch-only member: a raw Glofox booking id is refused, never run at Hatch', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(hatchStudio()))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('book_class', { event_id: '64aa00000000000000000001' }),
      toolTurn('cancel_class_booking', { booking_id: '64bb00000000000000000001' }),
      textTurn('ok'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: HATCH, conv: verifiedThread(HATCH_CONTACT), hatchSettings: SWITCH_ON, hatchUn1tOnline: WRITES_ON })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(HATCH))

    same(bodies[0].tools, CACHED_UN1T_FULL_TOOLS)
    expect(toolResultOf(bodies[1])).toMatchObject({ error: 'not_available_at_this_studio' })
    expect(toolResultOf(bodies[2])).toMatchObject({ error: 'not_available_at_this_studio' })
    expect(glofoxCalls()).toBe(0)
    expect(inserts.some((i) => i.table === 'agent_membership_requests')).toBe(false)
  })

  it('both on, dual member on a Stillorgan thread: un1t_full with the dual prompt', async () => {
    resolveMemberStudios.mockResolvedValue(resolution(stillorganStudio(), hatchStudio()))
    const { fetchFn, bodies } = modelTurns([textTurn('ok')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ threadLocationId: STILLORGAN, conv: verifiedThread(STILLORGAN_CONTACT), hatchSettings: SWITCH_ON, hatchUn1tOnline: WRITES_ON })

    await runChannelAgent(db, whatsappAdapter(), turnCtx(STILLORGAN))

    same(bodies[0].tools, CACHED_UN1T_FULL_TOOLS)
    expect(systemText(bodies[0])).toContain('Say which studio each answer is for')
    expect(systemText(bodies[0])).toContain('REFUNDS at UN1T Hatch Street')
    expect(decisionMeta(inserts).tool_block).toBe('un1t_full')
  })
})
