// INTEG-C3 — Mia wallet-empty soft handoff (per-LOCATION prepaid
// wallet, the sibling of the per-ORG ai_cap hard cap).
//
// Contract pinned here:
//   (a) UNPINNED location (getBillingState → null, i.e. every UN1T
//       location today) — the REAL checkSpend runs against the stub
//       db, sees no active tier pinning, and the turn proceeds
//       byte-identically to before enforcement existed.
//   (b) Pinned + allowance exhausted + wallet empty — soft handoff
//       with reason 'wallet_empty': ONE holding message, managers
//       paged, and the agent STAYS ARMED (no agent_active=false — a
//       top-up re-engages Mia with zero operator action).
//   (c) The check failing (thrown) — fail open: the reply still goes
//       out. A billing bug must never silence Mia.

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
// Real module, swappable checkSpend: the unpinned test exercises the
// REAL implementation against the stub db; the deny/fail-open tests
// override per call.
vi.mock('@/lib/wallet-enforcement', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, checkSpend: vi.fn(actual.checkSpend) }
})

import { runChannelAgent } from './auto-reply'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { checkSpend, clearBillingStateCache } from '@/lib/wallet-enforcement'

// Chainable stub (the auto-reply-model-failure shape). Unknown tables
// resolve { data: [], error: null } — which is exactly what an
// UNPINNED location looks like to the real checkSpend (location_plans
// has no active tier row).
function agentDb({ conv, history, calls }) {
  const mk = (table) => {
    const state = { op: 'select', patch: null, selectOpts: null }
    const finish = () => {
      if (state.op === 'update') {
        calls.push({ table, op: 'update', patch: state.patch })
        return { data: [{ id: 'conv-1' }], error: null }
      }
      if (table === 'locations') {
        return { data: { name: 'Stillorgan', settings: { customer_agent: { enabled: true } } }, error: null }
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
      eq: () => builder, or: () => builder, gte: () => builder, neq: () => builder,
      gt: () => { state.sawGt = true; return builder },
      lt: () => builder, is: () => builder, in: () => builder, order: () => builder, limit: () => builder,
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
    send: vi.fn().mockResolvedValue({ messageId: 'wamid.reply' }),
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

const HISTORY = [{ direction: 'inbound', body: 'Can I book a class tomorrow?', message_type: 'text', created_at: new Date().toISOString() }]

const MODEL_OK = {
  ok: true,
  status: 200,
  json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'See you at 7am!' }] }),
}

let errSpy, warnSpy
beforeEach(() => {
  vi.clearAllMocks()
  clearBillingStateCache()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  errSpy.mockRestore()
  warnSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('runChannelAgent — INTEG-C3 wallet gate', () => {
  it('(a) unpinned location: the REAL checkSpend passes and the reply goes out unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(MODEL_OK))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: { agent_active: true, contact_id: null, agent_last_reply_at: null }, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(checkSpend).toHaveBeenCalledWith(db, 'loc-1', 'ai_message', 'ai')
    // The real implementation resolved 'unpinned' off the stub db.
    await expect(checkSpend.mock.results[0].value).resolves.toEqual({ allow: true, reason: 'unpinned' })
    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(adapter.send.mock.calls[0][1]).toContain('See you at 7am!')
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('(b) pinned + empty wallet: soft handoff reason wallet_empty, agent stays armed', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    checkSpend.mockResolvedValueOnce({ allow: false, reason: 'wallet_empty' })
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: { agent_active: true, contact_id: null, agent_last_reply_at: null }, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'soft_handoff', reason: 'wallet_empty' })
    // No model call was made — the turn never started.
    expect(fetchSpy).not.toHaveBeenCalled()
    // ONE holding message reached the customer.
    expect(adapter.send).toHaveBeenCalledTimes(1)
    // Managers paged with the wallet copy.
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    const [, , payload] = sendPushToRolesAtLocation.mock.calls[0]
    expect(payload.title).toMatch(/wallet empty/i)
    // The agent was NOT disarmed (soft handoff — a top-up re-engages it).
    const disarm = calls.find((c) => c.op === 'update' && c.patch?.agent_active === false)
    expect(disarm).toBeUndefined()
  })

  it('(b) debounced: a recent agent reply suppresses a second wallet holding message', async () => {
    vi.stubGlobal('fetch', vi.fn())
    checkSpend.mockResolvedValueOnce({ allow: false, reason: 'wallet_empty' })
    const calls = []
    const adapter = makeAdapter()
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString()
    const db = agentDb({ conv: { agent_active: true, contact_id: null, agent_last_reply_at: tenSecondsAgo }, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: false, reason: 'soft_handoff_debounced' })
    expect(adapter.send).not.toHaveBeenCalled()
  })

  it('(c) a thrown wallet check FAILS OPEN — the reply still goes out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(MODEL_OK))
    checkSpend.mockRejectedValueOnce(new Error('billing infra down'))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv: { agent_active: true, contact_id: null, agent_last_reply_at: null }, history: HISTORY, calls })

    const result = await runChannelAgent(db, adapter, ctx)

    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })
})
