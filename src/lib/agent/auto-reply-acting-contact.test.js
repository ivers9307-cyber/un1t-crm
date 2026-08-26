// PERSON-ACCT.6 — the ACTING contact is the verified contact, not the person
// group's DISPLAY primary.
//
// Live bug (2026-08-25, "Julie Cross"): staff booked her on contact A, the
// thread was bound to A, and the agent still answered "I don't see any classes
// booked for you" because both verification lanes silently swapped A for the
// group's `primary_contact_id` (B) — a DISPLAY/outreach ranking (pickPrimary)
// that knows nothing about which account holds the person's activity. 879 of
// 887 person_groups hold divergent Glofox accounts, so it misroutes constantly.
//
// PR1 made every READ span the whole group (person-accounts.js), so the acting
// contact no longer has to be "the one true account" — it only has to be the
// person's ANCHOR. These tests pin that anchor for BOTH lanes, and pin that the
// name/greeting block deliberately still resolves through the display primary.
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
// A and B are ONE person (group G); B is the group's DISPLAY primary.
vi.mock('@/lib/person-links', () => ({
  personGroupResolver: vi.fn().mockResolvedValue({
    groupOf: (id) => (id === 'A' || id === 'B' ? 'G' : null),
    primaryOf: (g) => (g === 'G' ? 'B' : null),
  }),
}))
vi.mock('./account-tools', async (importOriginal) => ({
  ...(await importOriginal()),
  executeAccountTool: vi.fn(),
}))

import { runChannelAgent } from './auto-reply'
import { executeAccountTool } from './account-tools'

// Chainable stub over the reads runChannelAgentInner makes. `reads.contacts`
// records every contacts SELECT (which columns, which id) so the tests can tell
// the acting lookup apart from the display lookup.
function agentDb({ conv, history, calls, settings, phoneMatches = [], contactRows = {}, reads, contactsError = null }) {
  const mk = (table) => {
    const state = { op: 'select', patch: null, selectOpts: null, cols: null, eqs: [], sawOr: false, sawGt: false }
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
      if (table === 'contacts') {
        if (state.sawOr) return { data: phoneMatches, error: null }
        const id = (state.eqs.find((e) => e[0] === 'id') || [])[1] || null
        reads.contacts.push({ cols: state.cols, id })
        if (contactsError) return { data: null, error: contactsError }
        return { data: contactRows[id] || null, error: null }
      }
      return { data: [], error: null }
    }
    const builder = {
      select: (cols, opts) => { if (state.cols == null) state.cols = cols; if (opts) state.selectOpts = opts; return builder },
      update: (patch) => { state.op = 'update'; state.patch = patch; return builder },
      insert: (row) => { calls.push({ table, op: 'insert', row }); return Promise.resolve({ error: null }) },
      eq: (col, val) => { state.eqs.push([col, val]); return builder },
      or: () => { state.sawOr = true; return builder },
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

function makeAdapter({ trustsSenderIdentity }) {
  return {
    name: 'whatsapp',
    label: 'WhatsApp',
    conversationsTable: 'whatsapp_conversations',
    messagesTable: 'whatsapp_messages',
    nameColumn: 'wa_profile_name',
    pushCategory: 'whatsapp',
    handoffType: 'whatsapp_agent_handoff',
    trustsSenderIdentity,
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
  contactId: 'A',
  messageType: 'text',
  body: 'when is my next class?',
  connection: null,
}

const HISTORY = [{
  direction: 'inbound', body: 'when is my next class?', message_type: 'text',
  created_at: new Date().toISOString(),
}]

// Replays a scripted list of model turns.
function turnsFetch(turns) {
  let i = 0
  return vi.fn().mockImplementation(async () => ({
    ok: true, status: 200, json: async () => turns[Math.min(i++, turns.length - 1)],
  }))
}

const toolUse = (id, name) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: {} }] })
const endTurn = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Your next class is Monday at 6.' }] }

// Captures the acting id every tool call actually ran with.
function captureActing() {
  const seen = []
  executeAccountTool.mockImplementation(async (name, input, toolCtx) => {
    seen.push({ name, verifiedContactId: toolCtx.verifiedContactId })
    return name === 'verify_identity' ? { verified: true } : { ok: true }
  })
  return seen
}

const stampPatches = (calls) => calls
  .filter((c) => c.op === 'update' && c.table === 'whatsapp_conversations' && 'agent_verified_contact_id' in (c.patch || {}))
  .map((c) => c.patch.agent_verified_contact_id)

const decisionRow = (calls) => calls.find((c) => c.op === 'insert' && c.table === 'agent_decisions')?.row

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

describe('PERSON-ACCT.6 — acting contact is the verified contact, not the group primary', () => {
  it('PHONE lane: a thread bound to A in a group whose primary is B acts on A and stamps A', async () => {
    const seen = captureActing()
    vi.stubGlobal('fetch', turnsFetch([toolUse('t1', 'get_my_next_class'), endTurn]))
    const calls = []
    const reads = { contacts: [] }
    const db = agentDb({
      conv: { agent_active: true, contact_id: 'A', agent_last_reply_at: null, agent_verify_attempts: 0 },
      history: HISTORY,
      calls,
      settings: { enabled: true },
      // Both duplicate rows carry the sender's number — one Person, so the
      // same-person check passes and the lane verifies.
      phoneMatches: [{ id: 'A' }, { id: 'B' }],
      contactRows: { A: { first_name: 'Julie', email: 'julie@example.com' }, B: { first_name: 'Julie', email: 'julie@example.com' } },
      reads,
    })

    const result = await runChannelAgent(db, makeAdapter({ trustsSenderIdentity: true }), ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(seen).toContainEqual({ name: 'get_my_next_class', verifiedContactId: 'A' })
    expect(stampPatches(calls)).toEqual(['A'])
    expect(decisionRow(calls).contact_id).toBe('A')
  })

  it('QUIZ lane: the post-verify hook keeps the raw stamped contact A, never remaps to primary B', async () => {
    const seen = captureActing()
    vi.stubGlobal('fetch', turnsFetch([toolUse('t1', 'verify_identity'), toolUse('t2', 'get_my_next_class'), endTurn]))
    const calls = []
    const reads = { contacts: [] }
    const db = agentDb({
      // The re-read after a successful verify returns what account-tools
      // stamped: the RAW matched contact (account-tools.test.js pins that).
      conv: {
        agent_active: true, contact_id: 'A', agent_last_reply_at: null,
        agent_verify_attempts: 0, agent_verified_contact_id: 'A',
      },
      history: HISTORY,
      calls,
      settings: { enabled: true },
      contactRows: { A: { first_name: 'Julie', email: 'julie@example.com' }, B: { first_name: 'Julie', email: 'julie@example.com' } },
      reads,
    })

    // Untrusted channel identity → the email+surname quiz is the only lane.
    const result = await runChannelAgent(db, makeAdapter({ trustsSenderIdentity: false }), ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(seen).toContainEqual({ name: 'get_my_next_class', verifiedContactId: 'A' })
    // The hook must not re-stamp the thread onto the display primary either.
    expect(stampPatches(calls)).not.toContain('B')
    expect(decisionRow(calls).contact_id).toBe('A')
  })

  it('STORED stamp: a still-fresh prior verification acts on the stamped contact, not the primary', async () => {
    const seen = captureActing()
    vi.stubGlobal('fetch', turnsFetch([toolUse('t1', 'get_my_next_class'), endTurn]))
    const calls = []
    const reads = { contacts: [] }
    const db = agentDb({
      conv: {
        agent_active: true, contact_id: 'A', agent_last_reply_at: null, agent_verify_attempts: 0,
        agent_verified_contact_id: 'A', agent_verified_at: new Date().toISOString(),
      },
      history: HISTORY,
      calls,
      settings: { enabled: true },
      contactRows: { A: { id: 'A', first_name: 'Julie', email: 'julie@example.com' }, B: { id: 'B', first_name: 'Julie', email: 'julie@example.com' } },
      reads,
    })

    await runChannelAgent(db, makeAdapter({ trustsSenderIdentity: false }), ctx)

    expect(seen).toContainEqual({ name: 'get_my_next_class', verifiedContactId: 'A' })
  })

  it('DISPLAY stays on the group primary — the name block reads B while the turn acts as A', async () => {
    const seen = captureActing()
    vi.stubGlobal('fetch', turnsFetch([toolUse('t1', 'get_my_next_class'), endTurn]))
    const calls = []
    const reads = { contacts: [] }
    const db = agentDb({
      conv: { agent_active: true, contact_id: 'A', agent_last_reply_at: null, agent_verify_attempts: 0 },
      history: HISTORY,
      calls,
      settings: { enabled: true },
      phoneMatches: [{ id: 'A' }, { id: 'B' }],
      contactRows: { A: { first_name: 'Julie', email: 'julie@example.com' }, B: { first_name: 'Julie', email: 'julie@example.com' } },
      reads,
    })

    await runChannelAgent(db, makeAdapter({ trustsSenderIdentity: true }), ctx)

    const nameRead = reads.contacts.find((r) => String(r.cols || '').includes('first_name'))
    expect(nameRead?.id).toBe('B')
    expect(seen).toContainEqual({ name: 'get_my_next_class', verifiedContactId: 'A' })
  })

  it('DISPLAY on an UNVERIFIED thread stays on the thread\'s own contact, not a group primary', async () => {
    captureActing()
    vi.stubGlobal('fetch', turnsFetch([endTurn]))
    const calls = []
    const reads = { contacts: [] }
    const db = agentDb({
      conv: { agent_active: true, contact_id: 'A', agent_last_reply_at: null, agent_verify_attempts: 0 },
      history: HISTORY,
      calls,
      settings: { enabled: true },
      contactRows: { A: { first_name: 'Julie', email: 'julie@example.com' }, B: { first_name: 'Julie', email: 'julie@example.com' } },
      reads,
    })

    // Untrusted channel, no stamp → nobody has established who is typing, so
    // the greeting must not borrow a name from a (possibly mis-linked) group.
    await runChannelAgent(db, makeAdapter({ trustsSenderIdentity: false }), ctx)

    const nameRead = reads.contacts.find((r) => String(r.cols || '').includes('first_name'))
    expect(nameRead?.id).toBe('A')
  })

  it('STALE stamp: a stored id whose contact no longer exists is treated as absent → re-verify', async () => {
    const seen = captureActing()
    vi.stubGlobal('fetch', turnsFetch([toolUse('t1', 'get_my_next_class'), endTurn]))
    const calls = []
    const reads = { contacts: [] }
    const db = agentDb({
      conv: {
        agent_active: true, contact_id: 'A', agent_last_reply_at: null, agent_verify_attempts: 0,
        agent_verified_contact_id: 'GONE', agent_verified_at: new Date().toISOString(),
      },
      history: HISTORY,
      calls,
      settings: { enabled: true },
      // 'GONE' was merged away — no row answers for it.
      contactRows: { A: { first_name: 'Julie', email: 'julie@example.com' } },
      reads,
    })

    await runChannelAgent(db, makeAdapter({ trustsSenderIdentity: false }), ctx)

    expect(seen).toContainEqual({ name: 'get_my_next_class', verifiedContactId: null })
  })

  it('STALE stamp: an UNREADABLE contacts row keeps the verification (never re-quiz on a transient error)', async () => {
    const seen = captureActing()
    vi.stubGlobal('fetch', turnsFetch([toolUse('t1', 'get_my_next_class'), endTurn]))
    const calls = []
    const reads = { contacts: [] }
    const db = agentDb({
      conv: {
        agent_active: true, contact_id: 'A', agent_last_reply_at: null, agent_verify_attempts: 0,
        agent_verified_contact_id: 'A', agent_verified_at: new Date().toISOString(),
      },
      history: HISTORY,
      calls,
      settings: { enabled: true },
      reads,
      contactsError: { message: 'connection reset' },
    })

    await runChannelAgent(db, makeAdapter({ trustsSenderIdentity: false }), ctx)

    expect(seen).toContainEqual({ name: 'get_my_next_class', verifiedContactId: 'A' })
  })
})
