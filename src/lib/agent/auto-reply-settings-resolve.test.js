// MIAORG.1 Task 2 — the live reply path reads Mia's settings through the
// resolver (DEFAULTS <- org <- studio). Pins: an org-only value reaches the
// prompt; an org can never switch a studio on; Stillorgan's real blob builds
// the same request as before (org layer null); a studio read failure is still
// "disabled". Fictional ids.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(),
  sendInteractiveOptions: vi.fn(),
  sendTypingIndicator: vi.fn(),
  sendCtaUrlMessage: vi.fn(),
  splitTrailingUrl: () => null,
}))
vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }) }))
vi.mock('@/lib/error-events', () => ({ recordErrorEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/person-links', () => ({
  personGroupResolver: vi.fn().mockResolvedValue({ groupOf: () => null, primaryOf: () => null }),
}))

import { runChannelAgent } from './auto-reply'
import { STILLORGAN_BLOB, ORG_LAYER, withOrgLayer } from './settings-fixtures.test-helpers'

const LOC = 'a0000000-0000-0000-0000-0000000000a1'
const ORG = 'b0000000-0000-0000-0000-0000000000b1'

function agentDb({ settings, org = null, locationError = null }) {
  const calls = []
  const mk = (table) => {
    const state = { op: 'select', sawGt: false, selectOpts: null }
    const finish = () => {
      if (state.op === 'update') return { data: [{ id: 'conv-1' }], error: null }
      if (table === 'locations') {
        if (locationError) return { data: null, error: locationError }
        return { data: { id: LOC, name: 'Studio', timezone: 'Europe/Dublin', organization_id: ORG, settings }, error: null }
      }
      if (table === 'whatsapp_conversations') return { data: { agent_active: true, contact_id: null, agent_last_reply_at: null }, error: null }
      if (table === 'whatsapp_messages') {
        if (state.selectOpts?.head) return { count: 0, error: null }
        if (state.sawGt) return { data: [], error: null }
        return { data: [{ direction: 'inbound', body: 'hi', message_type: 'text', created_at: new Date().toISOString() }], error: null }
      }
      return { data: [], error: null }
    }
    const b = {
      select: (cols, opts) => { if (opts) state.selectOpts = opts; return b },
      update: () => { state.op = 'update'; return b },
      insert: (row) => { calls.push({ table, row }); return Promise.resolve({ error: null }) },
      eq: () => b, or: () => b, gte: () => b, gt: () => { state.sawGt = true; return b },
      is: () => b, in: () => b, order: () => b, limit: () => b, single: () => b, maybeSingle: () => b,
      then: (res, rej) => Promise.resolve(finish()).then(res, rej),
    }
    return b
  }
  return withOrgLayer({ from: mk, calls }, org)
}

const adapter = () => ({
  name: 'whatsapp', label: 'WhatsApp',
  conversationsTable: 'whatsapp_conversations', messagesTable: 'whatsapp_messages',
  nameColumn: 'wa_profile_name', pushCategory: 'whatsapp', handoffType: 'whatsapp_agent_handoff',
  trustsSenderIdentity: false,
  send: vi.fn().mockResolvedValue({ messageId: 'wamid.x' }),
  outboundRow: ({ conversationId, locationId, messageId, text, now }) => ({
    conversation_id: conversationId, location_id: locationId, wa_message_id: messageId,
    direction: 'outbound', message_type: 'text', body: text, status: 'sent', source: 'agent', sent_at: now,
  }),
})
const ctx = { conversationId: 'conv-1', locationId: LOC, recipient: '353870000777', contactId: null, messageType: 'text', body: 'hi', connection: null }

let fetchMock, errSpy, warnSpy
beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  fetchMock = vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello there.' }] }),
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { errSpy.mockRestore(); warnSpy.mockRestore(); vi.unstubAllGlobals() })

const requestBody = () => JSON.parse(fetchMock.mock.calls[0][1].body)
const systemText = () => requestBody().system.map((b) => b.text).join('\n')

describe('runChannelAgent reads resolved settings', () => {
  it('an org-only value (tone) reaches the prompt when the studio sets none', async () => {
    const studio = { ...STILLORGAN_BLOB, tone: null }
    const r = await runChannelAgent(agentDb({ settings: { customer_agent: studio }, org: ORG_LAYER }), adapter(), ctx)
    expect(r).toMatchObject({ handled: true, action: 'reply' })
    expect(systemText()).toContain('Org tone.')
    // The studio's own values still win over the org's.
    expect(systemText()).toContain(STILLORGAN_BLOB.extra_rules)
    expect(systemText()).not.toContain('Org rules.')
  })

  it('an org with enabled:true never switches on a studio with no blob (Hatch)', async () => {
    const r = await runChannelAgent(agentDb({ settings: {}, org: ORG_LAYER }), adapter(), ctx)
    expect(r).toEqual({ handled: false, reason: 'disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("no behaviour change: Stillorgan's real blob, org layer null, builds the same request it always did", async () => {
    const r = await runChannelAgent(agentDb({ settings: { customer_agent: STILLORGAN_BLOB }, org: null }), adapter(), ctx)
    expect(r).toMatchObject({ handled: true, action: 'reply' })
    const body = requestBody()
    expect(body.output_config.effort).toBe('medium')
    expect(systemText()).toContain(STILLORGAN_BLOB.tone)
    expect(systemText()).toContain(STILLORGAN_BLOB.agent_name)
  })

  it('a failed studio read is still "disabled" (no settings), exactly as before', async () => {
    const r = await runChannelAgent(agentDb({ settings: null, locationError: { message: 'down' } }), adapter(), ctx)
    expect(r).toEqual({ handled: false, reason: 'disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
