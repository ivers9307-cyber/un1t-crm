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
import { pickInboundContact, parseConsentKeyword } from '@/lib/whatsapp'
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

  it('a Flow completed in a thread routed by recent outbound acts at the routed studio', async () => {
    pickInboundContact.mockReturnValue({ id: 'c-1', location_id: HATCH })
    await run(makeState({
      conversations: [thread('conv-still', STILL), thread('conv-hatch', HATCH)],
      messages: [outbound('conv-still', STILL, ago(HOUR))],
    }), { type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: '{}' } } })
    expect(inboundRow()).toMatchObject({ conversation_id: 'conv-still', location_id: STILL })
    expect(handleFlowCompletion).toHaveBeenCalledTimes(1)
    expect(handleFlowCompletion).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: STILL }))
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

// WAORGNUMBER.6 — the transitional numberless_home step is gone: a studio with
// nothing switched on never receives a message (it could not answer it). A
// Hatch member files where the number is switched on, and the CTWA Lead and a
// Flow completion act at the routed studio.
describe('POST /api/webhooks/whatsapp — a studio with nothing switched on (WAORGNUMBER.6)', () => {
  it('a member homed there files at the number’s studio, stamped, and Mia answers there', async () => {
    pickInboundContact.mockReturnValue({ id: 'c-1', location_id: HATCH })
    await run(makeState({ links: PRE_GO_LIVE }))
    expect(state.conversations.find((c) => c.location_id === HATCH)).toBeUndefined()
    const still = state.conversations.find((c) => c.location_id === STILL)
    expect(still).toMatchObject({ contact_id: 'c-1' })
    expect(inboundRow()).toMatchObject({ conversation_id: still.id, location_id: STILL })
    expect(stampsOn(still.id)).toEqual([expect.objectContaining({ payload: { whatsapp_number_id: NUM } })])
    expect(maybeAutoReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: STILL }))
  })

  it('a thread staff moved there is not followed: the message files at the number’s studio', async () => {
    await run(makeState({ links: PRE_GO_LIVE, conversations: [thread('conv-hatch', HATCH, { contact_id: null, whatsapp_number_id: NUM })] }))
    expect(inboundRow()).toMatchObject({ location_id: STILL })
    expect(inboundRow().conversation_id).not.toBe('conv-hatch')
  })
})

// The CTWA Lead and a Flow completion act at the ROUTED studio (WAORGNUMBER.6
// removed the "act at the receiving number's studio" carve-out).
describe('POST /api/webhooks/whatsapp — CTWA and Flow act at the routed studio', () => {
  it('a Hatch member’s click-to-WhatsApp Lead is recorded for Hatch once the number is switched on there', async () => {
    pickInboundContact.mockReturnValue({ id: 'c-1', location_id: HATCH })
    await run(makeState({ links: GO_LIVE }), { referral: { source_type: 'ad', source_id: 'ad-x', ctwa_clid: 'clid-live' } })
    expect(inboundRow()).toMatchObject({ location_id: HATCH })
    expect(recordCtwaTouch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ctwaClid: 'clid-live', locationId: HATCH }))
  })

  it('a Flow completed in a Hatch thread acts at Hatch', async () => {
    pickInboundContact.mockReturnValue({ id: 'c-1', location_id: HATCH })
    await run(makeState({ links: GO_LIVE }), { type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: '{}' } } })
    expect(inboundRow()).toMatchObject({ location_id: HATCH })
    expect(handleFlowCompletion).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: HATCH }))
  })
})

// WAORGNUMBER.3b — live 18 Oct 2026: seven contacts shared Richard's phone. The
// phone match preferred a Stillorgan "Ivers" while the message routed into
// "Doe"'s Hatch thread, and the Hatch STOP was written to Ivers. A thread that
// names its contact now speaks for that contact; the phone match routes, and is
// used for a thread with no contact.
describe('POST /api/webhooks/whatsapp — several contacts share the phone (WAORGNUMBER.3b)', () => {
  const IVERS = { id: 'c-ivers', location_id: STILL }
  const DOE = { id: 'c-doe', location_id: HATCH }
  const hatchThreadOf = (contactId) => thread('conv-hatch', HATCH, { contact_id: contactId })
  const routedToDoe = (extra = {}) => makeState({
    contacts: [IVERS, DOE],
    conversations: [thread('conv-still', STILL, { contact_id: 'c-ivers' }), hatchThreadOf('c-doe')],
    messages: [outbound('conv-hatch', HATCH, ago(HOUR))],
    ...extra,
  })

  it('a STOP routed into Doe’s Hatch thread is applied to DOE at Hatch, with the sender’s number', async () => {
    pickInboundContact.mockReturnValue(IVERS)
    parseConsentKeyword.mockReturnValue('stop')
    await run(routedToDoe(), { text: { body: 'STOP' } })
    expect(inboundRow()).toMatchObject({ conversation_id: 'conv-hatch', location_id: HATCH, contact_id: 'c-doe' })
    expect(applyWhatsappConsentKeyword).toHaveBeenCalledTimes(1)
    expect(applyWhatsappConsentKeyword).toHaveBeenCalledWith(expect.objectContaining({
      contact: expect.objectContaining({ id: 'c-doe' }), locationId: HATCH, conversationId: 'conv-hatch', waPhone: PHONE, keyword: 'stop',
    }))
  })

  it('Mia, CTWA and the Flow act for the thread contact too', async () => {
    pickInboundContact.mockReturnValue(IVERS)
    await run(routedToDoe(), { referral: { source_type: 'ad', source_id: 'ad-none', ctwa_clid: 'clid-1' } })
    expect(maybeAutoReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: 'conv-hatch', contactId: 'c-doe' }))
    expect(recordCtwaTouch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contact: expect.objectContaining({ id: 'c-doe' }) }))

    vi.clearAllMocks()
    pickInboundContact.mockReturnValue(IVERS)
    await run(routedToDoe(), { type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: '{}' } } })
    expect(handleFlowCompletion).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contact: expect.objectContaining({ id: 'c-doe' }) }))
  })

  it('the welcome greeting is for the thread contact', async () => {
    pickInboundContact.mockReturnValue(IVERS)
    const { maybeSendWelcomeGreeting } = await import('@/lib/agent/welcome-greeting')
    await run(routedToDoe(), { type: 'request_welcome' })
    expect(maybeSendWelcomeGreeting).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: 'conv-hatch', contactId: 'c-doe' }))
  })

  it('a thread contact beyond the 20 phone matches is read by id within the organisation', async () => {
    pickInboundContact.mockReturnValue(IVERS)
    parseConsentKeyword.mockReturnValue('stop')
    // Twenty older same-phone contacts fill the phone match's limit, so Doe is not among them.
    const older = Array.from({ length: 20 }, (_, i) => ({ id: `c-old-${i}`, location_id: STILL, created_at: `2020-01-${String(i + 1).padStart(2, '0')}` }))
    await run(routedToDoe({ contacts: [...older, IVERS, { ...DOE, created_at: '2026-10-01' }] }), { text: { body: 'STOP' } })
    expect(applyWhatsappConsentKeyword).toHaveBeenCalledWith(expect.objectContaining({ contact: expect.objectContaining({ id: 'c-doe' }), locationId: HATCH }))
  })

  it('a thread contact outside the organisation is never acted for: the phone match is, logged', async () => {
    pickInboundContact.mockReturnValue(IVERS)
    parseConsentKeyword.mockReturnValue('stop')
    await run(routedToDoe({
      contacts: [IVERS, { id: 'c-stranger', location_id: 'loc-other-tenant' }],
      conversations: [hatchThreadOf('c-stranger')],
    }), { text: { body: 'STOP' } })
    expect(applyWhatsappConsentKeyword).toHaveBeenCalledWith(expect.objectContaining({ contact: expect.objectContaining({ id: 'c-ivers' }) }))
    expect(console.error).toHaveBeenCalledWith('[wa-webhook] thread contact unreadable; acting for the phone-matched contact', expect.objectContaining({ threadContactId: 'c-stranger' }))
  })

  it('a thread with no contact keeps the phone match (and is linked to it)', async () => {
    pickInboundContact.mockReturnValue(IVERS)
    parseConsentKeyword.mockReturnValue('stop')
    await run(routedToDoe({ conversations: [hatchThreadOf(null)] }), { text: { body: 'STOP' } })
    expect(state.conversations.find((c) => c.id === 'conv-hatch')).toMatchObject({ contact_id: 'c-ivers' })
    expect(applyWhatsappConsentKeyword).toHaveBeenCalledWith(expect.objectContaining({ contact: expect.objectContaining({ id: 'c-ivers' }), locationId: HATCH }))
  })
})

// ORGCONTACTS.1 (plan Task 10) — an inbound message from a known contact is
// activity at the studio the message was filed at: contact_studios.last_seen_at
// moves forward there. Fire-and-forget: a failed touch never costs the 200.
describe('POST /api/webhooks/whatsapp — inbound activity stamps contact_studios (ORGCONTACTS.1)', () => {
  const HATCH_MEMBER = { id: 'c-1', location_id: HATCH }

  it('a text from a known contact touches last_seen_at at the routed studio, at the message time', async () => {
    pickInboundContact.mockReturnValue(HATCH_MEMBER)
    const res = await run(makeState({ conversations: [thread('conv-hatch', HATCH)] }))
    expect(res.status).toBe(200)
    expect(inboundRow()).toMatchObject({ conversation_id: 'conv-hatch', location_id: HATCH })
    expect(touchContactStudio).toHaveBeenCalledTimes(1)
    expect(touchContactStudio).toHaveBeenCalledWith(expect.anything(), { contactId: 'c-1', locationId: HATCH, at: inboundRow().sent_at })
  })

  it('an unknown sender touches nothing; a failed touch is logged and the webhook still answers 200', async () => {
    pickInboundContact.mockReturnValue(null)
    expect((await run(makeState({ conversations: [thread('conv-still', STILL, { contact_id: null })] }))).status).toBe(200)
    expect(touchContactStudio).not.toHaveBeenCalled()

    pickInboundContact.mockReturnValue(HATCH_MEMBER)
    touchContactStudio.mockRejectedValueOnce(new Error('boom'))
    const res = await run(makeState({ conversations: [thread('conv-hatch', HATCH)] }))
    expect(res.status).toBe(200)
    expect(inboundRow()).toBeTruthy()
  })
})

// ORGCONTACTS.3 — the webhook reads the phone matches' contact_studios rows once,
// hands them to pickInboundContact (with the number's candidate studios) and the
// chosen contact's rows to the router (step 4: an active relationship).
describe('POST /api/webhooks/whatsapp — the relationship rows reach the picker and the router (ORGCONTACTS.3)', () => {
  const STILL_HOME = { id: 'c-1', location_id: STILL }
  const twoThreads = () => makeState({
    contacts: [{ ...STILL_HOME, wa_phone: PHONE, phone: null }],
    conversations: [thread('conv-still', STILL), thread('conv-hatch', HATCH)],
  })

  it("passes the chosen contact's studio rows to the router: an active Hatch row files a Stillorgan-home contact at Hatch", async () => {
    pickInboundContact.mockReturnValue(STILL_HOME)
    const byContact = new Map([['c-1', [{ location_id: HATCH, status: 'active', last_seen_at: ago(DAY) }]]])
    studiosOfContacts.mockResolvedValueOnce({ ok: true, byContact })
    const res = await run(twoThreads())
    expect(res.status).toBe(200)
    expect(studiosOfContacts).toHaveBeenCalledWith(expect.anything(), ['c-1'])
    expect(pickInboundContact).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'c-1' })]),
      expect.objectContaining({ candidateLocationIds: expect.arrayContaining([STILL, HATCH]), studiosByContact: byContact }),
    )
    expect(inboundRow()).toMatchObject({ conversation_id: 'conv-hatch', location_id: HATCH })
    expect(maybeAutoReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: 'conv-hatch', locationId: HATCH }))
  })

  it('a failed studios read passes null to both and routing still 200s on the home rule', async () => {
    pickInboundContact.mockReturnValue(STILL_HOME)
    studiosOfContacts.mockResolvedValueOnce({ ok: false, error: 'contact_studios down' })
    const res = await run(twoThreads())
    expect(res.status).toBe(200)
    expect(pickInboundContact).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ studiosByContact: null }))
    expect(inboundRow()).toMatchObject({ conversation_id: 'conv-still', location_id: STILL })
  })

  it('an unknown sender reads no rows and routes to the number home as before', async () => {
    pickInboundContact.mockReturnValue(null)
    const res = await run(makeState({ conversations: [] }))
    expect(res.status).toBe(200)
    expect(studiosOfContacts).not.toHaveBeenCalled()
    expect(inboundRow()).toMatchObject({ location_id: STILL })
  })
})
