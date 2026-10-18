// WAORGNUMBER.5 (spec R4) — the inbound webhook files a message with the
// studio that spoke last, through the REAL routeInboundThread over a small
// state-backed fake database. One organisation number, homed at Stillorgan;
// "go-live" is Hatch Street switching it on too. Fictional ids only.
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

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { resolveWhatsAppNumberByPhoneNumberId } from '@/lib/whatsapp-config'
import { pickInboundContact, parseConsentKeyword } from '@/lib/whatsapp'
import { applyWhatsappConsentKeyword } from '@/lib/whatsapp-consent'
import { maybeAutoReply } from '@/lib/agent/auto-reply'
import { recordCtwaTouch } from '@/lib/meta-capi'
import { fakeWhatsAppDb, link } from '@/lib/whatsapp-numbers-fake-db.test-helpers.js'

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

// Reads replay on the shared WhatsApp fake (it filters eq/neq/in/gte, orders,
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
      let q = reader.from(table)
      for (const [m, ...args] of ops) if (m !== 'or' && m !== 'is') q = q[m](...args)
      return q
    }
    const b = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'or', 'is', 'order', 'limit']) {
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
  }
}

const thread = (id, locationId, extra = {}) => ({
  id, location_id: locationId, contact_id: 'c-1', ctwa_clid: null, studio_resolution: null,
  wa_phone: PHONE, wa_bsuid: null, whatsapp_number_id: null, ...extra,
})
const outbound = (conversationId, locationId, sentAt) => ({
  conversation_id: conversationId, location_id: locationId, direction: 'outbound', sent_at: sentAt, wa_message_id: `wamid.out.${conversationId}`,
})

function reqFor(message) {
  const body = { entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: PNI },
    contacts: [{ wa_id: PHONE, profile: { name: 'Test Member' } }],
    messages: [{ id: `wamid.in.${Math.random()}`, from: PHONE, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' }, ...message }],
  } }] }] }
  return { text: async () => JSON.stringify(body), headers: { get: () => 'sha256=sig' } }
}

let state
const inboundRow = () => state.whatsapp_messages.find((m) => m.direction === 'inbound')
const stampsOn = (id) => state.updates.filter((u) => u.table === 'whatsapp_conversations' && 'whatsapp_number_id' in u.payload
  && u.ops.some(([m, c, v]) => m === 'eq' && c === 'id' && v === id))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_APP_SECRET = 'secret'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(OWNER)
  // clearAllMocks keeps a mockReturnValue: reset the two the tests set.
  pickInboundContact.mockReset().mockReturnValue(null)
  parseConsentKeyword.mockReset().mockReturnValue(null)
})
afterEach(() => { vi.restoreAllMocks() })

function run(s, message = {}) {
  state = s
  createServerClient.mockReturnValue(makeDb(state))
  return POST(reqFor(message))
}

describe('POST /api/webhooks/whatsapp — a reply lands with the studio that spoke last (WAORGNUMBER.5)', () => {
  const HATCH_MEMBER = { id: 'c-1', location_id: HATCH }

  it('Hatch member replying to a Stillorgan campaign within 7 days lands at Stillorgan', async () => {
    pickInboundContact.mockReturnValue(HATCH_MEMBER)
    const res = await run(makeState({
      conversations: [thread('conv-still', STILL), thread('conv-hatch', HATCH)],
      messages: [outbound('conv-still', STILL, ago(DAY))],
    }))
    expect(res.status).toBe(200)
    expect(inboundRow()).toMatchObject({ conversation_id: 'conv-still', location_id: STILL })
    expect(maybeAutoReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: 'conv-still', locationId: STILL }))
    expect(stampsOn('conv-still')).toHaveLength(1)
  })

  it('same member with no recent outbound lands at Hatch (home)', async () => {
    pickInboundContact.mockReturnValue(HATCH_MEMBER)
    await run(makeState({
      conversations: [thread('conv-still', STILL), thread('conv-hatch', HATCH)],
      messages: [outbound('conv-still', STILL, ago(8 * DAY))],
    }))
    expect(inboundRow()).toMatchObject({ conversation_id: 'conv-hatch', location_id: HATCH })
    // Switched on at Hatch: the thread replies from the number the member wrote to.
    expect(stampsOn('conv-hatch')).toEqual([expect.objectContaining({ payload: { whatsapp_number_id: NUM } })])
  })

  it('CTWA ad for Hatch files at Hatch for a known Stillorgan member and attributes the Lead to Hatch', async () => {
    pickInboundContact.mockReturnValue({ id: 'c-1', location_id: STILL })
    await run(makeState({
      conversations: [thread('conv-still', STILL)],
      messages: [outbound('conv-still', STILL, ago(HOUR))],
      adEntities: [{ level: 'ad', external_id: 'ad-hatch-1', location_id: HATCH }],
    }), { referral: { source_type: 'ad', source_id: 'ad-hatch-1', ctwa_clid: 'clid-hatch' } })
    const hatchThread = state.conversations.find((c) => c.location_id === HATCH)
    expect(hatchThread).toMatchObject({ contact_id: 'c-1', wa_phone: PHONE, ctwa_clid: 'clid-hatch' })
    expect(inboundRow()).toMatchObject({ conversation_id: hatchThread.id, location_id: HATCH })
    expect(recordCtwaTouch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ctwaClid: 'clid-hatch', locationId: HATCH }))
  })

  it('consent keyword acts at the routed studio', async () => {
    pickInboundContact.mockReturnValue(HATCH_MEMBER)
    parseConsentKeyword.mockReturnValue('stop')
    await run(makeState({
      conversations: [thread('conv-still', STILL), thread('conv-hatch', HATCH)],
      messages: [outbound('conv-still', STILL, ago(2 * HOUR))],
    }), { text: { body: 'STOP' } })
    expect(applyWhatsappConsentKeyword).toHaveBeenCalledWith(expect.objectContaining({ locationId: STILL, conversationId: 'conv-still', keyword: 'stop' }))
  })

  it('a reply quoting a Hatch message lands in the Hatch thread even when Stillorgan spoke later', async () => {
    pickInboundContact.mockReturnValue({ id: 'c-1', location_id: STILL })
    await run(makeState({
      conversations: [thread('conv-still', STILL), thread('conv-hatch', HATCH)],
      messages: [
        { ...outbound('conv-hatch', HATCH, ago(3 * DAY)), wa_message_id: 'wamid.hatch-promo' },
        outbound('conv-still', STILL, ago(HOUR)),
      ],
    }), { context: { id: 'wamid.hatch-promo' } })
    expect(inboundRow()).toMatchObject({ conversation_id: 'conv-hatch', location_id: HATCH })
  })
})

// WAHOMESTUDIO.1 (R2/F1), rewritten for WAORGNUMBER.5: until Hatch switches the
// number on, its threads still land at Hatch ('numberless_home') and are
// stamped with the receiving number, which they reply through.
describe('POST /api/webhooks/whatsapp — while Hatch has nothing switched on (transitional numberless_home)', () => {
  it('a Hatch member with no recent outbound gets the thread AT Hatch, stamped with the receiving number', async () => {
    pickInboundContact.mockReturnValue({ id: 'c-1', location_id: HATCH })
    await run(makeState({ links: PRE_GO_LIVE }))
    const hatchThread = state.conversations.find((c) => c.location_id === HATCH)
    expect(hatchThread).toMatchObject({ contact_id: 'c-1' })
    expect(inboundRow()).toMatchObject({ conversation_id: hatchThread.id, location_id: HATCH })
    expect(stampsOn(hatchThread.id)).toEqual([expect.objectContaining({ payload: { whatsapp_number_id: NUM } })])
    expect(maybeAutoReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: HATCH }))
  })

  it('an unknown sender whose thread staff moved to Hatch stays in that thread (F1)', async () => {
    await run(makeState({ links: PRE_GO_LIVE, conversations: [thread('conv-hatch', HATCH, { contact_id: null, whatsapp_number_id: NUM })] }))
    expect(state.conversations).toHaveLength(1)
    expect(inboundRow()).toMatchObject({ conversation_id: 'conv-hatch', location_id: HATCH })
    expect(maybeAutoReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: 'conv-hatch', locationId: HATCH }))
  })

  it('an unknown sender with no moved thread files at Stillorgan, stamped', async () => {
    await run(makeState({ links: PRE_GO_LIVE }))
    const still = state.conversations.find((c) => c.location_id === STILL)
    expect(still).toMatchObject({ contact_id: null })
    expect(stampsOn(still.id)).toHaveLength(1)
  })
})
