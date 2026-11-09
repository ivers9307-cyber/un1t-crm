// WA-BSUID.2 — a WhatsApp user with a username can hide their phone number.
// Meta then omits `messages[].from` and `contacts[].wa_id` and names the sender
// by a business-scoped user id only. The webhook used to call
// `message.from.startsWith`, so such a message threw, was lost, and took the
// rest of that webhook POST with it. Same state-backed fake database and real
// routeInboundThread as route.inbound-route.test.js. Fictional ids only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({
  refreshWindow: vi.fn(),
  parseConsentKeyword: vi.fn(() => null),
  pickInboundContact: vi.fn(() => null),
  markUndeliverableIfPermanent: vi.fn(),
}))
vi.mock('@/lib/whatsapp-consent', () => ({ applyWhatsappConsentKeyword: vi.fn(async () => ({ applied: true })), applyMetaUserPreference: vi.fn() }))
vi.mock('@/lib/whatsapp-flow/completion.js', () => ({ handleFlowCompletion: vi.fn() }))
vi.mock('@/lib/whatsapp-config', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))
vi.mock('@/lib/webhook-auth', () => ({ verifyMetaSignature: vi.fn(() => ({ ok: true })), safeEqual: vi.fn(() => true) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(), sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/schemas', () => ({ MANAGER_ROLES: ['owner', 'manager', 'head_coach'] }))
vi.mock('@/lib/webhook-events', () => ({
  recordWebhookEvent: vi.fn(async () => ({ seen: false })),
  WEBHOOK_PROVIDERS: { WHATSAPP: 'whatsapp' },
}))
vi.mock('@/lib/agent/auto-reply', () => ({ maybeAutoReply: vi.fn(async () => ({ handled: false })) }))
vi.mock('@/lib/agent/welcome-greeting', () => ({ maybeSendWelcomeGreeting: vi.fn() }))
vi.mock('@/lib/wa-studio-pick/resolve', () => ({
  resolveNewSenderStudio: vi.fn(async (_db, ctx) => ({ action: 'skip', locationId: ctx.threadLocationId, conversationId: ctx.conversationId })),
}))
vi.mock('@/lib/whatsapp-template-events', () => ({ applyTemplateEvent: vi.fn(async () => ({ template: null, notify: null })) }))
vi.mock('@/lib/whatsapp-number-events', () => ({ NUMBER_EVENT_FIELDS: new Set(), applyNumberEvent: vi.fn() }))
vi.mock('@/lib/whatsapp-flow-events', () => ({ FLOW_EVENT_FIELDS: new Set(), applyFlowEvent: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ recordCtwaTouch: vi.fn() }))
vi.mock('@/lib/whatsapp-pricing', () => ({ pricingColumnsFromStatus: vi.fn(() => null) }))
vi.mock('@/lib/whatsapp-media-server', () => ({ ensureMediaRehosted: vi.fn() }))
vi.mock('@/lib/whatsapp-bsuid', () => ({ captureInboundBsuid: vi.fn(), extractInboundBsuid: vi.fn(() => null) }))
vi.mock('@/lib/whatsapp-coexistence', () => ({
  parseEchoMessages: vi.fn(() => []),
  parseSyncContacts: vi.fn(() => []),
  parseHistoryMessages: vi.fn(() => []),
  nextHistorySyncState: vi.fn(),
}))
vi.mock('@/lib/whatsapp-coexistence-ingest', () => ({ syncContactMatchOnly: vi.fn(), ingestCoexistenceMessage: vi.fn() }))
// ORGCONTACTS.1 — an inbound message is activity at the routed studio (touchContactStudio).
// ORGCONTACTS.3 — the phone matches' relationship rows feed pickInboundContact and the router.
// The real pickStudioByActivity stays (the router's step 4 is under test).
vi.mock('@/lib/contact-studios', async (importOriginal) => ({
  ...(await importOriginal()),
  touchContactStudio: vi.fn(async () => ({ ok: true, touched: true })),
  studiosOfContacts: vi.fn(async () => ({ ok: true, byContact: new Map() })),
}))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { resolveWhatsAppNumberByPhoneNumberId } from '@/lib/whatsapp-config'
import { pickInboundContact, parseConsentKeyword, refreshWindow } from '@/lib/whatsapp'
import { captureInboundBsuid } from '@/lib/whatsapp-bsuid'
import { applyWhatsappConsentKeyword } from '@/lib/whatsapp-consent'
import { maybeAutoReply } from '@/lib/agent/auto-reply'
import { recordCtwaTouch } from '@/lib/meta-capi'
import { handleFlowCompletion } from '@/lib/whatsapp-flow/completion.js'
import { fakeWhatsAppDb, link } from '@/lib/whatsapp-numbers-fake-db.test-helpers.js'
import { touchContactStudio, studiosOfContacts } from '@/lib/contact-studios'

const ORG = 'd0000000-0000-4000-8000-000000000001'
const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const NUM = 'wn-1'
const PNI = '1230000000000001'
const PHONE = '353870000001'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const ago = (ms) => new Date(Date.now() - ms).toISOString()

const OWNER = { source: 'db', id: NUM, locationId: STILL, homeLocationId: STILL, organizationId: ORG, phoneNumberId: PNI, token: 'tok' }
const PRE_GO_LIVE = [link(STILL, NUM, { is_default: true })]
const GO_LIVE = [...PRE_GO_LIVE, link(HATCH, NUM, { is_default: true })]

// Reads replay on the shared WhatsApp fake (it filters eq/neq/in/gte/lte, orders,
// limits); writes land in `state` so later reads see them. `.or()` and `.is()`
// only narrow writes and the contacts lookup here, so the reader skips them.
function makeDb(state) {
  const reader = fakeWhatsAppDb(state)
  let seq = 0
  const from = (table) => {
    const ops = []
    let write = null
    const run = async () => {
      if (write?.op === 'insert') {
        const row = { id: `${table === 'whatsapp_conversations' ? 'conv' : 'row'}-new-${++seq}`, ...write.payload }
        const key = table === 'whatsapp_conversations' ? 'conversations' : table
        state[key] = [...(state[key] || []), row]
        return { data: { id: row.id }, error: null }
      }
      if (write?.op === 'update') {
        state.updates.push({ table, payload: write.payload, ops })
        if (table === 'whatsapp_conversations') {
          const id = ops.find(([m, c]) => m === 'eq' && c === 'id')?.[2]
          for (const r of state.conversations.filter((c) => c.id === id)) Object.assign(r, write.payload)
        }
        return { data: null, error: null }
      }
      state.reads.push({ table, ops })
      let q = reader.from(table)
      for (const [m, ...args] of ops) if (m !== 'or' && m !== 'is') q = q[m](...args)
      return q
    }
    const b = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'or', 'is', 'order', 'limit']) {
      b[m] = (...args) => { ops.push([m, ...args]); return b }
    }
    b.insert = (payload) => { write = { op: 'insert', payload }; return b }
    b.update = (payload) => { write = { op: 'update', payload }; return b }
    b.single = async () => { const r = await run(); return Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r }
    b.maybeSingle = async () => { if (write) return run(); const q = await run(); return Array.isArray(q.data) ? { data: q.data[0] ?? null, error: null } : q }
    b.then = (res, rej) => run().then((q) => q).then(res, rej)
    return b
  }
  return { from, rpc: vi.fn(async () => ({ data: null, error: null })) }
}

function makeState({ links = GO_LIVE, conversations = [], messages = [], adEntities = [], contacts = [] } = {}) {
  return {
    locations: [{ id: STILL, organization_id: ORG }, { id: HATCH, organization_id: ORG }],
    numbers: [{ id: NUM, location_id: STILL, organization_id: ORG, is_active: true }],
    links,
    conversations,
    whatsapp_messages: messages,
    ad_entities: adEntities,
    contacts,
    updates: [],
    reads: [],
  }
}

const thread = (id, locationId, extra = {}) => ({
  id, location_id: locationId, contact_id: 'c-1', ctwa_clid: null, studio_resolution: null,
  wa_phone: PHONE, wa_bsuid: null, whatsapp_number_id: null, ...extra,
})
const outbound = (conversationId, locationId, sentAt) => ({
  conversation_id: conversationId, location_id: locationId, direction: 'outbound', sent_at: sentAt, wa_message_id: `wamid.out.${conversationId}`,
})

const BSUID = 'IE.13491208655302741918'

const text = (extra = {}) => ({
  id: `wamid.in.${Math.random()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' }, ...extra,
})
// A sender with a hidden number: no `from`, no `wa_id`.
const hidden = (extra = {}) => text({ from_user_id: BSUID, ...extra })
const HIDDEN_CONTACTS = [{ profile: { name: 'Hidden Member', username: 'hidden.member' }, user_id: BSUID }]
const PHONE_CONTACTS = [{ wa_id: PHONE, profile: { name: 'Test Member' } }]

function reqFor({ messages = [], contacts = HIDDEN_CONTACTS, statuses } = {}) {
  const body = { entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: PNI }, contacts, messages, ...(statuses ? { statuses } : {}),
  } }] }] }
  return { text: async () => JSON.stringify(body), headers: { get: () => 'sha256=sig' } }
}

let state
const inboundRows = () => state.whatsapp_messages.filter((m) => m.direction === 'inbound')
const contactReads = () => state.reads.filter((r) => r.table === 'contacts')

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_APP_SECRET = 'secret'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(OWNER)
  pickInboundContact.mockReset().mockReturnValue(null)
  parseConsentKeyword.mockReset().mockReturnValue(null)
  refreshWindow.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { vi.restoreAllMocks() })

function run(s, payload) {
  state = s
  createServerClient.mockReturnValue(makeDb(state))
  return POST(reqFor(payload))
}

describe('POST /api/webhooks/whatsapp — a sender with a hidden phone number (WA-BSUID.2)', () => {
  it('stores the message in a new thread keyed on the user id, and hands Mia that id to reply to', async () => {
    const res = await run(makeState({ links: PRE_GO_LIVE }), { messages: [hidden()] })
    expect(res.status).toBe(200)

    const conv = state.conversations.at(-1)
    expect(conv).toMatchObject({ location_id: STILL, wa_phone: null, wa_bsuid: BSUID, wa_profile_name: 'Hidden Member', contact_id: null })
    expect(inboundRows()).toEqual([expect.objectContaining({ conversation_id: conv.id, location_id: STILL, body: 'hi', message_type: 'text' })])
    expect(maybeAutoReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: conv.id, senderPhone: BSUID }))
    expect(captureInboundBsuid).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ bsuid: BSUID, senderPhone: null, conversationId: conv.id }))
  })

  it('looks the contact up by the user id, never by a phone filter built from nothing', async () => {
    await run(makeState({ links: PRE_GO_LIVE }), { messages: [hidden()] })
    const lookup = contactReads()[0]
    expect(lookup.ops).toContainEqual(['eq', 'wa_bsuid', BSUID])
    expect(lookup.ops.some(([m]) => m === 'or')).toBe(false)
  })

  it('files a later message in the thread that already carries the user id', async () => {
    const s = makeState({ links: PRE_GO_LIVE, conversations: [thread('conv-hidden', STILL, { wa_phone: null, wa_bsuid: BSUID, contact_id: null })] })
    await run(s, { messages: [hidden()] })
    expect(state.conversations).toHaveLength(1)
    expect(inboundRows()).toEqual([expect.objectContaining({ conversation_id: 'conv-hidden' })])
  })

  it('stores the number on that thread once Meta sends it', async () => {
    const s = makeState({ links: PRE_GO_LIVE, conversations: [thread('conv-hidden', STILL, { wa_phone: null, wa_bsuid: BSUID, contact_id: null })] })
    await run(s, { messages: [text({ from: PHONE, from_user_id: BSUID })], contacts: [{ wa_id: PHONE, user_id: BSUID, profile: { name: 'Hidden Member' } }] })
    expect(state.conversations).toHaveLength(1)
    expect(state.conversations[0].wa_phone).toBe(PHONE)
    expect(maybeAutoReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: 'conv-hidden', senderPhone: PHONE }))
  })

  it('never writes a number onto a thread that carries someone else\'s user id, or none', async () => {
    const s = makeState({ links: PRE_GO_LIVE, conversations: [thread('conv-phone', STILL, { contact_id: null })] })
    await run(s, { messages: [text({ from: PHONE })], contacts: PHONE_CONTACTS })
    expect(state.updates.some((u) => u.table === 'whatsapp_conversations' && 'wa_phone' in u.payload)).toBe(false)
  })

  it('a STOP is acknowledged at the user id, and is not matched against any phone', async () => {
    pickInboundContact.mockReturnValue({ id: 'c-1', location_id: STILL })
    parseConsentKeyword.mockReturnValue('stop')
    const s = makeState({ links: PRE_GO_LIVE, contacts: [{ id: 'c-1', location_id: STILL, wa_bsuid: BSUID }] })
    await run(s, { messages: [hidden({ text: { body: 'STOP' } })] })
    expect(applyWhatsappConsentKeyword).toHaveBeenCalledWith(expect.objectContaining({ waPhone: null, replyTo: BSUID, keyword: 'stop' }))
    // No phone, so nothing tries to write one onto the contact.
    expect(state.updates.some((u) => u.table === 'contacts' && 'wa_phone' in u.payload)).toBe(false)
  })

  it('a message with a phone still passes the phone, and no replyTo', async () => {
    pickInboundContact.mockReturnValue({ id: 'c-1', location_id: STILL })
    parseConsentKeyword.mockReturnValue('stop')
    await run(makeState({ links: PRE_GO_LIVE }), { messages: [text({ from: PHONE, text: { body: 'STOP' } })], contacts: PHONE_CONTACTS })
    const args = applyWhatsappConsentKeyword.mock.calls[0][0]
    expect(args.waPhone).toBe(PHONE)
    expect('replyTo' in args).toBe(false)
  })
})

describe('POST /api/webhooks/whatsapp — one bad message never takes the rest of the delivery (WA-BSUID.2)', () => {
  it('a message naming no sender at all is skipped and the next one is stored', async () => {
    const two = [...HIDDEN_CONTACTS, { wa_id: PHONE, profile: { name: 'Test Member' } }]
    const res = await run(makeState({ links: PRE_GO_LIVE }), { messages: [text(), hidden({ text: { body: 'second' } })], contacts: two })
    expect(res.status).toBe(200)
    expect(inboundRows()).toEqual([expect.objectContaining({ body: 'second' })])
  })

  it('a handler that throws on one message still lets the next message and the statuses through', async () => {
    refreshWindow.mockRejectedValueOnce(new Error('boom'))
    const res = await run(makeState({ links: PRE_GO_LIVE }), {
      messages: [hidden({ text: { body: 'first' } }), hidden({ text: { body: 'second' } })],
      statuses: [{ id: 'wamid.out.1', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }],
    })
    expect(res.status).toBe(200)
    expect(inboundRows()).toEqual([expect.objectContaining({ body: 'second' })])
    expect(state.updates).toContainEqual(expect.objectContaining({ table: 'whatsapp_messages', payload: expect.objectContaining({ status: 'delivered' }) }))
  })
})
