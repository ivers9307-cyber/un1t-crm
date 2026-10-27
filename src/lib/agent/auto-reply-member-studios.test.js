// MIAHATCH.1 Task 2 — the member-studio resolver wired into Mia's turn.
//
// A Hatch-only member (live only at Hatch Street, an un1t.online studio)
// talking on a Stillorgan-filed thread while Hatch's Mia is off for them used
// to be read off the Stillorgan contact's Glofox columns ("no membership").
// Now the booking-system tools answer membership_at_other_studio, naming the
// studio, with no Glofox read. Everything else is byte-identical: the tool
// block and prompt of a Stillorgan-only member equal the base-commit fixtures.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
// Every Glofox entry point is a spy: a membership_at_other_studio answer must
// call none of them.
vi.mock('@/lib/glofox', () => ({
  GLOFOX_BOOKING_MODEL: 'program',
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(async () => ({ ok: true, events: [] })),
  fetchUserBookingsResult: vi.fn(async () => ({ ok: true, bookings: [] })),
  fetchUserCreditsResult: vi.fn(async () => ({ ok: true, credits: [] })),
  createBooking: vi.fn(async () => ({ ok: true })),
  cancelBooking: vi.fn(async () => ({ ok: true })),
  interpretBookingResult: vi.fn(() => ({ success: true })),
}))
// The resolver is the unit under control here (its own reads are Task 1's
// tests); the pure helpers stay real.
vi.mock('./member-studios', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveMemberStudios: vi.fn(),
}))
// The executors are spies so a test can say "the real tool never ran"; an
// executor that does run answers a marker no real tool returns.
vi.mock('./account-tools', async (importOriginal) => ({
  ...(await importOriginal()),
  executeAccountTool: vi.fn(async (name) => (name === 'verify_identity'
    ? { verified: true }
    : { marker: 'REAL_ACCOUNT_TOOL_RAN' })),
}))
vi.mock('./booking-tools', async (importOriginal) => ({
  ...(await importOriginal()),
  executeBookingTool: vi.fn(async () => ({ marker: 'REAL_BOOKING_TOOL_RAN' })),
}))

import fs from 'node:fs'
import path from 'node:path'
import * as glofox from '@/lib/glofox'
import { CACHED_ACCOUNT_TOOLS, runChannelAgent } from './auto-reply'
import { resolveMemberStudios } from './member-studios'
import { executeAccountTool } from './account-tools'
import { executeBookingTool } from './booking-tools'
import {
  BOOKING_SYSTEM_TOOL_NAMES, MEMBERSHIP_AT_OTHER_STUDIO_ERROR, membershipAtOtherStudio,
} from './tool-capability'
import { STILLORGAN_BLOB } from './settings-fixtures.test-helpers'

const FIX_DIR = path.join(__dirname, '__fixtures__')
const PROMPT_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'glofox-system-prompt.fixture.json'), 'utf8'))
const TOOLS_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'glofox-agent-tools.fixture.json'), 'utf8'))

// Fictional ids.
const ORG = 'b2000000-0000-0000-0000-000000000001'
const STILLORGAN = 'a1000000-0000-0000-0000-000000000001'
const HATCH = 'a1000000-0000-0000-0000-000000000002'
const STILLORGAN_CONTACT = 'c1000000-0000-0000-0000-000000000001'
const HATCH_CONTACT = 'c1000000-0000-0000-0000-000000000002'
const PHONE = '353870000000'

const stillorganStudio = (extra = {}) => ({
  locationId: STILLORGAN, name: 'UN1T Stillorgan', providerKey: 'glofox',
  active: false, answerable: true, contactIds: [STILLORGAN_CONTACT], glofoxMemberId: 'gm-1', ...extra,
})
const hatchStudio = (extra = {}) => ({
  locationId: HATCH, name: 'UN1T Hatch Street', providerKey: 'un1t_online',
  active: true, answerable: false, contactIds: [HATCH_CONTACT], un1tUserId: 'u-1', ...extra,
})
const HATCH_ONLY = { studios: [stillorganStudio(), hatchStudio()], readFailed: false }
const STILLORGAN_ONLY = { studios: [stillorganStudio({ active: true })], readFailed: false }

// A recording fake db for a WhatsApp turn at `locationId`.
function turnDb({ locationId = STILLORGAN, organizationId = ORG, settings = { enabled: true }, conv, freshVerified = null }) {
  const reads = []
  const inserts = []
  const updates = []
  const mk = (table) => {
    const state = { op: 'select', cols: null, selectOpts: null }
    const finish = () => {
      if (state.op === 'update') return { data: [{ id: 'conv-1' }], error: null }
      reads.push({ table, cols: state.cols })
      if (table === 'locations') {
        return {
          data: {
            id: locationId, name: 'UN1T Stillorgan', organization_id: organizationId, membership_source: 'glofox',
            settings: { customer_agent: settings, wa_card_sets: [{ name: 'Classes', description: 'when they ask what classes are like', cards: [{}, {}] }] },
          },
          error: null,
        }
      }
      if (table === 'agent_knowledge') {
        return {
          data: [
            { category: 'sales', title: 'Intro offer', content: 'Fictional: 3 classes for 30 euro.', enabled: true },
            { category: 'hours', title: 'Opening hours', content: 'Fictional: 6am to 9pm weekdays.', enabled: true },
          ],
          error: null,
        }
      }
      if (table === 'contacts') return { data: { id: STILLORGAN_CONTACT, first_name: 'Aoife', email: 'aoife@example.test' }, error: null }
      if (table === 'whatsapp_conversations' || table === 'instagram_conversations') {
        if (state.cols === 'agent_verified_contact_id') return { data: { agent_verified_contact_id: freshVerified }, error: null }
        return { data: conv, error: null }
      }
      if (table === 'whatsapp_messages' || table === 'instagram_messages') {
        if (state.selectOpts?.head) return { count: 0, error: null }
        if (state.sawGt) return { data: [], error: null }
        return { data: [{ direction: 'inbound', body: 'am I still a member?', message_type: 'text', created_at: new Date().toISOString() }], error: null }
      }
      return { data: [], error: null }
    }
    const builder = {
      select: (cols, opts) => { state.cols = cols; if (opts) state.selectOpts = opts; return builder },
      update: (row) => { state.op = 'update'; updates.push({ table, row }); return builder },
      insert: (row) => { inserts.push({ table, row }); return Promise.resolve({ error: null }) },
      eq: () => builder, or: () => builder, gte: () => builder, lte: () => builder,
      gt: () => { state.sawGt = true; return builder },
      is: () => builder, in: () => builder, order: () => builder, limit: () => builder,
      single: () => builder, maybeSingle: () => builder,
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return builder
  }
  return { db: { from: mk }, reads, inserts, updates }
}

function makeAdapter(extra = {}) {
  return {
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
    ...extra,
  }
}
function makeInstagramAdapter() {
  return makeAdapter({
    name: 'instagram', label: 'Instagram',
    conversationsTable: 'instagram_conversations', messagesTable: 'instagram_messages',
    nameColumn: null,
  })
}

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

const VERIFIED_THREAD = {
  agent_active: true, contact_id: STILLORGAN_CONTACT, agent_verified_contact_id: STILLORGAN_CONTACT,
  agent_verified_at: new Date().toISOString(), agent_last_reply_at: null,
}
const UNVERIFIED_THREAD = { agent_active: true, contact_id: STILLORGAN_CONTACT, agent_verified_contact_id: null, agent_verified_at: null, agent_last_reply_at: null }
const turnCtx = (extra = {}) => ({
  conversationId: 'conv-1', locationId: STILLORGAN, recipient: PHONE, contactId: STILLORGAN_CONTACT,
  messageType: 'text', body: 'am I still a member?', connection: null, ...extra,
})

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

describe('membershipAtOtherStudio (the tool answer)', () => {
  it('names the studio, says nothing was looked up, carries the error key', () => {
    expect(MEMBERSHIP_AT_OTHER_STUDIO_ERROR).toBe('membership_at_other_studio')
    expect(membershipAtOtherStudio('UN1T Hatch Street')).toEqual({
      error: 'membership_at_other_studio',
      studio: 'UN1T Hatch Street',
      message:
        "This person's membership is at UN1T Hatch Street, which you cannot answer for yet. Nothing was looked up. " +
        'Say you can see they train at UN1T Hatch Street and hand off to the team.',
    })
  })

  it('has no em or en dash in what it adds', () => {
    expect(membershipAtOtherStudio('UN1T Hatch Street').message).not.toMatch(/[—–]/)
  })
})

describe('Hatch-only member on a Stillorgan thread, Hatch off', () => {
  it('get_my_membership answers membership_at_other_studio naming Hatch: no executor, no Glofox read', async () => {
    resolveMemberStudios.mockResolvedValue(HATCH_ONLY)
    const { fetchFn, bodies } = modelTurns([toolTurn('get_my_membership'), textTurn('[[HANDOFF]] member at Hatch')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, reads } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(toolResultOf(bodies[1])).toMatchObject({ error: 'membership_at_other_studio', studio: 'UN1T Hatch Street' })
    expect(executeAccountTool).not.toHaveBeenCalled()
    expect(executeBookingTool).not.toHaveBeenCalled()
    expect(reads.some((r) => /glofox/.test(r.cols || ''))).toBe(false)
    for (const fn of Object.values(glofox)) if (typeof fn === 'function' && fn.mock) expect(fn).not.toHaveBeenCalled()
  })

  it.each([...BOOKING_SYSTEM_TOOL_NAMES])('%s answers membership_at_other_studio', async (name) => {
    resolveMemberStudios.mockResolvedValue(HATCH_ONLY)
    const { fetchFn, bodies } = modelTurns([toolTurn(name, { event_id: '64aa00000000000000000001' }), textTurn('[[HANDOFF]] at Hatch')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(toolResultOf(bodies[1])).toMatchObject({ error: 'membership_at_other_studio', studio: 'UN1T Hatch Street' })
    expect(executeAccountTool).not.toHaveBeenCalled()
    expect(executeBookingTool).not.toHaveBeenCalled()
  })

  it('an UNVERIFIED turn gets not_verified from the executor: no membership_at_other_studio, no studio name', async () => {
    resolveMemberStudios.mockResolvedValue(HATCH_ONLY)
    executeAccountTool.mockImplementationOnce(async (_name, _input, ctx) => (ctx.verifiedContactId
      ? { marker: 'REAL_ACCOUNT_TOOL_RAN' }
      : { error: 'not_verified', message: 'Verify the customer first.' }))
    const { fetchFn, bodies } = modelTurns([toolTurn('get_my_membership'), textTurn('Please verify first')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ conv: UNVERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    // The turn still resolved (it feeds the decision meta)...
    expect(resolveMemberStudios).toHaveBeenCalledTimes(1)
    expect(inserts.find((i) => i.table === 'agent_decisions').row.meta.member_studios).toHaveLength(2)
    // ...but the tool ran its own executor, which answered not_verified.
    expect(executeAccountTool).toHaveBeenCalledTimes(1)
    expect(executeAccountTool.mock.calls[0][2].verifiedContactId).toBeNull()
    const result = toolResultOf(bodies[1])
    expect(result.error).toBe('not_verified')
    expect(result.error).not.toBe('membership_at_other_studio')
    expect(JSON.stringify(result)).not.toContain('Hatch')
  })

  it('a Stillorgan contact on classpass_payg who is Hatch-active keeps the Glofox executor', async () => {
    // The resolver's classifier marks a live Stillorgan relationship; Hatch is active but unanswerable.
    resolveMemberStudios.mockResolvedValue({
      studios: [stillorganStudio({ liveRelationship: true }), hatchStudio()], readFailed: false,
    })
    const { fetchFn, bodies } = modelTurns([toolTurn('get_my_membership'), textTurn('You are on ClassPass.')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(executeAccountTool).toHaveBeenCalledWith('get_my_membership', {}, expect.any(Object))
    expect(toolResultOf(bodies[1])).toEqual({ marker: 'REAL_ACCOUNT_TOOL_RAN' })
    expect(JSON.stringify(toolResultOf(bodies[1]))).not.toContain('membership_at_other_studio')
  })

  it('a tool outside the booking-system set still runs its executor', async () => {
    resolveMemberStudios.mockResolvedValue(HATCH_ONLY)
    const { fetchFn, bodies } = modelTurns([toolTurn('list_upcoming_classes'), textTurn('Here you go')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(executeBookingTool).toHaveBeenCalledTimes(1)
    expect(toolResultOf(bodies[1])).toEqual({ marker: 'REAL_BOOKING_TOOL_RAN' })
  })

  it('resolves once at turn start from the verified contact, at the thread studio and its organisation', async () => {
    resolveMemberStudios.mockResolvedValue(HATCH_ONLY)
    const { fetchFn } = modelTurns([textTurn('Hi!')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(resolveMemberStudios).toHaveBeenCalledTimes(1)
    expect(resolveMemberStudios).toHaveBeenCalledWith(db, {
      anchorContactId: STILLORGAN_CONTACT, threadLocationId: STILLORGAN, organizationId: ORG, senderPhone: PHONE,
    })
  })

  it('the organisation id rides the location row the turn already reads: no second read for it', async () => {
    resolveMemberStudios.mockResolvedValue(HATCH_ONLY)
    const { fetchFn } = modelTurns([textTurn('Hi!')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, reads } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    // MIAFIX.1 (8) adds ONE organisation read of its own (the other studios'
    // booking links, readOrgStudioLinks, 'id, name, membership_source'); the org id still rides the first.
    expect(reads.filter((r) => r.table === 'locations').map((r) => r.cols))
      .toEqual(['id, name, timezone, organization_id, membership_source, settings', 'id, name, membership_source'])
  })

  it('decision meta carries member_studios: ids and flags only', async () => {
    resolveMemberStudios.mockResolvedValue(HATCH_ONLY)
    const { fetchFn } = modelTurns([toolTurn('get_my_membership'), textTurn('[[HANDOFF]] at Hatch')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    const decision = inserts.find((i) => i.table === 'agent_decisions')
    expect(decision.row.meta.member_studios).toEqual([
      { location_id: STILLORGAN, provider: 'glofox', active: false, answerable: true },
      { location_id: HATCH, provider: 'un1t_online', active: true, answerable: false },
    ])
    const raw = JSON.stringify(decision.row.meta)
    expect(raw).not.toContain('UN1T Hatch Street')
    expect(raw).not.toContain(HATCH_CONTACT)
    expect(raw).not.toContain('gm-1')
  })
})

describe('Stillorgan-only member: nothing changes', () => {
  it('tool block and stable system bytes equal the base-commit fixtures; no membership_at_other_studio', async () => {
    resolveMemberStudios.mockResolvedValue(STILLORGAN_ONLY)
    const { fetchFn, bodies } = modelTurns([toolTurn('get_my_membership'), textTurn('You are active.')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({
      conv: VERIFIED_THREAD,
      settings: { ...STILLORGAN_BLOB, membership_signup_url: 'https://example.test/join' },
    })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(JSON.stringify(bodies[0].tools)).toBe(JSON.stringify(TOOLS_FIXTURE.cached_tools))
    expect(bodies[0].tools).toEqual(JSON.parse(JSON.stringify(CACHED_ACCOUNT_TOOLS)))
    expect(bodies[0].system[0]).toEqual(PROMPT_FIXTURE.stillorgan_whatsapp[0])
    // The real executor ran, and its answer is what the model saw.
    expect(executeAccountTool).toHaveBeenCalledWith('get_my_membership', {}, expect.any(Object))
    expect(toolResultOf(bodies[1])).toEqual({ marker: 'REAL_ACCOUNT_TOOL_RAN' })
  })

  it('a resolved turn sends the same request bytes as an unresolved one (no org, so no resolution)', async () => {
    const run = async (organizationId, resolved) => {
      resolveMemberStudios.mockResolvedValue(resolved)
      const { fetchFn, bodies } = modelTurns([textTurn('Hi!')])
      vi.stubGlobal('fetch', fetchFn)
      const { db } = turnDb({ conv: VERIFIED_THREAD, organizationId })
      await runChannelAgent(db, makeAdapter(), turnCtx())
      return bodies[0]
    }
    const withResolution = await run(ORG, STILLORGAN_ONLY)
    const without = await run(null, STILLORGAN_ONLY)
    expect(resolveMemberStudios).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(withResolution)).toBe(JSON.stringify(without))
  })
})

describe('readFailed or nothing to resolve: today\'s thread-studio behaviour exactly', () => {
  it('readFailed: the real executor runs, even if studios were somehow present', async () => {
    resolveMemberStudios.mockResolvedValue({ studios: HATCH_ONLY.studios, readFailed: true })
    const { fetchFn, bodies } = modelTurns([toolTurn('get_my_membership'), textTurn('Hmm')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(executeAccountTool).toHaveBeenCalledTimes(1)
    expect(toolResultOf(bodies[1])).toEqual({ marker: 'REAL_ACCOUNT_TOOL_RAN' })
    // A failed read records no resolution: the key is omitted, not empty.
    const decision = inserts.find((i) => i.table === 'agent_decisions')
    expect(decision.row.meta).not.toHaveProperty('member_studios')
  })

  it('readFailed with the contract shape ({ studios: [], readFailed: true }) behaves the same', async () => {
    resolveMemberStudios.mockResolvedValue({ studios: [], readFailed: true })
    const { fetchFn, bodies } = modelTurns([toolTurn('get_my_membership'), textTurn('Hmm')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(toolResultOf(bodies[1])).toEqual({ marker: 'REAL_ACCOUNT_TOOL_RAN' })
  })

  it('no organisation on the location: the resolver is never called and the turn is today\'s', async () => {
    resolveMemberStudios.mockResolvedValue(HATCH_ONLY)
    const { fetchFn, bodies } = modelTurns([toolTurn('get_my_membership'), textTurn('Hmm')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: VERIFIED_THREAD, organizationId: null })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(resolveMemberStudios).not.toHaveBeenCalled()
    expect(toolResultOf(bodies[1])).toEqual({ marker: 'REAL_ACCOUNT_TOOL_RAN' })
  })

  it('no anchor contact at all: the resolver is never called', async () => {
    resolveMemberStudios.mockResolvedValue(HATCH_ONLY)
    const { fetchFn } = modelTurns([textTurn('Hi!')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: { ...UNVERIFIED_THREAD, contact_id: null } })

    await runChannelAgent(db, makeAdapter(), turnCtx({ contactId: null }))

    expect(resolveMemberStudios).not.toHaveBeenCalled()
  })
})

describe('re-resolution after verify_identity in the same turn', () => {
  it('an unverified thread resolves from the thread contact, then again from the newly verified one', async () => {
    resolveMemberStudios
      .mockResolvedValueOnce(STILLORGAN_ONLY)
      .mockResolvedValueOnce(HATCH_ONLY)
    const { fetchFn, bodies } = modelTurns([
      toolTurn('verify_identity', { email: 'a@example.test', surname: 'Example' }),
      toolTurn('get_my_membership'),
      textTurn('[[HANDOFF]] at Hatch'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ conv: UNVERIFIED_THREAD, freshVerified: HATCH_CONTACT })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(resolveMemberStudios).toHaveBeenCalledTimes(2)
    expect(resolveMemberStudios.mock.calls[0][1].anchorContactId).toBe(STILLORGAN_CONTACT)
    expect(resolveMemberStudios.mock.calls[1][1]).toEqual({
      anchorContactId: HATCH_CONTACT, threadLocationId: STILLORGAN, organizationId: ORG, senderPhone: PHONE,
    })
    // Before verifying, the thread contact's resolution said Stillorgan-only; after it, Hatch.
    expect(toolResultOf(bodies[2])).toMatchObject({ error: 'membership_at_other_studio', studio: 'UN1T Hatch Street' })
    // The decision row describes the LATEST resolution.
    const decision = inserts.find((i) => i.table === 'agent_decisions')
    expect(decision.row.meta.member_studios.map((s) => s.location_id)).toEqual([STILLORGAN, HATCH])
  })

  it('a re-resolve that yields nothing CLEARS the earlier resolution: no stale membership_at_other_studio', async () => {
    resolveMemberStudios
      .mockResolvedValueOnce(HATCH_ONLY)
      .mockRejectedValueOnce(new Error('boom'))
    const { fetchFn, bodies } = modelTurns([
      toolTurn('verify_identity', { email: 'a@example.test', surname: 'Example' }),
      toolTurn('get_my_membership'),
      textTurn('Done'),
    ])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ conv: UNVERIFIED_THREAD, freshVerified: HATCH_CONTACT })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(resolveMemberStudios).toHaveBeenCalledTimes(2)
    // The first resolution was anchored on the thread contact; it must not decide the verified turn.
    expect(toolResultOf(bodies[2])).toEqual({ marker: 'REAL_ACCOUNT_TOOL_RAN' })
    const decision = inserts.find((i) => i.table === 'agent_decisions')
    expect(decision.row.meta).not.toHaveProperty('member_studios')
  })

  it('a failed verify_identity does not re-resolve', async () => {
    resolveMemberStudios.mockResolvedValue(STILLORGAN_ONLY)
    executeAccountTool.mockImplementationOnce(async () => ({ verified: false }))
    const { fetchFn } = modelTurns([toolTurn('verify_identity', { email: 'a@example.test', surname: 'Nope' }), textTurn('Try again')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: UNVERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(resolveMemberStudios).toHaveBeenCalledTimes(1)
  })
})

describe('Instagram turn', () => {
  it('never calls the resolver and leaves toolCtx.memberStudios undefined', async () => {
    resolveMemberStudios.mockResolvedValue(HATCH_ONLY)
    const { fetchFn, bodies } = modelTurns([toolTurn('get_my_membership'), textTurn('Hmm')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeInstagramAdapter(), turnCtx())

    expect(resolveMemberStudios).not.toHaveBeenCalled()
    const ctxArg = executeAccountTool.mock.calls[0][2]
    expect(ctxArg.memberStudios).toBeUndefined()
    expect(toolResultOf(bodies[1])).toEqual({ marker: 'REAL_ACCOUNT_TOOL_RAN' })
    const decision = inserts.find((i) => i.table === 'agent_decisions')
    expect(decision.row.meta).not.toHaveProperty('member_studios')
  })
})

// MIAASKSTUDIO.1 — accounts at both studios, active at neither: Mia gets
// choose_studio and the "Which studio?" block, and a choice re-plans the turn.
describe('studio choice (accounts at both, active at neither)', () => {
  const BOTH_INACTIVE = { studios: [stillorganStudio(), hatchStudio({ active: false, answerable: true })], readFailed: false }
  const toolNames = (body) => body.tools.map((t) => t.name)
  const systemText = (body) => body.system.map((b) => b.text).join('\n')

  it('offers choose_studio; the choice is stored, re-plans the same turn and is logged', async () => {
    resolveMemberStudios.mockResolvedValue(BOTH_INACTIVE)
    const { fetchFn, bodies } = modelTurns([toolTurn('choose_studio', { studio: 'Hatch' }), textTurn('Sorting that now')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts, updates } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx({ body: 'can you resend the membership link' }))

    expect(toolNames(bodies[0])).toContain('choose_studio')
    expect(systemText(bodies[0])).toContain('## Which studio?')
    expect(toolResultOf(bodies[1])).toMatchObject({ chosen: 'UN1T Hatch Street' })
    expect(updates).toContainEqual({ table: 'whatsapp_conversations', row: { agent_chosen_location_id: HATCH } })
    // The next request is Hatch's block, with no choice left to make.
    expect(toolNames(bodies[1])).not.toContain('choose_studio')
    expect(systemText(bodies[1])).not.toContain('## Which studio?')
    const meta = inserts.find((i) => i.table === 'agent_decisions').row.meta
    expect(meta.chosen_studio).toBe(HATCH)
    expect(meta.tool_block).toMatch(/^un1t_/)
  })

  it('an unknown name changes nothing and lists the options', async () => {
    resolveMemberStudios.mockResolvedValue(BOTH_INACTIVE)
    const { fetchFn, bodies } = modelTurns([toolTurn('choose_studio', { studio: 'Rathmines' }), textTurn('Which studio?')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, updates } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(toolResultOf(bodies[1])).toMatchObject({ error: 'unknown_studio', options: ['UN1T Stillorgan', 'UN1T Hatch Street'] })
    expect(updates.some((u) => 'agent_chosen_location_id' in (u.row || {}))).toBe(false)
    expect(toolNames(bodies[1])).toContain('choose_studio')
  })

  it('a choice already on the thread is used from the first request', async () => {
    resolveMemberStudios.mockResolvedValue(BOTH_INACTIVE)
    const { fetchFn, bodies } = modelTurns([textTurn('Hi')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, inserts } = turnDb({ conv: { ...VERIFIED_THREAD, agent_chosen_location_id: HATCH } })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(toolNames(bodies[0])).not.toContain('choose_studio')
    expect(inserts.find((i) => i.table === 'agent_decisions').row.meta.tool_block).toMatch(/^un1t_/)
  })

  it('a member active somewhere is never asked', async () => {
    resolveMemberStudios.mockResolvedValue(STILLORGAN_ONLY)
    const { fetchFn, bodies } = modelTurns([textTurn('Hi')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ conv: VERIFIED_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx())

    expect(toolNames(bodies[0])).not.toContain('choose_studio')
    expect(systemText(bodies[0])).not.toContain('## Which studio?')
  })
})
